import { ApiError, badRequest, forbidden, fromBase64, newId } from "@afs/shared";
import { type AppEnv, type Standing, cap, standingOf } from "../env";
import { htmlToText, makePreview } from "../extract/text";
import { normalizeOutgoingAddress } from "../lib/address";
import { hasControlChars, headerSafe, isMimeType } from "../lib/headers";
import { bracketMessageId, buildReferences, replySubject } from "../lib/threading";
import { type Addr, type InboxRow, type MessageRow, messageSummary, utcDay } from "./format";
import { assertActive, maxBlobBytes, storedBlobBytes } from "./budgets";
import { OVER_BUDGET_TEXT_BYTES, blobKey, capText, insertMessage, overTextBudget, threadUpsert, utf8Bytes } from "./ingest";
import { getInboxRow, ownershipNotVerified, sharedDomain } from "./inboxes";
import { getMessageRow } from "./messages";

export { utcDay };

/**
 * Sending through Cloudflare Email Service (the `send_email` binding, env.EMAIL.send()).
 *
 * Rules enforced here, before Email Service sees anything:
 *   - From is always the inbox's own address (display name from the inbox).
 *   - Its domain is the operator's MAIL_DOMAIN, or a custom domain this account owns (ownership
 *     challenge passed) whose sending DNS records have passed verify (Email Service also refuses
 *     unverified sender domains).
 *   - At most 50 recipients (to+cc+bcc), 32 attachments, 25 MiB total (Email Service limits).
 *   - Per-account daily cap SEND_DAILY_LIMIT (UNCLAIMED_SEND_DAILY_LIMIT for unclaimed accounts),
 *     counted per recipient, UTC day. Suspended accounts cannot send.
 *   - Custom headers: X-* only (Email Service allows a fixed list; threading headers are set by us).
 *   - Nothing that becomes a header (display name, attachment filename / content type / content id)
 *     carries CR/LF or other control characters.
 */

export const MAX_RECIPIENTS = 50;
export const MAX_ATTACHMENTS = 32;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export interface AttachmentInput {
  filename: string;
  /** base64 */
  content: string;
  content_type?: string;
  disposition?: "attachment" | "inline";
  content_id?: string;
}

export interface SendInput {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  reply_to?: string;
  attachments?: AttachmentInput[];
  headers?: Record<string, string>;
}

const asList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function recipients(field: string, v: string | string[] | undefined): string[] {
  return asList(v).map((a) => {
    const n = normalizeOutgoingAddress(a);
    if (!n) throw badRequest(`Invalid address in ${field}: "${a}".`, "Use plain addresses like name@example.com.");
    return n;
  });
}

export const DEFAULT_SEND_DAILY_LIMIT = 200;

export function dailyLimit(env: AppEnv, standing: Standing = { suspended: false, claimed: true }): number {
  return cap(env, standing, "SEND_DAILY_LIMIT", DEFAULT_SEND_DAILY_LIMIT);
}

/** Atomically reserve `n` sends for today; throws 429 when it would exceed the limit. */
export async function reserveSends(
  env: AppEnv,
  accountId: string,
  n: number,
  now = Date.now(),
  standing?: Standing,
): Promise<{ used: number; limit: number; day: string }> {
  const limit = dailyLimit(env, standing ?? (await standingOf(env, accountId)));
  const day = utcDay(now);
  const deny = () =>
    new ApiError(
      429,
      "daily_limit",
      `Daily send limit reached (${limit} recipients per UTC day).`,
      "Wait until 00:00 UTC (each recipient in to, cc and bcc counts once). Accounts a person has claimed (a claim link from the platform site, POST /v1/claim-link there) may have a higher limit.",
      { limit, day },
    );
  if (n > limit) throw deny();
  const row = await env.DB.prepare(
    `INSERT INTO send_counters (account_id, day, count) VALUES (?, ?, ?)
     ON CONFLICT(account_id, day) DO UPDATE SET count = send_counters.count + excluded.count
     WHERE send_counters.count + excluded.count <= ? RETURNING count`,
  )
    .bind(accountId, day, n, limit)
    .first<{ count: number }>();
  if (!row) throw deny();
  return { used: row.count, limit, day };
}

async function refundSends(env: AppEnv, accountId: string, day: string, n: number) {
  await env.DB.prepare("UPDATE send_counters SET count = MAX(0, count - ?) WHERE account_id = ? AND day = ?").bind(n, accountId, day).run();
}

/** May this inbox send? Shared domain: yes. Custom domain: only once owned and its sending DNS passed verify. */
export async function assertCanSendFrom(env: AppEnv, inbox: InboxRow) {
  if (inbox.domain === sharedDomain(env)) return;
  const d = await env.DB.prepare("SELECT sending_verified, owner_verified_at FROM domains WHERE domain = ? AND account_id = ?")
    .bind(inbox.domain, inbox.account_id)
    .first<{ sending_verified: number; owner_verified_at: number | null }>();
  if (!d)
    throw forbidden(`Domain ${inbox.domain} is not registered on this account.`, `POST /v1/domains {"domain":"${inbox.domain}"} first.`);
  if (!d.owner_verified_at) throw ownershipNotVerified(inbox.domain);
  if (!d.sending_verified) {
    throw new ApiError(
      403,
      "domain_not_verified",
      `${inbox.domain} is not verified for sending yet.`,
      `Add the "sending" DNS records from GET /v1/domains/${inbox.domain} (or use auto_configure), then POST /v1/domains/${inbox.domain}/verify until sending is "pass".`,
    );
  }
}

/**
 * SHARED_SEND_POLICY=reply_only: an inbox on the shared domain may only write to addresses that
 * have emailed it. That keeps the free shared domain useful for agents (replying to a service,
 * answering a human) without making it an open relay for cold email.
 *
 * Only mail whose From is authenticated counts: auth.verdict "pass", which needs Cloudflare's own
 * Authentication-Results header with DMARC pass for the From domain, or a DKIM / SPF pass aligned
 * with it (src/extract/auth.ts). Anyone can type any From, so a forged "From: target@victim" sent
 * to your own inbox does not unlock writing to target@victim. Mailing-list, bulk and auto-generated
 * mail (List-Id, Precedence: bulk, Auto-Submitted, ...; messages.automated) does not count either:
 * anyone can subscribe an inbox to an open list or get a helpdesk to auto-reply to it.
 */
export async function assertReplyOnly(env: AppEnv, inbox: InboxRow, recipients: string[]) {
  if (env.SHARED_SEND_POLICY !== "reply_only" || inbox.domain !== sharedDomain(env)) return;
  const unknown: string[] = [];
  for (const r of new Set(recipients.map((a) => a.toLowerCase()))) {
    const seen = await env.DB.prepare(
      "SELECT 1 FROM messages WHERE inbox_id = ? AND direction = 'in' AND lower(from_address) = ? AND automated = 0 AND json_extract(auth_json, '$.verdict') = 'pass' LIMIT 1",
    )
      .bind(inbox.id, r)
      .first();
    if (!seen) unknown.push(r);
  }
  if (unknown.length) {
    throw new ApiError(
      403,
      "reply_only",
      `Inboxes on ${inbox.domain} can only send to addresses that have emailed them personally with authenticated mail (auth.verdict "pass"). Not yet: ${unknown.join(", ")}.`,
      'Reply to a message you received whose auth.verdict is "pass" and that is not list, bulk or auto-generated mail (automated: false; a forged or unauthenticated From does not count either), or add your own domain (POST /v1/domains) and create the inbox there to send to anyone.',
      { recipients_not_allowed: unknown },
    );
  }
}

/** Map Email Service binding errors (error.code E_*) to API errors with recovery hints. */
export function mapSendError(e: unknown): ApiError {
  const code = (e as { code?: string })?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  const details = { provider_code: code || null, provider_message: msg };
  switch (code) {
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return new ApiError(
        403,
        "sender_not_verified",
        "Email Service refused the sender domain.",
        "The operator must onboard this domain to Cloudflare Email Sending (Compute > Email Service > Email Sending > Onboard Domain).",
        details,
      );
    case "E_RECIPIENT_NOT_ALLOWED":
      return new ApiError(
        403,
        "recipient_not_allowed",
        "Email Service refused this recipient.",
        "Until a sending domain is onboarded (Workers Paid plan), Email Service only delivers to verified destination addresses of the operator's account.",
        details,
      );
    case "E_RECIPIENT_SUPPRESSED":
      return new ApiError(
        422,
        "recipient_suppressed",
        "A recipient is on the suppression list (earlier hard bounce or spam complaint).",
        "Remove that address and retry.",
        details,
      );
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return new ApiError(429, "provider_rate_limited", "Email Service rate limit reached.", "Retry with exponential backoff.", details);
    case "E_DELIVERY_FAILED":
    case "E_INTERNAL_SERVER_ERROR":
      return new ApiError(
        502,
        "send_failed",
        "Email Service could not deliver the message.",
        "Retry in a minute; if it persists check the recipient address.",
        details,
      );
    case "":
      return new ApiError(502, "send_failed", `Sending failed: ${msg}`, "Retry; if it persists, check the request fields.", details);
    default:
      return new ApiError(
        400,
        "send_rejected",
        `Email Service rejected the message (${code}).`,
        "Fix the request (fields, headers, size) and retry.",
        details,
      );
  }
}

interface Prepared {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | undefined;
  html: string | undefined;
  replyTo: string | null;
  attachments: { filename: string; type: string; disposition: "attachment" | "inline"; contentId?: string; bytes: Uint8Array }[];
  headers: Record<string, string>;
}

function prepare(input: SendInput): Prepared {
  const to = recipients("to", input.to);
  const cc = recipients("cc", input.cc);
  const bcc = recipients("bcc", input.bcc);
  const total = to.length + cc.length + bcc.length;
  if (!total) throw badRequest("No recipients.", "Pass at least one address in to (or cc/bcc).");
  if (total > MAX_RECIPIENTS) throw badRequest(`Too many recipients (${total}; max ${MAX_RECIPIENTS}).`, "Split into several sends.");
  const subject = input.subject?.replace(/[\r\n]+/g, " ").trim();
  if (!subject) throw badRequest("subject is required.", "Pass a non-empty subject.");
  if (!input.text?.trim() && !input.html?.trim()) throw badRequest("Pass text or html.", "Plain text alone is fine; html is optional.");
  const replyTo = input.reply_to ? normalizeOutgoingAddress(input.reply_to) : null;
  if (input.reply_to && !replyTo) throw badRequest(`Invalid reply_to "${input.reply_to}".`);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!/^X-[A-Za-z0-9_-]{1,98}$/i.test(k))
      throw badRequest(
        `Header "${k}" is not allowed.`,
        "Only X-* custom headers can be set; threading headers are set automatically on replies.",
      );
    if (/[\r\n]/.test(v) || v.length > 2048)
      throw badRequest(`Header "${k}" has an invalid value.`, "No line breaks, at most 2048 characters.");
    headers[k] = v;
  }

  const atts = (input.attachments ?? []).map((a, i) => {
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(a.content);
    } catch {
      throw badRequest(`attachments[${i}].content is not valid base64.`);
    }
    const disposition = a.disposition ?? "attachment";
    // These become MIME headers (Content-Disposition, Content-Type, Content-ID).
    const filename = headerSafe(a.filename);
    if (!filename)
      throw badRequest(`attachments[${i}].filename is empty.`, "Pass a file name such as report.pdf (control characters are removed).");
    const type = a.content_type?.trim() || "application/octet-stream";
    if (!isMimeType(type))
      throw badRequest(
        `attachments[${i}].content_type "${a.content_type}" is not a valid MIME type.`,
        'Use type/subtype with optional parameters, e.g. "application/pdf" or "text/plain; charset=utf-8". No line breaks.',
      );
    if (a.content_id !== undefined && (hasControlChars(a.content_id) || /[\s<>]/.test(a.content_id) || !a.content_id)) {
      throw badRequest(
        `attachments[${i}].content_id is invalid.`,
        'Use a bare id without spaces, angle brackets or line breaks, e.g. "logo1", and reference it as <img src="cid:logo1">.',
      );
    }
    if (disposition === "inline" && !a.content_id)
      throw badRequest(`attachments[${i}] is inline but has no content_id.`, 'Reference it from html as <img src="cid:CONTENT_ID">.');
    return { filename, type, disposition, contentId: a.content_id, bytes };
  });
  if (atts.length > MAX_ATTACHMENTS) throw badRequest(`Too many attachments (max ${MAX_ATTACHMENTS}).`);
  const size = (input.text?.length ?? 0) + (input.html?.length ?? 0) + atts.reduce((n, a) => n + a.bytes.byteLength, 0);
  if (size > MAX_TOTAL_BYTES) throw badRequest("Message exceeds 25 MiB.", "Send large files as links instead of attachments.");

  // Always include a text part: some clients only show text, and it helps spam scoring.
  const text = input.text?.trim() ? input.text : input.html ? htmlToText(input.html) : undefined;
  return { to, cc, bcc, subject, text, html: input.html?.trim() ? input.html : undefined, replyTo, attachments: atts, headers };
}

const addrs = (list: string[]): Addr[] => list.map((address) => ({ address, name: null }));

async function sendAndStore(
  env: AppEnv,
  inbox: InboxRow,
  p: Prepared,
  thread: { threadId: string | null; inReplyTo: string | null; references: string | null },
  now = Date.now(),
) {
  const standing = await standingOf(env, inbox.account_id);
  assertActive(standing);
  await assertCanSendFrom(env, inbox);
  await assertReplyOnly(env, inbox, [...p.to, ...p.cc, ...p.bcc]);
  const n = p.to.length + p.cc.length + p.bcc.length;
  const quota = await reserveSends(env, inbox.account_id, n, now, standing);

  const headers = { ...p.headers };
  if (thread.inReplyTo) headers["In-Reply-To"] = thread.inReplyTo;
  if (thread.references) headers["References"] = thread.references;
  // Cleaned on input too; this also covers rows stored before that.
  const fromName = headerSafe(inbox.display_name);

  let providerId: string;
  try {
    const res = await env.EMAIL.send({
      from: fromName ? { email: inbox.address, name: fromName } : inbox.address,
      ...(p.to.length ? { to: p.to } : {}),
      ...(p.cc.length ? { cc: p.cc } : {}),
      ...(p.bcc.length ? { bcc: p.bcc } : {}),
      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
      subject: p.subject,
      ...(p.text !== undefined ? { text: p.text } : {}),
      ...(p.html !== undefined ? { html: p.html } : {}),
      ...(p.attachments.length
        ? {
            attachments: p.attachments.map((a) =>
              a.disposition === "inline"
                ? { disposition: "inline" as const, contentId: a.contentId!, filename: a.filename, type: a.type, content: a.bytes }
                : { disposition: "attachment" as const, filename: a.filename, type: a.type, content: a.bytes },
            ),
          }
        : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    } as EmailMessageBuilder);
    providerId = res.messageId;
  } catch (e) {
    await refundSends(env, inbox.account_id, quota.day, n);
    throw mapSendError(e);
  }

  const id = newId("msg");
  const html = p.html ? new TextEncoder().encode(p.html) : null;
  const blobBytes = (html?.byteLength ?? 0) + p.attachments.reduce((n, a) => n + a.bytes.byteLength, 0);
  // MAX_BLOB_BYTES_PER_ACCOUNT: the message has gone out either way; over the budget, the copy kept
  // here has its text but no HTML or attachments (so mail others send in cannot block sending).
  const keepBlobs = blobBytes === 0 || (await storedBlobBytes(env, inbox.account_id)) + blobBytes <= maxBlobBytes(env, standing);
  const htmlKey = html && keepBlobs ? blobKey.html(inbox.id, id) : null;
  const atts = keepBlobs ? p.attachments.map((a) => ({ ...a, id: newId("att") })) : [];
  await Promise.all([
    htmlKey ? env.BLOBS.put(htmlKey, html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } }) : null,
    ...atts.map((a) => env.BLOBS.put(blobKey.attachment(inbox.id, id, a.id), a.bytes, { httpMetadata: { contentType: a.type } })),
  ]);
  const t = threadUpsert(env, inbox, thread.threadId, p.subject, now);
  let stored = capText(p.text ?? ""); // the message went out in full; D1 keeps at most MAX_TEXT_BYTES
  if (await overTextBudget(env, standing, inbox.account_id, utf8Bytes(stored.text))) {
    const short = capText(p.text ?? "", OVER_BUDGET_TEXT_BYTES); // over the account's text budget: an excerpt
    stored = { text: short.text, truncated: short.truncated || stored.truncated };
  }
  const row: Omit<MessageRow, "seq"> = {
    id,
    account_id: inbox.account_id,
    inbox_id: inbox.id,
    thread_id: t.threadId,
    direction: "out",
    message_id_header: bracketMessageId(providerId),
    in_reply_to: thread.inReplyTo,
    references_header: thread.references,
    envelope_from: inbox.address,
    envelope_to: null,
    from_address: inbox.address,
    from_name: fromName || null,
    to_json: JSON.stringify(addrs(p.to)),
    cc_json: JSON.stringify(addrs(p.cc)),
    bcc_json: JSON.stringify(addrs(p.bcc)),
    reply_to: p.replyTo,
    subject: p.subject,
    preview: makePreview(p.text ?? ""),
    text_body: p.text !== undefined ? stored.text : null,
    text_truncated: stored.truncated ? 1 : 0,
    html_key: htmlKey,
    html_size: p.html?.length ?? null,
    raw_key: null,
    size: (p.text?.length ?? 0) + (p.html?.length ?? 0) + p.attachments.reduce((s, a) => s + a.bytes.byteLength, 0),
    code: null,
    verify_link: null,
    codes_json: "[]",
    links_json: "[]",
    auth_json: null,
    attachment_count: atts.length,
    read: 1,
    status: "sent",
    error: null,
    received_at: now,
    sent_at: now,
    sender_key: null,
    automated: 0,
    attachments_omitted: p.attachments.length - atts.length,
    blob_bytes: keepBlobs ? blobBytes : 0,
  };
  await env.DB.batch([
    t.stmt,
    insertMessage(env, row),
    ...atts.map((a) =>
      env.DB.prepare(
        "INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, disposition, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(a.id, id, a.filename, a.type, a.bytes.byteLength, a.contentId ?? null, a.disposition, blobKey.attachment(inbox.id, id, a.id)),
    ),
  ]);
  return {
    message: messageSummary({ ...row, seq: 0 }),
    provider_message_id: providerId,
    recipients: n,
    daily: { used: quota.used, limit: quota.limit, day: quota.day },
    ...(keepBlobs
      ? {}
      : {
          stored_copy: "text_only" as const,
          note: "Sent in full. This account's stored mail is at its limit, so the copy kept here has the text but not the HTML or attachments. Delete old mail (DELETE /v1/messages/:id, or whole inboxes) to free storage.",
        }),
    next_steps: [
      `Replies land in the same thread: GET /v1/threads/${t.threadId}, or wait for them with GET /v1/inboxes/${inbox.id}/wait?after=${now}.`,
    ],
  };
}

export async function sendFromInbox(env: AppEnv, accountId: string, inboxId: string, input: SendInput) {
  const inbox = await getInboxRow(env, accountId, inboxId);
  if (inbox.expires_at && inbox.expires_at <= Date.now())
    throw forbidden("This inbox has expired.", 'Create a new inbox or extend it with PATCH /v1/inboxes/:id {"ttl_days":...}.');
  return sendAndStore(env, inbox, prepare(input), { threadId: null, inReplyTo: null, references: null });
}

export interface ReplyInput {
  text?: string;
  html?: string;
  reply_all?: boolean;
  attachments?: AttachmentInput[];
  headers?: Record<string, string>;
}

/** Recipients of a reply (pure): the sender (or Reply-To); with reply_all also the other To/Cc. */
export function replyRecipients(
  original: Pick<MessageRow, "direction" | "from_address" | "reply_to" | "to_json" | "cc_json">,
  own: string,
  replyAll: boolean,
) {
  const parse = (s: string) => (JSON.parse(s) as Addr[]).map((a) => a.address.toLowerCase());
  const ownL = own.toLowerCase();
  let to: string[];
  let cc: string[] = [];
  if (original.direction === "out") {
    to = parse(original.to_json); // following up on our own message
    if (replyAll) cc = parse(original.cc_json);
  } else {
    to = [original.reply_to || original.from_address || ""].filter(Boolean);
    if (replyAll) {
      to.push(...parse(original.to_json));
      cc = parse(original.cc_json);
    }
  }
  const uniq = (l: string[], skip: Set<string>) => l.filter((a) => a && a !== ownL && !skip.has(a) && (skip.add(a), true));
  const seen = new Set<string>();
  const toU = uniq(to, seen);
  const ccU = uniq(cc, seen);
  return { to: toU, cc: ccU };
}

export async function replyToMessage(env: AppEnv, accountId: string, messageId: string, input: ReplyInput) {
  const original = await getMessageRow(env, accountId, messageId);
  const inbox = await getInboxRow(env, accountId, original.inbox_id);
  const { to, cc } = replyRecipients(original, inbox.address, !!input.reply_all);
  if (!to.length && !cc.length) throw badRequest("The original message has no address to reply to.");
  const p = prepare({
    to,
    cc,
    subject: replySubject(original.subject),
    text: input.text,
    html: input.html,
    attachments: input.attachments,
    headers: input.headers,
  });
  return sendAndStore(env, inbox, p, {
    threadId: original.thread_id,
    inReplyTo: original.message_id_header,
    references: buildReferences(original.references_header, original.message_id_header),
  });
}
