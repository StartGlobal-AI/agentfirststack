import { type AppEnv, type Standing, type WebhookEvent, cap } from "../env";
import { reserveDaily } from "./budgets";

/**
 * The event feed's write side: every event webhooks get (except webhook.test) is also kept in D1
 * for GET /v1/events, so an agent without a public URL can follow its account with one cursor.
 *
 *   - Kept 7 days (EVENT_RETENTION_MS; the cron purges), at most MAX_FEED_EVENTS_PER_DAY per account
 *     per UTC day (default 5000, 1000 unclaimed). Past the budget an event is not kept in the
 *     feed (webhooks still get it).
 *   - Message text in the feed is the reply_text excerpt only (no text_excerpt): the full message
 *     is one GET /v1/messages/:id away.
 *   - Writing wakes long-polls through the account's feed object (an InboxDO named "acct:<id>").
 */

export const EVENT_RETENTION_MS = 7 * 86_400_000;
export const DEFAULT_MAX_FEED_EVENTS_PER_DAY = 5000;
export const DEFAULT_UNCLAIMED_MAX_FEED_EVENTS_PER_DAY = 1000;

/** Event types kept in the feed (and offered to webhooks). */
export const FEED_EVENT_TYPES = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.failed",
  "message.forwarded",
  "domain.verified",
] as const;
export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];

export const maxEventsPerDay = (env: AppEnv, standing: Standing) =>
  cap(
    env,
    standing,
    "MAX_FEED_EVENTS_PER_DAY",
    standing.claimed ? DEFAULT_MAX_FEED_EVENTS_PER_DAY : DEFAULT_UNCLAIMED_MAX_FEED_EVENTS_PER_DAY,
  );

/** The Durable Object that wakes the account's event-feed long-polls. */
export const feedObjectName = (accountId: string) => `acct:${accountId}`;

/** data as the feed keeps it: message.text_excerpt dropped. Pure. */
export function feedData(data: Record<string, unknown>): Record<string, unknown> {
  const m = data.message as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || !("text_excerpt" in m)) return data;
  const { text_excerpt: _drop, ...message } = m;
  return {
    ...data,
    message,
    ...(data.untrusted && typeof data.untrusted === "object"
      ? {
          untrusted: {
            ...(data.untrusted as Record<string, unknown>),
            fields: ((data.untrusted as { fields?: string[] }).fields ?? []).filter((f) => f !== "data.message.text_excerpt"),
          },
        }
      : {}),
  };
}

/** Keep one event in the feed and wake its long-polls. false = over today's budget (not kept). */
export async function recordEvent(env: AppEnv, accountId: string, inboxId: string | null, event: WebhookEvent, standing: Standing) {
  if (!(FEED_EVENT_TYPES as readonly string[]).includes(event.type)) return false;
  const budget = await reserveDaily(env, accountId, "event", maxEventsPerDay(env, standing), event.created_at);
  if (!budget.ok) return false;
  await env.DB.prepare("INSERT INTO events (id, account_id, inbox_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(event.id, accountId, inboxId, event.type, JSON.stringify(feedData(event.data)), event.created_at)
    .run();
  try {
    await env.INBOX.get(env.INBOX.idFromName(feedObjectName(accountId))).notify(event.created_at);
  } catch (e) {
    console.error("feed notify failed (long-polls fall back to their timeout)", e);
  }
  return true;
}

/** Cron: events older than EVENT_RETENTION_MS, in chunks under a wall-time budget. */
export async function purgeEvents(env: AppEnv, now = Date.now(), budgetMs = 20_000) {
  const stop = Date.now() + budgetMs;
  let purged = 0;
  for (;;) {
    if (Date.now() >= stop) return { events_purged: purged, events_more: true };
    const r = await env.DB.prepare("DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE created_at < ? LIMIT 1000)")
      .bind(now - EVENT_RETENTION_MS)
      .run();
    const n = r.meta.changes ?? 0;
    purged += n;
    if (n < 1000) return { events_purged: purged, events_more: false };
  }
}
