/**
 * Periods and time buckets in the site's IANA timezone. Pure (Intl only); used by the DO.
 * All ranges are half-open [start, end) in unix ms.
 */

export const PERIODS = ["today", "yesterday", "24h", "7d", "30d", "90d", "12mo", "mtd", "ytd", "all", "custom"] as const;
export type Period = (typeof PERIODS)[number];
export const INTERVALS = ["hour", "day", "week", "month"] as const;
export type Interval = (typeof INTERVALS)[number];

export interface Range {
  period: Period;
  timezone: string;
  /** local YYYY-MM-DD of the first and last day covered */
  from: string;
  to: string;
  start: number;
  end: number;
  /** suggested timeseries interval */
  interval: Interval;
}

export interface PeriodInput {
  period?: Period;
  from?: string;
  to?: string;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const parts = fmt(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, min: get("minute") };
}

/** local wall clock minus UTC, in ms, at the given instant */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return asUtc - Math.floor(utcMs / 60_000) * 60_000;
}

/** UTC instant of a local wall-clock time (DST gaps resolve forward). */
export function zonedToUtc(y: number, m: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h);
  const t1 = guess - tzOffsetMs(guess, tz);
  const t2 = guess - tzOffsetMs(t1, tz);
  return t2;
}

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export const ymdString = (v: Ymd) => `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;

export function parseYmd(s: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const v = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const dt = new Date(Date.UTC(v.y, v.m - 1, v.d));
  if (dt.getUTCFullYear() !== v.y || dt.getUTCMonth() !== v.m - 1 || dt.getUTCDate() !== v.d) return null;
  return v;
}

export function addDays(v: Ymd, n: number): Ymd {
  const dt = new Date(Date.UTC(v.y, v.m - 1, v.d) + n * DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function addMonths(v: Ymd, n: number): Ymd {
  const total = v.y * 12 + (v.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(v.d, daysInMonth(y, m)) };
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayDiff = (a: Ymd, b: Ymd) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY);
const midnight = (v: Ymd, tz: string) => zonedToUtc(v.y, v.m, v.d, 0, tz);

export function localDay(utcMs: number, tz: string): Ymd {
  const p = localParts(utcMs, tz);
  return { y: p.y, m: p.m, d: p.d };
}

function intervalForDays(days: number): Interval {
  if (days <= 2) return "hour";
  if (days <= 92) return "day";
  return "month";
}

function dayRange(period: Period, from: Ymd, to: Ymd, tz: string, interval?: Interval): Range {
  return {
    period,
    timezone: tz,
    from: ymdString(from),
    to: ymdString(to),
    start: midnight(from, tz),
    end: midnight(addDays(to, 1), tz),
    interval: interval ?? intervalForDays(dayDiff(from, to) + 1),
  };
}

export class PeriodError extends Error {}

/**
 * Resolve a period in `tz`. `firstEventMs` anchors `all`. Throws PeriodError on bad input.
 *   today, yesterday            local calendar days (hourly)
 *   24h                         the last 24 whole local hours including the current one
 *   7d / 30d / 90d              the N local days ending today (today included)
 *   12mo                        the 12 calendar months ending with this month
 *   mtd / ytd                   month / year to date
 *   all                         from the first stored event
 *   from + to (YYYY-MM-DD)      inclusive local days ("custom")
 */
export function resolvePeriod(input: PeriodInput, tz: string, now: number, firstEventMs?: number | null): Range {
  const today = localDay(now, tz);
  if (input.from || input.to) {
    const f = input.from ? parseYmd(input.from) : null;
    const t = input.to ? parseYmd(input.to) : input.from ? today : null;
    if (!f || !t) throw new PeriodError("`from` and `to` must be dates as YYYY-MM-DD (to defaults to today).");
    if (dayDiff(f, t) < 0) throw new PeriodError("`from` must be on or before `to`.");
    if (dayDiff(f, t) > 3660) throw new PeriodError("Custom ranges are limited to 10 years.");
    return dayRange("custom", f, t, tz);
  }
  const period = input.period ?? "30d";
  switch (period) {
    case "today":
      return dayRange(period, today, today, tz, "hour");
    case "yesterday": {
      const y = addDays(today, -1);
      return dayRange(period, y, y, tz, "hour");
    }
    case "24h": {
      const off = tzOffsetMs(now, tz);
      const hourStart = Math.floor((now + off) / HOUR) * HOUR - off;
      const start = hourStart - 23 * HOUR;
      const end = hourStart + HOUR;
      return {
        period,
        timezone: tz,
        from: ymdString(localDay(start, tz)),
        to: ymdString(localDay(end - 1, tz)),
        start,
        end,
        interval: "hour",
      };
    }
    case "7d":
      return dayRange(period, addDays(today, -6), today, tz, "day");
    case "30d":
      return dayRange(period, addDays(today, -29), today, tz, "day");
    case "90d":
      return dayRange(period, addDays(today, -89), today, tz, "day");
    case "12mo":
      return dayRange(period, addMonths({ y: today.y, m: today.m, d: 1 }, -11), today, tz, "month");
    case "mtd":
      return dayRange(period, { y: today.y, m: today.m, d: 1 }, today, tz, "day");
    case "ytd":
      return dayRange(period, { y: today.y, m: 1, d: 1 }, today, tz, "month");
    case "all": {
      const first = firstEventMs ? localDay(firstEventMs, tz) : today;
      const r = dayRange(period, first, today, tz);
      return r;
    }
    case "custom":
      throw new PeriodError("period=custom needs `from` and `to` (YYYY-MM-DD).");
  }
}

/**
 * The comparison range for compare=previous: the same-length range immediately before (calendar
 * aware for mtd/ytd/12mo). For an in-progress range (today, mtd, ytd, 7d...) only the elapsed
 * part is compared, so "today so far" is measured against "yesterday up to the same time".
 * Returns null for `all`.
 */
export function previousRange(r: Range, now: number): (Range & { partial: boolean }) | null {
  if (r.period === "all") return null;
  return truncateElapsed(r, previousFull(r), now);
}

/** The whole range before `r` (no truncation for in-progress periods). */
function previousFull(r: Range): Range {
  const tz = r.timezone;
  if (r.period === "24h") return hourRange(r, r.start - 24 * HOUR);
  const from = parseYmd(r.from)!;
  const to = parseYmd(r.to)!;
  let pf: Ymd;
  let pt: Ymd;
  if (r.period === "mtd") {
    pf = addMonths(from, -1);
    pt = addMonths(to, -1);
  } else if (r.period === "ytd" || r.period === "12mo") {
    pf = addMonths(from, -12);
    pt = r.period === "12mo" ? addDays(from, -1) : addMonths(to, -12);
  } else {
    const n = dayDiff(from, to) + 1;
    pf = addDays(from, -n);
    pt = addDays(from, -1);
  }
  return dayRange(r.period, pf, pt, tz, r.interval);
}

/** A 24-hour range like `r` starting at `start`. */
function hourRange(r: Range, start: number): Range {
  const len = r.end - r.start;
  return {
    ...r,
    start,
    end: start + len,
    from: ymdString(localDay(start, r.timezone)),
    to: ymdString(localDay(start + len - 1, r.timezone)),
  };
}

/** For an in-progress range, compare only the elapsed part (today so far vs yesterday until the same time). */
function truncateElapsed(r: Range, cmp: Range, now: number): Range & { partial: boolean } {
  const partial = r.end > now && now > r.start;
  return partial ? { ...cmp, end: Math.min(cmp.end, cmp.start + (now - r.start)), partial } : { ...cmp, partial };
}

const weekday = (v: Ymd) => new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();

/** Move a range by whole days (local calendar days for day ranges). */
function shiftDays(r: Range, days: number): Range {
  if (!days) return r;
  if (r.period === "24h") return hourRange(r, r.start + days * DAY);
  return dayRange(r.period, addDays(parseYmd(r.from)!, days), addDays(parseYmd(r.to)!, days), r.timezone, r.interval);
}

export const COMPARE_MODES = ["previous", "year", "custom"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export interface CompareSpec {
  mode: CompareMode;
  /** compare=custom: YYYY-MM-DD, inclusive, site timezone */
  from?: string;
  to?: string;
  /** shift the comparison so it starts on the same weekday (earlier for previous, nearest for year) */
  match_weekday?: boolean;
}

export type ComparisonRange = Range & { partial: boolean; mode: CompareMode; match_weekday: boolean };

/**
 * The range to compare `r` with:
 *   previous  the same-length range just before (calendar aware for mtd/ytd/12mo)
 *   year      the same dates one year earlier
 *   custom    compare_from..compare_to
 * For an in-progress `r` (previous and year), only the elapsed part is compared. match_weekday
 * shifts previous earlier (so it never overlaps `r`) and year to the nearest same weekday, so
 * Mondays are compared with Mondays. Returns null for period=all (nothing before it).
 */
export function comparisonRange(r: Range, spec: CompareSpec, now: number): ComparisonRange | null {
  const tz = r.timezone;
  const mw = !!spec.match_weekday;
  if (spec.mode === "custom") {
    const f = spec.from ? parseYmd(spec.from) : null;
    const t = spec.to ? parseYmd(spec.to) : null;
    if (!f || !t) throw new PeriodError("compare=custom needs compare_from and compare_to as YYYY-MM-DD.");
    if (dayDiff(f, t) < 0) throw new PeriodError("compare_from must be on or before compare_to.");
    if (dayDiff(f, t) > 3660) throw new PeriodError("Comparison ranges are limited to 10 years.");
    return { ...dayRange("custom", f, t, tz, r.interval), partial: false, mode: "custom", match_weekday: false };
  }
  if (r.period === "all") return null;
  const curStart = r.period === "24h" ? localDay(r.start, tz) : parseYmd(r.from)!;
  let cmp: Range;
  if (spec.mode === "previous") {
    cmp = previousFull(r);
    if (mw) {
      const cs = r.period === "24h" ? localDay(cmp.start, tz) : parseYmd(cmp.from)!;
      cmp = shiftDays(cmp, -((weekday(cs) - weekday(curStart) + 7) % 7));
    }
  } else {
    if (r.period === "24h") {
      const p = localParts(r.start, tz);
      cmp = hourRange(r, zonedToUtc(p.y - 1, p.m, Math.min(p.d, daysInMonth(p.y - 1, p.m)), p.h, tz));
    } else {
      cmp = dayRange(r.period, addMonths(parseYmd(r.from)!, -12), addMonths(parseYmd(r.to)!, -12), tz, r.interval);
    }
    if (mw) {
      const cs = r.period === "24h" ? localDay(cmp.start, tz) : parseYmd(cmp.from)!;
      let k = (weekday(curStart) - weekday(cs) + 7) % 7;
      if (k > 3) k -= 7;
      cmp = shiftDays(cmp, k);
    }
  }
  return { ...truncateElapsed(r, cmp, now), mode: spec.mode, match_weekday: mw };
}

function mondayOf(v: Ymd): Ymd {
  const dow = new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();
  return addDays(v, dow === 0 ? -6 : 1 - dow);
}

/**
 * Offset segments (local - UTC) over [start, end): one entry per DST regime, so SQL can turn
 * e.ts into local wall-clock time with a CASE instead of per-row timezone lookups.
 */
export function offsetSegments(start: number, end: number, tz: string): { from: number; offset: number }[] {
  const segs = [{ from: start, offset: tzOffsetMs(start, tz) }];
  const STEP = DAY; // DST changes are months apart, so one per step at most
  let t = start;
  while (t < end) {
    const next = Math.min(t + STEP, end);
    const cur = segs[segs.length - 1]!.offset;
    const off = tzOffsetMs(next, tz);
    if (off !== cur) {
      // binary search to the minute where the offset changes
      let lo = t;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
        if (mid <= lo) break;
        if (tzOffsetMs(mid, tz) === cur) lo = mid;
        else hi = mid;
      }
      segs.push({ from: hi, offset: off });
    }
    t = next;
  }
  return segs;
}

export interface Bucket {
  label: string;
  start: number;
  end: number;
}

export const MAX_BUCKETS = 1000;

/** Time buckets covering the range, labelled in local time. */
export function buckets(r: Range, interval: Interval): Bucket[] {
  const tz = r.timezone;
  const out: Bucket[] = [];
  const push = (label: string, start: number, end: number) => {
    const last = out[out.length - 1];
    if (last && last.label === label)
      last.end = end; // DST fall-back repeats an hour label
    else out.push({ label, start, end });
    if (out.length > MAX_BUCKETS) throw new PeriodError(`Too many ${interval} buckets for this period; use a larger interval.`);
  };
  if (interval === "hour") {
    for (let t = r.start; t < r.end; t += HOUR) {
      const p = localParts(t, tz);
      push(`${ymdString(p)} ${String(p.h).padStart(2, "0")}:00`, t, Math.min(t + HOUR, r.end));
    }
    return out;
  }
  let cur = localDay(r.start, tz);
  const last = parseYmd(r.to) ?? localDay(r.end - 1, tz);
  while (dayDiff(cur, last) >= 0) {
    let next: Ymd;
    if (interval === "day") next = addDays(cur, 1);
    else if (interval === "week") {
      const dow = new Date(Date.UTC(cur.y, cur.m - 1, cur.d)).getUTCDay(); // 0 = Sunday
      next = addDays(cur, dow === 0 ? 1 : 8 - dow); // next Monday
    } else next = { y: cur.m === 12 ? cur.y + 1 : cur.y, m: cur.m === 12 ? 1 : cur.m + 1, d: 1 };
    if (dayDiff(next, addDays(last, 1)) < 0) next = addDays(last, 1);
    // Weeks are labelled by their Monday (even a partial first week), matching the SQL bucket key.
    const label = interval === "month" ? ymdString(cur).slice(0, 7) : interval === "week" ? ymdString(mondayOf(cur)) : ymdString(cur);
    push(label, Math.max(midnight(cur, tz), r.start), Math.min(midnight(next, tz), r.end));
    cur = next;
  }
  return out;
}
