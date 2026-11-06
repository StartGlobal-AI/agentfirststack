/**
 * Core Web Vitals from real visitors: Google's thresholds, ratings and the advice that goes with
 * them. Pure. The numbers come from the tracker's engagement beacon (LCP, INP, CLS of each full
 * page load, stored on its pageview), aggregated in do/vitals.ts.
 *
 * Google's method (web.dev/articles/vitals, CrUX): the 75th percentile of page loads, by nearest
 * rank, per metric; a page passes when all three p75 values are good.
 *   LCP  good <= 2500 ms, poor > 4000 ms
 *   INP  good <= 200 ms,  poor > 500 ms
 *   CLS  good <= 0.1,     poor > 0.25
 */

export const VITAL_METRICS = ["lcp", "inp", "cls"] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];
export type Rating = "good" | "needs_improvement" | "poor";

export const VITAL_THRESHOLDS: Record<VitalMetric, { good: number; poor: number; name: string; short: string }> = {
  lcp: { good: 2500, poor: 4000, name: "Largest Contentful Paint", short: "LCP" },
  inp: { good: 200, poor: 500, name: "Interaction to Next Paint", short: "INP" },
  cls: { good: 0.1, poor: 0.25, name: "Cumulative Layout Shift", short: "CLS" },
};

/** Fewer page loads than this and a p75 can swing a lot: answers say so (enough_samples: false). */
export const MIN_SAMPLES = 30;
/** A page needs this many page loads with a metric to be ranked among the worst pages. */
export const MIN_PAGE_SAMPLES = 10;

export function rate(metric: VitalMetric, value: number | null | undefined): Rating | null {
  if (value == null) return null;
  const t = VITAL_THRESHOLDS[metric];
  return value <= t.good ? "good" : value <= t.poor ? "needs_improvement" : "poor";
}

/** 2140 -> "2.1 s", 640 -> "640 ms" (LCP); 180 -> "180 ms" (INP); 0.081 -> "0.08" (CLS). */
export function formatVital(metric: VitalMetric, v: number | null | undefined): string {
  if (v == null) return "n/a";
  if (metric === "cls") return String(Math.round(v * 100) / 100);
  if (metric === "lcp" && v >= 1000) return `${Math.round(v / 100) / 10} s`;
  return `${Math.round(v)} ms`;
}

export interface MetricSummary {
  p75: number | null;
  rating: Rating | null;
  samples: number;
  /** % of page loads in each band */
  good: number;
  needs_improvement: number;
  poor: number;
  enough_samples: boolean;
}

/**
 * Google's assessment: passed when every metric with enough samples is good and LCP and CLS have
 * enough (INP needs an interaction, so a page can lack it); failed when any metric with enough
 * samples isn't good.
 */
export function assess(m: Record<VitalMetric, MetricSummary>): "passed" | "failed" | "not_enough_data" {
  const known = VITAL_METRICS.filter((k) => m[k].enough_samples && m[k].rating);
  if (known.some((k) => m[k].rating !== "good")) return "failed";
  if (m.lcp.enough_samples && m.cls.enough_samples) return "passed";
  return "not_enough_data";
}

/** What usually fixes each metric, said once per failing metric. */
const ADVICE: Record<VitalMetric, string> = {
  lcp: "preload the largest image or text block and give it fetchpriority=high (never lazy-load it), cut render-blocking CSS and JS, serve images as AVIF/WebP at the displayed size, and cache HTML at the edge so the first byte comes fast",
  inp: "break long JavaScript tasks up (yield to the main thread), keep input handlers light, defer or drop third-party scripts, and shrink the DOM",
  cls: "give images, videos, embeds and ads width and height (or aspect-ratio), reserve space for banners and anything injected late, and use size-matched fallback fonts (font-display: optional or size-adjust)",
};

export interface VitalsSignals {
  siteId: string;
  pageviews: number;
  withVitals: number;
  metrics: Record<VitalMetric, MetricSummary>;
  worstPages: { page: string; metric: VitalMetric; p75: number }[];
  breakdown: string | null;
}

export function vitalsNextSteps(s: VitalsSignals): string[] {
  const steps: string[] = [];
  const base = `/v1/sites/${s.siteId}`;
  if (!s.withVitals) {
    steps.push(
      s.pageviews
        ? `${s.pageviews} pageviews in this period, none with Web Vitals. They come from the tracker's engagement beacon when a visitor leaves a page (pagehide): load the current tracker (/s.js, not a copy) and check engagement beacons arrive (GET ${base} shows events; scroll_depth and time_on_page fill from the same beacon). Browsers without the Performance APIs send none.`
        : `No pageviews in this period. Install the tracker first (GET ${base}/install), then Web Vitals arrive with every page load.`,
    );
    return steps;
  }
  for (const k of VITAL_METRICS) {
    const m = s.metrics[k];
    if (!m.enough_samples || !m.rating || m.rating === "good") continue;
    const t = VITAL_THRESHOLDS[k];
    const worst = s.worstPages.filter((p) => p.metric === k).slice(0, 3);
    steps.push(
      `${t.short} p75 is ${formatVital(k, m.p75)} (${m.rating === "poor" ? "poor" : "needs improvement"}; good is ${formatVital(k, t.good)} or less)${
        worst.length ? `, worst on ${worst.map((p) => `${p.page} (${formatVital(k, p.p75)})`).join(", ")}` : ""
      }: ${ADVICE[k]}.`,
    );
  }
  const thin = VITAL_METRICS.filter((k) => s.metrics[k].samples > 0 && !s.metrics[k].enough_samples);
  if (thin.length)
    steps.push(
      `Few page loads with ${thin.map((k) => VITAL_THRESHOLDS[k].short).join(", ")} (under ${MIN_SAMPLES}): treat those p75 values as rough, or widen the period (period=90d).`,
    );
  if (s.breakdown !== "device")
    steps.push(
      `Google assesses mobile and desktop separately: compare them with breakdown=device (GET ${base}/web-vitals?breakdown=device).`,
    );
  const worst = s.worstPages[0];
  if (worst)
    steps.push(
      `See what a lab run says about the worst page and what to fix first: GET ${base}/web-vitals/lab?url=<https URL of ${worst.page}> (MCP get_web_vitals_lab).`,
    );
  return steps;
}
