/** Small, pure statistics helpers for insights and spike detection. */

export const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank percentile (p in 0..100), the definition Core Web Vitals use for p75. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1]!;
}

/** % change from b to a, rounded to 0.1; null when b is 0 and a is not (no baseline). */
export function changePercent(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return round(((a - b) / b) * 100, 1);
}

export interface HistogramBucket {
  label: string;
  min: number;
  /** inclusive; null = open-ended */
  max: number | null;
  count: number;
  share: number;
}

/** Count values into [min, max] buckets (max null = and above). Shares are % of all values. */
export function histogram(values: number[], edges: { label: string; min: number; max: number | null }[]): HistogramBucket[] {
  const total = values.length;
  return edges.map((e) => {
    const count = values.filter((v) => v >= e.min && (e.max == null || v <= e.max)).length;
    return { ...e, count, share: total ? round((count / total) * 100, 1) : 0 };
  });
}

export const DAYS_TO_CONVERT_BUCKETS = [
  { label: "same day", min: 0, max: 0 },
  { label: "1 day", min: 1, max: 1 },
  { label: "2-3 days", min: 2, max: 3 },
  { label: "4-7 days", min: 4, max: 7 },
  { label: "8-14 days", min: 8, max: 14 },
  { label: "15-30 days", min: 15, max: 30 },
  { label: "31+ days", min: 31, max: null },
];

export const VISITS_TO_CONVERT_BUCKETS = [
  { label: "1 visit", min: 1, max: 1 },
  { label: "2 visits", min: 2, max: 2 },
  { label: "3 visits", min: 3, max: 3 },
  { label: "4-5 visits", min: 4, max: 5 },
  { label: "6-10 visits", min: 6, max: 10 },
  { label: "11+ visits", min: 11, max: null },
];

/** Each row's share (%) of the total of `key`; rows keep their order. */
export function withShares<T extends Record<string, unknown>>(rows: T[], key: keyof T): (T & { share: number })[] {
  const total = rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
  return rows.map((r) => ({ ...r, share: total ? round((Number(r[key] ?? 0) / total) * 100, 1) : 0 }));
}

// ------------------------------------------------------------------ traffic spikes

/** A day needs at least this many visitors, and this multiple of its baseline, to be a spike. */
export const SPIKE_MIN_VISITORS = 20;
export const SPIKE_FACTOR = 2.5;
/** Days of history before the day that form the baseline (median), and the least that will do. */
export const SPIKE_BASELINE_DAYS = 14;
export const SPIKE_MIN_BASELINE_DAYS = 7;

export interface SpikeInput {
  /** distinct visitors on the day being checked */
  visitors: number;
  /** distinct visitors on each earlier day with data (oldest first) */
  baseline: number[];
  /** visitors per source on the day, and the source's mean per baseline day */
  sources: { name: string; visitors: number; baseline_mean: number }[];
}

export interface Spike {
  visitors: number;
  baseline: number;
  factor: number;
  change_percent: number;
  /** the source with the largest gain, when it explains at least a third of the jump */
  source: string | null;
  source_visitors: number | null;
}

export function detectSpike(x: SpikeInput): Spike | null {
  if (x.baseline.length < SPIKE_MIN_BASELINE_DAYS) return null;
  const base = median(x.baseline) ?? 0;
  if (x.visitors < SPIKE_MIN_VISITORS || x.visitors < Math.max(base, 1) * SPIKE_FACTOR) return null;
  const jump = x.visitors - base;
  const top = [...x.sources]
    .map((s) => ({ ...s, gain: s.visitors - s.baseline_mean }))
    .sort((a, b) => b.gain - a.gain || a.name.localeCompare(b.name))[0];
  const driver = top && top.gain > 0 && top.gain >= jump / 3 ? top : null;
  return {
    visitors: x.visitors,
    baseline: round(base, 1),
    factor: round(x.visitors / Math.max(base, 1), 1),
    change_percent: changePercent(x.visitors, base) ?? 0,
    source: driver?.name ?? null,
    source_visitors: driver?.visitors ?? null,
  };
}

export function spikeTitle(s: Spike): string {
  return s.source ? `Traffic spike from ${s.source}` : "Traffic spike";
}

export function spikeDescription(s: Spike): string {
  const base = `${s.visitors} visitors vs a typical ${s.baseline} (${s.factor}x).`;
  return s.source ? `${base} ${s.source} brought ${s.source_visitors}.` : base;
}
