/**
 * Per-account daily budgets for expensive work every site of the deployment shares (SQL wall time
 * in the site Durable Objects, raw exports), summed over the account's sites in D1
 * (account_usage_daily), so one account with many sites can't take more than its share:
 *
 *   MAX_SQL_MS_PER_ACCOUNT_PER_DAY       SQL wall time (ms) per UTC day, on top of each site's
 *                                        SQL_TIME_BUDGET_MS per 10 minutes
 *   MAX_EXPORT_ROWS_PER_ACCOUNT_PER_DAY  raw rows exported per UTC day, on top of each site's
 *                                        MAX_EXPORT_ROWS_PER_SITE_PER_DAY
 *
 * Both read an UNCLAIMED_ form first (capFor) and are off when unset. The counters only go up; a
 * concurrent call can overshoot by one query or one page. A D1 error fails open (logged).
 */

import { ApiError, accountStanding, capFor } from "@afs/shared";
import type { Bindings } from "../env";

export type AccountBudgetKind = "sql_ms" | "export_rows";

const VAR: Record<AccountBudgetKind, string> = {
  sql_ms: "MAX_SQL_MS_PER_ACCOUNT_PER_DAY",
  export_rows: "MAX_EXPORT_ROWS_PER_ACCOUNT_PER_DAY",
};

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export interface AccountBudget {
  kind: AccountBudgetKind;
  /** Infinity = no cap */
  limit: number;
  used: number;
  /** limit - used, never below 0 (Infinity without a cap) */
  left: number;
  day: string;
}

/** The account's cap and today's use of one budget (no D1 read without a cap). */
export async function accountBudget(env: Bindings, accountId: string, kind: AccountBudgetKind, now = Date.now()): Promise<AccountBudget> {
  const day = utcDay(now);
  const limit = capFor(
    env as unknown as Record<string, unknown>,
    await accountStanding(env, accountId),
    VAR[kind],
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(limit)) return { kind, limit, used: 0, left: Number.POSITIVE_INFINITY, day };
  let used = 0;
  try {
    const r = await env.DB.prepare("SELECT amount FROM account_usage_daily WHERE account_id = ? AND day = ? AND kind = ?")
      .bind(accountId, day, kind)
      .first<{ amount: number }>();
    used = Number(r?.amount ?? 0);
  } catch (e) {
    console.error("account budget unreadable", kind, e);
  }
  return { kind, limit, used, left: Math.max(0, limit - used), day };
}

/** Add `amount` to today's counter (only when the budget has a cap: nothing to count otherwise). */
export async function chargeAccount(env: Bindings, b: AccountBudget, accountId: string, amount: number): Promise<void> {
  if (!Number.isFinite(b.limit) || !(amount > 0)) return;
  await env.DB.prepare(
    `INSERT INTO account_usage_daily (account_id, day, kind, amount, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, day, kind) DO UPDATE SET amount = amount + excluded.amount, updated_at = excluded.updated_at`,
  )
    .bind(accountId, b.day, b.kind, Math.ceil(amount), Date.now())
    .run()
    .catch((e) => console.error("account budget not charged", b.kind, e));
}

/** The 429 for a used-up account budget. */
export function accountBudgetExhausted(b: AccountBudget): ApiError {
  const what = b.kind === "sql_ms" ? `${Math.round(b.limit / 1000)} s of SQL time` : `${b.limit} exported rows`;
  return new ApiError(
    429,
    b.kind === "sql_ms" ? "sql_budget_exhausted" : "daily_limit",
    `This account used its ${what} for today, summed over its sites.`,
    b.kind === "sql_ms"
      ? `It resets at 00:00 UTC (${VAR[b.kind]}). Meanwhile use GET /v1/sites/:id/stats, breakdown and timeseries, which don't count.`
      : `Exports continue after 00:00 UTC (${VAR[b.kind]}); the cursor stays valid.`,
    { var: VAR[b.kind], limit: b.limit, used: b.used },
  );
}

/** Cron: forget counters older than 40 days. */
export async function purgeAccountUsage(env: Bindings, now: number): Promise<number> {
  const r = await env.DB.prepare("DELETE FROM account_usage_daily WHERE day < ?")
    .bind(utcDay(now - 40 * 86_400_000))
    .run();
  return r.meta.changes ?? 0;
}
