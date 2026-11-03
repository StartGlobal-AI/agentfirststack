import type { AuthContext } from "@afs/shared";

/**
 * Bindings come from the generated worker-configuration.d.ts (`pnpm types`). Secrets and optional
 * vars are not in wrangler.jsonc, so they are declared here.
 */
export type AppEnv = Omit<Env, "MAIL_DOMAIN" | "SEND_DAILY_LIMIT" | "WORKER_NAME" | "SIGNUP_MODE" | "PUBLIC_BASE_URL" | "INBOX"> & {
  INBOX: DurableObjectNamespace<import("./inbox-do").InboxDO>;
  MAIL_DOMAIN: string;
  SEND_DAILY_LIMIT?: string;
  WORKER_NAME?: string;
  SIGNUP_MODE?: string;
  PUBLIC_BASE_URL?: string;
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
   * Hosted-platform abuse controls (all optional; unset = off unless a default is given):
   *   SHARED_SEND_POLICY       "reply_only": shared-domain inboxes may only send to addresses
   *                            that have emailed that inbox with authenticated, From-aligned mail
   *                            (auth.verdict "pass"). Custom domains are unaffected.
   *   SHARED_RETENTION_DAYS    delete shared-domain messages older than this (hourly cron).
   *   MAX_INBOXES_PER_ACCOUNT  cap on inboxes per account.
   *   EXTRA_RESERVED_USERNAMES comma-separated local parts nobody may claim on the shared domain
   *                            (brand and role names of the operator: hello, billing, ...).
   *   MAX_MESSAGES_PER_INBOX   inbound messages an inbox may hold; email() rejects more.
   *   MAX_INBOUND_PER_ACCOUNT_PER_DAY  inbound messages an account may receive per UTC day.
   *   MAX_WEBHOOKS_PER_ACCOUNT webhooks per account (default 10).
   */
  SHARED_SEND_POLICY?: string;
  SHARED_RETENTION_DAYS?: string;
  MAX_INBOXES_PER_ACCOUNT?: string;
  EXTRA_RESERVED_USERNAMES?: string;
  MAX_MESSAGES_PER_INBOX?: string;
  MAX_INBOUND_PER_ACCOUNT_PER_DAY?: string;
  MAX_WEBHOOKS_PER_ACCOUNT?: string;
};

/** A positive integer var, or `fallback` when unset, empty, zero or not a number. */
export function positiveIntVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export type AppHono = { Bindings: AppEnv; Variables: { auth: AuthContext } };

export interface WebhookJob {
  delivery_id: string;
  webhook_id: string;
  event: WebhookEvent;
}

export interface WebhookEvent {
  id: string;
  type: "message.received" | "webhook.test";
  created_at: number;
  data: Record<string, unknown>;
}
