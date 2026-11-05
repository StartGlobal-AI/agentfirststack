import { newId } from "@afs/shared";
import PostalMime, { type Address, type Email } from "postal-mime";
import { type AppEnv, type Standing, cap, standingOf } from "../env";
import { type ExtractedLink, extractAll } from "../extract";
import { type AuthResults, extractAuth } from "../extract/auth";
import { MAX_ICS_CHARS, parseIcs } from "../extract/calendar";
import { cleanTag, normalizeRecipient } from "../lib/address";
import { forwardEligibility } from "../lib/forwarding";
import { headerSafe, isMimeType } from "../lib/headers";
import { UNAUTHENTICATED_SENDER, isAutomated, senderKeyFor } from "../lib/sender";
import { bracketMessageId, hasReplyPrefix, normalizeSubject, threadLookupIds } from "../lib/threading";
import { type Addr, type InboxRow, type MessageRow, UNTRUSTED_NOTICE, messageSummary, utcDay } from "./format";
import { maxBlobBytes } from "./budgets";
import { findInboxForRecipient, sharedDomain } from "./inboxes";
import { receiveRefusal } from "./lists";
import { deleteMessageRows } from "./messages";

export { DEFAULT_MAX_BLOB_BYTES, DEFAULT_UNCLAIMED_MAX_BLOB_BYTES, maxBlobBytes, storedBlobBytes } from "./budgets";
import { emitEvent } from "./webhooks";

/** Email Routing's inbound limit. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/**
 * Plain text kept in D1 (and indexed), in UTF-8 bytes. Longer bodies are cut there and flagged
 * `text_truncated`; the raw MIME in R2 keeps everything.
 */
export const MAX_TEXT_BYTES = 64 * 1024;
/** Other sender-controlled fields are bounded too, so one message is a bounded D1 row. */
export const MAX_SUBJECT_CHARS = 2_000;
export const MAX_NAME_CHARS = 500;
export const MAX_LISTED_ADDRESSES = 100;
export const MAX_REFERENCES_CHARS = 8_000;
/**
 * Attachments listed per inbound message (a D1 row each, served from the raw MIME); the rest are
 * only in the raw MIME.
 */
export const MAX_STORED_ATTACHMENTS = 50;
export const MAX_FILENAME_CHARS = 255;
/** Over MAX_TEXT_BYTES_PER_ACCOUNT, a message keeps this much text and this many links in D1. */
export const OVER_BUDGET_TEXT_BYTES = 2 * 1024;
export const OVER_BUDGET_LINKS = 10;
const THREAD_WINDOW_MS = 30 * 86_400_000;
/** Bound for "no cap" in SQL (Infinity cannot be bound). */
const NO_CAP = 1_000_000_000;

/** Cut text to at most `maxBytes` of UTF-8 without splitting a character. Pure. */
export function capText(text: string, maxBytes = MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  if (text.length * 3 <= maxBytes) return { text, truncated: false }; // UTF-8 needs at most 3 bytes per UTF-16 unit
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  return read >= text.length ? { text, truncated: false } : { text: text.slice(0, read), truncated: true };
}

/** Keep the newest ids of an oversized References header (whole ids only). */
function capReferences(refs: string | null | undefined): string | null {
  if (!refs) return null;
  if (refs.length <= MAX_REFERENCES_CHARS) return refs;
  const tail = refs.slice(-MAX_REFERENCES_CHARS);
  const start = tail.indexOf("<");
  return start >= 0 ? tail.slice(start) : null;
}

// ---------------------------------------------------------------------------------------------
// Inbound admission (all off when unset unless a default is given; UNCLAIMED_* variants via capFor):
//   MAX_INBOUND_PER_ACCOUNT_PER_DAY  the account's inbound mail per UTC day. Checked before the
//                                    body is read, and counted in the same transaction that stores
//                                    the message: mail that is not stored (rejected, a duplicate,
//                                    an invocation that died) never uses up the quota.
//   MAX_INBOUND_PER_SENDER_PER_DAY   one sender's mail to one inbox per UTC day; and one sender
//                                    never gets more than half of the account's daily quota.
//                                    Checked right after the headers are parsed, before the body.
//   MAX_MESSAGES_PER_INBOX           what an inbox holds: beyond it the oldest mail of the sender
//                                    holding the most is evicted (one flooder cannot fill it)
//   MAX_BLOB_BYTES_PER_ACCOUNT       bytes of mail kept in R2 (default 1 GiB, 256 MiB unclaimed;
//                                    "0" = off): checked before the body is read and again, with the
//                                    exact size, in the transaction that stores the message.

export const maxMessagesPerInbox = (env: AppEnv, standing: Standing) => Math.max(1, cap(env, standing, "MAX_MESSAGES_PER_INBOX"));
export const maxInboundPerDay = (env: AppEnv, standing: Standing) => cap(env, standing, "MAX_INBOUND_PER_ACCOUNT_PER_DAY");

export type Admission = { ok: true; day: string | null } | { ok: false; reason: string };

/** 1.5 GB, 256 MB, 40 KB, 900 bytes. */
export function formatBytes(n: number): string {
  const units: [number, string][] = [
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "KB"],
  ];
  for (const [size, unit] of units) if (n >= size) return `${Math.round((n / size) * 10) / 10} ${unit}`;
  return `${n} bytes`;
}

/**
 * Why the inbox's account cannot take a message of `bytes` more stored bytes now, or null: its
 * daily quota is used up, or its storage would pass MAX_BLOB_BYTES_PER_ACCOUNT. Read-only (one
 * query): the email() handler calls it before reading the body, ingest again after a refused
 * commit to say why.
 */
export async function inboundRefusal(
  env: AppEnv,
  inbox: InboxRow,
  standing: Standing,
  bytes: number,
  now = Date.now(),
): Promise<string | null> {
  const perDay = maxInboundPerDay(env, standing);
  const blobCap = maxBlobBytes(env, standing);
  if (!Number.isFinite(perDay) && !Number.isFinite(blobCap)) return null;
  const row = await env.DB.prepare(
    `SELECT (SELECT count FROM inbound_counters WHERE account_id = ?1 AND day = ?2) AS today,
            (SELECT blob_bytes FROM account_usage WHERE account_id = ?1) AS stored`,
  )
    .bind(inbox.account_id, utcDay(now))
    .first<{ today: number | null; stored: number | null }>();
  if ((row?.today ?? 0) >= perDay)
    return `Daily limit reached: the account behind ${inbox.address} received its maximum of ${perDay} messages today (UTC); retry after 00:00 UTC`;
  if ((row?.stored ?? 0) + bytes > blobCap)
    return `Mailbox full: the account behind ${inbox.address} keeps at most ${formatBytes(blobCap)} of mail and this message does not fit; it accepts mail again once older mail is deleted`;
  return null;
}

/**
 * SQL condition (for the INSERT of the message) that admits it only if the account's daily quota
 * and stored-bytes budget still have room, evaluated inside the commit's transaction: concurrent
 * deliveries cannot overshoot either. null when neither is capped.
 */
function admissionGuard(env: AppEnv, inbox: InboxRow, standing: Standing, bytes: number, day: string) {
  const perDay = maxInboundPerDay(env, standing);
  const blobCap = maxBlobBytes(env, standing);
  const parts: string[] = [];
  const binds: unknown[] = [];
  if (Number.isFinite(perDay)) {
    parts.push("COALESCE((SELECT count FROM inbound_counters WHERE account_id = ? AND day = ?), 0) < ?");
    binds.push(inbox.account_id, day, perDay);
  }
  if (Number.isFinite(blobCap)) {
    parts.push("COALESCE((SELECT blob_bytes FROM account_usage WHERE account_id = ?), 0) + ? <= ?");
    binds.push(inbox.account_id, bytes, blobCap);
  }
  return parts.length ? { sql: parts.join(" AND "), binds, countDay: Number.isFinite(perDay) } : null;
}

/**
 * Per-sender admission, once the sender is known (after parsing): at most
 * MAX_INBOUND_PER_SENDER_PER_DAY messages from one sender key to one inbox per UTC day, and at
 * most half of MAX_INBOUND_PER_ACCOUNT_PER_DAY from one sender key across the account, so one
 * outsider can neither fill an inbox nor use up the account's daily quota. One atomic statement.
 */
export async function admitSender(env: AppEnv, standing: Standing, inbox: InboxRow, sender: string, now = Date.now()): Promise<Admission> {
  const perInbox = cap(env, standing, "MAX_INBOUND_PER_SENDER_PER_DAY");
  const perDay = maxInboundPerDay(env, standing);
  const perAccount = Number.isFinite(perDay) ? Math.max(1, Math.floor(perDay / 2)) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(perInbox) && !Number.isFinite(perAccount)) return { ok: true, day: null };
  const bound = (n: number) => (Number.isFinite(n) ? n : NO_CAP);
  const day = utcDay(now);
  const sum = "(SELECT COALESCE(SUM(count), 0) FROM sender_counters WHERE account_id = ?4 AND sender = ?2 AND day = ?3)";
  const row = await env.DB.prepare(
    `INSERT INTO sender_counters (inbox_id, sender, day, account_id, count)
     SELECT ?1, ?2, ?3, ?4, 1 WHERE ?5 >= 1 AND ${sum} < ?6
     ON CONFLICT(inbox_id, sender, day) DO UPDATE SET count = sender_counters.count + 1
     WHERE sender_counters.count < ?5 AND ${sum} < ?6
     RETURNING count`,
  )
    .bind(inbox.id, sender, day, inbox.account_id, bound(perInbox), bound(perAccount))
    .first<{ count: number }>();
  if (!row)
    return {
      ok: false,
      reason:
        sender === UNAUTHENTICATED_SENDER
          ? `Too much unauthenticated mail (no SPF, DKIM or DMARC pass) to ${inbox.address} today (UTC); retry after 00:00 UTC`
          : `Too much mail from ${sender} to ${inbox.address} today (UTC); retry after 00:00 UTC`,
    };
  return { ok: true, day };
}

async function refundSender(env: AppEnv, inboxId: string, sender: string, day: string | null) {
  if (!day) return;
  await env.DB.prepare("UPDATE sender_counters SET count = MAX(0, count - 1) WHERE inbox_id = ? AND sender = ? AND day = ?")
    .bind(inboxId, sender, day)
    .run();
}

/** MAX_TEXT_BYTES_PER_ACCOUNT: would `addBytes` more of stored text pass the account's budget? */
export async function overTextBudget(env: AppEnv, standing: Standing, accountId: string, addBytes: number): Promise<boolean> {
  const budget = cap(env, standing, "MAX_TEXT_BYTES_PER_ACCOUNT");
  if (!Number.isFinite(budget)) return false;
  const row = await env.DB.prepare("SELECT text_bytes FROM account_usage WHERE account_id = ?")
    .bind(accountId)
    .first<{ text_bytes: number }>();
  return (row?.text_bytes ?? 0) + addBytes > budget;
}

export const utf8Bytes = (s: string | null | undefined) => (s ? new TextEncoder().encode(s).byteLength : 0);

/** Over budget: action links first, at most OVER_BUDGET_LINKS. Pure. */
export function trimLinks(links: ExtractedLink[]): ExtractedLink[] {
  return [...links.filter((l) => l.kind !== "other"), ...links.filter((l) => l.kind === "other")].slice(0, OVER_BUDGET_LINKS);
}

/**
 * A full inbox makes room: while it holds more than `limit` inbound messages, delete the oldest
 * messages of the sender key that holds the most of them (ties: the one whose mail is oldest),
 * never `keepId`. With many different senders that is simply the oldest mail; with one flooder it
 * is the flooder's. Returns how many were evicted.
 */
export async function evictOverflow(env: AppEnv, inboxId: string, keepId: string, limit: number): Promise<number> {
  let evicted = 0;
  for (let round = 0; round < 5; round++) {
    const row = await env.DB.prepare("SELECT inbound_count FROM inboxes WHERE id = ?").bind(inboxId).first<{ inbound_count: number }>();
    const excess = (row?.inbound_count ?? 0) - limit;
    if (excess <= 0) break;
    const { results } = await env.DB.prepare(
      `SELECT id, thread_id, raw_key, html_key FROM messages
       WHERE inbox_id = ?1 AND direction = 'in' AND id != ?2 AND sender_key IS (
         SELECT sender_key FROM messages WHERE inbox_id = ?1 AND direction = 'in' AND id != ?2
         GROUP BY sender_key ORDER BY COUNT(*) DESC, MIN(received_at) ASC LIMIT 1)
       ORDER BY received_at ASC, seq ASC LIMIT ?3`,
    )
      .bind(inboxId, keepId, Math.min(excess, 200))
      .all<Pick<MessageRow, "id" | "thread_id" | "raw_key" | "html_key">>();
    if (!results.length) break;
    evicted += await deleteMessageRows(env, results);
  }
  return evicted;
}

export type IngestResult =
  | {
      status: "stored";
      message_id: string;
      inbox_id: string;
      thread_id: string;
      via: "address" | "catch_all";
      /** true: the inbox forwards each email and this one may be forwarded (the caller sends it after acceptance). */
      forward?: true;
    }
  | { status: "duplicate"; message_id: string; inbox_id: string }
  | { status: "rejected"; reason: string };

export function flattenAddresses(list: Address[] | undefined): Addr[] {
  const out: Addr[] = [];
  for (const a of list ?? []) {
    if (a.group) for (const m of a.group) out.push({ address: m.address.toLowerCase(), name: m.name || null });
    else if (a.address) out.push({ address: a.address.toLowerCase(), name: a.name || null });
  }
  return out;
}

function firstMailbox(a: Address | undefined): Addr | null {
  if (!a) return null;
  if (a.group) return a.group[0] ? { address: a.group[0].address.toLowerCase(), name: a.group[0].name || null } : null;
  return a.address ? { address: a.address.toLowerCase(), name: a.name || null } : null;
}

export const blobKey = {
  raw: (inboxId: string, msgId: string) => `inbox/${inboxId}/${msgId}/raw.eml`,
  html: (inboxId: string, msgId: string) => `inbox/${inboxId}/${msgId}/body.html`,
  attachment: (inboxId: string, msgId: string, attId: string) => `inbox/${inboxId}/${msgId}/att/${attId}`,
};

/** Find the thread a message belongs to (see src/lib/threading.ts for the rules). */
export async function resolveThread(
  env: AppEnv,
  inboxId: string,
  m: { inReplyTo?: string | null; references?: string | null; subject?: string | null; counterparty?: string | null },
  now: number,
): Promise<string | null> {
  const ids = threadLookupIds(m.inReplyTo, m.references);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const hit = await env.DB.prepare(
      `SELECT thread_id FROM messages WHERE inbox_id = ? AND message_id_header IN (${ph}) ORDER BY received_at DESC LIMIT 1`,
    )
      .bind(inboxId, ...ids)
      .first<{ thread_id: string }>();
    if (hit) return hit.thread_id;
  }
  if (hasReplyPrefix(m.subject) && m.counterparty) {
    const key = normalizeSubject(m.subject);
    if (key) {
      const hit = await env.DB.prepare(
        `SELECT t.id FROM threads t WHERE t.inbox_id = ?1 AND t.subject_key = ?2 AND t.last_message_at > ?3
           AND EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = t.id AND (x.from_address = ?4
             OR EXISTS (SELECT 1 FROM json_each(x.to_json) j WHERE lower(json_extract(j.value, '$.address')) = ?4)))
         ORDER BY t.last_message_at DESC LIMIT 1`,
      )
        // json_each equality, not LIKE: D1 refuses LIKE patterns over 50 bytes (long addresses).
        .bind(inboxId, key, now - THREAD_WINDOW_MS, m.counterparty.toLowerCase())
        .first<{ id: string }>();
      if (hit) return hit.id;
    }
  }
  return null;
}

export function threadUpsert(
  env: AppEnv,
  inbox: InboxRow,
  threadId: string | null,
  subject: string | null,
  at: number,
): { threadId: string; stmt: D1PreparedStatement } {
  if (threadId) {
    return {
      threadId,
      stmt: env.DB.prepare(
        "UPDATE threads SET message_count = message_count + 1, last_message_at = MAX(last_message_at, ?) WHERE id = ?",
      ).bind(at, threadId),
    };
  }
  const id = newId("thr");
  return {
    threadId: id,
    stmt: env.DB.prepare(
      "INSERT INTO threads (id, account_id, inbox_id, subject, subject_key, message_count, last_message_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    ).bind(id, inbox.account_id, inbox.id, subject, normalizeSubject(subject), at, at),
  };
}

export const MESSAGE_COLUMNS = [
  "id",
  "account_id",
  "inbox_id",
  "thread_id",
  "direction",
  "message_id_header",
  "in_reply_to",
  "references_header",
  "envelope_from",
  "envelope_to",
  "from_address",
  "from_name",
  "to_json",
  "cc_json",
  "bcc_json",
  "reply_to",
  "subject",
  "preview",
  "text_body",
  "text_truncated",
  "html_key",
  "html_size",
  "raw_key",
  "size",
  "code",
  "verify_link",
  "codes_json",
  "links_json",
  "auth_json",
  "attachment_count",
  "read",
  "status",
  "error",
  "received_at",
  "sent_at",
  "sender_key",
  "automated",
  "attachments_omitted",
  "blob_bytes",
  "tag",
  "reply_text",
  "provider_message_id",
  "labels_json",
  "scheduled_at",
  "scheduled_json",
  "calendar_json",
] as const;

const ZERO_DEFAULT = new Set<string>(["text_truncated", "read", "attachment_count", "automated", "attachments_omitted", "blob_bytes"]);

/**
 * `ignoreDuplicate`: insert-or-ignore on the inbound Message-ID unique index
 * (messages_inbound_msgid), so concurrent deliveries of one message store it once.
 */
export function insertMessage(
  env: AppEnv,
  row: Omit<MessageRow, "seq">,
  opts: { ignoreDuplicate?: boolean; onlyIf?: { sql: string; binds: unknown[] } | null } = {},
): D1PreparedStatement {
  const cols = MESSAGE_COLUMNS.join(", ");
  const ph = MESSAGE_COLUMNS.map(() => "?").join(", ");
  // `onlyIf`: INSERT ... SELECT ... WHERE <condition>, so the row is only written when it holds.
  const values = opts.onlyIf ? `SELECT ${ph} WHERE ${opts.onlyIf.sql}` : `VALUES (${ph})`;
  return env.DB.prepare(`INSERT INTO messages (${cols}) ${values}${opts.ignoreDuplicate ? " ON CONFLICT DO NOTHING" : ""}`).bind(
    ...MESSAGE_COLUMNS.map((c) => row[c] ?? (ZERO_DEFAULT.has(c) ? 0 : null)),
    ...(opts.onlyIf?.binds ?? []),
  );
}

/** `sql` (ending in a WHERE clause) restricted to run only if message `id` exists (was not dropped as a duplicate earlier in the batch). */
const ifStored = (env: AppEnv, id: string, sql: string, ...binds: unknown[]) =>
  env.DB.prepare(`${sql} AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`).bind(...binds, id);

/**
 * The header section of a raw message: everything up to the first empty line (or all of it).
 * Parsing only this gives From, Message-ID and Authentication-Results without touching the body.
 */
export function headerBlock(raw: Uint8Array): Uint8Array {
  for (let i = raw.indexOf(10); i >= 0 && i < raw.length - 1; i = raw.indexOf(10, i + 1)) {
    const next = raw[i + 1];
    if (next === 10 || (next === 13 && raw[i + 2] === 10)) return raw.subarray(0, i + 1);
  }
  return raw;
}

/**
 * Store one inbound message. `raw` is the full MIME as received. Safe to call twice for the same
 * message (Email Routing retries): a repeated Message-ID in the same inbox is a no-op.
 *
 * Order matters for cost. The headers are parsed first, on their own: duplicates and the
 * per-sender cap (MAX_INBOUND_PER_SENDER_PER_DAY, half the daily quota per sender) are settled
 * before the body is parsed, so a sender's expensive mail only ever spends that sender's
 * allowance. Then the body is parsed and extracted (bounded, linear work), every D1 read runs
 * before anything is written to R2, and the message is committed in one transaction that also
 * re-checks and counts the account's daily quota and stored bytes. The R2 objects of a message
 * that does not get committed (an error, a duplicate, a full account) are deleted again, so blobs
 * never outlive their D1 row (the cron's orphan sweep catches a crash).
 *
 * R2 keeps the raw MIME and the HTML body. Attachments are not copied out: they are served from
 * the raw MIME (attachments.part_index).
 */
export async function ingestRaw(
  env: AppEnv,
  input: {
    envelopeFrom: string;
    envelopeTo: string;
    raw: ArrayBuffer | Uint8Array;
    inbox?: { inbox: InboxRow; via: "address" | "catch_all" };
    standing?: Standing;
    /**
     * Internal delivery (send to one of the account's own inboxes): the message never left the
     * Worker, so its sender is known for certain and counts as authenticated (authserv_id "internal").
     */
    internalFrom?: InboxRow;
  },
  now = Date.now(),
): Promise<IngestResult> {
  const rcpt = normalizeRecipient(input.envelopeTo);
  if (!rcpt) return { status: "rejected", reason: "Invalid recipient address" };
  const target = input.inbox ?? (await findInboxForRecipient(env, rcpt.address, now));
  if (!target) return { status: "rejected", reason: "Address does not exist" };
  const { inbox, via } = target;
  const raw = input.raw instanceof Uint8Array ? input.raw : new Uint8Array(input.raw);
  const size = raw.byteLength;
  if (size > MAX_MESSAGE_BYTES) return { status: "rejected", reason: "Message too large (25 MB limit)" };
  const standing = input.standing ?? (await standingOf(env, inbox.account_id));
  if (standing.suspended) return { status: "rejected", reason: suspendedReason(inbox.address) };

  // 1. Headers only.
  const head: Email = await PostalMime.parse(headerBlock(raw));
  const msgIdHeader = bracketMessageId(head.messageId);
  const findDup = async () =>
    msgIdHeader
      ? env.DB.prepare("SELECT id FROM messages WHERE inbox_id = ? AND message_id_header = ? AND direction = 'in' LIMIT 1")
          .bind(inbox.id, msgIdHeader)
          .first<{ id: string }>()
      : null;
  // Cheap early exit for redeliveries; the unique index below settles concurrent ones.
  const dup = await findDup();
  if (dup) return { status: "duplicate", message_id: dup.id, inbox_id: inbox.id };

  const from = firstMailbox(head.from) ?? { address: input.envelopeFrom.toLowerCase(), name: null };
  const envelopeFrom = input.envelopeFrom.toLowerCase();
  const auth = input.internalFrom ? internalAuth() : extractAuth(head.headers, from.address);
  // Allow / block lists: refused before the body is read or any per-sender allowance is spent.
  const listed = await receiveRefusal(env, inbox, { fromAddress: from.address, envelopeFrom, auth });
  if (listed) return { status: "rejected", reason: listed };
  const senderKey = senderKeyFor({ fromAddress: from.address, envelopeFrom, auth }, [sharedDomain(env)]);
  const sender = await admitSender(env, standing, inbox, senderKey, now);
  if (!sender.ok) return { status: "rejected", reason: sender.reason };

  let stored = false;
  try {
    // 2. The body.
    const parsed: Email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
    const subject = parsed.subject?.trim().slice(0, MAX_SUBJECT_CHARS) || null;
    const ex = extractAll({
      subject,
      text: parsed.text,
      html: parsed.html,
      headers: parsed.headers,
      fromAddress: from.address,
      otpHeader: parsed.otp?.code ?? null,
      auth,
    });
    const id = newId("msg");
    const rawKey = blobKey.raw(inbox.id, id);
    const html = parsed.html ? new TextEncoder().encode(parsed.html) : null;
    const htmlKey = html ? blobKey.html(inbox.id, id) : null;
    const blobBytes = size + (html?.byteLength ?? 0);

    const kept = parsed.attachments.slice(0, MAX_STORED_ATTACHMENTS);
    const attachments = kept.map((a, i) => ({
      id: newId("att"),
      filename: a.filename ? headerSafe(a.filename).slice(0, MAX_FILENAME_CHARS) || null : null,
      // Served back as a Content-Type header on download: only well-formed types.
      content_type: a.mimeType && isMimeType(a.mimeType) ? a.mimeType : "application/octet-stream",
      size: typeof a.content === "string" ? utf8Bytes(a.content) : (a.content as ArrayBuffer).byteLength,
      content_id: a.contentId ? a.contentId.slice(0, MAX_FILENAME_CHARS) : null,
      disposition: a.disposition ?? null,
      part_index: i,
    }));

    // D1 reads first: nothing is in R2 yet if one of them throws, or if the account is full.
    const refusal = await inboundRefusal(env, inbox, standing, blobBytes, now);
    if (refusal) return { status: "rejected", reason: refusal };
    const threadId = await resolveThread(
      env,
      inbox.id,
      { inReplyTo: parsed.inReplyTo, references: parsed.references, subject, counterparty: from.address },
      now,
    );
    let text = capText(ex.text);
    let links = ex.links;
    let reply = replyColumn(ex.reply_text, text.text);
    if (await overTextBudget(env, standing, inbox.account_id, utf8Bytes(text.text) + utf8Bytes(JSON.stringify(links)) + utf8Bytes(reply))) {
      // Over the account's text budget: keep an excerpt (codes and links were extracted from all of it).
      const short = capText(ex.text, OVER_BUDGET_TEXT_BYTES);
      text = { text: short.text, truncated: short.truncated || text.truncated };
      links = trimLinks(ex.links);
      reply = replyColumn(ex.reply_text, text.text, OVER_BUDGET_TEXT_BYTES);
    }
    const thread = threadUpsert(env, inbox, threadId, subject, now);
    const sentAt = parsed.date ? Date.parse(parsed.date) : NaN;
    const row: Omit<MessageRow, "seq"> = {
      id,
      account_id: inbox.account_id,
      inbox_id: inbox.id,
      thread_id: thread.threadId,
      direction: "in",
      message_id_header: msgIdHeader,
      in_reply_to: bracketMessageId(parsed.inReplyTo),
      references_header: capReferences(parsed.references),
      envelope_from: envelopeFrom,
      envelope_to: input.envelopeTo.toLowerCase(),
      from_address: from.address,
      from_name: from.name ? from.name.slice(0, MAX_NAME_CHARS) : null,
      to_json: JSON.stringify(flattenAddresses(parsed.to).slice(0, MAX_LISTED_ADDRESSES)),
      cc_json: JSON.stringify(flattenAddresses(parsed.cc).slice(0, MAX_LISTED_ADDRESSES)),
      bcc_json: "[]",
      reply_to: firstMailbox(parsed.replyTo?.[0])?.address ?? null,
      subject,
      preview: ex.preview,
      text_body: text.text,
      text_truncated: text.truncated ? 1 : 0,
      html_key: htmlKey,
      html_size: parsed.html ? parsed.html.length : null,
      raw_key: rawKey,
      size,
      code: ex.code,
      verify_link: ex.verify_link,
      codes_json: JSON.stringify(ex.codes),
      links_json: JSON.stringify(links),
      auth_json: JSON.stringify(ex.auth),
      attachment_count: attachments.length,
      read: 0,
      status: null,
      error: null,
      received_at: now,
      sent_at: Number.isNaN(sentAt) ? null : sentAt,
      sender_key: senderKey,
      automated: !input.internalFrom && isAutomated(parsed.headers, input.envelopeFrom) ? 1 : 0,
      attachments_omitted: parsed.attachments.length - attachments.length,
      blob_bytes: blobBytes,
      tag: cleanTag(rcpt.tag),
      reply_text: reply,
      calendar_json: calendarOf(parsed.attachments),
    };

    // Forwarding to the project's members (src/service/forward.ts): mail that may be forwarded gets
    // a forward_queue row in the same transaction, so a failed live forward is never lost.
    const fwdMode = inbox.forward_mode === "each" || inbox.forward_mode === "digest" ? inbox.forward_mode : null;
    let fwdKind: "forward" | "list" | null = null;
    if (fwdMode) {
      const e = forwardEligibility({
        headers: parsed.headers,
        envelopeFrom: input.envelopeFrom,
        fromAddress: from.address,
        authVerdict: ex.auth.verdict,
        tag: row.tag,
        internal: !!input.internalFrom,
      });
      // "list" (machine notices) only goes into digests; an inbox that forwards each email sends none.
      if ("kind" in e && (e.kind === "forward" || fwdMode === "digest")) fwdKind = e.kind;
    }

    const day = utcDay(now);
    const guard = admissionGuard(env, inbox, standing, blobBytes, day);
    const keys = [rawKey, ...(htmlKey ? [htmlKey] : [])];
    try {
      await Promise.all([
        env.BLOBS.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } }),
        htmlKey ? env.BLOBS.put(htmlKey, html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } }) : null,
      ]);
      // One transaction. The message goes first with insert-or-ignore on (inbox, Message-ID), and
      // only if the account's daily quota and stored bytes still have room; every other statement
      // only runs if it was stored, so a concurrent duplicate or a full account changes nothing.
      const batch = await env.DB.batch([
        insertMessage(env, row, { ignoreDuplicate: true, onlyIf: guard }),
        // The day's count goes up only with a stored message (not via ifStored: in an upsert its
        // condition would land on the DO UPDATE branch, not on the insert).
        ...(guard?.countDay
          ? [
              env.DB.prepare(
                `INSERT INTO inbound_counters (account_id, day, count) SELECT ?, ?, 1 WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)
                 ON CONFLICT(account_id, day) DO UPDATE SET count = inbound_counters.count + 1`,
              ).bind(inbox.account_id, day, id),
            ]
          : []),
        thread.threadId === threadId
          ? ifStored(
              env,
              id,
              "UPDATE threads SET message_count = message_count + 1, last_message_at = MAX(last_message_at, ?) WHERE id = ?",
              now,
              thread.threadId,
            )
          : env.DB.prepare(
              "INSERT INTO threads (id, account_id, inbox_id, subject, subject_key, message_count, last_message_at, created_at) SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)",
            ).bind(thread.threadId, inbox.account_id, inbox.id, subject, normalizeSubject(subject), now, now, id),
        ...attachments.map((a) =>
          env.DB.prepare(
            "INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, disposition, r2_key, part_index) SELECT ?, ?, ?, ?, ?, ?, ?, '', ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)",
          ).bind(a.id, id, a.filename, a.content_type, a.size, a.content_id, a.disposition, a.part_index, id),
        ),
        ifStored(env, id, "UPDATE inboxes SET last_message_at = ? WHERE id = ?", now, inbox.id),
        ...(fwdKind
          ? [
              env.DB.prepare(
                "INSERT INTO forward_queue (message_id, inbox_id, account_id, kind, received_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)",
              ).bind(id, inbox.id, inbox.account_id, fwdKind, now, id),
            ]
          : []),
      ]);
      stored = !!batch[0]?.meta.changes;
    } finally {
      // Not committed (an error, a full account, or lost the race to an identical delivery): drop this copy's blobs.
      if (!stored) await env.BLOBS.delete(keys).catch((e) => console.error("blob cleanup failed (the cron sweep retries)", e));
    }
    if (!stored) {
      const winner = await findDup();
      if (winner) return { status: "duplicate", message_id: winner.id, inbox_id: inbox.id };
      // Refused by the guard: the quota or the storage filled up since the check above.
      const reason = await inboundRefusal(env, inbox, standing, blobBytes, now);
      return { status: "rejected", reason: reason ?? "Mailbox temporarily unavailable; retry later" };
    }

    // A full inbox makes room by evicting the dominant sender's oldest mail (never this one).
    const perInbox = maxMessagesPerInbox(env, standing);
    if (Number.isFinite(perInbox)) {
      try {
        const evicted = await evictOverflow(env, inbox.id, id, perInbox);
        if (evicted) console.log(JSON.stringify({ event: "mail.evicted", inbox_id: inbox.id, evicted, limit: perInbox }));
      } catch (e) {
        console.error("eviction failed", e);
      }
    }

    // Wake parked wait_for_email callers. Mail is already committed; a failure here only means
    // waiters fall back to their timeout re-check.
    try {
      await env.INBOX.get(env.INBOX.idFromName(inbox.id)).notify(now);
    } catch (e) {
      console.error("InboxDO notify failed", e);
    }
    try {
      await emitEvent(env, inbox.account_id, inbox.id, "message.received", receivedEventData(inbox, row, ex.links, ex.auth), now);
    } catch (e) {
      console.error("webhook enqueue failed", e);
    }
    return {
      status: "stored",
      message_id: id,
      inbox_id: inbox.id,
      thread_id: thread.threadId,
      via,
      ...(fwdKind === "forward" && fwdMode === "each" ? { forward: true as const } : {}),
    };
  } finally {
    if (!stored) await refundSender(env, inbox.id, senderKey, sender.day).catch(() => {});
  }
}

/** The first calendar invite among a message's parts, parsed (src/extract/calendar.ts), as JSON; or null. */
export function calendarOf(attachments: Email["attachments"]): string | null {
  const part = attachments.find((a) => /^(text\/calendar|application\/ics)\b/i.test(a.mimeType ?? "") || /\.ics$/i.test(a.filename ?? ""));
  if (!part) return null;
  const bytes = typeof part.content === "string" ? null : new Uint8Array(part.content as ArrayBuffer);
  const text = bytes ? new TextDecoder().decode(bytes.subarray(0, MAX_ICS_CHARS * 2)) : String(part.content).slice(0, MAX_ICS_CHARS);
  const ev = parseIcs(text);
  return ev ? JSON.stringify(ev) : null;
}

/** Webhook and event-feed text excerpts are at most this many UTF-8 bytes. */
export const EVENT_TEXT_BYTES = 8 * 1024;

/** `data` of a message.received event (webhooks and the event feed). */
export function receivedEventData(inbox: InboxRow, row: Omit<MessageRow, "seq">, links: ExtractedLink[], auth: AuthResults) {
  const replyText = row.reply_text ?? row.text_body ?? "";
  return {
    untrusted: {
      notice: UNTRUSTED_NOTICE,
      fields: [
        "data.message.subject",
        "data.message.preview",
        "data.message.from.name",
        "data.message.to[].name",
        "data.message.reply_text",
        "data.message.text_excerpt",
        "data.links",
      ],
    },
    inbox: { id: inbox.id, address: inbox.address },
    message: {
      ...messageSummary({ ...row, seq: 0 }),
      reply_text: capText(replyText, EVENT_TEXT_BYTES).text,
      text_excerpt: capText(row.text_body ?? "", EVENT_TEXT_BYTES).text,
    },
    links: links.filter((l) => l.kind !== "other").slice(0, 10),
    auth,
    url: `/v1/messages/${row.id}`,
  };
}

/** What reply_text stores: NULL when the reply is the whole (stored) text, else the reply capped like text. */
export function replyColumn(reply: string, storedText: string, maxBytes = MAX_TEXT_BYTES): string | null {
  const r = capText(reply, maxBytes).text;
  return r === storedText ? null : r;
}

/** Authentication of an internal delivery: the platform itself vouches for the sender. */
export function internalAuth(): AuthResults {
  return { spf: null, dkim: null, dmarc: "pass", arc: null, dkim_domains: [], authserv_id: "internal", trusted: true, verdict: "pass" };
}

/** The SMTP reason a suspended account's mail gets: polite, and says nothing about why. */
export const suspendedReason = (address: string) => `Mailbox unavailable: ${address} is not accepting mail`;

/**
 * The Worker's email() handler. Returns the ingest result (null when refused before parsing), so
 * the caller can forward a stored message after the SMTP answer (src/index.ts).
 */
export async function handleEmail(message: ForwardableEmailMessage, env: AppEnv): Promise<IngestResult | null> {
  const rcpt = normalizeRecipient(message.to);
  // Resolve and admit before reading the body so unknown addresses and over-quota mail are rejected cheaply.
  const target = rcpt ? await findInboxForRecipient(env, rcpt.address) : null;
  if (!target) {
    message.setReject("Address does not exist");
    return null;
  }
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    message.setReject("Message too large (25 MB limit)");
    return null;
  }
  const standing = await standingOf(env, target.inbox.account_id);
  if (standing.suspended) {
    console.log(JSON.stringify({ event: "mail.rejected", reason: "account_suspended", inbox_id: target.inbox.id }));
    message.setReject(suspendedReason(target.inbox.address));
    return null;
  }
  // Read-only: the quota is only counted when the message is stored (see ingestRaw).
  const refusal = await inboundRefusal(env, target.inbox, standing, message.rawSize);
  if (refusal) {
    console.log(JSON.stringify({ event: "mail.rejected", reason: refusal, inbox_id: target.inbox.id }));
    message.setReject(refusal);
    return null;
  }
  const raw = await new Response(message.raw).arrayBuffer(); // the stream is single-use
  const res = await ingestRaw(env, { envelopeFrom: message.from, envelopeTo: message.to, raw, inbox: target, standing });
  if (res.status === "rejected") {
    console.log(JSON.stringify({ event: "mail.rejected", reason: res.reason, inbox_id: target.inbox.id }));
    message.setReject(res.reason);
  } else console.log(JSON.stringify({ event: "mail.received", ...res, to: rcpt!.address }));
  return res;
}
