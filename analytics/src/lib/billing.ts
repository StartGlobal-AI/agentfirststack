/**
 * Polar, Paddle and LemonSqueezy webhooks: signature checks and event -> payments / subscription
 * states, so they feed the same model as Stripe. Pure apart from WebCrypto.
 *
 * Signatures (each from the provider's own documentation):
 *   - Polar: Standard Webhooks. Headers webhook-id, webhook-timestamp, webhook-signature (space
 *     separated "v1,<base64>"); signed content "<id>.<timestamp>.<body>", HMAC-SHA256. The key is
 *     the base64 after "whsec_" (Standard Webhooks) or, for secrets Polar issued before
 *     2026-09-08, the UTF-8 bytes of the whole "whsec_..." string: both are tried, as Polar's SDKs do.
 *   - Paddle Billing: Paddle-Signature "ts=<unix s>;h1=<hex>" (h1 may repeat during secret
 *     rotation); signed content "<ts>:<body>", HMAC-SHA256 hex with the endpoint secret as is.
 *   - LemonSqueezy: X-Signature = hex HMAC-SHA256 of the raw body with the signing secret. No
 *     timestamp and no event id: every record is idempotent by its natural key instead.
 * Timestamps (Polar, Paddle) must be within 5 minutes; Polar and Paddle event ids are deduped.
 *
 * Money: Polar, Paddle and LemonSqueezy are merchants of record (they collect and remit the tax),
 * so their payments are recorded before tax and after discounts. Amounts arrive in minor units.
 */

import { timingSafeEqual } from "@afs/shared";
import { SESSION_ID_RE, VISITOR_ID_RE } from "./visitor";
import { minorToMajor } from "./stripe";
import { type BillingInterval, INTERVALS, type SubStatus, mrrCounts, monthlyAmount, roundMoney } from "./subscriptions";
import type { PaymentInput } from "./types";

export const BILLING_PROVIDERS = ["polar", "paddle", "lemonsqueezy"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];
export const BILLING_TOLERANCE_S = 300;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, max = 255): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
/** Minor-unit amounts: integers, or (Paddle) integer strings. */
const minor = (v: unknown): number | null => {
  const n = typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : typeof v === "number" && Number.isSafeInteger(v) ? v : null;
  return n != null && n >= 0 ? n : null;
};
const ms = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
};
const money = (amount: number | null, currency: string | null) => (amount != null && currency ? minorToMajor(amount, currency) : null);

// ------------------------------------------------------------------ signatures

const enc = new TextEncoder();

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
function unb64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export type BillingCheck = { ok: true; event_id: string | null } | { ok: false; reason: string };

/** The candidate HMAC keys of a Polar secret: Standard Webhooks' base64 key, then the legacy UTF-8 bytes. */
function polarKeys(secret: string): Uint8Array[] {
  const keys: Uint8Array[] = [];
  const body = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const std = /^[A-Za-z0-9+/]+={0,2}$/.test(body) ? unb64(body) : null;
  if (std && std.length >= 16) keys.push(std);
  keys.push(enc.encode(secret));
  return keys;
}

export async function verifyBilling(
  provider: BillingProvider,
  body: string,
  headers: Headers,
  secret: string,
  nowMs: number,
): Promise<BillingCheck> {
  if (provider === "polar") {
    const id = headers.get("webhook-id");
    const ts = Number(headers.get("webhook-timestamp"));
    const sigs = (headers.get("webhook-signature") ?? "")
      .split(" ")
      .map((x) => x.split(","))
      .filter((x) => x[0] === "v1" && x[1])
      .map((x) => x[1]!);
    if (!id || !Number.isFinite(ts) || !sigs.length) return { ok: false, reason: "missing_signature" };
    if (Math.abs(nowMs / 1000 - ts) > BILLING_TOLERANCE_S) return { ok: false, reason: "timestamp_outside_tolerance" };
    for (const key of polarKeys(secret)) {
      const expected = b64(await hmac(key, `${id}.${ts}.${body}`));
      if (sigs.some((s) => timingSafeEqual(s, expected))) return { ok: true, event_id: id.slice(0, 100) };
    }
    return { ok: false, reason: "signature_mismatch" };
  }
  if (provider === "paddle") {
    const parts = (headers.get("paddle-signature") ?? "").split(";").map((p) => p.split("="));
    const ts = Number(parts.find((p) => p[0] === "ts")?.[1]);
    const h1 = parts.filter((p) => p[0] === "h1" && p[1]).map((p) => p[1]!);
    if (!Number.isFinite(ts) || !h1.length) return { ok: false, reason: "missing_signature" };
    if (Math.abs(nowMs / 1000 - ts) > BILLING_TOLERANCE_S) return { ok: false, reason: "timestamp_outside_tolerance" };
    const expected = hex(await hmac(enc.encode(secret), `${ts}:${body}`));
    if (!h1.some((s) => timingSafeEqual(s, expected))) return { ok: false, reason: "signature_mismatch" };
    let eventId: string | null = null;
    try {
      eventId = str((JSON.parse(body) as Obj).event_id, 100);
    } catch {
      /* checked by the caller */
    }
    return { ok: true, event_id: eventId };
  }
  const sig = headers.get("x-signature");
  if (!sig) return { ok: false, reason: "missing_signature" };
  const expected = hex(await hmac(enc.encode(secret), body));
  if (!timingSafeEqual(sig.toLowerCase(), expected)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true, event_id: null };
}

/** The headers a provider would send (tests and curl examples). */
export async function billingSignatureHeaders(
  provider: BillingProvider,
  body: string,
  secret: string,
  tSeconds: number,
  id = "msg_test",
): Promise<Record<string, string>> {
  if (provider === "polar")
    return {
      "webhook-id": id,
      "webhook-timestamp": String(tSeconds),
      "webhook-signature": `v1,${b64(await hmac(polarKeys(secret)[0]!, `${id}.${tSeconds}.${body}`))}`,
    };
  if (provider === "paddle")
    return { "paddle-signature": `ts=${tSeconds};h1=${hex(await hmac(enc.encode(secret), `${tSeconds}:${body}`))}` };
  return { "x-signature": hex(await hmac(enc.encode(secret), body)) };
}

// ------------------------------------------------------------------ normalised output

/** A subscription state before the customer id is hashed (the Worker hashes it). */
export interface BillingSubscription {
  provider: BillingProvider;
  external_id: string;
  customer_raw: string | null;
  status: SubStatus;
  plan: string | null;
  currency: string | null;
  mrr: number;
  price_mrr: number;
  interval: BillingInterval | null;
  interval_count: number;
  quantity: number;
  trial_start: number | null;
  trial_end: number | null;
  started_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  cancel_at_period_end: boolean;
  ts: number;
  visitor_id: string | null;
  session_id: string | null;
  user_id: string | null;
  livemode: boolean;
  kind?: "state" | "invoice";
  price_unknown?: boolean;
  period_amount?: number | null;
  period_end?: number | null;
  grace?: boolean;
}

export interface BillingAction {
  ignored?: string;
  payments: PaymentInput[];
  subscriptions: BillingSubscription[];
}

const none = (ignored: string): BillingAction => ({ ignored, payments: [], subscriptions: [] });

/** afs_* link ids from metadata / custom data, validated. */
function links(...sources: unknown[]) {
  const ms = sources.map(obj).filter((m): m is Obj => !!m);
  const pick = (k: string) => ms.map((m) => str(m[k], 200)).find((v) => v != null) ?? null;
  const v = pick("afs_visitor_id");
  const s = pick("afs_session_id");
  return {
    visitor_id: v && VISITOR_ID_RE.test(v) ? v : null,
    session_id: s && SESSION_ID_RE.test(s) ? s : null,
    user_id: pick("afs_user_id"),
  };
}

const ivOf = (v: unknown): BillingInterval | null => {
  const s = str(v, 10);
  return s && (INTERVALS as readonly string[]).includes(s) ? (s as BillingInterval) : null;
};

function state(
  base: Omit<BillingSubscription, "mrr" | "price_mrr"> & { monthly: number; collectionPaused?: boolean },
): BillingSubscription {
  const { monthly, collectionPaused, ...rest } = base;
  const price = roundMoney(monthly);
  return { ...rest, price_mrr: price, mrr: mrrCounts(rest.status, collectionPaused) ? price : 0 };
}

// ------------------------------------------------------------------ Polar

const POLAR_STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"]);

export function normalizePolar(event: unknown, eventId: string | null, livemode: boolean): BillingAction {
  const ev = obj(event);
  const type = str(ev?.type, 100);
  const o = obj(ev?.data);
  if (!type || !o) return none("not a Polar event");
  const ts = ms(ev?.timestamp) ?? ms(o.modified_at) ?? ms(o.created_at) ?? Date.now();
  const id = str(o.id);
  if (!id) return none("event object has no id");
  const currency = str(o.currency, 3)?.toUpperCase() ?? null;
  const customer = obj(o.customer);
  const ids = links(o.metadata, customer?.metadata);
  const user = ids.user_id ?? str(customer?.external_id, 200);
  const base = {
    provider: "polar",
    event_id: eventId,
    ts,
    livemode,
    currency,
    customer: str(o.customer_id),
    original_refs: [] as string[],
    ...ids,
    user_id: user,
  };
  if (type === "order.paid") {
    if (o.paid === false) return none("order not paid");
    const amount = money(minor(o.net_amount), currency);
    const reason = str(o.billing_reason, 40);
    const renewal = reason === "subscription_cycle" || reason === "subscription_update" || reason === "subscription_meter_cycle";
    if (!amount) return { payments: [{ ...base, type: "link", external_id: id, amount: 0 }], subscriptions: [] };
    return { payments: [{ ...base, type: renewal ? "renewal" : "new", external_id: id, amount }], subscriptions: [] };
  }
  if (type === "order.refunded") {
    const amount = money(minor(o.refunded_amount), currency);
    if (!amount) return none("order has no refunded amount");
    // refunded_amount is cumulative (and before tax, beside refunded_tax_amount): it replaces the figure.
    return { payments: [{ ...base, type: "refund", external_id: `refund:${id}`, amount, original_refs: [id] }], subscriptions: [] };
  }
  if (type.startsWith("subscription.")) {
    const status = str(o.status, 30);
    if (!status || !POLAR_STATUSES.has(status)) return none(`unknown subscription status ${status ?? ""}`);
    const iv = ivOf(o.recurring_interval);
    const count = Math.max(1, Number(o.recurring_interval_count) || 1);
    // Polar's amount already has the discount applied (and covers seats).
    const amount = money(minor(o.amount), currency) ?? 0;
    return {
      payments: [],
      subscriptions: [
        state({
          provider: "polar",
          external_id: id,
          customer_raw: str(o.customer_id),
          status: status as SubStatus,
          plan: str(obj(o.product)?.name, 200) ?? str(o.product_id),
          currency,
          monthly: iv ? monthlyAmount(amount, iv, count) : 0,
          interval: iv,
          interval_count: count,
          quantity: Number(o.seats) > 0 ? Number(o.seats) : 1,
          trial_start: ms(o.trial_start),
          trial_end: ms(o.trial_end),
          started_at: ms(o.started_at) ?? ms(o.created_at),
          canceled_at: ms(o.canceled_at),
          ended_at: ms(o.ended_at),
          cancel_at_period_end: o.cancel_at_period_end === true,
          ts,
          visitor_id: ids.visitor_id,
          session_id: ids.session_id,
          user_id: user,
          livemode,
        }),
      ],
    };
  }
  return none(`event type ${type} is not used`);
}

// ------------------------------------------------------------------ Paddle Billing

const PADDLE_STATUSES = new Set(["active", "canceled", "past_due", "paused", "trialing"]);
const PADDLE_RENEWAL = new Set(["subscription_recurring", "subscription_update"]);

export function normalizePaddle(event: unknown, livemode: boolean): BillingAction {
  const ev = obj(event);
  const type = str(ev?.event_type, 100);
  const eventId = str(ev?.event_id, 100);
  const o = obj(ev?.data);
  if (!type || !o) return none("not a Paddle event");
  const ts = ms(ev?.occurred_at) ?? Date.now();
  const id = str(o.id);
  if (!id) return none("event object has no id");
  const currency = str(o.currency_code, 3)?.toUpperCase() ?? null;
  const ids = links(o.custom_data);
  const base = {
    provider: "paddle",
    event_id: eventId,
    ts,
    livemode,
    currency,
    customer: str(o.customer_id),
    original_refs: [] as string[],
    ...ids,
  };
  if (type === "transaction.completed") {
    const totals = obj(obj(o.details)?.totals);
    const total = minor(totals?.total);
    const tax = minor(totals?.tax) ?? 0;
    const amount = money(total == null ? null : Math.max(0, total - tax), currency);
    const at = ms(o.billed_at) ?? ts;
    if (!amount) return { payments: [{ ...base, ts: at, type: "link", external_id: id, amount: 0 }], subscriptions: [] };
    return {
      payments: [{ ...base, ts: at, type: PADDLE_RENEWAL.has(String(o.origin)) ? "renewal" : "new", external_id: id, amount }],
      subscriptions: [],
    };
  }
  if (type === "adjustment.created" || type === "adjustment.updated") {
    const action = str(o.action, 40);
    if (action !== "refund" && action !== "chargeback") return none(`adjustment ${action ?? ""} is not a refund`);
    if (o.status !== "approved") return none(`adjustment ${String(o.status)}: counted once approved`);
    const amount = money(minor(obj(o.totals)?.subtotal), currency);
    const txn = str(o.transaction_id);
    if (!amount || !txn) return none("adjustment has no amount");
    return { payments: [{ ...base, type: "refund", external_id: `refund:${id}`, amount, original_refs: [txn] }], subscriptions: [] };
  }
  if (type.startsWith("subscription.")) {
    const status = str(o.status, 30);
    if (!status || !PADDLE_STATUSES.has(status)) return none(`unknown subscription status ${status ?? ""}`);
    const items = ((o.items as unknown[]) ?? []).map(obj).filter((x): x is Obj => !!x && x.status !== "inactive");
    const subCycle = obj(o.billing_cycle);
    let monthly = 0;
    let quantity = 0;
    let plan: string | null = null;
    let trial: Obj | null = null;
    for (const it of items) {
      const price = obj(it.price);
      const cycle = obj(price?.billing_cycle) ?? subCycle;
      const iv = ivOf(cycle?.interval);
      const unit = money(minor(obj(price?.unit_price)?.amount), currency);
      const q = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
      quantity += q;
      plan ??= str(price?.name, 200) ?? str(price?.description, 200) ?? str(price?.id);
      trial ??= obj(it.trial_dates);
      if (iv && unit != null) monthly += monthlyAmount(unit * q, iv, Math.max(1, Number(cycle?.frequency) || 1));
    }
    const canceled = status === "canceled";
    return {
      payments: [],
      subscriptions: [
        state({
          provider: "paddle",
          external_id: id,
          customer_raw: str(o.customer_id),
          status: status as SubStatus,
          plan,
          currency,
          // Paddle's subscription carries no discount amount: MRR is before discounts.
          monthly,
          interval: ivOf(subCycle?.interval),
          interval_count: Math.max(1, Number(subCycle?.frequency) || 1),
          quantity: quantity || 1,
          trial_start: ms(trial?.starts_at),
          trial_end: ms(trial?.ends_at),
          started_at: ms(o.started_at) ?? ms(o.first_billed_at) ?? ms(o.created_at),
          canceled_at: ms(o.canceled_at),
          ended_at: canceled ? (ms(o.canceled_at) ?? ts) : null,
          cancel_at_period_end: obj(o.scheduled_change)?.action === "cancel",
          ts,
          ...ids,
          livemode,
        }),
      ],
    };
  }
  return none(`event type ${type} is not used`);
}

// ------------------------------------------------------------------ LemonSqueezy

const LS_STATUS: Record<string, SubStatus> = {
  on_trial: "trialing",
  active: "active",
  paused: "paused",
  past_due: "past_due",
  unpaid: "unpaid",
  expired: "canceled",
};

/** The pre-tax share of a refund (LemonSqueezy refunds are of the total, tax included). */
const preTax = (refunded: number, net: number | null, total: number | null) =>
  net != null && total ? Math.round((refunded * net) / total) : refunded;

export function normalizeLemonSqueezy(event: unknown, eventHeader: string | null): BillingAction {
  const ev = obj(event);
  const meta = obj(ev?.meta);
  const type = str(meta?.event_name, 100) ?? str(eventHeader, 100);
  const data = obj(ev?.data);
  const a = obj(data?.attributes);
  const id = str(data?.id, 100);
  if (!type || !a || !id) return none("not a LemonSqueezy event");
  const livemode = a.test_mode !== true && meta?.test_mode !== true;
  const currency = str(a.currency, 3)?.toUpperCase() ?? null;
  const ids = links(meta?.custom_data);
  const customer = str(a.customer_id);
  const base = { provider: "lemonsqueezy", event_id: null, livemode, currency, customer, original_refs: [] as string[], ...ids };
  const net = (x: Obj) => {
    const sub = minor(x.subtotal);
    return sub == null ? null : Math.max(0, sub - (minor(x.discount_total) ?? 0));
  };
  if (type === "order_created") {
    if (a.status !== "paid") return none(`order ${String(a.status)}`);
    const amount = money(net(a), currency);
    const ts = ms(a.created_at) ?? Date.now();
    if (!amount) return { payments: [{ ...base, ts, type: "link", external_id: id, amount: 0 }], subscriptions: [] };
    return { payments: [{ ...base, ts, type: "new", external_id: id, amount }], subscriptions: [] };
  }
  if (type === "order_refunded" || type === "subscription_payment_refunded") {
    const own = type === "order_refunded" ? id : `invoice:${id}`;
    const refunded = minor(a.refunded_amount);
    const amount = money(refunded == null ? null : preTax(refunded, net(a), minor(a.total)), currency);
    if (!amount) return none("nothing refunded");
    const ts = ms(a.refunded_at) ?? ms(a.updated_at) ?? Date.now();
    return { payments: [{ ...base, ts, type: "refund", external_id: `refund:${own}`, amount, original_refs: [own] }], subscriptions: [] };
  }
  if (type === "subscription_payment_success") {
    const subId = str(a.subscription_id, 100);
    const amount = money(net(a), currency);
    const ts = ms(a.created_at) ?? Date.now();
    if (!subId || amount == null) return none("subscription invoice without subscription or amount");
    // The first invoice's money is counted from order_created; every invoice prices the subscription.
    const payments: PaymentInput[] =
      a.billing_reason === "initial" || !amount ? [] : [{ ...base, ts, type: "renewal", external_id: `invoice:${id}`, amount }];
    const invoice: BillingSubscription = {
      provider: "lemonsqueezy",
      external_id: subId,
      customer_raw: customer,
      status: "active",
      plan: null,
      currency,
      mrr: 0,
      price_mrr: 0,
      interval: null,
      interval_count: 1,
      quantity: 1,
      trial_start: null,
      trial_end: null,
      started_at: null,
      canceled_at: null,
      ended_at: null,
      cancel_at_period_end: false,
      ts,
      ...ids,
      livemode,
      kind: "invoice",
      period_amount: amount,
    };
    return { payments, subscriptions: [invoice] };
  }
  if (type.startsWith("subscription_")) {
    const raw = str(a.status, 30);
    const cancelled = raw === "cancelled";
    const status = cancelled ? "active" : raw ? LS_STATUS[raw] : undefined;
    if (!status) return none(`unknown subscription status ${raw ?? ""}`);
    const ts = ms(a.updated_at) ?? Date.now();
    const created = ms(a.created_at);
    return {
      payments: [],
      subscriptions: [
        {
          provider: "lemonsqueezy",
          external_id: id,
          customer_raw: customer,
          status,
          plan: [str(a.product_name, 100), str(a.variant_name, 100)].filter((x) => x && x !== "Default").join(" - ") || null,
          currency,
          mrr: 0,
          price_mrr: 0,
          interval: null,
          interval_count: 1,
          quantity: Number(obj(a.first_subscription_item)?.quantity) > 0 ? Number(obj(a.first_subscription_item)!.quantity) : 1,
          trial_start: raw === "on_trial" ? created : null,
          trial_end: ms(a.trial_ends_at),
          started_at: created,
          canceled_at: cancelled || raw === "expired" ? ts : null,
          ended_at: raw === "expired" ? (ms(a.ends_at) ?? ts) : null,
          cancel_at_period_end: cancelled,
          ts,
          ...ids,
          livemode,
          // No price on LemonSqueezy subscriptions: it comes from their invoices.
          price_unknown: true,
          period_end: ms(a.renews_at),
          grace: cancelled,
        },
      ],
    };
  }
  return none(`event type ${type} is not used`);
}
