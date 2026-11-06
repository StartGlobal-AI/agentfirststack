import { type AuthContext, type Standing, accountStanding, capFor } from "@afs/shared";

/**
 * Bindings come from the generated worker-configuration.d.ts (`pnpm types`). Secrets and optional
 * vars are not in wrangler.jsonc, so they are declared here.
 */
export type AppEnv = Omit<
  Env,
  | "MAIL_DOMAIN"
  | "SEND_DAILY_LIMIT"
  | "WORKER_NAME"
  | "SIGNUP_MODE"
  | "PUBLIC_BASE_URL"
  | "DEV_MODE"
  | "INBOX"
  | "SITE"
  | "WAIT_LIMITER"
  | "WEBHOOK_TEST_LIMITER"
  | "SEARCH_LIMITER"
> & {
  INBOX: DurableObjectNamespace<import("./inbox-do").InboxDO>;
  /**
   * Optional service binding to the platform's site (wrangler.jsonc): capability pauses are posted
   * to https://site.internal/v1/internal/pauses so the project's people and the operator are
   * emailed at once. Without it the pause is written to AUTH_DB directly (the site's cron emails).
   */
  SITE?: Fetcher;
  /** Optional Workers rate-limit bindings (wrangler.jsonc); a deployment without them skips the check. */
  WAIT_LIMITER?: RateLimit;
  WEBHOOK_TEST_LIMITER?: RateLimit;
  SEARCH_LIMITER?: RateLimit;
  MAIL_DOMAIN: string;
  SEND_DAILY_LIMIT?: string;
  WORKER_NAME?: string;
  SIGNUP_MODE?: string;
  PUBLIC_BASE_URL?: string;
  /** The OAuth authorization server (the platform's site), e.g. https://example.com. */
  AUTH_ISSUER?: string;
  /** "true" only locally: webhooks may use http://localhost. */
  DEV_MODE?: string;
  SIGNUP_TOKEN?: string;
  /**
   * Operator secret. Also authorises `auto_configure` / `force` on domains (request header
   * `x-admin-token`), and is the fallback key for custom-domain ownership challenges.
   */
  ADMIN_TOKEN?: string;
  /** 32-byte base64 key; seals webhook secrets at rest and keys custom-domain ownership challenges. */
  ENCRYPTION_KEY?: string;
  /** Optional: lets POST /v1/domains {auto_configure:true} (operator only) set up zones in the operator's account. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /**
   * Hosted-platform abuse controls (all optional; unset = off unless a default is given). Every
   * per-account cap and daily budget also reads `UNCLAIMED_<NAME>` for accounts no person has
   * claimed yet (capFor in @afs/shared); "0" means none allowed.
   *   SHARED_SEND_POLICY       "reply_only": shared-domain inboxes may only send to addresses
   *                            that have emailed that inbox with authenticated, From-aligned mail
   *                            (auth.verdict "pass") that was not list, bulk or auto-generated mail.
   *   SHARED_RETENTION_DAYS    delete shared-domain messages older than this (hourly cron).
   *   MAX_INBOXES_PER_ACCOUNT  cap on inboxes per account.
   *   MAX_INBOX_CREATES_PER_DAY / MAX_INBOX_DELETES_PER_DAY  inbox creations / API deletions per
   *                            account per UTC day.
   *   EXTRA_RESERVED_USERNAMES comma-separated local parts nobody may claim on the shared domain,
   *                            on top of the built-in role names (the operator's brand names).
   *                            Inboxes created before a name was reserved are listed by the cron
   *                            and GET /v1/admin/reserved-inboxes, never deleted.
   *   MAX_MESSAGES_PER_INBOX   inbound messages an inbox holds; beyond it the oldest mail of the
   *                            sender holding the most is evicted.
   *   MAX_INBOUND_PER_ACCOUNT_PER_DAY  inbound messages an account may receive per UTC day.
   *   MAX_INBOUND_PER_SENDER_PER_DAY   inbound messages one sender may send one inbox per UTC day.
   *   MAX_INBOUND_BYTES_PER_SENDER_PER_DAY  bytes of raw mail one sender may send the account
   *                            (all its inboxes) per UTC day; more from that sender is rejected.
   *   MAX_INBOUND_MESSAGE_BYTES        largest inbound message accepted, in bytes (default 25 MiB,
   *                            Email Routing's limit and the most it can be; 10 MiB for unclaimed
   *                            accounts; "0" = 25 MiB).
   *   MAX_TEXT_BYTES_PER_ACCOUNT       stored text (bodies + links) per account; beyond it new
   *                            mail keeps only a short excerpt in D1.
   *   MAX_BLOB_BYTES_PER_ACCOUNT       bytes of mail an account keeps in R2 (raw MIME, HTML bodies,
   *                            sent attachments); beyond it inbound mail is rejected ("Mailbox
   *                            full") and sent mail keeps no HTML/attachment copy. Default 1 GiB
   *                            (256 MiB for unclaimed accounts); "0" turns it off.
   *   MAX_CONCURRENT_WAITS     parked waits per account (default 3).
   *   MAX_CONCURRENT_WAITS_PER_INBOX   parked waits per inbox (default 2).
   *   MAX_WEBHOOKS_PER_ACCOUNT webhooks per account (default 10).
   *   MAX_WEBHOOK_TESTS_PER_DAY        POST /webhooks/:id/test calls per account per UTC day.
   *   MAX_FEED_EVENTS_PER_DAY       events kept in the feed (GET /v1/events) per account per UTC day
   *                            (default 5000, 1000 unclaimed); webhooks still fire beyond it.
   *   MAX_LIST_ENTRIES_PER_ACCOUNT     allow / block list entries per account (default 100).
   *   MAX_INBOX_CLEARS_PER_DAY DELETE /v1/inboxes/:id/messages calls per account per UTC day.
   *   MAX_SCHEDULED_PER_ACCOUNT        scheduled sends waiting at once (default 20, 5 unclaimed).
   *   MAX_ATTACHMENT_TEXT_PER_DAY      attachment-to-text conversions per account per UTC day
   *                            (default 20, 5 unclaimed; needs the AI binding).
   *   DELIVERY_EVENTS_QUEUE    name of the queue the Email Sending event subscriptions publish to
   *                            (this Worker consumes it). Set = delivery tracking is on. See README.
   *   MAX_FORWARDS_PER_ACCOUNT_PER_DAY  emails forwarded to the project's members (forwards and
   *                            digests, counted per recipient) per account per UTC day (default 100;
   *                            "0" = forwarding off). Never counts toward SEND_DAILY_LIMIT.
   * Automatic capability pauses (src/service/pauses.ts; recorded through @afs/shared, lifted only by
   * the operator). Each also reads UNCLAIMED_<name>; unset or "0" = that signal is off.
   *   SEND_PAUSE_BOUNCE_PERCENT / SEND_PAUSE_COMPLAINT_PERCENT  pause mail.send when more than this
   *                            percent of the external recipients the account sent to in the last
   *                            hour bounced / complained (Email Sending delivery events).
   *   SEND_PAUSE_MIN_SENDS     recipients the last hour must have before those rates count (default 10).
   *   INBOX_CREATE_BURST_PER_HOUR  pause mail.inbox_create when the account tries to create more new
   *                            inboxes than this in one UTC hour (refused attempts count too). Unset =
   *                            3 x MAX_INBOX_CREATES_PER_DAY when that is set, else off.
   */
  SHARED_SEND_POLICY?: string;
  SHARED_RETENTION_DAYS?: string;
  MAX_INBOXES_PER_ACCOUNT?: string;
  MAX_INBOX_CREATES_PER_DAY?: string;
  MAX_INBOX_DELETES_PER_DAY?: string;
  EXTRA_RESERVED_USERNAMES?: string;
  MAX_MESSAGES_PER_INBOX?: string;
  MAX_INBOUND_PER_ACCOUNT_PER_DAY?: string;
  MAX_INBOUND_PER_SENDER_PER_DAY?: string;
  MAX_INBOUND_BYTES_PER_SENDER_PER_DAY?: string;
  MAX_INBOUND_MESSAGE_BYTES?: string;
  MAX_TEXT_BYTES_PER_ACCOUNT?: string;
  MAX_BLOB_BYTES_PER_ACCOUNT?: string;
  MAX_CONCURRENT_WAITS?: string;
  MAX_CONCURRENT_WAITS_PER_INBOX?: string;
  MAX_WEBHOOKS_PER_ACCOUNT?: string;
  MAX_WEBHOOK_TESTS_PER_DAY?: string;
  MAX_FEED_EVENTS_PER_DAY?: string;
  MAX_LIST_ENTRIES_PER_ACCOUNT?: string;
  MAX_INBOX_CLEARS_PER_DAY?: string;
  MAX_SCHEDULED_PER_ACCOUNT?: string;
  MAX_ATTACHMENT_TEXT_PER_DAY?: string;
  DELIVERY_EVENTS_QUEUE?: string;
  MAX_FORWARDS_PER_ACCOUNT_PER_DAY?: string;
  SEND_PAUSE_BOUNCE_PERCENT?: string;
  SEND_PAUSE_COMPLAINT_PERCENT?: string;
  SEND_PAUSE_MIN_SENDS?: string;
  INBOX_CREATE_BURST_PER_HOUR?: string;
  /** Optional Workers AI binding (not in the template): attachment text via toMarkdown. Without it that route answers 501. */
  AI?: Ai;
} & { [K in CapName as `UNCLAIMED_${K}`]?: string };

/** A positive integer var, or `fallback` when unset, empty, zero or not a number. */
export function positiveIntVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Names of the per-account caps and daily budgets (each also read as UNCLAIMED_<name>). */
export type CapName =
  | "SEND_DAILY_LIMIT"
  | "MAX_INBOXES_PER_ACCOUNT"
  | "MAX_INBOX_CREATES_PER_DAY"
  | "MAX_INBOX_DELETES_PER_DAY"
  | "MAX_MESSAGES_PER_INBOX"
  | "MAX_INBOUND_PER_ACCOUNT_PER_DAY"
  | "MAX_INBOUND_PER_SENDER_PER_DAY"
  | "MAX_INBOUND_BYTES_PER_SENDER_PER_DAY"
  | "MAX_INBOUND_MESSAGE_BYTES"
  | "MAX_TEXT_BYTES_PER_ACCOUNT"
  | "MAX_BLOB_BYTES_PER_ACCOUNT"
  | "MAX_CONCURRENT_WAITS"
  | "MAX_CONCURRENT_WAITS_PER_INBOX"
  | "MAX_WEBHOOKS_PER_ACCOUNT"
  | "MAX_WEBHOOK_TESTS_PER_DAY"
  | "MAX_FEED_EVENTS_PER_DAY"
  | "MAX_LIST_ENTRIES_PER_ACCOUNT"
  | "MAX_INBOX_CLEARS_PER_DAY"
  | "MAX_SCHEDULED_PER_ACCOUNT"
  | "MAX_ATTACHMENT_TEXT_PER_DAY"
  | "MAX_FORWARDS_PER_ACCOUNT_PER_DAY"
  | "SEND_PAUSE_BOUNCE_PERCENT"
  | "SEND_PAUSE_COMPLAINT_PERCENT"
  | "SEND_PAUSE_MIN_SENDS"
  | "INBOX_CREATE_BURST_PER_HOUR";

/**
 * A per-account cap for an account of this standing: `UNCLAIMED_<name>` for unclaimed accounts
 * when set, else `<name>`, else `fallback` (Infinity = no cap). Whole numbers; "0" = none allowed.
 */
export function cap(env: AppEnv, standing: Standing, name: CapName, fallback = Number.POSITIVE_INFINITY): number {
  const n = capFor(env as unknown as Record<string, unknown>, standing, name, fallback);
  return Number.isFinite(n) ? Math.floor(n) : n;
}

/** DEV_MODE=true: local development only. */
export const isDevMode = (env: { DEV_MODE?: unknown }) => String(env.DEV_MODE ?? "") === "true";

/** The account's standing (suspended / claimed), cached per isolate for a minute by @afs/shared. */
export const standingOf = (env: AppEnv, accountId: string): Promise<Standing> => accountStanding(env, accountId);

export type { Standing };

export type AppHono = { Bindings: AppEnv; Variables: { auth: AuthContext } };

export interface WebhookJob {
  delivery_id: string;
  webhook_id: string;
  event: WebhookEvent;
}

export type WebhookEventType =
  | "message.received"
  | "message.sent"
  | "message.delivered"
  | "message.bounced"
  | "message.complained"
  | "message.failed"
  | "message.forwarded"
  | "domain.verified"
  | "webhook.test";

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  created_at: number;
  data: Record<string, unknown>;
}
