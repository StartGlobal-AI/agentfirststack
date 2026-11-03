import { newId } from "@afs/shared";
import PostalMime, { type Address, type Email } from "postal-mime";
import { type AppEnv, positiveIntVar } from "../env";
import { extractAll } from "../extract";
import { normalizeRecipient } from "../lib/address";
import { isMimeType } from "../lib/headers";
import { bracketMessageId, hasReplyPrefix, normalizeSubject, threadLookupIds } from "../lib/threading";
import { type Addr, type InboxRow, type MessageRow, messageSummary, utcDay } from "./format";
import { findInboxForRecipient } from "./inboxes";
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
const THREAD_WINDOW_MS = 30 * 86_400_000;

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
// Inbound admission: MAX_MESSAGES_PER_INBOX and MAX_INBOUND_PER_ACCOUNT_PER_DAY (unset = off).

export const maxMessagesPerInbox = (env: AppEnv) => positiveIntVar(env.MAX_MESSAGES_PER_INBOX, 0);
export const maxInboundPerDay = (env: AppEnv) => positiveIntVar(env.MAX_INBOUND_PER_ACCOUNT_PER_DAY, 0);

export type Admission = { ok: true; day: string | null } | { ok: false; reason: string };

/**
 * Decide, before the body is read, whether an inbox may take one more message: one row read for
 * the inbox count (already on the inbox row) and one atomic upsert for the account's daily count.
 * Reserves the daily slot; call refundInbound() if the message is not stored after all.
 */
export async function admitInbound(env: AppEnv, inbox: InboxRow, now = Date.now()): Promise<Admission> {
  const perInbox = maxMessagesPerInbox(env);
  if (perInbox && (inbox.inbound_count ?? 0) >= perInbox) {
    return { ok: false, reason: `Mailbox full: ${inbox.address} already holds the maximum of ${perInbox} messages` };
  }
  const perDay = maxInboundPerDay(env);
  if (!perDay) return { ok: true, day: null };
  const day = utcDay(now);
  const row = await env.DB.prepare(
    `INSERT INTO inbound_counters (account_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(account_id, day) DO UPDATE SET count = inbound_counters.count + 1
     WHERE inbound_counters.count + 1 <= ? RETURNING count`,
  )
    .bind(inbox.account_id, day, perDay)
    .first<{ count: number }>();
  if (!row)
    return {
      ok: false,
      reason: `Daily limit reached: the account behind ${inbox.address} received its maximum of ${perDay} messages today (UTC); retry after 00:00 UTC`,
    };
  return { ok: true, day };
}

export async function refundInbound(env: AppEnv, accountId: string, day: string) {
  await env.DB.prepare("UPDATE inbound_counters SET count = MAX(0, count - 1) WHERE account_id = ? AND day = ?").bind(accountId, day).run();
}

export type IngestResult =
  | { status: "stored"; message_id: string; inbox_id: string; thread_id: string; via: "address" | "catch_all" }
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
        `SELECT t.id FROM threads t WHERE t.inbox_id = ? AND t.subject_key = ? AND t.last_message_at > ?
           AND EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = t.id AND (x.from_address = ? OR x.to_json LIKE ?))
         ORDER BY t.last_message_at DESC LIMIT 1`,
      )
        .bind(inboxId, key, now - THREAD_WINDOW_MS, m.counterparty, `%"${m.counterparty.replace(/["%_\\]/g, "")}"%`)
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
] as const;

/**
 * `ignoreDuplicate`: insert-or-ignore on the inbound Message-ID unique index
 * (messages_inbound_msgid), so concurrent deliveries of one message store it once.
 */
export function insertMessage(env: AppEnv, row: Omit<MessageRow, "seq">, opts: { ignoreDuplicate?: boolean } = {}): D1PreparedStatement {
  const cols = MESSAGE_COLUMNS.join(", ");
  const ph = MESSAGE_COLUMNS.map(() => "?").join(", ");
  return env.DB.prepare(`INSERT INTO messages (${cols}) VALUES (${ph})${opts.ignoreDuplicate ? " ON CONFLICT DO NOTHING" : ""}`).bind(
    ...MESSAGE_COLUMNS.map((c) => row[c] ?? null),
  );
}

/** `sql` (ending in a WHERE clause) restricted to run only if message `id` exists (was not dropped as a duplicate earlier in the batch). */
const ifStored = (env: AppEnv, id: string, sql: string, ...binds: unknown[]) =>
  env.DB.prepare(`${sql} AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`).bind(...binds, id);

/**
 * Store one inbound message. `raw` is the full MIME as received. Safe to call twice for the same
 * message (Email Routing retries): a repeated Message-ID in the same inbox is a no-op.
 */
export async function ingestRaw(
  env: AppEnv,
  input: {
    envelopeFrom: string;
    envelopeTo: string;
    raw: ArrayBuffer | Uint8Array;
    inbox?: { inbox: InboxRow; via: "address" | "catch_all" };
  },
  now = Date.now(),
): Promise<IngestResult> {
  const rcpt = normalizeRecipient(input.envelopeTo);
  if (!rcpt) return { status: "rejected", reason: "Invalid recipient address" };
  const target = input.inbox ?? (await findInboxForRecipient(env, rcpt.address, now));
  if (!target) return { status: "rejected", reason: "Address does not exist" };
  const { inbox, via } = target;
  const size = input.raw.byteLength;
  if (size > MAX_MESSAGE_BYTES) return { status: "rejected", reason: "Message too large (25 MB limit)" };

  const parsed: Email = await PostalMime.parse(input.raw, { attachmentEncoding: "arraybuffer" });
  const msgIdHeader = bracketMessageId(parsed.messageId);
  const findDup = async () =>
    msgIdHeader
      ? env.DB.prepare("SELECT id FROM messages WHERE inbox_id = ? AND message_id_header = ? AND direction = 'in' LIMIT 1")
          .bind(inbox.id, msgIdHeader)
          .first<{ id: string }>()
      : null;
  // Cheap early exit for redeliveries; the unique index below settles concurrent ones.
  const dup = await findDup();
  if (dup) return { status: "duplicate", message_id: dup.id, inbox_id: inbox.id };

  const from = firstMailbox(parsed.from) ?? { address: input.envelopeFrom.toLowerCase(), name: null };
  const subject = parsed.subject?.trim().slice(0, MAX_SUBJECT_CHARS) || null;
  const ex = extractAll({
    subject,
    text: parsed.text,
    html: parsed.html,
    headers: parsed.headers,
    fromAddress: from.address,
    otpHeader: parsed.otp?.code ?? null,
  });
  const id = newId("msg");
  const rawKey = blobKey.raw(inbox.id, id);
  const htmlKey = parsed.html ? blobKey.html(inbox.id, id) : null;

  const attachments = parsed.attachments.map((a) => {
    const content = typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content as ArrayBuffer);
    const attId = newId("att");
    return {
      id: attId,
      filename: a.filename,
      // Served back as a Content-Type header on download: only well-formed types.
      content_type: a.mimeType && isMimeType(a.mimeType) ? a.mimeType : "application/octet-stream",
      size: content.byteLength,
      content_id: a.contentId ?? null,
      disposition: a.disposition ?? null,
      r2_key: blobKey.attachment(inbox.id, id, attId),
      content,
    };
  });

  await Promise.all([
    env.BLOBS.put(rawKey, input.raw, { httpMetadata: { contentType: "message/rfc822" } }),
    htmlKey ? env.BLOBS.put(htmlKey, parsed.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } }) : null,
    ...attachments.map((a) => env.BLOBS.put(a.r2_key, a.content, { httpMetadata: { contentType: a.content_type } })),
  ]);

  const threadId = await resolveThread(
    env,
    inbox.id,
    { inReplyTo: parsed.inReplyTo, references: parsed.references, subject, counterparty: from.address },
    now,
  );
  const thread = threadUpsert(env, inbox, threadId, subject, now);
  const sentAt = parsed.date ? Date.parse(parsed.date) : NaN;
  const text = capText(ex.text);
  const row: Omit<MessageRow, "seq"> = {
    id,
    account_id: inbox.account_id,
    inbox_id: inbox.id,
    thread_id: thread.threadId,
    direction: "in",
    message_id_header: msgIdHeader,
    in_reply_to: bracketMessageId(parsed.inReplyTo),
    references_header: capReferences(parsed.references),
    envelope_from: input.envelopeFrom.toLowerCase(),
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
    links_json: JSON.stringify(ex.links),
    auth_json: JSON.stringify(ex.auth),
    attachment_count: attachments.length,
    read: 0,
    status: null,
    error: null,
    received_at: now,
    sent_at: Number.isNaN(sentAt) ? null : sentAt,
  };

  // One transaction. The message goes first with insert-or-ignore on (inbox, Message-ID); every
  // other statement only runs if it was stored, so a concurrent duplicate changes nothing.
  const batch = await env.DB.batch([
    insertMessage(env, row, { ignoreDuplicate: true }),
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
        "INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, disposition, r2_key) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)",
      ).bind(a.id, id, a.filename, a.content_type, a.size, a.content_id, a.disposition, a.r2_key, id),
    ),
    ifStored(env, id, "UPDATE inboxes SET last_message_at = ? WHERE id = ?", now, inbox.id),
  ]);
  if (!batch[0]?.meta.changes) {
    // Lost the race to an identical delivery: drop the blobs written for this copy.
    await env.BLOBS.delete([rawKey, ...(htmlKey ? [htmlKey] : []), ...attachments.map((a) => a.r2_key)]);
    const winner = await findDup();
    return { status: "duplicate", message_id: winner?.id ?? id, inbox_id: inbox.id };
  }

  // Wake parked wait_for_email callers. Mail is already committed; a failure here only means
  // waiters fall back to their timeout re-check.
  try {
    await env.INBOX.get(env.INBOX.idFromName(inbox.id)).notify(now);
  } catch (e) {
    console.error("InboxDO notify failed", e);
  }
  try {
    await emitEvent(
      env,
      inbox.account_id,
      inbox.id,
      "message.received",
      {
        inbox: { id: inbox.id, address: inbox.address },
        message: messageSummary({ ...row, seq: 0 }),
        links: ex.links.filter((l) => l.kind !== "other").slice(0, 10),
        auth: ex.auth,
        url: `/v1/messages/${id}`,
      },
      now,
    );
  } catch (e) {
    console.error("webhook enqueue failed", e);
  }
  return { status: "stored", message_id: id, inbox_id: inbox.id, thread_id: thread.threadId, via };
}

/** The Worker's email() handler. */
export async function handleEmail(message: ForwardableEmailMessage, env: AppEnv): Promise<void> {
  const rcpt = normalizeRecipient(message.to);
  // Resolve and admit before reading the body so unknown addresses and over-quota mail are rejected cheaply.
  const target = rcpt ? await findInboxForRecipient(env, rcpt.address) : null;
  if (!target) {
    message.setReject("Address does not exist");
    return;
  }
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    message.setReject("Message too large (25 MB limit)");
    return;
  }
  const admit = await admitInbound(env, target.inbox);
  if (!admit.ok) {
    console.log(JSON.stringify({ event: "mail.rejected", reason: admit.reason, inbox_id: target.inbox.id }));
    message.setReject(admit.reason);
    return;
  }
  const refund = () => (admit.day ? refundInbound(env, target.inbox.account_id, admit.day) : Promise.resolve());
  let res: IngestResult;
  try {
    const raw = await new Response(message.raw).arrayBuffer(); // the stream is single-use
    res = await ingestRaw(env, { envelopeFrom: message.from, envelopeTo: message.to, raw, inbox: target });
  } catch (e) {
    await refund();
    throw e;
  }
  if (res.status !== "stored") await refund();
  if (res.status === "rejected") message.setReject(res.reason);
  else console.log(JSON.stringify({ event: "mail.received", ...res, to: rcpt!.address }));
}
