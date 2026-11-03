import { type Standing, accountStanding } from "@afs/shared";
import { DurableObject } from "cloudflare:workers";
import * as engine from "./engine";
import type { Db, MoversRequest, Row, SqlCursor } from "./engine";
import * as annotations from "./annotations";
import type { AnnotationInput, AnnotationPatch } from "./annotations";
import * as payments from "./payments";
import * as people from "./people";
import { insights, type InsightsRequest } from "./insights";
import { err, guard, rangeFor, utcDay } from "./common";
import type { SqlValue } from "../lib/query";
import type { Breakdown } from "../lib/filters";
import { type IngestCaps, type LimitVars, effectiveRetention, ingestCaps, limitVars, needsAggregate } from "../lib/limits";
import type {
  EnrichedEvent,
  FunnelRequest,
  IngestResponse,
  PaymentInput,
  PeriodParams,
  SiteSettings,
  StatsRequest,
  TimeseriesRequest,
} from "../lib/types";
import type { Bindings } from "../env";

const DAY = 86_400_000;
export const NOT_CONFIGURED = { error: { code: "not_configured", message: "Site storage is not configured." } } as const;

/** Report this site's daily count to the account / platform aggregate (D1) at most this often... */
const AGGREGATE_EVERY_MS = 60_000;
/** ...or after 1% of the smaller cap in new events (at most 1,000), whichever comes first. */
const AGGREGATE_EVERY_EVENTS = 1_000;
const aggregateEvery = (c: IngestCaps) =>
  Math.max(1, Math.min(AGGREGATE_EVERY_EVENTS, Math.floor(Math.min(c.accountDaily, c.platformDaily) / 100)));
/**
 * Drop counters are written at most this often (a flood of junk costs one write per reason per 10 s;
 * counts still in memory when the object is evicted are lost, which only makes them approximate).
 */
const DROPS_EVERY_MS = 10_000;
/** Payments are small; this is their share of the daily byte counter. */
const PAYMENT_BYTES = 256;

/** How the Worker asks for ingest: the limit vars of its env (so tests can change them per call). */
export interface IngestPolicy {
  vars?: LimitVars;
  /** signed provider webhooks (Stripe): not held to the daily caps; storage and suspension still apply */
  exempt?: boolean;
}

const CLAIMED: Standing = { suspended: false, claimed: true };

/**
 * One SQLite-backed Durable Object per site (idFromName(site_id)). Holds the site's events,
 * sessions, a settings + goals copy (so ingest never reads D1), and runs every query. A daily
 * alarm purges raw data older than retention_days.
 *
 * Fair use lives here, because every write of the site goes through it: the account's standing
 * (suspended accounts are refused; cached a minute), the per-site daily counter (usage table,
 * never lowered by purges), the account's and platform's daily totals (this site's count is
 * reported to D1 at most once a minute or per 1,000 events, and the totals come back with it), and
 * the storage budget (the database's own size).
 */
export class SiteDO extends DurableObject<Bindings> {
  private db: Db;
  /** Tables exist. False for an id that was never configured: we must not write storage for it. */
  private ready: boolean;
  /** account id looked up for a settings copy that predates account ids (undefined = not yet) */
  private lookedUpAccount: string | null | undefined;
  private agg = { day: "", at: 0, flushed: 0, account: 0, platform: 0 };
  private aggInflight: Promise<void> | null = null;
  private pendingDrops = new Map<string, { count: number; last_at: number; sample: string | null }>();
  private pendingRefused = 0;
  private dropsWrittenAt = 0;

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

  // ---------------------------------------------------------------- standing and budgets

  private async accountIdOf(s: SiteSettings): Promise<string | null> {
    if (s.account_id) return s.account_id;
    if (this.lookedUpAccount !== undefined) return this.lookedUpAccount;
    // A settings copy pushed before account ids were part of it: look it up once and keep it.
    try {
      const row = await this.env.DB.prepare("SELECT account_id FROM sites WHERE id = ?").bind(s.id).first<{ account_id: string }>();
      this.lookedUpAccount = row?.account_id ?? null;
      if (row?.account_id) engine.setSettingsField(this.db, "account_id", row.account_id);
    } catch {
      this.lookedUpAccount = null;
    }
    return this.lookedUpAccount;
  }

  private async standingOf(s: SiteSettings): Promise<{ accountId: string | null; standing: Standing }> {
    const accountId = await this.accountIdOf(s);
    if (!accountId) return { accountId, standing: CLAIMED };
    try {
      return { accountId, standing: await accountStanding(this.env, accountId) };
    } catch {
      return { accountId, standing: CLAIMED }; // identity DB unreachable: don't lose events over it
    }
  }

  private storageFull(caps: IngestCaps): boolean {
    return Number.isFinite(caps.storageBytes) && this.ctx.storage.sql.databaseSize >= caps.storageBytes;
  }

  /**
   * Today's events on the account's other sites and everywhere else, from the last report to the
   * D1 aggregate (made now if this instance hasn't reported today yet).
   */
  private async othersToday(siteId: string, accountId: string): Promise<{ account: number; platform: number }> {
    const day = utcDay(Date.now());
    if (this.agg.day !== day) this.agg = { day, at: 0, flushed: engine.usageOn(this.db, day).flushed, account: 0, platform: 0 };
    if (this.agg.at === 0) await this.reportOnce(siteId, accountId, day);
    return { account: Math.max(0, this.agg.account - this.agg.flushed), platform: Math.max(0, this.agg.platform - this.agg.flushed) };
  }

  /** After an ingest: report this site's count when it's due (a minute passed, or enough new events). */
  private async reportIfDue(siteId: string, accountId: string, caps: IngestCaps): Promise<void> {
    const now = Date.now();
    const day = utcDay(now);
    if (this.agg.day !== day) return;
    const local = engine.usageOn(this.db, day).events;
    const fresh = local - this.agg.flushed;
    if (fresh >= aggregateEvery(caps) || (fresh > 0 && now - this.agg.at >= AGGREGATE_EVERY_MS))
      await this.reportOnce(siteId, accountId, day);
  }

  private reportOnce(siteId: string, accountId: string, day: string): Promise<void> {
    this.aggInflight ??= this.report(siteId, accountId, day, engine.usageOn(this.db, day).events).finally(() => {
      this.aggInflight = null;
    });
    return this.aggInflight;
  }

  /**
   * Report this site's count (idempotent: an absolute, non-decreasing value) and read back the
   * account's and the platform's totals; the platform total grows by the delta since the last report.
   */
  private async report(siteId: string, accountId: string, day: string, local: number): Promise<void> {
    const now = Date.now();
    const delta = Math.max(0, local - this.agg.flushed);
    const db = this.env.DB;
    try {
      const res = await db.batch<{ n: number }>([
        db
          .prepare(
            `INSERT INTO usage_daily (site_id, account_id, day, events, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(site_id, day) DO UPDATE SET events = MAX(events, excluded.events), updated_at = excluded.updated_at`,
          )
          .bind(siteId, accountId, day, local, now),
        db
          .prepare(
            `INSERT INTO usage_global (day, events, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(day) DO UPDATE SET events = events + excluded.events, updated_at = excluded.updated_at`,
          )
          .bind(day, delta, now),
        db.prepare("SELECT COALESCE(SUM(events), 0) AS n FROM usage_daily WHERE account_id = ? AND day = ?").bind(accountId, day),
        db.prepare("SELECT COALESCE(MAX(events), 0) AS n FROM usage_global WHERE day = ?").bind(day),
      ]);
      this.agg = {
        day,
        at: now,
        flushed: local,
        account: Number(res[2]?.results[0]?.n ?? 0),
        platform: Number(res[3]?.results[0]?.n ?? 0),
      };
      engine.setUsageFlushed(this.db, day, local);
    } catch (e) {
      // D1 unavailable (or not migrated yet): keep the last totals, try again in a minute.
      console.error("usage aggregate failed", e);
      this.agg.at = now;
    }
  }

  private queueDrop(reason: string, sample: string | null): void {
    const cur = this.pendingDrops.get(reason);
    if (cur) {
      cur.count++;
      cur.last_at = Date.now();
      cur.sample = sample ?? cur.sample;
    } else this.pendingDrops.set(reason, { count: 1, last_at: Date.now(), sample });
  }

  /** Write coalesced drop / warning / refusal counts: when due, or always (`force`, before a summary). */
  private writeDrops(force = false): void {
    if (!this.pendingDrops.size && !this.pendingRefused) return;
    const now = Date.now();
    if (!force && now - this.dropsWrittenAt < DROPS_EVERY_MS) return;
    const drops = [...this.pendingDrops];
    const refused = this.pendingRefused;
    this.pendingDrops.clear();
    this.pendingRefused = 0;
    this.dropsWrittenAt = now;
    this.db.transaction(() => {
      for (const [reason, d] of drops) engine.recordDrop(this.db, reason, d.sample, d.last_at, d.count);
      engine.addUsage(this.db, utcDay(now), { refused });
    });
  }

  // ---------------------------------------------------------------- configuration and ingest

  async configure(settings: SiteSettings): Promise<{ ok: true }> {
    if (!this.ready) {
      engine.migrate(this.db);
      this.ready = true;
    }
    const prev = engine.getSettings(this.db);
    engine.configure(this.db, settings);
    // Lowering retention frees storage now (a site over its storage budget recovers at once).
    if (prev && settings.retention_days < prev.retention_days) {
      const { standing } = await this.standingOf(settings);
      engine.purge(this.db, effectiveRetention(this.env, standing, settings.retention_days));
    }
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + DAY);
    return { ok: true };
  }

  async ingest(events: EnrichedEvent[], policy: IngestPolicy = {}): Promise<IngestResponse> {
    const s = this.settingsOrNull();
    if (!s) return { known_site: false, persistent: false, results: events.map(() => ({ ok: false, reason: "unknown_site" })) };
    const persistent = s.visitor_id_mode === "persistent";
    const { accountId, standing } = await this.standingOf(s);
    if (standing.suspended)
      return {
        known_site: true,
        persistent,
        results: events.map(() => ({ ok: false, reason: "account_suspended" })),
        refused: "account_suspended",
      };
    const vars = policy.vars ?? limitVars(this.env);
    const caps = ingestCaps(vars, standing);
    const aggregate = needsAggregate(caps) && !!accountId && !policy.exempt;
    const others = aggregate ? await this.othersToday(s.id, accountId!) : { account: 0, platform: 0 };
    const res = engine.ingest(this.db, events, Date.now(), {
      dev: vars.DEV_MODE === "true",
      caps: policy.exempt ? undefined : { siteDaily: caps.siteDaily, accountDaily: caps.accountDaily, platformDaily: caps.platformDaily },
      accountOthers: others.account,
      platformOthers: others.platform,
      storageFull: this.storageFull(caps),
      // Warnings belong to stored events (already within the event budget): written with them.
      // Drops cost nothing else, so under a flood they are coalesced.
      drop: (reason, sample) =>
        reason.startsWith(engine.WARN_PREFIX) ? engine.recordDrop(this.db, reason, sample) : this.queueDrop(reason, sample),
    });
    this.pendingRefused += res.results.filter((r) => (engine.BUDGET_REASONS as readonly string[]).includes(r.reason ?? "")).length;
    this.writeDrops();
    if (aggregate) await this.reportIfDue(s.id, accountId!, caps);
    // From the settings copy already in hand: the Worker turns it into the tracker's replay loader URL.
    return { ...res, replay_site_id: s.replay_site_id ?? null };
  }

  /** A drop decided in the Worker (bots). Returns the site's replay link, or null for an unknown site. */
  recordDrop(reason: string, sample: string | null): { replay_site_id: string | null } | null {
    const s = this.settingsOrNull();
    if (!s) return null; // unknown site: don't create storage for it
    this.queueDrop(reason, sample);
    this.writeDrops();
    return { replay_site_id: s.replay_site_id ?? null };
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

  async ingestPayments(records: PaymentInput[], policy: IngestPolicy = {}) {
    const s = this.settingsOrNull();
    if (!s) return NOT_CONFIGURED;
    const { standing } = await this.standingOf(s);
    if (standing.suspended) return err("account_suspended", "This account has been suspended; its data is not recorded.");
    const caps = ingestCaps(policy.vars ?? limitVars(this.env), standing);
    if (this.storageFull(caps))
      return err(
        "storage_full",
        "This site's storage budget is used up; payments are not recorded.",
        "Lower retention_days or delete data.",
      );
    const day = utcDay(Date.now());
    if (!policy.exempt && engine.usageOn(this.db, day).events >= caps.siteDaily)
      return err("daily_limit", "This site reached its daily event limit; payments are refused until 00:00 UTC.");
    const results = payments.ingestPayments(this.db, records, Date.now(), { trustBrowserUserId: !!s.trust_browser_user_id });
    const added = results.filter((r) => r.ok && r.existing === false).length;
    engine.addUsage(this.db, day, { events: added, bytes: added * PAYMENT_BYTES });
    return { results };
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

  // ---------------------------------------------------------------- SQL

  sql(query: string, opts: { budgetMs?: number } = {}) {
    const maxRowsRead = Number(this.env.SQL_MAX_ROWS_READ) || undefined;
    return this.withSettings(() => engine.runSql(this.db, query, { maxRowsRead, budgetMs: opts.budgetMs }));
  }

  /** The Worker reports each slow query's wall time; it counts against the site's SQL budget. */
  chargeSql(ms: number, budgetMs: number): void {
    if (this.settingsOrNull() && Number.isFinite(budgetMs) && budgetMs > 0) engine.chargeSql(this.db, ms, budgetMs);
  }

  summary() {
    return this.withSettings(() => {
      this.writeDrops(true);
      return { ...engine.summary(this.db), database_bytes: this.ctx.storage.sql.databaseSize };
    });
  }

  /** The DO's schema version (meta.schema_version), for operators and tests. */
  schemaVersion(): number {
    return this.ready ? engine.schemaVersion(this.db) : 0;
  }

  /** Delete everything this site stored. Its count for today stays in the account aggregate. */
  async destroy(): Promise<{ ok: true }> {
    const s = this.settingsOrNull();
    if (s) {
      const day = utcDay(Date.now());
      const u = engine.usageOn(this.db, day);
      const accountId = await this.accountIdOf(s);
      // Deleting and re-creating a site must not reset the account's daily total.
      if (accountId && u.flushed > 0 && u.events > u.flushed) {
        if (this.agg.day !== day) this.agg = { day, at: 0, flushed: u.flushed, account: 0, platform: 0 };
        await this.report(s.id, accountId, day, u.events);
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ready = false;
    return { ok: true };
  }

  /** Daily: purge raw data past retention, then annotate traffic spikes of the days since the last run. */
  override async alarm(): Promise<void> {
    const s = this.settingsOrNull();
    if (!s) return; // deleted site: let the object go idle
    this.writeDrops(true);
    // The account's bounds (MIN_/MAX_RETENTION_DAYS) apply to sites created before they were set, too.
    const { standing } = await this.standingOf(s);
    const days = effectiveRetention(this.env, standing, s.retention_days);
    const res = engine.purge(this.db, days);
    if (res.events || res.sessions) console.log(JSON.stringify({ msg: "retention purge", site: s.id, retention_days: days, ...res }));
    try {
      const spikes = this.db.transaction(() => annotations.evaluateSpikes(this.db, s));
      if (spikes.length) console.log(JSON.stringify({ msg: "traffic spikes annotated", site: s.id, days: spikes }));
    } catch (e) {
      // Never let spike detection stop the retention schedule.
      console.error("spike evaluation failed", e);
    }
    if (engine.usageOn(this.db, utcDay(Date.now() - DAY)).flushed > 0) {
      await this.env.DB.prepare("DELETE FROM usage_daily WHERE site_id = ? AND day < ?")
        .bind(s.id, utcDay(Date.now() - 40 * DAY))
        .run()
        .catch(() => {});
    }
    await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
}
