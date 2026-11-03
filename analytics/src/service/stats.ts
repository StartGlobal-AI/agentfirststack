import { badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { type Breakdown, BREAKDOWNS, FilterError, type Metric, METRICS, isBreakdown, parseFilters, parseMetrics } from "../lib/filters";
import { FunnelError, parseFunnelSteps } from "../lib/query";
import { INTERVALS, PERIODS } from "../lib/time";
import { type Ctx, callSite, loadSite } from "./context";

/**
 * Query inputs are the same for REST (query string) and MCP (tool args): metrics may be a comma
 * list or an array; filters use one grammar everywhere (see lib/filters.ts).
 */
const listish = z.union([z.string(), z.array(z.string())]).optional();

export const periodShape = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe("today, yesterday, 24h, 7d, 30d (default), 90d, 12mo, mtd, ytd, all. Or use from/to. All in the site timezone."),
  from: z.string().optional().describe("YYYY-MM-DD, inclusive, site timezone (with `to`)."),
  to: z.string().optional().describe("YYYY-MM-DD, inclusive (defaults to today when only `from` is given)."),
};

export const filtersField = z
  .string()
  .max(4000)
  .optional()
  .describe(
    "e.g. country==US;page~/blog;channel!=Direct;goal==Signup;prop:plan==pro. Ops == != ~ (contains) !~; | = OR; (none) = missing.",
  );

export const statsInput = z.object({
  ...periodShape,
  metrics: listish.describe(`Comma list or array of: ${METRICS.join(", ")}. Default: all.`),
  breakdown: z
    .string()
    .optional()
    .describe(`Optional property to group by: ${BREAKDOWNS.join(", ")}, prop:<key>.`),
  filters: filtersField,
  compare: z
    .union([z.boolean(), z.enum(["previous", "true", "false", "none"])])
    .optional()
    .describe("previous (or true): also return the previous period and % change."),
  limit: z.coerce.number().int().min(1).max(1000).optional().describe("Breakdown rows (default 20)."),
});

export const breakdownInput = statsInput.omit({ compare: true }).extend({
  breakdown: z.string().describe(`Property to group by: ${BREAKDOWNS.join(", ")}, prop:<key>.`),
});

export const timeseriesInput = z.object({
  ...periodShape,
  metrics: listish.describe(
    `Comma list or array of: ${METRICS.join(", ")}. Default: visitors, visits, pageviews, events, conversions, revenue.`,
  ),
  interval: z.enum(INTERVALS).optional().describe("hour, day, week or month. Default depends on the period."),
  filters: filtersField,
});

export const funnelInput = z.object({
  ...periodShape,
  steps: z
    .union([z.string(), z.array(z.string())])
    .describe('2-8 ordered steps: "/pricing" (path, * wildcard), "page:/x", "event:signup", "goal:Purchase". Comma list or array.'),
  filters: filtersField,
});

const DEFAULT_TS_METRICS: Metric[] = ["visitors", "visits", "pageviews", "events", "conversions", "revenue"];

function metricsOf(v: string | string[] | undefined, fallback: readonly Metric[]): Metric[] {
  try {
    return parseMetrics(Array.isArray(v) ? v.join(",") : v, fallback);
  } catch (e) {
    throw badRequest((e as Error).message, `Valid metrics: ${METRICS.join(", ")}.`);
  }
}

function filtersOf(v: string | undefined) {
  try {
    return parseFilters(v);
  } catch (e) {
    if (e instanceof FilterError)
      throw badRequest(e.message, "Filter syntax: key==value;key2~text (ops == != ~ !~, | for OR, (none) for missing).");
    throw e;
  }
}

function breakdownOf(v: string | undefined): Breakdown | undefined {
  if (!v) return undefined;
  if (!isBreakdown(v)) throw badRequest(`Unknown breakdown "${v}".`, `Valid: ${BREAKDOWNS.join(", ")}, prop:<key>.`);
  return v;
}

const compareOf = (v: z.infer<typeof statsInput>["compare"]) => v === true || v === "previous" || v === "true";

export async function getStats(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(statsInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = {
    period: q.period,
    from: q.from,
    to: q.to,
    metrics: metricsOf(q.metrics, METRICS),
    filters: filtersOf(q.filters),
    breakdown: breakdownOf(q.breakdown),
    compare: compareOf(q.compare),
    limit: q.limit,
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.stats(req))) };
}

export async function getBreakdown(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(breakdownInput, raw);
  const site = await loadSite(ctx, siteId);
  const breakdown = breakdownOf(q.breakdown)!;
  const req = {
    period: q.period,
    from: q.from,
    to: q.to,
    metrics: metricsOf(q.metrics, METRICS),
    filters: filtersOf(q.filters),
    breakdown,
    limit: q.limit,
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.breakdown(req))) };
}

export async function getTimeseries(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(timeseriesInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = {
    period: q.period,
    from: q.from,
    to: q.to,
    metrics: metricsOf(q.metrics, DEFAULT_TS_METRICS),
    filters: filtersOf(q.filters),
    interval: q.interval,
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.timeseries(req))) };
}

export async function getRealtime(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.realtime())) };
}

export async function getFunnel(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(funnelInput, raw);
  const site = await loadSite(ctx, siteId);
  let steps;
  try {
    steps = parseFunnelSteps(q.steps);
  } catch (e) {
    if (e instanceof FunnelError) throw badRequest(e.message, "Example: steps=/pricing,event:signup,goal:Purchase");
    throw e;
  }
  const req = { period: q.period, from: q.from, to: q.to, filters: filtersOf(q.filters), steps };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.funnel(req))) };
}

export const sqlInput = z.object({
  q: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "One read-only SELECT/WITH statement over events, sessions, goals. No recursive CTEs, comma joins, more than 2 JOINs or JOINs without ON/USING. Max 1000 rows returned.",
    ),
});

export async function querySql(ctx: Ctx, siteId: string, raw: unknown) {
  const { q } = parse(sqlInput, raw);
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.sql(q))) };
}
