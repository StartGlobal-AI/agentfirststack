import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../env";
import type { SiteRow } from "../service/context";
import { deliverDue, emitSiteEvent } from "../service/webhooks";
import {
  type Budget,
  COUNTERS,
  hasBudget,
  heatmapRetentionDaysCap,
  retentionDaysCap,
  starredRetentionDays,
  type Totals,
  zeroTotals,
} from "../lib/limits";
import { Sampler } from "../lib/sampler";
import { DAY, type Db, type SqlValue, utcDay } from "./db";
import * as engine from "./engine";
import * as annotations from "./annotations";
import * as queries from "./queries";
import * as surveys from "./surveys";

/** What the site row says about retention, handed to the DO so its own alarm can purge. */
export interface SiteConfig {
  site_id: string;
  retention_days: number;
  heatmap_retention_days: number;
}

export interface IngestCall extends engine.IngestRequest {
  account_id: string;
  config: SiteConfig;
}

const SYNC_MS = 60_000;
const SYNC_MIN_MS = 2_000;
const HOUR = 3_600_000;
/** Re-delete window for chunks of sessions deleted over the API (an upload may still be in flight). */
const REDELETE_MS = 60_000;

/**
 * One SQLite-backed Durable Object per replay site (idFromName(site_id)): the session index, the
 * derived event log (pages, clicks, inputs, errors, events, scroll milestones), signal flags,
 * heatmap rollups, daily counters and ingest drop counters. The Worker validates the site against
 * D1 before it calls in, so storage is only ever created for real sites. Recording chunks live in
 * R2; this object deletes them itself (r2_pending, retried until R2 confirms).
 *
 * Retention runs on the object's own alarm (hourly while it holds data, every 30 s while a purge
 * has more to do), so no single run has to walk every site. Account and deployment budgets: the
 * object reports its daily counters to D1 at most once a minute (sooner when close to a cap) and
 * reads the totals back; between syncs it adds its own unreported counts.
 */
export class ReplaySiteDO extends DurableObject<Bindings> {
  private db: Db;
  /** SQLite rows read and written by this instance (the billed unit), for measurements and ops. */
  private stats = { rows_read: 0, rows_written: 0 };
  private usage: (engine.UsageSnapshot & { at: number }) | null = null;
  private syncing = false;
  private alarmChecked = false;
  private config: SiteConfig | null = null;
  private drops = new Sampler(30_000, 200);

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const exec = (q: string, args: SqlValue[]) => {
      const cur = sql.exec(q, ...args);
      const rows = cur.toArray() as Record<string, SqlValue>[];
      this.stats.rows_read += cur.rowsRead;
      this.stats.rows_written += cur.rowsWritten;
      return rows;
    };
    this.db = {
      all: (q: string, args: SqlValue[] = []) => exec(q, args),
      run: (q: string, args: SqlValue[] = []) => {
        exec(q, args);
      },
      transaction: <T>(fn: () => T): T => ctx.storage.transactionSync(fn),
    };
    engine.migrate(this.db); // versioned, idempotent: existing objects catch up in place
    const c = this.db.all("SELECT value FROM meta WHERE key = 'config'")[0]?.value;
    if (c) this.config = JSON.parse(String(c)) as SiteConfig;
  }

  // ------------------------------------------------------------------ ingest

  async ingest(req: IngestCall): Promise<engine.IngestResult> {
    // A deleted site's tombstone: refuse without writing anything (config, alarm).
    if (engine.isDeleted(this.db)) return { status: "rejected", reason: "unknown_site", stop: true };
    this.remember(req.config);
    await this.ensureAlarm();
    const { account, platform } = req.limits;
    // No totals for today yet (new instance, new day): read them first, so the check is real.
    if (this.usage?.day !== utcDay(Date.now())) await this.sync(req.account_id, account, platform, true);
    const r = engine.ingestChunk(this.db, { ...req, usage: this.usage });
    if (r.status === "rejected") this.noteDrop(r.reason, req.session_id);
    // Report what was just counted when due (other sites of the account see it from then on).
    else await this.sync(req.account_id, account, platform, false);
    return r;
  }

  /** Refusals counted by the Worker (origin, size, bots, rate limits), already sampled there. */
  recordDrop(reason: string, sample: string | null, count = 1): void {
    engine.recordDrop(this.db, reason, sample, Date.now(), count);
  }

  /** Refusals decided here: the first per reason is written, then at most one write per 30 s. */
  private noteDrop(reason: string, sample: string | null) {
    const t = this.drops.take(reason, Date.now(), sample);
    if (t) engine.recordDrop(this.db, reason, t.sample, Date.now(), t.count);
  }

  private flushDrops() {
    for (const d of this.drops.drain()) engine.recordDrop(this.db, d.key, d.sample, Date.now(), d.count);
  }

  /**
   * Report this site's unreported counters to D1 (account_usage rows for the account and "*" for
   * the deployment) and read today's totals back. Only when a budget is configured; `force`, or at
   * most once a minute, or after 2 s when the unreported part is over 2% of a cap. Fails open: a
   * D1 error leaves the last totals in place.
   */
  private async sync(accountId: string, account: Budget | undefined, platform: Budget | undefined, force: boolean) {
    const needAccount = !!account && hasBudget(account);
    const needPlatform = !!platform && hasBudget(platform);
    if ((!needAccount && !needPlatform) || this.syncing) return;
    const now = Date.now();
    const day = utcDay(now);
    const u = this.usage;
    if (!force && u && u.day === day) {
      const age = now - u.at;
      if (age < SYNC_MIN_MS) return;
      if (age < SYNC_MS) {
        const local = engine.localUnreported(engine.dailyRow(this.db, day));
        const near = (b: Budget | undefined) => !!b && COUNTERS.some((k) => b[k] !== null && local[k] > (b[k] as number) * 0.02);
        if (!near(account) && !near(platform)) return;
      }
    }
    this.syncing = true;
    try {
      const deltas = engine.unreported(this.db);
      const db = this.env.DB;
      const upsert = (id: string, d: { day: string; delta: Totals }) =>
        db
          .prepare(
            `INSERT INTO account_usage (account_id, day, sessions, chunks, bytes, derived, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, day) DO UPDATE SET sessions = sessions + excluded.sessions, chunks = chunks + excluded.chunks,
               bytes = bytes + excluded.bytes, derived = derived + excluded.derived, updated_at = excluded.updated_at`,
          )
          .bind(id, d.day, d.delta.sessions, d.delta.chunks, d.delta.bytes, d.delta.derived, now);
      const ids = [...(needAccount ? [accountId] : []), ...(needPlatform ? ["*"] : [])];
      const stmts = deltas.flatMap((d) => ids.map((id) => upsert(id, d)));
      const read = db
        .prepare("SELECT account_id, sessions, chunks, bytes, derived FROM account_usage WHERE day = ? AND account_id IN (?, ?)")
        .bind(day, accountId, "*");
      const res = await db.batch([...stmts, read]);
      engine.markReported(this.db, deltas);
      const rows = (res[res.length - 1]?.results ?? []) as ({ account_id: string } & Totals)[];
      const pick = (id: string): Totals | null => {
        const r = rows.find((x) => x.account_id === id);
        return r ? { sessions: r.sessions, chunks: r.chunks, bytes: r.bytes, derived: r.derived } : zeroTotals();
      };
      this.usage = { day, at: now, account: needAccount ? pick(accountId) : null, platform: needPlatform ? pick("*") : null };
    } catch (e) {
      console.error("replay usage sync failed", e);
      this.usage = { day, at: now, account: u?.day === day ? u.account : null, platform: u?.day === day ? u.platform : null };
    } finally {
      this.syncing = false;
    }
  }

  // ------------------------------------------------------------------ surveys

  async surveyRespond(req: surveys.RespondRequest): Promise<surveys.RespondResult> {
    if (engine.isDeleted(this.db)) return { status: "rejected", reason: "unknown_site" };
    const { account, platform } = req.limits;
    if (this.usage?.day !== utcDay(Date.now())) await this.sync(req.account_id, account, platform, true);
    const r = surveys.respond(this.db, { ...req, usage: this.usage });
    if (r.status === "stored") await this.sync(req.account_id, account, platform, false);
    return r;
  }

  surveyImpression(q: Parameters<typeof surveys.impression>[1]) {
    if (engine.isDeleted(this.db)) return { ok: false as const, reason: "unknown_site" };
    return surveys.impression(this.db, q);
  }

  surveyStats(surveyId: string) {
    return surveys.stats(this.db, surveyId, Date.now());
  }

  surveyResponses(q: surveys.ResponsesQuery) {
    return surveys.listResponses(this.db, q);
  }

  surveyResults(q: Parameters<typeof surveys.results>[1]) {
    return surveys.results(this.db, q);
  }

  deleteSurveyResponse(surveyId: string, id: string) {
    return surveys.deleteResponse(this.db, surveyId, id);
  }

  deleteVisitorResponses(userIds: string[]) {
    return surveys.deleteVisitorResponses(this.db, userIds);
  }

  deleteSurveyData(surveyId: string) {
    return surveys.deleteSurveyData(this.db, surveyId);
  }

  // ------------------------------------------------------------------ reads

  summary() {
    this.flushDrops();
    return engine.summary(this.db, Date.now());
  }

  search(q: queries.SearchRequest) {
    return queries.searchSessions(this.db, q);
  }

  session(id: string) {
    const session = queries.getSessionRow(this.db, id);
    return session
      ? {
          session,
          pages: queries.sessionPages(this.db, id),
          chunks: engine.chunkSeqs(this.db, id),
          tags: queries.sessionTags(this.db, id),
          labels: annotations.sessionLabels(this.db, id),
          notes: annotations.listNotes(this.db, id),
        }
      : null;
  }

  /** Labels per session for a page of search results. */
  labelsOf(ids: string[]) {
    return Object.fromEntries(annotations.labelsOf(this.db, ids));
  }

  addNote(q: Parameters<typeof annotations.addNote>[1]) {
    return annotations.addNote(this.db, q);
  }

  listNotes(sid: string) {
    return annotations.listNotes(this.db, sid);
  }

  deleteNote(sid: string, id: string) {
    return annotations.deleteNote(this.db, sid, id);
  }

  annotate(q: Parameters<typeof annotations.annotate>[1]) {
    return annotations.annotate(this.db, q);
  }

  siteLabels() {
    return annotations.siteLabels(this.db);
  }

  transcript(id: string, opts: { maxEvents: number; kinds?: string[] | null }) {
    return queries.transcriptData(this.db, id, opts);
  }

  summarize(q: queries.SummarizeRequest) {
    return queries.summarizeSessions(this.db, q);
  }

  heatmap(q: queries.HeatmapRequest) {
    return queries.heatmap(this.db, q);
  }

  metrics(q: queries.MetricsRequest) {
    return queries.metrics(this.db, q);
  }

  errors(q: queries.ErrorsRequest) {
    return queries.listErrors(this.db, q);
  }

  /** Funnel steps, then for `drop_step` the sessions that stopped there (most frustrated first) and what they had in common. */
  funnel(q: queries.FunnelRequest) {
    const f = queries.funnelDropoffs(this.db, q);
    if (!f.dropped) return { ...f, dropped: null };
    const ids = f.dropped.session_ids;
    const all = { start: 0, end: Number.MAX_SAFE_INTEGER };
    const list = ids.length
      ? queries.searchSessions(this.db, { ...all, session_ids: ids, sort: "frustration", limit: q.limit }).sessions
      : [];
    const summary = ids.length
      ? queries.summarizeSessions(this.db, { ...all, session_ids: ids.slice(0, 1000), sort: "frustration", limit: 1000, top: 5 })
      : null;
    return { ...f, dropped: { step: f.dropped.step, total: f.dropped.total, sessions: list, summary } };
  }

  chunks(id: string): number[] {
    return engine.chunkSeqs(this.db, id);
  }

  /** The chunks a share-link player may load (with rrweb events), at most `limit`; a clip's window only. */
  playable(id: string, limit = 2000, window?: { start: number; end: number } | null): number[] {
    return engine.playableChunks(this.db, id, limit, window);
  }

  /** May share link `link_id` serve this chunk now (a real recording, in its clip window, within its daily byte budget)? */
  serveChunk(q: {
    link_id: string;
    session_id: string;
    seq: number;
    budget: number | null;
    window?: { start: number; end: number } | null;
  }) {
    return engine.linkChunk(this.db, { ...q, now: Date.now() });
  }

  visitor(q: { user_ids?: string[]; analytics_visitor_id?: string }) {
    const v = queries.visitorData(this.db, q);
    const ids = queries.findVisitorSessions(this.db, q);
    return { ...v, responses: surveys.visitorResponses(this.db, ids, q.user_ids ?? []) };
  }

  /** A chunk for an export (a real recording, within the site's daily export byte budget). */
  exportChunk(q: { session_id: string; seq: number; budget: number | null }) {
    return engine.linkChunk(this.db, { link_id: "__export", session_id: q.session_id, seq: q.seq, budget: q.budget, now: Date.now() });
  }

  findVisitor(q: { user_id?: string; user_ids?: string[]; analytics_visitor_id?: string }) {
    return queries.findVisitorSessions(this.db, q);
  }

  /** Instance counters (rows read/written since it started) and the schema version: measurements, ops. */
  usageStats() {
    return { ...this.stats, schema_version: engine.schemaVersion(this.db) };
  }

  // ------------------------------------------------------------------ deletion and retention

  /**
   * Privacy deletion (delete_session, delete_visitor_data): rows go now, the ids are tombstoned for
   * two days (an open tab can't recreate them), chunks are deleted from R2 now and once more a
   * minute later (an upload in flight), tracked in r2_pending until R2 confirms.
   */
  async deleteSessions(ids: string[]): Promise<{ deleted: string[]; chunks: number }> {
    const prefix = this.prefix();
    const now = Date.now();
    const r = engine.deleteSessions(this.db, ids, { prefix, not_before: now + REDELETE_MS, tombstone_at: now });
    if (r.keys.length && prefix !== undefined) {
      try {
        for (let i = 0; i < r.keys.length; i += 1000) await this.env.CHUNKS.delete(r.keys.slice(i, i + 1000).map((k) => prefix + k));
      } catch (e) {
        console.error("replay R2 delete failed (the alarm retries)", e);
      }
    }
    await this.ensureAlarm(true);
    return { deleted: r.deleted, chunks: r.keys.length };
  }

  /** Remember the site's retention settings (and id) and make sure the alarm runs. */
  async configure(cfg: SiteConfig): Promise<{ ok: true }> {
    this.remember(cfg);
    await this.ensureAlarm();
    return { ok: true };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.metaNum("next_maint");
    // Woken for webhook retries only: maintenance waits for its own time.
    if (due !== null && due > now && (this.metaNum("webhook_at") ?? Number.POSITIVE_INFINITY) <= now) {
      await this.runWebhooks(now);
      await this.reschedule(false, due);
      return;
    }
    const r = await this.maintain();
    await this.checkSpikes(now).catch((e) => console.error("replay spike check failed", e));
    await this.runWebhooks(now);
    await this.reschedule(r.more);
  }

  // ------------------------------------------------------------------ webhooks

  /** A delivery of this site is due at `at`: make sure the alarm comes by then. */
  async wakeWebhooks(at: number): Promise<void> {
    const cur = this.metaNum("webhook_at");
    if (cur !== null && cur <= at) return;
    this.setMeta("webhook_at", at);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
  }

  private async runWebhooks(now: number) {
    const at = this.metaNum("webhook_at");
    if (at === null || at > now || !this.config) return;
    let next: number | null = null;
    try {
      next = await deliverDue(this.env, this.config.site_id);
    } catch (e) {
      console.error("replay webhook retries failed", e);
      next = now + 60_000;
    }
    this.setMeta("webhook_at", next);
  }

  /** signal.spike: checked when maintenance runs (about hourly); D1 is read only when there is a spike. */
  private async checkSpikes(now: number) {
    if (!this.config) return;
    const spikes = engine.signalSpikes(this.db, now);
    if (!spikes.length) return;
    const site = await this.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(this.config.site_id).first<SiteRow>();
    if (!site) return;
    for (const sp of spikes)
      await emitSiteEvent(this.env, site, "signal.spike", {
        ...sp,
        window: "1h",
        compared_with: "the hourly average of the 7 days before",
        next_steps: [`GET /v1/sites/${site.id}/sessions?signal=${sp.signal}&period=1h`],
      });
  }

  /** segment.session: did this session just enter the segment (filters already resolved)? */
  segmentHit(segmentId: string, f: queries.SessionFilters) {
    const r = queries.searchSessions(this.db, { ...f, sort: "recent", limit: 1 });
    const s = r.sessions[0];
    if (!s || !engine.segmentHit(this.db, segmentId, s.id, Date.now())) return null;
    return s;
  }

  private metaNum(key: string): number | null {
    const v = this.db.all("SELECT value FROM meta WHERE key = ?", [key])[0]?.value;
    return v === undefined || v === null || v === "" ? null : Number(v);
  }

  private setMeta(key: string, v: number | null) {
    if (v === null) this.db.run("DELETE FROM meta WHERE key = ?", [key]);
    else this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(v)]);
  }

  /**
   * One bounded maintenance pass: heatmap rollups (2 days), retention purge rounds until the
   * deadline, housekeeping, then R2 deletes of pending keys. `now` can be moved for tests.
   */
  async maintain(cfg?: SiteConfig, opts: { now?: number; budgetMs?: number } = {}) {
    if (cfg) this.remember(cfg);
    const now = opts.now ?? Date.now();
    const deadline = Date.now() + (opts.budgetMs ?? 10_000);
    const c = this.config;
    const retention = c ? Math.min(c.retention_days, retentionDaysCap(this.env)) : null;
    const starredDays = starredRetentionDays(this.env);
    const heat = c ? Math.min(c.heatmap_retention_days, heatmapRetentionDaysCap(this.env)) : null;
    const r = engine.maintain(this.db, {
      now,
      cutoff: retention === null ? null : now - retention * DAY,
      starred_cutoff: retention === null ? null : now - Math.max(retention, starredDays) * DAY,
      heat_cutoff: heat === null ? null : now - heat * DAY,
      prefix: this.prefix(),
      deadline,
    });
    let deleted = 0;
    let more = r.more;
    const prefix = this.prefix();
    if (prefix !== undefined) {
      while (Date.now() < deadline) {
        const keys = engine.pendingDue(this.db, now, 1000);
        if (!keys.length) break;
        try {
          await this.env.CHUNKS.delete(keys);
        } catch (e) {
          console.error("replay R2 delete failed (retried next run)", e);
          more = true;
          break;
        }
        engine.clearPending(this.db, keys);
        deleted += keys.length;
      }
      if (engine.pendingDue(this.db, now, 1).length) more = true;
    }
    return { ...r, chunks_deleted: deleted, more };
  }

  /**
   * Called by the hourly cron for a site it hasn't looked at for a day (and the first time after
   * this version is deployed, for objects that never had an alarm): runs one pass and schedules.
   */
  async kick(cfg: SiteConfig, opts: { now?: number; budgetMs?: number } = {}) {
    const r = await this.maintain(cfg, opts);
    await this.reschedule(r.more);
    return r;
  }

  /**
   * Delete everything (site deleted). A tombstone stays, so a chunk that slips in from a cached
   * loader can't recreate storage. R2 chunks are removed by prefix by the hourly cron.
   */
  async destroy(): Promise<{ ok: true }> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    engine.migrate(this.db);
    this.config = null;
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('deleted', ?)", [String(Date.now())]);
    return { ok: true };
  }

  // ------------------------------------------------------------------ internals

  private prefix(): string | undefined {
    return this.config ? `${this.config.site_id}/` : undefined;
  }

  private remember(cfg: SiteConfig) {
    const c = this.config;
    if (
      c &&
      c.site_id === cfg.site_id &&
      c.retention_days === cfg.retention_days &&
      c.heatmap_retention_days === cfg.heatmap_retention_days
    )
      return;
    const next = { site_id: cfg.site_id, retention_days: cfg.retention_days, heatmap_retention_days: cfg.heatmap_retention_days };
    this.db.run("INSERT INTO meta (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      JSON.stringify(next),
    ]);
    this.config = next;
  }

  /** Once per instance (or when asked): an alarm exists, else one in an hour (soon = in a minute). */
  private async ensureAlarm(soon = false) {
    if (this.alarmChecked && !soon) return;
    this.alarmChecked = true;
    const at = await this.ctx.storage.getAlarm();
    const want = Date.now() + (soon ? REDELETE_MS + 5_000 : HOUR);
    if (at === null || (soon && at > want)) await this.ctx.storage.setAlarm(want);
  }

  /** Next alarm: maintenance (30 s while a purge has more to do, hourly while data is stored) or a webhook retry. */
  private async reschedule(more: boolean, keepMaint?: number) {
    const now = Date.now();
    const maint = keepMaint ?? (more ? now + 30_000 : engine.hasStoredData(this.db) ? now + HOUR : null);
    this.setMeta("next_maint", maint);
    const wh = this.metaNum("webhook_at");
    const at = maint === null ? wh : wh === null ? maint : Math.min(maint, wh);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}
