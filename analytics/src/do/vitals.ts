/**
 * Real-visitor Core Web Vitals in the site's Durable Object: p75 by nearest rank (Google's
 * method), the share of page loads that are good / need improvement / poor, sample counts, a
 * breakdown, the worst pages and a comparison period. Read-only and bounded: two queries per set
 * of rows (counts, then percentiles for those rows only), over pageviews that carry vitals.
 */

import type { Filter } from "../lib/filters";
import { type Frag, type QueryCtx, evCte, groupSpecFor, join, raw, sql } from "../lib/query";
import { changePercent } from "../lib/stats-math";
import { type CompareSpec, comparisonRange } from "../lib/time";
import type { PeriodParams, SiteSettings } from "../lib/types";
import {
  MIN_PAGE_SAMPLES,
  MIN_SAMPLES,
  type MetricSummary,
  VITAL_METRICS,
  VITAL_THRESHOLDS,
  type VitalMetric,
  assess,
  rate,
  vitalsNextSteps,
} from "../lib/vitals";
import { type Db, all, checkGoalFilters, ctxFor, guard, num, periodOut, rangeFor, round } from "./common";

export const VITALS_BREAKDOWNS = ["page", "device", "country", "browser"] as const;
export type VitalsBreakdown = (typeof VITALS_BREAKDOWNS)[number];

export interface VitalsRequest extends PeriodParams {
  filters: Filter[];
  breakdown?: VitalsBreakdown;
  compare?: CompareSpec;
  limit?: number;
}

/** Pages ranked for worst_pages: the most-loaded ones (where a fix helps most visitors). */
const WORST_CANDIDATES = 100;
const WORST_PAGES = 10;

export interface VitalsRow {
  value: string;
  page_loads: number;
  lcp: MetricSummary;
  inp: MetricSummary;
  cls: MetricSummary;
}

const HAS_VITALS = "(e.lcp IS NOT NULL OR e.inp IS NOT NULL OR e.cls IS NOT NULL)";

/** Pageviews with vitals as (value, lcp, inp, cls), optionally only these group values. */
const vitalsCte = (key: Frag, only?: string[]) =>
  sql`v AS (SELECT ${key} AS value, e.lcp, e.inp, e.cls FROM ev e WHERE e.name = 'pageview' AND ${raw(HAS_VITALS)}${
    only ? sql` AND ${key} IN (SELECT value FROM json_each(${JSON.stringify(only)}))` : raw("")
  })`;

const bandCols = () =>
  VITAL_METRICS.map((m) => {
    const t = VITAL_THRESHOLDS[m];
    return sql`COUNT(${raw(m)}) AS ${raw(`${m}_n`)}, COALESCE(SUM(CASE WHEN ${raw(m)} <= ${t.good} THEN 1 ELSE 0 END), 0) AS ${raw(`${m}_good`)},
      COALESCE(SUM(CASE WHEN ${raw(m)} > ${t.poor} THEN 1 ELSE 0 END), 0) AS ${raw(`${m}_poor`)}`;
  });

function summary(metric: VitalMetric, n: number, good: number, poor: number, p75: number | null): MetricSummary {
  const share = (x: number) => (n ? round((x / n) * 100, 1) : 0);
  const p = p75 == null ? null : metric === "cls" ? round(p75, 3) : Math.round(p75);
  return {
    p75: p,
    rating: rate(metric, p),
    samples: n,
    good: share(good),
    needs_improvement: n ? round(100 - share(good) - share(poor), 1) : 0,
    poor: share(poor),
    enough_samples: n >= MIN_SAMPLES,
  };
}

/**
 * Vitals per group `key` (the most-loaded `limit` groups, or exactly `only`): page loads, bands
 * and p75 per metric. p75 is the ceil(0.75 n)-th value, row (3n + 3) / 4 in integer division.
 */
export function vitalsRows(db: Db, ctx: QueryCtx, key: Frag, limit: number, only?: string[]): VitalsRow[] {
  const counts = all(
    db,
    sql`WITH ${evCte(ctx)}, ${vitalsCte(key, only)}
    SELECT value, COUNT(*) AS page_loads, ${join(bandCols(), ", ")}
    FROM v GROUP BY value ORDER BY page_loads DESC, value LIMIT ${limit}`,
  );
  if (!counts.length) return [];
  const values = counts.map((r) => String(r.value));
  const p75 = new Map<string, number>();
  for (const r of all(
    db,
    sql`WITH ${evCte(ctx)}, ${vitalsCte(key, values)},
    x AS (SELECT value, 'lcp' AS k, lcp AS m FROM v WHERE lcp IS NOT NULL
      UNION ALL SELECT value, 'inp', inp FROM v WHERE inp IS NOT NULL
      UNION ALL SELECT value, 'cls', cls FROM v WHERE cls IS NOT NULL),
    r AS (SELECT value, k, m, ROW_NUMBER() OVER (PARTITION BY value, k ORDER BY m) AS rn, COUNT(*) OVER (PARTITION BY value, k) AS n FROM x)
    SELECT value, k, m FROM r WHERE rn = (3 * n + 3) / 4`,
  ))
    p75.set(`${r.value}\u001f${r.k}`, Number(r.m));
  return counts.map((r) => {
    const value = String(r.value);
    const out = { value, page_loads: num(r.page_loads) } as VitalsRow;
    for (const m of VITAL_METRICS)
      out[m] = summary(m, num(r[`${m}_n`]), num(r[`${m}_good`]), num(r[`${m}_poor`]), p75.get(`${value}\u001f${m}`) ?? null);
    return out;
  });
}

const ALL = raw("'all'");

const emptyRow = (value: string): VitalsRow => ({
  value,
  page_loads: 0,
  lcp: summary("lcp", 0, 0, 0, null),
  inp: summary("inp", 0, 0, 0, null),
  cls: summary("cls", 0, 0, 0, null),
});

/** One metric's p75, samples and bands over a window (alerts). */
export function vitalTotals(db: Db, ctx: QueryCtx): VitalsRow {
  return vitalsRows(db, ctx, ALL, 1)[0] ?? emptyRow("all");
}

/** The pages whose worst metric is furthest over its good threshold (enough samples only). */
export function worstPages(rows: VitalsRow[], only?: VitalMetric, n = WORST_PAGES) {
  return rows
    .map((r) => {
      let worst: { metric: VitalMetric; ratio: number } | null = null;
      for (const m of only ? [only] : VITAL_METRICS) {
        const s = r[m];
        if (s.p75 == null || s.samples < MIN_PAGE_SAMPLES) continue;
        const ratio = s.p75 / VITAL_THRESHOLDS[m].good;
        if (!worst || ratio > worst.ratio) worst = { metric: m, ratio };
      }
      return worst && worst.ratio > 1 ? { row: r, ...worst } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.ratio - a.ratio || b.row.page_loads - a.row.page_loads)
    .slice(0, n)
    .map((x) => ({
      page: x.row.value,
      page_loads: x.row.page_loads,
      worst_metric: x.metric,
      lcp: { p75: x.row.lcp.p75, rating: x.row.lcp.rating, samples: x.row.lcp.samples },
      inp: { p75: x.row.inp.p75, rating: x.row.inp.rating, samples: x.row.inp.samples },
      cls: { p75: x.row.cls.p75, rating: x.row.cls.rating, samples: x.row.cls.samples },
    }));
}

const p75Of = (r: VitalsRow | undefined) => ({ lcp_p75: r?.lcp.p75 ?? null, inp_p75: r?.inp.p75 ?? null, cls_p75: r?.cls.p75 ?? null });
const changesOf = (cur: VitalsRow, prev: VitalsRow | undefined) =>
  Object.fromEntries(
    VITAL_METRICS.map((m) => {
      const a = cur[m].p75;
      const b = prev?.[m].p75 ?? null;
      return [`${m}_p75`, a == null || b == null ? null : changePercent(a, b)];
    }),
  );

export function webVitals(db: Db, settings: SiteSettings, q: VitalsRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q);
    const limit = q.limit ?? 20;
    const overall = vitalTotals(db, ctx);
    const pageviews = num(all(db, sql`WITH ${evCte(ctx)} SELECT COUNT(*) AS n FROM ev e WHERE e.name = 'pageview'`)[0]?.n);
    const metrics = { lcp: overall.lcp, inp: overall.inp, cls: overall.cls };
    const pageKey = groupSpecFor("page", ctx).key;
    const pages = overall.page_loads ? vitalsRows(db, ctx, pageKey, Math.max(WORST_CANDIDATES, limit)) : [];
    const worst = worstPages(pages);
    const out: Record<string, unknown> = {
      period: periodOut(r),
      filters: q.filters,
      assessment: assess(metrics),
      page_loads: overall.page_loads,
      coverage: { pageviews, with_vitals: overall.page_loads, share: pageviews ? round((overall.page_loads / pageviews) * 100, 1) : 0 },
      metrics,
      thresholds: Object.fromEntries(VITAL_METRICS.map((m) => [m, { good: VITAL_THRESHOLDS[m].good, poor: VITAL_THRESHOLDS[m].poor }])),
      min_samples: MIN_SAMPLES,
      worst_pages: worst,
    };
    const p = q.compare ? comparisonRange(r, q.compare, now) : null;
    const cmp = p ? { ...ctx, start: p.start, end: p.end } : null;
    if (q.compare) {
      if (cmp && p) {
        const prev = vitalTotals(db, cmp);
        out.comparison = {
          period: { ...periodOut(p), partial: p.partial, mode: p.mode },
          page_loads: prev.page_loads,
          metrics: { lcp: prev.lcp, inp: prev.inp, cls: prev.cls },
          change_percent: changesOf(overall, prev),
        };
      } else out.comparison = null;
    }
    if (q.breakdown) {
      const rows = q.breakdown === "page" ? pages.slice(0, limit) : vitalsRows(db, ctx, groupSpecFor(q.breakdown, ctx).key, limit);
      const prev =
        cmp && rows.length
          ? new Map(
              vitalsRows(
                db,
                cmp,
                groupSpecFor(q.breakdown, ctx).key,
                rows.length,
                rows.map((x) => x.value),
              ).map((x) => [x.value, x]),
            )
          : null;
      out.breakdown = q.breakdown;
      out.results = rows.map((x) => ({
        ...x,
        ...(prev
          ? {
              comparison: {
                page_loads: prev.get(x.value)?.page_loads ?? 0,
                ...p75Of(prev.get(x.value)),
                change_percent: changesOf(x, prev.get(x.value)),
              },
            }
          : {}),
      }));
    }
    out.notes = [
      "p75 by nearest rank over page loads (Google's method, as in Chrome UX Report; CrUX uses the last 28 days). good / needs_improvement / poor are % of page loads in each band.",
      "Vitals come from real visitors' full page loads in browsers that report them (Chromium-based browsers report all three; others report some or none). Client-side navigations in single-page apps carry none.",
      "INP is recorded only for page loads with an interaction slower than 40 ms, so its samples lean slow: read its p75 as an upper bound.",
    ];
    out.next_steps = vitalsNextSteps({
      siteId: settings.id,
      pageviews,
      withVitals: overall.page_loads,
      metrics,
      worstPages: worst.map((w) => ({ page: w.page, metric: w.worst_metric, p75: w[w.worst_metric].p75 ?? 0 })),
      breakdown: q.breakdown ?? null,
    });
    return out;
  });
}
