/**
 * Ad spend: daily cost by source and campaign (JSON or CSV), idempotent by (date, source,
 * campaign), so reports can show cost, ROAS, CPA, CAC and cost per visit (do/costs.ts).
 */

import { accountStanding, badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { parseCsv } from "../lib/csv";
import { enforce, limitVars, siteCap } from "../lib/limits";
import { addDays, localDay, parseYmd, ymdString } from "../lib/time";
import type { CostInput } from "../do/costs";
import { type Ctx, callSite, loadSite } from "./context";
import { convertCosts } from "./fx";

export const MAX_COST_ROWS_PER_CALL = 1000;
export const MAX_COST_CSV_BYTES = 256 * 1024;
/** Cost rows a site keeps when MAX_COST_ROWS_PER_SITE is unset (about 3 years of 50 campaigns a day). */
export const DEFAULT_MAX_COST_ROWS_PER_SITE = 50_000;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const costRow = z.object({
  date: day.describe("The day the money was spent (YYYY-MM-DD, the site's timezone)."),
  source: z.string().trim().min(1).max(100).describe('Matched with utm_source, case-insensitive (e.g. "google", "facebook").'),
  campaign: z.string().trim().max(200).optional().describe("Matched with utm_campaign. Omit for spend not split by campaign."),
  medium: z.string().trim().max(100).optional().describe("Kept for reference (cpc, paid_social)."),
  cost: z.number().min(0).max(1e10).describe("Spend that day, in major units."),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .describe("Default: the request's currency, else the site's. Converted to the site currency when it has one."),
  clicks: z.number().int().min(0).max(1e12).optional(),
  impressions: z.number().int().min(0).max(1e13).optional(),
});

export const costsShape = {
  costs: z.array(costRow).max(MAX_COST_ROWS_PER_CALL).optional().describe(`Up to ${MAX_COST_ROWS_PER_CALL} rows.`),
  csv: z
    .string()
    .max(MAX_COST_CSV_BYTES)
    .optional()
    .describe(
      "Or CSV with a header row: date,source,campaign,cost[,currency,medium,clicks,impressions] (Google Ads / Meta exports renamed to these).",
    ),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .describe("Currency of rows that don't say."),
};
export const recordCostsInput = z.object(costsShape);

const numOf = (v: string | undefined) => {
  if (v == null || v === "") return undefined;
  const t = v.replace(/\s/g, "");
  // 1,234.50 (thousands commas) or 1234,50 (decimal comma)
  const n = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)
    ? Number(t.replaceAll(",", ""))
    : /^\d+,\d{1,2}$/.test(t)
      ? Number(t.replace(",", "."))
      : Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** CSV rows as JSON rows (cost "1,234.50" and "1234,50" both read). */
function fromCsv(text: string): { rows: unknown[]; more: boolean } {
  const { rows, more } = parseCsv(text, MAX_COST_ROWS_PER_CALL);
  return {
    more,
    rows: rows.map((r) => ({
      date: r.date ?? r.day,
      source: r.source ?? r.utm_source,
      ...(r.campaign || r.utm_campaign ? { campaign: r.campaign ?? r.utm_campaign } : {}),
      ...(r.medium || r.utm_medium ? { medium: r.medium ?? r.utm_medium } : {}),
      cost: numOf(r.cost ?? r.spend ?? r.amount),
      ...(r.currency ? { currency: r.currency } : {}),
      ...(r.clicks ? { clicks: numOf(r.clicks) } : {}),
      ...(r.impressions ? { impressions: numOf(r.impressions) } : {}),
    })),
  };
}

export async function recordCosts(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(recordCostsInput, raw);
  if (!input.costs?.length && !input.csv)
    throw badRequest(
      "Send costs (JSON rows) or csv.",
      'Example: {"costs":[{"date":"2026-11-03","source":"google","campaign":"brand","cost":42.5}]}',
    );
  await enforce(
    [[ctx.env.API_INGEST_LIMITER, `acct:${ctx.accountId}`]],
    "ingest requests",
    "Send up to 1000 cost rows per request and retry in a minute.",
  );
  const site = await loadSite(ctx, siteId);
  const csv = input.csv ? fromCsv(input.csv) : { rows: [], more: false };
  if (csv.more)
    throw badRequest(
      `At most ${MAX_COST_ROWS_PER_CALL} rows per request.`,
      "Split the file and send each part (rows are idempotent by date, source and campaign).",
    );
  const today = ymdString(addDays(localDay(Date.now(), site.timezone), 1));
  const oldest = ymdString(addDays(localDay(Date.now(), site.timezone), -site.retention_days));
  const rows: (CostInput | string)[] = [...(input.costs ?? []), ...csv.rows].map((r): CostInput | string => {
    const p = costRow.safeParse(r);
    if (!p.success) return p.error.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`).join("; ");
    const v = p.data;
    if (!parseYmd(v.date)) return "date is not a calendar day";
    if (v.date > today) return "date is in the future";
    if (v.date < oldest) return `date is older than this site's retention_days (${site.retention_days})`;
    const currency = (v.currency ?? input.currency ?? site.currency ?? null)?.toUpperCase() ?? null;
    return {
      day: v.date,
      source: v.source.toLowerCase(),
      campaign: (v.campaign ?? "").toLowerCase(),
      medium: v.medium?.toLowerCase() ?? null,
      cost: v.cost,
      currency,
      clicks: v.clicks ?? null,
      impressions: v.impressions ?? null,
    };
  });
  const valid = await convertCosts(
    ctx.env,
    site,
    rows.filter((r): r is CostInput => typeof r !== "string"),
  );
  const max = siteCap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_COST_ROWS_PER_SITE", DEFAULT_MAX_COST_ROWS_PER_SITE);
  const res = valid.length
    ? await callSite(ctx.env, site, (s) => s.upsertCosts(valid, Number.isFinite(max) ? max : 1e9, limitVars(ctx.env)))
    : { results: [], stored: 0 };
  let vi = 0;
  const results = rows.map((r, index) => (typeof r === "string" ? { index, ok: false, reason: r } : { index, ...res.results[vi++]! }));
  const accepted = results.filter((r) => r.ok).length;
  const limited = results.filter((r) => !r.ok && r.reason === "cost_rows_limit").length;
  const currencies = new Set(valid.map((v) => v.currency));
  return {
    accepted,
    rejected: results.length - accepted,
    created: results.filter((r) => r.ok && "existing" in r && r.existing === false).length,
    updated: results.filter((r) => r.ok && "existing" in r && r.existing && r.changed).length,
    unchanged: results.filter((r) => r.ok && "existing" in r && r.existing && !r.changed).length,
    rows_stored: res.stored,
    results,
    next_steps: [
      `GET /v1/sites/${site.id}/breakdown?breakdown=utm_campaign&metrics=visits,revenue,cost,roas,cpa,cac,cost_per_visit shows spend against results.`,
      `GET /v1/sites/${site.id}/costs lists the rows; sending a (date, source, campaign) again replaces its figure.`,
      ...(limited
        ? [
            `${limited} row(s) refused: the site keeps at most ${max} cost rows (MAX_COST_ROWS_PER_SITE). DELETE /v1/sites/${site.id}/costs?from=&to= frees room.`,
          ]
        : []),
      ...(!site.currency && currencies.size > 1
        ? [
            "Rows are in more than one currency and the site has none: set one (PATCH /v1/sites/:id {currency}) so cost and revenue are comparable.",
          ]
        : []),
    ],
  };
}

const range = (q: { from?: string; to?: string }, tz: string) => {
  const to = q.to ?? ymdString(localDay(Date.now(), tz));
  const from = q.from ?? ymdString(addDays(parseYmd(to) ?? localDay(Date.now(), tz), -29));
  if (from > to) throw badRequest("from is after to.", "Dates are YYYY-MM-DD, inclusive.");
  return { from, to };
};

export const listCostsInput = z.object({
  from: day.optional().describe("YYYY-MM-DD, inclusive. Default 30 days before to."),
  to: day.optional().describe("YYYY-MM-DD, inclusive. Default today."),
  source: z.string().max(100).optional(),
  campaign: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().describe("Default 100."),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export async function listCosts(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(listCostsInput, raw);
  const site = await loadSite(ctx, siteId);
  const r = range(q, site.timezone);
  return {
    site_id: site.id,
    from: r.from,
    to: r.to,
    ...(await callSite(ctx.env, site, (s) =>
      s.listCosts({
        ...r,
        source: q.source?.toLowerCase(),
        campaign: q.campaign?.toLowerCase(),
        limit: q.limit ?? 100,
        offset: q.offset ?? 0,
      }),
    )),
  };
}

export const deleteCostsInput = z.object({
  from: day,
  to: day,
  source: z.string().max(100).optional(),
  campaign: z.string().max(200).optional().describe('"" = rows without a campaign.'),
});

export async function deleteCosts(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(deleteCostsInput, raw);
  const site = await loadSite(ctx, siteId);
  const r = range(q, site.timezone);
  return {
    site_id: site.id,
    ...r,
    ...(await callSite(ctx.env, site, (s) =>
      s.deleteCosts({ ...r, source: q.source?.toLowerCase(), campaign: q.campaign?.toLowerCase() }),
    )),
  };
}
