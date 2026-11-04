import { ApiError, type Standing } from "@afs/shared";
import { deliveryBudgets, utcDay } from "./limits";

/**
 * Daily delivery budgets across containers: per account (MAX_DELIVERIES_PER_ACCOUNT_PER_DAY) and
 * for the whole platform (MAX_DELIVERIES_PER_DAY; unclaimed accounts stop at the lower
 * UNCLAIMED_MAX_DELIVERIES_PER_DAY on the same counter). Counted in D1 `delivery_usage` per UTC
 * day. Counters only go up: deleting containers, destinations or events gives nothing back, and
 * a refused request still counts. No cap set = no D1 call at all.
 */
export interface Reservation {
  granted: number;
  /** Why fewer than requested were granted (for the event log). */
  reason?: string;
}

export async function reserveDeliveries(
  env: { DB: D1Database } & object,
  accountId: string,
  standing: Standing,
  requested: number,
  now = Date.now(),
): Promise<Reservation> {
  if (requested <= 0) return { granted: 0 };
  const caps = deliveryBudgets(env, standing);
  const scopes: { scope: string; label: string; cap: number }[] = [];
  if (Number.isFinite(caps.perAccount)) scopes.push({ scope: `account:${accountId}`, label: "account", cap: caps.perAccount });
  if (Number.isFinite(caps.platform)) scopes.push({ scope: "platform", label: "platform-wide", cap: caps.platform });
  if (!scopes.length) return { granted: requested };
  const day = utcDay(now);
  try {
    const res = await env.DB.batch<{ n: number }>(
      scopes.map((s) =>
        env.DB.prepare(
          "INSERT INTO delivery_usage (scope, day, n) VALUES (?1, ?2, ?3) ON CONFLICT(scope, day) DO UPDATE SET n = n + ?3 RETURNING n",
        ).bind(s.scope, day, requested),
      ),
    );
    // No cron in this app: now and then, drop counters older than a week.
    if (Math.random() < 0.001)
      await env.DB.prepare("DELETE FROM delivery_usage WHERE day < ?")
        .bind(utcDay(now - 7 * 86_400_000))
        .run()
        .catch(() => undefined);
    let granted = requested;
    let reason: string | undefined;
    res.forEach((r, i) => {
      const s = scopes[i]!;
      const before = (r.results[0]?.n ?? requested) - requested;
      const left = Math.max(0, Math.min(requested, s.cap - before));
      if (left < granted) {
        granted = left;
        reason = `${s.label} daily delivery budget (${s.cap}) reached; deliveries resume at 00:00 UTC`;
      }
    });
    return { granted, reason };
  } catch (e) {
    // Fail open: a D1 hiccup must not drop real conversions (the per-container budget still applies).
    console.error("delivery budget check failed", e);
    return { granted: requested };
  }
}

// ------------------------------------------------------------------ daily event budgets

/** Events of one UTC day: browser hits and backend events, counted (and capped) separately. */
export interface EventCounts {
  browser: number;
  server: number;
}
export const NO_EVENTS: EventCounts = { browser: 0, server: 0 };

/** Which daily event cap refused: the container's own, the account's, or the platform's. */
export type EventScope = "container" | "account" | "platform";

/**
 * Daily event budgets across containers: per account (MAX_EVENTS_PER_ACCOUNT_PER_DAY) and for the
 * whole platform (MAX_EVENTS_PER_DAY; unclaimed accounts stop at the lower
 * UNCLAIMED_MAX_EVENTS_PER_DAY on the same counter). A D1 write per event would cost too much, so
 * each ContainerDO counts its own events and calls this at most once a minute (or after enough
 * new ones): its absolute, non-decreasing counts for the day go into D1 `usage_daily` (MAX, so a
 * repeated report is harmless), `usage_global` grows by `delta` (the events since its last report),
 * and the account's and the platform's totals come back. Rows of deleted containers stay, so
 * deleting and re-creating a container frees nothing. Returns null when D1 fails: the caller keeps
 * its last totals (fail open; the per-container quota still applies).
 */
export async function reportEventUsage(
  db: D1Database,
  r: { containerId: string; accountId: string; day: string; local: EventCounts; delta: EventCounts; now: number },
): Promise<{ account: EventCounts; platform: EventCounts } | null> {
  try {
    const res = await db.batch<{ browser: number; server: number }>([
      db
        .prepare(
          `INSERT INTO usage_daily (container_id, account_id, day, browser_events, server_events, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(container_id, day) DO UPDATE SET browser_events = MAX(browser_events, excluded.browser_events),
             server_events = MAX(server_events, excluded.server_events), updated_at = excluded.updated_at`,
        )
        .bind(r.containerId, r.accountId, r.day, r.local.browser, r.local.server, r.now),
      db
        .prepare(
          `INSERT INTO usage_global (day, browser_events, server_events, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET browser_events = browser_events + excluded.browser_events,
             server_events = server_events + excluded.server_events, updated_at = excluded.updated_at`,
        )
        .bind(r.day, r.delta.browser, r.delta.server, r.now),
      db
        .prepare(
          "SELECT COALESCE(SUM(browser_events), 0) AS browser, COALESCE(SUM(server_events), 0) AS server FROM usage_daily WHERE account_id = ? AND day = ?",
        )
        .bind(r.accountId, r.day),
      db.prepare("SELECT browser_events AS browser, server_events AS server FROM usage_global WHERE day = ?").bind(r.day),
    ]);
    // No cron in this app: now and then, drop counters older than a week (deleted containers' too).
    if (Math.random() < 0.001) {
      const old = utcDay(r.now - 7 * 86_400_000);
      await db
        .batch([
          db.prepare("DELETE FROM usage_daily WHERE day < ?").bind(old),
          db.prepare("DELETE FROM usage_global WHERE day < ?").bind(old),
        ])
        .catch(() => undefined);
    }
    const counts = (row: { browser: number; server: number } | undefined): EventCounts => ({
      browser: Number(row?.browser ?? 0),
      server: Number(row?.server ?? 0),
    });
    return { account: counts(res[2]?.results[0]), platform: counts(res[3]?.results[0]) };
  } catch (e) {
    // D1 unavailable (or not migrated yet): fail open, the ContainerDO tries again in a minute.
    console.error("event usage report failed", e);
    return null;
  }
}

/**
 * The answer when a daily event cap refuses a /collect hit (`browser`) or a batch of backend events
 * (`server`): 429 quota_exceeded for every scope, saying when it resets. `used` is the count so far
 * today for backend events (they're refused per batch). The platform's answers carry no numbers:
 * they'd tell anyone the whole deployment's traffic.
 */
export function eventQuotaError(
  env: { AUTH_ISSUER?: string },
  r: { scope: EventScope; kind: keyof EventCounts; limit: number; used?: number },
): ApiError {
  const claim = env.AUTH_ISSUER
    ? ` Accounts a person has claimed (POST ${env.AUTH_ISSUER.replace(/\/$/, "")}/v1/claim-link) may get higher limits.`
    : "";
  const selfHost = "or self-host (the code is open source, see /llms.txt)";
  if (r.kind === "browser") {
    const other = "Backend events (POST /v1/containers/:id/events) have their own daily";
    switch (r.scope) {
      case "container":
        return new ApiError(
          429,
          "quota_exceeded",
          `This container received its ${r.limit} browser events for today; hits are dropped until 00:00 UTC.`,
          `GET /v1/containers/:id shows stats.today. ${other} quota.`,
        );
      case "account":
        return new ApiError(
          429,
          "quota_exceeded",
          `This account received its ${r.limit} browser events for today across its containers; hits are dropped until 00:00 UTC.`,
          `GET /v1/containers/:id shows stats.today.account and stats.limits; deleting containers frees nothing. ${other} budget.${claim}`,
        );
      case "platform":
        return new ApiError(
          429,
          "quota_exceeded",
          "This service's daily budget of browser events is reached; hits are dropped until 00:00 UTC.",
          `Retry after 00:00 UTC, ${selfHost}. ${other} budget.${claim}`,
        );
    }
  }
  const left = Math.max(0, r.limit - (r.used ?? 0));
  const retry = "Send fewer (or smaller batches) and retry after 00:00 UTC.";
  switch (r.scope) {
    case "container":
      return new ApiError(
        429,
        "quota_exceeded",
        `This container accepts ${r.limit} backend events per UTC day; ${left} are left today.`,
        `${retry} GET /v1/containers/:id shows stats.today.`,
      );
    case "account":
      return new ApiError(
        429,
        "quota_exceeded",
        `This account accepts ${r.limit} backend events per UTC day across its containers; ${left} are left today.`,
        `${retry} GET /v1/containers/:id shows stats.today.account; deleting containers frees nothing.${claim}`,
      );
    case "platform":
      return new ApiError(
        429,
        "quota_exceeded",
        "This service's daily budget of backend events is reached (or this batch would pass it); events are refused until 00:00 UTC.",
        `Send a smaller batch, retry after 00:00 UTC, ${selfHost}.${claim}`,
      );
  }
}
