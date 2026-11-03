/**
 * The per-site engine: schema, ingest of derived chunks, signal resolution across chunks, daily
 * counters and budgets, deletion and retention. Runs inside ReplaySiteDO (one SQLite database per
 * replay site) and, in unit tests, on node:sqlite.
 *
 * Ingest work here is small and bounded on purpose: the Worker already decompressed and derived
 * the chunk (lib/derive.ts); the DO inserts a few dozen rows, re-evaluates signals in a window of
 * a few seconds around the chunk, and recomputes the session's counters. Every query that could
 * grow with stored data has a LIMIT or works on one session.
 */

import type { DerivedChunk } from "../lib/derive";
import { anyIn, DEAD_MS, shiftChunk } from "../lib/derive";
import { type Budget, COUNTERS, type Counter, DEFAULTS, LIMITS, type Totals } from "../lib/limits";
import type { PageRow, SessionRow } from "../lib/rows";
import { detectRage, errorClicks, excessiveScroll, frustrationScore, quickBacks } from "../lib/signals";
import { type Db, DAY, IN_JSON, marks, num, type Row, type SqlValue, strOrNull, utcDay } from "./db";

/**
 * Schema version 1 (the first release) is SCHEMA_V1 and is never edited; later versions are
 * MIGRATIONS, run in order, each in a transaction that also bumps meta.schema_version, so a DO
 * created by any earlier release catches up the first time it is instantiated (like analytics'
 * engine). SCHEMA_V1 only runs for a brand-new database: running it again would recreate indexes a
 * migration dropped.
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_V1 = `
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

/**
 * The partial index events_ce covers clicks and errors only (other kinds never need a time-range
 * scan). SQLite uses a partial index only when the query repeats its WHERE term, so every
 * time-range query over clicks or errors includes CE.
 */
export const CE = "kind IN ('click', 'error')";

const SCHEMA_V2 = `
DROP INDEX IF EXISTS events_kind_ts;
DROP INDEX IF EXISTS events_click_path;
CREATE INDEX IF NOT EXISTS events_ce ON events(kind, ts) WHERE kind IN ('click', 'error');
CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY,
  sessions INTEGER NOT NULL DEFAULT 0,
  forced INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  derived INTEGER NOT NULL DEFAULT 0,
  forwarded INTEGER NOT NULL DEFAULT 0,
  rep_sessions INTEGER NOT NULL DEFAULT 0,
  rep_chunks INTEGER NOT NULL DEFAULT 0,
  rep_bytes INTEGER NOT NULL DEFAULT 0,
  rep_derived INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS net_daily (
  day TEXT NOT NULL,
  net TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  PRIMARY KEY (day, net)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS deleted_sessions (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS r2_pending (key TEXT PRIMARY KEY, not_before INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS r2_pending_due ON r2_pending(not_before);
CREATE TABLE IF NOT EXISTS link_usage (
  link_id TEXT NOT NULL,
  day TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (link_id, day)
) WITHOUT ROWID
`;

const statements = (sql: string) =>
  sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

const MIGRATIONS: { version: number; up: (db: Db, now: number) => void }[] = [
  {
    // Cost and abuse hardening: one partial index instead of events_kind_ts + events_click_path (a
    // click insert updated three indexes), non-decreasing daily counters (deleting sessions no
    // longer frees quota), per-network session counts, deleted-session tombstones, R2 keys pending
    // deletion (no orphans when a delete fails), and per-link bytes served.
    version: 2,
    up: (db, now) => {
      for (const s of statements(SCHEMA_V2)) db.run(s);
      // Today's counters start where the stored sessions are, so the daily caps carry on.
      db.run(
        `INSERT OR IGNORE INTO daily (day, sessions, forced, chunks, bytes, derived)
         SELECT day, COUNT(*), COALESCE(SUM(forced), 0), COALESCE(SUM(chunks), 0), COALESCE(SUM(bytes), 0), COALESCE(SUM(derived), 0)
         FROM sessions WHERE day = ? GROUP BY day`,
        [utcDay(now)],
      );
    },
  },
];

export function migrate(db: Db, now = Date.now()): void {
  const hasMeta = db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").length > 0;
  let version = hasMeta ? Number(db.all("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value ?? 0) || 0 : 0;
  if (!version) {
    for (const s of statements(SCHEMA_V1)) db.run(s);
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')");
    version = 1;
  }
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.transaction(() => {
      m.up(db, now);
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(m.version)]);
    });
    version = m.version;
  }
}

export function schemaVersion(db: Db): number {
  return Number(db.all("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value ?? 0);
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
  /** default LIMITS.CHUNKS_PER_SESSION */
  chunks_per_session?: number;
  /** default DEFAULTS.DERIVED_PER_SESSION */
  derived_per_session?: number;
  /** new non-forced sessions per UTC day (the trial cap while the domain is unverified); null = no cap */
  daily_sessions: number | null;
  /** new ?afsr=1 sessions per UTC day; null/undefined = no cap */
  forced_daily?: number | null;
  /** new sessions per client network per UTC day */
  net_daily?: number | null;
  /** analytics events forwarded per UTC day */
  forward_daily?: number | null;
  /** the account's and the deployment's daily budgets (null fields = no cap) */
  account?: Budget;
  platform?: Budget;
}

/** The account's and the deployment's totals today as last read from D1 (they include what this site reported). */
export interface UsageSnapshot {
  day: string;
  account: Totals | null;
  platform: Totals | null;
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
  /** collect settled signals not forwarded yet (the site is verified and linked to analytics) */
  forward: boolean;
  /** hashed client network (IPv4 address or IPv6 /48), for net_daily; never the address */
  net?: string | null;
  usage?: UsageSnapshot | null;
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
  | { status: "rejected"; reason: string; stop: boolean; counter?: Counter };

const SESSION_GRACE_MS = 120_000;

/** Add `count` refusals for `reason` today (callers sample: see lib/sampler.ts). */
export function recordDrop(db: Db, reason: string, sample: string | null, now: number, count = 1): void {
  db.run(
    `INSERT INTO drops (day, reason, count, last_at, sample) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, reason) DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at, sample = COALESCE(excluded.sample, sample)`,
    [utcDay(now), reason.slice(0, 60), Math.max(1, Math.floor(count)), now, sample ? sample.slice(0, 200) : null],
  );
}

function getSession(db: Db, id: string): SessionRow | null {
  return (db.all("SELECT * FROM sessions WHERE id = ?", [id])[0] as unknown as SessionRow | undefined) ?? null;
}

export interface DailyRow {
  day: string;
  sessions: number;
  forced: number;
  chunks: number;
  bytes: number;
  derived: number;
  forwarded: number;
  rep_sessions: number;
  rep_chunks: number;
  rep_bytes: number;
  rep_derived: number;
}

export function dailyRow(db: Db, day: string): DailyRow {
  const r = db.all("SELECT * FROM daily WHERE day = ?", [day])[0];
  const n = (k: string) => num(r?.[k]);
  return {
    day,
    sessions: n("sessions"),
    forced: n("forced"),
    chunks: n("chunks"),
    bytes: n("bytes"),
    derived: n("derived"),
    forwarded: n("forwarded"),
    rep_sessions: n("rep_sessions"),
    rep_chunks: n("rep_chunks"),
    rep_bytes: n("rep_bytes"),
    rep_derived: n("rep_derived"),
  };
}

/** Today's counters this site hasn't reported to the account/deployment totals in D1 yet. */
export const localUnreported = (d: DailyRow): Totals => ({
  sessions: d.sessions - d.rep_sessions,
  chunks: d.chunks - d.rep_chunks,
  bytes: d.bytes - d.rep_bytes,
  derived: d.derived - d.rep_derived,
});

/** Upper bound of the derived rows a chunk can add (scroll milestones included). */
const factCount = (c: DerivedChunk) =>
  c.clicks.length +
  c.inputs.length +
  c.errors.length +
  c.customs.length +
  c.marks.length +
  c.scrolls.reduce((n, s) => n + s.milestones.length, 0);

export const isDeleted = (db: Db) => db.all("SELECT 1 FROM meta WHERE key = 'deleted'").length > 0;

export function ingestChunk(db: Db, req: IngestRequest): IngestResult {
  return db.transaction(() => ingestTx(db, req));
}

function ingestTx(db: Db, req: IngestRequest): IngestResult {
  const { now, session_id: sid, seq, meta } = req;
  const L = req.limits;
  if (isDeleted(db)) return { status: "rejected", reason: "unknown_site", stop: true };
  if (db.all("SELECT 1 FROM deleted_sessions WHERE id = ?", [sid]).length)
    return { status: "rejected", reason: "session_deleted", stop: true };
  if (db.all("SELECT 1 FROM chunks WHERE session_id = ? AND seq = ?", [sid, seq]).length) return { status: "duplicate" };
  const existing = getSession(db, sid);
  const skew = existing ? existing.skew_ms : req.skew_ms;
  const c = shiftChunk(req.chunk, skew);
  const reject = (reason: string, stop = true, counter?: Counter): IngestResult => {
    // Only the first refusal of a session writes (a script that keeps sending costs reads only).
    if (existing && stop) db.run("UPDATE sessions SET limited = ? WHERE id = ? AND limited IS NULL", [reason, sid]);
    return { status: "rejected", reason, stop, ...(counter ? { counter } : {}) };
  };
  const firstTs = c.rr_events ? c.first_ts : now;
  const lastTs = c.rr_events ? c.last_ts : now;
  const day = utcDay(now);
  const d = dailyRow(db, day);

  // The account's and the deployment's budgets: the last D1 read plus what this site hasn't reported.
  const add: Totals = { sessions: existing ? 0 : 1, chunks: 1, bytes: req.bytes, derived: factCount(c) };
  const local = localUnreported(d);
  const usage = req.usage && req.usage.day === day ? req.usage : null;
  const scopes = [
    { budget: L.account, totals: usage?.account ?? null, reason: "account_daily_limit" },
    { budget: L.platform, totals: usage?.platform ?? null, reason: "platform_budget" },
  ];
  for (const s of scopes) {
    if (!s.budget) continue;
    for (const k of COUNTERS) {
      const max = s.budget[k];
      if (max === null || max === undefined || !add[k]) continue;
      if ((s.totals?.[k] ?? 0) + local[k] + add[k] > max) return reject(s.reason, true, k);
    }
  }

  if (!existing) {
    // A new session starts with its page: its hostname is what was checked against the site.
    if (!c.hosts.length) return reject("page_host_required", false);
    if (meta.forced) {
      if (L.forced_daily !== null && L.forced_daily !== undefined && d.forced >= L.forced_daily) return reject("forced_daily_limit");
    } else if (L.daily_sessions !== null && d.sessions - d.forced >= L.daily_sessions) return reject("daily_session_limit");
    if (req.net && L.net_daily !== null && L.net_daily !== undefined) {
      const n = num(db.all("SELECT sessions FROM net_daily WHERE day = ? AND net = ?", [day, req.net])[0]?.sessions);
      if (n >= L.net_daily) return reject("ip_daily_limit");
    }
    if (req.bytes > L.session_bytes) return reject("session_bytes_limit");
  } else {
    if (existing.ua_hash && meta.ua_hash && existing.ua_hash !== meta.ua_hash) return reject("session_mismatch");
    if (existing.bytes + req.bytes > L.session_bytes) return reject("session_bytes_limit");
    if (existing.chunks >= (L.chunks_per_session ?? LIMITS.CHUNKS_PER_SESSION)) return reject("session_chunk_limit");
    if (lastTs - existing.started_at > L.max_session_ms + SESSION_GRACE_MS) return reject("max_duration");
  }
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
  let room = (L.derived_per_session ?? DEFAULTS.DERIVED_PER_SESSION) - session.derived;
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
  if (capped || c.truncated) db.run("UPDATE sessions SET limited = 'events' WHERE id = ? AND limited IS NULL", [sid]);

  if (c.rr_events) {
    resolveDeadClicks(db, sid, seq, firstTs, lastTs, c);
    resolveWindowSignals(db, sid, firstTs, lastTs);
  }
  resolvePages(db, sid);
  refreshSession(db, sid);
  const room2 = L.forward_daily === null || L.forward_daily === undefined ? Number.POSITIVE_INFINITY : L.forward_daily - d.forwarded;
  const forward = req.forward && room2 > 0 ? takeForwardable(db, sid, Math.max(c.cover_end, lastTs) - 1500, req.end, room2) : [];
  // One write per chunk for every daily counter (non-decreasing: deleting sessions frees nothing).
  db.run(
    `INSERT INTO daily (day, sessions, forced, chunks, bytes, derived, forwarded) VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET sessions = sessions + excluded.sessions, forced = forced + excluded.forced, chunks = chunks + 1,
       bytes = bytes + excluded.bytes, derived = derived + excluded.derived, forwarded = forwarded + excluded.forwarded`,
    [day, existing ? 0 : 1, !existing && meta.forced ? 1 : 0, req.bytes, added, forward.length],
  );
  if (!existing && req.net)
    db.run("INSERT INTO net_daily (day, net, sessions) VALUES (?, ?, 1) ON CONFLICT(day, net) DO UPDATE SET sessions = sessions + 1", [
      day,
      req.net,
    ]);
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
    "SELECT id, ts, seq FROM events WHERE session_id = ? AND kind = 'click' AND open = 1 AND seq != ? AND ((ts >= ? AND ts <= ?) OR seq = ?) LIMIT 500",
    [sid, seq, firstTs - DEAD_MS, lastTs, seq - 1],
  )) {
    const ts = num(r.ts);
    const effect = anyIn(head, ts - 50, ts + DEAD_MS) || hasNavIn(db, sid, ts, ts + DEAD_MS);
    if (effect) db.run("UPDATE events SET dead = 0, open = 0 WHERE id = ?", [num(r.id)]);
    else if (num(r.seq) + 1 === seq) db.run("UPDATE events SET open = 0 WHERE id = ?", [num(r.id)]);
  }
  const open = db.all("SELECT id, ts FROM events WHERE session_id = ? AND kind = 'click' AND open = 1 AND seq = ? LIMIT 500", [sid, seq]);
  if (!open.length) return;
  // Parsed once per later chunk (not once per click and chunk).
  const later = db
    .all("SELECT seq, effect_head FROM chunks WHERE session_id = ? AND seq > ? AND first_ts <= ? ORDER BY seq LIMIT 20", [
      sid,
      seq,
      lastTs + DEAD_MS,
    ])
    .map((l) => ({ seq: num(l.seq), head: l.effect_head ? (JSON.parse(String(l.effect_head)) as number[]) : [] }));
  const contiguous = later.some((l) => l.seq === seq + 1);
  for (const r of open) {
    const ts = num(r.ts);
    const effect = later.some((l) => anyIn(l.head, ts - 50, ts + DEAD_MS)) || hasNavIn(db, sid, ts, ts + DEAD_MS);
    if (effect) db.run("UPDATE events SET dead = 0, open = 0 WHERE id = ?", [num(r.id)]);
    else if (contiguous) db.run("UPDATE events SET open = 0 WHERE id = ?", [num(r.id)]);
  }
}

const WINDOW_LOAD_MS = 3000;
const WINDOW_UPDATE_MS = 1500;
/** Rows a window looks at, at most (overlapping crafted chunks can't make one update expensive). */
const WINDOW_ROWS = 3000;

/** Rage clicks and error clicks, re-evaluated in a window around the new chunk (exact for the updated range). */
function resolveWindowSignals(db: Db, sid: string, firstTs: number, lastTs: number) {
  const from = firstTs - WINDOW_LOAD_MS;
  const to = lastTs + WINDOW_LOAD_MS;
  const clicks = db.all(
    "SELECT id, ts, pv, selector, x, y, rage, rage_start, error_click, label FROM events WHERE session_id = ? AND kind = 'click' AND ts >= ? AND ts <= ? ORDER BY ts, id LIMIT ?",
    [sid, from, to, WINDOW_ROWS],
  );
  const errors = db.all(
    "SELECT id, ts, error_click, selector FROM events WHERE session_id = ? AND kind = 'error' AND ts >= ? AND ts <= ? ORDER BY ts, id LIMIT ?",
    [sid, from, to, WINDOW_ROWS],
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
 * to analytics yet, marked as sent, at most `room` of them (MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY).
 * Rage bursts once, dead clicks on interactive elements outside rage bursts, each error
 * fingerprint once per session.
 */
function takeForwardable(db: Db, sid: string, settledBefore: number, end: boolean, room: number): ForwardItem[] {
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
    const items: ForwardItem[] = [];
    if (num(r.rage_start)) items.push({ name: "rage_click", ts: num(r.ts), path: strOrNull(r.path), props: base });
    // A rage burst is one rage_click; its clicks are not also sent as dead clicks.
    if (num(r.dead) && num(r.interactive) && !num(r.rage))
      items.push({ name: "dead_click", ts: num(r.ts), path: strOrNull(r.path), props: base });
    if (num(r.error_click)) items.push({ name: "error_click", ts: num(r.ts), path: strOrNull(r.path), props: base });
    if (out.length + items.length > room) return out;
    out.push(...items);
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
      if (out.length + 1 > room) return out;
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
    const items: ForwardItem[] = [];
    if (num(r.quick_back) && !(f & 1)) {
      items.push({ name: "quick_back", ts: num(r.ts), path: strOrNull(r.path), props });
      f |= 1;
    }
    if (num(r.excessive_scroll) && !(f & 2)) {
      items.push({ name: "excessive_scroll", ts: num(r.ts), path: strOrNull(r.path), props });
      f |= 2;
    }
    if (out.length + items.length > room) return out;
    out.push(...items);
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

export interface DeleteOptions {
  /**
   * The site's R2 prefix ("<site_id>/"): the chunks' keys go into r2_pending in the same
   * transaction, so a failed or interrupted R2 delete is retried (no orphaned recordings).
   */
  prefix?: string;
  /** pending keys are (re)deleted from this time on; a little later than now covers chunk uploads still in flight */
  not_before?: number;
  /** tombstone the ids (a privacy delete): an open tab can't recreate them for two days */
  tombstone_at?: number;
}

export function deleteSessions(db: Db, ids: string[], opts: DeleteOptions = {}): DeletedSessions {
  if (!ids.length) return { deleted: [], keys: [] };
  return db.transaction(() => {
    const list = JSON.stringify(ids);
    const found = db.all(`SELECT id FROM sessions WHERE id IN ${IN_JSON}`, [list]).map((r) => String(r.id));
    const keys = db
      .all(`SELECT session_id, seq FROM chunks WHERE session_id IN ${IN_JSON}`, [list])
      .map((r) => chunkKey(String(r.session_id), num(r.seq)));
    if (opts.prefix !== undefined)
      db.run(
        `INSERT OR IGNORE INTO r2_pending (key, not_before) SELECT ? || session_id || '/' || printf('%06d', seq), ? FROM chunks WHERE session_id IN ${IN_JSON}`,
        [opts.prefix, opts.not_before ?? 0, list],
      );
    if (opts.tombstone_at !== undefined)
      db.run(`INSERT OR REPLACE INTO deleted_sessions (id, at) SELECT value, ? FROM json_each(?)`, [
        opts.tombstone_at,
        JSON.stringify(found),
      ]);
    for (const t of ["events", "pages", "chunks"]) db.run(`DELETE FROM ${t} WHERE session_id IN ${IN_JSON}`, [list]);
    db.run(`DELETE FROM sessions WHERE id IN ${IN_JSON}`, [list]);
    return { deleted: found, keys };
  });
}

/** R2 keys due for deletion (full keys, prefix included), oldest first. */
export const pendingDue = (db: Db, now: number, limit = 1000): string[] =>
  db.all("SELECT key FROM r2_pending WHERE not_before <= ? ORDER BY not_before LIMIT ?", [now, limit]).map((r) => String(r.key));

export function clearPending(db: Db, keys: string[]): void {
  if (keys.length) db.run(`DELETE FROM r2_pending WHERE key IN ${IN_JSON}`, [JSON.stringify(keys)]);
}

/**
 * Roll settled days (up to two days ago) up into heatmap aggregates, before retention deletes the
 * rows they come from. Idempotent: meta.rolled_through remembers the last day done. At most
 * `maxDays` per call (the rest next time: `more`).
 */
export function rollup(db: Db, now: number, maxDays = 31): { rolled: string[]; more: boolean } {
  const lastSettled = utcDay(now - 2 * DAY);
  const through = strOrNull(db.all("SELECT value FROM meta WHERE key = 'rolled_through'")[0]?.value);
  let day: string;
  if (through) day = utcDay(Date.parse(`${through}T00:00:00Z`) + DAY);
  else {
    const first = db.all("SELECT MIN(ts) AS t FROM pages")[0]?.t;
    const firstClick = db.all(`SELECT MIN(ts) AS t FROM events WHERE ${CE} AND kind = 'click'`)[0]?.t;
    const t = Math.min(
      first == null ? Number.POSITIVE_INFINITY : num(first),
      firstClick == null ? Number.POSITIVE_INFINITY : num(firstClick),
    );
    if (!Number.isFinite(t)) {
      db.run("INSERT INTO meta (key, value) VALUES ('rolled_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
        lastSettled,
      ]);
      return { rolled: [], more: false };
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
         FROM events WHERE ${CE} AND kind = 'click' AND ts >= ? AND ts < ? AND path IS NOT NULL AND selector IS NOT NULL
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
  return { rolled, more: day <= lastSettled };
}

export const REACH_BUCKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export interface PurgeRequest {
  now: number;
  /** sessions started before this are deleted (null: retention unknown, nothing deleted) */
  cutoff: number | null;
  /** heatmap aggregates of days before this are deleted (null: keep) */
  heat_cutoff: number | null;
  /** the site's R2 prefix ("<site_id>/"): deleted sessions' chunk keys go into r2_pending */
  prefix?: string;
  /** most R2 keys (chunks) and derived rows deleted in one round */
  max_keys?: number;
  max_rows?: number;
  /** heatmap days rolled up per call */
  rollup_days?: number;
}

const ROUND_KEYS = 1_000;
const ROUND_ROWS = 20_000;

/** One bounded round of retention: the oldest sessions past cutoff, at most max_keys chunks and max_rows derived rows. */
export function purgeRound(db: Db, req: PurgeRequest): DeletedSessions & { more: boolean } {
  if (req.cutoff === null) return { deleted: [], keys: [], more: false };
  const maxKeys = req.max_keys ?? ROUND_KEYS;
  const maxRows = req.max_rows ?? ROUND_ROWS;
  const rows = db.all("SELECT id, chunks, derived, pageviews FROM sessions WHERE started_at < ? ORDER BY started_at LIMIT 200", [
    req.cutoff,
  ]);
  const ids: string[] = [];
  let keys = 0;
  let derived = 0;
  for (const r of rows) {
    const k = num(r.chunks);
    const d = num(r.derived) + num(r.pageviews);
    if (ids.length && (keys + k > maxKeys || derived + d > maxRows)) break;
    ids.push(String(r.id));
    keys += k;
    derived += d;
  }
  const del = deleteSessions(db, ids, { prefix: req.prefix, not_before: req.now });
  return { ...del, more: ids.length < rows.length || rows.length === 200 };
}

/** Old aggregates, counters, samples and tombstones. Cheap: every statement is an indexed range delete. */
export function housekeeping(db: Db, now: number, heatCutoff: number | null): void {
  db.transaction(() => {
    if (heatCutoff !== null) {
      const heatDay = utcDay(heatCutoff);
      db.run("DELETE FROM heat_daily WHERE day < ?", [heatDay]);
      db.run("DELETE FROM scroll_daily WHERE day < ?", [heatDay]);
    }
    db.run("DELETE FROM drops WHERE day < ?", [utcDay(now - 31 * DAY)]);
    // Samples (an Origin, a user agent) only help with today's and yesterday's refusals.
    db.run("UPDATE drops SET sample = NULL WHERE day < ? AND sample IS NOT NULL", [utcDay(now - DAY)]);
    db.run("DELETE FROM daily WHERE day < ?", [utcDay(now - 31 * DAY)]);
    db.run("DELETE FROM net_daily WHERE day < ?", [utcDay(now - DAY)]);
    db.run("DELETE FROM link_usage WHERE day < ?", [utcDay(now - DAY)]);
    db.run("DELETE FROM deleted_sessions WHERE at < ?", [now - 2 * DAY]);
  });
}

/** Rollup (bounded), one purge round, housekeeping. */
export function purge(db: Db, req: PurgeRequest): DeletedSessions & { more: boolean; rolled: string[] } {
  const r = rollup(db, req.now, req.rollup_days);
  const del = purgeRound(db, req);
  housekeeping(db, req.now, req.heat_cutoff);
  return { ...del, more: del.more || r.more, rolled: r.rolled };
}

/**
 * What the site's alarm (and the daily cron kick) runs: rollup a few days, purge rounds until the
 * deadline or nothing is left, housekeeping. Deleted chunks' keys end up in r2_pending; the DO
 * deletes them from R2 afterwards.
 */
export function maintain(db: Db, req: PurgeRequest & { deadline: number }) {
  const r = rollup(db, req.now, req.rollup_days ?? 2);
  let sessions = 0;
  let keys = 0;
  let more = false;
  while (Date.now() < req.deadline) {
    const round = purgeRound(db, req);
    sessions += round.deleted.length;
    keys += round.keys.length;
    more = round.more;
    if (!round.more) break;
  }
  housekeeping(db, req.now, req.heat_cutoff);
  return { sessions_deleted: sessions, chunks_queued: keys, rolled: r.rolled, more: more || r.more };
}

/** Anything a later maintenance run still has to look after (so the alarm keeps coming). */
export const hasStoredData = (db: Db): boolean =>
  ["sessions", "heat_daily", "scroll_daily", "r2_pending", "deleted_sessions"].some((t) => db.all(`SELECT 1 FROM ${t} LIMIT 1`).length > 0);

// ---------------------------------------------------------------------------------- account/deployment usage

/** Per day: what this site counted and hasn't reported to D1 yet (at most today and yesterday). */
export function unreported(db: Db): { day: string; delta: Totals }[] {
  return db
    .all(
      "SELECT * FROM daily WHERE sessions > rep_sessions OR chunks > rep_chunks OR bytes > rep_bytes OR derived > rep_derived ORDER BY day DESC LIMIT 2",
    )
    .map((r) => {
      const d = dailyRow(db, String(r.day));
      return { day: d.day, delta: localUnreported(d) };
    });
}

/** After D1 accepted the deltas: they count as reported. */
export function markReported(db: Db, rows: { day: string; delta: Totals }[]): void {
  for (const r of rows)
    db.run(
      "UPDATE daily SET rep_sessions = rep_sessions + ?, rep_chunks = rep_chunks + ?, rep_bytes = rep_bytes + ?, rep_derived = rep_derived + ? WHERE day = ?",
      [r.delta.sessions, r.delta.chunks, r.delta.bytes, r.delta.derived, r.day],
    );
}

// ---------------------------------------------------------------------------------- share-link chunks

/**
 * May a share link serve this chunk? Only chunks ingest accepted with rrweb events in them (a real
 * recording, not whatever bytes someone posted), and within the link's daily byte budget, which is
 * charged here.
 */
export function linkChunk(
  db: Db,
  q: { link_id: string; session_id: string; seq: number; now: number; budget: number | null },
): { ok: true; bytes: number } | { ok: false; reason: "not_found" | "budget" } {
  const ch = db.all("SELECT bytes, rr_events FROM chunks WHERE session_id = ? AND seq = ?", [q.session_id, q.seq])[0];
  if (!ch || !num(ch.rr_events)) return { ok: false, reason: "not_found" };
  const bytes = num(ch.bytes);
  const day = utcDay(q.now);
  const used = num(db.all("SELECT bytes FROM link_usage WHERE link_id = ? AND day = ?", [q.link_id, day])[0]?.bytes);
  if (q.budget !== null && used + bytes > q.budget) return { ok: false, reason: "budget" };
  db.run(
    "INSERT INTO link_usage (link_id, day, bytes) VALUES (?, ?, ?) ON CONFLICT(link_id, day) DO UPDATE SET bytes = bytes + excluded.bytes",
    [q.link_id, day, bytes],
  );
  return { ok: true, bytes };
}

/** Seqs of the chunks a player can play (with rrweb events), capped. */
export function playableChunks(db: Db, sid: string, limit = 2000): number[] {
  return db.all("SELECT seq FROM chunks WHERE session_id = ? AND rr_events > 0 ORDER BY seq LIMIT ?", [sid, limit]).map((r) => num(r.seq));
}

// ---------------------------------------------------------------------------------- summary (verify, get_site)

export function summary(db: Db, now: number) {
  const s = db.all(
    `SELECT COUNT(*) AS n, COALESCE(SUM(started_at > ?), 0) AS last24, MAX(received_at) AS last_received, MAX(started_at) AS last_started,
       COALESCE(SUM(chunks), 0) AS chunks, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(day = ?), 0) AS today, COALESCE(SUM(forced), 0) AS forced
     FROM sessions`,
    [now - DAY, utcDay(now)],
  )[0]!;
  const drops: Record<string, { count: number; last_at: number }> = {};
  const samples: Record<string, string> = {};
  for (const r of db.all(
    "SELECT reason, SUM(count) AS n, MAX(last_at) AS last_at, MAX(sample) AS sample FROM drops WHERE day >= ? GROUP BY reason",
    [utcDay(now - 7 * DAY)],
  )) {
    drops[String(r.reason)] = { count: num(r.n), last_at: num(r.last_at) };
    if (r.sample != null) samples[String(r.reason)] = String(r.sample);
  }
  const hosts = db
    .all("SELECT host, COUNT(*) AS n FROM pages WHERE ts > ? AND host IS NOT NULL GROUP BY host ORDER BY n DESC LIMIT 10", [now - 7 * DAY])
    .map((r) => ({ hostname: String(r.host), pageviews: num(r.n) }));
  const t = dailyRow(db, utcDay(now));
  return {
    sessions_total: num(s.n),
    sessions_last_24h: num(s.last24),
    sessions_today: num(s.today),
    forced_sessions: num(s.forced),
    last_chunk_at: s.last_received == null ? null : num(s.last_received),
    last_session_started_at: s.last_started == null ? null : num(s.last_started),
    chunks_total: num(s.chunks),
    bytes_total: num(s.bytes),
    /** today's counters (UTC day); they never go down, deleting sessions frees nothing */
    usage_today: {
      sessions: t.sessions,
      forced_sessions: t.forced,
      chunks: t.chunks,
      bytes: t.bytes,
      derived_events: t.derived,
      forwarded_events: t.forwarded,
    },
    hostnames_last_7d: hosts,
    dropped_last_7d: drops,
    /** the latest refused Origin / hostname / user agent per reason (raw request data: untrusted) */
    drop_samples: samples,
  };
}

export type Summary = ReturnType<typeof summary>;

export function chunkSeqs(db: Db, sid: string): number[] {
  return db.all("SELECT seq FROM chunks WHERE session_id = ? ORDER BY seq", [sid]).map((r) => num(r.seq));
}

export type { Row };
