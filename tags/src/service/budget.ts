import type { Standing } from "@afs/shared";
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
