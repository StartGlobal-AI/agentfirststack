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
import * as tags from "./tags-outbox";
import * as heatmapImage from "./heatmap-image";
import { postTagsEvents } from "../service/tags";
import type { TagsServerEvent } from "../lib/tags";

/** What the site row says about retention, handed to the DO so its own alarm can purge. */
export interface SiteConfig {
  site_id: string;
  retention_days: number;
  heatmap_retention_days: number;
}

export interface IngestCall extends engine.IngestRequest {
  account_id: string;
  config: SiteConfig;
  /** the linked tags container (with `tags`): where the alarm sends queued events */
  tags_container?: string | null;
}

/** A completed survey response's scores for the linked tags container. */
export interface SurveyTags {
  container_id: string;
  event: TagsServerEvent;
  daily: number | null;
}

/** Batching window for tags: the first queued event waits this long for others. */
const TAGS_BATCH_MS = 15_000;

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
    this.rememberBudgets(req.limits.account, req.limits.platform);
    await this.ensureAlarm();
    const { account, platform } = req.limits;
    // No totals for today yet (new instance, new day): read them first, so the check is real.
    if (this.usage?.day !== utcDay(Date.now())) await this.sync(req.account_id, account, platform, true);
    const r = engine.ingestChunk(this.db, { ...req, usage: this.usage });
    if (r.status === "accepted" && r.tags_queued && req.tags_container) await this.wakeTags(req.tags_container, req.account_id);
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

  async surveyRespond(req: surveys.RespondRequest & { tags?: SurveyTags | null }): Promise<surveys.RespondResult> {
    if (engine.isDeleted(this.db)) return { status: "rejected", reason: "unknown_site" };
    const { account, platform } = req.limits;
    if (this.usage?.day !== utcDay(Date.now())) await this.sync(req.account_id, account, platform, true);
    const { tags: t, ...rest } = req;
    const r = surveys.respond(this.db, { ...rest, usage: this.usage });
    if (r.status === "stored") {
      // A completed, real response with a score: queued for the tags container (its own daily budget).
      if (t && r.completed_now && !r.test && tags.tagsRoom(this.db, req.now, t.daily) > 0) {
        const event = r.session_linked ? t.event : { ...t.event, params: { ...t.event.params } };
        if (!r.session_linked) delete event.params.replay_session_id;
        tags.queueTags(this.db, { session_id: r.session_linked ? req.session_id : null, response_id: r.id, events: [event], now: req.now });
        await this.wakeTags(t.container_id, req.account_id);
      }
      await this.sync(req.account_id, account, platform, false);
    }
    return r;
  }

  // ------------------------------------------------------------------ tags

  /** Events are queued: remember where they go and send them within TAGS_BATCH_MS (with more that arrive meanwhile). */
  private async wakeTags(containerId: string, accountId: string) {
    const link = JSON.stringify({ container_id: containerId, account_id: accountId });
    const cur = this.db.all("SELECT value FROM meta WHERE key = 'tags_link'")[0]?.value;
    if (cur !== link)
      this.db.run("INSERT INTO meta (key, value) VALUES ('tags_link', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [link]);
    if (this.metaNum("tags_at") !== null) return;
    const at = Date.now() + TAGS_BATCH_MS;
    this.setMeta("tags_at", at);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
  }

  /** The site was unlinked from tags (or the binding is gone): nothing queued is sent. */
  tagsUnlink(): { dropped: number } {
    const dropped = tags.tagsClear(this.db);
    this.db.run("DELETE FROM meta WHERE key IN ('tags_link', 'tags_at')");
    return { dropped };
  }

  /**
   * Send queued events in batches of 100 (at most 5 per run). 2xx: done. 429, 5xx, a binding
   * failure: retried with backoff (30 s doubling, at most an hour); events older than a day or
   * tried 8 times are dropped. Another 4xx (container deleted, invalid batch): the batch is dropped.
   * The outcome is kept in meta tags_last (get_site shows it under data.tags_forwarding).
   */
  private async runTags(now: number) {
    const at = this.metaNum("tags_at");
    if (at === null || at > now) return;
    const raw = this.db.all("SELECT value FROM meta WHERE key = 'tags_link'")[0]?.value;
    const link = raw ? (JSON.parse(String(raw)) as { container_id: string; account_id: string }) : null;
    let dropped = tags.tagsExpire(this.db, now);
    if (!link || !this.env.TAGS || !this.env.INTERNAL_TOKEN) {
      this.tagsUnlink();
      return;
    }
    let next: number | null = null;
    for (let round = 0; round < 5; round++) {
      const rows = tags.tagsDue(this.db, 100);
      if (!rows.length) break;
      const r = await postTagsEvents(
        this.env,
        link.account_id,
        link.container_id,
        rows.map((x) => x.event),
      );
      const ids = rows.map((x) => x.id);
      const ok = r.status === 202 || r.status === 200;
      const retry = r.status === 0 || r.status === 429 || r.status >= 500;
      if (ok || !retry) tags.tagsDone(this.db, ids);
      else tags.tagsRetry(this.db, ids);
      if (!ok && !retry) {
        dropped += rows.length;
        console.log(
          JSON.stringify({ event: "replay.tags_forward_refused", status: r.status, error: r.error, container: link.container_id }),
        );
      }
      const last: engine.TagsLast = { status: r.status, at: now, sent: ok ? rows.length : 0, dropped, error: r.error };
      this.db.run("INSERT INTO meta (key, value) VALUES ('tags_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
        JSON.stringify(last),
      ]);
      if (retry) {
        next = now + Math.min(3_600_000, 30_000 * 2 ** Math.max(0, Math.min(7, rows[0]!.tries)));
        break;
      }
    }
    if (next === null && tags.tagsQueued(this.db) > 0) next = now + TAGS_BATCH_MS;
    this.setMeta("tags_at", next);
  }

  async surveyImpression(q: Parameters<typeof surveys.impression>[1] & { account_id: string }) {
    if (engine.isDeleted(this.db)) return { ok: false as const, reason: "unknown_site" };
    const { account, platform } = q;
    if (this.usage?.day !== utcDay(Date.now())) await this.sync(q.account_id, account, platform, true);
    const r = surveys.impression(this.db, { ...q, usage: this.usage });
    if (r.ok) await this.sync(q.account_id, account, platform, false);
    return r;
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

  deleteResponsesByEmail(email: string) {
    return surveys.deleteResponsesByEmail(this.db, email);
  }

  responsesByEmail(email: string) {
    return surveys.responsesByEmail(this.db, email);
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

  /** Star / label; starring copies the playback now (bounded; the alarm finishes), unstarring deletes the copy. */
  async annotate(q: Parameters<typeof annotations.annotate>[1]) {
    const r = annotations.annotate(this.db, q);
    if (!r.ok) return r;
    if (r.was_starred && !r.starred) {
      engine.dropKept(this.db, q.session_id, this.prefix(), Date.now());
      await this.ensureAlarm(true);
    }
    if (r.starred && !r.was_starred) await this.runCopies(Date.now(), 5_000);
    return r;
  }

  /**
   * Copy due chunks of starred sessions to the starred/ prefix (get + put; R2 has no server-side
   * copy), counting their bytes against today's budgets; past a budget it waits for tomorrow.
   * Leaves copy_at set when more remain, so the alarm comes back for them.
   */
  private async runCopies(now: number, budgetMs = 10_000) {
    const prefix = this.prefix();
    if (prefix === undefined) return;
    const stop = Date.now() + budgetMs;
    const limits = this.budgets();
    let more = false;
    for (;;) {
      const due = engine.starredCopyDue(this.db, 50);
      if (!due.length) break;
      for (const c of due) {
        if (Date.now() > stop) {
          more = true;
          break;
        }
        if (
          engine.overBudget(
            this.db,
            utcDay(now),
            { sessions: 0, chunks: 0, bytes: c.bytes, derived: 0 },
            limits?.account,
            limits?.platform,
            this.usage,
          )
        ) {
          more = true; // tomorrow
          break;
        }
        const obj = await this.env.CHUNKS.get(prefix + engine.chunkKey(c.session_id, c.seq));
        if (!obj) {
          engine.markKept(this.db, c.session_id, c.seq, 0, 0, now);
          continue;
        }
        await this.env.CHUNKS.put(engine.starredKey(prefix, c.session_id, c.seq), obj.body, {
          httpMetadata: obj.httpMetadata,
          customMetadata: obj.customMetadata,
        });
        engine.markKept(this.db, c.session_id, c.seq, 1, c.bytes, now);
      }
      if (more || Date.now() > stop) {
        more = more || engine.starredCopyDue(this.db, 1).length > 0;
        break;
      }
    }
    this.setMeta("copy_at", more ? Date.now() + 30_000 : null);
    if (more) {
      const at = await this.ctx.storage.getAlarm();
      if (at === null || at > Date.now() + 30_000) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
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

  /** What a heatmap image is drawn from: the latest snapshot of a page load, click dots, scroll reach and attention. */
  heatmapImageData(q: { page: string; device: string; start: number; end: number }) {
    const h = queries.heatmap(this.db, { ...q, limit: 1 });
    return {
      snapshot: heatmapImage.latestSnapshot(this.db, q),
      dots: heatmapImage.clickDots(this.db, q),
      heat: { pageviews: h.pageviews, clicks: h.clicks, reach: h.scroll.reach, attention: h.attention },
    };
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
        const all = [...r.keys.map((k) => prefix + k), ...(r.starred_keys ?? [])];
        for (let i = 0; i < all.length; i += 1000) await this.env.CHUNKS.delete(all.slice(i, i + 1000));
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
    const next = this.metaNum("next_maint");
    // Woken for a webhook retry, starred copies or a tags batch only: maintenance keeps its own time.
    const maintDue = next === null || next <= now;
    let more = false;
    if (maintDue) {
      const r = await this.maintain();
      more = r.more;
      await this.checkSpikes(now).catch((e) => console.error("replay spike check failed", e));
    }
    await this.runWebhooks(now);
    const copyAt = this.metaNum("copy_at");
    if (maintDue || (copyAt !== null && copyAt <= now))
      await this.runCopies(now).catch((e) => console.error("replay starred copy failed", e));
    await this.runTags(now).catch((e) => console.error("replay tags forwarding failed", e));
    await this.reschedule(more, maintDue ? undefined : (next ?? undefined));
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

  /** The account's and deployment's daily budgets as last given by ingest (for work the alarm does). */
  private budgetCache: { account?: Budget; platform?: Budget } | null = null;
  private rememberBudgets(account: Budget | undefined, platform: Budget | undefined) {
    const v = JSON.stringify({ account, platform });
    if (this.budgetCache && JSON.stringify(this.budgetCache) === v) return;
    this.budgetCache = { account, platform };
    this.db.run("INSERT INTO meta (key, value) VALUES ('budgets', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [v]);
  }
  private budgets(): { account?: Budget; platform?: Budget } {
    if (this.budgetCache) return this.budgetCache;
    const v = this.db.all("SELECT value FROM meta WHERE key = 'budgets'")[0]?.value;
    this.budgetCache = v ? (JSON.parse(String(v)) as { account?: Budget; platform?: Budget }) : {};
    return this.budgetCache;
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
    const wake = [maint, this.metaNum("webhook_at"), this.metaNum("copy_at"), this.metaNum("tags_at")].filter(
      (x): x is number => x !== null,
    );
    const at = wake.length ? Math.min(...wake) : null;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}
