import { type AppEnv, type CapName, cap, standingOf } from "../env";
import { maxBlobBytes, nextUtcMidnight } from "./budgets";
import { deliveryCounts } from "./delivery";
import { maxEventsPerDay } from "./feed";
import { maxForwardsPerDay } from "./forward-settings";
import { attachmentTextPerDay } from "./attachment-text";
import { maxListEntries } from "./lists";
import { utcDay } from "./format";
import { SMALL_MESSAGE_BYTES, formatBytes, maxInboundBytesPerSender, maxInboundMessageBytes, maxInboundPerDay } from "./ingest";
import { activePauses, sendHealthJson } from "./pauses";
import { dailyLimit, maxScheduled } from "./send";
import { DEFAULT_MAX_CONCURRENT_WAITS, DEFAULT_MAX_CONCURRENT_WAITS_PER_INBOX } from "./wait";
import { maxWebhooks } from "./webhooks";

/**
 * GET /v1/usage: every cap that applies to this account, with what it has used, the limit this
 * deployment configures for an account of its standing (UNCLAIMED_<name> until a person claims
 * it), and when daily budgets reset. Read before a 429, not after (rule 6). limit null = no cap.
 * Analytics, tags and replay share the item shape: label (for a person), drops_data (reaching it
 * loses incoming data silently) and per (per-entity caps), so the platform site can warn owners.
 */

/** One entity under a per-entity cap (an inbox under messages_per_inbox). */
export interface UsagePer {
  id: string;
  /** What a person reads: the inbox's address. */
  label: string;
  used: number;
  remaining: number | null;
}

export interface UsageItem {
  /** A short sentence-case name a person reads in an email ("Inbound mail a day"). */
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** Daily budgets: next 00:00 UTC (unix ms). null for caps that do not reset. */
  resets_at: number | null;
  /** What one unit is, and what the cap counts. */
  unit: string;
  /** The operator var that sets it (UNCLAIMED_<var> for unclaimed accounts). */
  var: string;
  note?: string;
  /**
   * Reaching it silently loses incoming data (mail rejected at SMTP, oldest mail evicted, text cut
   * to an excerpt) rather than failing the agent's own call with a clear error. Absent otherwise.
   */
  drops_data?: true;
  /** Per-entity caps: every entity (inbox), highest use first, at most PER_MAX. used = the top one. */
  per?: UsagePer[];
}

/** At most this many entries in an item's per list. */
export const PER_MAX = 25;

const num = (n: number) => (Number.isFinite(n) ? n : null);

interface ItemOpts {
  note?: string;
  drops_data?: true;
  per?: UsagePer[];
}

function item(
  label: string,
  used: number | null,
  limit: number,
  unit: string,
  varName: string,
  resetsAt: number | null,
  opts: ItemOpts = {},
): UsageItem {
  const l = num(limit);
  return {
    label,
    used,
    limit: l,
    remaining: l === null || used === null ? null : Math.max(0, l - used),
    resets_at: resetsAt,
    unit,
    var: varName,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.drops_data ? { drops_data: true as const } : {}),
    ...(opts.per ? { per: opts.per } : {}),
  };
}

export async function getUsage(env: AppEnv, accountId: string, opts: { days?: number } = {}, now = Date.now()) {
  const standing = await standingOf(env, accountId);
  const day = utcDay(now);
  const resets = nextUtcMidnight(now);
  const c = (name: CapName, fallback?: number) => cap(env, standing, name, fallback);
  const counters = env.DB.prepare(
    `SELECT
       (SELECT count FROM send_counters WHERE account_id = ?1 AND day = ?2) AS sends,
       (SELECT count FROM inbound_counters WHERE account_id = ?1 AND day = ?2) AS inbound,
       (SELECT MAX(count) FROM sender_counters WHERE account_id = ?1 AND day = ?2) AS top_sender,
       (SELECT MAX(b) FROM (SELECT SUM(bytes) AS b FROM sender_counters WHERE account_id = ?1 AND day = ?2 GROUP BY sender)) AS top_sender_bytes,
       (SELECT count FROM account_daily WHERE account_id = ?1 AND kind = 'inbox_create' AND day = ?2) AS inbox_creates,
       (SELECT count FROM account_daily WHERE account_id = ?1 AND kind = 'inbox_delete' AND day = ?2) AS inbox_deletes,
       (SELECT count FROM account_daily WHERE account_id = ?1 AND kind = 'webhook_test' AND day = ?2) AS webhook_tests,
       (SELECT COUNT(*) FROM inboxes WHERE account_id = ?1) AS inboxes,
       (SELECT MAX(inbound_count) FROM inboxes WHERE account_id = ?1) AS fullest_inbox,
       (SELECT COUNT(*) FROM webhooks WHERE account_id = ?1) AS webhooks,
       (SELECT COUNT(*) FROM active_waits WHERE account_id = ?1 AND expires_at > ?3) AS waits,
       (SELECT blob_bytes FROM account_usage WHERE account_id = ?1) AS blob_bytes,
       (SELECT text_bytes FROM account_usage WHERE account_id = ?1) AS text_bytes,
       (SELECT COUNT(*) FROM list_entries WHERE account_id = ?1) AS list_entries,
       (SELECT count FROM account_daily WHERE account_id = ?1 AND kind = 'event' AND day = ?2) AS events,
       (SELECT count FROM account_daily WHERE account_id = ?1 AND kind = 'inbox_clear' AND day = ?2) AS inbox_clears,
       (SELECT COUNT(*) FROM messages WHERE account_id = ?1 AND status = 'scheduled') AS scheduled,
       (SELECT count FROM account_daily WHERE account_id = ?1 AND kind = 'attachment_text' AND day = ?2) AS attachment_text,
       (SELECT count FROM account_daily WHERE account_id = ?1 AND kind = 'forward' AND day = ?2) AS forwards`,
  )
    .bind(accountId, day, now)
    .first<Record<string, number | null>>();
  // messages_per_inbox lists every inbox; inboxes per account are capped (MAX_INBOXES_PER_ACCOUNT), so this stays small.
  const inboxes = env.DB.prepare(
    `SELECT id, address, inbound_count FROM inboxes WHERE account_id = ? ORDER BY inbound_count DESC, created_at, id LIMIT ${PER_MAX}`,
  )
    .bind(accountId)
    .all<{ id: string; address: string; inbound_count: number }>();
  const [row, perInbox, paused, sendHealth] = await Promise.all([
    counters,
    inboxes,
    activePauses(env, accountId),
    sendHealthJson(env, accountId, standing, now),
  ]);
  const v = (k: string) => row?.[k] ?? 0;
  const maxMessages = c("MAX_MESSAGES_PER_INBOX");
  const maxMessagesN = num(maxMessages);
  const limits: Record<string, UsageItem> = {
    sends_per_day: item(
      "Recipients sent a day",
      v("sends"),
      dailyLimit(env, standing),
      "recipients (to + cc + bcc) sent",
      "SEND_DAILY_LIMIT",
      resets,
    ),
    forwards_per_day: item(
      "Emails forwarded to members a day",
      v("forwards"),
      maxForwardsPerDay(env, standing),
      "emails forwarded to the project's members (one per member per forward or digest)",
      "MAX_FORWARDS_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Inbox forwarding (forward on an inbox) has its own budget and never counts toward SEND_DAILY_LIMIT. Past it, forwarding each email pauses until 00:00 UTC and the rest goes into a digest.",
      },
    ),
    inbound_per_day: item(
      "Inbound mail a day",
      v("inbound"),
      maxInboundPerDay(env, standing),
      "messages stored, across inboxes",
      "MAX_INBOUND_PER_ACCOUNT_PER_DAY",
      resets,
      { note: "Mail beyond it is rejected at SMTP time; one sender gets at most half of it.", drops_data: true },
    ),
    inbound_per_sender_per_day: item(
      "Inbound mail from one sender a day",
      v("top_sender"),
      c("MAX_INBOUND_PER_SENDER_PER_DAY"),
      "messages from one sender to one inbox (used = the busiest sender today)",
      "MAX_INBOUND_PER_SENDER_PER_DAY",
      resets,
    ),
    inbound_bytes_per_sender_per_day: item(
      "Inbound bytes from one sender a day",
      v("top_sender_bytes"),
      maxInboundBytesPerSender(env, standing),
      "bytes of raw mail from one sender, across inboxes (used = the busiest sender today)",
      "MAX_INBOUND_BYTES_PER_SENDER_PER_DAY",
      resets,
      { note: "Beyond it that sender's mail is rejected at SMTP time until 00:00 UTC; other senders are not affected." },
    ),
    inbound_message_bytes: item(
      "Largest inbound message",
      null,
      maxInboundMessageBytes(env, standing),
      "bytes of one received message (raw MIME)",
      "MAX_INBOUND_MESSAGE_BYTES",
      null,
      { note: "Larger messages are rejected at SMTP time." },
    ),
    inbox_creates_per_day: item(
      "Inboxes created a day",
      v("inbox_creates"),
      c("MAX_INBOX_CREATES_PER_DAY"),
      "inboxes created",
      "MAX_INBOX_CREATES_PER_DAY",
      resets,
    ),
    inbox_deletes_per_day: item(
      "Inboxes deleted a day",
      v("inbox_deletes"),
      c("MAX_INBOX_DELETES_PER_DAY"),
      "inboxes deleted by API",
      "MAX_INBOX_DELETES_PER_DAY",
      resets,
    ),
    webhook_tests_per_day: item(
      "Webhook tests a day",
      v("webhook_tests"),
      c("MAX_WEBHOOK_TESTS_PER_DAY"),
      "test events sent",
      "MAX_WEBHOOK_TESTS_PER_DAY",
      resets,
    ),
    inboxes: item("Inboxes", v("inboxes"), c("MAX_INBOXES_PER_ACCOUNT"), "inboxes", "MAX_INBOXES_PER_ACCOUNT", null),
    messages_per_inbox: item(
      "Messages in one inbox",
      v("fullest_inbox"),
      maxMessages,
      "inbound messages one inbox holds (used = the fullest inbox)",
      "MAX_MESSAGES_PER_INBOX",
      null,
      {
        note: "Beyond it the oldest mail of the sender holding the most is evicted.",
        drops_data: true,
        per: perInbox.results.map((r) => ({
          id: r.id,
          label: r.address,
          used: r.inbound_count,
          remaining: maxMessagesN === null ? null : Math.max(0, maxMessagesN - r.inbound_count),
        })),
      },
    ),
    webhooks: item(
      "Webhooks",
      v("webhooks"),
      maxWebhooks(env, standing),
      "webhooks (disabled ones count)",
      "MAX_WEBHOOKS_PER_ACCOUNT",
      null,
    ),
    concurrent_waits: item(
      "Waits at once",
      v("waits"),
      c("MAX_CONCURRENT_WAITS", DEFAULT_MAX_CONCURRENT_WAITS),
      "blocking calls parked at once (wait, latest-code, events, delivery)",
      "MAX_CONCURRENT_WAITS",
      null,
    ),
    concurrent_waits_per_inbox: item(
      "Waits at once on one inbox",
      null,
      c("MAX_CONCURRENT_WAITS_PER_INBOX", DEFAULT_MAX_CONCURRENT_WAITS_PER_INBOX),
      "blocking calls parked at once on one inbox",
      "MAX_CONCURRENT_WAITS_PER_INBOX",
      null,
    ),
    storage_bytes: item(
      "Mail storage",
      v("blob_bytes"),
      maxBlobBytes(env, standing),
      "bytes of mail kept (raw messages, HTML bodies, sent attachments)",
      "MAX_BLOB_BYTES_PER_ACCOUNT",
      null,
      {
        note: `When full, new mail is rejected (Mailbox full) until old mail is deleted. Past 80% the senders that keep the most of it can't send messages over ${formatBytes(SMALL_MESSAGE_BYTES)}, and the last 5% is kept for messages up to ${formatBytes(SMALL_MESSAGE_BYTES)} (verification codes still arrive).`,
        drops_data: true,
      },
    ),
    text_bytes: item(
      "Stored text",
      v("text_bytes"),
      c("MAX_TEXT_BYTES_PER_ACCOUNT"),
      "bytes of stored text (bodies, reply text, links)",
      "MAX_TEXT_BYTES_PER_ACCOUNT",
      null,
      { note: "Beyond it new mail keeps a 2 KB excerpt.", drops_data: true },
    ),
    list_entries: item(
      "Allow and block list entries",
      v("list_entries"),
      maxListEntries(env, standing),
      "allow / block list entries",
      "MAX_LIST_ENTRIES_PER_ACCOUNT",
      null,
    ),
    events_per_day: item(
      "Feed events a day",
      v("events"),
      maxEventsPerDay(env, standing),
      "events kept in the feed (GET /v1/events)",
      "MAX_FEED_EVENTS_PER_DAY",
      resets,
      { note: "Beyond it events are not kept in the feed; webhooks still get them." },
    ),
    inbox_clears_per_day: item(
      "Inbox clears a day",
      v("inbox_clears"),
      c("MAX_INBOX_CLEARS_PER_DAY"),
      "DELETE /v1/inboxes/:id/messages calls",
      "MAX_INBOX_CLEARS_PER_DAY",
      resets,
    ),
    scheduled: item(
      "Scheduled sends",
      v("scheduled"),
      maxScheduled(env, standing),
      "scheduled sends waiting to go out",
      "MAX_SCHEDULED_PER_ACCOUNT",
      null,
    ),
    attachment_text_per_day: item(
      "Attachments converted to text a day",
      v("attachment_text"),
      env.AI ? attachmentTextPerDay(env, standing) : 0,
      "attachments converted to text",
      "MAX_ATTACHMENT_TEXT_PER_DAY",
      resets,
      env.AI ? {} : { note: "Not available on this deployment (no Workers AI binding)." },
    ),
  };
  const retention = Number(env.SHARED_RETENTION_DAYS || 0);
  return {
    day,
    resets_at: resets,
    resets_at_iso: new Date(resets).toISOString(),
    claimed: standing.claimed,
    limits,
    delivery: await deliveryCounts(env, accountId, opts.days ?? 30, now),
    // Capabilities paused automatically (src/service/pauses.ts): { capability, reason, paused_at, paused_by, until }.
    paused,
    send_health: sendHealth,
    policy: {
      shared_send_policy: env.SHARED_SEND_POLICY === "reply_only" ? "reply_only" : "open",
      shared_retention_days: retention > 0 ? retention : null,
    },
    rate_limits:
      "Bursts are also limited per account per minute (wait, search, webhook tests): 429 rate_limited with Retry-After. Those counters are approximate and not listed here.",
    next_steps: [
      ...paused.map(
        (p) =>
          `${p.capability} is paused because ${p.reason}. The project's people were emailed; only the operator lifts it (the 403 capability_paused hint says how to appeal). Don't retry or work around it.`,
      ),
      ...(standing.claimed
        ? []
        : [
            "Nobody has claimed this account, so the lower unclaimed limits apply. POST /v1/claim-link (on the platform site) gives your person a link to claim it.",
          ]),
      "Every 429 carries Retry-After (seconds) and error.details.retry_after_s.",
    ],
  };
}
