import { ApiError, badRequest, forbidden, fromBase64, identityDb, isSchemaError, newId, randomString } from "@afs/shared";
import PostalMime from "postal-mime";
import { type AppEnv, type Standing, cap, isDevMode, standingOf } from "../env";
import { extractReply } from "../extract/reply";
import { htmlToText, makePreview } from "../extract/text";
import { normalizeOutgoingAddress, normalizeRecipient } from "../lib/address";
import { hasControlChars, headerSafe, isMimeType } from "../lib/headers";
import { type MimeAttachment, buildMime, rfc5322Date } from "../lib/mime";
import { bracketMessageId, buildReferences, normalizeSubject, replySubject } from "../lib/threading";
import { assertActive, maxBlobBytes, secondsToUtcMidnight, storedBlobBytes } from "./budgets";
import { type Addr, type AttachmentRow, type InboxRow, type MessageRow, messageSummary, utcDay } from "./format";
import { deliveryRowsForSend } from "./delivery";
import { type SendTracker, parseIdempotencyKey, withIdempotency } from "./idempotency";
import {
  OVER_BUDGET_TEXT_BYTES,
  blobKey,
  capText,
  ingestRaw,
  insertMessage,
  overTextBudget,
  replyColumn,
  threadUpsert,
  utf8Bytes,
} from "./ingest";
import { getInboxRow, ownershipNotVerified, sharedDomain } from "./inboxes";
import { assertSendAllowed } from "./lists";
import { getMessageRow } from "./messages";
import { assertSendNotPaused } from "./pauses";
import { emitEvent } from "./webhooks";

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
 *   - While mail.send is paused (high bounce/complaint rate, src/service/pauses.ts), nothing goes to
 *     recipients outside the account (403 capability_paused).
 *   - Custom headers: X-* only (Email Service allows a fixed list; threading headers are set by us).
 *   - Nothing that becomes a header (display name, attachment filename / content type / content id)
 *     carries CR/LF or other control characters.
 *   - Recipients that are this account's own inboxes are delivered internally (ingestRaw, the
 *     message never leaves the Worker); Email Service gets only the others. Every recipient counts
 *     toward SEND_DAILY_LIMIT either way.
 *   - Idempotency-Key (src/service/idempotency.ts): a retried send with the same key and body is
 *     answered with the first response instead of sending again.
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
  /** Send later: ISO time or unix ms, at most 7 days ahead. */
  send_at?: string | number;
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
      "Wait until 00:00 UTC (each recipient in to, cc and bcc counts once). Accounts a person has claimed (a claim link from the platform site, POST /v1/claim-link there) may have a higher limit. GET /v1/usage shows what is left.",
      { limit, day, retry_after_s: secondsToUtcMidnight(now) },
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
 * Google-verified email addresses of the people who have claimed this account (memberships +
 * users in the identity database), lowercased. Empty when nobody has, or when the deployment has
 * no people tables (a single app self-hosted). DEV_MODE sign-ins ("dev:" subjects, no Google) only
 * count on a DEV_MODE deployment.
 */
export async function memberEmails(env: AppEnv, accountId: string): Promise<Set<string>> {
  try {
    const { results } = await identityDb(env)
      .prepare(
        "SELECT lower(u.email) AS email, u.google_sub AS sub FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.account_id = ?",
      )
      .bind(accountId)
      .all<{ email: string; sub: string }>();
    return new Set(results.filter((r) => r.email && (isDevMode(env) || !r.sub.startsWith("dev:"))).map((r) => r.email));
  } catch (e) {
    if (isSchemaError(e)) return new Set();
    throw e;
  }
}

/**
 * Which recipients are this account's own inboxes: an inbox at that address (the +tag ignored),
 * or the catch-all inbox of one of its own domains, as an inbound delivery would find them.
 * Keyed by the recipient as given (lowercased). Two queries whatever the number of recipients.
 */
export async function ownInboxRecipients(
  env: AppEnv,
  accountId: string,
  recipients: string[],
  now = Date.now(),
): Promise<Map<string, { inbox: InboxRow; via: "address" | "catch_all" }>> {
  const out = new Map<string, { inbox: InboxRow; via: "address" | "catch_all" }>();
  const base = new Map<string, string[]>();
  for (const r of new Set(recipients.map((a) => a.toLowerCase()))) {
    const n = normalizeRecipient(r);
    if (n) base.set(n.address, [...(base.get(n.address) ?? []), r]);
  }
  if (!base.size) return out;
  const shared = sharedDomain(env);
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM inboxes i WHERE i.account_id = ?1 AND i.address IN (SELECT value FROM json_each(?2))
       AND (i.expires_at IS NULL OR i.expires_at > ?3)
       AND (i.domain = ?4 OR EXISTS (SELECT 1 FROM domains d WHERE d.domain = i.domain AND d.account_id = i.account_id
            AND d.owner_verified_at IS NOT NULL AND d.receiving_enabled = 1))`,
  )
    .bind(accountId, JSON.stringify([...base.keys()]), now, shared)
    .all<InboxRow>();
  for (const inbox of results) for (const r of base.get(inbox.address) ?? []) out.set(r, { inbox, via: "address" });
  const rest = [...base.keys()].filter((a) => !results.some((i) => i.address === a));
  const domains = [...new Set(rest.map((a) => a.split("@")[1]!).filter((d) => d !== shared))];
  if (domains.length) {
    const { results: ca } = await env.DB.prepare(
      `SELECT d.domain AS catch_domain, i.* FROM domains d JOIN inboxes i ON i.id = d.catch_all_inbox_id
       WHERE d.account_id = ?1 AND d.owner_verified_at IS NOT NULL AND d.receiving_enabled = 1
         AND d.domain IN (SELECT value FROM json_each(?2)) AND i.account_id = d.account_id AND (i.expires_at IS NULL OR i.expires_at > ?3)`,
    )
      .bind(accountId, JSON.stringify(domains), now)
      .all<InboxRow & { catch_domain: string }>();
    for (const a of rest) {
      const hit = ca.find((c) => c.catch_domain === a.split("@")[1]);
      if (!hit) continue;
      const { catch_domain: _d, ...inbox } = hit;
      for (const r of base.get(a) ?? []) out.set(r, { inbox: inbox as InboxRow, via: "catch_all" });
    }
  }
  return out;
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
 *
 * Always allowed, without having written first: the account's own inboxes (delivered internally),
 * and the Google-verified email addresses of the people who claimed the account (its members), so
 * an agent can write to its person and test inbox to inbox without a custom domain.
 */
export async function assertReplyOnly(env: AppEnv, inbox: InboxRow, recipients: string[], standing?: Standing) {
  if (env.SHARED_SEND_POLICY !== "reply_only" || inbox.domain !== sharedDomain(env)) return;
  let unknown: string[] = [];
  for (const r of new Set(recipients.map((a) => a.toLowerCase()))) {
    const seen = await env.DB.prepare(
      "SELECT 1 FROM messages WHERE inbox_id = ? AND direction = 'in' AND lower(from_address) = ? AND automated = 0 AND json_extract(auth_json, '$.verdict') = 'pass' LIMIT 1",
    )
      .bind(inbox.id, r)
      .first();
    if (!seen) unknown.push(r);
  }
  if (unknown.length) {
    const [members, own] = await Promise.all([memberEmails(env, inbox.account_id), ownInboxRecipients(env, inbox.account_id, unknown)]);
    unknown = unknown.filter((r) => !members.has(r) && !own.has(r));
  }
  if (unknown.length) {
    const claimed = (standing ?? (await standingOf(env, inbox.account_id))).claimed;
    throw new ApiError(
      403,
      "reply_only",
      `Inboxes on ${inbox.domain} can only send to addresses that have emailed them personally with authenticated mail (auth.verdict "pass"). Not yet: ${unknown.join(", ")}.`,
      `Reply to a message you received whose auth.verdict is "pass" and that is not list, bulk or auto-generated mail (automated: false; a forged or unauthenticated From does not count either), or add your own domain (POST /v1/domains) and create the inbox there to send to anyone. Always allowed: this account's own inboxes and the verified emails of the people who claimed it${claimed ? "" : " (nobody has claimed this account yet: POST /v1/claim-link on the platform site gives your person a link to claim it, then you can write to them)"}.`,
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
      return new ApiError(429, "provider_rate_limited", "Email Service rate limit reached.", "Retry with exponential backoff.", {
        ...details,
        retry_after_s: 30,
      });
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

export interface PreparedAttachment {
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
  bytes: Uint8Array;
}

export interface Prepared {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | undefined;
  html: string | undefined;
  replyTo: string | null;
  attachments: PreparedAttachment[];
  headers: Record<string, string>;
}

/** Attachments as base64 (API input) or already as bytes (forward). */
type AttachmentSource = { base64: AttachmentInput[] } | { bytes: (Omit<PreparedAttachment, "bytes"> & { bytes: Uint8Array })[] };

function prepareAttachments(src: AttachmentSource): PreparedAttachment[] {
  const list =
    "base64" in src
      ? src.base64.map((a, i) => {
          let bytes: Uint8Array;
          try {
            bytes = fromBase64(a.content);
          } catch {
            throw badRequest(`attachments[${i}].content is not valid base64.`);
          }
          return { filename: a.filename, type: a.content_type, disposition: a.disposition, contentId: a.content_id, bytes };
        })
      : src.bytes;
  return list.map((a, i) => {
    const disposition = a.disposition ?? "attachment";
    // These become MIME headers (Content-Disposition, Content-Type, Content-ID).
    const filename = headerSafe(a.filename);
    if (!filename)
      throw badRequest(`attachments[${i}].filename is empty.`, "Pass a file name such as report.pdf (control characters are removed).");
    const type = a.type?.trim() || "application/octet-stream";
    if (!isMimeType(type))
      throw badRequest(
        `attachments[${i}].content_type "${a.type}" is not a valid MIME type.`,
        'Use type/subtype with optional parameters, e.g. "application/pdf" or "text/plain; charset=utf-8". No line breaks.',
      );
    if (a.contentId !== undefined && (hasControlChars(a.contentId) || /[\s<>]/.test(a.contentId) || !a.contentId)) {
      throw badRequest(
        `attachments[${i}].content_id is invalid.`,
        'Use a bare id without spaces, angle brackets or line breaks, e.g. "logo1", and reference it as <img src="cid:logo1">.',
      );
    }
    if (disposition === "inline" && !a.contentId)
      throw badRequest(`attachments[${i}] is inline but has no content_id.`, 'Reference it from html as <img src="cid:CONTENT_ID">.');
    return { filename, type, disposition, contentId: a.contentId, bytes: a.bytes };
  });
}

/** Validate and normalise a send (recipients, subject, body, headers, attachments, size). Also used by forward.ts. */
export function prepare(input: Omit<SendInput, "attachments"> & { attachments?: AttachmentSource }): Prepared {
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

  const atts = prepareAttachments(input.attachments ?? { base64: [] });
  if (atts.length > MAX_ATTACHMENTS) throw badRequest(`Too many attachments (max ${MAX_ATTACHMENTS}).`);
  const size = (input.text?.length ?? 0) + (input.html?.length ?? 0) + atts.reduce((n, a) => n + a.bytes.byteLength, 0);
  if (size > MAX_TOTAL_BYTES) throw badRequest("Message exceeds 25 MiB.", "Send large files as links instead of attachments.");

  // Always include a text part: some clients only show text, and it helps spam scoring.
  const text = input.text?.trim() ? input.text : input.html ? htmlToText(input.html) : undefined;
  return { to, cc, bcc, subject, text, html: input.html?.trim() ? input.html : undefined, replyTo, attachments: atts, headers };
}

const addrs = (list: string[]): Addr[] => list.map((address) => ({ address, name: null }));

export interface SendOptions {
  /** Idempotency-Key header (REST) or idempotency_key argument (MCP). */
  idempotencyKey?: string | null;
  /** The caller is an expiring OAuth access token (it may not schedule mail to outsiders). */
  temporaryCredential?: boolean;
}

/** One internal delivery of a send: the recipient, and whether its inbox stored the message. */
export interface InternalDelivery {
  recipient: string;
  inbox_id: string;
  status: "delivered" | "rejected";
  message_id?: string;
  reason?: string;
}

interface Routed {
  all: string[];
  own: Map<string, { inbox: InboxRow; via: "address" | "catch_all" }>;
  ext: { to: string[]; cc: string[]; bcc: string[] };
  outsiders: string[];
}

/** Every rule a send must pass before anything goes out, and where each recipient goes. */
async function checkAndRoute(
  env: AppEnv,
  inbox: InboxRow,
  p: Pick<Prepared, "to" | "cc" | "bcc">,
  standing: Standing,
  now: number,
): Promise<Routed> {
  assertActive(standing);
  await assertCanSendFrom(env, inbox);
  const all = [...p.to, ...p.cc, ...p.bcc];
  const own = await ownInboxRecipients(env, inbox.account_id, all, now);
  const isOwn = (a: string) => own.has(a.toLowerCase());
  const outsiders = all.filter((a) => !isOwn(a));
  // mail.send paused (src/service/pauses.ts): nothing goes out through Email Service; mail to the
  // account's own inboxes never leaves the Worker and still works.
  if (outsiders.length) await assertSendNotPaused(env, inbox.account_id);
  await assertReplyOnly(env, inbox, outsiders, standing);
  await assertSendAllowed(env, inbox, all);
  return {
    all,
    own,
    outsiders,
    ext: { to: p.to.filter((a) => !isOwn(a)), cc: p.cc.filter((a) => !isOwn(a)), bcc: p.bcc.filter((a) => !isOwn(a)) },
  };
}

const threadHeaders = (p: Prepared, thread: { inReplyTo: string | null; references: string | null }) => {
  const headers = { ...p.headers };
  if (thread.inReplyTo) headers["In-Reply-To"] = thread.inReplyTo;
  if (thread.references) headers["References"] = thread.references;
  return headers;
};

/** Email Service send to the recipients outside the account; null when there are none. Throws mapped errors. */
export async function sendExternal(env: AppEnv, inbox: InboxRow, p: Prepared, ext: Routed["ext"], headers: Record<string, string>) {
  if (!(ext.to.length + ext.cc.length + ext.bcc.length)) return null;
  const fromName = headerSafe(inbox.display_name);
  try {
    const res = await env.EMAIL.send({
      from: fromName ? { email: inbox.address, name: fromName } : inbox.address,
      ...(ext.to.length ? { to: ext.to } : {}),
      ...(ext.cc.length ? { cc: ext.cc } : {}),
      ...(ext.bcc.length ? { bcc: ext.bcc } : {}),
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
    return res.messageId;
  } catch (e) {
    throw mapSendError(e);
  }
}

/**
 * Copies for the account's own inboxes, written here and stored like inbound mail (the same
 * per-inbox and per-account limits apply), with the To/Cc the sender wrote.
 */
async function deliverInternal(
  env: AppEnv,
  inbox: InboxRow,
  p: Prepared,
  routed: Routed,
  messageIdHeader: string,
  thread: { inReplyTo: string | null; references: string | null },
  now: number,
): Promise<InternalDelivery[]> {
  const internal: InternalDelivery[] = [];
  if (!routed.own.size) return internal;
  const raw = buildMime({
    from: { address: inbox.address, name: headerSafe(inbox.display_name) || null },
    to: p.to,
    cc: p.cc,
    replyTo: p.replyTo,
    subject: p.subject,
    messageId: messageIdHeader,
    date: now,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    text: p.text,
    html: p.html,
    attachments: p.attachments as MimeAttachment[],
    headers: p.headers,
  });
  const done = new Set<string>();
  for (const r of routed.all) {
    const target = routed.own.get(r.toLowerCase());
    if (!target || done.has(r.toLowerCase())) continue;
    done.add(r.toLowerCase());
    try {
      const res = await ingestRaw(env, { envelopeFrom: inbox.address, envelopeTo: r, raw, inbox: target, internalFrom: inbox }, now);
      internal.push(
        res.status === "rejected"
          ? { recipient: r, inbox_id: target.inbox.id, status: "rejected", reason: res.reason }
          : { recipient: r, inbox_id: target.inbox.id, status: "delivered", message_id: res.message_id },
      );
    } catch (e) {
      console.error("internal delivery failed", e);
      internal.push({ recipient: r, inbox_id: target.inbox.id, status: "rejected", reason: "Internal delivery failed; send it again" });
    }
  }
  return internal;
}

const ownMessageId = (id: string, inbox: InboxRow) => `<${id}.${randomString(8)}@${inbox.domain}>`;
const bareId = (providerId: string | null) => (providerId ? providerId.replace(/^<|>$/g, "") : null);

async function emitSent(
  env: AppEnv,
  inbox: InboxRow,
  summary: ReturnType<typeof messageSummary>,
  n: number,
  internal: InternalDelivery[],
  now: number,
) {
  try {
    await emitEvent(
      env,
      inbox.account_id,
      inbox.id,
      "message.sent",
      {
        inbox: { id: inbox.id, address: inbox.address },
        message: summary,
        recipients: n,
        ...(internal.length ? { internal } : {}),
        url: `/v1/messages/${summary.id}`,
      },
      now,
    );
  } catch (e) {
    console.error("message.sent emit failed", e);
  }
}

async function sendAndStore(
  env: AppEnv,
  inbox: InboxRow,
  p: Prepared,
  thread: { threadId: string | null; inReplyTo: string | null; references: string | null },
  tracker: SendTracker,
  now = Date.now(),
) {
  const standing = await standingOf(env, inbox.account_id);
  const routed = await checkAndRoute(env, inbox, p, standing, now);
  const n = routed.all.length;
  const quota = await reserveSends(env, inbox.account_id, n, now, standing);
  const fromName = headerSafe(inbox.display_name);
  const id = newId("msg");

  let providerId: string | null;
  try {
    providerId = await sendExternal(env, inbox, p, routed.ext, threadHeaders(p, thread));
  } catch (e) {
    await refundSends(env, inbox.account_id, quota.day, n);
    throw e;
  }
  tracker.accepted({ provider_message_id: providerId, message_id: id });
  // Internal-only sends get a Message-ID of our own; replies to it thread like any other.
  const messageIdHeader = (providerId ? bracketMessageId(providerId) : null) ?? ownMessageId(id, inbox);

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
  const replyFull = extractReply(p.text ?? "");
  let reply = replyColumn(replyFull, stored.text);
  if (await overTextBudget(env, standing, inbox.account_id, utf8Bytes(stored.text) + utf8Bytes(reply))) {
    const short = capText(p.text ?? "", OVER_BUDGET_TEXT_BYTES); // over the account's text budget: an excerpt
    stored = { text: short.text, truncated: short.truncated || stored.truncated };
    reply = replyColumn(replyFull, stored.text, OVER_BUDGET_TEXT_BYTES);
  }
  const row = outboundRow({
    id,
    inbox,
    threadId: t.threadId,
    p,
    thread,
    fromName,
    messageIdHeader,
    text: p.text !== undefined ? stored : null,
    reply,
    htmlKey,
    attachments: atts.length,
    attachmentsOmitted: p.attachments.length - atts.length,
    blobBytes: keepBlobs ? blobBytes : 0,
    now,
  });
  row.status = "sent";
  row.provider_message_id = bareId(providerId); // bare (no <>), as Email Sending events carry it
  await env.DB.batch([
    t.stmt,
    insertMessage(env, row),
    ...atts.map((a) =>
      env.DB.prepare(
        "INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, disposition, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(a.id, id, a.filename, a.type, a.bytes.byteLength, a.contentId ?? null, a.disposition, blobKey.attachment(inbox.id, id, a.id)),
    ),
    ...deliveryRowsForSend(env, id, inbox.account_id, [...routed.ext.to, ...routed.ext.cc, ...routed.ext.bcc], [], now),
  ]);

  const internal = await deliverInternal(env, inbox, p, routed, messageIdHeader, thread, now);
  if (internal.length) await env.DB.batch(deliveryRowsForSend(env, id, inbox.account_id, [], internal, now));
  const summary = messageSummary({ ...row, seq: 0 });
  await emitSent(env, inbox, summary, n, internal, now);

  return {
    message: summary,
    provider_message_id: providerId,
    recipients: n,
    ...(internal.length ? { internal } : {}),
    daily: { used: quota.used, limit: quota.limit, day: quota.day },
    ...(keepBlobs
      ? {}
      : {
          stored_copy: "text_only" as const,
          note: "Sent in full. This account's stored mail is at its limit, so the copy kept here has the text but not the HTML or attachments. Delete old mail (DELETE /v1/messages/:id, or whole inboxes) to free storage.",
        }),
    next_steps: [
      `Replies land in the same thread: GET /v1/threads/${t.threadId}, or wait for them with GET /v1/inboxes/${inbox.id}/wait?after=${now}.`,
      `GET /v1/messages/${id}/delivery?timeout=60 waits until every recipient is delivered, bounced or failed.`,
      ...(internal.length
        ? [
            `${internal.length} recipient(s) are this account's own inboxes: delivered internally (see internal), not through Email Service.`,
          ]
        : []),
    ],
  };
}

/** The D1 row of a sent (or scheduled) message. */
function outboundRow(o: {
  id: string;
  inbox: InboxRow;
  threadId: string;
  p: Prepared;
  thread: { inReplyTo: string | null; references: string | null };
  fromName: string;
  messageIdHeader: string | null;
  text: { text: string; truncated: boolean } | null;
  reply: string | null;
  htmlKey: string | null;
  attachments: number;
  attachmentsOmitted: number;
  blobBytes: number;
  now: number;
}): Omit<MessageRow, "seq"> {
  const { p, inbox } = o;
  return {
    id: o.id,
    account_id: inbox.account_id,
    inbox_id: inbox.id,
    thread_id: o.threadId,
    direction: "out",
    message_id_header: o.messageIdHeader,
    in_reply_to: o.thread.inReplyTo,
    references_header: o.thread.references,
    envelope_from: inbox.address,
    envelope_to: null,
    from_address: inbox.address,
    from_name: o.fromName || null,
    to_json: JSON.stringify(addrs(p.to)),
    cc_json: JSON.stringify(addrs(p.cc)),
    bcc_json: JSON.stringify(addrs(p.bcc)),
    reply_to: p.replyTo,
    subject: p.subject,
    preview: makePreview(p.text ?? ""),
    text_body: o.text ? o.text.text : null,
    text_truncated: o.text?.truncated ? 1 : 0,
    html_key: o.htmlKey,
    html_size: p.html?.length ?? null,
    raw_key: null,
    size: (p.text?.length ?? 0) + (p.html?.length ?? 0) + p.attachments.reduce((s, a) => s + a.bytes.byteLength, 0),
    code: null,
    verify_link: null,
    codes_json: "[]",
    links_json: "[]",
    auth_json: null,
    attachment_count: o.attachments,
    read: 1,
    status: "sent",
    error: null,
    received_at: o.now,
    sent_at: o.now,
    sender_key: null,
    automated: 0,
    attachments_omitted: o.attachmentsOmitted,
    blob_bytes: o.blobBytes,
    tag: null,
    reply_text: o.reply,
    provider_message_id: null,
    labels_json: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Scheduled send

/** How far ahead send_at may be. */
export const MAX_SCHEDULE_AHEAD_MS = 7 * 86_400_000;
export const DEFAULT_MAX_SCHEDULED = 20;
export const DEFAULT_UNCLAIMED_MAX_SCHEDULED = 5;
/** send_at closer than this is sent at once. */
const SCHEDULE_MIN_AHEAD_MS = 5_000;

export const maxScheduled = (env: AppEnv, standing: Standing) =>
  cap(env, standing, "MAX_SCHEDULED_PER_ACCOUNT", standing.claimed ? DEFAULT_MAX_SCHEDULED : DEFAULT_UNCLAIMED_MAX_SCHEDULED);

/** send_at -> unix ms, or null for "now". 400 when not a time or more than 7 days ahead. Pure. */
export function parseSendAt(v: string | number | undefined | null, now = Date.now()): number | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  const at = /^\d+$/.test(s) && n < 1e11 ? n * 1000 : n;
  if (!Number.isFinite(at))
    throw badRequest("Invalid send_at.", "Pass an ISO 8601 time (2026-11-05T09:00:00Z) or unix ms / seconds, at most 7 days ahead.");
  if (at > now + MAX_SCHEDULE_AHEAD_MS)
    throw badRequest(
      "send_at is more than 7 days ahead.",
      `Schedule at most 7 days ahead (before ${new Date(now + MAX_SCHEDULE_AHEAD_MS).toISOString()}).`,
    );
  return at <= now + SCHEDULE_MIN_AHEAD_MS ? null : at;
}

/**
 * Store a message to send later (status "scheduled"). Everything that can be checked now is: the
 * sending domain, reply_only, the send block list, the cap on scheduled sends, storage for its
 * HTML and attachments. Checked again, and the daily limit counted, when it goes out. An OAuth
 * access token may only schedule mail to the account's own inboxes and people: a send to anyone
 * else would happen after the token has expired.
 */
async function scheduleAndStore(
  env: AppEnv,
  inbox: InboxRow,
  p: Prepared,
  thread: { threadId: string | null; inReplyTo: string | null; references: string | null },
  sendAt: number,
  opts: SendOptions,
  now = Date.now(),
) {
  const standing = await standingOf(env, inbox.account_id);
  const routed = await checkAndRoute(env, inbox, p, standing, now);
  if (opts.temporaryCredential) {
    const members = await memberEmails(env, inbox.account_id);
    if (routed.outsiders.some((a) => !members.has(a.toLowerCase())))
      throw new ApiError(
        403,
        "temporary_credential",
        "A connected app's access token can't schedule mail to people outside this account.",
        "Send it now instead (no send_at), or use the project's own API key. Scheduling to the account's own inboxes and members works.",
      );
  }
  if (routed.all.length > dailyLimit(env, standing))
    throw badRequest(`More recipients (${routed.all.length}) than the daily send limit allows.`, "Split the message into several sends.");
  if (p.text && utf8Bytes(p.text) > MAX_TEXT_BYTES_STORED)
    throw badRequest(
      "A scheduled message's text may be at most 64 KB.",
      "Send it now (no send_at), or move the long part into an attachment.",
    );
  const html = p.html ? new TextEncoder().encode(p.html) : null;
  const blobBytes = (html?.byteLength ?? 0) + p.attachments.reduce((n, a) => n + a.bytes.byteLength, 0);
  const storageFull = () =>
    new ApiError(
      403,
      "storage_full",
      "This account's stored mail is at its limit; a scheduled message must be stored in full until it goes out.",
      "Delete old mail (DELETE /v1/messages/:id, clear_inbox, or whole inboxes) or send it now instead.",
    );
  if (blobBytes && (await storedBlobBytes(env, inbox.account_id)) + blobBytes > maxBlobBytes(env, standing)) throw storageFull();
  const reply = replyColumn(extractReply(p.text ?? ""), p.text ?? "");
  if (await overTextBudget(env, standing, inbox.account_id, utf8Bytes(p.text) + utf8Bytes(reply))) throw storageFull();

  const max = maxScheduled(env, standing);
  const id = newId("msg");
  const htmlKey = html ? blobKey.html(inbox.id, id) : null;
  const atts = p.attachments.map((a) => ({ ...a, id: newId("att") }));
  await Promise.all([
    htmlKey ? env.BLOBS.put(htmlKey, html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } }) : null,
    ...atts.map((a) => env.BLOBS.put(blobKey.attachment(inbox.id, id, a.id), a.bytes, { httpMetadata: { contentType: a.type } })),
  ]);
  const t = threadUpsert(env, inbox, thread.threadId, p.subject, now);
  const row = outboundRow({
    id,
    inbox,
    threadId: t.threadId,
    p,
    thread,
    fromName: headerSafe(inbox.display_name),
    messageIdHeader: null,
    text: p.text !== undefined ? { text: p.text, truncated: false } : null,
    reply,
    htmlKey,
    attachments: atts.length,
    attachmentsOmitted: 0,
    blobBytes,
    now,
  });
  row.status = "scheduled";
  row.sent_at = null;
  row.scheduled_at = sendAt;
  row.scheduled_json = JSON.stringify({ headers: p.headers });
  // One transaction, and only under the cap: concurrent schedules cannot pass MAX_SCHEDULED_PER_ACCOUNT.
  const guard = {
    sql: "(SELECT COUNT(*) FROM messages WHERE account_id = ? AND status = 'scheduled') < ?",
    binds: [inbox.account_id, Number.isFinite(max) ? max : 1e9],
  };
  const stored = (sql: string, ...binds: unknown[]) =>
    env.DB.prepare(`${sql} AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`).bind(...binds, id);
  let ok = false;
  try {
    const res = await env.DB.batch([
      insertMessage(env, row, { onlyIf: guard }),
      thread.threadId
        ? stored("UPDATE threads SET message_count = message_count + 1 WHERE id = ?", thread.threadId)
        : env.DB.prepare(
            "INSERT INTO threads (id, account_id, inbox_id, subject, subject_key, message_count, last_message_at, created_at) SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)",
          ).bind(t.threadId, inbox.account_id, inbox.id, p.subject, normalizeSubject(p.subject), now, now, id),
      ...atts.map((a) =>
        env.DB.prepare(
          "INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, disposition, r2_key) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)",
        ).bind(
          a.id,
          id,
          a.filename,
          a.type,
          a.bytes.byteLength,
          a.contentId ?? null,
          a.disposition,
          blobKey.attachment(inbox.id, id, a.id),
          id,
        ),
      ),
    ]);
    ok = !!res[0]?.meta.changes;
  } finally {
    if (!ok) {
      const keys = [...(htmlKey ? [htmlKey] : []), ...atts.map((a) => blobKey.attachment(inbox.id, id, a.id))];
      if (keys.length) await env.BLOBS.delete(keys).catch(() => {});
    }
  }
  if (!ok)
    throw new ApiError(
      403,
      "quota_exceeded",
      `This account already has ${max} scheduled messages, the most allowed here.`,
      "Wait for one to go out, or cancel one (DELETE /v1/messages/:id; list them with ?status=scheduled).",
      { limit: max },
    );
  await env.INBOX.get(env.INBOX.idFromName(inbox.id)).schedule(inbox.id, sendAt);
  return {
    message: messageSummary({ ...row, seq: 0 }),
    scheduled_at: sendAt,
    scheduled_at_iso: new Date(sendAt).toISOString(),
    recipients: routed.all.length,
    next_steps: [
      `It goes out at ${new Date(sendAt).toISOString()}; rules and the daily limit are checked again then (a failure marks it "failed" and emits message.failed).`,
      `DELETE /v1/messages/${id} cancels it. GET /v1/inboxes/${inbox.id}/messages?status=scheduled lists what is waiting.`,
    ],
  };
}

/** What send, reply and forward answer: the sent message, or the scheduled one. */
type SendResult = Awaited<ReturnType<typeof sendAndStore>> | Awaited<ReturnType<typeof scheduleAndStore>>;

/** Stored text of a scheduled message is kept whole: it must fit the D1 text cap. */
const MAX_TEXT_BYTES_STORED = 64 * 1024;

/**
 * Send one scheduled message now (the inbox's alarm, or the cron). Claimed atomically
 * (scheduled -> sending), so a second run never sends it twice. Any failure (rules changed, daily
 * limit reached, Email Service refused) marks it "failed" with the error and emits message.failed.
 */
export async function sendScheduled(env: AppEnv, messageId: string, now = Date.now()): Promise<"sent" | "failed" | "skipped"> {
  const row = await env.DB.prepare("UPDATE messages SET status = 'sending' WHERE id = ? AND status = 'scheduled' RETURNING *")
    .bind(messageId)
    .first<MessageRow>();
  if (!row) return "skipped";
  const inbox = await env.DB.prepare("SELECT * FROM inboxes WHERE id = ?").bind(row.inbox_id).first<InboxRow>();
  if (!inbox) return "skipped";
  const thread = { inReplyTo: row.in_reply_to, references: row.references_header };
  let n = 0;
  let quota: { day: string } | null = null;
  try {
    const p = await preparedFromRow(env, row);
    const standing = await standingOf(env, inbox.account_id);
    const routed = await checkAndRoute(env, inbox, p, standing, now);
    n = routed.all.length;
    quota = await reserveSends(env, inbox.account_id, n, now, standing);
    const providerId = await sendExternal(env, inbox, p, routed.ext, threadHeaders(p, thread));
    const messageIdHeader = (providerId ? bracketMessageId(providerId) : null) ?? ownMessageId(row.id, inbox);
    quota = null; // sent: the quota stays used
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messages SET status = 'sent', message_id_header = ?, provider_message_id = ?, received_at = ?, sent_at = ?, error = NULL WHERE id = ?",
      ).bind(messageIdHeader, bareId(providerId), now, now, row.id),
      env.DB.prepare("UPDATE threads SET last_message_at = MAX(last_message_at, ?) WHERE id = ?").bind(now, row.thread_id),
      ...deliveryRowsForSend(env, row.id, inbox.account_id, [...routed.ext.to, ...routed.ext.cc, ...routed.ext.bcc], [], now),
    ]);
    const internal = await deliverInternal(env, inbox, p, routed, messageIdHeader, thread, now);
    if (internal.length) await env.DB.batch(deliveryRowsForSend(env, row.id, inbox.account_id, [], internal, now));
    await emitSent(
      env,
      inbox,
      messageSummary({ ...row, status: "sent", received_at: now, sent_at: now, message_id_header: messageIdHeader }),
      n,
      internal,
      now,
    );
    return "sent";
  } catch (e) {
    if (quota) await refundSends(env, inbox.account_id, quota.day, n).catch(() => {});
    const err = e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
    await env.DB.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").bind(err.slice(0, 500), row.id).run();
    try {
      await emitEvent(
        env,
        inbox.account_id,
        inbox.id,
        "message.failed",
        {
          message_id: row.id,
          inbox_id: inbox.id,
          recipient: null,
          status: "failed",
          detail: err.slice(0, 500),
          scheduled: true,
          url: `/v1/messages/${row.id}`,
        },
        now,
      );
    } catch (e2) {
      console.error("message.failed emit failed", e2);
    }
    return "failed";
  }
}

/** A stored (scheduled) row back into what sendExternal / deliverInternal take. */
async function preparedFromRow(env: AppEnv, row: MessageRow): Promise<Prepared> {
  const list = (j: string) => (JSON.parse(j) as Addr[]).map((a) => a.address);
  const html = row.html_key ? await env.BLOBS.get(row.html_key).then((o) => (o ? o.text() : undefined)) : undefined;
  const { results } = await env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid")
    .bind(row.id)
    .all<AttachmentRow>();
  const attachments: PreparedAttachment[] = [];
  for (const a of results) {
    const o = await env.BLOBS.get(a.r2_key);
    if (!o) throw new ApiError(500, "attachment_missing", `Attachment ${a.filename ?? a.id} of the scheduled message is gone.`);
    attachments.push({
      filename: a.filename ?? "attachment",
      type: a.content_type ?? "application/octet-stream",
      disposition: a.disposition === "inline" ? "inline" : "attachment",
      contentId: a.content_id ?? undefined,
      bytes: new Uint8Array(await o.arrayBuffer()),
    });
  }
  const extra = row.scheduled_json ? (JSON.parse(row.scheduled_json) as { headers?: Record<string, string> }) : {};
  return {
    to: list(row.to_json),
    cc: list(row.cc_json),
    bcc: list(row.bcc_json),
    subject: row.subject ?? "",
    text: row.text_body ?? undefined,
    html,
    replyTo: row.reply_to,
    attachments,
    headers: extra.headers ?? {},
  };
}

/** Due scheduled messages of one inbox (or all, for the cron), and the next time one is due. */
export async function runScheduled(env: AppEnv, inboxId: string | null, now = Date.now(), budgetMs = 20_000) {
  const stop = Date.now() + budgetMs;
  let sent = 0;
  let failed = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM messages WHERE status = 'scheduled' AND scheduled_at <= ?${inboxId ? " AND inbox_id = ?" : ""} ORDER BY scheduled_at LIMIT 50`,
    )
      .bind(now, ...(inboxId ? [inboxId] : []))
      .all<{ id: string }>();
    for (const r of results) {
      const res = await sendScheduled(env, r.id, now);
      if (res === "sent") sent++;
      if (res === "failed") failed++;
      if (Date.now() >= stop) break;
    }
    if (results.length < 50 || Date.now() >= stop) break;
  }
  const next = await env.DB.prepare(
    `SELECT MIN(scheduled_at) AS at FROM messages WHERE status = 'scheduled'${inboxId ? " AND inbox_id = ?" : ""}`,
  )
    .bind(...(inboxId ? [inboxId] : []))
    .first<{ at: number | null }>();
  return { scheduled_sent: sent, scheduled_failed: failed, next_at: next?.at ?? null };
}

const assertNotExpired = (inbox: InboxRow) => {
  if (inbox.expires_at && inbox.expires_at <= Date.now())
    throw forbidden("This inbox has expired.", 'Create a new inbox or extend it with PATCH /v1/inboxes/:id {"ttl_days":...}.');
};

export async function sendFromInbox(env: AppEnv, accountId: string, inboxId: string, input: SendInput, opts: SendOptions = {}) {
  const key = parseIdempotencyKey(opts.idempotencyKey);
  const inbox = await getInboxRow(env, accountId, inboxId);
  assertNotExpired(inbox);
  const p = prepare({ ...input, attachments: { base64: input.attachments ?? [] } });
  const at = parseSendAt(input.send_at);
  const thread = { threadId: null, inReplyTo: null, references: null };
  return withIdempotency<SendResult>(env, accountId, key, `send:${inboxId}`, input, (t) =>
    at ? scheduleAndStore(env, inbox, p, thread, at, opts) : sendAndStore(env, inbox, p, thread, t),
  );
}

export interface ReplyInput {
  text?: string;
  html?: string;
  reply_all?: boolean;
  attachments?: AttachmentInput[];
  headers?: Record<string, string>;
  send_at?: string | number;
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

export async function replyToMessage(env: AppEnv, accountId: string, messageId: string, input: ReplyInput, opts: SendOptions = {}) {
  const key = parseIdempotencyKey(opts.idempotencyKey);
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
    attachments: { base64: input.attachments ?? [] },
    headers: input.headers,
  });
  const at = parseSendAt(input.send_at);
  const thread = {
    threadId: original.thread_id,
    inReplyTo: original.message_id_header,
    references: buildReferences(original.references_header, original.message_id_header),
  };
  return withIdempotency<SendResult>(env, accountId, key, `reply:${messageId}`, input, (t) =>
    at ? scheduleAndStore(env, inbox, p, thread, at, opts) : sendAndStore(env, inbox, p, thread, t),
  );
}

// ---------------------------------------------------------------------------------------------
// Forward

export interface ForwardInput {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  text?: string;
  html?: string;
  /** Default true: the original's attachments go along (at most MAX_ATTACHMENTS, 25 MiB in all). */
  include_attachments?: boolean;
  headers?: Record<string, string>;
  send_at?: string | number;
}

/** "Fwd: <subject>", without stacking prefixes. Pure. */
export function forwardSubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  if (!s) return "Fwd:";
  return /^\s*fwd?\s*:/i.test(s) ? s : `Fwd: ${s}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The quoted header block of a forward: From, Date, Subject, To (and Cc). Pure. */
export function forwardHeader(
  o: Pick<MessageRow, "from_address" | "from_name" | "subject" | "to_json" | "cc_json" | "sent_at" | "received_at">,
) {
  const list = (j: string) => (JSON.parse(j) as Addr[]).map((a) => mailboxText(a.address, a.name)).join(", ");
  const lines = [
    "---------- Forwarded message ---------",
    `From: ${mailboxText(o.from_address ?? "", o.from_name)}`,
    `Date: ${rfc5322Date(o.sent_at ?? o.received_at)}`,
    `Subject: ${headerSafe(o.subject) || "(no subject)"}`,
    `To: ${list(o.to_json)}`,
    ...((JSON.parse(o.cc_json) as Addr[]).length ? [`Cc: ${list(o.cc_json)}`] : []),
  ];
  return lines;
}

const mailboxText = (address: string, name: string | null | undefined) => {
  const n = headerSafe(name);
  return n ? `${n} <${address}>` : address;
};

/** The original's full text, HTML and attachments: from the raw MIME when we have it, else the stored copy. */
export async function originalContent(env: AppEnv, row: MessageRow, withAttachments: boolean) {
  if (row.raw_key) {
    const raw = await env.BLOBS.get(row.raw_key);
    if (raw) {
      const parsed = await PostalMime.parse(await raw.arrayBuffer(), { attachmentEncoding: "arraybuffer" });
      const text = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : (row.text_body ?? "");
      const attachments = withAttachments
        ? parsed.attachments.map((a) => ({
            filename: a.filename || "attachment",
            type: a.mimeType && isMimeType(a.mimeType) ? a.mimeType : "application/octet-stream",
            disposition: (a.disposition === "inline" ? "inline" : "attachment") as "inline" | "attachment",
            contentId: a.contentId ? a.contentId.replace(/^<|>$/g, "") : undefined,
            bytes: typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content as ArrayBuffer),
          }))
        : [];
      return { text, html: parsed.html ?? null, attachments };
    }
  }
  const html = row.html_key ? await env.BLOBS.get(row.html_key).then((o) => (o ? o.text() : null)) : null;
  const attachments: PreparedAttachment[] = [];
  if (withAttachments) {
    const { results } = await env.DB.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid")
      .bind(row.id)
      .all<AttachmentRow>();
    for (const a of results) {
      if (!a.r2_key) continue;
      const o = await env.BLOBS.get(a.r2_key);
      if (!o) continue;
      attachments.push({
        filename: a.filename || "attachment",
        type: a.content_type || "application/octet-stream",
        disposition: a.disposition === "inline" ? "inline" : "attachment",
        contentId: a.content_id ?? undefined,
        bytes: new Uint8Array(await o.arrayBuffer()),
      });
    }
  }
  return { text: row.text_body ?? "", html, attachments };
}

/**
 * Forward a message: subject "Fwd: ...", your text first, then the quoted original (header block,
 * text, HTML) and, by default, its attachments. Recipients follow the same rules and limits as
 * send (reply_only on the shared domain, the daily limit, internal delivery to own inboxes). It is
 * stored in the original's thread.
 */
export async function forwardMessage(env: AppEnv, accountId: string, messageId: string, input: ForwardInput, opts: SendOptions = {}) {
  const key = parseIdempotencyKey(opts.idempotencyKey);
  const original = await getMessageRow(env, accountId, messageId);
  const inbox = await getInboxRow(env, accountId, original.inbox_id);
  assertNotExpired(inbox);
  if (input.to === undefined && input.cc === undefined && input.bcc === undefined)
    throw badRequest("No recipients.", 'Pass to (an address or a list), e.g. {"to":"ops@example.com"}.');
  const withAtts = input.include_attachments ?? true;
  const content = await originalContent(env, original, withAtts);
  const kept = content.attachments.slice(0, MAX_ATTACHMENTS);
  const skipped = content.attachments.length - kept.length;
  const attBytes = kept.reduce((n, a) => n + a.bytes.byteLength, 0);
  if (attBytes > MAX_TOTAL_BYTES)
    throw badRequest(
      `The original's attachments are ${Math.round(attBytes / 1048576)} MiB; a message may carry at most 25 MiB.`,
      'Forward without them: {"include_attachments": false} (the text and HTML still go along).',
    );
  const header = forwardHeader(original);
  const note = input.text?.trim() ? input.text : input.html ? htmlToText(input.html) : "";
  const text = `${note ? `${note}\n\n` : ""}${header.join("\n")}\n\n${content.text}`;
  const html = content.html
    ? `${input.html ?? (note ? `<div>${escapeHtml(note).replace(/\n/g, "<br>")}</div>` : "")}<br><div>${header
        .map(escapeHtml)
        .join("<br>")}</div><br>${content.html}`
    : undefined;
  const p = prepare({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: forwardSubject(original.subject),
    text,
    html,
    attachments: { bytes: kept },
    headers: input.headers,
  });
  const at = parseSendAt(input.send_at);
  const thread = { threadId: original.thread_id, inReplyTo: null, references: null };
  const r = await withIdempotency<SendResult>(env, accountId, key, `forward:${messageId}`, input, (t) =>
    at ? scheduleAndStore(env, inbox, p, thread, at, opts) : sendAndStore(env, inbox, p, thread, t),
  );
  return {
    ...r,
    forwarded: { message_id: original.id, attachments_included: kept.length, attachments_skipped: skipped },
  };
}
