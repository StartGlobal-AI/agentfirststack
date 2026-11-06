import { identityDb, newId } from "@afs/shared";
import { type AppEnv, type Standing, standingOf } from "../env";
import { normalizeRecipient } from "../lib/address";
import {
  type DigestItem,
  type DigestReason,
  FORWARD_MARKER,
  digestDue,
  digestEmail,
  eachForwardEmail,
  forwardFooter,
  forwardFromName,
  localParts,
} from "../lib/forwarding";
import { hasControlChars } from "../lib/headers";
import { refundDaily, reserveDaily } from "./budgets";
import type { InboxRow, MessageRow } from "./format";
import { type Members, forwardRecipients, forwardRecipientsMany, maxForwardsPerDay, settingOf } from "./forward-settings";
import {
  MAX_ATTACHMENTS,
  MAX_TOTAL_BYTES,
  type PreparedAttachment,
  assertCanSendFrom,
  forwardHeader,
  originalContent,
  prepare,
  sendExternal,
} from "./send";
import { emitEvent } from "./webhooks";

/**
 * Forwarding an inbox's mail to the project's members (the people who claimed it with Google
 * sign-in), so the owner sees what arrives after the agent's session has ended.
 *
 *   each    after a message is stored (email() hands it over with waitUntil, after the SMTP answer)
 *           it is forwarded to every member, one email each, from the inbox's own address (display
 *           name "<inbox> via AgentFirstStack"), subject "[<inbox>] <subject>", with the original's
 *           header block, text, HTML (active content stripped) and attachments (within the forward
 *           limits) and a footer saying how to change it. No Reply-To: a reply goes to the inbox
 *           (and, coming from a member, is never forwarded back).
 *   digest  the hourly cron sends one email per member at digest_hour in the inbox's time zone,
 *           on days with new mail, listing it newest first (src/lib/forwarding.ts digestEmail).
 *
 * What may be forwarded is decided at ingest (forwardEligibility): mail that may be gets a
 * forward_queue row in the transaction that stores it. Loops (mail from the account's own inboxes
 * or from a member) are dropped here. Rows are claimed while they are sent and deleted once they
 * were, so a cron retry or a concurrent run never sends the same mail twice; the digest-hour digest
 * also claims its local day on the inbox.
 *
 * Before anyone claims the project there is nobody to send to: rows wait (at most
 * FORWARD_QUEUE_MAX_DAYS). Once a member exists, the cron sends one catch-up digest of what waited,
 * then the chosen mode continues. Budget: MAX_FORWARDS_PER_ACCOUNT_PER_DAY recipients per UTC day,
 * never SEND_DAILY_LIMIT. Past it each-mode forwarding pauses and the rest goes into a digest once
 * the budget allows (the next day's first cron), with a note. Suspended accounts send nothing.
 *
 * Nothing is stored as a sent message and no message.sent event is emitted: either would show the
 * members' addresses to the agent's key. message.forwarded carries counts only.
 */

/** Mode each: how long the live forward has before the cron sends what is left as a digest. */
export const FORWARD_GRACE_MS = 10 * 60_000;
/** A claim older than this belongs to a run that died; another run may take the mail over. */
export const STALE_CLAIM_MS = 15 * 60_000;
const CRON_PAGE = 200;
/** Room kept for the text and HTML when attachments go along (MAX_TOTAL_BYTES is the whole message). */
const BODY_MARGIN = 512 * 1024;

/** The project's name (identity DB), else its account id. */
async function projectLabel(env: AppEnv, accountId: string): Promise<string> {
  try {
    const row = await identityDb(env).prepare("SELECT name FROM accounts WHERE id = ?").bind(accountId).first<{ name: string | null }>();
    return row?.name?.trim() || accountId;
  } catch {
    return accountId;
  }
}

/** <site>/dashboard/projects/<account id>, from AUTH_ISSUER (the platform's site); null without one. */
export function dashboardUrl(env: Pick<AppEnv, "AUTH_ISSUER">, accountId: string): string | null {
  const base = (env.AUTH_ISSUER ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/i.test(base)) return null;
  return `${base}/dashboard/projects/${accountId}`;
}

/** Senders never forwarded: the account's own inboxes and its members (loops). */
async function loopSenders(env: AppEnv, accountId: string, members: Members): Promise<(from: string | null) => boolean> {
  const { results } = await env.DB.prepare("SELECT address FROM inboxes WHERE account_id = ?").bind(accountId).all<{ address: string }>();
  const known = new Set([...results.map((r) => r.address.toLowerCase()), ...members.emails]);
  return (from) => {
    const a = (from ?? "").trim().toLowerCase();
    if (!a) return false;
    return known.has(a) || known.has(normalizeRecipient(a)?.address ?? a);
  };
}

/**
 * The inbox may not send now (a custom domain's sending records failed, or a shared domain not yet
 * onboarded to Email Sending): its mail stays queued (FORWARD_QUEUE_MAX_DAYS) and goes out as a
 * digest once it can. Logged, so the operator sees forwards held back by a domain.
 */
function cannotSend(inbox: InboxRow, e: unknown) {
  console.warn(
    JSON.stringify({
      event: "forward.cannot_send",
      inbox_id: inbox.id,
      domain: inbox.domain,
      code: (e as { code?: string })?.code ?? null,
      error: e instanceof Error ? e.message : String(e),
    }),
  );
}

/** Claim waiting rows for this run (token); returns how many. Stale claims are taken over. */
async function claim(env: AppEnv, token: string, now: number, where: string, ...binds: unknown[]): Promise<number> {
  const r = await env.DB.prepare(`UPDATE forward_queue SET claim = ?, claimed_at = ? WHERE ${where} AND (claim IS NULL OR claimed_at < ?)`)
    .bind(token, now, ...binds, now - STALE_CLAIM_MS)
    .run();
  return r.meta.changes ?? 0;
}

const release = (env: AppEnv, token: string) =>
  env.DB.prepare("UPDATE forward_queue SET claim = NULL, claimed_at = NULL WHERE claim = ?").bind(token).run();

const pause = (env: AppEnv, inboxId: string, now: number) =>
  env.DB.prepare("UPDATE inboxes SET forward_paused_at = COALESCE(forward_paused_at, ?) WHERE id = ?").bind(now, inboxId).run();

/** The footer's parts for this inbox. */
async function footerFor(env: AppEnv, inbox: InboxRow, mode: "each" | "digest") {
  return forwardFooter({
    inboxAddress: inbox.address,
    project: await projectLabel(env, inbox.account_id),
    dashboardUrl: dashboardUrl(env, inbox.account_id),
    mode,
  });
}

/** Third-party attachments as Email Service takes them: an unusable Content-ID makes it a plain attachment. */
function cleanAttachments(list: PreparedAttachment[]): PreparedAttachment[] {
  return list.map((a) => {
    const cid = a.contentId && !/[\s<>]/.test(a.contentId) && !hasControlChars(a.contentId) ? a.contentId : undefined;
    return { ...a, contentId: cid, disposition: a.disposition === "inline" && cid ? "inline" : "attachment" };
  });
}

/**
 * Send one email to each member (so none sees the others' addresses), from the inbox with the
 * forwarded marker. Returns how many went out; failures are logged.
 */
async function sendToMembers(
  env: AppEnv,
  inbox: InboxRow,
  emails: string[],
  mail: { subject: string; text: string; html?: string; attachments?: PreparedAttachment[] },
  marker: string,
): Promise<number> {
  const from = { ...inbox, display_name: forwardFromName(inbox) };
  const base = { to: emails[0]!, subject: mail.subject, text: mail.text, headers: { [FORWARD_MARKER]: marker } };
  let p: ReturnType<typeof prepare>;
  try {
    p = prepare({ ...base, html: mail.html, attachments: { bytes: mail.attachments ?? [] } });
  } catch (e) {
    // Something in the third-party HTML or attachments was refused: send the text alone.
    console.error(JSON.stringify({ event: "forward.prepare_failed", inbox_id: inbox.id, error: String(e) }));
    p = prepare({ ...base, text: `${mail.text}\n[The HTML version and attachments could not be included.]` });
  }
  let sent = 0;
  for (const to of emails) {
    try {
      await sendExternal(env, from, p, { to: [to], cc: [], bcc: [] }, p.headers);
      sent++;
    } catch (e) {
      console.error(JSON.stringify({ event: "forward.send_failed", inbox_id: inbox.id, error: String(e) }));
    }
  }
  return sent;
}

async function emitForwarded(
  env: AppEnv,
  inbox: InboxRow,
  kind: "each" | DigestReason,
  messageIds: string[],
  recipients: number,
  now: number,
) {
  try {
    await emitEvent(
      env,
      inbox.account_id,
      inbox.id,
      "message.forwarded",
      {
        inbox: { id: inbox.id, address: inbox.address },
        kind,
        messages: messageIds.length,
        message_ids: messageIds.slice(0, 50),
        recipients,
        ...(kind === "each" ? { url: `/v1/messages/${messageIds[0]}` } : { url: `/v1/inboxes/${inbox.id}` }),
      },
      now,
    );
  } catch (e) {
    console.error("message.forwarded emit failed", e);
  }
}

/** The forward of one message: header block, text, sanitized HTML, attachments that fit. */
async function eachMail(env: AppEnv, inbox: InboxRow, msg: MessageRow) {
  const content = await originalContent(env, msg, true);
  const footer = await footerFor(env, inbox, "each");
  let attachments = cleanAttachments(content.attachments.slice(0, MAX_ATTACHMENTS));
  let note: string | null = null;
  const bytes = attachments.reduce((n, a) => n + a.bytes.byteLength, 0);
  const body = content.text.length + (content.html?.length ?? 0);
  if (attachments.length && bytes + body > MAX_TOTAL_BYTES - BODY_MARGIN) {
    note = `${content.attachments.length} attachment(s) not included: a forward carries at most 25 MiB. Ask your agent for them.`;
    attachments = [];
  } else if (content.attachments.length > attachments.length) {
    note = `${content.attachments.length - attachments.length} more attachment(s) not included (at most ${MAX_ATTACHMENTS} per forward). Ask your agent for them.`;
  }
  const mail = eachForwardEmail({
    inboxAddress: inbox.address,
    subject: msg.subject,
    headerLines: forwardHeader(msg),
    text: content.text,
    html: content.html,
    footer,
    note,
  });
  return { ...mail, attachments };
}

export type ForwardEachResult =
  | "forwarded"
  | "not_queued"
  | "not_each"
  | "suspended"
  | "waiting_for_owner"
  | "loop"
  | "claimed"
  | "paused"
  | "cannot_send"
  | "failed";

/**
 * Mode each: forward one stored message to the members now. Safe to call more than once (the
 * queue row is claimed). Whatever does not go out stays queued for the cron's digest.
 */
export async function forwardEach(
  env: AppEnv,
  messageId: string,
  now = Date.now(),
): Promise<{ status: ForwardEachResult; recipients?: number }> {
  const q = await env.DB.prepare(
    "SELECT q.kind AS q_kind, i.* FROM forward_queue q JOIN inboxes i ON i.id = q.inbox_id WHERE q.message_id = ?",
  )
    .bind(messageId)
    .first<InboxRow & { q_kind: string }>();
  if (!q) return { status: "not_queued" };
  const { q_kind, ...inbox } = q;
  if (q_kind !== "forward" || inbox.forward_mode !== "each") return { status: "not_each" };
  const standing = await standingOf(env, inbox.account_id);
  if (standing.suspended) return { status: "suspended" };
  const members = await forwardRecipients(env, inbox.account_id);
  if (!members.emails.length) return { status: "waiting_for_owner" };
  const msg = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId).first<MessageRow>();
  if (!msg) return { status: "not_queued" };
  if ((await loopSenders(env, inbox.account_id, members))(msg.from_address)) {
    await env.DB.prepare("DELETE FROM forward_queue WHERE message_id = ?").bind(messageId).run();
    return { status: "loop" };
  }
  const token = newId("fwc");
  if (!(await claim(env, token, now, "message_id = ? AND kind = 'forward'", messageId))) return { status: "claimed" };
  let refund: { day: string | null; n: number } | null = null;
  try {
    try {
      await assertCanSendFrom(env, inbox);
    } catch (e) {
      cannotSend(inbox, e);
      await release(env, token);
      return { status: "cannot_send" };
    }
    const n = members.emails.length;
    const budget = await reserveDaily(env, inbox.account_id, "forward", maxForwardsPerDay(env, standing), now, n);
    if (!budget.ok) {
      await pause(env, inbox.id, now);
      await release(env, token);
      return { status: "paused" };
    }
    refund = { day: budget.day, n };
    const mail = await eachMail(env, inbox, msg);
    const sent = await sendToMembers(env, inbox, members.emails, mail, msg.id);
    refund = { day: budget.day, n: n - sent };
    if (!sent) {
      await release(env, token);
      return { status: "failed" };
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM forward_queue WHERE claim = ?").bind(token),
      // A pause note is only kept while what it explains still waits for its digest.
      env.DB.prepare(
        `UPDATE inboxes SET forward_last_forwarded_at = ?1,
           forward_paused_at = CASE WHEN EXISTS (SELECT 1 FROM forward_queue WHERE inbox_id = ?2) THEN forward_paused_at ELSE NULL END
         WHERE id = ?2`,
      ).bind(now, inbox.id),
    ]);
    await emitForwarded(env, inbox, "each", [msg.id], sent, now);
    return { status: "forwarded", recipients: sent };
  } catch (e) {
    console.error(JSON.stringify({ event: "forward.failed", message_id: messageId, error: String(e) }));
    await release(env, token).catch(() => {});
    return { status: "failed" };
  } finally {
    if (refund?.n) await refundDaily(env, inbox.account_id, "forward", refund.day, refund.n).catch(() => {});
  }
}

export type DigestResult = "sent" | "already_sent" | "nothing" | "paused" | "cannot_send" | "failed";

/**
 * One digest of what is waiting for an inbox, to each member. `reason` digest also claims the
 * inbox's local day (one digest-hour digest a day, whatever the retries). Mode each only takes mail
 * older than FORWARD_GRACE_MS (newer mail is the live forward's).
 */
export async function sendDigest(
  env: AppEnv,
  inbox: InboxRow,
  reason: DigestReason,
  members: Members,
  standing: Standing,
  now = Date.now(),
): Promise<{ status: DigestResult; messages?: number; recipients?: number }> {
  const setting = settingOf(inbox);
  let day: { day: string; prev: string | null } | null = null;
  if (reason === "digest") {
    const d = localParts(now, setting.timezone).day;
    const r = await env.DB.prepare("UPDATE inboxes SET forward_digest_day = ? WHERE id = ? AND forward_digest_day IS NOT ?")
      .bind(d, inbox.id, d)
      .run();
    if (!r.meta.changes) return { status: "already_sent" };
    day = { day: d, prev: inbox.forward_digest_day ?? null };
  }
  const undoDay = async () => {
    if (day)
      await env.DB.prepare("UPDATE inboxes SET forward_digest_day = ? WHERE id = ? AND forward_digest_day = ?")
        .bind(day.prev, inbox.id, day.day)
        .run();
  };
  const token = newId("fwc");
  const claimed =
    setting.mode === "each"
      ? await claim(env, token, now, "inbox_id = ? AND received_at <= ?", inbox.id, now - FORWARD_GRACE_MS)
      : await claim(env, token, now, "inbox_id = ?", inbox.id);
  if (!claimed) {
    await undoDay();
    return { status: "nothing" };
  }
  let refund: { day: string | null; n: number } | null = null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.from_address, m.from_name, m.subject, m.received_at, m.code, m.verify_link,
              substr(COALESCE(m.reply_text, m.text_body, m.preview, ''), 1, 1000) AS snippet
       FROM forward_queue q JOIN messages m ON m.id = q.message_id WHERE q.claim = ? ORDER BY m.received_at DESC, m.seq DESC LIMIT 5000`,
    )
      .bind(token)
      .all<DigestItem>();
    const isLoop = await loopSenders(env, inbox.account_id, members);
    const items = results.filter((i) => !isLoop(i.from_address));
    if (!items.length) {
      await env.DB.prepare("DELETE FROM forward_queue WHERE claim = ?").bind(token).run();
      await undoDay();
      return { status: "nothing" };
    }
    try {
      await assertCanSendFrom(env, inbox);
    } catch (e) {
      cannotSend(inbox, e);
      await release(env, token);
      await undoDay();
      return { status: "cannot_send" };
    }
    const n = members.emails.length;
    const limit = maxForwardsPerDay(env, standing);
    const budget = await reserveDaily(env, inbox.account_id, "forward", limit, now, n);
    if (!budget.ok) {
      await pause(env, inbox.id, now);
      await release(env, token);
      await undoDay();
      return { status: "paused" };
    }
    refund = { day: budget.day, n };
    // Unauthenticated mail is only counted: since the last digest (or since forwarding was turned
    // on); in mode each, over the span this digest covers.
    const oldest = Math.min(...items.map((i) => i.received_at));
    const since = setting.mode === "each" ? oldest - 1 : (inbox.forward_last_digest_at ?? inbox.forward_since ?? inbox.created_at);
    const unauth = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ? AND direction = 'in' AND received_at > ? AND received_at <= ?
         AND COALESCE(json_extract(auth_json, '$.verdict'), '') != 'pass'`,
    )
      .bind(inbox.id, since, now)
      .first<{ n: number }>();
    // Rows past the 5,000 loaded still count ("and N more").
    const total = items.length + Math.max(0, claimed - results.length);
    const mail = digestEmail({
      inboxAddress: inbox.address,
      items,
      total,
      timezone: setting.timezone,
      reason,
      mode: setting.mode === "each" ? "each" : "digest",
      digestHour: setting.digest_hour,
      unauthenticated: unauth?.n ?? 0,
      pausedAt: inbox.forward_paused_at ?? null,
      dailyLimit: Number.isFinite(limit) ? limit : null,
      footer: await footerFor(env, inbox, setting.mode === "each" ? "each" : "digest"),
    });
    const sent = await sendToMembers(env, inbox, members.emails, mail, `digest ${inbox.id}`);
    refund = { day: budget.day, n: n - sent };
    if (!sent) {
      await release(env, token);
      await undoDay();
      return { status: "failed" };
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM forward_queue WHERE claim = ?").bind(token),
      env.DB.prepare("UPDATE inboxes SET forward_last_digest_at = ?, forward_paused_at = NULL WHERE id = ?").bind(now, inbox.id),
    ]);
    await emitForwarded(
      env,
      inbox,
      reason,
      items.map((i) => i.id),
      sent,
      now,
    );
    return { status: "sent", messages: total, recipients: sent };
  } catch (e) {
    console.error(JSON.stringify({ event: "forward.digest_failed", inbox_id: inbox.id, error: String(e) }));
    await release(env, token).catch(() => {});
    await undoDay().catch(() => {});
    return { status: "failed" };
  } finally {
    if (refund?.n) await refundDaily(env, inbox.account_id, "forward", refund.day, refund.n).catch(() => {});
  }
}

/**
 * Hourly cron: for every inbox with mail waiting, send the digest that is due (src/lib/forwarding.ts
 * digestDue): the digest-hour digest, the one catch-up digest once a member exists, or what mode
 * each left over. Members are read for many accounts at once. Stops after `budgetMs` (more: true).
 */
export async function runForwards(env: AppEnv, now = Date.now(), budgetMs = 20_000) {
  const stop = Date.now() + budgetMs;
  const out = { forward_digests: 0, forward_catch_ups: 0, forward_leftovers: 0, forward_paused: 0, forward_more: false };
  let cursor = "";
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT w.inbox_id AS w_inbox_id, w.oldest_waiting, i.* FROM (
         SELECT inbox_id, MIN(received_at) AS oldest_waiting FROM forward_queue
         WHERE inbox_id > ?1 AND (claim IS NULL OR claimed_at < ?2) GROUP BY inbox_id ORDER BY inbox_id LIMIT ?3
       ) w LEFT JOIN inboxes i ON i.id = w.inbox_id ORDER BY w.inbox_id`,
    )
      .bind(cursor, now - STALE_CLAIM_MS, CRON_PAGE)
      .all<InboxRow & { w_inbox_id: string; oldest_waiting: number }>();
    if (!results.length) break;
    cursor = results[results.length - 1]!.w_inbox_id;
    const live = results.filter(
      (r) => r.id && (r.forward_mode === "each" || r.forward_mode === "digest") && (r.expires_at === null || r.expires_at > now),
    );
    const members = await forwardRecipientsMany(
      env,
      live.map((r) => r.account_id),
    );
    for (const r of live) {
      if (Date.now() >= stop) return { ...out, forward_more: true };
      const m = members.get(r.account_id);
      if (!m?.emails.length) continue; // nobody to send to yet: the mail waits
      const reason = digestDue({
        setting: settingOf(r),
        digestDay: r.forward_digest_day,
        lastForwardedAt: r.forward_last_forwarded_at,
        lastDigestAt: r.forward_last_digest_at,
        oldestWaiting: r.oldest_waiting,
        claimedAt: m.claimedAt,
        now,
        graceMs: FORWARD_GRACE_MS,
      });
      if (!reason) continue;
      const standing = await standingOf(env, r.account_id);
      if (standing.suspended) continue;
      const { w_inbox_id: _w, oldest_waiting: _o, ...inbox } = r;
      const res = await sendDigest(env, inbox as InboxRow, reason, m, standing, now);
      if (res.status === "paused") out.forward_paused++;
      if (res.status !== "sent") continue;
      if (reason === "digest") out.forward_digests++;
      else if (reason === "catch_up") out.forward_catch_ups++;
      else out.forward_leftovers++;
    }
    if (results.length < CRON_PAGE) break;
  }
  return out;
}
