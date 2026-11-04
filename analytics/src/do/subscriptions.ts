/**
 * Subscriptions in the site's Durable Object: the latest state of each (subscriptions) and every
 * MRR movement between states (subscription_changes), so MRR at any past moment is the sum of each
 * subscription's last movement before it. Each subscription carries the attribution of the session
 * it was linked to (like payments: session, visitor, user, then the customer's earlier link), so
 * MRR splits by acquisition channel, source and campaign.
 *
 * A subscription seen for the first time (a backfilled Stripe object, a webhook for an older
 * subscription, the API) has no history here: it is reconstructed from its dates (trial start,
 * start or trial end, cancellation / end) at its current price.
 */

import { newId } from "@afs/shared";
import {
  type BillingInterval,
  type Change,
  type SubStatus,
  type SubscriptionInput,
  monthlyAmount,
  mrrCounts,
  roundMoney,
  snapInterval,
  transitions,
} from "../lib/subscriptions";
import { buckets } from "../lib/time";
import type { Interval } from "../lib/time";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { type Db, type Row, all, guard, num, periodOut, rangeFor, round } from "./common";
import { resolve } from "./payments";
import { sql, raw } from "../lib/query";

export const SUBSCRIPTION_DIMS = ["channel", "source", "utm_source", "utm_medium", "utm_campaign", "referrer", "country", "plan"] as const;
export type SubscriptionDim = (typeof SUBSCRIPTION_DIMS)[number];
const DIM_FROM_SESSION = ["channel", "source", "utm_source", "utm_medium", "utm_campaign", "referrer", "country"] as const;

export { SUBSCRIPTIONS_SQL } from "./subscriptions-schema";

export interface SubscriptionOutcome {
  ok: boolean;
  id?: string;
  existing?: boolean;
  changed?: boolean;
  stale?: boolean;
  linked_by?: string | null;
  changes?: string[];
  reason?: string;
}

/**
 * The history of a subscription seen for the first time, from its own dates: trial start, trial end
 * (converted, or canceled when it ended inside the trial), the first paid month (new, at its price),
 * then the move to its state now (churn at its end, or expansion / contraction now). Approximate for
 * subscriptions that changed price before we saw them: the price is today's.
 */
export function snapshotHistory(p: SubscriptionInput & { price_mrr: number }): (Change & { ts: number })[] {
  const out: (Change & { ts: number })[] = [];
  const price = p.price_mrr;
  const trialEnd = p.trial_end ?? null;
  const end = p.ended_at ?? (p.status === "canceled" || p.status === "incomplete_expired" ? (p.canceled_at ?? p.ts) : null);
  if (p.trial_start != null || trialEnd != null || p.status === "trialing")
    out.push({ kind: "trial_start", mrr_before: 0, mrr_after: 0, ts: p.trial_start ?? p.started_at ?? p.ts });
  if (p.status === "trialing") return out;
  if (trialEnd != null && end != null && end <= trialEnd) {
    out.push({ kind: "trial_canceled", mrr_before: 0, mrr_after: 0, ts: end });
    return out;
  }
  if (p.status === "incomplete" || p.status === "incomplete_expired") return out;
  if (trialEnd != null) out.push({ kind: "trial_converted", mrr_before: 0, mrr_after: 0, ts: trialEnd });
  if (price <= 0) return out;
  const paidFrom = trialEnd ?? p.started_at ?? p.ts;
  out.push({ kind: "new", mrr_before: 0, mrr_after: price, ts: paidFrom });
  if (p.mrr === 0) out.push({ kind: "churn", mrr_before: price, mrr_after: 0, ts: Math.max(paidFrom, end ?? p.ts) });
  else if (p.mrr !== price)
    out.push({ kind: p.mrr > price ? "expansion" : "contraction", mrr_before: price, mrr_after: p.mrr, ts: Math.max(paidFrom, p.ts) });
  return out;
}

/** A subscription state (or a paid invoice) for the DO; see do/site-do.ts SubscriptionRecord. */
export type SubscriptionRecord = SubscriptionInput & {
  price_mrr?: number;
  original_mrr?: number | null;
  original_currency?: string | null;
  fx_rate?: number | null;
  /** invoice: a paid period (period_amount at ts) of a provider whose objects carry no price */
  kind?: "state" | "invoice";
  /** the provider's state has no price: keep (or infer) the stored one */
  price_unknown?: boolean;
  /** what one billing period costs (invoice kind), before tax, after discounts */
  period_amount?: number | null;
  /** the end of the current billing period (renews_at) */
  period_end?: number | null;
  /** canceled but paying until the period ends: active with cancel_at_period_end, or a canceled trial */
  grace?: boolean;
  /** the site currency to convert to, at fx_rate (the day's ECB rate, from the Worker) */
  fx_to?: string | null;
  fx_day?: string | null;
  fx_fallback?: boolean;
};

/**
 * Converted to the site currency at the rate the subscription was first converted with (same
 * original currency), else the day's: exchange-rate moves are never expansion or contraction.
 */
function withFx(cur: Row | undefined, r: SubscriptionRecord): SubscriptionRecord {
  if (!r.fx_to || !r.fx_rate || !r.currency) return r;
  const rate = cur?.fx_rate && cur.original_currency === r.currency ? num(cur.fx_rate) : r.fx_rate;
  const conv = (x: number) => roundMoney(x * rate);
  return {
    ...r,
    original_currency: r.currency,
    currency: r.fx_to,
    mrr: conv(r.mrr),
    ...(r.price_mrr != null ? { price_mrr: conv(r.price_mrr) } : {}),
    ...(r.period_amount != null ? { period_amount: conv(r.period_amount) } : {}),
    fx_rate: rate,
  };
}

const DAY_MS = 86_400_000;

interface Prepared {
  p: SubscriptionRecord & { price_mrr: number };
  /** the state_ts to store (an invoice doesn't move it: lifecycle comes from state events) */
  stateTs: number;
  extra: { period_amount: number | null; last_paid_at: number | null; current_period_end: number | null };
  stale: boolean;
}

/** A record as a full state, given the stored row: invoices, unknown prices and grace periods resolved. */
function prepare(cur: Row | undefined, input: SubscriptionRecord): Prepared {
  const r = withFx(cur, input);
  const curInterval = cur?.interval ? { interval: cur.interval as BillingInterval, count: num(cur.interval_count) || 1 } : null;
  const extra = {
    period_amount: (cur?.period_amount as number | null) ?? null,
    last_paid_at: (cur?.last_paid_at as number | null) ?? null,
    current_period_end: r.period_end ?? (cur?.current_period_end as number | null) ?? null,
  };
  const fromCur = (k: keyof SubscriptionInput) => (cur ? ((cur[k] as never) ?? null) : null);
  if (r.kind === "invoice") {
    const paidAt = r.ts;
    const last = extra.last_paid_at;
    if (last != null && last >= paidAt)
      return { p: { ...r, price_mrr: num(cur?.price_mrr) }, stateTs: num(cur?.state_ts), extra, stale: true };
    const days =
      last != null && paidAt - last > DAY_MS / 2
        ? (paidAt - last) / DAY_MS
        : extra.current_period_end != null && extra.current_period_end - paidAt > DAY_MS / 2
          ? (extra.current_period_end - paidAt) / DAY_MS
          : null;
    const iv = snapInterval(days) ?? curInterval;
    const amount = r.period_amount ?? 0;
    const price = iv ? roundMoney(monthlyAmount(amount, iv.interval, iv.count)) : num(cur?.price_mrr);
    const status = (cur?.status as SubStatus | undefined) ?? "active";
    return {
      p: {
        ...r,
        status,
        plan: r.plan ?? fromCur("plan"),
        mrr: mrrCounts(status) ? price : 0,
        price_mrr: price,
        interval: iv?.interval ?? null,
        interval_count: iv?.count ?? 1,
        quantity: cur ? num(cur.quantity) || 1 : r.quantity,
        trial_start: fromCur("trial_start"),
        trial_end: fromCur("trial_end"),
        started_at: cur ? fromCur("started_at") : paidAt,
        canceled_at: fromCur("canceled_at"),
        ended_at: fromCur("ended_at"),
        cancel_at_period_end: !!cur?.cancel_at_period_end,
      },
      // A row an invoice creates takes any state event after it.
      stateTs: cur ? num(cur.state_ts) : 0,
      extra: { ...extra, period_amount: amount, last_paid_at: paidAt },
      stale: false,
    };
  }
  let status = r.status;
  let cancelAtEnd = r.cancel_at_period_end;
  if (r.grace) {
    // Canceled, still paid up to the period's end; a trial canceled this way never paid.
    status = cur?.status === "trialing" ? "canceled" : "active";
    cancelAtEnd = true;
  }
  let price = r.price_mrr ?? r.mrr;
  let interval = r.interval;
  let count = r.interval_count;
  if (r.price_unknown) {
    price = num(cur?.price_mrr);
    interval = curInterval?.interval ?? null;
    count = curInterval?.count ?? 1;
    // The first invoice came before the state that says when the period ends: infer it now.
    if (!curInterval && extra.period_amount != null && extra.last_paid_at != null && r.period_end != null) {
      const iv = snapInterval((r.period_end - extra.last_paid_at) / DAY_MS);
      if (iv) {
        price = roundMoney(monthlyAmount(extra.period_amount, iv.interval, iv.count));
        interval = iv.interval;
        count = iv.count;
      }
    }
  }
  const mrr = r.price_unknown || r.grace ? (mrrCounts(status) ? price : 0) : r.mrr;
  return {
    p: {
      ...r,
      status,
      currency: r.currency ?? fromCur("currency"),
      plan: r.plan ?? fromCur("plan"),
      cancel_at_period_end: cancelAtEnd,
      mrr,
      price_mrr: price,
      interval,
      interval_count: count,
    },
    stateTs: r.ts,
    extra,
    stale: !!cur && num(cur.state_ts) > r.ts,
  };
}

export function applySubscriptions(
  db: Db,
  inputs: SubscriptionRecord[],
  now = Date.now(),
  o: { trustBrowserUserId?: boolean } = {},
): SubscriptionOutcome[] {
  const out: SubscriptionOutcome[] = [];
  db.transaction(() => {
    for (const raw of inputs) {
      const ref = `${raw.provider}:${raw.external_id}`;
      const cur = db.all("SELECT * FROM subscriptions WHERE ref = ?", [ref])[0];
      const { p, stateTs, extra, stale } = prepare(cur, raw);
      if (stale) {
        out.push({ ok: true, id: String(cur!.id), existing: true, changed: false, stale: true });
        continue;
      }
      const same =
        cur &&
        cur.status === p.status &&
        num(cur.mrr) === p.mrr &&
        (cur.plan ?? null) === p.plan &&
        num(cur.cancel_at_period_end) === (p.cancel_at_period_end ? 1 : 0) &&
        (cur.ended_at ?? null) === p.ended_at;
      if (same) {
        db.run(
          "UPDATE subscriptions SET state_ts = ?, period_amount = ?, last_paid_at = ?, current_period_end = ?, updated_at = ? WHERE id = ?",
          [stateTs, extra.period_amount, extra.last_paid_at, extra.current_period_end, now, String(cur!.id)],
        );
        out.push({ ok: true, id: String(cur!.id), existing: true, changed: false });
        continue;
      }
      // Attribution: linked once (or again while still unlinked).
      let dims: Row | null = null;
      let linkedBy: string | null = (cur?.linked_by as string | null) ?? null;
      if (!cur || !cur.linked_by) {
        const t = resolve(
          db,
          {
            provider: p.provider,
            external_id: p.external_id,
            event_id: null,
            type: "link",
            amount: 0,
            currency: p.currency,
            ts: p.started_at ?? p.ts,
            visitor_id: p.visitor_id,
            session_id: p.session_id,
            user_id: p.user_id,
            customer: p.customer,
            original_refs: [],
            livemode: p.livemode,
          },
          { trustBrowserUserId: o.trustBrowserUserId },
        );
        dims = t.dims;
        linkedBy = t.linked_by;
      }
      const price = p.price_mrr;
      // First seen: its history from its dates (a webhook for an older subscription, a backfill or
      // the API alike). Seen before: the movements from the stored state.
      const changes: (Change & { ts: number })[] = !cur
        ? snapshotHistory(p)
        : transitions(
            { status: cur.status as SubStatus, mrr: num(cur.mrr) },
            { status: p.status, mrr: p.mrr },
            !!db.all("SELECT 1 FROM subscription_changes WHERE sub_ref = ? AND kind IN ('new', 'reactivation') LIMIT 1", [ref]).length,
          ).map((c) => ({ ...c, ts: p.ts }));
      const id = cur ? String(cur.id) : newId("sub");
      const d = (k: string) => (dims ? (dims[k] ?? null) : cur ? (cur[k] ?? null) : null);
      const values = {
        status: p.status,
        plan: p.plan,
        currency: p.currency,
        mrr: p.mrr,
        price_mrr: price,
        // The price in its own currency when converted (price_mrr / fx_rate).
        original_currency: p.original_currency ?? (cur?.original_currency as string | null) ?? null,
        fx_rate: p.fx_rate ?? (cur?.fx_rate as number | null) ?? null,
        original_mrr: (p.fx_rate ?? cur?.fx_rate) ? roundMoney(price / num(p.fx_rate ?? cur?.fx_rate)) : null,
        interval: p.interval,
        interval_count: p.interval_count,
        quantity: p.quantity,
        trial_start: p.trial_start,
        trial_end: p.trial_end,
        started_at: p.started_at,
        canceled_at: p.canceled_at,
        ended_at: p.ended_at,
        cancel_at_period_end: p.cancel_at_period_end ? 1 : 0,
        customer: p.customer ?? (cur?.customer as string | null) ?? null,
        session_id: d("session_id"),
        visitor_id: d("visitor_id") ?? p.visitor_id,
        user_id: d("user_id") ?? p.user_id,
        linked_by: linkedBy,
        ...Object.fromEntries(DIM_FROM_SESSION.map((k) => [k, d(k)])),
        ...extra,
        livemode: p.livemode ? 1 : 0,
        state_ts: stateTs,
        updated_at: now,
      } as Record<string, string | number | null>;
      if (cur) {
        const cols = Object.keys(values);
        db.run(
          `UPDATE subscriptions SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
          [...cols.map((c) => values[c]!), id].map((v) => v ?? null),
        );
      } else {
        const all = { id, ref, provider: p.provider, external_id: p.external_id, created_at: now, ...values };
        const cols = Object.keys(all);
        db.run(
          `INSERT INTO subscriptions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          cols.map((c) => (all as Record<string, unknown>)[c] as string | number | null),
        );
      }
      for (const c of changes)
        db.run(
          "INSERT INTO subscription_changes (sub_ref, ts, kind, mrr_before, mrr_after, status_after, currency) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [ref, c.ts, c.kind, roundMoney(c.mrr_before), roundMoney(c.mrr_after), p.status, p.currency],
        );
      out.push({ ok: true, id, existing: !!cur, changed: true, linked_by: linkedBy, changes: changes.map((c) => c.kind) });
    }
  });
  return out;
}

// ------------------------------------------------------------------ reports

export interface MrrRequest extends PeriodParams {
  interval?: Interval;
  breakdown?: SubscriptionDim;
  include_test?: boolean;
}

const MOVES = ["new", "expansion", "contraction", "churn", "reactivation"] as const;

/** MRR of every subscription at `t` (each one's last movement before t), per group. */
function mrrAt(db: Db, t: number, dim: string | null, test: boolean) {
  return all(
    db,
    sql`WITH last AS (SELECT c.sub_ref, c.mrr_after, c.currency, ROW_NUMBER() OVER (PARTITION BY c.sub_ref ORDER BY c.ts DESC, c.id DESC) AS rn
                      FROM subscription_changes c WHERE c.ts < ${t} AND c.kind IN ('new', 'expansion', 'contraction', 'churn', 'reactivation'))
        SELECT ${raw(dim ? `COALESCE(s.${dim}, '(none)')` : "NULL")} AS value, l.currency, COALESCE(SUM(l.mrr_after), 0) AS mrr,
               COALESCE(SUM(l.mrr_after > 0), 0) AS active
        FROM last l JOIN subscriptions s ON s.ref = l.sub_ref WHERE l.rn = 1 ${raw(test ? "" : "AND s.livemode = 1")}
        GROUP BY value, l.currency`,
  );
}

function movesIn(db: Db, a: number, b: number, dim: string | null, test: boolean) {
  return all(
    db,
    sql`SELECT ${raw(dim ? `COALESCE(s.${dim}, '(none)')` : "NULL")} AS value, c.kind, COUNT(*) AS n, COALESCE(SUM(c.mrr_after - c.mrr_before), 0) AS delta
        FROM subscription_changes c JOIN subscriptions s ON s.ref = c.sub_ref
        WHERE c.ts >= ${a} AND c.ts < ${b} ${raw(test ? "" : "AND s.livemode = 1")} GROUP BY value, c.kind`,
  );
}

const sumBy = (rows: Row[], key: (r: Row) => string, f: (r: Row) => number) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + f(r));
  return m;
};

export function mrrReport(db: Db, settings: SiteSettings, q: MrrRequest, now = Date.now()) {
  return guard(() => {
    const r = rangeFor(db, settings, { ...q, period: q.period ?? (q.from ? undefined : "12mo") }, now);
    const interval = q.interval ?? (r.interval === "hour" ? "day" : r.interval);
    const test = !!q.include_test;
    const live = db.all(
      `SELECT currency, COALESCE(SUM(mrr), 0) AS mrr, COALESCE(SUM(mrr > 0), 0) AS active, COUNT(DISTINCT CASE WHEN mrr > 0 THEN customer END) AS customers,
              COALESCE(SUM(status = 'trialing'), 0) AS trialing, COALESCE(SUM(status = 'past_due'), 0) AS past_due
       FROM subscriptions ${test ? "" : "WHERE livemode = 1"} GROUP BY currency`,
    );
    const currencies = live.filter((x) => num(x.mrr) > 0 || num(x.trialing) > 0).map((x) => String(x.currency ?? "(none)"));
    const single = new Set(currencies).size <= 1;
    const tot = (k: string) => live.reduce((a, x) => a + num(x[k]), 0);
    const mrr = roundMoney(tot("mrr"));
    const current = {
      mrr: single ? mrr : null,
      arr: single ? roundMoney(mrr * 12) : null,
      currency: single ? (currencies[0] ?? settings.currency ?? null) : null,
      active_subscriptions: tot("active"),
      paying_customers: tot("customers"),
      trialing: tot("trialing"),
      past_due: tot("past_due"),
      arpu: single && tot("customers") ? roundMoney(mrr / tot("customers")) : null,
      ...(single
        ? {}
        : {
            by_currency: Object.fromEntries(
              live.map((x) => [String(x.currency ?? "(none)"), { mrr: roundMoney(num(x.mrr)), active: num(x.active) }]),
            ),
          }),
    };
    const bs = buckets(r, interval as Interval).filter((b, i) => i === 0 || b.start <= now);
    const series = bs.map((b) => {
      const end = Math.min(b.end, now);
      const at = mrrAt(db, end, null, test);
      const mv = movesIn(db, b.start, end, null, test);
      const byKind = sumBy(
        mv,
        (x) => String(x.kind),
        (x) => num(x.delta),
      );
      const nBy = sumBy(
        mv,
        (x) => String(x.kind),
        (x) => num(x.n),
      );
      return {
        date: b.label,
        mrr: roundMoney(at.reduce((a, x) => a + num(x.mrr), 0)),
        active_subscriptions: at.reduce((a, x) => a + num(x.active), 0),
        new_mrr: roundMoney(byKind.get("new") ?? 0),
        expansion_mrr: roundMoney(byKind.get("expansion") ?? 0),
        contraction_mrr: roundMoney(-(byKind.get("contraction") ?? 0)),
        churned_mrr: roundMoney(-(byKind.get("churn") ?? 0)),
        reactivation_mrr: roundMoney(byKind.get("reactivation") ?? 0),
        net_new_mrr: roundMoney(MOVES.reduce((a, k) => a + (byKind.get(k) ?? 0), 0)),
        new_subscriptions: nBy.get("new") ?? 0,
        churned_subscriptions: nBy.get("churn") ?? 0,
        trials_started: nBy.get("trial_start") ?? 0,
        trials_converted: nBy.get("trial_converted") ?? 0,
      };
    });
    const start = r.start;
    const end = Math.min(r.end, now);
    const atStart = mrrAt(db, start, null, test);
    const startMrr = atStart.reduce((a, x) => a + num(x.mrr), 0);
    const startActive = atStart.reduce((a, x) => a + num(x.active), 0);
    const mv = movesIn(db, start, end, null, test);
    const d = sumBy(
      mv,
      (x) => String(x.kind),
      (x) => num(x.delta),
    );
    const n = sumBy(
      mv,
      (x) => String(x.kind),
      (x) => num(x.n),
    );
    const ended = (n.get("trial_converted") ?? 0) + (n.get("trial_canceled") ?? 0);
    const totals = {
      mrr_at_start: roundMoney(startMrr),
      mrr_at_end: series.at(-1)?.mrr ?? roundMoney(startMrr),
      new_mrr: roundMoney(d.get("new") ?? 0),
      expansion_mrr: roundMoney(d.get("expansion") ?? 0),
      contraction_mrr: roundMoney(-(d.get("contraction") ?? 0)),
      churned_mrr: roundMoney(-(d.get("churn") ?? 0)),
      reactivation_mrr: roundMoney(d.get("reactivation") ?? 0),
      customer_churn_rate: startActive ? round(((n.get("churn") ?? 0) / startActive) * 100, 1) : null,
      revenue_churn_rate: startMrr ? round((-(d.get("churn") ?? 0) / startMrr) * 100, 1) : null,
      net_revenue_churn_rate: startMrr
        ? round((-((d.get("churn") ?? 0) + (d.get("contraction") ?? 0) + (d.get("expansion") ?? 0)) / startMrr) * 100, 1)
        : null,
      trials_started: n.get("trial_start") ?? 0,
      trials_converted: n.get("trial_converted") ?? 0,
      trial_conversion_rate: ended ? round(((n.get("trial_converted") ?? 0) / ended) * 100, 1) : null,
    };
    const out: Record<string, unknown> = { period: periodOut(r), interval, current, totals, series };
    if (q.breakdown) {
      const dim = q.breakdown;
      const nowRows = mrrAt(db, now + 1, dim, test);
      const startRows = mrrAt(db, start, dim, test);
      const mvd = movesIn(db, start, end, dim, test);
      const values = new Set([...nowRows, ...startRows, ...mvd].map((x) => String(x.value)));
      const sumV = (rows: Row[], v: string, k: string) => rows.filter((x) => String(x.value) === v).reduce((a, x) => a + num(x[k]), 0);
      const mvOf = (v: string, kind: string, k = "delta") =>
        mvd.filter((x) => String(x.value) === v && x.kind === kind).reduce((a, x) => a + num(x[k]), 0);
      out.breakdown = {
        property: dim,
        results: [...values]
          .map((v) => {
            const sm = sumV(startRows, v, "mrr");
            const sa = sumV(startRows, v, "active");
            return {
              value: v,
              mrr: roundMoney(sumV(nowRows, v, "mrr")),
              active_subscriptions: sumV(nowRows, v, "active"),
              new_mrr: roundMoney(mvOf(v, "new")),
              expansion_mrr: roundMoney(mvOf(v, "expansion")),
              churned_mrr: roundMoney(-mvOf(v, "churn")),
              customer_churn_rate: sa ? round((mvOf(v, "churn", "n") / sa) * 100, 1) : null,
              revenue_churn_rate: sm ? round((-mvOf(v, "churn") / sm) * 100, 1) : null,
              trials_started: mvOf(v, "trial_start", "n"),
              trials_converted: mvOf(v, "trial_converted", "n"),
            };
          })
          .sort((a, b) => b.mrr - a.mrr || b.new_mrr - a.new_mrr || a.value.localeCompare(b.value)),
      };
    }
    if (!single)
      out.note =
        "Subscriptions are in more than one currency and the site has no currency to convert to: MRR is reported per currency (current.by_currency) and the series sum them as they are. Set the site's currency (PATCH /v1/sites/:id {currency}) to convert.";
    return out;
  });
}

export interface SubscriptionsQuery {
  status?: string;
  limit: number;
  offset: number;
}

export function listSubscriptions(db: Db, q: SubscriptionsQuery) {
  const where = q.status ? "WHERE status = ?" : "";
  const args = q.status ? [q.status] : [];
  const rows = db.all(`SELECT *, COUNT(*) OVER () AS total FROM subscriptions ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`, [
    ...args,
    q.limit,
    q.offset,
  ]);
  const total = num(rows[0]?.total);
  return {
    subscriptions: rows.map((s) => ({
      id: s.id,
      provider: s.provider,
      external_id: s.external_id,
      status: s.status,
      plan: s.plan ?? null,
      mrr: num(s.mrr),
      currency: s.currency ?? null,
      ...(s.original_currency ? { original: { mrr: s.original_mrr, currency: s.original_currency, fx_rate: s.fx_rate } } : {}),
      interval: s.interval ?? null,
      interval_count: s.interval_count ?? null,
      quantity: s.quantity ?? null,
      trial_end: s.trial_end ?? null,
      started_at: s.started_at ?? null,
      canceled_at: s.canceled_at ?? null,
      ended_at: s.ended_at ?? null,
      cancel_at_period_end: !!s.cancel_at_period_end,
      linked_by: s.linked_by ?? null,
      channel: s.channel ?? "Unattributed",
      source: s.source ?? null,
      utm_campaign: s.utm_campaign ?? null,
      livemode: !!s.livemode,
      updated_at: s.updated_at,
    })),
    total,
    offset: q.offset,
    next_offset: q.offset + rows.length < total ? q.offset + rows.length : null,
  };
}
