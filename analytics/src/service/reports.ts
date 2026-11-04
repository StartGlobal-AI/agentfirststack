import { ApiError, accountStanding, badRequest, newId, notFound, parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import type { Fetcher } from "../lib/delivery";
import { quotaExceeded, siteCap } from "../lib/limits";
import { addDays, addMonths, localDay, ymdString, zonedToUtc } from "../lib/time";
import { UNTRUSTED_NOTICE } from "../do/engine";
import { type Ctx, type SiteRow, callSite, loadSite } from "./context";
import { checkDestinationIds } from "./destinations";
import { deliver } from "./notify";
import { periodShape } from "./stats";

/**
 * The digest (a period summary with comparisons, revenue, goals, top lists and movers) and
 * scheduled reports that deliver it weekly or monthly through the alert destinations (cron).
 */

export const DEFAULT_MAX_REPORTS_PER_SITE = 5;
export const CADENCES = ["weekly", "monthly"] as const;
type Cadence = (typeof CADENCES)[number];

export const digestInput = z.object({
  period: periodShape.period.describe("Default 7d (with the 7 days before as the comparison)."),
  from: periodShape.from,
  to: periodShape.to,
  limit: z.coerce.number().int().min(1).max(20).optional().describe("Rows per top list (default 5)."),
});

type DigestData = {
  period: { from: string; to: string; timezone: string; start: number; end: number };
  comparison: { period: { from: string; to: string } } | null;
  kpis: Record<string, { value: number | null; previous: number | null; change_percent: number | null }>;
  revenue: Record<string, { value: number | null; previous: number | null; change_percent: number | null }>;
  goals: { name: unknown; conversions: number; change_percent: number | null }[];
  channels: unknown[];
  top_sources: unknown[];
  top_pages: unknown[];
  top_countries: unknown[];
  movers: unknown;
  annotations: unknown[];
};

/** The digest of a period for a site row (used by the endpoint and by report sends). */
async function digestFor(
  env: Bindings,
  site: SiteRow,
  q: { period?: z.infer<typeof digestInput>["period"]; from?: string; to?: string; limit?: number },
) {
  const d = (await callSite(env, site, (s) =>
    s.digest({ period: q.period ?? (q.from ? undefined : "7d"), from: q.from, to: q.to, limit: q.limit }),
  )) as unknown as DigestData;
  const fired = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM alert_events WHERE site_id = ? AND kind = 'alert' AND created_at >= ? AND created_at < ?",
  )
    .bind(site.id, d.period.start, d.period.end)
    .first<{ n: number }>();
  const { top_sources, top_pages, movers, annotations, ...rest } = d;
  return {
    site_id: site.id,
    domain: site.domain,
    ...rest,
    alerts_fired: fired?.n ?? 0,
    untrusted: { notice: UNTRUSTED_NOTICE, top_sources, top_pages, movers, annotations },
  };
}

export async function getDigest(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(digestInput, raw);
  const site = await loadSite(ctx, siteId);
  return digestFor(ctx.env, site, q);
}

// ------------------------------------------------------------------ scheduled reports

export interface ReportRow {
  id: string;
  site_id: string;
  name: string;
  cadence: Cadence;
  weekday: number | null;
  day_of_month: number | null;
  hour: number;
  destination_ids: string;
  enabled: number;
  next_run_at: number;
  last_sent_at: number | null;
  created_at: number;
  updated_at: number;
}

const scheduleFields = {
  weekday: z.number().int().min(1).max(7).optional().describe("weekly: 1 = Monday (default) ... 7 = Sunday."),
  day_of_month: z.number().int().min(1).max(28).optional().describe("monthly: 1-28 (default 1)."),
  hour: z.number().int().min(0).max(23).optional().describe("Hour of day in the site timezone (default 8)."),
  destination_ids: z.array(z.string().max(40)).min(1).max(5).optional(),
  enabled: z.boolean().optional(),
};

export const createReportInput = z.object({
  name: z.string().min(1).max(120).describe('Unique per site, e.g. "Weekly digest".'),
  cadence: z
    .enum(CADENCES)
    .describe("weekly: the 7 days before the send day; monthly: the previous calendar month. Compared with the period before."),
  ...scheduleFields,
  destination_ids: scheduleFields.destination_ids.unwrap(),
});
export const updateReportInput = z.object({
  name: z.string().min(1).max(120).optional(),
  cadence: z.enum(CADENCES).optional(),
  ...scheduleFields,
});

const isoWeekday = (v: { y: number; m: number; d: number }) => {
  const d = new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();
  return d === 0 ? 7 : d;
};

/** The next send time after `now`, in the site's timezone. */
export function nextRunAt(r: Pick<ReportRow, "cadence" | "weekday" | "day_of_month" | "hour">, tz: string, now: number): number {
  const today = localDay(now, tz);
  if (r.cadence === "weekly") {
    for (let i = 0; i <= 7; i++) {
      const day = addDays(today, i);
      const t = zonedToUtc(day.y, day.m, day.d, r.hour, tz);
      if (isoWeekday(day) === (r.weekday ?? 1) && t > now) return t;
    }
  }
  for (let i = 0; i <= 2; i++) {
    const m = addMonths({ y: today.y, m: today.m, d: 1 }, i);
    const t = zonedToUtc(m.y, m.m, r.day_of_month ?? 1, r.hour, tz);
    if (t > now) return t;
  }
  return now + 7 * 86_400_000;
}

/** The period a report sent on `at` covers: the 7 days before (weekly), or the previous month. */
export function reportPeriod(cadence: Cadence, tz: string, at: number): { from: string; to: string } {
  const day = localDay(at, tz);
  if (cadence === "weekly") return { from: ymdString(addDays(day, -7)), to: ymdString(addDays(day, -1)) };
  const first = addMonths({ y: day.y, m: day.m, d: 1 }, -1);
  const last = addDays({ y: day.y, m: day.m, d: 1 }, -1);
  return { from: ymdString(first), to: ymdString(last) };
}

export function reportJson(r: ReportRow) {
  return {
    id: r.id,
    name: r.name,
    cadence: r.cadence,
    weekday: r.cadence === "weekly" ? (r.weekday ?? 1) : null,
    day_of_month: r.cadence === "monthly" ? (r.day_of_month ?? 1) : null,
    hour: r.hour,
    destination_ids: JSON.parse(r.destination_ids) as string[],
    enabled: !!r.enabled,
    next_run_at: r.next_run_at,
    last_sent_at: r.last_sent_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function loadReport(ctx: Ctx, siteId: string, id: string): Promise<ReportRow> {
  const r = await ctx.env.DB.prepare("SELECT * FROM reports WHERE id = ? AND site_id = ?").bind(id, siteId).first<ReportRow>();
  if (!r) throw notFound("Report", `GET /v1/sites/${siteId}/reports lists this site's reports.`);
  return r;
}

export async function createReport(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createReportInput, raw);
  const site = await loadSite(ctx, siteId);
  const db = ctx.env.DB;
  const existing = await db.prepare("SELECT * FROM reports WHERE site_id = ? AND name = ?").bind(site.id, input.name).first<ReportRow>();
  if (existing) return { report: reportJson(existing), existing: true };
  if (input.cadence === "weekly" && input.day_of_month != null)
    throw badRequest("day_of_month is for monthly reports; weekly ones take weekday.");
  if (input.cadence === "monthly" && input.weekday != null)
    throw badRequest("weekday is for weekly reports; monthly ones take day_of_month.");
  const ids = await checkDestinationIds(ctx.env, site.id, input.destination_ids);
  const max = siteCap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_REPORTS_PER_SITE", DEFAULT_MAX_REPORTS_PER_SITE);
  if (Number.isFinite(max)) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE site_id = ?").bind(site.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw quotaExceeded(
        `This site already has ${max} reports, the most allowed here.`,
        "Delete one you no longer need (DELETE /v1/sites/:id/reports/:report_id).",
      );
  }
  const now = Date.now();
  const row: ReportRow = {
    id: newId("rpt"),
    site_id: site.id,
    name: input.name,
    cadence: input.cadence,
    weekday: input.cadence === "weekly" ? (input.weekday ?? 1) : null,
    day_of_month: input.cadence === "monthly" ? (input.day_of_month ?? 1) : null,
    hour: input.hour ?? 8,
    destination_ids: JSON.stringify(ids),
    enabled: input.enabled === false ? 0 : 1,
    next_run_at: 0,
    last_sent_at: null,
    created_at: now,
    updated_at: now,
  };
  row.next_run_at = nextRunAt(row, site.timezone, now);
  try {
    await db
      .prepare(
        `INSERT INTO reports (id, site_id, name, cadence, weekday, day_of_month, hour, destination_ids, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.site_id,
        row.name,
        row.cadence,
        row.weekday,
        row.day_of_month,
        row.hour,
        row.destination_ids,
        row.enabled,
        row.next_run_at,
        now,
        now,
      )
      .run();
  } catch (e) {
    const other = await db.prepare("SELECT * FROM reports WHERE site_id = ? AND name = ?").bind(site.id, input.name).first<ReportRow>();
    if (other) return { report: reportJson(other), existing: true };
    throw e;
  }
  return {
    report: reportJson(row),
    existing: false,
    next_steps: [
      `First send: ${new Date(row.next_run_at).toISOString()}. Send one now: POST /v1/sites/${site.id}/reports/${row.id}/send (MCP send_report).`,
      `Preview the content any time: GET /v1/sites/${site.id}/digest?period=${row.cadence === "weekly" ? "7d" : "30d"} (MCP get_digest).`,
    ],
  };
}

export async function listReports(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const { results } = await ctx.env.DB.prepare("SELECT * FROM reports WHERE site_id = ? ORDER BY created_at")
    .bind(site.id)
    .all<ReportRow>();
  return { reports: results.map(reportJson) };
}

export async function updateReport(ctx: Ctx, siteId: string, id: string, raw: unknown) {
  const input = parse(updateReportInput, raw);
  const site = await loadSite(ctx, siteId);
  const cur = await loadReport(ctx, site.id, id);
  const next: ReportRow = { ...cur, updated_at: Date.now() };
  if (input.name !== undefined && input.name !== cur.name) {
    const clash = await ctx.env.DB.prepare("SELECT id FROM reports WHERE site_id = ? AND name = ? AND id != ?")
      .bind(site.id, input.name, cur.id)
      .first();
    if (clash) throw new ApiError(409, "conflict", `Another report on this site is called "${input.name}".`, "Pick another name.");
    next.name = input.name;
  }
  if (input.cadence !== undefined) next.cadence = input.cadence;
  if (input.weekday !== undefined) next.weekday = input.weekday;
  if (input.day_of_month !== undefined) next.day_of_month = input.day_of_month;
  if (input.hour !== undefined) next.hour = input.hour;
  if (input.enabled !== undefined) next.enabled = input.enabled ? 1 : 0;
  if (next.cadence === "weekly") next.day_of_month = null;
  else next.weekday = null;
  if (input.destination_ids) next.destination_ids = JSON.stringify(await checkDestinationIds(ctx.env, site.id, input.destination_ids));
  next.next_run_at = nextRunAt(next, site.timezone, Date.now());
  await ctx.env.DB.prepare(
    "UPDATE reports SET name = ?, cadence = ?, weekday = ?, day_of_month = ?, hour = ?, destination_ids = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND site_id = ?",
  )
    .bind(
      next.name,
      next.cadence,
      next.weekday,
      next.day_of_month,
      next.hour,
      next.destination_ids,
      next.enabled,
      next.next_run_at,
      next.updated_at,
      cur.id,
      site.id,
    )
    .run();
  return { report: reportJson(next) };
}

export async function deleteReport(ctx: Ctx, siteId: string, id: string) {
  const site = await loadSite(ctx, siteId);
  const res = await ctx.env.DB.prepare("DELETE FROM reports WHERE id = ? AND site_id = ?").bind(id, site.id).run();
  if (!res.meta.changes) throw notFound("Report", `GET /v1/sites/${site.id}/reports lists this site's reports.`);
  return { deleted: id };
}

const fmt = (v: number | null) => (v == null ? "n/a" : Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(v));
const pct = (c: number | null) => (c == null ? "" : ` (${c > 0 ? "+" : ""}${c}%)`);

/** Deliver one report now: the digest of its period, to its destinations. */
async function sendReportRow(env: Bindings, site: SiteRow, r: ReportRow, now: number, fetcher?: Fetcher) {
  const period = reportPeriod(r.cadence, site.timezone, now);
  const d = await digestFor(env, site, period);
  const k = d.kpis;
  const rev = d.revenue;
  const label = r.cadence === "weekly" ? "Weekly" : "Monthly";
  const lines = [
    `${period.from} to ${period.to} (${site.timezone}), compared with the period before.`,
    `Visitors ${fmt(k.visitors!.value)}${pct(k.visitors!.change_percent)} · visits ${fmt(k.visits!.value)}${pct(k.visits!.change_percent)} · pageviews ${fmt(k.pageviews!.value)}${pct(k.pageviews!.change_percent)}`,
    `Engagement rate ${fmt(k.engagement_rate!.value)}% · bounce rate ${fmt(k.bounce_rate!.value)}%`,
    `Conversions ${fmt(k.conversions!.value)}${pct(k.conversions!.change_percent)} · revenue ${fmt(rev.revenue!.value)}${pct(rev.revenue!.change_percent)} from ${fmt(rev.purchases!.value)} purchases`,
    ...d.goals.slice(0, 5).map((g) => `Goal ${String(g.name)}: ${fmt(g.conversions)} conversions${pct(g.change_percent)}`),
    ...(d.alerts_fired ? [`${d.alerts_fired} alerts fired in the period.`] : []),
  ];
  const title = `[${site.domain}] ${label} report: ${fmt(k.visitors!.value)} visitors${pct(k.visitors!.change_percent)}`;
  const top = (rows: unknown[]) => (rows as { value: unknown; visitors: number }[]).map((x) => ({ value: x.value, visitors: x.visitors }));
  return deliver(
    env,
    site,
    JSON.parse(r.destination_ids) as string[],
    {
      kind: "report",
      type: "report.ready",
      title,
      lines,
      data: { report: reportJson(r), digest: d },
      untrusted: { top_sources: top(d.untrusted.top_sources), top_pages: top(d.untrusted.top_pages) },
      report_id: r.id,
    },
    { fetcher, now },
  );
}

export async function sendReport(ctx: Ctx, siteId: string, id: string, opts: { fetcher?: Fetcher } = {}) {
  const site = await loadSite(ctx, siteId);
  const r = await loadReport(ctx, site.id, id);
  const sent = await sendReportRow(ctx.env, site, r, Date.now(), opts.fetcher);
  await ctx.env.DB.prepare("UPDATE reports SET last_sent_at = ? WHERE id = ?").bind(Date.now(), r.id).run();
  return { sent: true, ...sent };
}

/** Cron step: due reports, at most REPORTS_PER_RUN, until the run's time budget is used. */
export async function runReports(env: Bindings, now: number, stopAt: number, fetcher?: Fetcher) {
  const { results } = await env.DB.prepare(
    "SELECT r.*, s.account_id AS s_account_id FROM reports r JOIN sites s ON s.id = r.site_id WHERE r.enabled = 1 AND r.next_run_at <= ? ORDER BY r.next_run_at LIMIT 50",
  )
    .bind(now)
    .all<ReportRow & { s_account_id: string }>();
  let sent = 0;
  for (const r of results) {
    if (Date.now() > stopAt) break;
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(r.site_id).first<SiteRow>();
    if (!site) continue;
    const next = nextRunAt(r, site.timezone, now);
    if (!(await accountStanding(env, r.s_account_id)).suspended) {
      try {
        await sendReportRow(env, site, r, now, fetcher);
        sent++;
      } catch (e) {
        console.error("report send failed", r.id, e);
      }
    }
    // Scheduled from now: a send missed while the cron was down isn't sent twice.
    await env.DB.prepare("UPDATE reports SET next_run_at = ?, last_sent_at = ? WHERE id = ?").bind(next, now, r.id).run();
  }
  return { reports_sent: sent };
}
