import { DurableObject } from "cloudflare:workers";
import { accountStanding, randomString, type Standing } from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import type { DispatchEvent } from "../destinations/types";
import type { Bindings } from "../env";
import { reserveDeliveries } from "../service/budget";
import { aggregateStatus, type DestinationInfo, planDispatch, type PlannedTarget, type TargetResult } from "../service/dispatch-plan";
import { mergeVisitor, type VisitorData, type VisitorUpdate } from "../service/identity";
import { containerCaps, shownCap, utcDay } from "../service/limits";
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
import type { ServerEvent } from "../service/ingest-schema";
import { hostAllowed, originHost } from "../service/origin";

export const EVENT_RETENTION_DAYS = 7;
export const VISITOR_RETENTION_DAYS = 180;
const DAY = 86_400_000;
/** Backend events keep working past MAX_CONTAINER_DB_BYTES up to this factor, so a /collect flood can't block them. */
export const SERVER_STORAGE_HEADROOM = 1.25;

export interface ContainerState {
  id: string;
  account_id: string;
  domain: string;
  allowed_hostnames: string[];
  live_version: number | null;
}

export interface DispatchMessage {
  container_id: string;
  destination_id: string;
  type: string;
  test: boolean;
  event: DispatchEvent;
}

export type CollectResult =
  | { ok: true; event_id: string; duplicate?: boolean; visitor_id?: string; destinations?: PlannedTarget[]; note?: string }
  | { ok: false; error: "not_synced" | "origin_not_allowed" | "suspended"; host?: string }
  | { ok: false; error: "quota" | "storage_full"; limit: number };

export type IngestRefusal =
  | { error: "not_synced" | "suspended" }
  | { error: "quota"; limit: number; used: number }
  | { error: "storage_full"; limit: number };

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
};

/** Event log rows are keyed by (source, event_id): browser and server rows never collide. */
type Origin = "browser" | "server";

const SCHEMA_VERSION = 3;
const EVENTS_DDL = `
  CREATE TABLE events (
    event_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
    ts INTEGER NOT NULL, received_at INTEGER NOT NULL, visitor_id TEXT, transaction_id TEXT,
    value REAL, currency TEXT, preview INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    data TEXT NOT NULL, results TEXT NOT NULL DEFAULT '{}', note TEXT,
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
 */
export class ContainerDO extends DurableObject<Bindings> {
  private sql: SqlStorage;
  /** Tables exist. False for an id that was never initialised through the API. */
  private ready: boolean;

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
      if (version < SCHEMA_VERSION) this.setMeta("schema", SCHEMA_VERSION);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
        CREATE INDEX IF NOT EXISTS events_name ON events(name, received_at);
        CREATE INDEX IF NOT EXISTS events_txn ON events(transaction_id, name, source);
      `);
    });
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

  async destroy() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
    this.visitorCount = null;
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
    this.sql.exec("DELETE FROM usage WHERE day < ?", utcDay(now - 3 * DAY));
    this.visitorCount = null;
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
    if (!Number.isFinite(cap)) return;
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
    const now = hit.enrich.received_at;
    const day = utcDay(now);
    const eventId = p.event_id ?? `${p.type === "visit" ? "v" : "e"}_${randomString(20)}`;
    const duplicate: CollectResult = { ok: true, event_id: eventId, duplicate: true };

    // Dedupe among browser rows first (retried beacons, double-fired triggers) so counters don't
    // move. Everything from here to insertEvent is synchronous, so the check can't be raced.
    if (this.eventRow("browser", eventId)) return duplicate;
    // Public ingest stops writing when the database or today's event quota is full.
    if (this.sql.databaseSize > caps.dbBytes) return { ok: false, error: "storage_full", limit: caps.dbBytes };
    if (this.usage(day, "browser_events") >= caps.eventsPerDay) return { ok: false, error: "quota", limit: caps.eventsPerDay };
    const visitor = p.visitor_id ? this.upsertVisitor(p.visitor_id, visitorUpdateFromHit(hit), now, caps.visitors) : null;

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
        preview: !!hit.preview_config,
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
      if (inserted) this.bump(day, "browser_events", 1);
      return inserted ? { ok: true, event_id: eventId, visitor_id: p.visitor_id } : duplicate;
    }

    const config = hit.preview_config ?? this.getMeta<ContainerConfig>("config");
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
      else
        targets = this.containerBudget(
          planDispatch(event, this.getMeta<DestinationInfo[]>("destinations") ?? [], { matched: true, now }),
          caps.deliveriesPerDay,
          day,
        );
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
      preview: !!hit.preview_config,
      data: JSON.stringify(event),
      results: planned,
      note,
    });
    if (!inserted) return duplicate;
    this.bump(day, "browser_events", 1);
    this.bump(day, "deliveries", targets.filter((t) => t.status === "queued").length);
    ({ targets, results: planned } = await this.accountBudget(event, targets, planned, state.account_id, standing, now));
    await this.enqueue(event, targets, planned, state.id, now);
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
    const day = utcDay(opts.now);
    if (this.sql.databaseSize > caps.dbBytes * SERVER_STORAGE_HEADROOM) return { error: "storage_full", limit: caps.dbBytes };
    const used = this.usage(day, "server_events");
    if (used + events.length > caps.eventsPerDay) return { error: "quota", limit: caps.eventsPerDay, used };
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
        data: JSON.stringify(event),
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
    const results = JSON.parse(r.results) as Record<string, TargetResult>;
    const data = JSON.parse(r.data) as Record<string, unknown>;
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
      status: r.status,
      ...(r.note ? { note: r.note } : {}),
      ...(isConversion
        ? { identity: identitySummary(data as unknown as DispatchEvent), fired_in_browser: (data.fired as string[] | undefined) ?? [] }
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
    const ev = one<{ visits: number; conversions: number; last_visit: number | null; last_conversion: number | null }>(
      `SELECT SUM(type = 'visit') AS visits, SUM(type = 'conversion') AS conversions,
              MAX(CASE WHEN type = 'visit' THEN received_at END) AS last_visit,
              MAX(CASE WHEN type = 'conversion' THEN received_at END) AS last_conversion
       FROM events WHERE received_at >= ?`,
      since,
    );
    const st = this.sql
      .exec<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM events WHERE type = 'conversion' AND received_at >= ? GROUP BY status",
        since,
      )
      .toArray();
    const visitors = one<{ n: number }>("SELECT COUNT(*) AS n FROM visitors");
    const config = this.getMeta<ContainerConfig>("config");
    const state = this.getMeta<ContainerState>("container");
    const caps = containerCaps(this.env, state ? await accountStanding(this.env, state.account_id) : undefined);
    const day = utcDay(Date.now());
    const bytes = this.sql.databaseSize;
    const today = {
      day,
      browser_events: this.usage(day, "browser_events"),
      server_events: this.usage(day, "server_events"),
      deliveries: this.usage(day, "deliveries"),
    };
    return {
      synced: !!state,
      live_config_loaded: !!config,
      last_24h: {
        visits: ev?.visits ?? 0,
        conversions: ev?.conversions ?? 0,
        conversion_status: Object.fromEntries(st.map((s) => [s.status, s.n])),
        last_visit_at: ev?.last_visit ?? null,
        last_conversion_at: ev?.last_conversion ?? null,
      },
      visitors_stored: visitors?.n ?? 0,
      today,
      limits: {
        events_per_day: shownCap(caps.eventsPerDay),
        deliveries_per_day: shownCap(caps.deliveriesPerDay),
        visitors: shownCap(caps.visitors),
        db_bytes: shownCap(caps.dbBytes),
      },
      storage: { bytes, limit: shownCap(caps.dbBytes), full: bytes > caps.dbBytes },
      quota_reached: today.browser_events >= caps.eventsPerDay,
    };
  }
}
