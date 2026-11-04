/**
 * Frustration signals, computed on the server from the derived event log. Pure: the Durable Object
 * feeds them rows from SQLite, the unit tests feed them fixtures. Definitions (also in llms.txt):
 *
 *   rage click        >= 3 clicks within 1 s on the same element (same selector) or within 30 px,
 *                     on the same pageview. Every click in the burst is flagged; the burst counts once.
 *   dead click        no DOM change, scroll, input, navigation or page hide within 1 s of a click
 *                     (clicks that focus a text field or label are never dead). Computed while
 *                     deriving a chunk (lib/derive.ts) and resolved across chunk boundaries in the DO.
 *   error click       a JS error within 1 s after a click.
 *   quick back        a pageview left within 7 s for the page the visitor came from (A -> B -> A):
 *                     flagged on B, the page that didn't deliver.
 *   excessive scroll  on one pageview, >= 4 direction reversals and a scrolled distance of at least
 *                     2.5x the page's scrollable height.
 *   api error         a fetch/XHR request answered >= 400 or failed (capture_network_errors); one within
 *                     1 s after a click records that click (it doesn't make it an error click).
 */

export const RAGE_WINDOW_MS = 1000;
export const RAGE_MIN_CLICKS = 3;
export const RAGE_RADIUS_PX = 30;
/**
 * How many earlier clicks each click is compared with. Ingest keeps at most 20 clicks in any 1 s
 * window (LIMITS.CLICKS_PER_SECOND), so this is exact for real input and keeps detection linear
 * (O(20 n)) for anything else, e.g. overlapping chunks crafted to pile thousands of clicks into one second.
 */
export const RAGE_LOOKBACK = 20;
export const ERROR_CLICK_MS = 1000;
export const QUICK_BACK_MS = 7000;
export const EXCESSIVE_MIN_REVERSALS = 4;
export const EXCESSIVE_DISTANCE_FACTOR = 2.5;

export interface ClickPoint {
  ts: number;
  pv: number;
  selector: string;
  x: number;
  y: number;
}

const sameTarget = (a: ClickPoint, b: ClickPoint) =>
  a.pv === b.pv && (a.selector === b.selector || Math.hypot(a.x - b.x, a.y - b.y) <= RAGE_RADIUS_PX);

/**
 * Rage clicks over clicks sorted by ts. `rage[i]`: click i belongs to a burst; `start[i]`: it is
 * the first click of its burst (count bursts by counting starts).
 */
export function detectRage(clicks: readonly ClickPoint[]): { rage: boolean[]; start: boolean[] } {
  const n = clicks.length;
  const rage = new Array<boolean>(n).fill(false);
  for (let j = 0; j < n; j++) {
    // Clicks on the same target within the window ending at j.
    const members = [j];
    const stop = Math.max(0, j - RAGE_LOOKBACK);
    for (let i = j - 1; i >= stop && clicks[j]!.ts - clicks[i]!.ts <= RAGE_WINDOW_MS; i--)
      if (sameTarget(clicks[i]!, clicks[j]!)) members.push(i);
    if (members.length >= RAGE_MIN_CLICKS) for (const m of members) rage[m] = true;
  }
  const start = new Array<boolean>(n).fill(false);
  for (let j = 0; j < n; j++) {
    if (!rage[j]) continue;
    let continues = false;
    const stop = Math.max(0, j - RAGE_LOOKBACK);
    for (let i = j - 1; i >= stop && clicks[j]!.ts - clicks[i]!.ts <= RAGE_WINDOW_MS; i--) {
      if (rage[i] && sameTarget(clicks[i]!, clicks[j]!)) {
        continues = true;
        break;
      }
    }
    start[j] = !continues;
  }
  return { rage, start };
}

/**
 * Error clicks: for each click (sorted by ts), whether an error (sorted by ts) followed within
 * ERROR_CLICK_MS; and for each error, the index of the click that triggered it (the latest click
 * at most ERROR_CLICK_MS before it), or -1.
 */
export function errorClicks(
  clicks: readonly { ts: number }[],
  errors: readonly { ts: number }[],
): { clickHit: boolean[]; errorClick: number[] } {
  const clickHit = new Array<boolean>(clicks.length).fill(false);
  const errorClick = new Array<number>(errors.length).fill(-1);
  let c = 0;
  for (let e = 0; e < errors.length; e++) {
    const et = errors[e]!.ts;
    while (c < clicks.length && clicks[c]!.ts <= et) c++;
    // clicks[c-1] is the latest click at or before the error
    const k = c - 1;
    if (k >= 0 && et - clicks[k]!.ts <= ERROR_CLICK_MS) {
      errorClick[e] = k;
      clickHit[k] = true;
    }
  }
  return { clickHit, errorClick };
}

export interface PageVisit {
  pv: number;
  ts: number;
  path: string;
}

/** Quick backs over a session's pageviews sorted by pv: `true` at index i when page i was bounced off. */
export function quickBacks(pages: readonly PageVisit[]): boolean[] {
  const out = new Array<boolean>(pages.length).fill(false);
  for (let i = 1; i + 1 < pages.length; i++) {
    const prev = pages[i - 1]!;
    const cur = pages[i]!;
    const next = pages[i + 1]!;
    if (cur.path !== prev.path && next.path === prev.path && next.ts - cur.ts <= QUICK_BACK_MS && next.ts >= cur.ts) out[i] = true;
  }
  return out;
}

export function excessiveScroll(s: { dist: number; reversals: number; doc_h: number | null; view_h: number | null }): boolean {
  const dh = s.doc_h ?? 0;
  const vh = s.view_h ?? 0;
  const scrollable = dh - vh;
  if (!dh || scrollable < Math.max(200, vh / 2)) return false;
  return s.reversals >= EXCESSIVE_MIN_REVERSALS && s.dist >= EXCESSIVE_DISTANCE_FACTOR * scrollable;
}

export interface SignalCounts {
  rage_clicks: number;
  dead_clicks: number;
  /** dead clicks on interactive elements (buttons, links, ...): the "broken" kind */
  dead_interactive: number;
  error_clicks: number;
  errors: number;
  quick_backs: number;
  excessive_scrolls: number;
  /** failed requests (capture_network_errors) */
  api_errors?: number;
}

/** Score weights; the sum is capped at 100. */
export const FRUSTRATION_WEIGHTS = {
  rage_click: 25,
  error_click: 20,
  dead_interactive: 10,
  dead_other: 2,
  error: 8,
  errors_cap: 32,
  quick_back: 10,
  excessive_scroll: 10,
  api_error: 6,
  api_errors_cap: 24,
} as const;

/** 0-100. Rage and error clicks dominate; plain dead clicks on text count little. */
export function frustrationScore(c: SignalCounts): number {
  const w = FRUSTRATION_WEIGHTS;
  const deadOther = Math.max(0, c.dead_clicks - c.dead_interactive);
  const raw =
    c.rage_clicks * w.rage_click +
    c.error_clicks * w.error_click +
    c.dead_interactive * w.dead_interactive +
    Math.min(deadOther * w.dead_other, 10) +
    Math.min(c.errors * w.error, w.errors_cap) +
    c.quick_backs * w.quick_back +
    c.excessive_scrolls * w.excessive_scroll +
    Math.min((c.api_errors ?? 0) * w.api_error, w.api_errors_cap);
  return Math.min(100, Math.round(raw));
}

export const SIGNALS = ["rage_click", "dead_click", "error_click", "quick_back", "excessive_scroll", "js_error", "api_error"] as const;
export type Signal = (typeof SIGNALS)[number];
