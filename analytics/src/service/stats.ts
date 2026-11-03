import { badRequest, parse } from "@afs/shared";
import { z } from "zod";
import {
  type Breakdown,
  BREAKDOWNS,
  DEFAULT_METRICS,
  FilterError,
  type Metric,
  METRICS,
  SORTABLE_METRICS,
  isBreakdown,
  parseFilters,
  parseMetrics,
} from "../lib/filters";
import { FunnelError, parseFunnelSteps } from "../lib/query";
import { type CompareSpec, INTERVALS, PERIODS } from "../lib/time";
import type { SortSpec } from "../lib/types";
import { type Ctx, callSite, loadSite } from "./context";
import { loadFunnel } from "./funnels";

/**
 * Query inputs are the same for REST (query string) and MCP (tool args): metrics may be a comma
 * list or an array; filters use one grammar everywhere (see lib/filters.ts).
 */
const listish = z.union([z.string(), z.array(z.string())]).optional();
const boolish = z.union([z.boolean(), z.enum(["true", "false", "1", "0"])]).optional();
const truthy = (v: z.infer<typeof boolish>) => v === true || v === "true" || v === "1";

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

export const compareShape = {
  compare: z
    .union([z.boolean(), z.enum(["previous", "year", "custom", "true", "false", "none"])])
    .optional()
    .describe(
      "previous (or true): the same-length period before; year: the same dates a year earlier; custom: compare_from..compare_to. Adds comparison + change_percent to totals, rows and buckets.",
    ),
  compare_from: z.string().optional().describe("compare=custom: first day, YYYY-MM-DD (site timezone)."),
  compare_to: z.string().optional().describe("compare=custom: last day, YYYY-MM-DD (inclusive)."),
  match_weekday: boolish.describe("Shift the comparison so weekdays line up (Mondays vs Mondays)."),
};

const sortField = z
  .string()
  .max(40)
  .optional()
  .describe(
    `Breakdown order: visitors (default), ${SORTABLE_METRICS.filter((m) => m !== "visitors").join(", ")}; or change / change:<metric> for the biggest absolute movers vs the comparison (implies compare=previous).`,
  );

export const statsInput = z.object({
  ...periodShape,
  metrics: listish.describe(`Comma list or array of: ${METRICS.join(", ")}. Default: ${DEFAULT_METRICS.join(", ")} (the rest are opt-in).`),
  breakdown: z
    .string()
    .optional()
    .describe(`Optional property to group by: ${BREAKDOWNS.join(", ")}, prop:<key>.`),
  filters: filtersField,
  ...compareShape,
  sort: sortField,
  limit: z.coerce.number().int().min(1).max(1000).optional().describe("Breakdown rows (default 20)."),
});

export const breakdownInput = statsInput.extend({
  breakdown: z.string().describe(`Property to group by: ${BREAKDOWNS.join(", ")}, prop:<key>.`),
});

export const timeseriesInput = z.object({
  ...periodShape,
  metrics: listish.describe(
    `Comma list or array of: ${METRICS.join(", ")}. Default: visitors, visits, pageviews, events, conversions, revenue.`,
  ),
  interval: z.enum(INTERVALS).optional().describe("hour, day, week or month. Default depends on the period."),
  filters: filtersField,
  ...compareShape,
});

export const funnelInput = z.object({
  ...periodShape,
  steps: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      '2-8 ordered steps: "/pricing" (path, * wildcard), "page:/x", "event:signup", "goal:Purchase". Comma list or array. Or pass funnel_id.',
    ),
  funnel_id: z.string().max(40).optional().describe("A saved funnel (fnl_...) instead of steps."),
  filters: filtersField,
});

export const moversInput = z.object({
  ...periodShape,
  breakdown: z.string().describe(`Property whose values moved: ${BREAKDOWNS.filter((b) => b !== "goal").join(", ")}, prop:<key>.`),
  metric: z.enum(METRICS).optional().describe("Metric to rank by (default visitors)."),
  metrics: listish.describe("Extra metrics to return per row (default: the ranking metric)."),
  filters: filtersField,
  ...compareShape,
  limit: z.coerce.number().int().min(1).max(100).optional().describe("Gainers and losers to return, each (default 10)."),
});

export const insightsInput = z.object({
  ...periodShape,
  filters: filtersField,
  goal: z.string().max(120).optional().describe("Conversion = this goal instead of a new purchase (payment or revenue event)."),
});

const DEFAULT_TS_METRICS: Metric[] = ["visitors", "visits", "pageviews", "events", "conversions", "revenue"];

export function metricsOf(v: string | string[] | undefined, fallback: readonly Metric[]): Metric[] {
  try {
    return parseMetrics(Array.isArray(v) ? v.join(",") : v, fallback);
  } catch (e) {
    throw badRequest((e as Error).message, `Valid metrics: ${METRICS.join(", ")}.`);
  }
}

export function filtersOf(v: string | undefined) {
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

type CompareIn = { compare?: boolean | string; compare_from?: string; compare_to?: string; match_weekday?: z.infer<typeof boolish> };

export function compareOf(q: CompareIn): CompareSpec | undefined {
  const c = q.compare;
  const custom = c === "custom" || (c === undefined && (q.compare_from || q.compare_to));
  if (custom) {
    if (!q.compare_from || !q.compare_to)
      throw badRequest(
        "compare=custom needs compare_from and compare_to.",
        "Example: compare=custom&compare_from=2026-09-01&compare_to=2026-09-30.",
      );
    return { mode: "custom", from: q.compare_from, to: q.compare_to };
  }
  if (c === true || c === "true" || c === "previous") return { mode: "previous", match_weekday: truthy(q.match_weekday) };
  if (c === "year") return { mode: "year", match_weekday: truthy(q.match_weekday) };
  return undefined;
}

export function sortOf(v: string | undefined, metrics: Metric[]): SortSpec | undefined {
  if (!v || v === "visitors") return v ? { by: "metric", metric: "visitors" } : undefined;
  if (v === "change" || v.startsWith("change:")) {
    const m = v === "change" ? (metrics[0] ?? "visitors") : v.slice(7);
    if (!(METRICS as readonly string[]).includes(m)) throw badRequest(`Unknown metric "${m}" in sort.`, `Valid: ${METRICS.join(", ")}.`);
    return { by: "change", metric: m as Metric };
  }
  if (!(SORTABLE_METRICS as readonly string[]).includes(v))
    throw badRequest(`Can't sort by "${v}".`, `Sort by one of: ${SORTABLE_METRICS.join(", ")}, or change / change:<metric>.`);
  return { by: "metric", metric: v as Metric };
}

function statsReq(q: z.infer<typeof statsInput>) {
  const metrics = metricsOf(q.metrics, DEFAULT_METRICS);
  const sort = sortOf(q.sort, metrics);
  const compare = compareOf(q) ?? (sort?.by === "change" ? { mode: "previous" as const } : undefined);
  return {
    period: q.period,
    from: q.from,
    to: q.to,
    metrics,
    filters: filtersOf(q.filters),
    breakdown: breakdownOf(q.breakdown),
    compare,
    sort,
    limit: q.limit,
  };
}

export async function getStats(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(statsInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = statsReq(q);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.stats(req))) };
}

export async function getBreakdown(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(breakdownInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = { ...statsReq(q), breakdown: breakdownOf(q.breakdown)! };
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
    compare: compareOf(q),
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.timeseries(req))) };
}

export async function getMovers(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(moversInput, raw);
  const site = await loadSite(ctx, siteId);
  const metric = q.metric ?? "visitors";
  const req = {
    period: q.period,
    from: q.from,
    to: q.to,
    breakdown: breakdownOf(q.breakdown)!,
    metric,
    metrics: metricsOf(q.metrics, [metric]),
    filters: filtersOf(q.filters),
    compare: compareOf(q) ?? { mode: "previous" as const },
    limit: q.limit,
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.movers(req))) };
}

export async function getInsights(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(insightsInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = { period: q.period, from: q.from, to: q.to, filters: filtersOf(q.filters), goal: q.goal };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.insights(req))) };
}

export async function getRealtime(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.realtime())) };
}

export function stepsOf(input: string | string[]) {
  try {
    return parseFunnelSteps(input);
  } catch (e) {
    if (e instanceof FunnelError) throw badRequest(e.message, "Example: steps=/pricing,event:signup,goal:Purchase");
    throw e;
  }
}

export async function getFunnel(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(funnelInput, raw);
  const site = await loadSite(ctx, siteId);
  const saved = q.funnel_id ? await loadFunnel(ctx, site.id, q.funnel_id) : null;
  if (!saved && !q.steps)
    throw badRequest(
      "Pass steps or funnel_id.",
      "Example: steps=/pricing,event:signup,goal:Purchase, or a saved funnel's id (GET /v1/sites/:id/funnels).",
    );
  const steps = stepsOf(saved ? saved.steps : q.steps!);
  const req = { period: q.period, from: q.from, to: q.to, filters: filtersOf(q.filters), steps };
  const res = await callSite(ctx.env, site, (s) => s.funnel(req));
  return { site_id: site.id, ...(saved ? { funnel: saved } : {}), ...res };
}

export const sqlInput = z.object({
  q: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "One read-only SELECT/WITH statement over events, sessions, goals, payments, annotations. No recursive CTEs, comma joins, more than 2 JOINs or JOINs without ON/USING. Max 1000 rows returned.",
    ),
});

export async function querySql(ctx: Ctx, siteId: string, raw: unknown) {
  const { q } = parse(sqlInput, raw);
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.sql(q))) };
}
