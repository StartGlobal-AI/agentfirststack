/**
 * The per-site engine: schema, ingest of derived chunks, signal resolution across chunks. Runs
 * inside ReplaySiteDO (one SQLite database per replay site) and, in unit tests, on node:sqlite.
 *
 * Ingest work here is small and bounded on purpose: the Worker already decompressed and derived
 * the chunk (lib/derive.ts); the DO inserts a few dozen rows, re-evaluates signals in a window of
 * a few seconds around the chunk, and recomputes the session's counters.
 */

import type { DerivedChunk } from "../lib/derive";
import { anyIn, DEAD_MS, shiftChunk } from "../lib/derive";
import { LIMITS } from "../lib/limits";
import type { PageRow, SessionRow } from "../lib/rows";
import { detectRage, errorClicks, excessiveScroll, frustrationScore, quickBacks } from "../lib/signals";
import { type Db, DAY, IN_JSON, marks, num, type Row, type SqlValue, strOrNull, utcDay } from "./db";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  entry_path TEXT,
  exit_path TEXT,
  pageviews INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  inputs INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  rage_clicks INTEGER NOT NULL DEFAULT 0,
  dead_clicks INTEGER NOT NULL DEFAULT 0,
  dead_interactive INTEGER NOT NULL DEFAULT 0,
  error_clicks INTEGER NOT NULL DEFAULT 0,
  quick_backs INTEGER NOT NULL DEFAULT 0,
  excessive_scrolls INTEGER NOT NULL DEFAULT 0,
  frustration INTEGER NOT NULL DEFAULT 0,
  device TEXT,
  browser TEXT,
  browser_version TEXT,
  os TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  viewport_w INTEGER,
  viewport_h INTEGER,
  user_id TEXT,
  analytics_visitor_id TEXT,
  ua_hash TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  rr_events INTEGER NOT NULL DEFAULT 0,
  derived INTEGER NOT NULL DEFAULT 0,
  ended INTEGER NOT NULL DEFAULT 0,
  forced INTEGER NOT NULL DEFAULT 0,
  skew_ms INTEGER NOT NULL DEFAULT 0,
  limited TEXT
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS sessions_frustration ON sessions(frustration, started_at);
CREATE INDEX IF NOT EXISTS sessions_day ON sessions(day);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_avid ON sessions(analytics_visitor_id) WHERE analytics_visitor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chunks (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  cover_end INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  rr_events INTEGER NOT NULL,
  effect_head TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pages (
  session_id TEXT NOT NULL,
  pv INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  path TEXT,
  host TEXT,
  title TEXT,
  referrer TEXT,
  nav TEXT,
  left_at INTEGER,
  max_scroll INTEGER NOT NULL DEFAULT 0,
  doc_h INTEGER,
  view_h INTEGER,
  scroll_dist INTEGER NOT NULL DEFAULT 0,
  reversals INTEGER NOT NULL DEFAULT 0,
  last_y INTEGER,
  last_dir INTEGER NOT NULL DEFAULT 0,
  quick_back INTEGER NOT NULL DEFAULT 0,
  excessive_scroll INTEGER NOT NULL DEFAULT 0,
  forwarded INTEGER NOT NULL DEFAULT 0,
  device TEXT,
  PRIMARY KEY (session_id, pv)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pages_path ON pages(path, ts);
CREATE INDEX IF NOT EXISTS pages_ts ON pages(ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  pv INTEGER,
  kind TEXT NOT NULL,
  path TEXT,
  selector TEXT,
  label TEXT,
  label_masked INTEGER NOT NULL DEFAULT 0,
  tag TEXT,
  interactive INTEGER NOT NULL DEFAULT 0,
  x INTEGER,
  y INTEGER,
  doc_w INTEGER,
  doc_h INTEGER,
  top_pct INTEGER,
  href TEXT,
  detail TEXT,
  message TEXT,
  fingerprint TEXT,
  rage INTEGER NOT NULL DEFAULT 0,
  rage_start INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0,
  open INTEGER NOT NULL DEFAULT 0,
  error_click INTEGER NOT NULL DEFAULT 0,
  forwarded INTEGER NOT NULL DEFAULT 0,
  device TEXT
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS events_fingerprint ON events(fingerprint, ts) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_click_path ON events(path, ts) WHERE kind = 'click';

CREATE TABLE IF NOT EXISTS heat_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  device TEXT NOT NULL,
  selector TEXT NOT NULL,
  label TEXT,
  tag TEXT,
  interactive INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL,
  rage INTEGER NOT NULL,
  dead INTEGER NOT NULL,
  error_clicks INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  top_sum INTEGER NOT NULL,
  top_n INTEGER NOT NULL,
  PRIMARY KEY (day, path, device, selector)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS heat_daily_path ON heat_daily(path, day);

CREATE TABLE IF NOT EXISTS scroll_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  device TEXT NOT NULL,
  pageviews INTEGER NOT NULL,
  reach TEXT NOT NULL,
  fold_sum INTEGER NOT NULL,
  fold_n INTEGER NOT NULL,
  PRIMARY KEY (day, path, device)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS drops (
  day TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  sample TEXT,
  PRIMARY KEY (day, reason)
) WITHOUT ROWID;
`;

export function migrate(db: Db): void {
  for (const stmt of SCHEMA.split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    db.run(stmt);
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
}

// ---------------------------------------------------------------------------------- ingest

export interface SessionMeta {
  device: string | null;
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  ua_hash: string | null;
  user_id: string | null;
  analytics_visitor_id: string | null;
  forced: boolean;
}

export interface IngestLimits {
  session_bytes: number;
  max_session_ms: number;
  /** null = no daily cap */
  daily_sessions: number | null;
}

export interface IngestRequest {
  now: number;
  session_id: string;
  seq: number;
  /** stored (compressed) size of the chunk */
  bytes: number;
  /** derived from the client's clock (not shifted yet) */
  chunk: DerivedChunk;
  /**
   * Client clock correction measured on this chunk (server time - client send time, rounded; 0
   * when under a minute). The session keeps the one measured on its first chunk, so every chunk
   * of a session shifts by the same amount and their order is preserved.
   */
  skew_ms: number;
  meta: SessionMeta;
  end: boolean;
  limits: IngestLimits;
  /** collect settled signals not forwarded yet (the site is linked to analytics) */
  forward: boolean;
}

export interface ForwardItem {
  name: "rage_click" | "dead_click" | "error_click" | "js_error" | "quick_back" | "excessive_scroll";
  ts: number;
  path: string | null;
  props: Record<string, string | number | boolean | null>;
}

export type IngestResult =
  | { status: "accepted"; new_session: boolean; forward: ForwardItem[] }
  | { status: "duplicate" }
  | { status: "rejected"; reason: string; stop: boolean };

const SESSION_GRACE_MS = 120_000;

export function recordDrop(db: Db, reason: string, sample: string | null, now: number): void {
  db.run(
    `INSERT INTO drops (day, reason, count, last_at, sample) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(day, reason) DO UPDATE SET count = count + 1, last_at = excluded.last_at, sample = COALESCE(excluded.sample, sample)`,
    [utcDay(now), reason.slice(0, 60), now, sample ? sample.slice(0, 200) : null],
  );
}

function getSession(db: Db, id: string): SessionRow | null {
  return (db.all("SELECT * FROM sessions WHERE id = ?", [id])[0] as unknown as SessionRow | undefined) ?? null;
}

export function ingestChunk(db: Db, req: IngestRequest): IngestResult {
  return db.transaction(() => ingestTx(db, req));
}

function ingestTx(db: Db, req: IngestRequest): IngestResult {
  const { now, session_id: sid, seq, meta } = req;
  if (db.all("SELECT 1 FROM meta WHERE key = 'deleted'").length) return { status: "rejected", reason: "unknown_site", stop: true };
  if (db.all("SELECT 1 FROM chunks WHERE session_id = ? AND seq = ?", [sid, seq]).length) return { status: "duplicate" };
  const existing = getSession(db, sid);
  const skew = existing ? existing.skew_ms : req.skew_ms;
  const c = shiftChunk(req.chunk, skew);
  const reject = (reason: string, stop = true): IngestResult => {
    recordDrop(db, reason, sid, now);
    if (existing && stop) db.run("UPDATE sessions SET limited = COALESCE(limited, ?) WHERE id = ?", [reason, sid]);
    return { status: "rejected", reason, stop };
  };
  const firstTs = c.rr_events ? c.first_ts : now;
  const lastTs = c.rr_events ? c.last_ts : now;
  if (!existing) {
    if (req.limits.daily_sessions !== null) {
      const n = num(db.all("SELECT COUNT(*) AS n FROM sessions WHERE day = ?", [utcDay(now)])[0]?.n);
      if (n >= req.limits.daily_sessions) return reject("daily_session_limit");
    }
  } else {
    if (existing.ua_hash && meta.ua_hash && existing.ua_hash !== meta.ua_hash) return reject("session_mismatch");
    if (existing.bytes + req.bytes > req.limits.session_bytes) return reject("session_bytes_limit");
    if (existing.chunks >= LIMITS.CHUNKS_PER_SESSION) return reject("session_chunk_limit");
    if (lastTs - existing.started_at > req.limits.max_session_ms + SESSION_GRACE_MS) return reject("max_duration");
  }
  if (!existing && req.bytes > req.limits.session_bytes) return reject("session_bytes_limit");

  if (!existing) {
    db.run(
      `INSERT INTO sessions (id, started_at, last_at, received_at, day, device, browser, browser_version, os, country, region, city,
         viewport_w, viewport_h, user_id, analytics_visitor_id, ua_hash, forced, skew_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sid,
        firstTs,
        lastTs,
        now,
        utcDay(now),
        meta.device,
        meta.browser,
        meta.browser_version,
        meta.os,
        meta.country,
        meta.region,
        meta.city,
        c.viewport?.w ?? null,
        c.viewport?.h ?? null,
        meta.user_id,
        meta.analytics_visitor_id,
        meta.ua_hash,
        meta.forced ? 1 : 0,
        skew,
      ],
    );
  }
  db.run(
    `UPDATE sessions SET started_at = MIN(started_at, ?), last_at = MAX(last_at, ?), received_at = ?,
       chunks = chunks + 1, bytes = bytes + ?, rr_events = rr_events + ?, ended = MAX(ended, ?),
       user_id = COALESCE(?, user_id), analytics_visitor_id = COALESCE(?, analytics_visitor_id),
       viewport_w = COALESCE(viewport_w, ?), viewport_h = COALESCE(viewport_h, ?),
       device = COALESCE(device, ?), browser = COALESCE(browser, ?), os = COALESCE(os, ?), country = COALESCE(country, ?)
     WHERE id = ?`,
    [
      firstTs,
      lastTs,
      now,
      req.bytes,
      c.rr_events,
      req.end ? 1 : 0,
      meta.user_id,
      meta.analytics_visitor_id,
      c.viewport?.w ?? null,
      c.viewport?.h ?? null,
      meta.device,
      meta.browser,
      meta.os,
      meta.country,
      sid,
    ],
  );
  db.run(
    "INSERT INTO chunks (session_id, seq, first_ts, last_ts, cover_end, received_at, bytes, rr_events, effect_head) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      sid,
      seq,
      firstTs,
      lastTs,
      Math.max(c.cover_end, lastTs),
      now,
      req.bytes,
      c.rr_events,
      c.effect_head.length ? JSON.stringify(c.effect_head) : null,
    ],
  );

  const session = getSession(db, sid)!;
  const device = session.device;

  // Pages (upsert: a scroll segment can create a placeholder row before its page event arrives).
  const pageCount = num(db.all("SELECT COUNT(*) AS n FROM pages WHERE session_id = ?", [sid])[0]?.n);
  let pagesLeft = LIMITS.PAGES_PER_SESSION - pageCount;
  for (const p of c.pages) {
    const known = db.all("SELECT path FROM pages WHERE session_id = ? AND pv = ?", [sid, p.pv])[0];
    if (!known && pagesLeft <= 0) continue;
    if (!known) pagesLeft--;
    db.run(
      `INSERT INTO pages (session_id, pv, ts, path, host, title, referrer, nav, doc_h, view_h, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, pv) DO UPDATE SET ts = excluded.ts, path = excluded.path, host = excluded.host, title = excluded.title,
         referrer = excluded.referrer, nav = excluded.nav, doc_h = MAX(COALESCE(doc_h, 0), excluded.doc_h), view_h = COALESCE(excluded.view_h, view_h)`,
      [sid, p.pv, p.ts, p.path, p.host || null, p.title, p.referrer, p.nav, p.dh || null, p.vh || null, device],
    );
    // Events that arrived before their page learn its path.
    db.run("UPDATE events SET path = ? WHERE session_id = ? AND pv = ? AND path IS NULL", [p.path, sid, p.pv]);
  }

  // Scroll: merge each pageview's segment into its page row; first-time milestones become events.
  const milestoneRows: { ts: number; pv: number; pct: number }[] = [];
  for (const s of c.scrolls) {
    let row = db.all("SELECT * FROM pages WHERE session_id = ? AND pv = ?", [sid, s.pv])[0] as unknown as PageRow | undefined;
    if (!row) {
      if (pagesLeft <= 0) continue;
      pagesLeft--;
      db.run("INSERT INTO pages (session_id, pv, ts, device) VALUES (?, ?, ?, ?)", [sid, s.pv, s.first_ts, device]);
      row = db.all("SELECT * FROM pages WHERE session_id = ? AND pv = ?", [sid, s.pv])[0] as unknown as PageRow;
    }
    const boundary = row.last_y === null ? 0 : Math.abs(s.first_y - row.last_y);
    const flip = row.last_dir !== 0 && s.first_dir !== 0 && row.last_dir !== s.first_dir ? 1 : 0;
    const dist = row.scroll_dist + boundary + s.dist;
    const reversals = row.reversals + flip + s.reversals;
    const doc_h = Math.max(row.doc_h ?? 0, s.dh) || null;
    const view_h = s.vh || row.view_h;
    for (const m of s.milestones) if (m.pct > row.max_scroll) milestoneRows.push({ ts: m.ts, pv: s.pv, pct: m.pct });
    db.run(
      `UPDATE pages SET max_scroll = MAX(max_scroll, ?), scroll_dist = ?, reversals = ?, last_y = ?, last_dir = ?, doc_h = ?, view_h = ?, excessive_scroll = ?
       WHERE session_id = ? AND pv = ?`,
      [
        s.max_reach,
        dist,
        reversals,
        s.last_y,
        s.last_dir || row.last_dir,
        doc_h,
        view_h,
        excessiveScroll({ dist, reversals, doc_h, view_h }) ? 1 : 0,
        sid,
        s.pv,
      ],
    );
  }

  // Derived events, capped per session.
  const pathOf = new Map<number, string | null>();
  const pvs = [
    ...new Set([...c.clicks, ...c.inputs, ...c.errors, ...c.customs, ...c.marks].map((e) => e.pv).concat(milestoneRows.map((m) => m.pv))),
  ];
  if (pvs.length)
    for (const r of db.all(`SELECT pv, path FROM pages WHERE session_id = ? AND pv IN ${IN_JSON}`, [sid, JSON.stringify(pvs)]))
      pathOf.set(num(r.pv), strOrNull(r.path));
  let room = LIMITS.DERIVED_PER_SESSION - session.derived;
  let errorRoom = LIMITS.ERRORS_PER_SESSION - session.errors;
  let added = 0;
  let capped = false;
  const insert = (cols: Record<string, SqlValue>) => {
    if (room <= 0) {
      capped = true;
      return;
    }
    room--;
    added++;
    const keys = Object.keys(cols);
    db.run(`INSERT INTO events (session_id, seq, device, ${keys.join(", ")}) VALUES (?, ?, ?, ${marks(keys.length)})`, [
      sid,
      seq,
      device,
      ...Object.values(cols),
    ]);
  };
  for (const k of c.clicks)
    insert({
      ts: k.ts,
      pv: k.pv,
      kind: "click",
      path: pathOf.get(k.pv) ?? null,
      selector: k.selector,
      label: k.label || null,
      label_masked: k.label_masked ? 1 : 0,
      tag: k.tag || null,
      interactive: k.interactive ? 1 : 0,
      x: k.x,
      y: k.y,
      doc_w: k.doc_w,
      doc_h: k.doc_h,
      top_pct: k.top_pct,
      href: k.href,
      detail: k.blocked ? '{"blocked":1}' : null,
      dead: k.dead ? 1 : 0,
      open: k.open ? 1 : 0,
    });
  for (const i of c.inputs)
    insert({
      ts: i.ts,
      pv: i.pv,
      kind: "input",
      path: pathOf.get(i.pv) ?? null,
      selector: i.selector,
      label: i.label,
      tag: i.tag,
      interactive: 1,
      detail: JSON.stringify({ name: i.name, masked: i.masked }),
    });
  for (const e of c.errors) {
    if (errorRoom <= 0) {
      capped = true;
      continue;
    }
    errorRoom--;
    insert({
      ts: e.ts,
      pv: e.pv,
      kind: "error",
      path: pathOf.get(e.pv) ?? null,
      message: e.message,
      fingerprint: e.fingerprint,
      detail: JSON.stringify({ kind: e.kind, source: e.source, line: e.line, col: e.col, stack: e.stack }),
    });
  }
  for (const e of c.customs)
    insert({
      ts: e.ts,
      pv: e.pv,
      kind: "event",
      path: pathOf.get(e.pv) ?? null,
      label: e.name,
      detail: e.props ? JSON.stringify({ props: e.props }) : null,
    });
  for (const m of c.marks)
    insert({ ts: m.ts, pv: m.pv, kind: m.kind, path: pathOf.get(m.pv) ?? null, detail: JSON.stringify({ k: m.detail }) });
  for (const m of milestoneRows)
    insert({ ts: m.ts, pv: m.pv, kind: "scroll", path: pathOf.get(m.pv) ?? null, detail: JSON.stringify({ pct: m.pct }) });
  if (added) db.run("UPDATE sessions SET derived = derived + ? WHERE id = ?", [added, sid]);
  if (capped || c.truncated) db.run("UPDATE sessions SET limited = COALESCE(limited, 'events') WHERE id = ?", [sid]);

  if (c.rr_events) {
    resolveDeadClicks(db, sid, seq, firstTs, lastTs, c);
    resolveWindowSignals(db, sid, firstTs, lastTs);
  }
  resolvePages(db, sid);
  refreshSession(db, sid);
  const forward = req.forward ? takeForwardable(db, sid, Math.max(c.cover_end, lastTs) - 1500, req.end) : [];
  return { status: "accepted", new_session: !existing, forward };
}

const hasNavIn = (db: Db, sid: string, from: number, to: number) =>
  db.all("SELECT 1 FROM pages WHERE session_id = ? AND ts > ? AND ts <= ? LIMIT 1", [sid, from, to]).length > 0 ||
  db.all("SELECT 1 FROM events WHERE session_id = ? AND kind = 'hide' AND ts > ? AND ts <= ? LIMIT 1", [sid, from, to]).length > 0;

/**
 * Dead clicks across chunk boundaries. A click whose 1 s window ran past its chunk is `open`: this
 * chunk's first second (effect_head) or a navigation can still prove it had an effect. And a click
 * in this chunk that is open may already be answered by a later chunk that arrived first.
 */
function resolveDeadClicks(db: Db, sid: string, seq: number, firstTs: number, lastTs: number, c: DerivedChunk) {
  const head = c.effect_head;
  // Open clicks this chunk can answer: those whose window reaches into it, and every open click of
  // the chunk right before it (contiguous: nothing happened in between, so they are settled).
  for (const r of db.all(
    "SELECT id, ts, seq FROM events WHERE session_id = ? AND kind = 'click' AND open = 1 AND seq != ? AND ((ts >= ? AND ts <= ?) OR seq = ?)",
    [sid, seq, firstTs - DEAD_MS, lastTs, seq - 1],
  )) {
    const ts = num(r.ts);
    const effect = anyIn(head, ts - 50, ts + DEAD_MS) || hasNavIn(db, sid, ts, ts + DEAD_MS);
    if (effect) db.run("UPDATE events SET dead = 0, open = 0 WHERE id = ?", [num(r.id)]);
    else if (num(r.seq) + 1 === seq) db.run("UPDATE events SET open = 0 WHERE id = ?", [num(r.id)]);
  }
  const open = db.all("SELECT id, ts FROM events WHERE session_id = ? AND kind = 'click' AND open = 1 AND seq = ?", [sid, seq]);
  if (!open.length) return;
  const later = db.all("SELECT seq, first_ts, effect_head FROM chunks WHERE session_id = ? AND seq > ? AND first_ts <= ?", [
    sid,
    seq,
    lastTs + DEAD_MS,
  ]);
  for (const r of open) {
    const ts = num(r.ts);
    let effect = hasNavIn(db, sid, ts, ts + DEAD_MS);
    let contiguous = false;
    for (const l of later) {
      if (num(l.seq) === seq + 1) contiguous = true;
      const h = l.effect_head ? (JSON.parse(String(l.effect_head)) as number[]) : [];
      if (anyIn(h, ts - 50, ts + DEAD_MS)) effect = true;
    }
    if (effect) db.run("UPDATE events SET dead = 0, open = 0 WHERE id = ?", [num(r.id)]);
    else if (contiguous) db.run("UPDATE events SET open = 0 WHERE id = ?", [num(r.id)]);
  }
}

const WINDOW_LOAD_MS = 3000;
const WINDOW_UPDATE_MS = 1500;

/** Rage clicks and error clicks, re-evaluated in a window around the new chunk (exact for the updated range). */
function resolveWindowSignals(db: Db, sid: string, firstTs: number, lastTs: number) {
  const from = firstTs - WINDOW_LOAD_MS;
  const to = lastTs + WINDOW_LOAD_MS;
  const clicks = db.all(
    "SELECT id, ts, pv, selector, x, y, rage, rage_start, error_click, label FROM events WHERE session_id = ? AND kind = 'click' AND ts >= ? AND ts <= ? ORDER BY ts, id",
    [sid, from, to],
  );
  const errors = db.all(
    "SELECT id, ts, error_click, selector FROM events WHERE session_id = ? AND kind = 'error' AND ts >= ? AND ts <= ? ORDER BY ts, id",
    [sid, from, to],
  );
  const inRange = (ts: number) => ts >= firstTs - WINDOW_UPDATE_MS && ts <= lastTs + WINDOW_UPDATE_MS;
  const points = clicks.map((r) => ({ ts: num(r.ts), pv: num(r.pv), selector: String(r.selector ?? ""), x: num(r.x), y: num(r.y) }));
  const { rage, start } = detectRage(points);
  const { clickHit, errorClick } = errorClicks(
    points,
    errors.map((r) => ({ ts: num(r.ts) })),
  );
  clicks.forEach((r, i) => {
    if (!inRange(num(r.ts))) return;
    const nr = rage[i] ? 1 : 0;
    const ns = start[i] ? 1 : 0;
    const ne = clickHit[i] ? 1 : 0;
    if (nr !== num(r.rage) || ns !== num(r.rage_start) || ne !== num(r.error_click))
      db.run("UPDATE events SET rage = ?, rage_start = ?, error_click = ? WHERE id = ?", [nr, ns, ne, num(r.id)]);
  });
  errors.forEach((r, i) => {
    if (!inRange(num(r.ts))) return;
    const k = errorClick[i]!;
    const click = k >= 0 ? clicks[k]! : null;
    const ne = click ? 1 : 0;
    if (ne !== num(r.error_click) || (click && click.selector !== r.selector))
      db.run("UPDATE events SET error_click = ?, selector = ?, label = ? WHERE id = ?", [
        ne,
        click ? strOrNull(click.selector) : null,
        click ? strOrNull(click.label) : null,
        num(r.id),
      ]);
  });
}

/** Quick backs and dwell time over the session's pageviews (a few hundred at most). */
function resolvePages(db: Db, sid: string) {
  const pages = db.all("SELECT pv, ts, path, left_at, quick_back FROM pages WHERE session_id = ? AND path IS NOT NULL ORDER BY pv", [sid]);
  const last = num(db.all("SELECT last_at FROM sessions WHERE id = ?", [sid])[0]?.last_at);
  const qb = quickBacks(pages.map((p) => ({ pv: num(p.pv), ts: num(p.ts), path: String(p.path) })));
  pages.forEach((p, i) => {
    const next = pages[i + 1];
    const left = next ? num(next.ts) : Math.max(last, num(p.ts));
    const q = qb[i] ? 1 : 0;
    if (left !== num(p.left_at) || q !== num(p.quick_back))
      db.run("UPDATE pages SET left_at = ?, quick_back = ? WHERE session_id = ? AND pv = ?", [left, q, sid, num(p.pv)]);
  });
}

/** Recompute the session's counters and frustration score from its rows. */
export function refreshSession(db: Db, sid: string) {
  const e = db.all(
    `SELECT COALESCE(SUM(kind = 'click'), 0) AS clicks, COALESCE(SUM(kind = 'input'), 0) AS inputs, COALESCE(SUM(kind = 'error'), 0) AS errors,
       COALESCE(SUM(kind = 'click' AND rage_start = 1), 0) AS rage, COALESCE(SUM(kind = 'click' AND dead = 1), 0) AS dead,
       COALESCE(SUM(kind = 'click' AND dead = 1 AND interactive = 1), 0) AS dead_i, COALESCE(SUM(kind = 'click' AND error_click = 1), 0) AS error_clicks
     FROM events WHERE session_id = ?`,
    [sid],
  )[0]!;
  const p = db.all(
    "SELECT COUNT(*) AS n, COALESCE(SUM(quick_back), 0) AS qb, COALESCE(SUM(excessive_scroll), 0) AS ex FROM pages WHERE session_id = ? AND path IS NOT NULL",
    [sid],
  )[0]!;
  const entry = db.all("SELECT path FROM pages WHERE session_id = ? AND path IS NOT NULL ORDER BY pv LIMIT 1", [sid])[0];
  const exit = db.all("SELECT path FROM pages WHERE session_id = ? AND path IS NOT NULL ORDER BY pv DESC LIMIT 1", [sid])[0];
  const counts = {
    rage_clicks: num(e.rage),
    dead_clicks: num(e.dead),
    dead_interactive: num(e.dead_i),
    error_clicks: num(e.error_clicks),
    errors: num(e.errors),
    quick_backs: num(p.qb),
    excessive_scrolls: num(p.ex),
  };
  db.run(
    `UPDATE sessions SET duration_ms = MAX(0, last_at - started_at), clicks = ?, inputs = ?, errors = ?, rage_clicks = ?, dead_clicks = ?, dead_interactive = ?,
       error_clicks = ?, quick_backs = ?, excessive_scrolls = ?, pageviews = ?, entry_path = ?, exit_path = ?, frustration = ? WHERE id = ?`,
    [
      num(e.clicks),
      num(e.inputs),
      counts.errors,
      counts.rage_clicks,
      counts.dead_clicks,
      counts.dead_interactive,
      counts.error_clicks,
      counts.quick_backs,
      counts.excessive_scrolls,
      num(p.n),
      strOrNull(entry?.path),
      strOrNull(exit?.path),
      frustrationScore(counts),
      sid,
    ],
  );
}

/**
 * Signals that can no longer change (their window is behind `settledBefore`) and haven't been sent
 * to analytics yet, marked as sent. Rage bursts once, dead clicks on interactive elements outside
 * rage bursts, each error fingerprint once per session.
 */
function takeForwardable(db: Db, sid: string, settledBefore: number, end: boolean): ForwardItem[] {
  const out: ForwardItem[] = [];
  // The page ended: nothing can change any more. Otherwise only what lies well inside known coverage.
  const limit = end ? Number.MAX_SAFE_INTEGER : settledBefore;
  const clicks = db.all(
    `SELECT id, ts, path, selector, label, interactive, rage, rage_start, dead, error_click FROM events
     WHERE session_id = ? AND kind = 'click' AND forwarded = 0 AND ts <= ? AND (open = 0 OR ? = 1)
       AND (rage_start = 1 OR (dead = 1 AND interactive = 1 AND rage = 0) OR error_click = 1)
     ORDER BY ts LIMIT 100`,
    [sid, limit, end ? 1 : 0],
  );
  for (const r of clicks) {
    const base = { replay_session_id: sid, selector: strOrNull(r.selector), label: strOrNull(r.label) };
    if (num(r.rage_start)) out.push({ name: "rage_click", ts: num(r.ts), path: strOrNull(r.path), props: base });
    // A rage burst is one rage_click; its clicks are not also sent as dead clicks.
    if (num(r.dead) && num(r.interactive) && !num(r.rage))
      out.push({ name: "dead_click", ts: num(r.ts), path: strOrNull(r.path), props: base });
    if (num(r.error_click)) out.push({ name: "error_click", ts: num(r.ts), path: strOrNull(r.path), props: base });
    db.run("UPDATE events SET forwarded = 1 WHERE id = ?", [num(r.id)]);
  }
  const errors = db.all(
    `SELECT id, ts, path, message, fingerprint FROM events e WHERE session_id = ? AND kind = 'error' AND forwarded = 0 AND ts <= ?
     ORDER BY ts LIMIT 50`,
    [sid, limit],
  );
  const sent = new Set(
    db
      .all("SELECT DISTINCT fingerprint FROM events WHERE session_id = ? AND kind = 'error' AND forwarded = 1", [sid])
      .map((r) => String(r.fingerprint)),
  );
  for (const r of errors) {
    const fp = String(r.fingerprint);
    if (!sent.has(fp)) {
      sent.add(fp);
      out.push({
        name: "js_error",
        ts: num(r.ts),
        path: strOrNull(r.path),
        props: { replay_session_id: sid, fingerprint: fp, message: String(r.message ?? "").slice(0, 200) },
      });
    }
    db.run("UPDATE events SET forwarded = 1 WHERE id = ?", [num(r.id)]);
  }
  const pages = db.all(
    `SELECT pv, ts, path, quick_back, excessive_scroll, forwarded FROM pages WHERE session_id = ? AND path IS NOT NULL
     AND ((quick_back = 1 AND (forwarded & 1) = 0) OR (excessive_scroll = 1 AND (forwarded & 2) = 0)) AND COALESCE(left_at, ts) <= ?`,
    [sid, limit],
  );
  for (const r of pages) {
    let f = num(r.forwarded);
    const props = { replay_session_id: sid };
    if (num(r.quick_back) && !(f & 1)) {
      out.push({ name: "quick_back", ts: num(r.ts), path: strOrNull(r.path), props });
      f |= 1;
    }
    if (num(r.excessive_scroll) && !(f & 2)) {
      out.push({ name: "excessive_scroll", ts: num(r.ts), path: strOrNull(r.path), props });
      f |= 2;
    }
    db.run("UPDATE pages SET forwarded = ? WHERE session_id = ? AND pv = ?", [f, sid, num(r.pv)]);
  }
  return out;
}

// ---------------------------------------------------------------------------------- deletion and retention

export interface DeletedSessions {
  deleted: string[];
  /** R2 keys below the site prefix: "<session_id>/<seq 6 digits>" */
  keys: string[];
}

export const chunkKey = (sid: string, seq: number) => `${sid}/${String(seq).padStart(6, "0")}`;

export function deleteSessions(db: Db, ids: string[]): DeletedSessions {
  if (!ids.length) return { deleted: [], keys: [] };
  return db.transaction(() => {
    const list = JSON.stringify(ids);
    const found = db.all(`SELECT id FROM sessions WHERE id IN ${IN_JSON}`, [list]).map((r) => String(r.id));
    const keys = db
      .all(`SELECT session_id, seq FROM chunks WHERE session_id IN ${IN_JSON}`, [list])
      .map((r) => chunkKey(String(r.session_id), num(r.seq)));
    for (const t of ["events", "pages", "chunks"]) db.run(`DELETE FROM ${t} WHERE session_id IN ${IN_JSON}`, [list]);
    db.run(`DELETE FROM sessions WHERE id IN ${IN_JSON}`, [list]);
    return { deleted: found, keys };
  });
}

/**
 * Roll settled days (up to two days ago) up into heatmap aggregates, before retention deletes the
 * rows they come from. Idempotent: meta.rolled_through remembers the last day done.
 */
export function rollup(db: Db, now: number, maxDays = 31): { rolled: string[] } {
  const lastSettled = utcDay(now - 2 * DAY);
  const through = strOrNull(db.all("SELECT value FROM meta WHERE key = 'rolled_through'")[0]?.value);
  let day: string;
  if (through) day = utcDay(Date.parse(`${through}T00:00:00Z`) + DAY);
  else {
    const first = db.all("SELECT MIN(ts) AS t FROM pages")[0]?.t;
    const firstClick = db.all("SELECT MIN(ts) AS t FROM events WHERE kind = 'click'")[0]?.t;
    const t = Math.min(
      first == null ? Number.POSITIVE_INFINITY : num(first),
      firstClick == null ? Number.POSITIVE_INFINITY : num(firstClick),
    );
    if (!Number.isFinite(t)) {
      db.run("INSERT INTO meta (key, value) VALUES ('rolled_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
        lastSettled,
      ]);
      return { rolled: [] };
    }
    day = utcDay(t);
  }
  const rolled: string[] = [];
  while (day <= lastSettled && rolled.length < maxDays) {
    const start = Date.parse(`${day}T00:00:00Z`);
    const end = start + DAY;
    db.transaction(() => {
      db.run(
        `INSERT OR REPLACE INTO heat_daily (day, path, device, selector, label, tag, interactive, clicks, rage, dead, error_clicks, sessions, top_sum, top_n)
         SELECT ?, path, COALESCE(device, ''), selector, MAX(label), MAX(tag), MAX(interactive), COUNT(*), SUM(rage), SUM(dead), SUM(error_click),
           COUNT(DISTINCT session_id), COALESCE(SUM(top_pct), 0), COUNT(top_pct)
         FROM events WHERE kind = 'click' AND ts >= ? AND ts < ? AND path IS NOT NULL AND selector IS NOT NULL
         GROUP BY path, COALESCE(device, ''), selector`,
        [day, start, end],
      );
      const rows = db.all(
        `SELECT path, COALESCE(device, '') AS device, COUNT(*) AS n, ${REACH_BUCKETS.map((b) => `SUM(max_scroll >= ${b}) AS r${b}`).join(", ")},
           COALESCE(SUM(CASE WHEN doc_h > 0 AND view_h > 0 THEN MIN(100, view_h * 100 / doc_h) END), 0) AS fold_sum,
           SUM(CASE WHEN doc_h > 0 AND view_h > 0 THEN 1 ELSE 0 END) AS fold_n
         FROM pages WHERE ts >= ? AND ts < ? AND path IS NOT NULL GROUP BY path, COALESCE(device, '')`,
        [start, end],
      );
      for (const r of rows)
        db.run("INSERT OR REPLACE INTO scroll_daily (day, path, device, pageviews, reach, fold_sum, fold_n) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          day,
          String(r.path),
          String(r.device),
          num(r.n),
          JSON.stringify(REACH_BUCKETS.map((b) => num(r[`r${b}`]))),
          num(r.fold_sum),
          num(r.fold_n),
        ]);
      db.run("INSERT INTO meta (key, value) VALUES ('rolled_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [day]);
    });
    rolled.push(day);
    day = utcDay(start + DAY);
  }
  return { rolled };
}

export const REACH_BUCKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export interface PurgeRequest {
  now: number;
  /** sessions started before this are deleted */
  cutoff: number;
  /** heatmap aggregates of days before this are deleted */
  heat_cutoff: number;
  limit?: number;
}

export function purge(db: Db, req: PurgeRequest): DeletedSessions & { more: boolean; rolled: string[] } {
  const { rolled } = rollup(db, req.now);
  const limit = req.limit ?? 300;
  const ids = db
    .all("SELECT id FROM sessions WHERE started_at < ? ORDER BY started_at LIMIT ?", [req.cutoff, limit])
    .map((r) => String(r.id));
  const del = deleteSessions(db, ids);
  const heatDay = utcDay(req.heat_cutoff);
  db.run("DELETE FROM heat_daily WHERE day < ?", [heatDay]);
  db.run("DELETE FROM scroll_daily WHERE day < ?", [heatDay]);
  db.run("DELETE FROM drops WHERE day < ?", [utcDay(req.now - 31 * DAY)]);
  return { ...del, more: ids.length === limit, rolled };
}

// ---------------------------------------------------------------------------------- summary (verify, get_site)

export function summary(db: Db, now: number) {
  const s = db.all(
    `SELECT COUNT(*) AS n, COALESCE(SUM(started_at > ?), 0) AS last24, MAX(received_at) AS last_received, MAX(started_at) AS last_started,
       COALESCE(SUM(chunks), 0) AS chunks, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(day = ?), 0) AS today, COALESCE(SUM(forced), 0) AS forced
     FROM sessions`,
    [now - DAY, utcDay(now)],
  )[0]!;
  const drops: Record<string, { count: number; last_at: number; sample: string | null }> = {};
  for (const r of db.all(
    "SELECT reason, SUM(count) AS n, MAX(last_at) AS last_at, MAX(sample) AS sample FROM drops WHERE day >= ? GROUP BY reason",
    [utcDay(now - 7 * DAY)],
  ))
    drops[String(r.reason)] = { count: num(r.n), last_at: num(r.last_at), sample: strOrNull(r.sample) };
  const hosts = db
    .all("SELECT host, COUNT(*) AS n FROM pages WHERE ts > ? AND host IS NOT NULL GROUP BY host ORDER BY n DESC LIMIT 10", [now - 7 * DAY])
    .map((r) => ({ hostname: String(r.host), pageviews: num(r.n) }));
  return {
    sessions_total: num(s.n),
    sessions_last_24h: num(s.last24),
    sessions_today: num(s.today),
    forced_sessions: num(s.forced),
    last_chunk_at: s.last_received == null ? null : num(s.last_received),
    last_session_started_at: s.last_started == null ? null : num(s.last_started),
    chunks_total: num(s.chunks),
    bytes_total: num(s.bytes),
    hostnames_last_7d: hosts,
    dropped_last_7d: drops,
  };
}

export type Summary = ReturnType<typeof summary>;

export function chunkSeqs(db: Db, sid: string): number[] {
  return db.all("SELECT seq FROM chunks WHERE session_id = ? ORDER BY seq", [sid]).map((r) => num(r.seq));
}

export type { Row };
