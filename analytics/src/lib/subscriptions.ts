/**
 * Subscriptions: provider objects -> one normalised state, MRR, and the movements between two
 * states. Pure.
 *
 * MRR of a subscription (in its own currency, major units):
 *   - only while it pays: status active or past_due (past_due still counts: Stripe is retrying the
 *     invoice). trialing, incomplete, incomplete_expired, unpaid, paused and canceled count 0, and
 *     so does an active subscription whose collection is paused.
 *   - each item: unit amount x quantity, per month: interval month / interval_count, year /
 *     (12 x interval_count), week x 52 / 12 / interval_count, day x 365 / 12 / interval_count.
 *   - the discount in effect (repeating or forever; not "once", not past its end): percent_off
 *     scales it, amount_off (per invoice, in the coupon's currency) is spread over the items'
 *     interval like the price. Tax is not included (unit amounts are pre-tax).
 *   - metered and tiered prices have no fixed unit amount: they count 0 unless the API sends an
 *     amount (POST /subscriptions).
 *
 * Movements (subscription_changes): new (first time it pays), expansion / contraction (MRR up or
 * down while paying), churn (paying -> not paying: canceled, ended, paused, unpaid), reactivation
 * (not paying -> paying again after having paid), and trial_start, trial_converted, trial_canceled.
 */

export const SUB_STATUSES = ["trialing", "active", "past_due", "unpaid", "paused", "canceled", "incomplete", "incomplete_expired"] as const;
export type SubStatus = (typeof SUB_STATUSES)[number];
export const PAYING: readonly SubStatus[] = ["active", "past_due"];
export const INTERVALS = ["day", "week", "month", "year"] as const;
export type BillingInterval = (typeof INTERVALS)[number];

/** A subscription state as handed to the site's Durable Object (customer already hashed). */
export interface SubscriptionInput {
  provider: string;
  external_id: string;
  customer: string | null;
  status: SubStatus;
  plan: string | null;
  currency: string | null;
  /** MRR in the subscription's currency (computed by monthlyAmount for provider objects); 0 unless paying */
  mrr: number;
  /** what it pays per month while paying (discount applied): history of a first-seen snapshot uses it */
  price_mrr?: number;
  interval: BillingInterval | null;
  interval_count: number;
  quantity: number;
  trial_start: number | null;
  trial_end: number | null;
  started_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  cancel_at_period_end: boolean;
  /** when this state was true (the event's time); older states than the stored one are ignored */
  ts: number;
  visitor_id: string | null;
  session_id: string | null;
  user_id: string | null;
  livemode: boolean;
}

const PER_MONTH: Record<BillingInterval, number> = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };

/** An amount billed every `count` `interval`s, per month. */
export function monthlyAmount(amount: number, interval: BillingInterval, count = 1): number {
  return (amount * PER_MONTH[interval]) / Math.max(1, count);
}

/**
 * A billing period length in days as an interval, for providers whose subscription objects don't
 * say (LemonSqueezy): 1 day, 1-2 weeks, 1-11 months, a year. Null when it is none of those.
 */
export function snapInterval(days: number | null): { interval: BillingInterval; count: number } | null {
  if (days == null || !Number.isFinite(days) || days < 0.5) return null;
  if (days < 1.5) return { interval: "day", count: 1 };
  for (const w of [1, 2]) if (Math.abs(days - 7 * w) <= 1) return { interval: "week", count: w };
  if (Math.abs(days - 365.25) <= 6) return { interval: "year", count: 1 };
  const m = Math.round(days / 30.4375);
  if (m >= 1 && m <= 11 && Math.abs(days - m * 30.4375) <= 3.5 + m * 0.5) return { interval: "month", count: m };
  return null;
}

export const roundMoney = (n: number) => Math.round(n * 100) / 100 || 0; // never -0

export function mrrCounts(status: SubStatus, collectionPaused = false): boolean {
  return PAYING.includes(status) && !collectionPaused;
}

// ------------------------------------------------------------------ Stripe

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, max = 255): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const secs = (v: unknown): number | null => (num(v) && (v as number) > 0 ? (v as number) * 1000 : null);
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v)?.id);

const ZERO = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
const major = (minor: number, currency: string) => minor / (ZERO.has(currency) ? 1 : THREE.has(currency) ? 1000 : 100);

/** A Stripe subscription object (API 2024-06-20) as a state, at `ts`. Null when it isn't one. */
export function stripeSubscriptionState(
  o: Obj,
  ts: number,
  nowMs: number,
): (Omit<SubscriptionInput, "customer"> & { customer_raw: string | null }) | null {
  const id = str(o.id);
  const status = str(o.status, 30) as SubStatus | null;
  if (!id || !status || !(SUB_STATUSES as readonly string[]).includes(status)) return null;
  const items = (obj(o.items)?.data as unknown[] | undefined)?.map(obj).filter((x): x is Obj => !!x) ?? [];
  const currency = (str(o.currency, 3) ?? str(obj(obj(items[0])?.price)?.currency, 3))?.toUpperCase() ?? null;
  let monthly = 0;
  let interval: BillingInterval | null = null;
  let count = 1;
  let quantity = 0;
  let plan: string | null = null;
  for (const it of items) {
    const price = obj(it.price) ?? obj(it.plan);
    const rec = obj(price?.recurring) ?? (price?.interval ? price : null);
    const iv = str(rec?.interval, 10) as BillingInterval | null;
    const ic = num(rec?.interval_count) ?? 1;
    const unit =
      num(price?.unit_amount) ??
      (typeof price?.unit_amount_decimal === "string" ? Number(price.unit_amount_decimal) : null) ??
      num(price?.amount);
    const q = num(it.quantity) ?? 1;
    quantity += q;
    if (!interval && iv) {
      interval = iv;
      count = ic;
      plan = str(price?.nickname, 200) ?? str(price?.lookup_key, 200) ?? idOf(price?.product) ?? idOf(price);
    }
    if (iv && (INTERVALS as readonly string[]).includes(iv) && unit != null && currency)
      monthly += monthlyAmount(major(unit, currency) * q, iv, ic);
  }
  // The discount in effect now (not "once", not ended).
  const discount = obj(o.discount) ?? obj((o.discounts as unknown[] | undefined)?.[0]);
  const coupon = obj(discount?.coupon);
  const ended = num(discount?.end) != null && (discount!.end as number) * 1000 < nowMs;
  if (coupon && coupon.duration !== "once" && !ended) {
    const pct = num(coupon.percent_off);
    const off = num(coupon.amount_off);
    if (pct) monthly *= 1 - Math.min(100, pct) / 100;
    else if (off && interval && currency && str(coupon.currency, 3)?.toUpperCase() === currency)
      monthly = Math.max(0, monthly - monthlyAmount(major(off, currency), interval, count));
  }
  const paused = !!obj(o.pause_collection);
  const md = obj(o.metadata) ?? {};
  const vid = str(md.afs_visitor_id, 64);
  return {
    provider: "stripe",
    external_id: id,
    customer_raw: idOf(o.customer),
    status,
    plan,
    currency,
    mrr: mrrCounts(status, paused) ? roundMoney(monthly) : 0,
    price_mrr: roundMoney(monthly),
    interval,
    interval_count: count,
    quantity: quantity || 1,
    trial_start: secs(o.trial_start),
    trial_end: secs(o.trial_end),
    started_at: secs(o.start_date) ?? secs(o.created),
    canceled_at: secs(o.canceled_at),
    ended_at: secs(o.ended_at),
    cancel_at_period_end: o.cancel_at_period_end === true,
    ts,
    visitor_id: vid && /^[A-Za-z0-9_-]{8,64}$/.test(vid) ? vid : null,
    session_id: null,
    user_id: str(md.afs_user_id, 200),
    livemode: o.livemode === true,
  };
}

// ------------------------------------------------------------------ movements

export interface StateLike {
  status: SubStatus;
  mrr: number;
}

export interface Change {
  kind: "new" | "expansion" | "contraction" | "churn" | "reactivation" | "trial_start" | "trial_converted" | "trial_canceled";
  mrr_before: number;
  mrr_after: number;
}

/** The movements from `prev` (null: first seen) to `next`. `paidBefore`: it has paid at some point. */
export function transitions(prev: StateLike | null, next: StateLike, paidBefore: boolean): Change[] {
  const out: Change[] = [];
  const before = prev?.mrr ?? 0;
  const after = next.mrr;
  const wasTrial = prev?.status === "trialing";
  if (next.status === "trialing" && !wasTrial) out.push({ kind: "trial_start", mrr_before: before, mrr_after: after });
  if (wasTrial && next.status !== "trialing") {
    if (after > 0 || PAYING.includes(next.status)) out.push({ kind: "trial_converted", mrr_before: before, mrr_after: after });
    else out.push({ kind: "trial_canceled", mrr_before: before, mrr_after: after });
  }
  if (before === 0 && after > 0) out.push({ kind: paidBefore ? "reactivation" : "new", mrr_before: 0, mrr_after: after });
  else if (before > 0 && after === 0) out.push({ kind: "churn", mrr_before: before, mrr_after: 0 });
  else if (before > 0 && after > before) out.push({ kind: "expansion", mrr_before: before, mrr_after: after });
  else if (before > 0 && after < before) out.push({ kind: "contraction", mrr_before: before, mrr_after: after });
  return out;
}
