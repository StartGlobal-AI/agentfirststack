/**
 * Bulk raw export (do/export.ts): GET /v1/sites/:id/export?from=&to=&format=ndjson|csv|json&cursor=
 * returns one bounded page of raw events and the cursor of the next (also in x-afs-next-cursor).
 */

import { accountStanding, badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { toCsv } from "../lib/csv";
import { siteCap } from "../lib/limits";
import { parseInstant, parseYmd, zonedToUtc } from "../lib/time";
import { type Ctx, callSite, loadSite } from "./context";

export const MAX_EXPORT_PAGE = 10_000;
export const DEFAULT_MAX_EXPORT_ROWS_PER_SITE_PER_DAY = 1_000_000;

export const exportInput = z.object({
  from: z.string().describe("YYYY-MM-DD (site timezone, inclusive) or an ISO timestamp."),
  to: z.string().optional().describe("YYYY-MM-DD inclusive (default: today) or an ISO timestamp (exclusive)."),
  format: z.enum(["ndjson", "csv", "json"]).optional().describe("ndjson (default over REST), csv, or json."),
  cursor: z
    .string()
    .regex(/^e[0-9a-z]{1,12}$/)
    .optional()
    .describe("next_cursor of the previous page."),
  limit: z.coerce.number().int().min(1).max(MAX_EXPORT_PAGE).optional().describe(`Rows per page (default 5000, max ${MAX_EXPORT_PAGE}).`),
  debug: z
    .enum(["exclude", "include", "only", "quarantined"])
    .optional()
    .describe("Test traffic: exclude (default), include, only. quarantined: only the events attack protection set aside."),
});

function bound(v: string, tz: string, end: boolean): number {
  const d = parseYmd(v);
  if (d) return zonedToUtc(d.y, d.m, d.d + (end ? 1 : 0), 0, tz);
  const t = parseInstant(v);
  if (t == null) throw badRequest(`"${v}" is not YYYY-MM-DD or an ISO timestamp.`, "Example: from=2026-10-01&to=2026-10-31");
  return t;
}

export async function exportEvents(ctx: Ctx, siteId: string, raw: unknown, maxLimit = MAX_EXPORT_PAGE) {
  const q = parse(exportInput, raw);
  const site = await loadSite(ctx, siteId);
  const start = bound(q.from, site.timezone, false);
  const end = q.to ? bound(q.to, site.timezone, true) : Date.now() + 60_000;
  if (end <= start) throw badRequest("to is before from.", "from and to are inclusive days (or ISO timestamps, to exclusive).");
  const budget = siteCap(
    ctx.env,
    await accountStanding(ctx.env, ctx.accountId),
    "MAX_EXPORT_ROWS_PER_SITE_PER_DAY",
    DEFAULT_MAX_EXPORT_ROWS_PER_SITE_PER_DAY,
  );
  const res = (await callSite(ctx.env, site, (s) =>
    s.exportEvents(
      {
        start,
        end,
        after: q.cursor ? Number.parseInt(q.cursor.slice(1), 36) : 0,
        limit: Math.min(q.limit ?? 5000, maxLimit),
        debug: q.debug ?? "exclude",
      },
      Number.isFinite(budget) ? budget : 1e15,
    ),
  )) as { columns: string[]; rows: Record<string, unknown>[]; next_cursor: string | null; used_today: number; daily_budget: number | null };
  return { site_id: site.id, format: q.format, from: new Date(start).toISOString(), to: new Date(end).toISOString(), ...res };
}

/** The REST body of an export page. */
export function exportBody(res: Awaited<ReturnType<typeof exportEvents>>): { body: string; type: string } {
  if (res.format === "json") return { body: JSON.stringify(res), type: "application/json" };
  if (res.format === "csv")
    return {
      body: toCsv(res.rows.map((r) => ({ ...r, props: r.props == null ? null : JSON.stringify(r.props) }))),
      type: "text/csv; charset=utf-8",
    };
  return { body: res.rows.map((r) => JSON.stringify(r)).join("\n") + (res.rows.length ? "\n" : ""), type: "application/x-ndjson" };
}
