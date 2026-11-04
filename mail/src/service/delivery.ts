import { badRequest } from "@afs/shared";
import { type AppEnv, standingOf } from "../env";
import { parkOnInbox } from "../lib/park";
import { assertActive, rateLimit } from "./budgets";
import { type Addr, type MessageRow, iso } from "./format";
import { getInboxRow } from "./inboxes";
import { getMessageRow } from "./messages";
import { acquireWaitSlot, clampTimeout, releaseWaitSlot } from "./wait";
import { emitEvent } from "./webhooks";

/**
 * Delivery status per recipient, from Cloudflare Email Sending events.
 *
 * Email Sending publishes cf.email.sending.message.{delivered,deferred,bounced,failed,rejected,
 * complained} to a Queues event subscription, one subscription per sending domain
 * (developers.cloudflare.com/email-service/reference/event-subscriptions/). This Worker consumes
 * that queue (queue() dispatches by message shape, so it may be the webhooks queue or one of its
 * own); DELIVERY_EVENTS_QUEUE names it and turns tracking on in responses. Each event names the
 * message id send() returned (messages.provider_message_id) and one recipient.
 *
 *   sent        accepted by Email Service, no event yet (also every recipient while tracking is off)
 *   deferred    a temporary failure; Email Service retries (not terminal)
 *   delivered | bounced | failed | rejected | complained   terminal
 *
 * Events are applied idempotently (same event id: no-op) and in order: a terminal status is never
 * replaced by a non-terminal one, an older event never replaces a newer one, and complained (a spam
 * report after delivery) always wins. Each change to a terminal status emits message.delivered,
 * message.bounced, message.complained or message.failed (failed and rejected) to webhooks and the
 * event feed, and wakes GET /v1/messages/:id/delivery waits. Recipients that are the account's own
 * inboxes are "delivered" (internal: true) at send time.
 */

export const DELIVERY_STATUSES = ["sent", "delivered", "deferred", "bounced", "failed", "rejected", "complained"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
const TERMINAL = new Set<string>(["delivered", "bounced", "failed", "rejected", "complained"]);
const EVENT_PREFIX = "cf.email.sending.message.";
const SMTP_RESPONSE_CHARS = 500;
/** How often the "events seen for this domain" marker is rewritten. */
const SEEN_EVERY_MS = 3_600_000;

export const trackingEnabled = (env: AppEnv) => !!env.DELIVERY_EVENTS_QUEUE;

export interface EmailSendingEvent {
  type: string;
  source?: { type?: string; zoneId?: string; domain?: string };
  payload: {
    eventId?: string;
    messageId?: string;
    sender?: string;
    recipient?: string;
    terminal?: boolean;
    delivery?: { status?: string; smtpStatusCode?: string; smtpEnhancedStatusCode?: string; smtpResponse?: string };
    bounce?: { type?: string; classification?: string; reason?: string };
    failure?: { reason?: string };
    rejection?: { reason?: string; party?: string; detail?: string };
    complaint?: { type?: string };
  };
  metadata?: { eventTimestamp?: string; accountId?: string; eventSubscriptionId?: string };
}

/** A queue message body from an Email Sending event subscription (not one of our webhook jobs). Pure. */
export function isEmailSendingEvent(body: unknown): body is EmailSendingEvent {
  const b = body as EmailSendingEvent | null;
  return !!b && typeof b === "object" && typeof b.type === "string" && b.type.startsWith(EVENT_PREFIX) && !!b.payload;
}

interface DeliveryRow {
  message_id: string;
  account_id: string;
  recipient: string;
  status: string;
  terminal: number;
  internal: number;
  smtp_code: string | null;
  smtp_enhanced: string | null;
  smtp_response: string | null;
  detail: string | null;
  event_id: string | null;
  event_at: number | null;
  updated_at: number;
}

/** What one event says about one recipient (pure). null = not an event we track. */
export function parseDeliveryEvent(ev: EmailSendingEvent) {
  const status = ev.type.slice(EVENT_PREFIX.length);
  if (!(DELIVERY_STATUSES as readonly string[]).includes(status) || status === "sent") return null;
  const p = ev.payload;
  if (!p.messageId || !p.recipient) return null;
  const at = Date.parse(ev.metadata?.eventTimestamp ?? "");
  const detail =
    p.bounce?.reason ??
    (p.rejection ? [p.rejection.reason, p.rejection.party, p.rejection.detail].filter(Boolean).join(": ") : null) ??
    p.failure?.reason ??
    p.complaint?.type ??
    null;
  return {
    status: status as DeliveryStatus,
    providerMessageId: p.messageId.replace(/^<|>$/g, ""),
    recipient: p.recipient.toLowerCase(),
    terminal: TERMINAL.has(status),
    smtp_code: p.delivery?.smtpStatusCode ?? null,
    smtp_enhanced: p.delivery?.smtpEnhancedStatusCode ?? null,
    smtp_response: p.delivery?.smtpResponse ? p.delivery.smtpResponse.slice(0, SMTP_RESPONSE_CHARS) : null,
    detail: detail ? detail.slice(0, SMTP_RESPONSE_CHARS) : null,
    bounce_type: p.bounce?.type ?? null,
    event_id: p.eventId ?? null,
    at: Number.isNaN(at) ? Date.now() : at,
    domain: ev.source?.domain?.toLowerCase() ?? null,
  };
}

/** The webhook / feed event a terminal status emits. */
const eventFor = (s: string) =>
  s === "delivered"
    ? "message.delivered"
    : s === "bounced"
      ? "message.bounced"
      : s === "complained"
        ? "message.complained"
        : s === "failed" || s === "rejected"
          ? "message.failed"
          : null;

/** D1 statements recording the recipients of a send (internal ones already delivered). */
export function deliveryRowsForSend(
  env: AppEnv,
  messageId: string,
  accountId: string,
  external: string[],
  internal: { recipient: string; status: "delivered" | "rejected"; reason?: string }[],
  now: number,
): D1PreparedStatement[] {
  const ins = (r: string, status: string, terminal: number, isInternal: number, detail: string | null) =>
    env.DB.prepare(
      `INSERT INTO deliveries (message_id, account_id, recipient, status, terminal, internal, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, recipient) DO NOTHING`,
    ).bind(messageId, accountId, r.toLowerCase(), status, terminal, isInternal, detail, now);
  return [
    ...[...new Set(external.map((r) => r.toLowerCase()))].map((r) => ins(r, "sent", 0, 0, null)),
    ...internal.map((d) => ins(d.recipient, d.status === "delivered" ? "delivered" : "failed", 1, 1, d.reason ?? null)),
  ];
}

/**
 * Apply one Email Sending event. Unknown messages (sent before tracking, or by something else on
 * the same sending domain) are ignored. Throws only on a D1 error, so the queue retries.
 */
export async function handleDeliveryEvent(env: AppEnv, ev: EmailSendingEvent): Promise<"applied" | "unchanged" | "unknown"> {
  const e = parseDeliveryEvent(ev);
  if (!e) return "unknown";
  if (e.domain) await markSeen(env, e.domain, e.at).catch((err) => console.error("delivery seen marker failed", err));
  const msg = await env.DB.prepare(
    "SELECT id, account_id, inbox_id, subject FROM messages WHERE provider_message_id = ? AND direction = 'out' LIMIT 1",
  )
    .bind(e.providerMessageId)
    .first<Pick<MessageRow, "id" | "account_id" | "inbox_id" | "subject">>();
  if (!msg) return "unknown";
  const changed = await env.DB.prepare(
    `INSERT INTO deliveries (message_id, account_id, recipient, status, terminal, internal, smtp_code, smtp_enhanced, smtp_response, detail, event_id, event_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(message_id, recipient) DO UPDATE SET status = excluded.status, terminal = excluded.terminal,
       smtp_code = excluded.smtp_code, smtp_enhanced = excluded.smtp_enhanced, smtp_response = excluded.smtp_response,
       detail = excluded.detail, event_id = excluded.event_id, event_at = excluded.event_at, updated_at = excluded.updated_at
     WHERE deliveries.internal = 0 AND deliveries.event_id IS NOT excluded.event_id AND deliveries.status != 'complained' AND (
       excluded.status = 'complained'
       OR (deliveries.terminal = 0 AND (excluded.terminal = 1 OR COALESCE(deliveries.event_at, 0) <= excluded.event_at))
       OR (deliveries.terminal = 1 AND excluded.terminal = 1 AND COALESCE(deliveries.event_at, 0) <= excluded.event_at))
     RETURNING status`,
  )
    .bind(
      msg.id,
      msg.account_id,
      e.recipient,
      e.status,
      e.terminal ? 1 : 0,
      e.smtp_code,
      e.smtp_enhanced,
      e.smtp_response,
      e.detail,
      e.event_id,
      e.at,
      Date.now(),
    )
    .first<{ status: string }>();
  if (!changed) return "unchanged";
  try {
    await env.INBOX.get(env.INBOX.idFromName(msg.inbox_id)).notify(e.at);
  } catch (err) {
    console.error("delivery notify failed", err);
  }
  const type = eventFor(e.status);
  if (type) {
    try {
      await emitEvent(env, msg.account_id, msg.inbox_id, type, {
        message_id: msg.id,
        inbox_id: msg.inbox_id,
        recipient: e.recipient,
        status: e.status,
        smtp_code: e.smtp_code,
        smtp_enhanced_status: e.smtp_enhanced,
        smtp_response: e.smtp_response,
        detail: e.detail,
        ...(e.bounce_type ? { bounce_type: e.bounce_type } : {}),
        at: e.at,
        url: `/v1/messages/${msg.id}/delivery`,
      });
    } catch (err) {
      console.error("delivery event emit failed", err);
    }
  }
  return "applied";
}

/** Remember that events arrive for a sending domain (shows whether its subscription works). */
async function markSeen(env: AppEnv, domain: string, at: number) {
  const name = `delivery_seen:${domain}`;
  await env.DB.prepare(
    `INSERT INTO cron_state (name, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE cron_state.updated_at < ?3 - ?4`,
  )
    .bind(name, String(at), at, SEEN_EVERY_MS)
    .run();
}

async function seenAt(env: AppEnv, domain: string): Promise<number | null> {
  const r = await env.DB.prepare("SELECT updated_at FROM cron_state WHERE name = ?")
    .bind(`delivery_seen:${domain}`)
    .first<{ updated_at: number }>();
  return r?.updated_at ?? null;
}

export function deliveryJson(r: DeliveryRow) {
  return {
    recipient: r.recipient,
    status: r.status,
    terminal: !!r.terminal,
    internal: !!r.internal,
    smtp_code: r.smtp_code,
    smtp_enhanced_status: r.smtp_enhanced,
    smtp_response: r.smtp_response,
    detail: r.detail,
    at: r.event_at ?? r.updated_at,
    at_iso: iso(r.event_at ?? r.updated_at),
  };
}

/** The delivery rows of a sent message, filling in "sent" for recipients without one (sent before tracking). */
export async function deliveryOf(env: AppEnv, row: MessageRow) {
  if (row.status === "scheduled" || row.status === "sending") return [];
  const failed = row.status === "failed";
  const { results } = await env.DB.prepare("SELECT * FROM deliveries WHERE message_id = ? ORDER BY recipient")
    .bind(row.id)
    .all<DeliveryRow>();
  const have = new Set(results.map((r) => r.recipient));
  const listed = [row.to_json, row.cc_json, row.bcc_json].flatMap((j) => (JSON.parse(j) as Addr[]).map((a) => a.address.toLowerCase()));
  const missing = [...new Set(listed)].filter((a) => !have.has(a));
  const rows = [
    ...results,
    ...missing.map(
      (recipient): DeliveryRow => ({
        message_id: row.id,
        account_id: row.account_id,
        recipient,
        status: failed ? "failed" : "sent",
        terminal: failed ? 1 : 0,
        internal: 0,
        smtp_code: null,
        smtp_enhanced: null,
        smtp_response: null,
        detail: failed ? row.error : null,
        event_id: null,
        event_at: null,
        updated_at: row.received_at,
      }),
    ),
  ];
  return rows.map(deliveryJson);
}

/**
 * GET /v1/messages/:id/delivery?timeout=: per-recipient status of a sent message. With a timeout
 * (seconds, max 120) the call blocks until every recipient is terminal or the time is up, then
 * answers 200 either way (`complete` says which). Without tracking it answers at once.
 */
export async function getDelivery(env: AppEnv, accountId: string, messageId: string, timeoutS?: number) {
  const started = Date.now();
  const row = await getMessageRow(env, accountId, messageId);
  if (row.direction !== "out")
    throw badRequest(
      "Delivery status is for sent messages.",
      "This message was received; its auth and envelope are on GET /v1/messages/:id.",
    );
  const inbox = await getInboxRow(env, accountId, row.inbox_id);
  const tracking = trackingEnabled(env);
  const seen = tracking ? await seenAt(env, inbox.domain) : null;
  const done = (d: Awaited<ReturnType<typeof deliveryOf>>) => d.length > 0 && d.every((x) => x.terminal);
  const answer = (d: Awaited<ReturnType<typeof deliveryOf>>) => ({
    message_id: row.id,
    status: row.status,
    tracking: tracking ? ("on" as const) : ("off" as const),
    sending_domain: inbox.domain,
    events_seen_at: seen,
    complete: done(d),
    delivery: d,
    waited_ms: Date.now() - started,
    next_steps:
      row.status === "scheduled"
        ? [`Scheduled for ${iso(row.scheduled_at)}; delivery starts once it has gone out.`]
        : !tracking
          ? [
              'Delivery tracking is off on this deployment: "sent" means Email Service accepted the message. The operator turns it on with an Email Sending event subscription (README: Delivery status).',
            ]
          : done(d)
            ? []
            : [
                `Not every recipient has a final status yet. Call again with ?timeout=60 to wait, or follow message.delivered / message.bounced on GET /v1/events or a webhook.${seen ? "" : ` No delivery event has been seen for ${inbox.domain} yet: its Email Sending event subscription may be missing.`}`,
              ],
  });
  let d = await deliveryOf(env, row);
  const timeout = clampTimeout(timeoutS ?? 0);
  if (!tracking || done(d) || timeout <= 0 || row.status === "scheduled") return answer(d);

  const standing = await standingOf(env, accountId);
  assertActive(standing);
  await rateLimit(
    env.WAIT_LIMITER,
    `wait:${accountId}`,
    "wait",
    "Waits are limited per account per minute. Use one longer timeout (up to 120 s), or the event feed. Retry in a minute.",
  );
  const deadline = started + timeout * 1000;
  const slot = await acquireWaitSlot(env, standing, inbox, deadline);
  const stub = env.INBOX.get(env.INBOX.idFromName(inbox.id));
  try {
    let version = await stub.version();
    for (;;) {
      d = await deliveryOf(env, row);
      if (done(d)) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const r = await parkOnInbox(stub, version, remaining);
      if (!r.woken) break;
      if (r.version === version) await new Promise((res) => setTimeout(res, Math.min(250, Math.max(0, deadline - Date.now()))));
      version = r.version;
    }
  } finally {
    if (slot) await releaseWaitSlot(env, slot);
  }
  return answer(await deliveryOf(env, row));
}

/** GET /v1/usage: delivery outcomes of the last `days` days, per status. */
export async function deliveryCounts(env: AppEnv, accountId: string, days: number, now = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM deliveries WHERE account_id = ? AND updated_at > ? GROUP BY status",
  )
    .bind(accountId, now - days * 86_400_000)
    .all<{ status: string; n: number }>();
  const counts = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as Record<DeliveryStatus, number>;
  for (const r of results) if (r.status in counts) counts[r.status as DeliveryStatus] = r.n;
  return { days, tracking: trackingEnabled(env), ...counts };
}
