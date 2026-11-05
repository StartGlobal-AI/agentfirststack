import { type AppEnv, type CapName, cap, standingOf } from "../env";
import { maxBlobBytes, nextUtcMidnight } from "./budgets";
import { deliveryCounts } from "./delivery";
import { maxEventsPerDay } from "./feed";
import { maxForwardsPerDay } from "./forward-settings";
import { attachmentTextPerDay } from "./attachment-text";
import { maxListEntries } from "./lists";
import { utcDay } from "./format";
import { maxInboundPerDay } from "./ingest";
import { dailyLimit, maxScheduled } from "./send";
import { DEFAULT_MAX_CONCURRENT_WAITS, DEFAULT_MAX_CONCURRENT_WAITS_PER_INBOX } from "./wait";
import { maxWebhooks } from "./webhooks";

/**
 * GET /v1/usage: every cap that applies to this account, with what it has used, the limit this
 * deployment configures for an account of its standing (UNCLAIMED_<name> until a person claims
 * it), and when daily budgets reset. Read before a 429, not after (rule 6). limit null = no cap.
 */

export interface UsageItem {
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
}

const num = (n: number) => (Number.isFinite(n) ? n : null);

function item(used: number | null, limit: number, unit: string, varName: string, resetsAt: number | null, note?: string): UsageItem {
  const l = num(limit);
  return {
    used,
    limit: l,
    remaining: l === null || used === null ? null : Math.max(0, l - used),
    resets_at: resetsAt,
    unit,
    var: varName,
    ...(note ? { note } : {}),
  };
}

export async function getUsage(env: AppEnv, accountId: string, opts: { days?: number } = {}, now = Date.now()) {
  const standing = await standingOf(env, accountId);
  const day = utcDay(now);
  const resets = nextUtcMidnight(now);
  const c = (name: CapName, fallback?: number) => cap(env, standing, name, fallback);
  const row = await env.DB.prepare(
    `SELECT
       (SELECT count FROM send_counters WHERE account_id = ?1 AND day = ?2) AS sends,
       (SELECT count FROM inbound_counters WHERE account_id = ?1 AND day = ?2) AS inbound,
       (SELECT MAX(count) FROM sender_counters WHERE account_id = ?1 AND day = ?2) AS top_sender,
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
  const v = (k: string) => row?.[k] ?? 0;
  const limits: Record<string, UsageItem> = {
    sends_per_day: item(v("sends"), dailyLimit(env, standing), "recipients (to + cc + bcc) sent", "SEND_DAILY_LIMIT", resets),
    forwards_per_day: item(
      v("forwards"),
      maxForwardsPerDay(env, standing),
      "emails forwarded to the project's members (one per member per forward or digest)",
      "MAX_FORWARDS_PER_ACCOUNT_PER_DAY",
      resets,
      "Inbox forwarding (forward on an inbox) has its own budget and never counts toward SEND_DAILY_LIMIT. Past it, forwarding each email pauses until 00:00 UTC and the rest goes into a digest.",
    ),
    inbound_per_day: item(
      v("inbound"),
      maxInboundPerDay(env, standing),
      "messages stored, across inboxes",
      "MAX_INBOUND_PER_ACCOUNT_PER_DAY",
      resets,
      "Mail beyond it is rejected at SMTP time; one sender gets at most half of it.",
    ),
    inbound_per_sender_per_day: item(
      v("top_sender"),
      c("MAX_INBOUND_PER_SENDER_PER_DAY"),
      "messages from one sender to one inbox (used = the busiest sender today)",
      "MAX_INBOUND_PER_SENDER_PER_DAY",
      resets,
    ),
    inbox_creates_per_day: item(v("inbox_creates"), c("MAX_INBOX_CREATES_PER_DAY"), "inboxes created", "MAX_INBOX_CREATES_PER_DAY", resets),
    inbox_deletes_per_day: item(
      v("inbox_deletes"),
      c("MAX_INBOX_DELETES_PER_DAY"),
      "inboxes deleted by API",
      "MAX_INBOX_DELETES_PER_DAY",
      resets,
    ),
    webhook_tests_per_day: item(
      v("webhook_tests"),
      c("MAX_WEBHOOK_TESTS_PER_DAY"),
      "test events sent",
      "MAX_WEBHOOK_TESTS_PER_DAY",
      resets,
    ),
    inboxes: item(v("inboxes"), c("MAX_INBOXES_PER_ACCOUNT"), "inboxes", "MAX_INBOXES_PER_ACCOUNT", null),
    messages_per_inbox: item(
      v("fullest_inbox"),
      c("MAX_MESSAGES_PER_INBOX"),
      "inbound messages one inbox holds (used = the fullest inbox)",
      "MAX_MESSAGES_PER_INBOX",
      null,
      "Beyond it the oldest mail of the sender holding the most is evicted.",
    ),
    webhooks: item(v("webhooks"), maxWebhooks(env, standing), "webhooks (disabled ones count)", "MAX_WEBHOOKS_PER_ACCOUNT", null),
    concurrent_waits: item(
      v("waits"),
      c("MAX_CONCURRENT_WAITS", DEFAULT_MAX_CONCURRENT_WAITS),
      "blocking calls parked at once (wait, latest-code, events, delivery)",
      "MAX_CONCURRENT_WAITS",
      null,
    ),
    concurrent_waits_per_inbox: item(
      null,
      c("MAX_CONCURRENT_WAITS_PER_INBOX", DEFAULT_MAX_CONCURRENT_WAITS_PER_INBOX),
      "blocking calls parked at once on one inbox",
      "MAX_CONCURRENT_WAITS_PER_INBOX",
      null,
    ),
    storage_bytes: item(
      v("blob_bytes"),
      maxBlobBytes(env, standing),
      "bytes of mail kept (raw messages, HTML bodies, sent attachments)",
      "MAX_BLOB_BYTES_PER_ACCOUNT",
      null,
      "When full, new mail is rejected (Mailbox full) until old mail is deleted.",
    ),
    text_bytes: item(
      v("text_bytes"),
      c("MAX_TEXT_BYTES_PER_ACCOUNT"),
      "bytes of stored text (bodies, reply text, links)",
      "MAX_TEXT_BYTES_PER_ACCOUNT",
      null,
      "Beyond it new mail keeps a 2 KB excerpt.",
    ),
    list_entries: item(
      v("list_entries"),
      maxListEntries(env, standing),
      "allow / block list entries",
      "MAX_LIST_ENTRIES_PER_ACCOUNT",
      null,
    ),
    events_per_day: item(
      v("events"),
      maxEventsPerDay(env, standing),
      "events kept in the feed (GET /v1/events)",
      "MAX_FEED_EVENTS_PER_DAY",
      resets,
      "Beyond it events are not kept in the feed; webhooks still get them.",
    ),
    inbox_clears_per_day: item(
      v("inbox_clears"),
      c("MAX_INBOX_CLEARS_PER_DAY"),
      "DELETE /v1/inboxes/:id/messages calls",
      "MAX_INBOX_CLEARS_PER_DAY",
      resets,
    ),
    scheduled: item(v("scheduled"), maxScheduled(env, standing), "scheduled sends waiting to go out", "MAX_SCHEDULED_PER_ACCOUNT", null),
    attachment_text_per_day: item(
      v("attachment_text"),
      env.AI ? attachmentTextPerDay(env, standing) : 0,
      "attachments converted to text",
      "MAX_ATTACHMENT_TEXT_PER_DAY",
      resets,
      env.AI ? undefined : "Not available on this deployment (no Workers AI binding).",
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
    policy: {
      shared_send_policy: env.SHARED_SEND_POLICY === "reply_only" ? "reply_only" : "open",
      shared_retention_days: retention > 0 ? retention : null,
    },
    rate_limits:
      "Bursts are also limited per account per minute (wait, search, webhook tests): 429 rate_limited with Retry-After. Those counters are approximate and not listed here.",
    next_steps: [
      ...(standing.claimed
        ? []
        : [
            "Nobody has claimed this account, so the lower unclaimed limits apply. POST /v1/claim-link (on the platform site) gives your person a link to claim it.",
          ]),
      "Every 429 carries Retry-After (seconds) and error.details.retry_after_s.",
    ],
  };
}
