/**
 * The per-site engine: schema, ingest + sessionisation, and the query engine. Storage-agnostic
 * (a tiny `Db` interface) so SiteDO runs it over ctx.storage.sql and tests run it over node:sqlite.
 */

import { randomString } from "@afs/shared";
import { hostAllowed } from "../lib/url";
import { type Breakdown, type Metric, FilterError } from "../lib/filters";
import {
  type Frag,
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
import { type Range, PeriodError, buckets, offsetSegments, previousRange, resolvePeriod } from "../lib/time";
import { guardSql } from "../lib/sqlguard";
import type {
  Attribution,
  DoError,
  EnrichedEvent,
  FunnelRequest,
  IngestOutcome,
  IngestResponse,
  PeriodParams,
  SiteSettings,
  StatsRequest,
  TimeseriesRequest,
} from "../lib/types";

export type Row = Record<string, SqlValue>;

/** A statement being stepped lazily: each next() produces one row. Counters cover the work so far. */
export interface SqlCursor {
  next(): IteratorResult<Row, unknown>;
  /** Rows SQLite has read so far (grows as the cursor is stepped; 0 where the driver can't tell). */
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface Db {
  all(sql: string, args?: SqlValue[]): Row[];
  run(sql: string, args?: SqlValue[]): void;
  /** Start a statement without reading its rows (for the user SQL endpoint, so it can stop early). */
  cursor(sql: string): SqlCursor;
  /** Run fn in a transaction; throw inside to roll back. */
  transaction<T>(fn: () => T): T;
}

export const SESSION_TIMEOUT_MS = 30 * 60_000;
const DAY = 86_400_000;

// ------------------------------------------------------------------ schema

export const SCHEMA_VERSION = 1;

const ATTR_COLS = [
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
const GEO_COLS = ["country", "region", "region_code", "city", "continent", "timezone", "latitude", "longitude", "asn", "as_org"] as const;
const DEVICE_COLS = ["browser", "browser_version", "os", "os_version", "device"] as const;

const SCHEMA = `
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

/** Columns and their meaning, for llms.txt / the query_sql tool description. */
export const SCHEMA_DOC = `events(id, ts unix ms, name ['pageview' or custom], visitor_id, session_id, user_id, origin [browser|server],
  hostname, pathname, url, referrer, referrer_host, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
  click_id_type, click_id, country, region, region_code, city, continent, timezone, latitude, longitude, asn, as_org,
  browser, browser_version, os, os_version, device, props [JSON text], revenue, currency, engagement_ms)
sessions(id, visitor_id, user_id, started_at, last_seen_at, hostname, entry_page, exit_page, pageviews, custom_events,
  engagement_ms, + the same attribution, geo and device columns as events)
goals(id, name, type [event|pageview], match, glob, value, created_at)`;

export function migrate(db: Db): void {
  for (const stmt of SCHEMA.split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    db.run(stmt);
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
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
      db.run("INSERT INTO goals (id, name, type, match, glob, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        g.id,
        g.name,
        g.type,
        g.match,
        g.type === "pageview" ? toGlob(g.match) : null,
        g.value,
        g.created_at,
      ]);
    }
  });
}

// ------------------------------------------------------------------ ingest

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

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

function pick<K extends string>(src: Record<string, unknown>, cols: readonly K[]): Record<K, SqlValue> {
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

/** Visible-time beacon: adds to the latest pageview of that page and extends the session. */
function engagement(db: Db, visitorId: string, ev: EnrichedEvent): IngestOutcome {
  const ms = Math.max(0, Math.min(ev.engagement_ms || 0, 4 * 3_600_000));
  const pv = db.all(
    `SELECT id, session_id FROM events WHERE visitor_id = ? AND name = 'pageview' AND pathname = ? AND ts <= ? AND ts >= ?
     ORDER BY ts DESC LIMIT 1`,
    [visitorId, ev.pathname, ev.ts, ev.ts - DAY],
  )[0];
  if (!pv) return { ok: false, reason: "no_pageview_for_engagement" };
  db.run("UPDATE events SET engagement_ms = engagement_ms + ? WHERE id = ?", [ms, pv.id ?? null]);
  db.run("UPDATE sessions SET engagement_ms = engagement_ms + ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?", [
    ms,
    ev.ts,
    pv.session_id ?? null,
  ]);
  return { ok: true, visitor_id: visitorId, session_id: String(pv.session_id) };
}

// ------------------------------------------------------------------ queries

const all = (db: Db, f: Frag) => db.all(f.sql, f.args);
const num = (v: SqlValue | undefined) => (v == null ? 0 : Number(v));
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

const SESSION_METRICS: Metric[] = ["bounce_rate", "visit_duration"];

export function shapeMetrics(row: Row | undefined, metrics: Metric[]): Record<string, number> {
  const r = row ?? {};
  const visitors = num(r.visitors);
  const visits = num(r.visits);
  const pageviews = num(r.pageviews);
  const m: Record<Metric, number> = {
    visitors,
    visits,
    pageviews,
    views_per_visit: visits ? round(pageviews / visits, 2) : 0,
    bounce_rate: round(num(r.bounce_rate), 1),
    visit_duration: Math.round(num(r.visit_duration)),
    events: num(r.events),
    conversions: num(r.conversions),
    conversion_rate: visitors ? round((num(r.converted_visitors) / visitors) * 100, 1) : 0,
    revenue: round(num(r.revenue), 2),
  };
  const out: Record<string, number> = {};
  for (const k of metrics) out[k] = m[k];
  return out;
}

function ctxFor(db: Db, range: { start: number; end: number }, filters: StatsRequest["filters"]): QueryCtx {
  const g = db.all("SELECT COUNT(*) AS n, COUNT(value) AS v FROM goals")[0];
  return { start: range.start, end: range.end, filters, hasGoals: num(g?.n) > 0, hasGoalValues: num(g?.v) > 0 };
}

function firstEventTs(db: Db): number | null {
  const r = db.all("SELECT MIN(ts) AS t FROM events")[0];
  return r?.t == null ? null : Number(r.t);
}

const periodOut = (r: Range) => ({ name: r.period, from: r.from, to: r.to, timezone: r.timezone, start: r.start, end: r.end });

function err(code: string, message: string, hint?: string): DoError {
  return { error: { code, message, ...(hint ? { hint } : {}) } };
}

function range(db: Db, settings: SiteSettings, p: PeriodParams, now: number): Range {
  return resolvePeriod(p, settings.timezone, now, p.period === "all" ? firstEventTs(db) : null);
}

function checkGoalFilters(db: Db, filters: StatsRequest["filters"]): DoError | null {
  const names = filters.filter((f) => f.key === "goal" && (f.op === "==" || f.op === "!=")).flatMap((f) => f.values);
  if (!names.length) return null;
  const known = new Set(db.all("SELECT name FROM goals").map((r) => String(r.name)));
  const missing = names.filter((n) => !known.has(n));
  if (!missing.length) return null;
  return err(
    "unknown_goal",
    `Unknown goal(s): ${missing.join(", ")}.`,
    known.size ? `Goals on this site: ${[...known].join(", ")}.` : "This site has no goals yet; create one with POST /v1/sites/:id/goals.",
  );
}

function guard<T>(fn: () => T): T | DoError {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PeriodError || e instanceof FilterError) return err("bad_request", e.message);
    throw e;
  }
}

function notes(db: Db, metrics: Metric[]): string[] {
  const out: string[] = [];
  if ((metrics.includes("conversions") || metrics.includes("conversion_rate")) && !num(db.all("SELECT COUNT(*) AS n FROM goals")[0]?.n)) {
    out.push("No goals defined, so conversions are 0. Create one: POST /v1/sites/:id/goals {name, type: event|pageview, match}.");
  }
  return out;
}

export function stats(db: Db, settings: SiteSettings, q: StatsRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const r = range(db, settings, q, now);
    const ctx = ctxFor(db, r, q.filters);
    const withSessions = q.metrics.some((m) => SESSION_METRICS.includes(m));
    const cur = shapeMetrics(all(db, aggregateQuery(ctx, withSessions))[0], q.metrics);
    const out: Record<string, unknown> = { period: periodOut(r), filters: q.filters, metrics: cur };
    if (q.compare) {
      const p = previousRange(r, now);
      if (p) {
        const prev = shapeMetrics(all(db, aggregateQuery({ ...ctx, start: p.start, end: p.end }, withSessions))[0], q.metrics);
        const change: Record<string, number | null> = {};
        for (const m of q.metrics) {
          const a = cur[m]!;
          const b = prev[m]!;
          change[m] = b === 0 ? (a === 0 ? 0 : null) : round(((a - b) / b) * 100, 1);
        }
        out.comparison = { period: { ...periodOut(p), partial: p.partial }, metrics: prev, change_percent: change };
      } else out.comparison = null;
    }
    if (q.breakdown) {
      const b = breakdownRows(db, ctx, q.breakdown, q.breakdown_metrics ?? q.metrics, q.limit ?? 20);
      out.breakdown = { property: q.breakdown, results: b };
    }
    const n = notes(db, q.metrics);
    if (n.length) out.notes = n;
    return out;
  });
}

function breakdownRows(db: Db, ctx: QueryCtx, dim: Breakdown, metrics: Metric[], limit: number) {
  if (dim === "goal") {
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
      };
    });
  }
  const withSessions = metrics.some((m) => SESSION_METRICS.includes(m));
  const spec = { ...groupSpecFor(dim), limit };
  return all(db, groupedQuery(ctx, spec, withSessions)).map((r) => ({
    value: r.value,
    ...(spec.extra ? Object.fromEntries(spec.extra.map((x) => [x.name, r[x.name]])) : {}),
    ...shapeMetrics(r, metrics),
  }));
}

export function breakdown(db: Db, settings: SiteSettings, q: StatsRequest & { breakdown: Breakdown }, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const r = range(db, settings, q, now);
    const ctx = ctxFor(db, r, q.filters);
    return {
      period: periodOut(r),
      filters: q.filters,
      property: q.breakdown,
      results: breakdownRows(db, ctx, q.breakdown, q.metrics, q.limit ?? 20),
    };
  });
}

export function timeseries(db: Db, settings: SiteSettings, q: TimeseriesRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters);
    if (ge) return ge;
    const r = range(db, settings, q, now);
    const interval = q.interval ?? r.interval;
    // Buckets up to now: an in-progress period has no rows for the future.
    const bs = buckets(r, interval).filter((b, i) => i === 0 || b.start <= now);
    const ctx = ctxFor(db, r, q.filters);
    const withSessions = q.metrics.some((m) => SESSION_METRICS.includes(m));
    const key = bucketKey(interval, offsetSegments(r.start, r.end, settings.timezone));
    const rows = all(db, groupedQuery(ctx, { key, orderByKey: true }, withSessions));
    const byLabel = new Map(rows.map((x) => [String(x.value), x]));
    return {
      period: periodOut(r),
      interval,
      filters: q.filters,
      results: bs.map((b) => ({ date: b.label, ...shapeMetrics(byLabel.get(b.label), q.metrics) })),
    };
  });
}

export function realtime(db: Db, now = Date.now()) {
  const t5 = now - 5 * 60_000;
  const t30 = now - 30 * 60_000;
  const top = (col: string, extra = "") =>
    db
      .all(
        `SELECT COALESCE(${col}, '(none)') AS value, COUNT(DISTINCT visitor_id) AS visitors FROM events
         WHERE ts >= ? ${extra} GROUP BY value ORDER BY visitors DESC, value LIMIT 10`,
        [t30],
      )
      .map((r) => ({ value: r.value, visitors: num(r.visitors) }));
  const head = db.all(
    `SELECT COUNT(DISTINCT CASE WHEN ts >= ? THEN visitor_id END) AS v5, COUNT(DISTINCT visitor_id) AS v30,
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
    if (goalSteps.length) {
      const known = new Set(db.all("SELECT name FROM goals").map((r) => String(r.name)));
      const missing = goalSteps.filter((n) => !known.has(n));
      if (missing.length)
        return err(
          "unknown_goal",
          `Unknown goal(s) in steps: ${missing.join(", ")}.`,
          `Goals on this site: ${[...known].join(", ") || "none"}.`,
        );
    }
    const r = range(db, settings, q, now);
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
      "Send a single read-only SELECT (or WITH ... SELECT) over the events, sessions and goals tables, with at most 2 JOINs, each with ON or USING.",
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
            COALESCE(SUM(ts >= ?), 0) AS last_24h, COALESCE(SUM(origin = 'browser'), 0) AS browser, COALESCE(SUM(origin = 'server'), 0) AS server
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
  return { events: ev, sessions: se };
}

export type { Attribution };
