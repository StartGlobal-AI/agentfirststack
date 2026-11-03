import { badRequest, notFound } from "@afs/shared";
import type { AppEnv } from "../env";
import { type AttachmentRow, type MessageRow, type ThreadRow, messageDetail, messageSummary, threadJson } from "./format";
import { getInboxRow } from "./inboxes";

/** LIKE pattern with %/_ escaped (use with ESCAPE '\'). */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * User text -> safe FTS5 query: words only, each a quoted prefix term, AND-ed. Raw FTS5 syntax
 * (NEAR, column filters, unbalanced quotes) would otherwise throw on user input.
 */
export function ftsQuery(q: string): string | null {
  const words = (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w}"*`).join(" ");
}

/** Pagination cursor: "<received_at>.<seq>" (also accepts a bare unix-ms timestamp). */
export function parseCursor(before: string | number | undefined | null): { at: number; seq: number } | null {
  if (before === undefined || before === null || before === "") return null;
  const s = String(before);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (m) return { at: Number(m[1]), seq: m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER };
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return { at: t, seq: Number.MAX_SAFE_INTEGER };
  throw badRequest("Invalid `before` cursor.", "Pass the `next_before` value from the previous page, or a unix-ms timestamp.");
}

const cursorOf = (r: MessageRow) => `${r.received_at}.${r.seq}`;

export interface ListOptions {
  unread?: boolean;
  q?: string;
  from?: string;
  direction?: "in" | "out";
  limit?: number;
  before?: string | number;
}

function buildFilters(opts: ListOptions, where: string[], binds: unknown[]) {
  if (opts.unread) where.push("m.read = 0 AND m.direction = 'in'");
  if (opts.direction) {
    where.push("m.direction = ?");
    binds.push(opts.direction);
  }
  if (opts.from) {
    where.push("(m.from_address LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')");
    binds.push(likePattern(opts.from), likePattern(opts.from));
  }
  const cur = parseCursor(opts.before);
  if (cur) {
    where.push("(m.received_at < ? OR (m.received_at = ? AND m.seq < ?))");
    binds.push(cur.at, cur.at, cur.seq);
  }
}

async function runList(env: AppEnv, where: string[], binds: unknown[], opts: ListOptions) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let sql: string;
  if (opts.q) {
    const fq = ftsQuery(opts.q);
    if (!fq) throw badRequest("Search query has no words.", "Pass words to search for, e.g. q=verification.");
    sql = `SELECT m.* FROM messages_fts f JOIN messages m ON m.seq = f.rowid WHERE messages_fts MATCH ? AND ${where.join(" AND ")} ORDER BY m.received_at DESC, m.seq DESC LIMIT ?`;
    binds = [fq, ...binds];
  } else {
    sql = `SELECT m.* FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.received_at DESC, m.seq DESC LIMIT ?`;
  }
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit + 1)
    .all<MessageRow>();
  const page = results.slice(0, limit);
  return { messages: page.map(messageSummary), next_before: results.length > limit ? cursorOf(page[page.length - 1]!) : null };
}

export async function listMessages(env: AppEnv, accountId: string, inboxId: string, opts: ListOptions = {}) {
  await getInboxRow(env, accountId, inboxId);
  const where = ["m.inbox_id = ?"];
  const binds: unknown[] = [inboxId];
  buildFilters(opts, where, binds);
  return runList(env, where, binds, opts);
}

export async function searchMessages(env: AppEnv, accountId: string, opts: ListOptions & { inbox_id?: string }) {
  if (!opts.q?.trim()) throw badRequest("Missing q.", "GET /v1/search?q=invoice searches subject, sender and body across all inboxes.");
  const where = ["m.account_id = ?"];
  const binds: unknown[] = [accountId];
  if (opts.inbox_id) {
    where.push("m.inbox_id = ?");
    binds.push(opts.inbox_id);
  }
  buildFilters(opts, where, binds);
  return runList(env, where, binds, opts);
}

export async function getMessageRow(env: AppEnv, accountId: string, id: string): Promise<MessageRow> {
  const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ? AND account_id = ?").bind(id, accountId).first<MessageRow>();
  if (!row) throw notFound("Message", "GET /v1/inboxes/:id/messages lists messages; ids look like msg_...");
  return row;
}

export async function getMessage(env: AppEnv, accountId: string, id: string, opts: { include_html?: boolean } = {}) {
  const row = await getMessageRow(env, accountId, id);
  const [{ results: atts }, html] = await Promise.all([
    env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid").bind(id).all<AttachmentRow>(),
    opts.include_html === false || !row.html_key ? Promise.resolve(null) : env.BLOBS.get(row.html_key).then((o) => (o ? o.text() : null)),
  ]);
  return { message: messageDetail(row, { html, attachments: atts }) };
}

export async function getRawMessage(env: AppEnv, accountId: string, id: string): Promise<{ row: MessageRow; body: R2ObjectBody }> {
  const row = await getMessageRow(env, accountId, id);
  if (!row.raw_key) {
    throw notFound(
      "Raw MIME for this message",
      row.direction === "out"
        ? "Sent messages are composed by Email Service; only their text, HTML and attachments are stored. GET /v1/messages/" +
            id +
            " returns them."
        : undefined,
    );
  }
  const body = await env.BLOBS.get(row.raw_key);
  if (!body) throw notFound("Raw MIME object");
  return { row, body };
}

export async function getAttachment(
  env: AppEnv,
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ meta: AttachmentRow; body: R2ObjectBody }> {
  await getMessageRow(env, accountId, messageId);
  const meta = await env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND message_id = ?")
    .bind(attachmentId, messageId)
    .first<AttachmentRow>();
  if (!meta) throw notFound("Attachment", `GET /v1/messages/${messageId} lists its attachments.`);
  const body = await env.BLOBS.get(meta.r2_key);
  if (!body) throw notFound("Attachment content");
  return { meta, body };
}

export async function markRead(env: AppEnv, accountId: string, id: string, read: boolean) {
  const row = await getMessageRow(env, accountId, id);
  await env.DB.prepare("UPDATE messages SET read = ? WHERE id = ?")
    .bind(read ? 1 : 0, id)
    .run();
  return { message: messageSummary({ ...row, read: read ? 1 : 0 }) };
}

export async function deleteMessage(env: AppEnv, accountId: string, id: string) {
  const row = await getMessageRow(env, accountId, id);
  await deleteMessageRows(env, [row]);
  return { deleted: id };
}

/**
 * Delete many messages at once: their attachments, D1 rows (FTS follows by trigger), emptied
 * threads and R2 blobs. Ids travel as one JSON array parameter (json_each), so a batch is not
 * limited by D1's bound-parameter cap. Returns the number of rows given.
 */
export async function deleteMessageRows(
  env: AppEnv,
  rows: Pick<MessageRow, "id" | "thread_id" | "raw_key" | "html_key">[],
): Promise<number> {
  if (!rows.length) return 0;
  const ids = JSON.stringify(rows.map((r) => r.id));
  const threads = JSON.stringify([...new Set(rows.map((r) => r.thread_id))]);
  const inIds = "(SELECT value FROM json_each(?))";
  const { results: atts } = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id IN ${inIds}`)
    .bind(ids)
    .all<{ r2_key: string }>();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM attachments WHERE message_id IN ${inIds}`).bind(ids),
    env.DB.prepare(`DELETE FROM messages WHERE id IN ${inIds}`).bind(ids),
    env.DB.prepare(
      `UPDATE threads SET message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = threads.id),
         last_message_at = COALESCE((SELECT MAX(received_at) FROM messages WHERE thread_id = threads.id), last_message_at)
       WHERE id IN ${inIds}`,
    ).bind(threads),
    env.DB.prepare(`DELETE FROM threads WHERE id IN ${inIds} AND message_count = 0`).bind(threads),
  ]);
  const keys = [...rows.flatMap((r) => [r.raw_key, r.html_key]), ...atts.map((a) => a.r2_key)].filter((k): k is string => !!k);
  for (let i = 0; i < keys.length; i += 1000) await env.BLOBS.delete(keys.slice(i, i + 1000)); // R2 deletes up to 1000 keys per call
  return rows.length;
}

export async function getThread(env: AppEnv, accountId: string, threadId: string) {
  const t = await env.DB.prepare("SELECT * FROM threads WHERE id = ? AND account_id = ?").bind(threadId, accountId).first<ThreadRow>();
  if (!t) throw notFound("Thread", "Every message has a thread_id; GET /v1/inboxes/:id/threads lists threads.");
  const { results } = await env.DB.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC, seq ASC LIMIT 500")
    .bind(threadId)
    .all<MessageRow>();
  return { thread: { ...threadJson(t), messages: results.map(messageSummary) } };
}

export async function listThreads(env: AppEnv, accountId: string, inboxId: string, opts: { limit?: number; before?: number } = {}) {
  await getInboxRow(env, accountId, inboxId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const { results } = await env.DB.prepare(
    `SELECT * FROM threads WHERE inbox_id = ? ${opts.before ? "AND last_message_at < ?" : ""} ORDER BY last_message_at DESC LIMIT ?`,
  )
    .bind(...(opts.before ? [inboxId, opts.before, limit + 1] : [inboxId, limit + 1]))
    .all<ThreadRow>();
  const page = results.slice(0, limit);
  return { threads: page.map(threadJson), next_before: results.length > limit ? page[page.length - 1]!.last_message_at : null };
}
