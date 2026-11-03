/** Time ranges for queries: `period` or explicit `from` / `to`. All UTC, unix ms. */

export const PERIODS = ["1h", "24h", "today", "yesterday", "7d", "30d", "90d", "180d", "365d", "all"] as const;
export type Period = (typeof PERIODS)[number];

export class PeriodError extends Error {}

const DAY = 86_400_000;

/** unix ms, unix seconds, or an ISO 8601 date/time. */
export function parseTime(v: string | number): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = v.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t))
    throw new PeriodError(`"${v}" is not a time. Use unix ms, unix seconds or ISO 8601 (2026-11-03 or 2026-11-03T10:00:00Z).`);
  return t;
}

export interface Range {
  start: number;
  end: number;
  period: string;
}

export function resolveRange(q: { period?: string; from?: string | number; to?: string | number }, now: number, fallback: Period): Range {
  if (q.from !== undefined || q.to !== undefined) {
    const start = q.from !== undefined ? parseTime(q.from) : 0;
    let end = q.to !== undefined ? parseTime(q.to) : now;
    // A bare date as `to` means the whole day.
    if (typeof q.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.to.trim())) end += DAY - 1;
    if (end < start) throw new PeriodError("`to` is before `from`.");
    return { start, end, period: "custom" };
  }
  const p = (q.period ?? fallback) as Period;
  const today = Math.floor(now / DAY) * DAY;
  switch (p) {
    case "1h":
      return { start: now - 3_600_000, end: now, period: p };
    case "24h":
      return { start: now - DAY, end: now, period: p };
    case "today":
      return { start: today, end: now, period: p };
    case "yesterday":
      return { start: today - DAY, end: today - 1, period: p };
    case "7d":
    case "30d":
    case "90d":
    case "180d":
    case "365d":
      return { start: now - Number.parseInt(p, 10) * DAY, end: now, period: p };
    case "all":
      return { start: 0, end: now, period: p };
    default:
      throw new PeriodError(`Unknown period "${q.period}". Use one of ${PERIODS.join(", ")}, or from/to.`);
  }
}

export const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
export const iso = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString() : null);
