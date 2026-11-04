/**
 * A period summary for humans and agents (GET /digest, scheduled reports): headline numbers with
 * the change vs the previous period, revenue, goals, the top sources, pages and countries, the
 * sources that moved most, and the period's annotations. Built from the same functions as the
 * stats endpoints, so the numbers always agree with them.
 */

import type { Metric } from "../lib/filters";
import { comparisonRange } from "../lib/time";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { annotationsIn } from "./annotations";
import { type Db, ctxFor, guard, periodOut, rangeFor } from "./common";
import { breakdownRows, changes, movers, totals } from "./engine";

export const DIGEST_METRICS: Metric[] = [
  "visitors",
  "visits",
  "pageviews",
  "bounce_rate",
  "engagement_rate",
  "visit_duration",
  "conversions",
  "conversion_rate",
];
export const DIGEST_REVENUE: Metric[] = [
  "revenue",
  "new_revenue",
  "renewal_revenue",
  "refunds",
  "purchases",
  "customers",
  "average_order_value",
];

export interface DigestRequest extends PeriodParams {
  /** rows per top list (default 5) */
  limit?: number;
}

export function digest(db: Db, settings: SiteSettings, q: DigestRequest, now = Date.now()) {
  return guard(() => {
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, { filters: [], debug: q.debug });
    const p = comparisonRange(r, { mode: "previous" }, now);
    const cmp = p ? { ...ctx, start: p.start, end: p.end } : null;
    const metrics = [...DIGEST_METRICS, ...DIGEST_REVENUE];
    const cur = totals(db, ctx, metrics);
    const prev = cmp ? totals(db, cmp, metrics) : null;
    const change = prev ? changes(cur, prev, metrics) : null;
    const block = (ms: Metric[]) =>
      Object.fromEntries(ms.map((m) => [m, { value: cur[m], previous: prev?.[m] ?? null, change_percent: change?.[m] ?? null }]));
    const limit = q.limit ?? 5;
    const top = (dim: "source" | "page" | "country" | "channel") =>
      breakdownRows(db, ctx, dim, ["visitors", "conversions", "revenue"], limit, { cmp }).map((row) => ({
        value: row.value,
        visitors: row.visitors,
        conversions: row.conversions,
        revenue: row.revenue,
        change_percent:
          (row.comparison as { change_percent?: Record<string, number | null> } | undefined)?.change_percent?.visitors ?? null,
      }));
    const goals = breakdownRows(db, ctx, "goal", ["visitors", "conversions"], 50, { cmp }).map((g) => ({
      name: g.value,
      conversions: g.conversions,
      visitors: g.visitors,
      conversion_rate: g.conversion_rate,
      revenue: g.revenue,
      change_percent: (g.comparison as { change_percent?: Record<string, number | null> } | undefined)?.change_percent?.conversions ?? null,
    }));
    const mv = p
      ? (movers(
          db,
          settings,
          {
            ...q,
            period: q.period,
            from: q.from,
            to: q.to,
            filters: [],
            metrics: ["visitors"],
            breakdown: "source",
            metric: "visitors",
            limit: 3,
          },
          now,
        ) as {
          gainers?: unknown[];
          losers?: unknown[];
        })
      : null;
    return {
      period: periodOut(r),
      comparison: p ? { period: periodOut(p), partial: p.partial } : null,
      kpis: block(DIGEST_METRICS),
      revenue: block(DIGEST_REVENUE),
      goals,
      channels: top("channel"),
      // Visitor-sent names (sources, pages): the service returns them under `untrusted`.
      top_sources: top("source"),
      top_pages: top("page"),
      top_countries: top("country"),
      movers: mv ? { gainers: mv.gainers ?? [], losers: mv.losers ?? [] } : null,
      annotations: annotationsIn(db, settings, r.start, r.end),
    };
  });
}
