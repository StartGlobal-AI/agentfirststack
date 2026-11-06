import { DurableObject } from "cloudflare:workers";
import {
  accountStanding,
  isDatacenterAsn,
  type ProtectionMode,
  randomString,
  SPIKE_FACTOR,
  SPIKE_WINDOW_MS,
  type Standing,
} from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import type { DispatchEvent } from "../destinations/types";
import type { Bindings } from "../env";
import { type EventCounts, type EventScope, NO_EVENTS, reportEventUsage, reserveDeliveries } from "../service/budget";
import { aggregateStatus, type DestinationInfo, planDispatch, type PlannedTarget, type TargetResult } from "../service/dispatch-plan";
import { mergeVisitor, type VisitorData, type VisitorUpdate } from "../service/identity";
import {
  CLAIMED,
  CONSENT_RETENTION_DAYS,
  containerCaps,
  type EventBudgets,
  eventBudgets,
  needsAggregate,
  shownCap,
  utcDay,
} from "../service/limits";
import {
  browserDispatchEvent,
  type CollectHit,
  findConversion,
  identitySummary,
  serverDispatchEvent,
  serverEventId,
  serverUserData,
  visitorUpdateFromHit,
} from "../service/ingest";
import type { ConsentRecordPayload, ServerEvent } from "../service/ingest-schema";
import { hostAllowed, originHost } from "../service/origin";
import { eventForLog, LOG_IDENTITY } from "../service/privacy";
import {
  effectiveProtection,
  heldReason,
  isActive,
  measuresOn,
  type ProtectionView,
  parseMode,
  protectionCaps,
  type QuarantineReason,
  type StoredProtection,
  spikeMin,
  spikeThreshold,
} from "../service/protection";

export const EVENT_RETENTION_DAYS = 7;
export const VISITOR_RETENTION_DAYS = 180;
/** Preview log entries per preview token, and how long they're kept (tokens live up to 24 h). */
export const MAX_PREVIEW_LOG_ENTRIES = 500;
export const PREVIEW_LOG_HOURS = 48;
/** Tag-fire counts (settings.report_tag_fires) and page coverage are kept this many days. */
export const TAG_STATS_DAYS = 30;
/** Distinct host + path rows for coverage; further pages count under path "(other)". */
export const MAX_COVERAGE_PAGES = 1000;
/** The daily consent counts behind the rates are kept a little longer than the records (CONSENT_RETENTION_DAYS). */
const CONSENT_DAILY_DAYS = 400;
const DAY = 86_400_000;
/** Backend events keep working past MAX_CONTAINER_DB_BYTES up to this factor, so a /collect flood can't block them. */
export const SERVER_STORAGE_HEADROOM = 1.25;
/** Report this container's daily event counts to the account / platform aggregate (D1) at most this often... */
const AGGREGATE_EVERY_MS = 60_000;
/** ...or after 1% of the smaller budget in new events (at most 1,000), whichever comes first. */
const AGGREGATE_EVERY_EVENTS = 1_000;
const aggregateEvery = (b: EventBudgets) =>
  Math.max(1, Math.min(AGGREGATE_EVERY_EVENTS, Math.floor(Math.min(b.perAccount, b.platform) / 100)));

export interface ContainerState {
  id: string;
  account_id: string;
  domain: string;
  allowed_hostnames: string[];
  live_version: number | null;
  /** Attack protection (absent in objects synced by older code: auto). */
  protection?: ProtectionMode;
  /** For the spike baseline: days before the container existed don't count. */
  created_at?: number;
}

/** One container's share of GET /v1/usage (ContainerDO.usageToday). */
export interface ContainerUsage {
  browser_events: number;
  server_events: number;
  deliveries: number;
  visitors: number;
  db_bytes: number;
  /** Browser hits quarantined today (attack protection), and the most hits one network sent today. */
  quarantined: number;
  network_max: number;
  /** Consent banner choices recorded today. */
  consent_records: number;
  protection: ProtectionView;
}

export interface DispatchMessage {
  container_id: string;
  destination_id: string;
  type: string;
  test: boolean;
  event: DispatchEvent;
}

/** One consent banner choice to record (the Worker checked it isn't test traffic). No IP, user agent or visitor id. */
export interface ConsentRecordInput {
  record: ConsentRecordPayload;
  /** The page's host (origin check), the visitor's country (Cloudflare), the container version the page ran. */
  host: string | null;
  country: string | null;
  container_version: number | null;
  at: number;
}

export type ConsentRecordResult =
  | { ok: true }
  | { ok: false; error: "not_synced" | "origin_not_allowed" | "suspended"; host?: string }
  | { ok: false; error: "consent_quota" | "storage_full"; limit: number };

export interface ConsentRecordRow {
  consent_id: string;
  at: number;
  version: number;
  analytics: number;
  ads: number;
  personalization: number;
  method: string;
  country: string | null;
  language: string | null;
  container_version: number | null;
}

export type CollectResult =
  | { ok: true; event_id: string; duplicate?: boolean; visitor_id?: string; destinations?: PlannedTarget[]; note?: string }
  | { ok: false; error: "not_synced" | "origin_not_allowed" | "suspended"; host?: string }
  | { ok: false; error: "quota"; scope: EventScope; limit: number }
  | { ok: false; error: "storage_full"; limit: number };

export type IngestRefusal =
  | { error: "not_synced" | "suspended" }
  | { error: "quota"; scope: EventScope; limit: number; used: number }
  | { error: "storage_full"; limit: number };

/** Today's events on the account's other containers and on the rest of the platform (from D1). */
type Others = { account: EventCounts; platform: EventCounts };

export interface ServerIngestResult {
  event_id: string;
  name: string;
  status: "accepted" | "duplicate";
  joined: { by: string | null; visitor_id: string | null; click_ids: string[] };
  conversion: string | null;
  destinations: PlannedTarget[];
  note?: string;
}

export interface EventFilter {
  name?: string;
  status?: string;
  source?: string;
  since?: number;
  before?: number;
  limit?: number;
  include_visits?: boolean;
  verbose?: boolean;
}

type EventRow = {
  event_id: string;
  type: string;
  name: string;
  source: string;
  ts: number;
  received_at: number;
  visitor_id: string | null;
  transaction_id: string | null;
  value: number | null;
  currency: string | null;
  preview: number;
  status: string;
  data: string;
  results: string;
  note: string | null;
  /** Attack protection (schema v5): why the hit was quarantined (never delivered), and its network operator. */
  quarantine?: string | null;
  asn?: number | null;
  as_org?: string | null;
};

/** Event log rows are keyed by (source, event_id): browser and server rows never collide. */
type Origin = "browser" | "server";

const SCHEMA_VERSION = 5;
const EVENTS_DDL = `
  CREATE TABLE events (
    event_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
    ts INTEGER NOT NULL, received_at INTEGER NOT NULL, visitor_id TEXT, transaction_id TEXT,
    value REAL, currency TEXT, preview INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    data TEXT NOT NULL, results TEXT NOT NULL DEFAULT '{}', note TEXT,
    quarantine TEXT, asn INTEGER, as_org TEXT,
    PRIMARY KEY (source, event_id))`;
const EVENT_COLS =
  "event_id, type, name, source, ts, received_at, visitor_id, transaction_id, value, currency, preview, status, data, results, note";

/**
 * One per container (SQLite). Holds a copy of the live config and destination list (pushed by
 * the control plane on publish / destination changes) so /collect never touches D1, plus the
 * visitors table, the 7-day event log, and dedupe (the log's primary key is (source, event_id)).
 *
 * Storage is only created by `sync()`, which only the control plane calls (container create,
 * publish, rollback, destination changes, or a resync of a container that exists in D1). An id
 * nobody created answers `not_synced` and writes nothing, so /collect can't mint objects.
 *
 * Daily event caps live here too: the container's own (`usage` table, only ever incremented) and,
 * when MAX_EVENTS_PER_ACCOUNT_PER_DAY or MAX_EVENTS_PER_DAY is set, the account's and platform's
 * totals: this container's counts are reported to D1 at most once a minute or per 1% of the
 * smaller budget, and the totals come back with each report.
 */
export class ContainerDO extends DurableObject<Bindings> {
  private sql: SqlStorage;
  /** Tables exist. False for an id that was never initialised through the API. */
  private ready: boolean;
  /** The last report to the D1 aggregate today: when, this container's counts then, and the totals it read back. */
  private agg = { day: "", at: 0, flushed: NO_EVENTS, account: NO_EVENTS, platform: NO_EVENTS };
  private aggInflight: Promise<void> | null = null;
  /** Attack protection: the episode (meta "protection", loaded lazily, saved on change or every 30 s). */
  private prot: StoredProtection | null | undefined = undefined;
  private protSavedAt = 0;
  /** Browser hits in the current 15-minute window (in memory only), and the usual rate per window for a day. */
  private win = { start: 0, n: 0 };
  private usual = { day: "", perWindow: 0 };
  /** The day net_daily was last pruned for, and the most hits one network sent that day (-1: not read yet). */
  private netDay = "";
  private netMax = { day: "", n: -1 };

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ready = this.tableExists("meta");
    if (this.ready) this.migrate(); // idempotent; upgrades objects created by older code
  }

  private tableExists(name: string) {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
  }

  /** Create or upgrade the schema. Only runs for initialised objects (see constructor, sync). */
  private migrate() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS visitors (
          visitor_id TEXT PRIMARY KEY, user_id TEXT, em TEXT, ph TEXT,
          data TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS visitors_user ON visitors(user_id);
        CREATE INDEX IF NOT EXISTS visitors_em ON visitors(em);
        CREATE INDEX IF NOT EXISTS visitors_ph ON visitors(ph);
        CREATE INDEX IF NOT EXISTS visitors_seen ON visitors(last_seen);
        CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind));
        CREATE TABLE IF NOT EXISTS preview_log (
          token_hash TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, entry TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS preview_log_token ON preview_log(token_hash, seq);
        CREATE TABLE IF NOT EXISTS tag_stats (
          day TEXT NOT NULL, tag_id TEXT NOT NULL, status TEXT NOT NULL, n INTEGER NOT NULL, last_at INTEGER NOT NULL,
          PRIMARY KEY (day, tag_id, status));
        CREATE TABLE IF NOT EXISTS pages (
          host TEXT NOT NULL, path TEXT NOT NULL, hits INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
          PRIMARY KEY (host, path));
        CREATE TABLE IF NOT EXISTS net_daily (day TEXT NOT NULL, net TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, net));
        CREATE TABLE IF NOT EXISTS consent_records (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, consent_id TEXT NOT NULL, at INTEGER NOT NULL, version INTEGER NOT NULL,
          analytics INTEGER NOT NULL, ads INTEGER NOT NULL, personalization INTEGER NOT NULL, method TEXT NOT NULL,
          country TEXT, language TEXT, container_version INTEGER);
        CREATE INDEX IF NOT EXISTS consent_records_id ON consent_records(consent_id, at);
        CREATE INDEX IF NOT EXISTS consent_records_at ON consent_records(at);
        CREATE TABLE IF NOT EXISTS consent_daily (
          day TEXT NOT NULL, method TEXT NOT NULL, n INTEGER NOT NULL,
          analytics INTEGER NOT NULL, ads INTEGER NOT NULL, personalization INTEGER NOT NULL, PRIMARY KEY (day, method));
      `);
      const hasEvents = this.tableExists("events");
      const version = hasEvents ? (this.getMeta<number>("schema") ?? 1) : 0;
      if (version < 2) {
        // v1 keyed events by event_id alone, so a browser row could stand in for a server event
        // ("browser+server"). v2 keys by (source, event_id); merged rows become server rows.
        if (hasEvents) this.sql.exec("ALTER TABLE events RENAME TO events_v1");
        this.sql.exec(EVENTS_DDL);
        if (hasEvents) {
          this.sql.exec(
            `INSERT OR IGNORE INTO events (${EVENT_COLS})
             SELECT event_id, type, name, CASE WHEN source = 'browser' THEN 'browser' ELSE 'server' END, ts, received_at, visitor_id,
                    transaction_id, value, currency, preview, status, data, results, note FROM events_v1`,
          );
          this.sql.exec("DROP TABLE events_v1");
        }
      }
      if (version < 3) {
        // v3: the user_id/em/ph join columns hold only identities a backend linked (VisitorData.linked).
        // Older rows may carry ids a browser posted to /collect, so they are cleared; visitor_id joins
        // are unaffected and the backend re-links visitors with its next event.
        this.sql.exec(
          "UPDATE visitors SET user_id = NULL, em = NULL, ph = NULL WHERE user_id IS NOT NULL OR em IS NOT NULL OR ph IS NOT NULL",
        );
      }
      if (version < 4 && hasEvents) this.scrubLegacyEvents();
      if (version < 5) {
        // v5 (attack protection): quarantined hits are logged with their reason and network operator.
        const cols = new Set(
          this.sql
            .exec<{ name: string }>("SELECT name FROM pragma_table_info('events')")
            .toArray()
            .map((r) => r.name),
        );
        for (const [col, type] of [
          ["quarantine", "TEXT"],
          ["asn", "INTEGER"],
          ["as_org", "TEXT"],
        ])
          if (!cols.has(col!)) this.sql.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
      }
      if (version < SCHEMA_VERSION) this.setMeta("schema", SCHEMA_VERSION);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
        CREATE INDEX IF NOT EXISTS events_name ON events(name, received_at);
        CREATE INDEX IF NOT EXISTS events_txn ON events(transaction_id, name, source);
        CREATE INDEX IF NOT EXISTS events_quarantine ON events(received_at) WHERE quarantine IS NOT NULL;
      `);
    });
  }

  /**
   * v4: rows written by older code kept the raw IP, user agent, city and postal code of conversions,
   * and the exact requests sent to destinations. Those are removed (the network isn't recoverable
   * for these rows, so their identity summary may show ip/user_agent false). Public so tests can
   * run it on a row written the old way.
   */
  scrubLegacyEvents() {
    // Best effort: a failure here must never stop the object from starting (rows age out in 7 days anyway).
    try {
      this.sql.exec(
        `UPDATE events SET data = json_remove(data, '$.ip', '$.user_agent', '$.geo.city', '$.geo.postal_code', '$.device.model', '$.device.brand', '$.device.browser_version', '$.device.os_version')
         WHERE type = 'conversion' AND json_valid(data) AND json_extract(data, '$._identity') IS NULL`,
      );
      this.sql.exec(
        `UPDATE events SET results = (SELECT json_group_object(key, CASE WHEN type = 'object' THEN json_remove(value, '$.request') ELSE value END) FROM json_each(events.results))
         WHERE json_valid(results) AND json_valid(data) AND results LIKE '%"request"%' AND json_extract(data, '$._identity') IS NULL`,
      );
    } catch (e) {
      console.error("event log scrub (schema v4) failed", e);
    }
  }

  // ------------------------------------------------------------------ control plane sync

  private getMeta<T>(k: string): T | null {
    if (!this.ready) return null;
    const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  private setMeta(k: string, v: unknown) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }

  /** Called only by the control plane (src/service/containers.ts syncToDO / updateContainer). */
  async sync(update: { container?: ContainerState; config?: ContainerConfig | null; destinations?: DestinationInfo[] }) {
    if (!this.ready) {
      if (!update.container) return { ok: false }; // never initialise without the container itself
      this.ready = true;
      this.migrate();
    }
    if (update.container) this.setMeta("container", update.container);
    if (update.config !== undefined) this.setMeta("config", update.config);
    if (update.destinations) this.setMeta("destinations", update.destinations);
    await this.ensureAlarm();
    return { ok: true };
  }

  async isSynced() {
    return !!this.getMeta<ContainerState>("container");
  }

  /**
   * Storage left by older code for an id that was never a container (it created tables in the
   * constructor for any id). The Worker deletes it once D1 confirms the id is unknown.
   */
  async isStale() {
    if (!this.tableExists("meta")) return false;
    return this.sql.exec("SELECT 1 FROM meta WHERE k = 'container'").toArray().length === 0;
  }

  /** Delete everything this container stored. Its counts for today stay in the account / platform aggregate. */
  async destroy() {
    await this.flushEventUsage();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
    this.visitorCount = null;
    this.agg = { day: "", at: 0, flushed: NO_EVENTS, account: NO_EVENTS, platform: NO_EVENTS };
    this.prot = undefined;
    this.win = { start: 0, n: 0 };
    this.usual = { day: "", perWindow: 0 };
    this.netDay = "";
    this.netMax = { day: "", n: -1 };
    return { ok: true };
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY);
  }

  override async alarm() {
    if (!this.ready) return; // deleted container: let the object go idle
    const now = Date.now();
    this.sql.exec("DELETE FROM events WHERE received_at < ?", now - EVENT_RETENTION_DAYS * DAY);
    this.sql.exec("DELETE FROM visitors WHERE last_seen < ?", now - VISITOR_RETENTION_DAYS * DAY);
    // Eight days: the spike baseline reads the previous seven days' browser_events.
    this.sql.exec("DELETE FROM usage WHERE day < ?", utcDay(now - 8 * DAY));
    this.sql.exec("DELETE FROM net_daily WHERE day < ?", utcDay(now));
    this.sql.exec("DELETE FROM preview_log WHERE received_at < ?", now - PREVIEW_LOG_HOURS * 3_600_000);
    this.sql.exec("DELETE FROM tag_stats WHERE day < ?", utcDay(now - TAG_STATS_DAYS * DAY));
    this.sql.exec("DELETE FROM pages WHERE last_seen < ?", now - TAG_STATS_DAYS * DAY);
    this.sql.exec("DELETE FROM consent_records WHERE at < ?", now - CONSENT_RETENTION_DAYS * DAY);
    this.sql.exec("DELETE FROM consent_daily WHERE day < ?", utcDay(now - CONSENT_DAILY_DAYS * DAY));
    this.visitorCount = null;
    this.pageCount = null;
    await this.ctx.storage.setAlarm(now + DAY);
  }

  // ------------------------------------------------------------------ visitors

  private loadVisitor(id: string): VisitorData | null {
    const row = this.sql.exec<{ data: string }>("SELECT data FROM visitors WHERE visitor_id = ?", id).toArray()[0];
    return row ? (JSON.parse(row.data) as VisitorData) : null;
  }

  /** Join columns come only from identities the backend linked; ids posted to /collect never join. */
  private saveVisitor(id: string, v: VisitorData, now: number) {
    this.sql.exec(
      `INSERT INTO visitors (visitor_id, user_id, em, ph, data, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(visitor_id) DO UPDATE SET user_id = excluded.user_id, em = excluded.em, ph = excluded.ph,
         data = excluded.data, last_seen = excluded.last_seen`,
      id,
      v.linked?.user_id ?? null,
      v.linked?.em ?? null,
      v.linked?.ph ?? null,
      JSON.stringify(v),
      now,
      now,
    );
  }

  /** Visitor rows, counted once per object lifetime and kept up to date on insert/evict. */
  private visitorCount: number | null = null;

  /**
   * Make room for one new visitor under MAX_VISITORS_PER_CONTAINER: past the cap, the least
   * recently seen 1% are deleted (random visitor ids posted to /collect can't grow the table).
   */
  private makeRoomForVisitor(cap: number) {
    if (!Number.isFinite(cap)) {
      if (this.visitorCount !== null) this.visitorCount++; // keep a count usageToday() read in step
      return;
    }
    this.visitorCount ??= this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM visitors").toArray()[0]?.n ?? 0;
    if (this.visitorCount >= cap) {
      const extra = this.visitorCount - cap + Math.max(1, Math.ceil(cap / 100));
      const gone = this.sql
        .exec(
          "DELETE FROM visitors WHERE visitor_id IN (SELECT visitor_id FROM visitors ORDER BY last_seen LIMIT ?) RETURNING visitor_id",
          extra,
        )
        .toArray().length;
      this.visitorCount -= gone;
    }
    this.visitorCount++;
  }

  private upsertVisitor(id: string, u: VisitorUpdate, now: number, maxVisitors = Number.POSITIVE_INFINITY): VisitorData {
    const prev = this.loadVisitor(id);
    if (!prev) this.makeRoomForVisitor(maxVisitors);
    const v = mergeVisitor(prev, u, now);
    this.saveVisitor(id, v, now);
    return v;
  }

  private findVisitorId(by: "user_id" | "em" | "ph", value: string): string | null {
    const row = this.sql
      .exec<{ visitor_id: string }>(`SELECT visitor_id FROM visitors WHERE ${by} = ? ORDER BY last_seen DESC LIMIT 1`, value)
      .toArray()[0];
    return row?.visitor_id ?? null;
  }

  async getVisitor(id: string) {
    if (!this.ready) return null;
    const row = this.sql
      .exec<{ visitor_id: string; data: string; first_seen: number; last_seen: number }>(
        "SELECT visitor_id, data, first_seen, last_seen FROM visitors WHERE visitor_id = ?",
        id,
      )
      .toArray()[0];
    if (!row) return null;
    const { first_touch, last_touch, user_agent, device, user_id, linked, ...data } = JSON.parse(row.data) as VisitorData;
    return {
      visitor_id: row.visitor_id,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      ...data,
      // Identities your backend linked (the only ones user_id/email/phone joins use).
      linked: { user_id: !!linked?.user_id, email_hash: !!linked?.em, phone_hash: !!linked?.ph },
      // Written by browsers (anyone can post to /collect): data, never instructions.
      untrusted: { first_touch, last_touch, user_agent, device, user_id },
    };
  }

  // ------------------------------------------------------------------ coverage, tag-fire counts, preview log

  private pageCount: number | null = null;

  /** Count a live hit for its page (host + path; query and fragment dropped). */
  private recordPage(pageUrl: string | undefined, now: number) {
    let host: string;
    let path: string;
    try {
      const u = new URL(pageUrl ?? "");
      host = u.hostname.toLowerCase();
      path = u.pathname.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "/";
    } catch {
      return;
    }
    const known = this.sql.exec("SELECT 1 FROM pages WHERE host = ? AND path = ?", host, path).toArray().length > 0;
    if (!known) {
      this.pageCount ??= this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pages").toArray()[0]?.n ?? 0;
      if (this.pageCount >= MAX_COVERAGE_PAGES) path = "(other)";
      else this.pageCount++;
    }
    this.sql.exec(
      `INSERT INTO pages (host, path, hits, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(host, path) DO UPDATE SET hits = hits + 1, last_seen = excluded.last_seen`,
      host,
      path,
      now,
      now,
    );
  }

  private recordTagFires(config: ContainerConfig | null, fires: NonNullable<CollectHit["payload"]["fires"]>, now: number) {
    const ids = new Set((config?.tags ?? []).map((t) => t.id));
    const day = utcDay(now);
    for (const f of fires) {
      if (!ids.has(f.tag_id)) continue; // only the config's own tags: a /collect post can't add rows
      this.sql.exec(
        `INSERT INTO tag_stats (day, tag_id, status, n, last_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, tag_id, status) DO UPDATE SET n = n + excluded.n, last_at = excluded.last_at`,
        day,
        f.tag_id,
        f.status,
        f.n,
        now,
      );
    }
  }

  /** Preview log entries from a preview build (the token was checked by the Worker). */
  async previewLog(tokenHash: string, entries: unknown[], now: number): Promise<{ ok: boolean; stored: number; error?: string }> {
    if (!this.ready) return { ok: false, stored: 0, error: "not_synced" };
    const caps = containerCaps(this.env);
    if (this.sql.databaseSize > caps.dbBytes) return { ok: false, stored: 0, error: "storage_full" };
    const have = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM preview_log WHERE token_hash = ?", tokenHash).toArray()[0]?.n ?? 0;
    const room = Math.max(0, MAX_PREVIEW_LOG_ENTRIES - have);
    for (const e of entries.slice(0, room))
      this.sql.exec("INSERT INTO preview_log (token_hash, received_at, entry) VALUES (?, ?, ?)", tokenHash, now, JSON.stringify(e));
    if (Math.random() < 0.05) this.sql.exec("DELETE FROM preview_log WHERE received_at < ?", now - PREVIEW_LOG_HOURS * 3_600_000);
    await this.ensureAlarm();
    return { ok: true, stored: Math.min(entries.length, room) };
  }

  async readPreviewLog(tokenHash: string, after = 0, limit = 200) {
    if (!this.ready) return { entries: [], next_after: null, full: false };
    const rows = this.sql
      .exec<{ seq: number; received_at: number; entry: string }>(
        "SELECT seq, received_at, entry FROM preview_log WHERE token_hash = ? AND seq > ? ORDER BY seq LIMIT ?",
        tokenHash,
        after,
        Math.min(Math.max(limit, 1), 500) + 1,
      )
      .toArray();
    const page = rows.slice(0, limit);
    const total =
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM preview_log WHERE token_hash = ?", tokenHash).toArray()[0]?.n ?? 0;
    return {
      entries: page.map((r) => ({ seq: r.seq, received_at: r.received_at, ...(JSON.parse(r.entry) as Record<string, unknown>) })),
      next_after: rows.length > limit ? page[page.length - 1]!.seq : null,
      full: total >= MAX_PREVIEW_LOG_ENTRIES,
    };
  }

  async tagStats(sinceDay: string) {
    if (!this.ready) return [];
    return this.sql
      .exec<{ tag_id: string; status: string; n: number; last_at: number }>(
        "SELECT tag_id, status, SUM(n) AS n, MAX(last_at) AS last_at FROM tag_stats WHERE day >= ? GROUP BY tag_id, status",
        sinceDay,
      )
      .toArray();
  }

  async coverage(since: number) {
    if (!this.ready) return { pages: [], capped: false };
    const pages = this.sql
      .exec<{ host: string; path: string; hits: number; first_seen: number; last_seen: number }>(
        "SELECT host, path, hits, first_seen, last_seen FROM pages WHERE last_seen >= ? ORDER BY hits DESC LIMIT 1000",
        since,
      )
      .toArray();
    return { pages, capped: pages.some((p) => p.path === "(other)") };
  }

  // ------------------------------------------------------------------ consent banner records (proof of consent)

  /** Record one banner choice: origin checked like /collect hits, capped per day (MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY). */
  async recordConsent(input: ConsentRecordInput): Promise<ConsentRecordResult> {
    const state = this.getMeta<ContainerState>("container");
    if (!state) return { ok: false, error: "not_synced" };
    if (!input.host || !hostAllowed(input.host, state)) return { ok: false, error: "origin_not_allowed", host: input.host ?? undefined };
    const standing = await accountStanding(this.env, state.account_id);
    if (standing.suspended) return { ok: false, error: "suspended" };
    const caps = containerCaps(this.env, standing);
    if (this.sql.databaseSize > caps.dbBytes) return { ok: false, error: "storage_full", limit: caps.dbBytes };
    const day = utcDay(input.at);
    if (this.usage(day, "consent_records") >= caps.consentRecordsPerDay)
      return { ok: false, error: "consent_quota", limit: caps.consentRecordsPerDay };
    const r = input.record;
    const [a, d, p] = [+r.analytics, +r.ads, +r.personalization];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO consent_records (consent_id, at, version, analytics, ads, personalization, method, country, language, container_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id,
        input.at,
        r.version,
        a,
        d,
        p,
        r.method,
        input.country,
        r.language ?? null,
        input.container_version,
      );
      this.sql.exec(
        `INSERT INTO consent_daily (day, method, n, analytics, ads, personalization) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(day, method) DO UPDATE SET n = n + 1, analytics = analytics + excluded.analytics,
           ads = ads + excluded.ads, personalization = personalization + excluded.personalization`,
        day,
        r.method,
        a,
        d,
        p,
      );
      this.bump(day, "consent_records", 1);
    });
    await this.ensureAlarm();
    return { ok: true };
  }

  /** Daily counts since a day (for GET /consent), and today's records against the cap. */
  async consentSummary(sinceDay: string) {
    if (!this.ready) return { days: [], today: 0, limit: null };
    const state = this.getMeta<ContainerState>("container");
    const standing = state ? await accountStanding(this.env, state.account_id) : undefined;
    const days = this.sql
      .exec<{ day: string; method: string; n: number; analytics: number; ads: number; personalization: number }>(
        "SELECT day, method, n, analytics, ads, personalization FROM consent_daily WHERE day >= ? ORDER BY day",
        sinceDay,
      )
      .toArray();
    return {
      days,
      today: this.usage(utcDay(Date.now()), "consent_records"),
      limit: shownCap(containerCaps(this.env, standing).consentRecordsPerDay),
    };
  }

  /** Records newest first: one consent id's history, or all since a time (before = cursor). */
  async consentRecords(f: {
    consent_id?: string;
    since?: number;
    before?: number;
    limit?: number;
  }): Promise<{ records: ConsentRecordRow[]; next_before: number | null }> {
    if (!this.ready) return { records: [], next_before: null };
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const where: string[] = ["at >= ?"];
    const args: (string | number)[] = [f.since ?? 0];
    if (f.consent_id) {
      where.push("consent_id = ?");
      args.push(f.consent_id);
    }
    if (f.before) {
      where.push("seq < ?");
      args.push(f.before);
    }
    const rows = this.sql
      .exec<ConsentRecordRow & { seq: number } & Record<string, SqlStorageValue>>(
        `SELECT seq, consent_id, at, version, analytics, ads, personalization, method, country, language, container_version
         FROM consent_records WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
        ...args,
        limit + 1,
      )
      .toArray() as (ConsentRecordRow & { seq: number })[];
    const page = rows.slice(0, limit);
    return {
      records: page.map(({ seq: _, ...r }) => r as ConsentRecordRow),
      next_before: rows.length > limit ? page[page.length - 1]!.seq : null,
    };
  }

  // ------------------------------------------------------------------ ingest

  private eventRow(source: Origin, id: string): EventRow | null {
    return this.sql.exec<EventRow>("SELECT * FROM events WHERE source = ? AND event_id = ?", source, id).toArray()[0] ?? null;
  }

  /** The latest server-origin conversion with this name + order id (server-side dedupe key). */
  private serverRowByOrder(name: string, orderId: string): EventRow | null {
    return (
      this.sql
        .exec<EventRow>(
          "SELECT * FROM events WHERE transaction_id = ? AND name = ? AND source = 'server' AND type = 'conversion' ORDER BY received_at DESC LIMIT 1",
          orderId,
          name,
        )
        .toArray()[0] ?? null
    );
  }

  /**
   * Insert a row unless (source, event_id) exists. Returns false when it already existed. Callers
   * insert BEFORE enqueueing, with no await in between the dedupe check and this insert, so two
   * concurrent copies of one event can't both be delivered.
   */
  private insertEvent(
    r: Omit<EventRow, "results" | "status" | "preview"> & { results: Record<string, TargetResult>; preview: boolean },
  ): boolean {
    const rows = this.sql
      .exec(
        `INSERT INTO events (${EVENT_COLS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, event_id) DO NOTHING RETURNING event_id`,
        r.event_id,
        r.type,
        r.name,
        r.source,
        r.ts,
        r.received_at,
        r.visitor_id,
        r.transaction_id,
        r.value,
        r.currency,
        r.preview ? 1 : 0,
        aggregateStatus(r.results),
        r.data,
        JSON.stringify(r.results),
        r.note,
      )
      .toArray();
    return rows.length > 0;
  }

  private plannedResults(targets: PlannedTarget[], now: number): Record<string, TargetResult> {
    const results: Record<string, TargetResult> = {};
    for (const t of targets) results[t.destination_id] = { type: t.type, status: t.status, reason: t.reason, attempts: 0, updated_at: now };
    return results;
  }

  /** Send the queued targets to the dispatch queue (the row is already logged). */
  private async enqueue(
    event: DispatchEvent,
    targets: PlannedTarget[],
    results: Record<string, TargetResult>,
    containerId: string,
    now: number,
  ) {
    const queued = targets.filter((t) => t.status === "queued");
    if (!queued.length) return results;
    try {
      await this.env.DISPATCH.sendBatch(
        queued.map((t) => ({
          body: {
            container_id: containerId,
            destination_id: t.destination_id,
            type: t.type,
            test: !!event.test,
            event,
          } satisfies DispatchMessage,
          contentType: "json" as const,
        })),
      );
      return results;
    } catch (e) {
      const failed = { ...results };
      for (const t of queued)
        failed[t.destination_id] = {
          type: t.type,
          status: "failed",
          error: `enqueue failed: ${e instanceof Error ? e.message : String(e)}`,
          attempts: 0,
          updated_at: now,
        };
      this.sql.exec(
        "UPDATE events SET results = ?, status = ? WHERE source = ? AND event_id = ?",
        JSON.stringify(failed),
        aggregateStatus(failed),
        event.source,
        event.event_id,
      );
      return failed;
    }
  }

  // ------------------------------------------------------------------ daily counters and budgets

  /** Today's count of `kind` (browser_events, server_events, deliveries). Only ever incremented. */
  private usage(day: string, kind: string): number {
    return this.sql.exec<{ n: number }>("SELECT n FROM usage WHERE day = ? AND kind = ?", day, kind).toArray()[0]?.n ?? 0;
  }

  private bump(day: string, kind: string, n: number) {
    if (n > 0)
      this.sql.exec(
        "INSERT INTO usage (day, kind, n) VALUES (?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = n + excluded.n",
        day,
        kind,
        n,
      );
  }

  private eventsOn(day: string): EventCounts {
    return { browser: this.usage(day, "browser_events"), server: this.usage(day, "server_events") };
  }

  /** This container's counts as of its last report to D1 today, or null if it hasn't reported today (budgets off). */
  private reportedOn(day: string): EventCounts | null {
    const rows = this.sql
      .exec<{ kind: string; n: number }>(
        "SELECT kind, n FROM usage WHERE day = ? AND kind IN ('browser_events_reported', 'server_events_reported')",
        day,
      )
      .toArray();
    if (!rows.length) return null;
    const n = (kind: string) => rows.find((r) => r.kind === kind)?.n ?? 0;
    return { browser: n("browser_events_reported"), server: n("server_events_reported") };
  }

  private setReported(day: string, c: EventCounts) {
    for (const [kind, n] of [
      ["browser_events_reported", c.browser],
      ["server_events_reported", c.server],
    ] as const)
      this.sql.exec(
        "INSERT INTO usage (day, kind, n) VALUES (?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = MAX(n, excluded.n)",
        day,
        kind,
        n,
      );
  }

  /** The aggregate state for `day` (a new day starts from what this container last reported). */
  private aggFor(day: string) {
    if (this.agg.day !== day)
      this.agg = { day, at: 0, flushed: this.reportedOn(day) ?? NO_EVENTS, account: NO_EVENTS, platform: NO_EVENTS };
    return this.agg;
  }

  /**
   * Today's events on the account's other containers and on the rest of the platform, from the
   * last report to the D1 aggregate (made now if this instance hasn't reported today yet).
   */
  private async othersToday(state: ContainerState, day: string): Promise<Others> {
    if (this.aggFor(day).at === 0) await this.reportOnce(state, day);
    const { flushed, account, platform } = this.agg;
    const minus = (t: EventCounts) => ({
      browser: Math.max(0, t.browser - flushed.browser),
      server: Math.max(0, t.server - flushed.server),
    });
    return { account: minus(account), platform: minus(platform) };
  }

  /** After an ingest: report this container's counts when due (a minute passed, or enough new events). */
  private async reportIfDue(state: ContainerState, budgets: EventBudgets, day: string): Promise<void> {
    if (this.agg.day !== day) return;
    const local = this.eventsOn(day);
    const { flushed, at } = this.agg;
    const fresh = Math.max(local.browser - flushed.browser, local.server - flushed.server);
    if (fresh >= aggregateEvery(budgets) || (fresh > 0 && Date.now() - at >= AGGREGATE_EVERY_MS)) await this.reportOnce(state, day);
  }

  private reportOnce(state: ContainerState, day: string): Promise<void> {
    this.aggInflight ??= this.report(state, day, this.eventsOn(day)).finally(() => {
      this.aggInflight = null;
    });
    return this.aggInflight;
  }

  /**
   * Report this container's counts (absolute and non-decreasing, so a repeat is harmless) and read
   * back the account's and platform's totals; the platform's grows by the delta since the last report.
   */
  private async report(state: ContainerState, day: string, local: EventCounts): Promise<void> {
    const now = Date.now();
    const { flushed } = this.aggFor(day);
    const delta = { browser: Math.max(0, local.browser - flushed.browser), server: Math.max(0, local.server - flushed.server) };
    const totals = await reportEventUsage(this.env.DB, { containerId: state.id, accountId: state.account_id, day, local, delta, now });
    if (!totals) {
      this.agg.at = now; // D1 failed (logged): keep the last totals, try again in a minute
      return;
    }
    this.agg = { day, at: now, flushed: local, ...totals };
    if (this.ready) this.setReported(day, local);
  }

  /** Before deleting: report counts not yet in D1, so re-creating the container frees nothing. No D1 call if it never reported today. */
  private async flushEventUsage() {
    const state = this.getMeta<ContainerState>("container");
    const day = utcDay(Date.now());
    if (!state || !this.reportedOn(day)) return;
    await this.aggInflight;
    const { flushed } = this.aggFor(day);
    const local = this.eventsOn(day);
    if (local.browser > flushed.browser || local.server > flushed.server) await this.reportOnce(state, day);
  }

  /** The account and platform budget `n` more events of `kind` would pass, if any (`used`: this container's today). */
  private overBudget(others: Others | null, b: EventBudgets, kind: keyof EventCounts, used: number, n: number) {
    if (!others) return null;
    const account = others.account[kind] + used;
    if (account + n > b.perAccount) return { scope: "account" as const, limit: b.perAccount, used: account };
    const platform = others.platform[kind] + used;
    if (platform + n > b.platform) return { scope: "platform" as const, limit: b.platform, used: platform };
    return null;
  }

  /** Skip queued targets past the first `granted`, with `reason` (logged on the event). */
  private limitTargets(targets: PlannedTarget[], granted: number, reason: string): PlannedTarget[] {
    let n = 0;
    return targets.map((t) => (t.status !== "queued" || n++ < granted ? t : { ...t, status: "skipped" as const, reason }));
  }

  /** MAX_DELIVERIES_PER_CONTAINER_PER_DAY, applied synchronously before the row is written. */
  private containerBudget(targets: PlannedTarget[], cap: number, day: string): PlannedTarget[] {
    const queued = targets.filter((t) => t.status === "queued").length;
    if (!queued || !Number.isFinite(cap)) return targets;
    const left = Math.max(0, cap - this.usage(day, "deliveries"));
    if (left >= queued) return targets;
    console.warn(`container ${this.getMeta<ContainerState>("container")?.id}: daily delivery budget ${cap} reached`);
    return this.limitTargets(targets, left, `container daily delivery budget (${cap}) reached; deliveries resume at 00:00 UTC`);
  }

  /**
   * Account and platform-wide budgets (D1, see budget.ts), after the row is written (the dedupe
   * insert stays free of awaits); refused targets are rewritten as skipped with the reason.
   */
  private async accountBudget(
    event: DispatchEvent,
    targets: PlannedTarget[],
    results: Record<string, TargetResult>,
    accountId: string,
    standing: Standing,
    now: number,
  ): Promise<{ targets: PlannedTarget[]; results: Record<string, TargetResult> }> {
    const queued = targets.filter((t) => t.status === "queued").length;
    if (!queued) return { targets, results };
    const r = await reserveDeliveries(this.env, accountId, standing, queued, now);
    if (r.granted >= queued) return { targets, results };
    console.warn(`account ${accountId}: ${r.reason}`);
    const next = this.limitTargets(targets, r.granted, r.reason ?? "daily delivery budget reached");
    const planned = this.plannedResults(next, now);
    this.sql.exec(
      "UPDATE events SET results = ?, status = ? WHERE source = ? AND event_id = ?",
      JSON.stringify(planned),
      aggregateStatus(planned),
      event.source,
      event.event_id,
    );
    return { targets: next, results: planned };
  }

  // ------------------------------------------------------------------ attack protection

  private loadProt(): StoredProtection | null {
    if (this.prot === undefined) this.prot = this.getMeta<StoredProtection>("protection");
    return this.prot;
  }

  /** Persist the episode: at once on a change of state or reasons, else at most every 30 s (counts, last_seen_at). */
  private saveProt(force: boolean) {
    const t = Date.now();
    if (!force && t - this.protSavedAt < 30_000) return;
    this.protSavedAt = t;
    this.setMeta("protection", this.prot ?? null);
  }

  /**
   * A trigger: a spike (under_attack) or a network past its share (contained). Opens an episode when
   * none is active, upgrades contained to under_attack, and refreshes last_seen_at (the cooldown
   * counts from it). `detail` replaces the reason's text when given.
   */
  private trigger(kind: "spike" | "network_share", now: number, day: string, detail?: string) {
    const cur = effectiveProtection(this.loadProt(), now);
    const next = kind === "spike" ? "under_attack" : "contained";
    let changed = false;
    let ep: StoredProtection;
    if (!cur || !isActive(cur.state)) {
      ep = { state: next, since: now, last_seen_at: now, ended_at: null, reasons: [], quarantined: 0, q_day: day };
      changed = true;
    } else {
      ep = cur;
      if (next === "under_attack" && ep.state !== "under_attack") {
        ep.state = "under_attack";
        changed = true;
      }
      if (now > ep.last_seen_at) ep.last_seen_at = now;
    }
    const r = ep.reasons.find((x) => x.kind === kind);
    if (!r) {
      ep.reasons.push({
        kind,
        detail: detail ?? (kind === "spike" ? "A sudden spike in browser hits." : "A network passed its daily share."),
      });
      changed = true;
    } else if (detail) r.detail = detail;
    this.prot = ep;
    this.saveProt(changed);
  }

  /** One upsert per hit: this network's hits today (`net` is the Worker's keyed daily hash, never the address). */
  private countNetwork(day: string, net: string): number {
    if (this.netDay !== day) {
      this.sql.exec("DELETE FROM net_daily WHERE day < ?", day);
      this.netDay = day;
    }
    const n =
      this.sql
        .exec<{ n: number }>(
          "INSERT INTO net_daily (day, net, n) VALUES (?, ?, 1) ON CONFLICT(day, net) DO UPDATE SET n = n + 1 RETURNING n",
          day,
          net,
        )
        .toArray()[0]?.n ?? 1;
    if (this.netMax.day === day && n > this.netMax.n) this.netMax.n = n;
    return n;
  }

  /** The most hits one network sent today (read once per object lifetime and day, then kept in step). */
  private networkMax(day: string): number {
    if (this.netMax.day !== day || this.netMax.n < 0)
      this.netMax = {
        day,
        n: this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(n), 0) AS n FROM net_daily WHERE day = ?", day).toArray()[0]?.n ?? 0,
      };
    return this.netMax.n;
  }

  /**
   * The container's usual browser hits per 15-minute window: the previous 7 UTC days' browser_events
   * / 96, counting only days since it existed (no history = 0). Read once per object lifetime and day.
   */
  private usualPerWindow(state: ContainerState, day: string): number {
    if (this.usual.day === day) return this.usual.perWindow;
    const today = Date.parse(`${day}T00:00:00Z`);
    let from = utcDay(today - 7 * DAY);
    if (state.created_at && utcDay(state.created_at) > from) from = utcDay(state.created_at);
    // Objects synced by older code have no created_at; their first counted day stands in.
    const first = this.sql.exec<{ d: string | null }>("SELECT MIN(day) AS d FROM usage WHERE kind = 'browser_events'").toArray()[0]?.d;
    if (!state.created_at && first && first > from) from = first;
    const sum =
      this.sql
        .exec<{ n: number }>("SELECT COALESCE(SUM(n), 0) AS n FROM usage WHERE kind = 'browser_events' AND day >= ? AND day < ?", from, day)
        .toArray()[0]?.n ?? 0;
    const days = Math.max(0, Math.round((today - Date.parse(`${from}T00:00:00Z`)) / DAY));
    const perWindow = days > 0 ? sum / (days * (DAY / SPIKE_WINDOW_MS)) : 0;
    this.usual = { day, perWindow };
    return perWindow;
  }

  /** Count a hit in the current window; past max(SPIKE_FACTOR x usual, SPIKE_MIN) it's a spike. In memory only. */
  private countWindow(state: ContainerState, day: string, now: number) {
    const start = now - (now % SPIKE_WINDOW_MS);
    if (this.win.start !== start) this.win = { start, n: 0 };
    const n = ++this.win.n;
    const min = spikeMin(this.env);
    if (n < min) return; // the usual rate is read only past the floor
    const usual = this.usualPerWindow(state, day);
    if (n >= spikeThreshold(usual, min))
      this.trigger(
        "spike",
        now,
        day,
        `${n} browser hits in 15 minutes; usually about ${Math.round(usual)} (a spike is ${SPIKE_FACTOR}x that, and at least ${min}).`,
      );
  }

  /**
   * Attack protection for one live browser hit (preview links carry a valid token and are exempt):
   * count its network and the window, then decide whether it's quarantined and whether browser
   * conversions are held. With protection "off" detection still runs but nothing is set aside.
   */
  private guard(hit: CollectHit, state: ContainerState, standing: Standing, day: string, now: number) {
    const mode = parseMode(state.protection);
    const caps = protectionCaps(this.env, standing);
    let overShare = false;
    if (Number.isFinite(caps.perNetwork) && hit.enrich.net_hash) {
      const n = this.countNetwork(day, hit.enrich.net_hash);
      if (n > caps.perNetwork) {
        overShare = true;
        let detail: string | undefined;
        if (n === caps.perNetwork + 1) {
          this.bump(day, "networks_over_share", 1);
          const nets = this.usage(day, "networks_over_share");
          detail = `${nets} network${nets === 1 ? "" : "s"} passed ${caps.perNetwork} browser hits today; the rest of their hits today are quarantined.`;
        }
        this.trigger("network_share", now, day, detail);
      }
    }
    // A network over its share is already contained: it doesn't count towards a spike.
    if (!overShare) this.countWindow(state, day, now);
    const on = measuresOn(mode, effectiveProtection(this.loadProt(), now)?.state ?? "none");
    let quarantine: QuarantineReason | null = null;
    if (mode !== "off") {
      if (overShare) quarantine = "network_share";
      else if (on && isDatacenterAsn(hit.enrich.asn)) quarantine = "datacenter";
    }
    return { mode, caps, quarantine, hold: on };
  }

  /** Today's quarantine counters: by reason, and the hits past MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY that weren't logged. */
  private quarantineCounts(day: string) {
    const rows = this.sql
      .exec<{ kind: string; n: number }>(
        "SELECT kind, n FROM usage WHERE day = ? AND kind IN ('q:network_share', 'q:datacenter', 'q_dropped')",
        day,
      )
      .toArray();
    const n = (k: string) => rows.find((r) => r.kind === k)?.n ?? 0;
    const network_share = n("q:network_share");
    const datacenter = n("q:datacenter");
    return { network_share, datacenter, total: network_share + datacenter, dropped: n("q_dropped") };
  }

  /**
   * A quarantined hit: counted, logged for review (status "quarantined", with the reason and network
   * operator) up to the daily cap, never delivered, never stored as a visitor or a page, and not
   * counted against the daily event budgets.
   */
  private quarantineHit(hit: CollectHit, eventId: string, reason: QuarantineReason, cap: number, day: string, now: number): CollectResult {
    const p = hit.payload;
    const before = Number.isFinite(cap) ? this.quarantineCounts(day) : null;
    this.bump(day, `q:${reason}`, 1);
    const ep = effectiveProtection(this.loadProt(), now);
    if (ep && isActive(ep.state)) {
      if (ep.q_day !== day) [ep.q_day, ep.quarantined] = [day, 0];
      ep.quarantined++;
      const add = reason === "datacenter" && !ep.reasons.some((r) => r.kind === "datacenter");
      if (add)
        ep.reasons.push({
          kind: "datacenter",
          detail:
            "Browser hits from data-centre networks (hosting and cloud providers) are quarantined while the container is under attack.",
        });
      this.prot = ep;
      this.saveProt(add);
    }
    if (before && before.total - before.dropped >= cap) {
      this.bump(day, "q_dropped", 1);
      return { ok: true, event_id: eventId };
    }
    if (p.type === "tags") return { ok: true, event_id: eventId }; // telemetry: counted only
    const conversion = p.type === "conversion";
    const d = hit.enrich.device;
    this.sql.exec(
      `INSERT INTO events (${EVENT_COLS}, quarantine, asn, as_org)
       VALUES (?, ?, ?, 'browser', ?, ?, NULL, NULL, ?, ?, ?, 'quarantined', ?, '{}', ?, ?, ?, ?)
       ON CONFLICT(source, event_id) DO NOTHING`,
      eventId,
      conversion ? "conversion" : "visit",
      conversion ? (p.name ?? "conversion") : "page_view",
      now,
      now,
      conversion ? (p.value ?? null) : null,
      conversion ? (p.currency ?? null) : null,
      hit.test ? 1 : 0,
      JSON.stringify({ page: pageOf(p.page_url), country: hit.enrich.geo?.country, browser: d?.browser, os: d?.os }),
      reason === "network_share"
        ? "Quarantined: this network passed its daily share of browser hits for the container. Never sent to destinations."
        : "Quarantined: a data-centre network while attack measures were on. Never sent to destinations.",
      reason,
      hit.enrich.asn ?? null,
      hit.enrich.as_org ?? null,
    );
    return { ok: true, event_id: eventId };
  }

  /** Attack measures on: a browser conversion's server-side deliveries are skipped (held) with the reason. */
  private hold(targets: PlannedTarget[], mode: ProtectionMode, day: string): PlannedTarget[] {
    if (!targets.some((t) => t.status === "queued")) return targets;
    this.bump(day, "held_conversions", 1);
    const reason = heldReason(mode);
    return targets.map((t) => (t.status === "queued" ? { ...t, status: "skipped" as const, reason } : t));
  }

  /** The container's protection as of `now` (next_steps are added by the Worker, which knows the public URL). */
  private protectionView(state: ContainerState | null, now: number, standing: Standing = CLAIMED): ProtectionView {
    const mode = parseMode(state?.protection);
    const day = utcDay(now);
    const ep = effectiveProtection(this.ready ? this.loadProt() : null, now);
    const st = ep?.state ?? "none";
    const on = measuresOn(mode, st);
    const cap = protectionCaps(this.env, standing).perNetwork;
    return {
      mode,
      state: st,
      since: ep?.since ?? null,
      last_seen_at: ep?.last_seen_at ?? null,
      ended_at: ep?.state === "ended" ? ep.ended_at : null,
      reasons: ep?.reasons ?? [],
      quarantined: !ep ? 0 : isActive(st) && ep.q_day !== day ? 0 : ep.quarantined,
      quarantined_today: this.ready ? this.quarantineCounts(day).total : 0,
      conversions_held_today: this.ready ? this.usage(day, "held_conversions") : 0,
      measures: {
        network_share_limit: mode !== "off" && Number.isFinite(cap) ? cap : null,
        datacenter_quarantine: on,
        browser_conversions_held: on,
      },
    };
  }

  /** GET /v1/containers/:id protection (and tests, with another `now`). */
  async protection(now = Date.now()): Promise<ProtectionView> {
    const state = this.getMeta<ContainerState>("container");
    const standing = state ? await accountStanding(this.env, state.account_id) : undefined;
    return this.protectionView(state, now, standing);
  }

  /** GET /v1/containers/:id/quarantine: what was set aside since `since` (the log keeps 7 days). */
  async quarantineSummary(since: number, now = Date.now()) {
    const state = this.getMeta<ContainerState>("container");
    const standing = state ? await accountStanding(this.env, state.account_id) : CLAIMED;
    const protection = this.protectionView(state, now, standing);
    const day = utcDay(now);
    const empty = {
      protection,
      by_day: [] as { day: string; reason: string; type: string; n: number }[],
      networks: [] as { asn: number | null; as_org: string | null; n: number }[],
      countries: [] as { country: string | null; n: number }[],
      pages: [] as { page: string | null; n: number }[],
      browsers: [] as { browser: string | null; os: string | null; n: number }[],
      today: { network_share: 0, datacenter: 0, total: 0, dropped: 0 },
      networks_over_share_today: 0,
    };
    if (!this.ready) return empty;
    const W = "FROM events WHERE quarantine IS NOT NULL AND received_at >= ?";
    const rows = <T>(q: string) => this.sql.exec<T & Record<string, SqlStorageValue>>(q, since).toArray() as T[];
    return {
      ...empty,
      by_day: rows<{ day: string; reason: string; type: string; n: number }>(
        `SELECT strftime('%Y-%m-%d', received_at / 1000, 'unixepoch') AS day, quarantine AS reason, type, COUNT(*) AS n ${W} GROUP BY 1, 2, 3 ORDER BY 1`,
      ),
      networks: rows<{ asn: number | null; as_org: string | null; n: number }>(
        `SELECT asn, as_org, COUNT(*) AS n ${W} GROUP BY asn, as_org ORDER BY n DESC LIMIT 10`,
      ),
      countries: rows<{ country: string | null; n: number }>(
        `SELECT json_extract(data, '$.country') AS country, COUNT(*) AS n ${W} GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      ),
      pages: rows<{ page: string | null; n: number }>(
        `SELECT json_extract(data, '$.page') AS page, COUNT(*) AS n ${W} GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      ),
      browsers: rows<{ browser: string | null; os: string | null; n: number }>(
        `SELECT json_extract(data, '$.browser') AS browser, json_extract(data, '$.os') AS os, COUNT(*) AS n ${W} GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`,
      ),
      today: this.quarantineCounts(day),
      networks_over_share_today: this.usage(day, "networks_over_share"),
    };
  }

  async collect(hit: CollectHit): Promise<CollectResult> {
    const state = this.getMeta<ContainerState>("container");
    if (!state) return { ok: false, error: "not_synced" };
    const p = hit.payload;
    const host = hit.enrich.origin_host ?? originHost(undefined, p.page_url);
    if (!hit.preview_config && (!host || !hostAllowed(host, state)))
      return { ok: false, error: "origin_not_allowed", host: host ?? undefined };
    const standing = await accountStanding(this.env, state.account_id);
    if (standing.suspended) return { ok: false, error: "suspended" };
    const caps = containerCaps(this.env, standing);
    const budgets = eventBudgets(this.env, standing);
    const now = hit.enrich.received_at;
    const day = utcDay(now);
    const eventId = p.event_id ?? `${p.type === "visit" ? "v" : "e"}_${randomString(20)}`;
    const duplicate: CollectResult = { ok: true, event_id: eventId, duplicate: true };
    // The account's and platform's totals, only when a budget is set (the D1 call, if any, is here).
    const others = needsAggregate(budgets) ? await this.othersToday(state, day) : null;

    // Dedupe among browser rows first (retried beacons, double-fired triggers) so counters don't
    // move. Everything from here to insertEvent is synchronous, so the check can't be raced.
    if (this.eventRow("browser", eventId)) return duplicate;
    // Public ingest stops writing when the database or today's event quota (or budget) is full.
    if (this.sql.databaseSize > caps.dbBytes) return { ok: false, error: "storage_full", limit: caps.dbBytes };
    const live = !hit.preview_config;
    // Attack protection, before the budgets: quarantined hits don't count against them.
    const guard = live ? this.guard(hit, state, standing, day, now) : null;
    if (guard?.quarantine) {
      const r = this.quarantineHit(hit, eventId, guard.quarantine, guard.caps.quarantinedPerDay, day, now);
      await this.ensureAlarm();
      return r;
    }
    const used = this.usage(day, "browser_events");
    if (used >= caps.eventsPerDay) return { ok: false, error: "quota", scope: "container", limit: caps.eventsPerDay };
    const over = this.overBudget(others, budgets, "browser", used, 1);
    if (over) return { ok: false, error: "quota", scope: over.scope, limit: over.limit };
    // Test traffic (preview, ?afsa_debug=1, afst('test', true)) is logged as test and delivered in
    // test mode; it never creates, updates or joins a visitor (so it can't lend one click ids,
    // hashes or consent), and browser hits never link identities anyway.
    const test = !!hit.test || !live;
    if (p.type === "tags") {
      // settings.report_tag_fires: one hit per page with per-tag counts (a browser event for quotas).
      this.bump(day, "browser_events", 1);
      if (live) {
        this.recordTagFires(hit.env_config ?? this.getMeta<ContainerConfig>("config"), p.fires ?? [], now);
        this.recordPage(p.page_url, now);
      }
      if (others) await this.reportIfDue(state, budgets, day);
      await this.ensureAlarm();
      return { ok: true, event_id: eventId };
    }
    if (live) this.recordPage(p.page_url, now);
    const visitor = p.visitor_id && !test ? this.upsertVisitor(p.visitor_id, visitorUpdateFromHit(hit), now, caps.visitors) : null;

    if (p.type === "visit") {
      const inserted = this.insertEvent({
        event_id: eventId,
        type: "visit",
        name: "page_view",
        source: "browser",
        ts: now,
        received_at: now,
        visitor_id: p.visitor_id ?? null,
        transaction_id: null,
        value: null,
        currency: null,
        preview: test,
        data: JSON.stringify({
          page_url: p.page_url,
          referrer: p.referrer,
          click_ids: Object.keys(p.click_ids ?? {}),
          utm: p.utm,
          consent: p.consent,
          geo: hit.enrich.geo?.country,
        }),
        results: {},
        note: null,
      });
      if (!inserted) return duplicate;
      this.bump(day, "browser_events", 1);
      if (others) await this.reportIfDue(state, budgets, day);
      return { ok: true, event_id: eventId, visitor_id: p.visitor_id };
    }

    const config = hit.preview_config ?? hit.env_config ?? this.getMeta<ContainerConfig>("config");
    const conversion = findConversion(config, p.name);
    const event = browserDispatchEvent(hit, visitor, conversion, eventId);
    let targets: PlannedTarget[] = [];
    let note: string | null = null;
    if (!conversion) note = `No conversion named "${p.name}" in the ${hit.preview_config ? "draft" : "live config"}; logged only.`;
    else if (!conversion.server) note = "server: false; delivered by browser tags only.";
    else {
      // Server events are the source of truth: if the backend already reported this conversion
      // (same event_id, or same name + order id), the browser copy isn't sent server-side again.
      const server =
        this.eventRow("server", eventId) ?? (event.transaction_id ? this.serverRowByOrder(event.name, event.transaction_id) : null);
      if (server)
        note = `The backend already sent this conversion server-side (event ${server.event_id}); the browser copy is logged only.`;
      else {
        let plan = planDispatch(event, this.getMeta<DestinationInfo[]>("destinations") ?? [], { matched: true, now });
        // Under attack (or protection strict): browser conversions aren't forwarded to ad platforms.
        if (guard?.hold) {
          const held = this.hold(plan, guard.mode, day);
          if (held !== plan)
            note =
              guard.mode === "strict"
                ? "Held: protection is strict, so browser conversions aren't forwarded server-side. Send this conversion from your backend (POST /v1/containers/:id/events)."
                : "Held: the container is under attack, so browser conversions aren't forwarded to ad platforms until it ends. Your backend's conversions (POST /v1/containers/:id/events) are still delivered.";
          plan = held;
        }
        targets = this.containerBudget(plan, caps.deliveriesPerDay, day);
      }
    }
    let planned = this.plannedResults(targets, now);
    const inserted = this.insertEvent({
      event_id: eventId,
      type: "conversion",
      name: event.name,
      source: "browser",
      ts: event.ts,
      received_at: now,
      visitor_id: p.visitor_id ?? null,
      transaction_id: event.transaction_id ?? null,
      value: event.value ?? null,
      currency: event.currency ?? null,
      preview: test,
      // The log keeps no raw IP, user agent, city or postal code (src/service/privacy.ts); the
      // queue messages enqueued below carry them for delivery only.
      data: JSON.stringify(eventForLog(event)),
      results: planned,
      note,
    });
    if (!inserted) return duplicate;
    this.bump(day, "browser_events", 1);
    this.bump(day, "deliveries", targets.filter((t) => t.status === "queued").length);
    ({ targets, results: planned } = await this.accountBudget(event, targets, planned, state.account_id, standing, now));
    await this.enqueue(event, targets, planned, state.id, now);
    if (others) await this.reportIfDue(state, budgets, day);
    await this.ensureAlarm();
    return { ok: true, event_id: eventId, visitor_id: p.visitor_id, destinations: targets, ...(note ? { note } : {}) };
  }

  /**
   * Backend events (authenticated by API key) are the source of truth. They're deduped only
   * against earlier server events (same event_id, or same name + order_id). Browser rows, which
   * anyone can post to /collect, never make a server event a duplicate, never lend it their
   * event_id, visitor, values or skip rules, and are never overwritten by it. They join a visitor
   * by user_id / email / phone only when the backend itself linked that visitor (an earlier event
   * with its visitor_id), and such a join never carries the visitor's consent or click ids.
   */
  async ingestServer(events: ServerEvent[], opts: { test: boolean; now: number }): Promise<ServerIngestResult[] | IngestRefusal> {
    const state = this.getMeta<ContainerState>("container");
    if (!state) return { error: "not_synced" };
    const standing = await accountStanding(this.env, state.account_id);
    if (standing.suspended) return { error: "suspended" };
    const caps = containerCaps(this.env, standing);
    const budgets = eventBudgets(this.env, standing);
    const day = utcDay(opts.now);
    const others = needsAggregate(budgets) ? await this.othersToday(state, day) : null;
    if (this.sql.databaseSize > caps.dbBytes * SERVER_STORAGE_HEADROOM) return { error: "storage_full", limit: caps.dbBytes };
    const used = this.usage(day, "server_events");
    if (used + events.length > caps.eventsPerDay) return { error: "quota", scope: "container", limit: caps.eventsPerDay, used };
    const over = this.overBudget(others, budgets, "server", used, events.length);
    if (over) return { error: "quota", ...over };
    const config = this.getMeta<ContainerConfig>("config");
    const destinations = this.getMeta<DestinationInfo[]>("destinations") ?? [];
    const phoneCc = config?.settings?.phone_country_code;
    const out: ServerIngestResult[] = [];
    for (const ev of events) {
      const now = opts.now;
      const user = serverUserData(ev, phoneCc);
      // Join to a stored visitor: visitor_id > user_id > email hash > phone hash (the last three
      // only match identities a backend linked to the visitor).
      let visitorId: string | null = null;
      let by: string | null = null;
      if (ev.visitor_id && this.loadVisitor(ev.visitor_id)) [visitorId, by] = [ev.visitor_id, "visitor_id"];
      if (!visitorId && ev.user_id) [visitorId, by] = [this.findVisitorId("user_id", ev.user_id), "user_id"];
      if (!visitorId && user.em) [visitorId, by] = [this.findVisitorId("em", user.em), "email"];
      if (!visitorId && user.ph) [visitorId, by] = [this.findVisitorId("ph", user.ph), "phone"];
      if (!visitorId) by = null;
      const inherit = by === "visitor_id";
      const conversion = findConversion(config, ev.name);

      const eventId = serverEventId(ev, () => randomString(20));
      const existing = this.eventRow("server", eventId) ?? (ev.order_id ? this.serverRowByOrder(ev.name, ev.order_id) : null);
      if (existing) {
        const v = visitorId ? this.loadVisitor(visitorId) : null;
        out.push({
          event_id: existing.event_id,
          name: ev.name,
          status: "duplicate",
          joined: { by, visitor_id: visitorId, click_ids: inherit ? Object.keys(v?.click_ids ?? {}) : [] },
          conversion: conversion?.name ?? null,
          destinations: [],
          note: "Already received from your backend (dedupe by event_id, or name + order_id).",
        });
        continue;
      }
      const visitor = visitorId
        ? this.upsertVisitor(
            visitorId,
            {
              user,
              user_id: ev.user_id,
              click_ids: ev.click_ids,
              fbc: ev.fbc,
              fbp: ev.fbp,
              conversion: true,
              // The backend says this visitor is this user: later events may join by these.
              link: { user_id: ev.user_id, em: user.em, ph: user.ph },
            },
            now,
          )
        : null;
      const event = serverDispatchEvent(ev, {
        eventId,
        visitor,
        visitorId: visitorId ?? undefined,
        user,
        conversion,
        test: opts.test,
        now,
        inherit,
      });
      const joined = { by, visitor_id: visitorId, click_ids: Object.keys(event.click_ids) };
      let targets = this.containerBudget(
        planDispatch(event, destinations, { only: ev.destinations, matched: !!conversion, now }),
        caps.deliveriesPerDay,
        day,
      );
      const notes: string[] = [];
      if (!conversion && !ev.send_to) {
        notes.push(
          `No conversion named "${ev.name}" in the live config and no send_to in the event: only analytics destinations and webhooks with settings.all_events receive it. Define conversions[].name = "${ev.name}" (with send_to) or pass send_to.`,
        );
      }
      if (visitorId && !inherit)
        notes.push(
          `Joined by ${by}: the visitor's consent and click ids aren't inherited through a ${by} join. Pass consent and click_ids in the event, or the browser's visitor_id.`,
        );
      if (opts.test && ev.visitor_id && !inherit)
        notes.push(
          `No stored visitor ${ev.visitor_id}: browser test traffic (preview, ?afsa_debug=1, afst('test', true)) never stores one, and real hits store one only when consent allows a visitor id. Pass click_ids, fbp/fbc and consent in the test event to test with them.`,
        );
      const note = notes.length ? notes.join(" ") : undefined;
      let planned = this.plannedResults(targets, now);
      const inserted = this.insertEvent({
        event_id: eventId,
        type: "conversion",
        name: ev.name,
        source: "server",
        ts: event.ts,
        received_at: now,
        visitor_id: visitorId,
        transaction_id: ev.order_id ?? null,
        value: ev.value ?? null,
        currency: ev.currency ?? null,
        preview: opts.test,
        // The log keeps no raw IP, user agent, city or postal code (src/service/privacy.ts); the
        // queue messages enqueued below carry them for delivery only.
        data: JSON.stringify(eventForLog(event)),
        results: planned,
        note: note ?? null,
      });
      if (!inserted) {
        out.push({
          event_id: eventId,
          name: ev.name,
          status: "duplicate",
          joined,
          conversion: conversion?.name ?? null,
          destinations: [],
          note: "Already received from your backend (dedupe by event_id).",
        });
        continue;
      }
      this.bump(day, "server_events", 1);
      this.bump(day, "deliveries", targets.filter((t) => t.status === "queued").length);
      ({ targets, results: planned } = await this.accountBudget(event, targets, planned, state.account_id, standing, now));
      await this.enqueue(event, targets, planned, state.id, now);
      out.push({
        event_id: eventId,
        name: ev.name,
        status: "accepted",
        joined,
        conversion: conversion?.name ?? null,
        destinations: targets,
        ...(note ? { note } : {}),
      });
    }
    if (others) await this.reportIfDue(state, budgets, day);
    await this.ensureAlarm();
    return out;
  }

  /** Write a destination's delivery result back to the event log (called by the queue consumer). */
  async recordResult(eventId: string, destinationId: string, result: Omit<TargetResult, "updated_at">, source: Origin = "browser") {
    if (!this.ready) return { ok: false };
    const row = this.eventRow(source, eventId);
    if (!row) return { ok: false };
    const results = JSON.parse(row.results) as Record<string, TargetResult>;
    results[destinationId] = { ...result, updated_at: Date.now() };
    this.sql.exec(
      "UPDATE events SET results = ?, status = ? WHERE source = ? AND event_id = ?",
      JSON.stringify(results),
      aggregateStatus(results),
      source,
      eventId,
    );
    return { ok: true };
  }

  // ------------------------------------------------------------------ reads

  async listEvents(f: EventFilter) {
    if (!this.ready) return { events: [], next_before: null };
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (!f.include_visits && f.name !== "page_view") where.push("type != 'visit'");
    // Quarantined hits (attack protection) only with status=quarantined: the log shows real traffic first.
    if (!f.status) where.push("status != 'quarantined'");
    if (f.name) where.push("name = ?"), args.push(f.name);
    if (f.status) where.push("status = ?"), args.push(f.status);
    if (f.source) where.push("source = ?"), args.push(f.source);
    if (f.since) where.push("received_at >= ?"), args.push(f.since);
    if (f.before) where.push("received_at < ?"), args.push(f.before);
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const rows = this.sql
      .exec<EventRow>(
        `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC LIMIT ${limit + 1}`,
        ...args,
      )
      .toArray();
    const page = rows.slice(0, limit);
    return {
      events: page.map((r) => this.present(r, !!f.verbose)),
      next_before: rows.length > limit ? page[page.length - 1]!.received_at : null,
    };
  }

  /**
   * One event-log entry. Strings that anyone could have written (page URLs, titles, referrers,
   * params, items, browser order ids, user agents, destination answers and the exact requests
   * sent) are only ever under an `untrusted` key; everything else is ids, numbers, statuses and
   * this service's own notes.
   */
  private present(r: EventRow, verbose: boolean) {
    if (r.quarantine) return this.presentQuarantined(r);
    const results = JSON.parse(r.results) as Record<string, TargetResult>;
    const { [LOG_IDENTITY]: identity, ...data } = JSON.parse(r.data) as Record<string, unknown>;
    const isConversion = r.type === "conversion";
    const browser = r.source === "browser";
    const untrusted: Record<string, unknown> = {};
    if (!isConversion) untrusted.page = data;
    if (browser && r.transaction_id) untrusted.transaction_id = r.transaction_id;
    if (verbose && isConversion) untrusted.data = data;
    return {
      event_id: r.event_id,
      type: r.type,
      name: r.name,
      source: r.source,
      ts: r.ts,
      received_at: r.received_at,
      visitor_id: r.visitor_id,
      // Backend order ids are yours; a browser's is under untrusted.transaction_id.
      transaction_id: browser ? null : r.transaction_id,
      value: r.value,
      currency: r.currency,
      preview: !!r.preview,
      // The clearer name for the same flag: preview hits, browser test traffic, test: true backend events.
      test: !!r.preview,
      status: r.status,
      ...(r.note ? { note: r.note } : {}),
      ...(isConversion
        ? {
            // What the event carried when it was delivered (the row itself keeps less, see eventForLog).
            identity: (identity as ReturnType<typeof identitySummary> | undefined) ?? identitySummary(data as unknown as DispatchEvent),
            fired_in_browser: (data.fired as string[] | undefined) ?? [],
          }
        : {}),
      destinations: Object.entries(results).map(([id, res]) => {
        const { request, response, ...rest } = res;
        const u: Record<string, unknown> = {};
        if (response !== undefined) u.response = response;
        if (verbose && request !== undefined) u.request = request;
        return { destination_id: id, ...rest, ...(Object.keys(u).length ? { untrusted: u } : {}) };
      }),
      ...(Object.keys(untrusted).length ? { untrusted } : {}),
    };
  }

  /** A quarantined hit: only what the summary keeps (page, country, browser, os), never delivered. */
  private presentQuarantined(r: EventRow) {
    return {
      event_id: r.event_id,
      type: r.type,
      name: r.name,
      source: r.source,
      ts: r.ts,
      received_at: r.received_at,
      value: r.value,
      currency: r.currency,
      test: !!r.preview,
      status: r.status,
      quarantine: r.quarantine,
      network: { asn: r.asn ?? null, as_org: r.as_org ?? null },
      ...(r.note ? { note: r.note } : {}),
      destinations: [],
      // Page and browser come from the hit (anyone can post to /collect).
      untrusted: { page: JSON.parse(r.data) as Record<string, unknown> },
    };
  }

  async stats() {
    if (!this.ready)
      return {
        synced: false,
        live_config_loaded: false,
        last_24h: { visits: 0, conversions: 0, conversion_status: {}, last_visit_at: null, last_conversion_at: null },
        visitors_stored: 0,
      };
    const since = Date.now() - DAY;
    const one = <T>(q: string, ...a: (string | number)[]) => this.sql.exec<T & Record<string, SqlStorageValue>>(q, ...a).toArray()[0] as T;
    // Quarantined hits (attack protection) aren't visits or conversions: they're counted apart.
    const ev = one<{ visits: number; conversions: number; quarantined: number; last_visit: number | null; last_conversion: number | null }>(
      `SELECT SUM(type = 'visit' AND quarantine IS NULL) AS visits, SUM(type = 'conversion' AND quarantine IS NULL) AS conversions,
              SUM(quarantine IS NOT NULL) AS quarantined,
              MAX(CASE WHEN type = 'visit' AND quarantine IS NULL THEN received_at END) AS last_visit,
              MAX(CASE WHEN type = 'conversion' AND quarantine IS NULL THEN received_at END) AS last_conversion
       FROM events WHERE received_at >= ?`,
      since,
    );
    const st = this.sql
      .exec<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM events WHERE type = 'conversion' AND quarantine IS NULL AND received_at >= ? GROUP BY status",
        since,
      )
      .toArray();
    const visitors = one<{ n: number }>("SELECT COUNT(*) AS n FROM visitors");
    const config = this.getMeta<ContainerConfig>("config");
    const state = this.getMeta<ContainerState>("container");
    const standing = state ? await accountStanding(this.env, state.account_id) : undefined;
    const caps = containerCaps(this.env, standing);
    const budgets = eventBudgets(this.env, standing);
    const day = utcDay(Date.now());
    const totals = state && needsAggregate(budgets) ? await this.totalsToday(state, day) : null;
    const reached = (t: EventCounts | undefined, cap: number) => !!t && (t.browser >= cap || t.server >= cap);
    const bytes = this.sql.databaseSize;
    const today = {
      day,
      browser_events: this.usage(day, "browser_events"),
      server_events: this.usage(day, "server_events"),
      deliveries: this.usage(day, "deliveries"),
      // Summed over the account's containers (up to a minute behind for the others).
      ...(totals && Number.isFinite(budgets.perAccount)
        ? { account: { browser_events: totals.account.browser, server_events: totals.account.server } }
        : {}),
    };
    return {
      synced: !!state,
      live_config_loaded: !!config,
      last_24h: {
        visits: ev?.visits ?? 0,
        conversions: ev?.conversions ?? 0,
        conversion_status: Object.fromEntries(st.map((s) => [s.status, s.n])),
        quarantined: ev?.quarantined ?? 0,
        last_visit_at: ev?.last_visit ?? null,
        last_conversion_at: ev?.last_conversion ?? null,
      },
      visitors_stored: visitors?.n ?? 0,
      today,
      protection: this.protectionView(state ?? null, Date.now(), standing),
      limits: {
        events_per_day: shownCap(caps.eventsPerDay),
        events_per_account_per_day: shownCap(budgets.perAccount),
        platform_events_per_day: shownCap(budgets.platform),
        deliveries_per_day: shownCap(caps.deliveriesPerDay),
        visitors: shownCap(caps.visitors),
        db_bytes: shownCap(caps.dbBytes),
      },
      storage: { bytes, limit: shownCap(caps.dbBytes), full: bytes > caps.dbBytes },
      quota_reached: today.browser_events >= caps.eventsPerDay,
      // Browser hits or backend events refused by the account's or the platform's daily budget.
      account_quota_reached: reached(totals?.account, budgets.perAccount),
      platform_quota_reached: reached(totals?.platform, budgets.platform),
    };
  }

  /**
   * For GET /v1/usage (called hourly by the platform for every claimed project, so no scans):
   * `day`'s counters (point reads), the visitor count eviction keeps (counted once per object
   * lifetime) and the database size. No D1 call; an object never synced answers zeros.
   */
  async usageToday(day: string, standing: Standing = CLAIMED, now = Date.now()): Promise<ContainerUsage> {
    const state = this.getMeta<ContainerState>("container");
    const protection = this.protectionView(state, now, standing);
    if (!this.ready)
      return {
        browser_events: 0,
        server_events: 0,
        deliveries: 0,
        visitors: 0,
        db_bytes: 0,
        quarantined: 0,
        network_max: 0,
        consent_records: 0,
        protection,
      };
    this.visitorCount ??= this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM visitors").toArray()[0]?.n ?? 0;
    return {
      browser_events: this.usage(day, "browser_events"),
      server_events: this.usage(day, "server_events"),
      deliveries: this.usage(day, "deliveries"),
      visitors: this.visitorCount,
      db_bytes: this.sql.databaseSize,
      quarantined: this.quarantineCounts(day).total,
      network_max: this.networkMax(day),
      consent_records: this.usage(day, "consent_records"),
      protection,
    };
  }

  /** The account's and platform's events today, this container's included (reported first if behind or over a minute old). */
  private async totalsToday(state: ContainerState, day: string): Promise<Others> {
    const agg = this.aggFor(day);
    const local = this.eventsOn(day);
    if (
      agg.at === 0 ||
      Date.now() - agg.at >= AGGREGATE_EVERY_MS ||
      local.browser > agg.flushed.browser ||
      local.server > agg.flushed.server
    )
      await this.reportOnce(state, day);
    const others = await this.othersToday(state, day);
    const mine = this.eventsOn(day);
    const plus = (t: EventCounts) => ({ browser: t.browser + mine.browser, server: t.server + mine.server });
    return { account: plus(others.account), platform: plus(others.platform) };
  }
}

/** host + path of a page URL (no query or fragment), for the quarantine summary. */
function pageOf(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "/"}`;
  } catch {
    return null;
  }
}
