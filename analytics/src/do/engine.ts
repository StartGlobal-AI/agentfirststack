/**
 * The per-site engine: schema + migrations, ingest + sessionisation, and the query engine.
 * Storage-agnostic (a tiny `Db` interface) so SiteDO runs it over ctx.storage.sql and tests run it
 * over node:sqlite. Payments, annotations, visitors/journeys and insights live in sibling modules.
 */

import { randomString } from "@afs/shared";
import { hostAllowed } from "../lib/url";
import { type CompiledExclusions, compileExclusions, excludedBy } from "../lib/exclusions";
import { type Breakdown, type Metric, SESSION_METRICS, SORTABLE_METRICS, VISITOR_TYPE_METRICS, VITALS_METRICS } from "../lib/filters";
import {
  type GroupOpts,
  type GroupSpec,
  KEY_SEP,
  type QueryCtx,
  type SqlValue,
  aggregateQuery,
  bucketKey,
  funnelQuery,
  goalBreakdownQuery,
  groupSpecFor,
  groupedQuery,
  toGlob,
} from "../lib/query";
import { changePercent } from "../lib/stats-math";
import { type ComparisonRange, buckets, comparisonRange, offsetSegments } from "../lib/time";
import { guardSql } from "../lib/sqlguard";
import type {
  Attribution,
  EnrichedEvent,
  FunnelRequest,
  IngestOutcome,
  IngestResponse,
  SiteSettings,
  SortSpec,
  StatsRequest,
  TimeseriesRequest,
} from "../lib/types";
import { annotationsIn } from "./annotations";
import {
  DAY,
  type Db,
  type Row,
  all,
  checkGoalFilters,
  ctxFor,
  err,
  guard,
  identityNote,
  num,
  periodOut,
  rangeFor,
  round,
  unknownGoals,
  utcDay,
} from "./common";

export type { Db, Row, SqlCursor } from "./common";

export const SESSION_TIMEOUT_MS = 30 * 60_000;

// ------------------------------------------------------------------ schema

/**
 * Schema version 1 (the first release) is created by SCHEMA_V1 and never edited; later versions are
 * MIGRATIONS run in order, each in a transaction that also bumps meta.schema_version, so a DO
 * created by any earlier release catches up the first time it is instantiated. Steps are
 * idempotent on their own too (columns are added only when missing), in case one half-applied.
 */
export const SCHEMA_VERSION = 2;

export const ATTR_COLS = [
  "referrer",
  "referrer_host",
  "source",
  "channel",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "click_id_type",
  "click_id",
] as const;
export const GEO_COLS = [
  "country",
  "region",
  "region_code",
  "city",
  "continent",
  "timezone",
  "latitude",
  "longitude",
  "asn",
  "as_org",
] as const;
export const DEVICE_COLS = ["browser", "browser_version", "os", "os_version", "device"] as const;

/** Exported for the migration test, which builds a DO exactly as the first release left it. */
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT,
  origin TEXT NOT NULL,
  hostname TEXT, pathname TEXT, url TEXT,
  referrer TEXT, referrer_host TEXT, source TEXT, channel TEXT NOT NULL DEFAULT 'Direct',
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  click_id_type TEXT, click_id TEXT,
  country TEXT, region TEXT, region_code TEXT, city TEXT, continent TEXT, timezone TEXT,
  latitude REAL, longitude REAL, asn INTEGER, as_org TEXT,
  browser TEXT, browser_version TEXT, os TEXT, os_version TEXT, device TEXT,
  props TEXT, revenue REAL, currency TEXT,
  engagement_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_visitor ON events(visitor_id, ts);
CREATE INDEX IF NOT EXISTS events_name_ts ON events(name, ts);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  user_id TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  hostname TEXT, entry_page TEXT, exit_page TEXT,
  pageviews INTEGER NOT NULL DEFAULT 0,
  last_pageview_at INTEGER,
  custom_events INTEGER NOT NULL DEFAULT 0,
  engagement_ms INTEGER NOT NULL DEFAULT 0,
  referrer TEXT, referrer_host TEXT, source TEXT, channel TEXT NOT NULL DEFAULT 'Direct',
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  click_id_type TEXT, click_id TEXT,
  country TEXT, region TEXT, region_code TEXT, city TEXT, continent TEXT, timezone TEXT,
  latitude REAL, longitude REAL, asn INTEGER, as_org TEXT,
  browser TEXT, browser_version TEXT, os TEXT, os_version TEXT, device TEXT
);
CREATE INDEX IF NOT EXISTS sessions_visitor ON sessions(visitor_id, last_seen_at);
CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_at);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, match TEXT NOT NULL,
  glob TEXT, value REAL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drops (
  day TEXT NOT NULL, reason TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER, sample TEXT, PRIMARY KEY (day, reason)
);
`;

const statements = (s: string) =>
  s
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);

/** Does `table` have `column`? Read from sqlite_master (ALTER TABLE ADD COLUMN updates it). */
export function hasColumn(db: Db, table: string, column: string): boolean {
  const row = db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])[0];
  return !!row?.sql && new RegExp(`[(,]\\s*"?${column}"?\\s`, "i").test(String(row.sql));
}

function addColumn(db: Db, table: string, column: string, decl: string): void {
  if (!hasColumn(db, table, column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

const MIGRATIONS: { version: number; up: (db: Db) => void }[] = [
  {
    // Batch 1: revenue attribution, scroll depth + Web Vitals, scroll goals, annotations, payments.
    version: 2,
    up: (db) => {
      addColumn(db, "events", "revenue_type", "TEXT");
      addColumn(db, "events", "scroll_depth", "INTEGER");
      addColumn(db, "events", "lcp", "REAL");
      addColumn(db, "events", "inp", "REAL");
      addColumn(db, "events", "cls", "REAL");
      addColumn(db, "goals", "threshold", "INTEGER");
      for (const s of statements(`
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, last_seen_at);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, ts INTEGER NOT NULL, end_ts INTEGER,
  title TEXT NOT NULL, description TEXT, source TEXT NOT NULL, details TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS annotations_ts ON annotations(ts);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, external_id TEXT NOT NULL,
  type TEXT NOT NULL, amount REAL NOT NULL, currency TEXT, ts INTEGER NOT NULL, customer TEXT,
  event_rowid INTEGER, linked_by TEXT, livemode INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_ts ON payments(ts);
CREATE INDEX IF NOT EXISTS payments_customer ON payments(customer, ts);
CREATE TABLE IF NOT EXISTS payment_links (
  customer TEXT PRIMARY KEY, session_id TEXT, visitor_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)
`))
        db.run(s);
    },
  },
];

/** Columns and their meaning, for llms.txt / the query_sql tool description. */
export const SCHEMA_DOC = `events(id, ts unix ms, name ['pageview', 'engagement' never stored, custom names, and from payments 'payment' | 'renewal' | 'refund'], visitor_id, session_id, user_id, origin [browser|server|payment],
  hostname, pathname, url, referrer, referrer_host, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
  click_id_type, click_id, country, region, region_code, city, continent, timezone, latitude, longitude, asn, as_org,
  browser, browser_version, os, os_version, device, props [JSON text], revenue [refunds negative], currency,
  revenue_type [new|renewal|refund|NULL], engagement_ms, scroll_depth [0-100, pageviews], lcp [ms], inp [ms], cls)
sessions(id, visitor_id, user_id, started_at, last_seen_at, hostname, entry_page, exit_page, pageviews, custom_events,
  engagement_ms, + the same attribution, geo and device columns as events)
goals(id, name, type [event|pageview|scroll], match, glob, value, threshold, created_at)
payments(id, ref [provider:external_id], provider, external_id, type [new|renewal|refund], amount, currency, ts, customer [salted hash],
  event_rowid [events.id], linked_by [session|visitor|user|customer|original_payment|NULL], livemode, created_at, updated_at)
annotations(id, kind [note|traffic_spike], ts, end_ts, title, description, source [api|auto], details [JSON], created_at, updated_at)`;

export function migrate(db: Db): void {
  for (const stmt of statements(SCHEMA_V1)) db.run(stmt);
  // Version 1 is what SCHEMA_V1 creates; a brand-new DO then runs every migration like an old one.
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')");
  let version = Number(db.all("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value ?? 1) || 1;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.transaction(() => {
      m.up(db);
      db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(m.version)]);
    });
    version = m.version;
  }
}

export function schemaVersion(db: Db): number {
  return Number(db.all("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value ?? 0);
}

// ------------------------------------------------------------------ settings

export function getSettings(db: Db): SiteSettings | null {
  const row = db.all("SELECT value FROM meta WHERE key = 'settings'")[0];
  return row?.value ? (JSON.parse(String(row.value)) as SiteSettings) : null;
}

export function configure(db: Db, settings: SiteSettings): void {
  db.transaction(() => {
    db.run("INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      JSON.stringify(settings),
    ]);
    db.run("DELETE FROM goals");
    for (const g of settings.goals) {
      db.run("INSERT INTO goals (id, name, type, match, glob, value, threshold, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        g.id,
        g.name,
        g.type,
        g.match,
        g.type === "pageview" || g.type === "scroll" ? toGlob(g.match) : null,
        g.value,
        g.type === "scroll" ? (g.threshold ?? 75) : null,
        g.created_at,
      ]);
    }
  });
}

// ------------------------------------------------------------------ ingest

export function recordDrop(db: Db, reason: string, sample: string | null, now = Date.now()): void {
  db.run(
    `INSERT INTO drops (day, reason, count, last_at, sample) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(day, reason) DO UPDATE SET count = count + 1, last_at = excluded.last_at, sample = COALESCE(excluded.sample, sample)`,
    [utcDay(now), reason, now, sample?.slice(0, 300) ?? null],
  );
}

type SessionRow = Row & {
  id: string;
  started_at: number;
  last_seen_at: number;
  channel: string;
  country: string | null;
  browser: string | null;
  device: string | null;
  user_id: string | null;
  entry_page: string | null;
};

export function pick<K extends string>(src: Record<string, unknown>, cols: readonly K[]): Record<K, SqlValue> {
  const out = {} as Record<K, SqlValue>;
  for (const c of cols) out[c] = (src[c] ?? null) as SqlValue;
  return out;
}

function findSession(db: Db, visitorId: string, ts: number): SessionRow | null {
  const r = db.all(
    `SELECT * FROM sessions WHERE visitor_id = ? AND last_seen_at >= ? AND started_at <= ?
     ORDER BY last_seen_at DESC LIMIT 1`,
    [visitorId, ts - SESSION_TIMEOUT_MS, ts + SESSION_TIMEOUT_MS],
  )[0];
  return (r as SessionRow | undefined) ?? null;
}

// Exclusion rules are compiled once per settings change, not per event.
let compiledFor: string | null = null;
let compiled: CompiledExclusions | null = null;
function exclusionsOf(settings: SiteSettings): CompiledExclusions | null {
  const key = JSON.stringify(settings.exclusions ?? null);
  if (key !== compiledFor) {
    compiled = compileExclusions(settings.exclusions ?? null);
    compiledFor = key;
  }
  return compiled;
}

export function ingest(db: Db, events: EnrichedEvent[], now = Date.now()): IngestResponse {
  const settings = getSettings(db);
  if (!settings) return { known_site: false, persistent: false, results: events.map(() => ({ ok: false, reason: "unknown_site" })) };
  const persistent = settings.visitor_id_mode === "persistent";
  const results: IngestOutcome[] = [];
  db.transaction(() => {
    for (const ev of events) results.push(ingestOne(db, settings, ev, now));
  });
  return { known_site: true, persistent, results };
}

/** Prefix of `drops` rows that count a problem with an event that was kept, not a dropped one. */
export const WARN_PREFIX = "warn:";

function ingestOne(db: Db, settings: SiteSettings, ev: EnrichedEvent, now: number): IngestOutcome {
  if (ev.origin === "browser" && ev.proxy_warning) recordDrop(db, WARN_PREFIX + ev.proxy_warning, ev.hostname, now);
  if (ev.origin === "browser" && !hostAllowed(ev.hostname, settings.allowed_hostnames)) {
    recordDrop(db, "hostname_not_allowed", ev.hostname, now);
    return { ok: false, reason: "hostname_not_allowed" };
  }
  if (ev.origin === "browser" && settings.respect_dnt && ev.dnt) {
    recordDrop(db, "dnt", null, now);
    return { ok: false, reason: "dnt" };
  }
  // Exclusions: the IP is compared here, in memory, and dropped with the event; the drop's sample
  // is the rule that matched. Engagement beacons of an excluded page are refused without a second count.
  const ex = excludedBy(exclusionsOf(settings), {
    ip: ev.ip,
    hostname: ev.hostname,
    pathname: ev.url || ev.origin === "browser" ? ev.pathname : null,
    country: ev.country,
  });
  if (ex) {
    if (ev.name !== "engagement") recordDrop(db, ex.reason, ex.rule, now);
    return { ok: false, reason: ex.reason };
  }
  const visitorId =
    ev.explicit_visitor_id ?? (settings.visitor_id_mode === "persistent" && ev.client_visitor_id ? ev.client_visitor_id : ev.visitor_hash);

  if (ev.name === "engagement") return engagement(db, visitorId, ev);

  const isPageview = ev.name === "pageview";
  let sess = findSession(db, visitorId, ev.ts);
  const evAttr = pick(ev as unknown as Record<string, unknown>, ATTR_COLS);
  let attr: Record<string, SqlValue>;
  let geo = pick(ev as unknown as Record<string, unknown>, GEO_COLS);
  let device = pick(ev as unknown as Record<string, unknown>, DEVICE_COLS);
  let userId = ev.user_id;

  if (!sess) {
    const id = `s${randomString(15)}`;
    attr = evAttr;
    db.run(
      `INSERT INTO sessions (id, visitor_id, user_id, started_at, last_seen_at, hostname, entry_page, exit_page,
         ${ATTR_COLS.join(", ")}, ${GEO_COLS.join(", ")}, ${DEVICE_COLS.join(", ")})
       VALUES (${Array(8 + ATTR_COLS.length + GEO_COLS.length + DEVICE_COLS.length)
         .fill("?")
         .join(", ")})`,
      [
        id,
        visitorId,
        userId,
        ev.ts,
        ev.ts,
        ev.hostname,
        isPageview ? ev.pathname : null,
        isPageview ? ev.pathname : null,
        ...ATTR_COLS.map((c) => evAttr[c]),
        ...GEO_COLS.map((c) => geo[c]),
        ...DEVICE_COLS.map((c) => device[c]),
      ],
    );
    sess = {
      id,
      started_at: ev.ts,
      last_seen_at: ev.ts,
      channel: String(evAttr.channel),
      country: null,
      browser: null,
      device: null,
      user_id: userId,
      entry_page: null,
    } as SessionRow;
  } else {
    // Session-level attribution: the session keeps its first source, except that a Direct session
    // picks up the first real source it sees (e.g. a server event opened it, then the pageview with
    // UTM tags arrived). Earlier events of the session are re-attributed with it.
    attr = pick(sess, ATTR_COLS);
    const sets: string[] = [];
    const args: SqlValue[] = [];
    if (sess.channel === "Direct" && evAttr.channel !== "Direct") {
      attr = evAttr;
      for (const c of ATTR_COLS) {
        sets.push(`${c} = ?`);
        args.push(evAttr[c]);
      }
      db.run(`UPDATE events SET ${ATTR_COLS.map((c) => `${c} = ?`).join(", ")} WHERE session_id = ?`, [
        ...ATTR_COLS.map((c) => evAttr[c]),
        sess.id,
      ]);
    }
    // Geo and device: an event without them (typical server event) inherits the session's; a
    // session without them (opened by a server event) learns them from the first event that has.
    if (geo.country == null && sess.country != null) geo = pick(sess, GEO_COLS);
    else if (sess.country == null && geo.country != null) {
      for (const c of GEO_COLS) {
        sets.push(`${c} = ?`);
        args.push(geo[c]);
      }
      db.run(`UPDATE events SET ${GEO_COLS.map((c) => `${c} = ?`).join(", ")} WHERE session_id = ? AND country IS NULL`, [
        ...GEO_COLS.map((c) => geo[c]),
        sess.id,
      ]);
    }
    if (device.browser == null && device.device == null && (sess.browser != null || sess.device != null)) device = pick(sess, DEVICE_COLS);
    else if (sess.browser == null && sess.device == null && (device.browser != null || device.device != null)) {
      for (const c of DEVICE_COLS) {
        sets.push(`${c} = ?`);
        args.push(device[c]);
      }
    }
    if (userId && !sess.user_id) {
      sets.push("user_id = ?");
      args.push(userId);
    } else if (!userId && sess.user_id) userId = sess.user_id;
    if (isPageview && (!sess.entry_page || ev.ts < Number(sess.started_at))) {
      sets.push("entry_page = ?");
      args.push(ev.pathname);
    }
    if (sets.length) db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, [...args, sess.id]);
  }

  db.run(
    `INSERT INTO events (ts, name, visitor_id, session_id, user_id, origin, hostname, pathname, url,
       ${ATTR_COLS.join(", ")}, ${GEO_COLS.join(", ")}, ${DEVICE_COLS.join(", ")}, props, revenue, currency, engagement_ms)
     VALUES (${Array(9 + ATTR_COLS.length + GEO_COLS.length + DEVICE_COLS.length + 4)
       .fill("?")
       .join(", ")})`,
    [
      ev.ts,
      ev.name,
      visitorId,
      sess.id,
      userId,
      ev.origin,
      ev.hostname,
      ev.pathname,
      ev.url,
      ...ATTR_COLS.map((c) => attr[c] ?? null),
      ...GEO_COLS.map((c) => geo[c]),
      ...DEVICE_COLS.map((c) => device[c]),
      ev.props,
      ev.revenue,
      ev.currency,
      ev.engagement_ms || 0,
    ],
  );
  db.run(
    `UPDATE sessions SET
       pageviews = pageviews + ?, custom_events = custom_events + ?,
       exit_page = CASE WHEN ? = 1 AND ? >= COALESCE(last_pageview_at, 0) THEN ? ELSE exit_page END,
       last_pageview_at = CASE WHEN ? = 1 THEN MAX(COALESCE(last_pageview_at, 0), ?) ELSE last_pageview_at END,
       last_seen_at = MAX(last_seen_at, ?), started_at = MIN(started_at, ?)
     WHERE id = ?`,
    [isPageview ? 1 : 0, isPageview ? 0 : 1, isPageview ? 1 : 0, ev.ts, ev.pathname, isPageview ? 1 : 0, ev.ts, ev.ts, ev.ts, sess.id],
  );
  return { ok: true, visitor_id: visitorId, session_id: sess.id };
}

/**
 * Engagement beacon: adds visible time to the latest pageview of that page (and its session),
 * raises the page's max scroll depth and stores the page load's Web Vitals (latest values win:
 * the tracker sends running maxima).
 */
function engagement(db: Db, visitorId: string, ev: EnrichedEvent): IngestOutcome {
  const ms = Math.max(0, Math.min(ev.engagement_ms || 0, 4 * 3_600_000));
  const pv = db.all(
    `SELECT id, session_id FROM events WHERE visitor_id = ? AND name = 'pageview' AND pathname = ? AND ts <= ? AND ts >= ?
     ORDER BY ts DESC LIMIT 1`,
    [visitorId, ev.pathname, ev.ts, ev.ts - DAY],
  )[0];
  if (!pv) return { ok: false, reason: "no_pageview_for_engagement" };
  const sd = ev.scroll_depth ?? null;
  db.run(
    `UPDATE events SET engagement_ms = engagement_ms + ?,
       scroll_depth = CASE WHEN ? IS NULL THEN scroll_depth ELSE MAX(COALESCE(scroll_depth, 0), ?) END,
       lcp = COALESCE(?, lcp), inp = COALESCE(?, inp), cls = COALESCE(?, cls)
     WHERE id = ?`,
    [ms, sd, sd, ev.lcp ?? null, ev.inp ?? null, ev.cls ?? null, pv.id ?? null],
  );
  db.run("UPDATE sessions SET engagement_ms = engagement_ms + ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?", [
    ms,
    ev.ts,
    pv.session_id ?? null,
  ]);
  return { ok: true, visitor_id: visitorId, session_id: String(pv.session_id) };
}

// ------------------------------------------------------------------ metrics

export type MetricValues = Record<string, number | null>;

const nullable = (v: SqlValue | undefined, d: number) => (v == null ? null : round(Number(v), d));

export function shapeMetrics(row: Row | undefined, metrics: Metric[]): MetricValues {
  const r = row ?? {};
  const visitors = num(r.visitors);
  const visits = num(r.visits);
  const pageviews = num(r.pageviews);
  const revenue = num(r.revenue);
  const renewal = num(r.renewal_revenue);
  const refund = num(r.refund_revenue); // negative
  const customers = num(r.customers);
  const returning = Math.min(num(r.returning_visitors), visitors);
  const m: Record<Metric, number | null> = {
    visitors,
    visits,
    pageviews,
    views_per_visit: visits ? round(pageviews / visits, 2) : 0,
    bounce_rate: round(num(r.bounce_rate), 1),
    visit_duration: Math.round(num(r.visit_duration)),
    events: num(r.events),
    conversions: num(r.conversions),
    conversion_rate: visitors ? round((num(r.converted_visitors) / visitors) * 100, 1) : 0,
    revenue: round(revenue, 2),
    revenue_per_visitor: visitors ? round(revenue / visitors, 2) : 0,
    new_revenue: round(revenue - renewal - refund, 2),
    renewal_revenue: round(renewal, 2),
    refunds: round(-refund, 2),
    purchases: num(r.purchases),
    customers,
    purchase_rate: visitors ? round((customers / visitors) * 100, 1) : 0,
    new_visitors: visitors - returning,
    returning_visitors: returning,
    scroll_depth: nullable(r.scroll_depth, 1),
    time_on_page: nullable(r.time_on_page, 1),
    lcp_p75: nullable(r.lcp_p75, 0),
    inp_p75: nullable(r.inp_p75, 0),
    cls_p75: nullable(r.cls_p75, 3),
  };
  const out: MetricValues = {};
  for (const k of metrics) out[k] = m[k];
  return out;
}

export function changes(cur: MetricValues, prev: MetricValues, metrics: Metric[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of metrics) {
    const a = cur[m];
    const b = prev[m];
    out[m] = a == null || b == null ? null : changePercent(a, b);
  }
  return out;
}

export function optsFor(metrics: Metric[]): GroupOpts {
  return {
    sessions: metrics.some((m) => SESSION_METRICS.includes(m)),
    visitorTypes: metrics.some((m) => VISITOR_TYPE_METRICS.includes(m)),
    vitals: metrics.some((m) => VITALS_METRICS.includes(m)),
  };
}

export function totals(db: Db, ctx: QueryCtx, metrics: Metric[]): MetricValues {
  const o = optsFor(metrics);
  return shapeMetrics(all(db, aggregateQuery(ctx, !!o.sessions, o))[0], metrics);
}

const comparisonOut = (p: ComparisonRange) => ({ ...periodOut(p), partial: p.partial, mode: p.mode, match_weekday: p.match_weekday });

function notes(db: Db, settings: SiteSettings, metrics: Metric[]): string[] {
  const out: string[] = [];
  if ((metrics.includes("conversions") || metrics.includes("conversion_rate")) && !num(db.all("SELECT COUNT(*) AS n FROM goals")[0]?.n)) {
    out.push("No goals defined, so conversions are 0. Create one: POST /v1/sites/:id/goals {name, type: event|pageview|scroll, match}.");
  }
  if (metrics.some((m) => VISITOR_TYPE_METRICS.includes(m))) {
    const n = identityNote(settings);
    if (n) out.push(`returning_visitors: ${n}`);
  }
  return out;
}

// ------------------------------------------------------------------ stats, breakdowns, comparisons

export function stats(db: Db, settings: SiteSettings, q: StatsRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q.filters);
    const cur = totals(db, ctx, q.metrics);
    const out: Record<string, unknown> = { period: periodOut(r), filters: q.filters, metrics: cur };
    const p = q.compare ? comparisonRange(r, q.compare, now) : null;
    const cmpCtx = p ? { ...ctx, start: p.start, end: p.end } : null;
    if (q.compare) {
      if (p && cmpCtx) {
        const prev = totals(db, cmpCtx, q.metrics);
        out.comparison = { period: comparisonOut(p), metrics: prev, change_percent: changes(cur, prev, q.metrics) };
      } else out.comparison = null;
    }
    if (q.breakdown) {
      const metrics = q.breakdown_metrics ?? q.metrics;
      out.breakdown = {
        property: q.breakdown,
        sort: sortOut(q.sort),
        results: breakdownRows(db, ctx, q.breakdown, metrics, q.limit ?? 20, { sort: q.sort, cmp: cmpCtx }),
      };
    }
    const n = notes(db, settings, q.metrics);
    if (n.length) out.notes = n;
    return out;
  });
}

const sortOut = (s: SortSpec | undefined) => (s ? (s.by === "change" ? `change:${s.metric}` : s.metric) : "visitors");

type BreakdownRow = Record<string, unknown> & { value: SqlValue };

function compositeKey(row: Row | BreakdownRow, spec: GroupSpec): string {
  return [row.value, ...(spec.extra ?? []).map((x) => row[x.name])].map((v) => String(v ?? "")).join(KEY_SEP);
}

function shapeRow(r: Row, spec: GroupSpec, metrics: Metric[]): BreakdownRow {
  return {
    value: r.value ?? null,
    ...(spec.extra ? Object.fromEntries(spec.extra.map((x) => [x.name, r[x.name]])) : {}),
    ...shapeMetrics(r, metrics),
  };
}

interface RowOpts {
  sort?: SortSpec;
  /** comparison period: rows get comparison {metrics, change_percent} */
  cmp?: QueryCtx | null;
}

const GOAL_ROW_METRICS = ["visitors", "conversions", "conversion_rate", "revenue"] as const;

function goalRows(db: Db, ctx: QueryCtx, limit: number) {
  return all(db, goalBreakdownQuery(ctx, limit)).map((r) => {
    const visitors = num(r.visitors);
    const total = num(r.total_visitors);
    return {
      value: r.value,
      goal_type: r.goal_type,
      goal_match: r.goal_match,
      visitors,
      conversions: num(r.conversions),
      conversion_rate: total ? round((visitors / total) * 100, 1) : 0,
      revenue: round(num(r.revenue), 2),
    } as BreakdownRow & Record<(typeof GOAL_ROW_METRICS)[number], number>;
  });
}

export function breakdownRows(db: Db, ctx: QueryCtx, dim: Breakdown, metrics: Metric[], limit: number, o: RowOpts = {}): BreakdownRow[] {
  if (dim === "goal") {
    let rows = goalRows(db, ctx, 1000);
    const sm = o.sort?.metric;
    if (o.cmp) {
      const prev = new Map(goalRows(db, o.cmp, 1000).map((r) => [String(r.value), r]));
      rows = rows.map((r) => {
        const p = prev.get(String(r.value));
        const pm = Object.fromEntries(GOAL_ROW_METRICS.map((k) => [k, p ? p[k] : 0]));
        const cm = Object.fromEntries(GOAL_ROW_METRICS.map((k) => [k, r[k]]));
        return { ...r, comparison: { metrics: pm, change_percent: changes(cm, pm, [...GOAL_ROW_METRICS] as Metric[]) } };
      });
    }
    if (sm && (GOAL_ROW_METRICS as readonly string[]).includes(sm)) {
      const key = sm as (typeof GOAL_ROW_METRICS)[number];
      const delta = (r: (typeof rows)[number]) =>
        o.sort?.by === "change"
          ? Math.abs(Number(r[key]) - Number((r.comparison as { metrics: Record<string, number> } | undefined)?.metrics[key] ?? 0))
          : Number(r[key]);
      rows = [...rows].sort((a, b) => delta(b) - delta(a) || String(a.value).localeCompare(String(b.value)));
    }
    return rows.slice(0, limit);
  }
  const spec: GroupSpec = { ...groupSpecFor(dim), limit };
  if (o.sort?.by === "change" && o.cmp) return changeRanked(db, ctx, o.cmp, spec, metrics, o.sort.metric).rows.slice(0, limit);
  if (o.sort?.by === "metric") spec.sortBy = o.sort.metric;
  const opts = optsFor(metrics);
  const rows = all(db, groupedQuery(ctx, spec, opts)).map((r) => shapeRow(r, spec, metrics));
  if (!o.cmp || !rows.length) return rows;
  const keys = rows.map((r) => compositeKey(r, spec));
  const prev = new Map(
    all(db, groupedQuery(o.cmp, { ...spec, limit: undefined, sortBy: undefined, only: keys }, opts)).map((r) => [compositeKey(r, spec), r]),
  );
  return rows.map((r) => {
    const pm = shapeMetrics(prev.get(compositeKey(r, spec)), metrics);
    return { ...r, comparison: { metrics: pm, change_percent: changes(r as unknown as MetricValues, pm, metrics) } };
  });
}

/** Candidates = the top values of either period by the metric; ranked by absolute change. */
export const MOVER_CANDIDATES = 50;

function changeRanked(db: Db, ctx: QueryCtx, cmp: QueryCtx, base: GroupSpec, metrics: Metric[], metric: Metric) {
  const all_ = [...new Set<Metric>([metric, ...metrics])];
  const opts = optsFor(all_);
  const sortBy = SORTABLE_METRICS.includes(metric) ? metric : "visitors";
  const k = Math.max(base.limit ?? 20, MOVER_CANDIDATES);
  const candidates = new Set<string>();
  for (const c of [ctx, cmp])
    for (const r of all(db, groupedQuery(c, { ...base, limit: k, sortBy }, {}))) candidates.add(compositeKey(r, base));
  if (!candidates.size) return { rows: [] as BreakdownRow[], candidates: 0 };
  const only = [...candidates];
  const cur = new Map(
    all(db, groupedQuery(ctx, { ...base, limit: undefined, sortBy: undefined, only }, opts)).map((r) => [compositeKey(r, base), r]),
  );
  const prev = new Map(
    all(db, groupedQuery(cmp, { ...base, limit: undefined, sortBy: undefined, only }, opts)).map((r) => [compositeKey(r, base), r]),
  );
  const rows = only.map((key) => {
    const c = cur.get(key);
    const p = prev.get(key);
    const shaped = shapeRow((c ?? p)!, base, all_);
    const cm = shapeMetrics(c, all_);
    const pm = shapeMetrics(p, all_);
    const delta = Number(cm[metric] ?? 0) - Number(pm[metric] ?? 0);
    const out: BreakdownRow = {
      ...shaped,
      ...pick(cm as Record<string, unknown>, metrics),
      comparison: { metrics: pick(pm as Record<string, unknown>, metrics), change_percent: changes(cm, pm, metrics) },
    };
    return { row: out, delta, key };
  });
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));
  return { rows: rows.map((x) => ({ ...x.row, change: round(x.delta, 3) })), deltas: rows, candidates: candidates.size };
}

export function breakdown(db: Db, settings: SiteSettings, q: StatsRequest & { breakdown: Breakdown }, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q.filters);
    const p = q.compare ? comparisonRange(r, q.compare, now) : null;
    const out: Record<string, unknown> = {
      period: periodOut(r),
      ...(q.compare ? { comparison: p ? { period: comparisonOut(p) } : null } : {}),
      filters: q.filters,
      property: q.breakdown,
      sort: sortOut(q.sort),
      results: breakdownRows(db, ctx, q.breakdown, q.metrics, q.limit ?? 20, {
        sort: q.sort,
        cmp: p ? { ...ctx, start: p.start, end: p.end } : null,
      }),
    };
    const n = notes(db, settings, q.metrics);
    if (n.length) out.notes = n;
    return out;
  });
}

export interface MoversRequest extends StatsRequest {
  breakdown: Breakdown;
  metric: Metric;
}

/** The values of a property whose metric rose or fell the most against the comparison period. */
export function movers(db: Db, settings: SiteSettings, q: MoversRequest, now = Date.now()) {
  return guard(() => {
    if (q.breakdown === "goal")
      return err(
        "bad_request",
        "Top movers work on event properties, not goals.",
        "For goals use GET /v1/sites/:id/breakdown?breakdown=goal&compare=previous.",
      );
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const p = comparisonRange(r, q.compare ?? { mode: "previous" }, now);
    if (!p)
      return err(
        "bad_request",
        "period=all has nothing before it to compare with.",
        "Use a bounded period (e.g. 30d) or compare=custom with compare_from/compare_to.",
      );
    const ctx = ctxFor(db, r, q.filters);
    const spec: GroupSpec = { ...groupSpecFor(q.breakdown), limit: q.limit ?? 10 };
    const metrics = [...new Set<Metric>([q.metric, ...q.metrics])];
    const ranked = changeRanked(db, ctx, { ...ctx, start: p.start, end: p.end }, spec, metrics, q.metric);
    const limit = q.limit ?? 10;
    const rows = ranked.rows as (BreakdownRow & { change: number })[];
    return {
      period: periodOut(r),
      comparison: { period: comparisonOut(p) },
      filters: q.filters,
      property: q.breakdown,
      metric: q.metric,
      gainers: rows
        .filter((x) => x.change > 0)
        .sort((a, b) => b.change - a.change)
        .slice(0, limit),
      losers: rows
        .filter((x) => x.change < 0)
        .sort((a, b) => a.change - b.change)
        .slice(0, limit),
      note: `Movers are found among the top ${Math.max(limit, MOVER_CANDIDATES)} values of either period by ${SORTABLE_METRICS.includes(q.metric) ? q.metric : "visitors"}; change = current minus comparison.`,
    };
  });
}

export function timeseries(db: Db, settings: SiteSettings, q: TimeseriesRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const interval = q.interval ?? r.interval;
    // Buckets up to now: an in-progress period has no rows for the future.
    const bs = buckets(r, interval).filter((b, i) => i === 0 || b.start <= now);
    const ctx = ctxFor(db, r, q.filters);
    const opts = optsFor(q.metrics);
    const key = bucketKey(interval, offsetSegments(r.start, r.end, settings.timezone));
    const rows = all(db, groupedQuery(ctx, { key, orderByKey: true }, opts));
    const byLabel = new Map(rows.map((x) => [String(x.value), x]));
    let results: Record<string, unknown>[] = bs.map((b) => ({ date: b.label, ...shapeMetrics(byLabel.get(b.label), q.metrics) }));
    const out: Record<string, unknown> = { period: periodOut(r), interval, filters: q.filters };
    if (q.compare) {
      const p = comparisonRange(r, q.compare, now);
      if (p) {
        const cbs = buckets(p, interval);
        const ckey = bucketKey(interval, offsetSegments(p.start, p.end, settings.timezone));
        const crows = new Map(
          all(db, groupedQuery({ ...ctx, start: p.start, end: p.end }, { key: ckey, orderByKey: true }, opts)).map((x) => [
            String(x.value),
            x,
          ]),
        );
        // Buckets are paired by position: day 1 with day 1 of the comparison range, and so on.
        results = results.map((row, i) => {
          const cb = cbs[i];
          if (!cb || cb.start >= p.end) return { ...row, comparison: null };
          const pm = shapeMetrics(crows.get(cb.label), q.metrics);
          return { ...row, comparison: { date: cb.label, metrics: pm, change_percent: changes(row as MetricValues, pm, q.metrics) } };
        });
        out.comparison = { period: comparisonOut(p) };
      } else out.comparison = null;
    }
    out.results = results;
    out.annotations = annotationsIn(db, settings, r.start, r.end);
    const n = notes(db, settings, q.metrics);
    if (n.length) out.notes = n;
    return out;
  });
}

// ------------------------------------------------------------------ realtime, funnel, sql, summary

export function realtime(db: Db, now = Date.now()) {
  const t5 = now - 5 * 60_000;
  const t30 = now - 30 * 60_000;
  const top = (col: string, extra = "") =>
    db
      .all(
        `SELECT COALESCE(${col}, '(none)') AS value, COUNT(DISTINCT visitor_id) AS visitors FROM events
         WHERE ts >= ? AND origin != 'payment' ${extra} GROUP BY value ORDER BY visitors DESC, value LIMIT 10`,
        [t30],
      )
      .map((r) => ({ value: r.value, visitors: num(r.visitors) }));
  const head = db.all(
    `SELECT COUNT(DISTINCT CASE WHEN ts >= ? AND origin != 'payment' THEN visitor_id END) AS v5,
            COUNT(DISTINCT CASE WHEN origin != 'payment' THEN visitor_id END) AS v30,
            COALESCE(SUM(name = 'pageview'), 0) AS pv30, COUNT(*) AS ev30
     FROM events WHERE ts >= ?`,
    [t5, t30],
  )[0];
  const recent = db.all(
    `SELECT ts, name, origin, hostname, pathname, channel, source, country, region, city, device, browser, os,
            visitor_id, session_id, user_id, props, revenue, currency
     FROM events ORDER BY ts DESC, id DESC LIMIT 50`,
  );
  return {
    visitors_last_5m: num(head?.v5),
    visitors_last_30m: num(head?.v30),
    pageviews_last_30m: num(head?.pv30),
    events_last_30m: num(head?.ev30),
    top_pages_last_30m: top("pathname", "AND name = 'pageview'"),
    top_countries_last_30m: top("country"),
    top_sources_last_30m: top("source"),
    recent_events: recent.map((r) => ({
      ...r,
      time: new Date(Number(r.ts)).toISOString(),
      props: r.props ? JSON.parse(String(r.props)) : null,
    })),
  };
}

export function funnel(db: Db, settings: SiteSettings, q: FunnelRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const goalSteps = q.steps.filter((s) => s.type === "goal").map((s) => (s as { name: string }).name);
    const gs = unknownGoals(db, goalSteps, "goal(s) in steps");
    if (gs) return gs;
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q.filters);
    const rows = all(db, funnelQuery(ctx, q.steps));
    const first = num(rows[0]?.visitors);
    let prev = first;
    const steps = q.steps.map((s, i) => {
      const row = rows.find((x) => num(x.step) === i + 1);
      const visitors = num(row?.visitors);
      const out = {
        step: i + 1,
        label: s.type === "page" ? s.pattern : `${s.type}:${s.name}`,
        visitors,
        sessions: num(row?.sessions),
        conversion_rate: first ? round((visitors / first) * 100, 1) : 0,
        dropoff: i === 0 ? 0 : prev - visitors,
        dropoff_rate: i === 0 || !prev ? 0 : round(((prev - visitors) / prev) * 100, 1),
      };
      prev = visitors;
      return out;
    });
    return {
      period: periodOut(r),
      filters: q.filters,
      steps,
      overall_conversion_rate: steps.length ? steps[steps.length - 1]!.conversion_rate : 0,
      note: "Steps must happen in order within one session (30 minutes of inactivity ends a session). Counts are unique visitors.",
    };
  });
}

export const MAX_SQL_ROWS = 1000;
/** Default for SQL_MAX_ROWS_READ: rows SQLite may read while streaming results after the first row. */
export const DEFAULT_SQL_MAX_ROWS_READ = 1_000_000;

class SqlBudgetError extends Error {}

/**
 * Run user SQL. The row cap is enforced here for every driver: the cursor is stepped at most
 * MAX_SQL_ROWS + 1 times. Each time a row comes back the cursor's rowsRead counter is checked, so
 * a query that keeps scanning to produce its rows (a correlated subquery per row) is stopped once
 * it has read `maxRowsRead` rows after its first one. Work SQLite does before a row comes back (an
 * aggregate, a sort, a filter that rarely matches) can't be interrupted: the Durable Object SQL
 * API has no timeout, progress handler or interrupt, so the guard's shape checks bound that.
 */
export function runSql(db: Db, query: string, opts: { maxRowsRead?: number } = {}) {
  const g = guardSql(query);
  if (!g.ok)
    return err(
      "sql_rejected",
      g.reason,
      "Send a single read-only SELECT (or WITH ... SELECT) over the events, sessions, goals, payments and annotations tables, with at most 2 JOINs, each with ON or USING.",
    );
  const maxRowsRead = opts.maxRowsRead && opts.maxRowsRead > 0 ? opts.maxRowsRead : DEFAULT_SQL_MAX_ROWS_READ;
  try {
    const rows: Row[] = [];
    db.transaction(() => {
      const cur = db.cursor(g.sql);
      let readAtFirst = 0;
      while (rows.length <= MAX_SQL_ROWS) {
        const r = cur.next();
        if (r.done) break;
        rows.push(r.value);
        if (rows.length === 1) readAtFirst = cur.rowsRead;
        else if (cur.rowsRead - readAtFirst > maxRowsRead) throw new SqlBudgetError();
      }
      // Defence in depth: the guard should make writes impossible; if one slipped through, roll back.
      if (cur.rowsWritten > 0) throw new Error("write detected; rolled back");
    });
    const truncated = rows.length > MAX_SQL_ROWS;
    const outRows = truncated ? rows.slice(0, MAX_SQL_ROWS) : rows;
    return { columns: outRows[0] ? Object.keys(outRows[0]) : [], rows: outRows, row_count: outRows.length, truncated };
  } catch (e) {
    if (e instanceof SqlBudgetError) {
      return err(
        "sql_too_expensive",
        `Stopped: the query read more than ${maxRowsRead} rows while producing its results.`,
        "Avoid a subquery that scans events for every row; join or GROUP BY instead, filter on ts (indexed), visitor_id, session_id or name, and add LIMIT.",
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return err("sql_error", `SQLite error: ${message}`, `Tables: ${SCHEMA_DOC.replace(/\s+/g, " ")}`);
  }
}

export function summary(db: Db, now = Date.now()) {
  const head = db.all(
    `SELECT COUNT(*) AS total, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
            COALESCE(SUM(ts >= ?), 0) AS last_24h, COALESCE(SUM(origin = 'browser'), 0) AS browser, COALESCE(SUM(origin = 'server'), 0) AS server,
            COALESCE(SUM(origin = 'payment'), 0) AS payment
     FROM events`,
    [now - DAY],
  )[0];
  const last = db.all("SELECT ts, name, origin, hostname, pathname, country FROM events ORDER BY ts DESC, id DESC LIMIT 1")[0];
  const hosts = db.all(
    "SELECT hostname, COUNT(*) AS events FROM events WHERE ts >= ? AND origin = 'browser' GROUP BY hostname ORDER BY events DESC LIMIT 5",
    [now - 7 * DAY],
  );
  const drops = db.all(
    "SELECT reason, SUM(count) AS count, MAX(last_at) AS last_at, MAX(sample) AS sample FROM drops WHERE day >= ? GROUP BY reason",
    [utcDay(now - 7 * DAY)],
  );
  return {
    total_events: num(head?.total),
    events_last_24h: num(head?.last_24h),
    browser_events: num(head?.browser),
    server_events: num(head?.server),
    payment_events: num(head?.payment),
    first_event_at: head?.first_ts ?? null,
    last_event_at: head?.last_ts ?? null,
    last_event: last ?? null,
    hostnames_last_7d: hosts.map((h) => ({ hostname: h.hostname, events: num(h.events) })),
    dropped_last_7d: Object.fromEntries(
      drops
        .filter((d) => !String(d.reason).startsWith(WARN_PREFIX))
        .map((d) => [String(d.reason), { count: num(d.count), last_at: d.last_at, sample: d.sample }]),
    ),
    // Kept events with a setup problem, e.g. proxy_key_missing: came through a first-party proxy
    // without a valid x-afs-proxy-key, so their IP and geo are the proxy's.
    warnings_last_7d: Object.fromEntries(
      drops
        .filter((d) => String(d.reason).startsWith(WARN_PREFIX))
        .map((d) => [String(d.reason).slice(WARN_PREFIX.length), { count: num(d.count), last_at: d.last_at, sample: d.sample }]),
    ),
  };
}

/** Delete raw data older than the retention window. Returns rows deleted. */
export function purge(db: Db, retentionDays: number, now = Date.now()): { events: number; sessions: number } {
  const cutoff = now - retentionDays * DAY;
  const ev = num(db.all("SELECT COUNT(*) AS n FROM events WHERE ts < ?", [cutoff])[0]?.n);
  const se = num(db.all("SELECT COUNT(*) AS n FROM sessions WHERE last_seen_at < ?", [cutoff])[0]?.n);
  db.run("DELETE FROM events WHERE ts < ?", [cutoff]);
  db.run("DELETE FROM sessions WHERE last_seen_at < ?", [cutoff]);
  db.run("DELETE FROM drops WHERE day < ?", [utcDay(now - Math.max(retentionDays, 30) * DAY)]);
  db.run("DELETE FROM payments WHERE ts < ?", [cutoff]);
  db.run("DELETE FROM payment_links WHERE updated_at < ?", [cutoff]);
  // Stripe retries a delivery for up to 3 days; 30 days of event ids is plenty for dedupe.
  db.run("DELETE FROM provider_events WHERE received_at < ?", [now - 30 * DAY]);
  db.run("DELETE FROM annotations WHERE kind != 'note' AND ts < ?", [cutoff]);
  return { events: ev, sessions: se };
}

export type { Attribution };
