/**
 * Ingest derivation: one chunk of rrweb events -> the compact facts an agent reads. Pure and
 * bounded (at most LIMITS.EVENTS_PER_CHUNK events looked at, MAX_DERIVED_PER_CHUNK facts
 * kept), so it runs in the Worker within its CPU budget and is unit-tested with fixtures.
 *
 * Everything in a chunk is untrusted (anyone can POST one): every field is type-checked, clipped
 * and clamped here, and anything malformed is dropped and counted in `dropped`.
 */

import { errorFingerprint, fnv1a64 } from "./fingerprint";
import { LIMITS } from "./limits";
import { cleanText, scrubPath, scrubText, stripQuery } from "./mask-rules";
import { type Envelope, type NavType, SESSION_ID_RE, TAGS } from "./protocol";

export interface DerivedPage {
  ts: number;
  pv: number;
  path: string;
  host: string;
  title: string | null;
  referrer: string | null;
  nav: NavType;
  vw: number;
  vh: number;
  dh: number;
}
export interface DerivedClick {
  ts: number;
  pv: number;
  selector: string;
  label: string;
  label_masked: boolean;
  tag: string;
  interactive: boolean;
  x: number;
  y: number;
  doc_w: number;
  doc_h: number;
  top_pct: number;
  href: string | null;
  blocked: boolean;
  /** no DOM change, scroll, input, navigation or page hide within DEAD_MS inside this chunk */
  dead: boolean;
  /** the DEAD_MS window reaches past this chunk: a later chunk may still show an effect */
  open: boolean;
  /** the zone the recorder put the click in (a configured zones selector or a landmark), if any */
  zone?: string | null;
}
export interface DerivedInput {
  ts: number;
  pv: number;
  selector: string;
  tag: string;
  name: string | null;
  label: string | null;
  masked: boolean;
}
export interface DerivedError {
  ts: number;
  pv: number;
  kind: "error" | "rejection" | "console" | "warn";
  message: string;
  source: string | null;
  line: number | null;
  col: number | null;
  stack: string | null;
  fingerprint: string;
}
export interface DerivedCustom {
  ts: number;
  pv: number;
  name: string;
  props: Record<string, string | number | boolean | null> | null;
}
export interface DerivedNet {
  ts: number;
  pv: number;
  method: string;
  /** same-site path or origin + path, query stripped, id-like segments as :id */
  url: string;
  /** 0 = network failure */
  status: number;
  ms: number;
  fingerprint: string;
}
export interface DerivedTag {
  ts: number;
  pv: number;
  key: string;
  values: string[];
}
/** Visitor activity on one pageview within a chunk (active time). pv 0 = the session's current page. */
export interface DerivedActivity {
  pv: number;
  first: number;
  last: number;
  /** sum of the gaps between consecutive activity points, each at most ACTIVE_GAP_MS */
  ms: number;
}
export interface DerivedMark {
  ts: number;
  pv: number;
  /** hide: hidden | pagehide | max_duration | stop | excluded; idle */
  kind: "hide" | "idle";
  detail: string;
}
export interface ScrollSegment {
  pv: number;
  first_ts: number;
  last_ts: number;
  first_y: number;
  last_y: number;
  /** -1 up, 1 down, 0 none yet */
  first_dir: number;
  last_dir: number;
  dist: number;
  reversals: number;
  /** % of the document seen at most ((y + viewport) / document height) */
  max_reach: number;
  dh: number;
  vh: number;
  /** first time 25/50/75/100% was reached in this chunk */
  milestones: { pct: number; ts: number }[];
  /** the positions themselves [ts, y] (at most 200; attention map) */
  pts?: [number, number][];
}
export interface DerivedChunk {
  first_ts: number;
  last_ts: number;
  /** max(last event, client send time): what this chunk is known to cover */
  cover_end: number;
  rr_events: number;
  full_snapshots: number;
  effects: number;
  pages: DerivedPage[];
  clicks: DerivedClick[];
  inputs: DerivedInput[];
  errors: DerivedError[];
  customs: DerivedCustom[];
  nets: DerivedNet[];
  tags: DerivedTag[];
  marks: DerivedMark[];
  scrolls: ScrollSegment[];
  activity: DerivedActivity[];
  /** quantised (50 ms) effect timestamps in this chunk's first DEAD_MS: resolve open clicks of earlier chunks */
  effect_head: number[];
  viewport: { w: number; h: number } | null;
  /** page hostnames named by afs.page events and rrweb Meta events */
  hosts: string[];
  /** events or facts dropped: malformed, out of range, over the caps */
  dropped: number;
  /** of those, malformed or out of range (not just over a cap): a chunk that is mostly this is refused */
  invalid: number;
  truncated: boolean;
}

/** A click with no visible effect within this long is dead. */
export const DEAD_MS = 1000;

/**
 * Active time: the visitor counts as active between two activity points (pointer move or click,
 * scroll, input, touch, drag, selection) at most this far apart, so a tab left open doesn't count.
 */
export const ACTIVE_GAP_MS = 5000;
const ACTIVITY_SOURCES = new Set([
  1 /* MouseMove */, 2 /* MouseInteraction */, 3 /* Scroll */, 5 /* Input */, 6 /* TouchMove */, 12 /* Drag */, 14 /* Selection */,
]);

/** Activity points (ts, pv) -> active ms per pageview: gaps up to ACTIVE_GAP_MS count. */
export function activitySegments(points: { ts: number; pv: number }[]): DerivedActivity[] {
  const byPv = new Map<number, number[]>();
  for (const p of points) {
    const l = byPv.get(p.pv);
    if (l) l.push(p.ts);
    else byPv.set(p.pv, [p.ts]);
  }
  const out: DerivedActivity[] = [];
  for (const [pv, ts] of byPv) {
    ts.sort((a, b) => a - b);
    let ms = 0;
    for (let i = 1; i < ts.length; i++) ms += Math.min(ACTIVE_GAP_MS, ts[i]! - ts[i - 1]!);
    out.push({ pv, first: ts[0]!, last: ts[ts.length - 1]!, ms });
  }
  return out;
}

/** rrweb IncrementalSource values that count as a visible effect of a click. */
const EFFECT_SOURCES = new Set([
  0 /* Mutation */, 3 /* Scroll */, 5 /* Input */, 7 /* MediaInteraction */, 8 /* StyleSheetRule */, 13 /* StyleDeclaration */,
]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A string field: control characters, separators and bidi overrides removed (cleanText), clipped. */
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string" || !v.length) return null;
  const s = cleanText(v.length > max * 2 ? v.slice(0, max * 2) : v).trim();
  return s ? (s.length > max ? s.slice(0, max) : s) : null;
};
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : null;
const NAV: readonly NavType[] = ["load", "reload", "back_forward", "push", "replace", "pop"];
const HIDE_KINDS = new Set(["hidden", "pagehide", "max_duration", "stop", "excluded"]);

/**
 * A path the way we store it: starts with "/", no query or fragment, id-like segments (emails,
 * numbers, uuids, tokens) as ":id", no control characters, at most 500 characters.
 */
export function cleanPath(v: unknown): string | null {
  const s = str(v, 2000);
  if (!s || s[0] !== "/") return null;
  return scrubPath(stripQuery(s).replace(/\s/g, "")).slice(0, 500) || "/";
}

function cleanHref(v: unknown): string | null {
  const s = str(v, 2000);
  if (!s) return null;
  if (s[0] === "/") return cleanPath(s);
  const m = /^(https?:\/\/[a-z0-9.-]+(?::\d{1,5})?)(\/[^\s]*)?$/i.exec(stripQuery(s));
  if (m) return `${m[1]!.toLowerCase()}${cleanPath(m[2] ?? "/") ?? "/"}`.slice(0, 500);
  return null;
}

function cleanProps(v: unknown): Record<string, string | number | boolean | null> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n >= 20) break;
    const key = k.slice(0, 40);
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (val === null || typeof val === "boolean" || (typeof val === "number" && Number.isFinite(val))) out[key] = val;
    else if (typeof val === "string") out[key] = cleanText(val.slice(0, 200));
    else continue;
    n++;
  }
  return n ? out : null;
}

/** A failed request's group: method, URL (already scrubbed) and status. */
export const netFingerprint = (method: string, url: string, status: number) => fnv1a64(`net|${method}|${url}|${status}`);

/** Custom tag keys: letters, digits and _ . - (like event props), not starting with "__" (no __proto__); ":" separates key and value in filters. */
export const TAG_KEY_RE = /^(?!__)[A-Za-z0-9_.-]{1,50}$/;

/** Tag values as stored: strings, numbers or booleans, at most 5, 100 characters, scrubbed like error messages. */
export function cleanTagValues(v: unknown): string[] {
  const list = Array.isArray(v) ? v.slice(0, 5) : [v];
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== "string" && typeof x !== "boolean" && !(typeof x === "number" && Number.isFinite(x))) continue;
    const s = str(scrubText(cleanText(String(x).slice(0, 400)), 100), 100);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export type EnvelopeResult = { ok: true; env: Envelope } | { ok: false; error: string; hint: string };

/** The tags runtime's visitor ids (afst.visitorId()). */
export const TAGS_VISITOR_RE = /^[A-Za-z0-9_.-]{6,64}$/;

/** The fields an envelope may have; anything else is refused (chunks are stored as received). */
const ENVELOPE_KEYS = new Set(["v", "sid", "seq", "t", "ev", "end", "uid", "avid", "f", "wd", "up", "tvid"]);

/** Check a decoded body against the query string (?sid=&q=) it was sent with. */
export function parseEnvelope(raw: unknown, q: { sid: string; seq: number }): EnvelopeResult {
  if (!isObj(raw)) return { ok: false, error: "invalid_body", hint: "The body must be a JSON object (an afs-replay envelope)." };
  if (raw.v !== 1) return { ok: false, error: "unsupported_version", hint: "Reload the page to get the current recorder." };
  if (raw.sid !== q.sid || !SESSION_ID_RE.test(q.sid))
    return { ok: false, error: "session_mismatch", hint: "sid in the body must match ?sid=." };
  if (raw.seq !== q.seq) return { ok: false, error: "seq_mismatch", hint: "seq in the body must match ?q=." };
  if (!Array.isArray(raw.ev)) return { ok: false, error: "invalid_body", hint: "ev must be an array of rrweb events." };
  const extra = Object.keys(raw).find((k) => !ENVELOPE_KEYS.has(k));
  if (extra !== undefined)
    return {
      ok: false,
      error: "invalid_body",
      hint: `Unknown envelope field ${JSON.stringify(extra.slice(0, 40))}; send only the recorder's fields.`,
    };
  const t = typeof raw.t === "number" && Number.isFinite(raw.t) ? raw.t : 0;
  const env: Envelope = { v: 1, sid: q.sid, seq: q.seq, t, ev: raw.ev };
  if (raw.end === 1) env.end = 1;
  const uid = str(raw.uid, 200);
  if (uid) env.uid = uid;
  const avid = str(raw.avid, 64);
  if (avid && /^[A-Za-z0-9_-]{8,64}$/.test(avid)) env.avid = avid;
  if (raw.f === 1) env.f = 1;
  if (raw.wd === 1) env.wd = 1;
  const up = str(raw.up, 60);
  if (up) env.up = up;
  const tvid = str(raw.tvid, 64);
  if (tvid && TAGS_VISITOR_RE.test(tvid)) env.tvid = tvid;
  return { ok: true, env };
}

const q50 = (ts: number) => Math.floor(ts / 50) * 50;

/** Is there a value in sorted `arr` inside (from, to]? */
export function anyIn(arr: readonly number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < arr.length && arr[lo]! <= to;
}

/** Clicks into text fields and labels focus something: no DOM change is expected, so they are never dead. */
export function focusClick(tag: string): boolean {
  if (tag === "textarea" || tag === "select" || tag === "label") return true;
  const m = /^input\[type=([a-z-]+)\]$/.exec(tag);
  return !!m && !["submit", "button", "reset", "image", "checkbox", "radio", "file", "color", "range"].includes(m[1]!);
}

/** A chunk with no facts (also what tests build on). */
export function emptyChunk(): DerivedChunk {
  return {
    first_ts: 0,
    last_ts: 0,
    cover_end: 0,
    rr_events: 0,
    full_snapshots: 0,
    effects: 0,
    pages: [],
    clicks: [],
    inputs: [],
    errors: [],
    customs: [],
    nets: [],
    tags: [],
    marks: [],
    scrolls: [],
    activity: [],
    effect_head: [],
    viewport: null,
    hosts: [],
    dropped: 0,
    invalid: 0,
    truncated: false,
  };
}

/**
 * Derive one chunk. `now` bounds timestamps: events claiming to be from the future (beyond
 * `now` + 5 min of the client's corrected clock) or older than a day are dropped. `maxDerived`
 * caps the facts kept (MAX_DERIVED_PER_CHUNK); clicks beyond LIMITS.CLICKS_PER_SECOND in any 1 s
 * window are dropped (no person clicks that fast).
 */
export function deriveChunk(env: Envelope, opts: { minTs: number; maxTs: number; maxDerived?: number }): DerivedChunk {
  const maxDerived = Math.max(0, Math.min(LIMITS.DERIVED_PER_CHUNK_MAX, opts.maxDerived ?? LIMITS.DERIVED_PER_CHUNK_MAX));
  const out = emptyChunk();

  const events = env.ev;
  if (events.length > LIMITS.EVENTS_PER_CHUNK) out.truncated = true;
  const effectTimes: number[] = [];
  const navTimes: number[] = [];
  const scrollPts: ScrollPoint[] = [];
  const activity: { ts: number; pv: number }[] = [];
  /** the pageview the latest afs.* event named: rrweb's own events don't say which page they are on */
  let curPv = 0;
  const hosts = new Set<string>();
  let derived = 0;
  const bad = () => {
    out.dropped++;
    out.invalid++;
  };
  const room = () => {
    if (derived >= maxDerived) {
      out.truncated = true;
      out.dropped++;
      return false;
    }
    derived++;
    return true;
  };
  let first = Number.POSITIVE_INFINITY;
  let last = 0;

  const n = Math.min(events.length, LIMITS.EVENTS_PER_CHUNK);
  for (let i = 0; i < n; i++) {
    const e = events[i];
    if (!isObj(e) || typeof e.type !== "number" || typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) {
      bad();
      continue;
    }
    const ts = Math.round(e.timestamp);
    if (ts < opts.minTs || ts > opts.maxTs) {
      bad();
      continue;
    }
    out.rr_events++;
    if (ts < first) first = ts;
    if (ts > last) last = ts;
    const data = isObj(e.data) ? e.data : {};
    if (e.type === 2) out.full_snapshots++;
    else if (e.type === 4) {
      const w = int(data.width, 0, 20_000);
      const h = int(data.height, 0, 20_000);
      if (w !== null && h !== null) out.viewport = { w, h };
      const mh = typeof data.href === "string" ? /^https?:\/\/([^/:?#\s]+)/i.exec(data.href) : null;
      if (mh) hosts.add(mh[1]!.toLowerCase().slice(0, 253));
      navTimes.push(ts);
    } else if (e.type === 3) {
      if (typeof data.source === "number" && EFFECT_SOURCES.has(data.source)) {
        out.effects++;
        effectTimes.push(q50(ts));
      }
      if (typeof data.source === "number" && ACTIVITY_SOURCES.has(data.source) && activity.length < 5000) activity.push({ ts, pv: curPv });
    } else if (e.type === 5) {
      const tag = data.tag;
      const p = data.payload;
      if (typeof tag !== "string" || !tag.startsWith("afs.") || !isObj(p)) continue;
      const pv = int(p.pv, 0, 100_000);
      if (pv === null) {
        bad();
        continue;
      }
      curPv = pv;
      if (tag === TAGS.page) {
        const path = cleanPath(p.p);
        const host = str(p.h, 253)?.toLowerCase() ?? "";
        // A page names its hostname; without one the page can't be checked against the site's hosts.
        if (!path || !/^[a-z0-9.-]+$/.test(host)) {
          bad();
          continue;
        }
        if (!room()) continue;
        hosts.add(host);
        const nav = NAV.includes(p.nav as NavType) ? (p.nav as NavType) : "load";
        out.pages.push({
          ts,
          pv,
          path,
          host,
          title: str(p.t, 200),
          referrer: str(p.r, 500)
            ? (cleanPath(p.r) ?? (/^[a-z0-9.-]+$/i.test(String(p.r)) ? String(p.r).toLowerCase().slice(0, 253) : null))
            : null,
          nav,
          vw: int(p.w, 0, 20_000) ?? 0,
          vh: int(p.vh, 0, 20_000) ?? 0,
          dh: int(p.dh, 0, 1_000_000) ?? 0,
        });
        navTimes.push(ts);
        scrollPts.push({ ts, pv, y: 0, dh: int(p.dh, 0, 1_000_000) ?? 0, vh: int(p.vh, 0, 20_000) ?? 0, load: true });
      } else if (tag === TAGS.click) {
        const selector = str(p.s, 300);
        if (!selector) {
          bad();
          continue;
        }
        if (!room()) continue;
        const doc_h = int(p.dh, 0, 1_000_000) ?? 0;
        out.clicks.push({
          ts,
          pv,
          selector,
          label: str(p.l, 120) ?? "",
          label_masked: p.lm === 1,
          tag: (str(p.tg, 40) ?? "").toLowerCase().replace(/[^a-z0-9[\]=-]/g, ""),
          interactive: p.i === 1,
          x: int(p.x, 0, 1_000_000) ?? 0,
          y: int(p.y, 0, 1_000_000) ?? 0,
          doc_w: int(p.w, 0, 1_000_000) ?? 0,
          doc_h,
          top_pct: int(p.top, 0, 100) ?? 0,
          href: cleanHref(p.h),
          blocked: p.b === 1,
          dead: false,
          open: false,
          zone: str(p.z, 120),
        });
      } else if (tag === TAGS.input) {
        const selector = str(p.s, 300);
        if (!selector) {
          bad();
          continue;
        }
        if (!room()) continue;
        out.inputs.push({
          ts,
          pv,
          selector,
          tag: (str(p.tg, 40) ?? "input").toLowerCase().replace(/[^a-z0-9[\]=-]/g, ""),
          name: str(p.n, 60),
          label: str(p.l, 120),
          masked: p.m !== 0,
        });
      } else if (tag === TAGS.scroll) {
        const y = int(p.y, 0, 1_000_000);
        if (y === null) continue;
        scrollPts.push({ ts, pv, y, dh: int(p.dh, 0, 1_000_000) ?? 0, vh: int(p.vh, 0, 20_000) ?? 0 });
      } else if (tag === TAGS.error) {
        const kind = p.k === "rejection" || p.k === "console" || p.k === "warn" ? p.k : "error";
        const message = scrubText(str(p.m, 1000) ?? "Error", 500);
        if (!room()) continue;
        const src = str(p.src, 600);
        const source = src ? stripQuery(src).replace(/\s/g, "").slice(0, 300) || null : null;
        const stack = typeof p.st === "string" && p.st ? scrubText(cleanText(p.st.slice(0, 3000), true), 1500) : null;
        const at = int(p.at, opts.minTs, ts);
        out.errors.push({
          ts: at !== null && at >= ts - 60_000 ? at : ts,
          pv,
          kind,
          message,
          source,
          line: int(p.ln, 0, 10_000_000),
          col: int(p.col, 0, 10_000_000),
          stack,
          fingerprint: errorFingerprint(kind, message, source, stack),
        });
      } else if (tag === TAGS.event) {
        const name = str(p.n, 100);
        if (!name || !room()) continue;
        out.customs.push({ ts, pv, name, props: cleanProps(p.p) });
      } else if (tag === TAGS.net) {
        const url = cleanHref(p.u);
        const status = int(p.st, 0, 999);
        if (!url || status === null || (status > 0 && status < 400)) {
          bad();
          continue;
        }
        if (!room()) continue;
        const m = typeof p.m === "string" ? p.m.toUpperCase() : "";
        const method = /^[A-Z]{1,10}$/.test(m) ? m : "GET";
        out.nets.push({ ts, pv, method, url, status, ms: int(p.ms, 0, 600_000) ?? 0, fingerprint: netFingerprint(method, url, status) });
      } else if (tag === TAGS.tag) {
        const key = str(p.k, 50);
        if (!key || !TAG_KEY_RE.test(key)) {
          bad();
          continue;
        }
        const values = cleanTagValues(p.v);
        if (!values.length || !room()) continue;
        out.tags.push({ ts, pv, key, values });
      } else if (tag === TAGS.hide || tag === TAGS.idle) {
        const detail = tag === TAGS.idle ? "idle" : HIDE_KINDS.has(String(p.k)) ? String(p.k) : "hidden";
        if (!room()) continue;
        out.marks.push({ ts, pv, kind: tag === TAGS.idle ? "idle" : "hide", detail });
        if (tag === TAGS.hide) navTimes.push(ts);
      }
    }
  }
  if (!Number.isFinite(first)) first = last = 0;
  out.clicks = capClickRate(out.clicks, out);
  out.first_ts = first;
  out.last_ts = last;
  out.cover_end = Math.max(last, Math.min(opts.maxTs, env.t || 0));
  out.hosts = [...hosts];

  effectTimes.sort((a, b) => a - b);
  navTimes.sort((a, b) => a - b);
  const effects = [...new Set(effectTimes)];
  out.effect_head = effects.filter((t) => t <= first + DEAD_MS).slice(0, LIMITS.EFFECT_HEAD);

  // Dead clicks within the chunk. Effect timestamps are quantised down to 50 ms, so allow that slack.
  for (const c of out.clicks) {
    if (focusClick(c.tag)) continue;
    const effect = anyIn(effects, c.ts - 50, c.ts + DEAD_MS) || anyIn(navTimes, c.ts, c.ts + DEAD_MS);
    c.dead = !effect;
    c.open = !effect && c.ts + DEAD_MS > out.cover_end;
  }

  out.scrolls = scrollSegments(scrollPts);
  out.activity = activitySegments(activity);
  return out;
}

/** Keep at most LIMITS.CLICKS_PER_SECOND clicks in any 1 s window (sorted by time); the rest are dropped. */
function capClickRate(clicks: DerivedClick[], out: { dropped: number; truncated: boolean }): DerivedClick[] {
  if (clicks.length <= LIMITS.CLICKS_PER_SECOND) return clicks;
  const sorted = [...clicks].sort((a, b) => a.ts - b.ts);
  const kept: DerivedClick[] = [];
  let lo = 0;
  for (const c of sorted) {
    while (lo < kept.length && kept[lo]!.ts <= c.ts - 1000) lo++;
    if (kept.length - lo >= LIMITS.CLICKS_PER_SECOND) {
      out.dropped++;
      out.truncated = true;
      continue;
    }
    kept.push(c);
  }
  return kept;
}

const REVERSAL_MIN_PX = 40;
const MILESTONES = [25, 50, 75, 100];

export interface ScrollPoint {
  ts: number;
  pv: number;
  y: number;
  dh: number;
  vh: number;
  /** the page event itself: counts for reach (the first screen), not as a scroll milestone */
  load?: boolean;
}

/** Per-pageview scroll summary of a chunk's scroll positions (page events count as y = 0). */
export function scrollSegments(points: ScrollPoint[]): ScrollSegment[] {
  const byPv = new Map<number, typeof points>();
  for (const p of points) {
    const list = byPv.get(p.pv);
    if (list) list.push(p);
    else byPv.set(p.pv, [p]);
  }
  const out: ScrollSegment[] = [];
  for (const [pv, pts] of byPv) {
    pts.sort((a, b) => a.ts - b.ts);
    const seg: ScrollSegment = {
      pv,
      first_ts: pts[0]!.ts,
      last_ts: pts[pts.length - 1]!.ts,
      first_y: pts[0]!.y,
      last_y: pts[0]!.y,
      first_dir: 0,
      last_dir: 0,
      dist: 0,
      reversals: 0,
      max_reach: 0,
      dh: 0,
      vh: 0,
      milestones: [],
      pts: pts.slice(0, 200).map((p) => [p.ts, p.y] as [number, number]),
    };
    let anchor = pts[0]!.y; // last y where a direction was established
    for (const p of pts) {
      seg.dh = Math.max(seg.dh, p.dh);
      if (p.vh) seg.vh = p.vh;
      seg.dist += Math.abs(p.y - seg.last_y);
      seg.last_y = p.y;
      const delta = p.y - anchor;
      if (Math.abs(delta) >= REVERSAL_MIN_PX) {
        const dir = delta > 0 ? 1 : -1;
        if (seg.last_dir !== 0 && dir !== seg.last_dir) seg.reversals++;
        if (seg.first_dir === 0) seg.first_dir = dir;
        seg.last_dir = dir;
        anchor = p.y;
      }
      if (p.dh > 0) {
        const reach = Math.min(100, Math.round(((p.y + (p.vh || seg.vh)) / p.dh) * 100));
        if (!p.load)
          for (const m of MILESTONES) {
            if (reach >= (m === 100 ? 98 : m) && seg.max_reach < (m === 100 ? 98 : m) && !seg.milestones.some((x) => x.pct === m))
              seg.milestones.push({ pct: m, ts: p.ts });
          }
        seg.max_reach = Math.max(seg.max_reach, reach);
      }
    }
    out.push(seg);
  }
  return out;
}

/** Shift every timestamp of a derived chunk (client clock skew correction). */
export function shiftChunk(d: DerivedChunk, ms: number): DerivedChunk {
  if (!ms) return d;
  const s = (t: number) => t + ms;
  return {
    ...d,
    first_ts: s(d.first_ts),
    last_ts: s(d.last_ts),
    cover_end: s(d.cover_end),
    pages: d.pages.map((x) => ({ ...x, ts: s(x.ts) })),
    clicks: d.clicks.map((x) => ({ ...x, ts: s(x.ts) })),
    inputs: d.inputs.map((x) => ({ ...x, ts: s(x.ts) })),
    errors: d.errors.map((x) => ({ ...x, ts: s(x.ts) })),
    customs: d.customs.map((x) => ({ ...x, ts: s(x.ts) })),
    tags: d.tags.map((x) => ({ ...x, ts: s(x.ts) })),
    nets: d.nets.map((x) => ({ ...x, ts: s(x.ts) })),
    activity: d.activity.map((x) => ({ ...x, first: s(x.first), last: s(x.last) })),
    marks: d.marks.map((x) => ({ ...x, ts: s(x.ts) })),
    scrolls: d.scrolls.map((x) => ({
      ...x,
      pts: x.pts?.map(([t, y]) => [s(t), y] as [number, number]),
      first_ts: s(x.first_ts),
      last_ts: s(x.last_ts),
      milestones: x.milestones.map((m) => ({ ...m, ts: s(m.ts) })),
    })),
    effect_head: d.effect_head.map(s),
  };
}

/** Attention: ms each 10% band of a page was in view, from positions held until the next one. */
export const ATTENTION_BANDS = 10;
/** A position counts at most this long (a tab left open on one screen doesn't pile up). */
export const ATTENTION_HOLD_MS = 30_000;

export function attentionAdd(bands: number[], points: readonly [number, number][], vh: number, dh: number, until: number | null): number[] {
  const out = bands.length === ATTENTION_BANDS ? [...bands] : new Array<number>(ATTENTION_BANDS).fill(0);
  if (!dh || !vh || !points.length) return out;
  const band = dh / ATTENTION_BANDS;
  const add = (y: number, dt: number) => {
    if (dt <= 0) return;
    const top = Math.max(0, y);
    const bottom = Math.min(dh, y + vh);
    for (let b = 0; b < ATTENTION_BANDS; b++) {
      const overlap = Math.min(bottom, (b + 1) * band) - Math.max(top, b * band);
      if (overlap > 0) out[b]! += Math.round(dt * (overlap / band));
    }
  };
  for (let i = 0; i < points.length; i++) {
    const [t, y] = points[i]!;
    const next = i + 1 < points.length ? points[i + 1]![0] : until;
    if (next !== null) add(y, Math.min(ATTENTION_HOLD_MS, next - t));
  }
  return out;
}
