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

import { ATTACK_COOLDOWN_MS, SPIKE_FACTOR, SPIKE_WINDOW_MS } from "@afs/shared";
import type { DerivedChunk } from "../lib/derive";
import { ACTIVE_GAP_MS, anyIn, ATTENTION_BANDS, attentionAdd, DEAD_MS, shiftChunk } from "../lib/derive";
import { type Budget, COUNTERS, type Counter, DEFAULTS, LIMITS, type Totals } from "../lib/limits";
import type { PageRow, SessionRow } from "../lib/rows";
import { detectRage, errorClicks, excessiveScroll, frustrationScore, quickBacks } from "../lib/signals";
import { type Db, DAY, IN_JSON, marks, num, type Row, type SqlValue, strOrNull, utcDay } from "./db";
import { surveyHousekeeping } from "./surveys";
import { FWD_ANALYTICS, queueSessionSignals, type TagsRequest, tagsQueued } from "./tags-outbox";

/**
 * Schema version 1 (the first release) is SCHEMA_V1 and is never edited; later versions are
 * MIGRATIONS, run in order, each in a transaction that also bumps meta.schema_version, so a DO
 * created by any earlier release catches up the first time it is instantiated (like analytics'
 * engine). SCHEMA_V1 only runs for a brand-new database: running it again would recreate indexes a
 * migration dropped.
 */
export const SCHEMA_VERSION = 5;

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
/** The partial index events_nw: failed requests and console warnings (v3). */
export const NW = "kind IN ('net', 'warn')";

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

/**
 * Version 3 (parity release), additive only: custom tags per session, and the columns and tables
 * the later features add (see each comment). Existing objects gain them in place; nothing is
 * rewritten, so old rows simply have the defaults.
 */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session_id, key, value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_tags_kv ON session_tags(key, value);
ALTER TABLE sessions ADD COLUMN referrer TEXT;
ALTER TABLE sessions ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN active_last INTEGER;
CREATE INDEX IF NOT EXISTS events_nw ON events(kind, ts) WHERE kind IN ('net', 'warn');
CREATE TABLE IF NOT EXISTS survey_responses (
  id TEXT PRIMARY KEY,
  survey_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  session_id TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  path TEXT,
  device TEXT,
  country TEXT,
  answers TEXT NOT NULL,
  answered INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  test INTEGER NOT NULL DEFAULT 0,
  element TEXT,
  net TEXT,
  bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS survey_responses_survey ON survey_responses(survey_id, created_at);
CREATE INDEX IF NOT EXISTS survey_responses_session ON survey_responses(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS survey_responses_user ON survey_responses(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS survey_responses_created ON survey_responses(created_at);
CREATE TABLE IF NOT EXISTS survey_daily (
  day TEXT NOT NULL,
  survey_id TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  responses INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  test_impressions INTEGER NOT NULL DEFAULT 0,
  test_responses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, survey_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS survey_net_daily (
  day TEXT NOT NULL,
  net TEXT NOT NULL,
  responses INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, net)
) WITHOUT ROWID;
ALTER TABLE sessions ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN upgraded TEXT;
ALTER TABLE daily ADD COLUMN upgraded INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS sessions_starred ON sessions(started_at) WHERE starred = 1;
CREATE TABLE IF NOT EXISTS session_labels (
  session_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (session_id, label)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_labels_label ON session_labels(label);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  t_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_session ON notes(session_id, t_ms);
ALTER TABLE chunks ADD COLUMN snap INTEGER;
ALTER TABLE pages ADD COLUMN attention TEXT;
ALTER TABLE pages ADD COLUMN att_ts INTEGER;
ALTER TABLE pages ADD COLUMN att_y INTEGER;
ALTER TABLE scroll_daily ADD COLUMN attention TEXT;
ALTER TABLE scroll_daily ADD COLUMN click_bands TEXT;
ALTER TABLE events ADD COLUMN zone TEXT;
ALTER TABLE heat_daily ADD COLUMN zone TEXT;
CREATE TABLE IF NOT EXISTS error_groups (
  fingerprint TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS segment_hits (
  segment_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, session_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS survey_versions (
  survey_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  questions TEXT NOT NULL,
  PRIMARY KEY (survey_id, version)
) WITHOUT ROWID
`;

/**
 * Version 4 (wave 2), additive: chunks of starred sessions copied to the starred/ prefix (kept:
 * NULL not yet, 1 copied, 0 the original was gone); signals and survey scores queued for a linked
 * tags container (tags_outbox, its daily counter daily.tags_forwarded; events.forwarded becomes a
 * bit set: 1 analytics, 2 tags).
 */
const SCHEMA_V4 = `
ALTER TABLE chunks ADD COLUMN kept INTEGER;
CREATE INDEX IF NOT EXISTS chunks_kept ON chunks(session_id) WHERE kept = 1;
ALTER TABLE daily ADD COLUMN tags_forwarded INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS tags_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  response_id TEXT,
  created_at INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tags_outbox_session ON tags_outbox(session_id);
CREATE INDEX IF NOT EXISTS tags_outbox_response ON tags_outbox(response_id) WHERE response_id IS NOT NULL
`;

/** Version 5 (hardening round): bytes per client network per day, for the network's byte share. */
const SCHEMA_V5 = `
ALTER TABLE net_daily ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0
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
  {
    version: 3,
    up: (db) => {
      for (const s of statements(SCHEMA_V3)) db.run(s);
    },
  },
  {
    version: 4,
    up: (db) => {
      for (const s of statements(SCHEMA_V4)) db.run(s);
    },
  },
  {
    version: 5,
    up: (db) => {
      for (const s of statements(SCHEMA_V5)) db.run(s);
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
  /** afsr('upgrade', reason) */
  upgraded?: string | null;
  /** this chunk's page had analytics test traffic on (envelope dbg: ?afsa_debug=1, afsa('debug')) */
  debug?: boolean;
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
  /** new afsr('upgrade') sessions per UTC day */
  upgraded_daily?: number | null;
  /** new sessions per client network per UTC day */
  net_daily?: number | null;
  /** stored bytes per client network per UTC day (every chunk counts, new session or not) */
  net_bytes?: number | null;
  /** analytics events forwarded per UTC day */
  forward_daily?: number | null;
  /** the account's and the deployment's daily budgets (null fields = no cap) */
  account?: Budget;
  platform?: Budget;
  /** this site's own daily budget (null fields = no cap): a flooded site stops alone (site_daily_limit) */
  site?: Budget;
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
  /** queue settled signals for the linked tags container (verified site, TAGS binding) */
  tags?: TagsRequest | null;
  /** hashed client network (IPv4 address or IPv6 /48), for net_daily; never the address */
  net?: string | null;
  /** the client network is a data centre (@afs/shared isDatacenterAsn): refused as a new session while the site is under attack */
  dc?: boolean;
  usage?: UsageSnapshot | null;
}

export interface ForwardItem {
  name: "rage_click" | "dead_click" | "error_click" | "js_error" | "quick_back" | "excessive_scroll";
  ts: number;
  path: string | null;
  props: Record<string, string | number | boolean | null>;
}

/** An error group (JS or network) seen for the first time on the site (webhook error.new). */
export interface NewError {
  fingerprint: string;
  kind: "js" | "network";
  message: string;
  path: string | null;
  ts: number;
}

export type IngestResult =
  | {
      status: "accepted";
      new_session: boolean;
      forward: ForwardItem[];
      /**
       * Test traffic: the session was forced (?afsr=1) or this chunk's page had analytics debug on.
       * Its forwarded signals go to analytics with debug: true and to tags in test batches.
       */
      test: boolean;
      new_errors?: NewError[];
      tags_queued?: number;
    }
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
  c.nets.length +
  c.tags.reduce((n, t) => n + t.values.length, 0) +
  c.marks.length +
  c.scrolls.reduce((n, s) => n + s.milestones.length, 0);

/**
 * Would adding `add` to today's counters pass the account's or the deployment's daily budget?
 * The last D1 totals plus what this site hasn't reported yet. Returns the refusal reason or null.
 */
export function overBudget(
  db: Db,
  day: string,
  add: Totals,
  account?: Budget,
  platform?: Budget,
  usage?: UsageSnapshot | null,
): "account_daily_limit" | "platform_budget" | null {
  const local = localUnreported(dailyRow(db, day));
  const u = usage && usage.day === day ? usage : null;
  const scopes = [
    { budget: account, totals: u?.account ?? null, reason: "account_daily_limit" as const },
    { budget: platform, totals: u?.platform ?? null, reason: "platform_budget" as const },
  ];
  for (const s of scopes) {
    if (!s.budget) continue;
    for (const k of COUNTERS) {
      const max = s.budget[k];
      if (max === null || max === undefined || !add[k]) continue;
      if ((s.totals?.[k] ?? 0) + local[k] + add[k] > max) return s.reason;
    }
  }
  return null;
}

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
  // This site's own share of the day (the account's other sites keep recording past it).
  if (L.site)
    for (const k of COUNTERS) {
      const max = L.site[k];
      if (max === null || max === undefined || !add[k]) continue;
      if (d[k] + add[k] > max) return reject("site_daily_limit", true, k);
    }
  const netRow =
    req.net && (L.net_daily != null || L.net_bytes != null)
      ? db.all("SELECT sessions, bytes FROM net_daily WHERE day = ? AND net = ?", [day, req.net])[0]
      : undefined;

  if (!existing) {
    // A new session starts with its page: its hostname is what was checked against the site.
    if (!c.hosts.length) return reject("page_host_required", false);
    if (!meta.forced) {
      // Every new-session attempt feeds spike detection; while under attack, data-centre networks
      // start no session (refused before the daily caps, so they never count against them).
      const attacked = noteSessionAttempt(db, now);
      if (req.dc && attacked) return reject("datacenter_under_attack");
    }
    if (meta.forced) {
      if (L.forced_daily !== null && L.forced_daily !== undefined && d.forced >= L.forced_daily) return reject("forced_daily_limit");
    } else if (L.daily_sessions !== null && d.sessions - d.forced >= L.daily_sessions) return reject("daily_session_limit");
    if (
      meta.upgraded &&
      L.upgraded_daily !== null &&
      L.upgraded_daily !== undefined &&
      num(db.all("SELECT upgraded FROM daily WHERE day = ?", [day])[0]?.upgraded) >= L.upgraded_daily
    )
      return reject("upgraded_daily_limit");
    if (req.net && L.net_daily !== null && L.net_daily !== undefined && num(netRow?.sessions) >= L.net_daily)
      return reject("ip_daily_limit");
    if (req.bytes > L.session_bytes) return reject("session_bytes_limit");
  } else {
    if (existing.ua_hash && meta.ua_hash && existing.ua_hash !== meta.ua_hash) return reject("session_mismatch");
    if (existing.bytes + req.bytes > L.session_bytes) return reject("session_bytes_limit");
    if (existing.chunks >= (L.chunks_per_session ?? LIMITS.CHUNKS_PER_SESSION)) return reject("session_chunk_limit");
    if (lastTs - existing.started_at > L.max_session_ms + SESSION_GRACE_MS) return reject("max_duration");
  }
  // The network's byte share of this site's day: every chunk counts, whichever session it belongs to.
  if (req.net && L.net_bytes !== null && L.net_bytes !== undefined && num(netRow?.bytes) + req.bytes > L.net_bytes)
    return reject("ip_bytes_limit");
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
       user_id = COALESCE(?, user_id), analytics_visitor_id = COALESCE(?, analytics_visitor_id), upgraded = COALESCE(upgraded, ?),
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
      meta.upgraded ?? null,
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
    "INSERT INTO chunks (session_id, seq, first_ts, last_ts, cover_end, received_at, bytes, rr_events, effect_head, snap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      c.full_snapshots > 0 ? 1 : 0,
    ],
  );

  const session = getSession(db, sid)!;
  const device = session.device;
  // The page activity before this chunk's first afs.* event belongs to (see derive: pv 0).
  const currentPv =
    num(db.all("SELECT MAX(pv) AS pv FROM pages WHERE session_id = ? AND path IS NOT NULL", [sid])[0]?.pv) ||
    (c.pages.length ? Math.min(...c.pages.map((p) => p.pv)) : 0);

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

  // Attention: how long each 10% band of the page was in view. Positions are held until the next
  // one (at most ATTENTION_HOLD_MS); the page's last position carries into the next chunk.
  {
    const touched = new Map(c.scrolls.map((sg) => [sg.pv, sg] as const));
    const latest = num(db.all("SELECT MAX(pv) AS pv FROM pages WHERE session_id = ? AND path IS NOT NULL", [sid])[0]?.pv);
    if (latest && !touched.has(latest)) touched.set(latest, undefined as never);
    for (const [pv, sg] of touched) {
      const row = db.all("SELECT attention, att_ts, att_y, view_h, doc_h FROM pages WHERE session_id = ? AND pv = ?", [sid, pv])[0];
      if (!row) continue;
      const vh = num(row.view_h) || (sg?.vh ?? 0);
      const dh = num(row.doc_h) || (sg?.dh ?? 0);
      const pts: [number, number][] = [];
      if (row.att_ts !== null && row.att_ts !== undefined) pts.push([num(row.att_ts), num(row.att_y)]);
      for (const p of sg?.pts ?? []) if (!pts.length || p[0] >= pts[pts.length - 1]![0]) pts.push(p);
      if (!pts.length) continue;
      const until = pv === latest ? Math.max(lastTs, pts[pts.length - 1]![0]) : null;
      const prev = row.attention ? (JSON.parse(String(row.attention)) as number[]) : [];
      const bands = attentionAdd(prev, pts, vh, dh, until);
      const [lt, ly] = pts[pts.length - 1]!;
      db.run("UPDATE pages SET attention = ?, att_ts = ?, att_y = ? WHERE session_id = ? AND pv = ?", [
        JSON.stringify(bands),
        until ?? lt,
        ly,
        sid,
        pv,
      ]);
    }
  }

  // Active time per pageview: the gaps inside this chunk, plus the gap to the page's last activity
  // in an earlier chunk (at most ACTIVE_GAP_MS). pv 0 = activity before any afs.* event of the chunk.
  if (c.activity.length) {
    for (const a of c.activity) {
      const pv = a.pv || currentPv;
      if (!pv) continue;
      const row = db.all("SELECT active_last FROM pages WHERE session_id = ? AND pv = ?", [sid, pv])[0];
      if (!row) continue;
      const lastBefore = row.active_last === null ? null : num(row.active_last);
      const join = lastBefore !== null && a.first >= lastBefore ? Math.min(ACTIVE_GAP_MS, a.first - lastBefore) : 0;
      db.run("UPDATE pages SET active_ms = active_ms + ?, active_last = MAX(COALESCE(active_last, 0), ?) WHERE session_id = ? AND pv = ?", [
        a.ms + join,
        a.last,
        sid,
        pv,
      ]);
    }
  }

  // Derived events, capped per session.
  const pathOf = new Map<number, string | null>();
  const pvs = [
    ...new Set(
      [...c.clicks, ...c.inputs, ...c.errors, ...c.nets, ...c.customs, ...c.marks].map((e) => e.pv).concat(milestoneRows.map((m) => m.pv)),
    ),
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
      ...(k.zone ? { zone: k.zone } : {}),
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
      // console.warn (capture_console_warnings) is kept apart: it isn't a JS error or a signal
      kind: e.kind === "warn" ? "warn" : "error",
      path: pathOf.get(e.pv) ?? null,
      message: e.message,
      fingerprint: e.fingerprint,
      detail: JSON.stringify({ kind: e.kind, source: e.source, line: e.line, col: e.col, stack: e.stack }),
    });
  }
  let netRoom = LIMITS.NET_PER_SESSION - num(session.api_errors);
  for (const n of c.nets) {
    if (netRoom <= 0) {
      capped = true;
      continue;
    }
    netRoom--;
    insert({
      ts: n.ts,
      pv: n.pv,
      kind: "net",
      path: pathOf.get(n.pv) ?? null,
      tag: n.method,
      href: n.url,
      message: `${n.method} ${n.url} ${n.status || "failed"}`,
      fingerprint: n.fingerprint,
      detail: JSON.stringify({ status: n.status, ms: n.ms }),
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
  // Custom tags (afsr('set'), identify attributes): at most TAG_KEYS_PER_SESSION keys and
  // TAG_VALUES_PER_KEY values; a value sent again (every page load re-sends the tab's tags) is free.
  if (c.tags.length) {
    const have = new Map<string, number>();
    for (const r of db.all("SELECT key, COUNT(*) AS n FROM session_tags WHERE session_id = ? GROUP BY key", [sid]))
      have.set(String(r.key), num(r.n));
    for (const t of c.tags) {
      let n = have.get(t.key);
      if (n === undefined) {
        if (have.size >= LIMITS.TAG_KEYS_PER_SESSION) {
          capped = true;
          continue;
        }
        n = 0;
      }
      for (const v of t.values) {
        if (db.all("SELECT 1 FROM session_tags WHERE session_id = ? AND key = ? AND value = ?", [sid, t.key, v]).length) continue;
        if (n >= LIMITS.TAG_VALUES_PER_KEY || room <= 0) {
          capped = true;
          break;
        }
        room--;
        added++;
        n++;
        db.run("INSERT INTO session_tags (session_id, key, value, ts) VALUES (?, ?, ?, ?)", [sid, t.key, v, t.ts]);
      }
      have.set(t.key, n);
    }
  }
  // Error groups the site has never seen (or not for heatmap_retention_days): error.new webhooks.
  const newErrors: NewError[] = [];
  const seen = new Set<string>();
  for (const e of [
    ...c.errors
      .filter((x) => x.kind !== "warn")
      .map((x) => ({ fp: x.fingerprint, kind: "js" as const, message: x.message, pv: x.pv, ts: x.ts })),
    ...c.nets.map((x) => ({
      fp: x.fingerprint,
      kind: "network" as const,
      message: `${x.method} ${x.url} ${x.status || "failed"}`,
      pv: x.pv,
      ts: x.ts,
    })),
  ]) {
    if (seen.has(e.fp)) continue;
    seen.add(e.fp);
    const g = db.all("SELECT last_seen FROM error_groups WHERE fingerprint = ?", [e.fp])[0];
    if (!g) {
      db.run("INSERT INTO error_groups (fingerprint, kind, first_seen, last_seen) VALUES (?, ?, ?, ?)", [e.fp, e.kind, e.ts, e.ts]);
      if (newErrors.length < 5)
        newErrors.push({ fingerprint: e.fp, kind: e.kind, message: e.message, path: pathOf.get(e.pv) ?? null, ts: e.ts });
    } else if (num(g.last_seen) < now - DAY) db.run("UPDATE error_groups SET last_seen = ? WHERE fingerprint = ?", [now, e.fp]);
  }
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
  if (!existing && meta.upgraded) db.run("UPDATE daily SET upgraded = upgraded + 1 WHERE day = ?", [day]);
  if (req.net)
    db.run(
      `INSERT INTO net_daily (day, net, sessions, bytes) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, net) DO UPDATE SET sessions = sessions + excluded.sessions, bytes = bytes + excluded.bytes`,
      [day, req.net, existing ? 0 : 1, req.bytes],
    );
  const test = !!session.forced || !!meta.debug;
  const tagsQueuedNow = req.tags ? queueSessionSignals(db, sid, Math.max(c.cover_end, lastTs) - 1500, req.end, req.tags, req.now, test) : 0;
  return {
    status: "accepted",
    new_session: !existing,
    forward,
    test,
    ...(newErrors.length ? { new_errors: newErrors } : {}),
    ...(tagsQueuedNow ? { tags_queued: tagsQueuedNow } : {}),
  };
}

// ---------------------------------------------------------------------------------- attack mode

/**
 * Replay's attack mode (the vocabulary of @afs/shared protection.ts). Every new-session attempt
 * (not ?afsr=1 tests) is counted per SPIKE_WINDOW_MS window; a window that reaches
 * max(ATTACK_MIN_SESSIONS, SPIKE_FACTOR x the site's usual sessions per window over the previous
 * 7 days) puts the site under attack until ATTACK_COOLDOWN_MS after the last such window. While it
 * lasts, new sessions from data-centre networks are refused (datacenter_under_attack): they are
 * not stored and never count against the site's daily sessions. Residential visitors are not
 * affected, nor are sessions already recording.
 *
 * State is one meta row. A window stops being written once it reached the threshold, so a flood
 * costs at most `threshold` writes per window (plus the usual rate, computed once a UTC day).
 */
export const ATTACK_MIN_SESSIONS = 30;
const BASELINE_DAYS = 7;
const WINDOWS_PER_DAY = DAY / SPIKE_WINDOW_MS;

interface AttackState {
  /** the episode: when it started and the last spiking window (0 = never) */
  since: number;
  last_seen_at: number;
  /** the current window's start and its new-session attempts (counted up to the threshold) */
  window: number;
  attempts: number;
  /** the usual sessions per window, and the UTC day it was computed on */
  baseline: number;
  baseline_day: string;
}

function attackState(db: Db): AttackState {
  const base: AttackState = { since: 0, last_seen_at: 0, window: 0, attempts: 0, baseline: 0, baseline_day: "" };
  try {
    const raw = db.all("SELECT value FROM meta WHERE key = 'attack'")[0]?.value;
    return raw ? { ...base, ...(JSON.parse(String(raw)) as Partial<AttackState>) } : base;
  } catch {
    return base;
  }
}

const saveAttack = (db: Db, a: AttackState) =>
  db.run("INSERT INTO meta (key, value) VALUES ('attack', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(a)]);

const attackActive = (a: AttackState, now: number) => a.last_seen_at > 0 && now - a.last_seen_at < ATTACK_COOLDOWN_MS;

/** Sessions per window, averaged over the BASELINE_DAYS full UTC days before `now`'s day. */
function usualPerWindow(db: Db, now: number): number {
  const today = utcDay(now);
  const r = db.all("SELECT COALESCE(SUM(sessions), 0) AS n FROM daily WHERE day < ? AND day >= ?", [
    today,
    utcDay(now - BASELINE_DAYS * DAY),
  ])[0];
  return num(r?.n) / (BASELINE_DAYS * WINDOWS_PER_DAY);
}

/** The spike threshold for one window. */
export const attackThreshold = (usual: number) => Math.max(ATTACK_MIN_SESSIONS, Math.ceil(SPIKE_FACTOR * usual));

/** Count one new-session attempt; true when the site is under attack (after counting it). */
export function noteSessionAttempt(db: Db, now: number): boolean {
  const a = attackState(db);
  let dirty = false;
  const today = utcDay(now);
  if (a.baseline_day !== today) {
    a.baseline = usualPerWindow(db, now);
    a.baseline_day = today;
    dirty = true;
  }
  const w = now - (now % SPIKE_WINDOW_MS);
  if (a.window !== w) {
    a.window = w;
    a.attempts = 0;
  }
  const threshold = attackThreshold(a.baseline);
  if (a.attempts < threshold) {
    a.attempts++;
    dirty = true;
    if (a.attempts >= threshold) {
      if (!attackActive(a, now)) a.since = now;
      a.last_seen_at = now;
    }
  }
  if (dirty) saveAttack(db, a);
  return attackActive(a, now);
}

/** What get_replay_site shows under data.protection. */
export function protectionState(db: Db, now: number) {
  const a = attackState(db);
  const active = attackActive(a, now);
  return {
    state: active ? ("under_attack" as const) : ("none" as const),
    since: active ? a.since : null,
    last_seen_at: a.last_seen_at || null,
    ends_at: active ? a.last_seen_at + ATTACK_COOLDOWN_MS : null,
    /** new-session attempts in this window that put the site under attack */
    threshold_per_window: attackThreshold(a.baseline_day === utcDay(now) ? a.baseline : usualPerWindow(db, now)),
    window_minutes: SPIKE_WINDOW_MS / 60_000,
  };
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
  // Failed requests remember the click that triggered them, like errors, but don't make it an error click.
  const nets = db.all(
    "SELECT id, ts, error_click, selector FROM events WHERE session_id = ? AND kind = 'net' AND ts >= ? AND ts <= ? ORDER BY ts, id LIMIT ?",
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
  const netClick = nets.length
    ? errorClicks(
        points,
        nets.map((r) => ({ ts: num(r.ts) })),
      ).errorClick
    : [];
  const link = (r: Record<string, SqlValue>, k: number) => {
    const click = k >= 0 ? clicks[k]! : null;
    const ne = click ? 1 : 0;
    if (ne !== num(r.error_click) || (click && click.selector !== r.selector))
      db.run("UPDATE events SET error_click = ?, selector = ?, label = ? WHERE id = ?", [
        ne,
        click ? strOrNull(click.selector) : null,
        click ? strOrNull(click.label) : null,
        num(r.id),
      ]);
  };
  nets.forEach((r, i) => {
    if (inRange(num(r.ts))) link(r, netClick[i]!);
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
       COALESCE(SUM(kind = 'net'), 0) AS api_errors,
       COALESCE(SUM(kind = 'click' AND rage_start = 1), 0) AS rage, COALESCE(SUM(kind = 'click' AND dead = 1), 0) AS dead,
       COALESCE(SUM(kind = 'click' AND dead = 1 AND interactive = 1), 0) AS dead_i, COALESCE(SUM(kind = 'click' AND error_click = 1), 0) AS error_clicks
     FROM events WHERE session_id = ?`,
    [sid],
  )[0]!;
  const p = db.all(
    "SELECT COUNT(*) AS n, COALESCE(SUM(quick_back), 0) AS qb, COALESCE(SUM(excessive_scroll), 0) AS ex, COALESCE(SUM(active_ms), 0) AS active FROM pages WHERE session_id = ? AND path IS NOT NULL",
    [sid],
  )[0]!;
  const entry = db.all("SELECT path, referrer FROM pages WHERE session_id = ? AND path IS NOT NULL ORDER BY pv LIMIT 1", [sid])[0];
  const exit = db.all("SELECT path FROM pages WHERE session_id = ? AND path IS NOT NULL ORDER BY pv DESC LIMIT 1", [sid])[0];
  const counts = {
    rage_clicks: num(e.rage),
    dead_clicks: num(e.dead),
    dead_interactive: num(e.dead_i),
    error_clicks: num(e.error_clicks),
    errors: num(e.errors),
    quick_backs: num(p.qb),
    excessive_scrolls: num(p.ex),
    api_errors: num(e.api_errors),
  };
  db.run(
    `UPDATE sessions SET duration_ms = MAX(0, last_at - started_at), clicks = ?, inputs = ?, errors = ?, rage_clicks = ?, dead_clicks = ?, dead_interactive = ?,
       error_clicks = ?, quick_backs = ?, excessive_scrolls = ?, pageviews = ?, entry_path = ?, exit_path = ?, referrer = ?, active_ms = ?, api_errors = ?, frustration = ? WHERE id = ?`,
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
      strOrNull(entry?.referrer)?.toLowerCase() ?? null,
      num(p.active),
      counts.api_errors,
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
     WHERE session_id = ? AND kind = 'click' AND (forwarded & ${FWD_ANALYTICS}) = 0 AND ts <= ? AND (open = 0 OR ? = 1)
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
    db.run(`UPDATE events SET forwarded = forwarded | ${FWD_ANALYTICS} WHERE id = ?`, [num(r.id)]);
  }
  const errors = db.all(
    `SELECT id, ts, path, message, fingerprint FROM events e WHERE session_id = ? AND kind = 'error' AND (forwarded & ${FWD_ANALYTICS}) = 0 AND ts <= ?
     ORDER BY ts LIMIT 50`,
    [sid, limit],
  );
  const sent = new Set(
    db
      .all(`SELECT DISTINCT fingerprint FROM events WHERE session_id = ? AND kind = 'error' AND (forwarded & ${FWD_ANALYTICS}) != 0`, [sid])
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
    db.run(`UPDATE events SET forwarded = forwarded | ${FWD_ANALYTICS} WHERE id = ?`, [num(r.id)]);
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
  /** full R2 keys of starred playback copies ("starred/<site_id>/<session_id>/<seq>") */
  starred_keys?: string[];
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

/** Every table with rows of one session (deleted with it: privacy requests and retention). */
export const SESSION_TABLES = [
  "events",
  "pages",
  "chunks",
  "session_tags",
  "session_labels",
  "notes",
  "segment_hits",
  "tags_outbox",
] as const;

export function deleteSessions(db: Db, ids: string[], opts: DeleteOptions = {}): DeletedSessions {
  if (!ids.length) return { deleted: [], keys: [] };
  return db.transaction(() => {
    const list = JSON.stringify(ids);
    const found = db.all(`SELECT id FROM sessions WHERE id IN ${IN_JSON}`, [list]).map((r) => String(r.id));
    const keys = db
      .all(`SELECT session_id, seq FROM chunks WHERE session_id IN ${IN_JSON}`, [list])
      .map((r) => chunkKey(String(r.session_id), num(r.seq)));
    const starred_keys =
      opts.prefix === undefined
        ? []
        : db
            .all(`SELECT session_id, seq FROM chunks WHERE session_id IN ${IN_JSON} AND kept = 1`, [list])
            .map((r) => starredKey(opts.prefix!, String(r.session_id), num(r.seq)));
    if (opts.prefix !== undefined) {
      db.run(
        `INSERT OR IGNORE INTO r2_pending (key, not_before) SELECT ? || session_id || '/' || printf('%06d', seq), ? FROM chunks WHERE session_id IN ${IN_JSON}`,
        [opts.prefix, opts.not_before ?? 0, list],
      );
      // a starred session's playback copies go with it
      db.run(
        `INSERT OR IGNORE INTO r2_pending (key, not_before) SELECT ? || ? || session_id || '/' || printf('%06d', seq), ? FROM chunks WHERE session_id IN ${IN_JSON} AND kept = 1`,
        [STARRED_PREFIX, opts.prefix, opts.not_before ?? 0, list],
      );
    }
    if (opts.tombstone_at !== undefined)
      db.run(`INSERT OR REPLACE INTO deleted_sessions (id, at) SELECT value, ? FROM json_each(?)`, [
        opts.tombstone_at,
        JSON.stringify(found),
      ]);
    for (const t of SESSION_TABLES) db.run(`DELETE FROM ${t} WHERE session_id IN ${IN_JSON}`, [list]);
    // Responses linked to these sessions go with them (privacy requests and retention alike).
    db.run(`DELETE FROM survey_responses WHERE session_id IN ${IN_JSON}`, [list]);
    db.run(`DELETE FROM sessions WHERE id IN ${IN_JSON}`, [list]);
    return { deleted: found, keys, ...(starred_keys.length ? { starred_keys } : {}) };
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
        `INSERT OR REPLACE INTO heat_daily (day, path, device, selector, label, tag, interactive, clicks, rage, dead, error_clicks, sessions, top_sum, top_n, zone)
         SELECT ?, path, COALESCE(device, ''), selector, MAX(label), MAX(tag), MAX(interactive), COUNT(*), SUM(rage), SUM(dead), SUM(error_click),
           COUNT(DISTINCT session_id), COALESCE(SUM(top_pct), 0), COUNT(top_pct), MAX(zone)
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
      const att = new Map<string, number[]>();
      for (const p of db.all(
        "SELECT path, COALESCE(device, '') AS device, attention FROM pages WHERE ts >= ? AND ts < ? AND path IS NOT NULL AND attention IS NOT NULL",
        [start, end],
      )) {
        const k = `${p.path}\u0000${p.device}`;
        const sum = att.get(k) ?? new Array<number>(ATTENTION_BANDS).fill(0);
        (JSON.parse(String(p.attention)) as number[]).forEach((v, i) => {
          if (i < ATTENTION_BANDS) sum[i]! += v;
        });
        att.set(k, sum);
      }
      const clickBands = new Map<string, number[]>();
      for (const e of db.all(
        `SELECT path, COALESCE(device, '') AS device, MIN(${ATTENTION_BANDS - 1}, y * ${ATTENTION_BANDS} / doc_h) AS b, COUNT(*) AS n FROM events
         WHERE ${CE} AND kind = 'click' AND ts >= ? AND ts < ? AND path IS NOT NULL AND doc_h > 0 GROUP BY path, device, b`,
        [start, end],
      )) {
        const k = `${e.path}\u0000${e.device}`;
        const arr = clickBands.get(k) ?? new Array<number>(ATTENTION_BANDS).fill(0);
        arr[Math.max(0, Math.min(ATTENTION_BANDS - 1, num(e.b)))]! += num(e.n);
        clickBands.set(k, arr);
      }
      for (const r of rows) {
        const k = `${r.path}\u0000${r.device}`;
        db.run(
          "INSERT OR REPLACE INTO scroll_daily (day, path, device, pageviews, reach, fold_sum, fold_n, attention, click_bands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            day,
            String(r.path),
            String(r.device),
            num(r.n),
            JSON.stringify(REACH_BUCKETS.map((b) => num(r[`r${b}`]))),
            num(r.fold_sum),
            num(r.fold_n),
            att.has(k) ? JSON.stringify(att.get(k)) : null,
            clickBands.has(k) ? JSON.stringify(clickBands.get(k)) : null,
          ],
        );
      }
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
  /** starred sessions are kept until this (MAX_STARRED_RETENTION_DAYS); default: like the others */
  starred_cutoff?: number | null;
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
  const starredCutoff = Math.min(req.cutoff, req.starred_cutoff ?? req.cutoff);
  const rows = db.all(
    "SELECT id, chunks, derived, pageviews FROM sessions WHERE started_at < ? AND (starred = 0 OR started_at < ?) ORDER BY started_at LIMIT 200",
    [req.cutoff, starredCutoff],
  );
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
export function housekeeping(db: Db, now: number, heatCutoff: number | null, cutoff: number | null = null): void {
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
    if (heatCutoff !== null) db.run("DELETE FROM error_groups WHERE last_seen < ?", [heatCutoff]);
    surveyHousekeeping(db, now, cutoff);
  });
}

/** Rollup (bounded), one purge round, housekeeping. */
export function purge(db: Db, req: PurgeRequest): DeletedSessions & { more: boolean; rolled: string[] } {
  const r = rollup(db, req.now, req.rollup_days);
  const del = purgeRound(db, req);
  housekeeping(db, req.now, req.heat_cutoff, req.cutoff);
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
  housekeeping(db, req.now, req.heat_cutoff, req.cutoff);
  return { sessions_deleted: sessions, chunks_queued: keys, rolled: r.rolled, more: more || r.more };
}

/** Anything a later maintenance run still has to look after (so the alarm keeps coming). */
export const hasStoredData = (db: Db): boolean =>
  ["sessions", "heat_daily", "scroll_daily", "r2_pending", "deleted_sessions", "survey_responses"].some(
    (t) => db.all(`SELECT 1 FROM ${t} LIMIT 1`).length > 0,
  );

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
  q: {
    link_id: string;
    session_id: string;
    seq: number;
    now: number;
    budget: number | null;
    window?: { start: number; end: number } | null;
  },
): { ok: true; bytes: number } | { ok: false; reason: "not_found" | "budget" } {
  const ch = db.all("SELECT bytes, rr_events FROM chunks WHERE session_id = ? AND seq = ?", [q.session_id, q.seq])[0];
  if (!ch || !num(ch.rr_events)) return { ok: false, reason: "not_found" };
  // A clip serves only the chunks of its window.
  if (q.window && !playableChunks(db, q.session_id, 2000, q.window).includes(q.seq)) return { ok: false, reason: "not_found" };
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

/**
 * Seqs of the chunks a player can play (with rrweb events), capped. With a clip window (absolute
 * ms): the chunks overlapping it, starting from the latest chunk with a full DOM snapshot before
 * its start (rrweb needs one to rebuild the page); chunks stored before v3 don't say, so from 0.
 */
export function playableChunks(db: Db, sid: string, limit = 2000, window?: { start: number; end: number } | null): number[] {
  if (!window)
    return db
      .all("SELECT seq FROM chunks WHERE session_id = ? AND rr_events > 0 ORDER BY seq LIMIT ?", [sid, limit])
      .map((r) => num(r.seq));
  const unknown = db.all("SELECT 1 FROM chunks WHERE session_id = ? AND rr_events > 0 AND snap IS NULL LIMIT 1", [sid]).length > 0;
  const snap = unknown
    ? null
    : db.all("SELECT MAX(seq) AS seq FROM chunks WHERE session_id = ? AND snap = 1 AND first_ts <= ?", [sid, window.start])[0]?.seq;
  const from = snap === null || snap === undefined ? 0 : num(snap);
  return db
    .all("SELECT seq FROM chunks WHERE session_id = ? AND rr_events > 0 AND seq >= ? AND first_ts <= ? ORDER BY seq LIMIT ?", [
      sid,
      from,
      window.end,
      limit,
    ])
    .map((r) => num(r.seq));
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
  const warnings: Record<string, { count: number; last_at: number }> = {};
  const samples: Record<string, string> = {};
  for (const r of db.all(
    "SELECT reason, SUM(count) AS n, MAX(last_at) AS last_at, MAX(sample) AS sample FROM drops WHERE day >= ? GROUP BY reason",
    [utcDay(now - 7 * DAY)],
  )) {
    const reason = String(r.reason);
    // warn:<what>: kept chunks with a setup problem (e.g. warn:proxy_key_missing), not refusals
    if (reason.startsWith("warn:")) warnings[reason.slice(5)] = { count: num(r.n), last_at: num(r.last_at) };
    else drops[reason] = { count: num(r.n), last_at: num(r.last_at) };
    if (r.sample != null) samples[reason] = String(r.sample);
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
      tags_events: num(db.all("SELECT tags_forwarded FROM daily WHERE day = ?", [utcDay(now)])[0]?.tags_forwarded),
    },
    /** signals and survey scores waiting for the linked tags container, and its last answer */
    tags_forwarding: tagsStatus(db),
    hostnames_last_7d: hosts,
    /** bytes kept in starred playback copies (counted against the daily byte budgets when copied) */
    starred_copy_bytes: starredBytes(db),
    dropped_last_7d: drops,
    /** chunks kept with a setup problem: proxy_key_missing / proxy_key_invalid (a path proxy without this site's x-afs-proxy-key) */
    warnings_last_7d: warnings,
    /** attack mode: while under_attack, new sessions from data-centre networks are refused (datacenter_under_attack) */
    protection: protectionState(db, now),
    /** the latest refused Origin / hostname / user agent per reason (raw request data: untrusted) */
    drop_samples: samples,
  };
}

export type Summary = ReturnType<typeof summary>;

// ---------------------------------------------------------------------------------- usage (GET /v1/usage)

/**
 * This site's counters behind the fair-use caps, for GET /v1/usage: today's daily row (one key
 * read), today's survey and export counters, and the counts the annotation caps check (starred
 * sessions over a partial index, notes, distinct labels; each bounded by its own cap). Never a scan
 * over sessions, events or chunks.
 */
export function usageToday(db: Db, now: number) {
  const day = utcDay(now);
  const d = dailyRow(db, day);
  const n = (sql: string, args: SqlValue[] = []) => num(db.all(sql, args)[0]?.n);
  const extra = db.all("SELECT upgraded, tags_forwarded FROM daily WHERE day = ?", [day])[0];
  const sv = db.all(
    "SELECT COALESCE(SUM(responses), 0) AS responses, COALESCE(SUM(test_responses), 0) AS test FROM survey_daily WHERE day = ?",
    [day],
  )[0];
  return {
    day,
    sessions: d.sessions,
    forced_sessions: d.forced,
    upgraded_sessions: num(extra?.upgraded),
    chunks: d.chunks,
    bytes: d.bytes,
    derived: d.derived,
    forwarded_events: d.forwarded,
    tags_events: num(extra?.tags_forwarded),
    /** what this site counted today and hasn't reported to D1 account_usage yet */
    unreported: localUnreported(d),
    survey_responses: num(sv?.responses),
    test_survey_responses: num(sv?.test),
    export_bytes: n("SELECT bytes AS n FROM link_usage WHERE link_id = '__export' AND day = ?", [day]),
    starred_sessions: n("SELECT COUNT(*) AS n FROM sessions WHERE starred = 1"),
    notes: n("SELECT COUNT(*) AS n FROM notes"),
    labels: n("SELECT COUNT(DISTINCT label) AS n FROM session_labels"),
  };
}

export type SiteUsage = ReturnType<typeof usageToday>;

/** The last batch sent to tags: HTTP status (0 = the binding failed), when, events accepted, dropped. */
export interface TagsLast {
  status: number;
  at: number;
  sent: number;
  dropped: number;
  error: string | null;
}

/** meta tags_last: the last batch sent to tags. */
function tagsStatus(db: Db): { queued: number; last: TagsLast | null } {
  const v = db.all("SELECT value FROM meta WHERE key = 'tags_last'")[0]?.value;
  let last: TagsLast | null = null;
  try {
    last = v ? (JSON.parse(String(v)) as TagsLast) : null;
  } catch {
    last = null;
  }
  return { queued: tagsQueued(db), last };
}

export function chunkSeqs(db: Db, sid: string): number[] {
  return db.all("SELECT seq FROM chunks WHERE session_id = ? ORDER BY seq", [sid]).map((r) => num(r.seq));
}

export type { Row };

// ---------------------------------------------------------------------------------- webhooks: segment hits, spikes

/** Record that a session entered a segment; true the first time (segment.session is sent once). */
export function segmentHit(db: Db, segmentId: string, sessionId: string, now: number): boolean {
  if (db.all("SELECT 1 FROM segment_hits WHERE segment_id = ? AND session_id = ?", [segmentId, sessionId]).length) return false;
  db.run("INSERT INTO segment_hits (segment_id, session_id, at) VALUES (?, ?, ?)", [segmentId, sessionId, now]);
  return true;
}

export const SPIKE = { MIN_SESSIONS: 5, FACTOR: 3, QUIET_MS: 6 * 3_600_000 } as const;
const SPIKE_COLUMNS = {
  rage_click: "rage_clicks",
  dead_click: "dead_interactive",
  error_click: "error_clicks",
  js_error: "errors",
  api_error: "api_errors",
  quick_back: "quick_backs",
} as const;

/**
 * Signals whose sessions in the last hour reach SPIKE.MIN_SESSIONS and SPIKE.FACTOR times the
 * hourly average of the 7 days before (signal.spike). Each signal alerts at most once per
 * SPIKE.QUIET_MS (remembered in meta). Two indexed range scans over sessions.
 */
export function signalSpikes(db: Db, now: number): { signal: string; sessions_last_hour: number; baseline_per_hour: number }[] {
  const H = 3_600_000;
  const cols = Object.entries(SPIKE_COLUMNS);
  const sum = (from: number, to: number) =>
    db.all(
      `SELECT ${cols.map(([k, c]) => `COALESCE(SUM(${c} > 0), 0) AS ${k}`).join(", ")} FROM sessions WHERE started_at >= ? AND started_at < ?`,
      [from, to],
    )[0];
  const last = sum(now - H, now + 1);
  const out: { signal: string; sessions_last_hour: number; baseline_per_hour: number }[] = [];
  if (!cols.some(([k]) => num(last?.[k]) >= SPIKE.MIN_SESSIONS)) return out;
  const base = sum(now - 8 * 24 * H, now - H);
  for (const [k] of cols) {
    const n = num(last?.[k]);
    const avg = num(base?.[k]) / (7 * 24);
    if (n < SPIKE.MIN_SESSIONS || n < SPIKE.FACTOR * avg) continue;
    const key = `spike:${k}`;
    const lastAlert = num(db.all("SELECT value FROM meta WHERE key = ?", [key])[0]?.value);
    if (lastAlert && now - lastAlert < SPIKE.QUIET_MS) continue;
    db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(now)]);
    out.push({ signal: k, sessions_last_hour: n, baseline_per_hour: Math.round(avg * 100) / 100 });
  }
  return out;
}

// ---------------------------------------------------------------------------------- starred playback copies

/**
 * Chunks of starred sessions are copied to `starred/<site_id>/<session_id>/<seq>` (outside the
 * `rsite_` prefix an R2 lifecycle rule may expire), so a starred session keeps its playback for
 * MAX_STARRED_RETENTION_DAYS. The copy is deleted when the session is unstarred or deleted.
 */
export const STARRED_PREFIX = "starred/";
export const starredKey = (prefix: string, sid: string, seq: number) => `${STARRED_PREFIX}${prefix}${chunkKey(sid, seq)}`;

/** Chunks of starred sessions not copied yet (oldest sessions first). */
export function starredCopyDue(db: Db, limit = 100): { session_id: string; seq: number; bytes: number }[] {
  return db
    .all(
      `SELECT session_id, seq, bytes FROM chunks WHERE session_id IN (SELECT id FROM sessions WHERE starred = 1) AND kept IS NULL AND rr_events > 0
       ORDER BY session_id, seq LIMIT ?`,
      [limit],
    )
    .map((r) => ({ session_id: String(r.session_id), seq: num(r.seq), bytes: num(r.bytes) }));
}

/** After a copy: kept 1 (copied, its bytes counted today) or 0 (the original was already gone). */
export function markKept(db: Db, sid: string, seq: number, kept: 0 | 1, bytes: number, now: number): void {
  db.transaction(() => {
    db.run("UPDATE chunks SET kept = ? WHERE session_id = ? AND seq = ?", [kept, sid, seq]);
    if (kept && bytes)
      db.run("INSERT INTO daily (day, bytes) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET bytes = bytes + excluded.bytes", [
        utcDay(now),
        bytes,
      ]);
  });
}

/** Unstarred: the copies are queued for deletion and forgotten. */
export function dropKept(db: Db, sid: string, prefix: string | undefined, now: number): number {
  const n = num(db.all("SELECT COUNT(*) AS n FROM chunks WHERE session_id = ? AND kept = 1", [sid])[0]?.n);
  db.transaction(() => {
    if (prefix !== undefined && n)
      db.run(
        `INSERT OR IGNORE INTO r2_pending (key, not_before) SELECT ? || ? || session_id || '/' || printf('%06d', seq), ? FROM chunks WHERE session_id = ? AND kept = 1`,
        [STARRED_PREFIX, prefix, now, sid],
      );
    db.run("UPDATE chunks SET kept = NULL WHERE session_id = ? AND kept IS NOT NULL", [sid]);
  });
  return n;
}

/** Bytes the site keeps in starred copies (and would with this session). */
export const starredBytes = (db: Db): number => num(db.all("SELECT COALESCE(SUM(bytes), 0) AS n FROM chunks WHERE kept = 1")[0]?.n);
