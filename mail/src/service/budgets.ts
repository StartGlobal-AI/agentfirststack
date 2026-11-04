import { ApiError, accountSuspended } from "@afs/shared";
import { type AppEnv, type Standing, cap } from "../env";
import { utcDay } from "./format";

/** Kinds of per-account daily budget kept in `account_daily`. */
export type DailyKind = "inbox_create" | "inbox_delete" | "inbox_clear" | "webhook_test" | "event" | "attachment_text";

/** Seconds from `now` to the next 00:00 UTC, when every daily budget resets (at least 1). */
export function secondsToUtcMidnight(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

/** The next 00:00 UTC as unix ms. */
export function nextUtcMidnight(now = Date.now()): number {
  return now + secondsToUtcMidnight(now) * 1000;
}

/** Window of the Workers rate-limit bindings (wrangler.jsonc: period 60). */
export const RATE_LIMIT_PERIOD_S = 60;

/** MAX_BLOB_BYTES_PER_ACCOUNT defaults (claimed / unclaimed accounts). */
export const DEFAULT_MAX_BLOB_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_UNCLAIMED_MAX_BLOB_BYTES = 256 * 1024 * 1024;

/** Bytes of mail an account may keep in R2: MAX_BLOB_BYTES_PER_ACCOUNT (UNCLAIMED_ via capFor), "0" = no cap. */
export function maxBlobBytes(env: AppEnv, standing: Standing): number {
  const n = cap(env, standing, "MAX_BLOB_BYTES_PER_ACCOUNT", standing.claimed ? DEFAULT_MAX_BLOB_BYTES : DEFAULT_UNCLAIMED_MAX_BLOB_BYTES);
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

/** Bytes the account's current messages keep in R2 (kept by triggers in account_usage). */
export async function storedBlobBytes(env: AppEnv, accountId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT blob_bytes FROM account_usage WHERE account_id = ?")
    .bind(accountId)
    .first<{ blob_bytes: number }>();
  return row?.blob_bytes ?? 0;
}

/** Throws account_suspended (403) for a suspended account. */
export function assertActive(standing: Standing): void {
  if (standing.suspended) throw accountSuspended();
}

/**
 * Atomically take `n` from today's (UTC) budget of `kind`; false when that would pass `limit`.
 * Infinity = no budget (nothing is written).
 */
export async function reserveDaily(env: AppEnv, accountId: string, kind: DailyKind, limit: number, now = Date.now(), n = 1) {
  if (!Number.isFinite(limit)) return { ok: true as const, day: null as string | null, used: 0, limit };
  const day = utcDay(now);
  if (n > limit) return { ok: false as const, day, used: limit, limit };
  const row = await env.DB.prepare(
    `INSERT INTO account_daily (account_id, kind, day, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, kind, day) DO UPDATE SET count = account_daily.count + excluded.count
     WHERE account_daily.count + excluded.count <= ? RETURNING count`,
  )
    .bind(accountId, kind, day, n, limit)
    .first<{ count: number }>();
  return row ? { ok: true as const, day, used: row.count, limit } : { ok: false as const, day, used: limit, limit };
}

export async function refundDaily(env: AppEnv, accountId: string, kind: DailyKind, day: string | null, n = 1) {
  if (!day) return;
  await env.DB.prepare("UPDATE account_daily SET count = MAX(0, count - ?) WHERE account_id = ? AND kind = ? AND day = ?")
    .bind(n, accountId, kind, day)
    .run();
}

/** 429 daily_limit with a hint. */
export function dailyLimitError(what: string, limit: number, hint: string, details: Record<string, unknown> = {}) {
  return new ApiError(
    429,
    "daily_limit",
    `Daily limit reached: ${what} (${limit} per UTC day).`,
    `${hint} The budget resets at 00:00 UTC.`,
    {
      limit,
      retry_after_s: secondsToUtcMidnight(),
      ...details,
    },
  );
}

/**
 * A Workers rate-limit binding check keyed by account (approximate, per Cloudflare location).
 * Deployments without the binding skip it. Throws 429 rate_limited with `hint`.
 */
export async function rateLimit(limiter: RateLimit | undefined, key: string, what: string, hint: string): Promise<void> {
  if (!limiter) return;
  let ok = true;
  try {
    ok = (await limiter.limit({ key })).success;
  } catch (e) {
    console.error("rate limiter failed", e);
    return; // fail open: the D1 caps still apply
  }
  if (!ok)
    throw new ApiError(429, "rate_limited", `Too many ${what} requests from this account.`, hint, { retry_after_s: RATE_LIMIT_PERIOD_S });
}
