import { badRequest, notFound } from "@afs/shared";
import PostalMime from "postal-mime";
import { type AppEnv, cap, standingOf } from "../env";
import { headerSafe } from "../lib/headers";
import { assertActive, dailyLimitError, rateLimit, refundDaily, reserveDaily } from "./budgets";
import { type AttachmentRow, type MessageRow, type ThreadRow, labelsOf, messageDetail, messageSummary, threadJson } from "./format";
import { getInboxRow } from "./inboxes";

/** Search words shorter than this are ignored (they would match nearly everything). */
export const MIN_SEARCH_TERM_CHARS = 3;
export const MAX_SEARCH_TERMS = 5;
/** Search looks through at most this many of the newest messages (before the cursor) per query. */
export const SEARCH_SCAN_ROWS = 2_000;

/**
 * User text -> search terms (pure): words of letters and digits, lowercased, at least
 * MIN_SEARCH_TERM_CHARS characters, deduplicated, at most MAX_SEARCH_TERMS. Every term must occur
 * (case-insensitive substring) in the subject, sender name, sender address or text.
 */
export function searchTerms(q: string): string[] {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => [...w].length >= MIN_SEARCH_TERM_CHARS);
  return [...new Set(words)].slice(0, MAX_SEARCH_TERMS);
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

/** has= values: an extracted code, an action link, attachments. */
export const HAS_VALUES = ["code", "link", "attachments"] as const;

export interface ListOptions {
  unread?: boolean;
  q?: string;
  /** Substring of the sender address or name. */
  from?: string;
  /** Substring of a To/Cc address or name, or of the envelope recipient. */
  to?: string;
  /** Substring of the subject. */
  subject?: string;
  direction?: "in" | "out";
  /** Plus-address tag, exact (`me+github@` -> "github"). */
  tag?: string;
  /** Comma-separated: code, link, attachments (all must hold). */
  has?: string;
  /** Sender authentication verdict: pass | fail | unknown. */
  auth?: "pass" | "fail" | "unknown";
  limit?: number;
  /** Newest first (default) or oldest first. */
  order?: "asc" | "desc";
  /** Cursor or unix ms: only messages before it (desc paging: next_before). */
  before?: string | number;
  /** Cursor or unix ms: only messages after it (asc paging: next_after). */
  after?: string | number;
  /** Comma-separated labels, all must be on the message (custom or system labels). */
  labels?: string;
  /** Outbound status: sent | failed | scheduled. */
  status?: string;
}

// ---------------------------------------------------------------------------------------------
// Labels

export const LABEL_RE = /^[a-z0-9:_-]{1,64}$/;
export const MAX_LABELS = 20;
/**
 * Read-only labels that describe a message: usable in labels= filters, never added or removed.
 * They mirror fields (read, direction, automated, auth_verdict, code, verify_link, attachments).
 */
export const SYSTEM_LABELS: Record<string, string> = {
  unread: "m.read = 0 AND m.direction = 'in'",
  read: "m.read = 1",
  received: "m.direction = 'in'",
  sent: "m.direction = 'out'",
  automated: "m.automated = 1",
  unauthenticated: "m.direction = 'in' AND COALESCE(json_extract(m.auth_json, '$.verdict'), 'unknown') != 'pass'",
  "has-code": "m.code IS NOT NULL",
  "has-link": "m.verify_link IS NOT NULL",
  "has-attachments": "(m.attachment_count > 0 OR m.attachments_omitted > 0)",
};

/** Labels from input: lowercase, valid, not a system label, deduplicated. Pure. */
export function parseLabels(list: string[] | undefined, field: string): string[] {
  const out = [...new Set((list ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))];
  for (const l of out) {
    if (!LABEL_RE.test(l))
      throw badRequest(
        `${field}: "${l}" is not a valid label.`,
        "Labels are 1-64 characters of a-z 0-9 : _ - (e.g. handled, needs-human, project:acme).",
      );
    if (l in SYSTEM_LABELS)
      throw badRequest(
        `${field}: "${l}" is a system label.`,
        `System labels (${Object.keys(SYSTEM_LABELS).join(", ")}) follow the message and can't be set; filter with labels=${l}.`,
      );
  }
  return out;
}

/** Current labels plus `add` minus `remove`, at most MAX_LABELS. Pure. */
export function applyLabels(current: string[], add: string[], remove: string[]): string[] {
  const next = [...current.filter((l) => !remove.includes(l)), ...add.filter((l) => !current.includes(l) && !remove.includes(l))];
  if (next.length > MAX_LABELS)
    throw badRequest(`At most ${MAX_LABELS} labels per message or thread.`, "Remove labels you no longer need (remove_labels) first.");
  return next;
}

/** labels= filter -> SQL on `alias` (m for messages, t for threads; threads have no system labels). */
function labelConditions(labels: string | undefined, alias: "m" | "t", where: string[], binds: unknown[]) {
  for (const l of (labels ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)) {
    if (alias === "m" && l in SYSTEM_LABELS) where.push(SYSTEM_LABELS[l]!);
    else if (LABEL_RE.test(l)) {
      where.push(`EXISTS (SELECT 1 FROM json_each(${alias}.labels_json) j WHERE j.value = ?)`);
      binds.push(l);
    } else throw badRequest(`labels: "${l}" is not a valid label.`, "Labels are 1-64 characters of a-z 0-9 : _ -.");
  }
}

/** has= -> its list of conditions; 400 for unknown values. Pure. */
export function parseHas(has: string | undefined): (typeof HAS_VALUES)[number][] {
  if (!has) return [];
  const out = has
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of out)
    if (!(HAS_VALUES as readonly string[]).includes(h))
      throw badRequest(`Unknown has=${h}.`, `Use one or more of ${HAS_VALUES.join(", ")} (comma-separated, all must hold).`);
  return out as (typeof HAS_VALUES)[number][];
}

function buildFilters(opts: ListOptions, where: string[], binds: unknown[]) {
  if (opts.unread) where.push("m.read = 0 AND m.direction = 'in'");
  if (opts.direction) {
    where.push("m.direction = ?");
    binds.push(opts.direction);
  }
  // instr(), not LIKE: D1 refuses LIKE patterns over 50 bytes.
  if (opts.from) {
    where.push("(instr(lower(m.from_address), ?) > 0 OR instr(lower(m.from_name), ?) > 0)");
    const p = opts.from.toLowerCase();
    binds.push(p, p);
  }
  if (opts.to) {
    where.push("(instr(lower(m.to_json), ?) > 0 OR instr(lower(m.cc_json), ?) > 0 OR instr(lower(m.envelope_to), ?) > 0)");
    const p = opts.to.toLowerCase();
    binds.push(p, p, p);
  }
  if (opts.subject) {
    where.push("instr(lower(m.subject), ?) > 0");
    binds.push(opts.subject.toLowerCase());
  }
  if (opts.tag) {
    where.push("m.tag = ?");
    binds.push(opts.tag.toLowerCase());
  }
  for (const h of parseHas(opts.has)) {
    if (h === "code") where.push("m.code IS NOT NULL");
    if (h === "link") where.push("m.verify_link IS NOT NULL");
    if (h === "attachments") where.push("(m.attachment_count > 0 OR m.attachments_omitted > 0)");
  }
  if (opts.auth) {
    if (opts.auth === "unknown")
      where.push("(m.auth_json IS NULL OR COALESCE(json_extract(m.auth_json, '$.verdict'), 'unknown') = 'unknown')");
    else {
      where.push("json_extract(m.auth_json, '$.verdict') = ?");
      binds.push(opts.auth);
    }
  }
  labelConditions(opts.labels, "m", where, binds);
  if (opts.status) {
    where.push("m.status = ?");
    binds.push(opts.status);
  }
  const cur = parseCursor(opts.before);
  if (cur) {
    where.push("(m.received_at < ? OR (m.received_at = ? AND m.seq < ?))");
    binds.push(cur.at, cur.at, cur.seq);
  }
  const aft = parseAfterCursor(opts.after);
  if (aft) {
    where.push("(m.received_at > ? OR (m.received_at = ? AND m.seq > ?))");
    binds.push(aft.at, aft.at, aft.seq);
  }
}

/** `after`: "<received_at>.<seq>" (next_after), unix ms, or an ISO date; seq 0 for a bare time. */
export function parseAfterCursor(after: string | number | undefined | null): { at: number; seq: number } | null {
  if (after === undefined || after === null || after === "") return null;
  const s = String(after);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (m) return { at: Number(m[1]), seq: m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER };
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return { at: t, seq: Number.MAX_SAFE_INTEGER };
  throw badRequest(
    "Invalid `after` cursor.",
    "Pass the `next_after` value from the previous page (order=asc), a unix-ms timestamp or an ISO date.",
  );
}

async function runList(
  env: AppEnv,
  where: string[],
  binds: unknown[],
  opts: ListOptions,
  scope?: { column: "account_id" | "inbox_id"; value: string },
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const asc = opts.order === "asc";
  if (opts.q !== undefined) {
    const terms = searchTerms(opts.q);
    if (!terms.length)
      throw badRequest(
        `Search needs a word of at least ${MIN_SEARCH_TERM_CHARS} letters or digits.`,
        "Pass words to search for, e.g. q=verification (shorter words are ignored; every word must appear).",
      );
    // Scoped to this account's (or inbox's) newest messages, newest first: the work is bounded by
    // the account's own mail, never by everyone's (a global full-text prefix scan could stall D1).
    for (const t of terms) {
      where.push(
        "(instr(lower(m.subject), ?) > 0 OR instr(lower(m.from_name), ?) > 0 OR instr(lower(m.from_address), ?) > 0 OR instr(lower(m.text_body), ?) > 0)",
      );
      binds.push(t, t, t, t);
    }
    if (scope) {
      const cur = parseCursor(opts.before);
      const window = `m.seq IN (SELECT seq FROM messages WHERE ${scope.column} = ?${cur ? " AND (received_at < ? OR (received_at = ? AND seq < ?))" : ""} ORDER BY received_at DESC, seq DESC LIMIT ${SEARCH_SCAN_ROWS})`;
      where.push(window);
      binds.push(scope.value, ...(cur ? [cur.at, cur.at, cur.seq] : []));
    }
  }
  const dir = asc ? "ASC" : "DESC";
  const sql = `SELECT m.* FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.received_at ${dir}, m.seq ${dir} LIMIT ?`;
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit + 1)
    .all<MessageRow>();
  const page = results.slice(0, limit);
  const more = results.length > limit;
  const last = page[page.length - 1];
  return {
    messages: page.map(messageSummary),
    next_before: !asc && more && last ? cursorOf(last) : null,
    ...(asc ? { next_after: more && last ? cursorOf(last) : null } : {}),
  };
}

const searchHint =
  "Search is limited per account per minute. Narrow it with inbox_id, from or more specific words, and page with before=next_before instead of repeating it. Retry in a minute.";

export async function listMessages(env: AppEnv, accountId: string, inboxId: string, opts: ListOptions = {}) {
  await getInboxRow(env, accountId, inboxId);
  if (opts.q !== undefined && opts.q !== "") await rateLimit(env.SEARCH_LIMITER, `search:${accountId}`, "search", searchHint);
  else opts = { ...opts, q: undefined };
  const where = ["m.inbox_id = ?"];
  const binds: unknown[] = [inboxId];
  buildFilters(opts, where, binds);
  return runList(env, where, binds, opts, { column: "inbox_id", value: inboxId });
}

export async function searchMessages(env: AppEnv, accountId: string, opts: ListOptions & { inbox_id?: string }) {
  if (!opts.q?.trim()) throw badRequest("Missing q.", "GET /v1/search?q=invoice searches subject, sender and body across all inboxes.");
  await rateLimit(env.SEARCH_LIMITER, `search:${accountId}`, "search", searchHint);
  const where = ["m.account_id = ?"];
  const binds: unknown[] = [accountId];
  if (opts.inbox_id) {
    where.push("m.inbox_id = ?");
    binds.push(opts.inbox_id);
  }
  buildFilters(opts, where, binds);
  return runList(
    env,
    where,
    binds,
    opts,
    opts.inbox_id ? { column: "inbox_id", value: opts.inbox_id } : { column: "account_id", value: accountId },
  );
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
  const detail = messageDetail(row, { html, attachments: atts });
  if (row.direction !== "out") return { message: detail };
  const { deliveryOf } = await import("./delivery"); // delivery.ts imports this module
  return { message: { ...detail, delivery: await deliveryOf(env, row) } };
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

/**
 * An attachment's metadata, and `open()` for its content. Attachments of received mail are not
 * stored twice: open() parses the stored raw MIME and returns the part at `part_index` (checked
 * against the stored size and filename). Others (sent mail, mail received before migration 0010)
 * are their own R2 object.
 */
export async function getAttachment(
  env: AppEnv,
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ meta: AttachmentRow; open: () => Promise<ReadableStream | Uint8Array> }> {
  const row = await getMessageRow(env, accountId, messageId);
  const meta = await env.DB.prepare("SELECT * FROM attachments WHERE id = ? AND message_id = ?")
    .bind(attachmentId, messageId)
    .first<AttachmentRow>();
  if (!meta) throw notFound("Attachment", `GET /v1/messages/${messageId} lists its attachments.`);
  const open = async (): Promise<ReadableStream | Uint8Array> => {
    if (meta.part_index === null || meta.part_index === undefined) {
      const body = await env.BLOBS.get(meta.r2_key);
      if (!body) throw notFound("Attachment content");
      return body.body;
    }
    const raw = row.raw_key ? await env.BLOBS.get(row.raw_key) : null;
    if (!raw) throw notFound("Attachment content", `The raw message is gone; GET /v1/messages/${messageId} shows what is left.`);
    const parsed = await PostalMime.parse(await raw.arrayBuffer(), { attachmentEncoding: "arraybuffer" });
    const bytes = (a: (typeof parsed.attachments)[number] | undefined) =>
      !a ? null : typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content as ArrayBuffer);
    const at = bytes(parsed.attachments[meta.part_index]);
    if (at && at.byteLength === meta.size) return at;
    // Defensive: a parser that orders parts differently. Fall back to the part with the same size and name.
    const name = (f: string | null | undefined) => (f ? headerSafe(f).slice(0, 255) || null : null); // as ingest stores it
    const same = parsed.attachments.find((a) => bytes(a)?.byteLength === meta.size && name(a.filename) === meta.filename);
    const content = bytes(same);
    if (!content) throw notFound("Attachment content");
    return content;
  };
  return { meta, open };
}

export async function markRead(env: AppEnv, accountId: string, id: string, read: boolean) {
  const row = await getMessageRow(env, accountId, id);
  await env.DB.prepare("UPDATE messages SET read = ? WHERE id = ?")
    .bind(read ? 1 : 0, id)
    .run();
  return { message: messageSummary({ ...row, read: read ? 1 : 0 }) };
}

export interface MessageUpdate {
  read?: boolean;
  add_labels?: string[];
  remove_labels?: string[];
}

/** PATCH /v1/messages/:id: read state and labels. */
export async function updateMessage(env: AppEnv, accountId: string, id: string, input: MessageUpdate) {
  const row = await getMessageRow(env, accountId, id);
  const add = parseLabels(input.add_labels, "add_labels");
  const remove = parseLabels(input.remove_labels, "remove_labels");
  const labels = add.length || remove.length ? applyLabels(labelsOf(row), add, remove) : labelsOf(row);
  const read = input.read === undefined ? row.read : input.read ? 1 : 0;
  const labels_json = labels.length ? JSON.stringify(labels) : null;
  await env.DB.prepare("UPDATE messages SET read = ?, labels_json = ? WHERE id = ?").bind(read, labels_json, id).run();
  return { message: messageSummary({ ...row, read, labels_json }) };
}

/** POST /v1/messages/batch: one change for up to 100 messages (read, labels, or delete). */
export async function batchUpdateMessages(env: AppEnv, accountId: string, input: MessageUpdate & { ids: string[]; delete?: boolean }) {
  const ids = [...new Set(input.ids)];
  if (!ids.length || ids.length > 100)
    throw badRequest("Pass 1 to 100 ids.", "Split larger batches; list ids with GET /v1/inboxes/:id/messages.");
  const { results } = await env.DB.prepare("SELECT * FROM messages WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(accountId, JSON.stringify(ids))
    .all<MessageRow>();
  const found = new Set(results.map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (input.delete) {
    if (input.read !== undefined || input.add_labels?.length || input.remove_labels?.length)
      throw badRequest("delete can't be combined with read or labels.", "Send two batches: one to change, one to delete.");
    await deleteMessageRows(env, results);
    return { deleted: results.map((r) => r.id), not_found: missing };
  }
  const add = parseLabels(input.add_labels, "add_labels");
  const remove = parseLabels(input.remove_labels, "remove_labels");
  if (input.read === undefined && !add.length && !remove.length)
    throw badRequest(
      "Nothing to change.",
      'Pass read, add_labels, remove_labels or delete: true, e.g. {"ids":[...],"add_labels":["handled"]}.',
    );
  const next = results.map((r) => {
    const labels = applyLabels(labelsOf(r), add, remove);
    return {
      ...r,
      read: input.read === undefined ? r.read : input.read ? 1 : 0,
      labels_json: labels.length ? JSON.stringify(labels) : null,
    };
  });
  for (let i = 0; i < next.length; i += 50)
    await env.DB.batch(
      next
        .slice(i, i + 50)
        .map((r) => env.DB.prepare("UPDATE messages SET read = ?, labels_json = ? WHERE id = ?").bind(r.read, r.labels_json, r.id)),
    );
  return { updated: next.map(messageSummary), not_found: missing };
}

/** Delete a message; a scheduled one is canceled (it never goes out). */
export async function deleteMessage(env: AppEnv, accountId: string, id: string) {
  const row = await getMessageRow(env, accountId, id);
  if (row.status === "sending")
    throw badRequest("This scheduled message is being sent right now.", `GET /v1/messages/${id} in a few seconds shows the result.`);
  await deleteMessageRows(env, [row]);
  return { deleted: id, ...(row.status === "scheduled" ? { canceled: true } : {}) };
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

async function getThreadRow(env: AppEnv, accountId: string, threadId: string): Promise<ThreadRow> {
  const t = await env.DB.prepare("SELECT * FROM threads WHERE id = ? AND account_id = ?").bind(threadId, accountId).first<ThreadRow>();
  if (!t) throw notFound("Thread", "Every message has a thread_id; GET /v1/threads lists threads.");
  return t;
}

export async function getThread(env: AppEnv, accountId: string, threadId: string) {
  const t = await getThreadRow(env, accountId, threadId);
  const { results } = await env.DB.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC, seq ASC LIMIT 500")
    .bind(threadId)
    .all<MessageRow>();
  return { thread: { ...threadJson(t), messages: results.map(messageSummary) } };
}

export interface ThreadListOptions {
  inbox_id?: string;
  /** Substring of the subject. */
  q?: string;
  labels?: string;
  limit?: number;
  /** last_message_at (unix ms): threads active before / after it. */
  before?: number;
  after?: number;
}

/** Threads of one inbox, or of the whole account (no inbox_id), most recent activity first. */
export async function listThreads(env: AppEnv, accountId: string, inboxId: string | null, opts: ThreadListOptions = {}) {
  const inbox = inboxId ?? opts.inbox_id ?? null;
  if (inbox) await getInboxRow(env, accountId, inbox);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = inbox ? ["t.inbox_id = ?"] : ["t.account_id = ?"];
  const binds: unknown[] = [inbox ?? accountId];
  if (opts.before) {
    where.push("t.last_message_at < ?");
    binds.push(opts.before);
  }
  if (opts.after) {
    where.push("t.last_message_at > ?");
    binds.push(opts.after);
  }
  if (opts.q) {
    where.push("instr(lower(t.subject), ?) > 0");
    binds.push(opts.q.toLowerCase());
  }
  labelConditions(opts.labels, "t", where, binds);
  const { results } = await env.DB.prepare(`SELECT t.* FROM threads t WHERE ${where.join(" AND ")} ORDER BY t.last_message_at DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<ThreadRow>();
  const page = results.slice(0, limit);
  return { threads: page.map(threadJson), next_before: results.length > limit ? page[page.length - 1]!.last_message_at : null };
}

/** PATCH /v1/threads/:id: labels on the thread; read applies to every inbound message in it. */
export async function updateThread(env: AppEnv, accountId: string, threadId: string, input: MessageUpdate) {
  const t = await getThreadRow(env, accountId, threadId);
  const add = parseLabels(input.add_labels, "add_labels");
  const remove = parseLabels(input.remove_labels, "remove_labels");
  const labels = applyLabels(labelsOf(t), add, remove);
  const labels_json = labels.length ? JSON.stringify(labels) : null;
  await env.DB.batch([
    env.DB.prepare("UPDATE threads SET labels_json = ? WHERE id = ?").bind(labels_json, threadId),
    ...(input.read === undefined
      ? []
      : [env.DB.prepare("UPDATE messages SET read = ? WHERE thread_id = ? AND direction = 'in'").bind(input.read ? 1 : 0, threadId)]),
  ]);
  return { thread: threadJson({ ...t, labels_json }) };
}

/** DELETE /v1/threads/:id: every message in it (and their blobs), then the thread. */
export async function deleteThread(env: AppEnv, accountId: string, threadId: string) {
  await getThreadRow(env, accountId, threadId);
  let deleted = 0;
  for (;;) {
    const { results } = await env.DB.prepare("SELECT id, thread_id, raw_key, html_key FROM messages WHERE thread_id = ? LIMIT 500")
      .bind(threadId)
      .all<Pick<MessageRow, "id" | "thread_id" | "raw_key" | "html_key">>();
    deleted += await deleteMessageRows(env, results);
    if (results.length < 500) break;
  }
  await env.DB.prepare("DELETE FROM threads WHERE id = ? AND account_id = ?").bind(threadId, accountId).run();
  return { deleted: threadId, messages_deleted: deleted };
}

/** Wall time one clear may spend; the rest is left for the next call (`more: true`). */
const CLEAR_BUDGET_MS = 15_000;

/**
 * DELETE /v1/inboxes/:id/messages?before=: delete an inbox's messages (all, or those received
 * before `before`), in and out, with their blobs; the inbox and its address stay. Counts toward
 * MAX_INBOX_CLEARS_PER_DAY. A very full inbox may need a second call (`more: true`).
 */
export async function clearInbox(
  env: AppEnv,
  accountId: string,
  inboxId: string,
  opts: { before?: string | number } = {},
  now = Date.now(),
) {
  await getInboxRow(env, accountId, inboxId);
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const cur = parseCursor(opts.before);
  const limit = cap(env, standing, "MAX_INBOX_CLEARS_PER_DAY");
  const budget = await reserveDaily(env, accountId, "inbox_clear", limit, now);
  if (!budget.ok)
    throw dailyLimitError(
      `this account cleared inboxes ${limit} times today`,
      limit,
      "Delete single messages (DELETE /v1/messages/:id) or let retention and ttl_days remove old mail.",
    );
  const stop = Date.now() + CLEAR_BUDGET_MS;
  let deleted = 0;
  let more = false;
  try {
    for (;;) {
      const { results } = await env.DB.prepare(
        `SELECT id, thread_id, raw_key, html_key FROM messages WHERE inbox_id = ?${cur ? " AND (received_at < ? OR (received_at = ? AND seq < ?))" : ""} LIMIT 200`,
      )
        .bind(inboxId, ...(cur ? [cur.at, cur.at, cur.seq] : []))
        .all<Pick<MessageRow, "id" | "thread_id" | "raw_key" | "html_key">>();
      deleted += await deleteMessageRows(env, results);
      if (results.length < 200) break;
      if (Date.now() >= stop) {
        more = true;
        break;
      }
    }
  } catch (e) {
    if (!deleted) await refundDaily(env, accountId, "inbox_clear", budget.day);
    throw e;
  }
  return {
    inbox_id: inboxId,
    deleted,
    more,
    next_steps: more ? [`More is left: call DELETE /v1/inboxes/${inboxId}/messages again.`] : [],
  };
}
