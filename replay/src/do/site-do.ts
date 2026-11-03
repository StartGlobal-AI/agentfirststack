import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../env";
import type { Db, SqlValue } from "./db";
import * as engine from "./engine";
import * as queries from "./queries";

/**
 * One SQLite-backed Durable Object per replay site (idFromName(site_id)): the session index, the
 * derived event log (pages, clicks, inputs, errors, events, scroll milestones), signal flags,
 * heatmap rollups and ingest drop counters. The Worker validates the site against D1 before it
 * calls in, so storage is only ever created for real sites. Recording chunks live in R2; this
 * object returns their keys when sessions are deleted or purged and the Worker deletes them.
 */
export class ReplaySiteDO extends DurableObject<Bindings> {
  private db: Db;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.db = {
      all: (q: string, args: SqlValue[] = []) => sql.exec(q, ...args).toArray() as Record<string, SqlValue>[],
      run: (q: string, args: SqlValue[] = []) => {
        sql.exec(q, ...args);
      },
      transaction: <T>(fn: () => T): T => ctx.storage.transactionSync(fn),
    };
    engine.migrate(this.db); // idempotent (CREATE ... IF NOT EXISTS)
  }

  ingest(req: engine.IngestRequest): engine.IngestResult {
    return engine.ingestChunk(this.db, req);
  }

  recordDrop(reason: string, sample: string | null): void {
    engine.recordDrop(this.db, reason, sample, Date.now());
  }

  summary() {
    return engine.summary(this.db, Date.now());
  }

  search(q: queries.SearchRequest) {
    return queries.searchSessions(this.db, q);
  }

  session(id: string) {
    const session = queries.getSessionRow(this.db, id);
    return session ? { session, pages: queries.sessionPages(this.db, id), chunks: engine.chunkSeqs(this.db, id) } : null;
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

  deleteSessions(ids: string[]) {
    return engine.deleteSessions(this.db, ids);
  }

  findVisitor(q: { user_id?: string; analytics_visitor_id?: string }) {
    return queries.findVisitorSessions(this.db, q);
  }

  purge(req: engine.PurgeRequest) {
    return engine.purge(this.db, req);
  }

  /**
   * Delete everything (site deleted). A tombstone stays, so a chunk that slips in from a cached
   * loader can't recreate storage. R2 chunks are removed by prefix by the hourly cron.
   */
  async destroy(): Promise<{ ok: true }> {
    await this.ctx.storage.deleteAll();
    engine.migrate(this.db);
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('deleted', ?)", [String(Date.now())]);
    return { ok: true };
  }
}
