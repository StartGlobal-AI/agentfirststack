import { DurableObject } from "cloudflare:workers";
import * as engine from "./engine";
import type { Db, MoversRequest, Row, SqlCursor } from "./engine";
import * as annotations from "./annotations";
import type { AnnotationInput, AnnotationPatch } from "./annotations";
import * as payments from "./payments";
import * as people from "./people";
import { insights, type InsightsRequest } from "./insights";
import { err, guard, rangeFor } from "./common";
import type { SqlValue } from "../lib/query";
import type { Breakdown } from "../lib/filters";
import type { EnrichedEvent, FunnelRequest, PaymentInput, PeriodParams, SiteSettings, StatsRequest, TimeseriesRequest } from "../lib/types";
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

  movers(q: MoversRequest) {
    return this.withSettings((s) => engine.movers(this.db, s, q));
  }

  insights(q: InsightsRequest) {
    return this.withSettings((s) => insights(this.db, s, q));
  }

  // ---------------------------------------------------------------- visitors, sessions, journeys

  visitors(q: people.VisitorsRequest) {
    return this.withSettings((s) => people.listVisitors(this.db, s, q));
  }

  visitor(key: string, limit?: number) {
    return this.withSettings((s) => people.getVisitor(this.db, s, key, limit));
  }

  session(id: string) {
    return this.withSettings((s) => people.getSession(this.db, s, id));
  }

  journeys(q: people.JourneysRequest) {
    return this.withSettings((s) => people.journeys(this.db, s, q));
  }

  // ---------------------------------------------------------------- payments

  ingestPayments(records: PaymentInput[]) {
    return this.withSettings(() => ({ results: payments.ingestPayments(this.db, records) }));
  }

  listPayments(q: PeriodParams & { type?: string; limit: number; offset: number }) {
    return this.withSettings((s) =>
      guard(() => {
        const r = rangeFor(this.db, s, q, Date.now());
        return {
          period: { from: r.from, to: r.to, start: r.start, end: r.end },
          ...payments.listPayments(this.db, s, { ...q, start: r.start, end: r.end }),
        };
      }),
    );
  }

  deletePayment(id: string) {
    return this.withSettings(
      () =>
        payments.deletePayment(this.db, id) ??
        err("not_found", "Payment not found.", "GET /v1/sites/:id/payments lists payments with their ids (pay_...)."),
    );
  }

  paymentsSummary() {
    return this.withSettings(() => payments.paymentsSummary(this.db));
  }

  // ---------------------------------------------------------------- annotations

  createAnnotation(a: AnnotationInput, max: number | null) {
    return this.withSettings((s) => annotations.createAnnotation(this.db, s, a, max));
  }

  listAnnotations(q: PeriodParams & { kind?: string }) {
    return this.withSettings((s) =>
      guard(() => {
        const bounded = q.period || q.from || q.to;
        const r = bounded ? rangeFor(this.db, s, q, Date.now()) : null;
        return {
          ...(r ? { period: { from: r.from, to: r.to, start: r.start, end: r.end, timezone: r.timezone } } : {}),
          annotations: annotations.annotationsIn(this.db, s, r?.start ?? 0, r?.end ?? Number.MAX_SAFE_INTEGER, q.kind),
        };
      }),
    );
  }

  updateAnnotation(id: string, p: AnnotationPatch) {
    return this.withSettings((s) => annotations.updateAnnotation(this.db, s, id, p));
  }

  deleteAnnotation(id: string) {
    return this.withSettings(() => annotations.deleteAnnotation(this.db, id));
  }

  sql(query: string) {
    const maxRowsRead = Number(this.env.SQL_MAX_ROWS_READ) || undefined;
    return this.withSettings(() => engine.runSql(this.db, query, { maxRowsRead }));
  }

  summary() {
    return this.withSettings(() => engine.summary(this.db));
  }

  /** The DO's schema version (meta.schema_version), for operators and tests. */
  schemaVersion(): number {
    return this.ready ? engine.schemaVersion(this.db) : 0;
  }

  /** Delete everything this site stored. */
  async destroy(): Promise<{ ok: true }> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
    return { ok: true };
  }

  /** Daily: purge raw data past retention, then annotate traffic spikes of the days since the last run. */
  override async alarm(): Promise<void> {
    const s = this.settingsOrNull();
    if (!s) return; // deleted site: let the object go idle
    const res = engine.purge(this.db, s.retention_days);
    if (res.events || res.sessions) console.log(JSON.stringify({ msg: "retention purge", site: s.id, ...res }));
    try {
      const spikes = this.db.transaction(() => annotations.evaluateSpikes(this.db, s));
      if (spikes.length) console.log(JSON.stringify({ msg: "traffic spikes annotated", site: s.id, days: spikes }));
    } catch (e) {
      // Never let spike detection stop the retention schedule.
      console.error("spike evaluation failed", e);
    }
    await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
}
