import { DurableObject } from "cloudflare:workers";
import * as engine from "./engine";
import type { Db, Row, SqlCursor } from "./engine";
import type { SqlValue } from "../lib/query";
import type { Breakdown } from "../lib/filters";
import type { EnrichedEvent, FunnelRequest, SiteSettings, StatsRequest, TimeseriesRequest } from "../lib/types";
import type { Bindings } from "../env";

const DAY = 86_400_000;
export const NOT_CONFIGURED = { error: { code: "not_configured", message: "Site storage is not configured." } } as const;

/**
 * One SQLite-backed Durable Object per site (idFromName(site_id)). Holds the site's events,
 * sessions, a settings + goals copy (so ingest never reads D1), and runs every query. A daily
 * alarm purges raw data older than retention_days.
 */
export class SiteDO extends DurableObject<Bindings> {
  private db: Db;
  /** Tables exist. False for an id that was never configured: we must not write storage for it. */
  private ready: boolean;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.db = {
      all: (q: string, args: SqlValue[] = []) => sql.exec(q, ...args).toArray() as Row[],
      run: (q: string, args: SqlValue[] = []) => {
        sql.exec(q, ...args);
      },
      // exec() steps to the first row; each next() steps one more, and rowsRead grows as it goes.
      cursor: (q: string) => sql.exec(q) as unknown as SqlCursor,
      transaction: <T>(fn: () => T): T => ctx.storage.transactionSync(fn),
    };
    this.ready = this.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").length > 0;
    if (this.ready) engine.migrate(this.db); // idempotent; picks up new tables/indexes after deploys
  }

  private settingsOrNull(): SiteSettings | null {
    return this.ready ? engine.getSettings(this.db) : null;
  }

  /** Run a query against the configured site, or tell the Worker to push settings first. */
  private withSettings<T>(fn: (s: SiteSettings) => T): T | typeof NOT_CONFIGURED {
    const s = this.settingsOrNull();
    return s ? fn(s) : NOT_CONFIGURED;
  }

  async configure(settings: SiteSettings): Promise<{ ok: true }> {
    if (!this.ready) {
      engine.migrate(this.db);
      this.ready = true;
    }
    engine.configure(this.db, settings);
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + DAY);
    return { ok: true };
  }

  ingest(events: EnrichedEvent[]) {
    if (!this.ready) return { known_site: false, persistent: false, results: events.map(() => ({ ok: false, reason: "unknown_site" })) };
    return engine.ingest(this.db, events);
  }

  recordDrop(reason: string, sample: string | null): void {
    if (!this.settingsOrNull()) return; // unknown site: don't create storage for it
    engine.recordDrop(this.db, reason, sample);
  }

  stats(q: StatsRequest) {
    return this.withSettings((s) => engine.stats(this.db, s, q));
  }

  breakdown(q: StatsRequest & { breakdown: Breakdown }) {
    return this.withSettings((s) => engine.breakdown(this.db, s, q));
  }

  timeseries(q: TimeseriesRequest) {
    return this.withSettings((s) => engine.timeseries(this.db, s, q));
  }

  realtime() {
    return this.withSettings(() => engine.realtime(this.db));
  }

  funnel(q: FunnelRequest) {
    return this.withSettings((s) => engine.funnel(this.db, s, q));
  }

  sql(query: string) {
    const maxRowsRead = Number(this.env.SQL_MAX_ROWS_READ) || undefined;
    return this.withSettings(() => engine.runSql(this.db, query, { maxRowsRead }));
  }

  summary() {
    return this.withSettings(() => engine.summary(this.db));
  }

  /** Delete everything this site stored. */
  async destroy(): Promise<{ ok: true }> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
    return { ok: true };
  }

  override async alarm(): Promise<void> {
    const s = this.settingsOrNull();
    if (!s) return; // deleted site: let the object go idle
    const res = engine.purge(this.db, s.retention_days);
    if (res.events || res.sessions) console.log(JSON.stringify({ msg: "retention purge", site: s.id, ...res }));
    await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
}
