import { hmacSha256Hex, timingSafeEqual } from "@afs/shared";
import type { PaymentInput } from "./types";
import { SESSION_ID_RE, VISITOR_ID_RE } from "./visitor";

/**
 * Stripe webhooks: signature verification and event -> payment normalisation. Pure (Web Crypto
 * only). Everything read from an event is untrusted input: only the fields below are read, each is
 * validated, and raw metadata is never stored.
 *
 * Signature (https://docs.stripe.com/webhooks#verify-manually): the `Stripe-Signature` header is
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`; v1 = hex(HMAC-SHA256(signing secret, "<t>.<raw body>")).
 * Several v1 values appear while a secret is being rolled; any match is accepted.
 */

export const STRIPE_TOLERANCE_S = 300;

/** Event types the integration uses. Everything else is acknowledged and ignored. */
export const STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "charge.refunded",
] as const;
/** Subscription states for MRR (the event's object is the subscription as of event.created). */
export const STRIPE_SUBSCRIPTION_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
] as const;
/** Optional: only for PaymentIntents you create yourself with metadata.afs_visitor_id set. */
export const STRIPE_OPTIONAL_EVENTS = ["payment_intent.succeeded"] as const;

export function parseStripeSignature(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t = Number.NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (!Number.isFinite(t) || !v1.length) return null;
  return { t, v1 };
}

export type SignatureCheck =
  | { ok: true; t: number }
  | { ok: false; reason: "missing_signature" | "timestamp_outside_tolerance" | "signature_mismatch" };

export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  nowMs: number,
  toleranceS = STRIPE_TOLERANCE_S,
): Promise<SignatureCheck> {
  const p = parseStripeSignature(header);
  if (!p) return { ok: false, reason: "missing_signature" };
  if (Math.abs(nowMs / 1000 - p.t) > toleranceS) return { ok: false, reason: "timestamp_outside_tolerance" };
  const expected = await hmacSha256Hex(secret, `${p.t}.${payload}`);
  if (!p.v1.some((s) => timingSafeEqual(s, expected))) return { ok: false, reason: "signature_mismatch" };
  return { ok: true, t: p.t };
}

/** The header Stripe would send for `payload` (tests, local `curl` examples). */
export async function stripeSignatureHeader(payload: string, secret: string, tSeconds: number): Promise<string> {
  return `t=${tSeconds},v1=${await hmacSha256Hex(secret, `${tSeconds}.${payload}`)}`;
}

// https://docs.stripe.com/currencies#zero-decimal and #three-decimal
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/** Stripe amounts are integers in the currency's smallest unit. */
export function minorToMajor(amount: number, currency: string): number {
  const c = currency.toUpperCase();
  const div = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100;
  return Math.round((amount / div) * 1000) / 1000;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, max = 255): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
/** A Stripe id field that may be a string or an expanded object. */
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v)?.id);
const intOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Link identifiers from metadata / client_reference_id, validated. */
export function linkIdentifiers(o: Obj): { visitor_id: string | null; session_id: string | null; user_id: string | null } {
  const sources = [o.metadata, obj(o.subscription_details)?.metadata, obj(obj(o.parent)?.subscription_details)?.metadata]
    .map(obj)
    .filter((m): m is Obj => !!m);
  const pick = (k: string) => sources.map((m) => str(m[k], 200)).find((v) => v != null) ?? null;
  let visitor = pick("afs_visitor_id");
  let session = pick("afs_session_id");
  let user = pick("afs_user_id");
  if (visitor && !VISITOR_ID_RE.test(visitor)) visitor = null;
  if (session && !SESSION_ID_RE.test(session)) session = null;
  // client_reference_id: "afs_<visitor id>" or a bare visitor id from afsa.visitorId(); merchants
  // often put their own user id there instead, so it is also tried as a user id (the DO uses
  // whichever matches stored data first).
  const cri = str(o.client_reference_id, 200);
  if (cri) {
    const bare = cri.startsWith("afs_") ? cri.slice(4) : cri;
    if (!visitor && VISITOR_ID_RE.test(bare)) visitor = bare;
    if (!user && !cri.startsWith("afs_")) user = cri;
  }
  return { visitor_id: visitor, session_id: session, user_id: user };
}

export type StripeAction = { action: "ignore"; reason: string } | { action: "record"; record: PaymentInput };

const ignore = (reason: string): StripeAction => ({ action: "ignore", reason });

/** Map one verified Stripe event to a payment (or a customer link, or nothing). */
export function normalizeStripeEvent(event: unknown): StripeAction {
  const ev = obj(event);
  const type = str(ev?.type, 100);
  const eventId = str(ev?.id, 100);
  const o = obj(obj(ev?.data)?.object);
  if (!ev || !type || !eventId || !o) return ignore("not a Stripe event object");
  const created = intOf(ev.created);
  const ts = created ? created * 1000 : Date.now();
  const livemode = ev.livemode === true;
  const currency = str(o.currency, 3)?.toUpperCase() ?? null;
  const base = {
    provider: "stripe",
    event_id: eventId,
    ts,
    livemode,
    currency,
    customer: idOf(o.customer),
    original_refs: [] as string[],
    ...linkIdentifiers(o),
  };
  const objectId = str(o.id, 255);
  if (!objectId) return ignore("event object has no id");

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const mode = str(o.mode, 20);
    if (mode === "subscription") {
      // Revenue comes from invoice.paid; this links the customer (and so every renewal) to the visitor.
      return { action: "record", record: { ...base, type: "link", external_id: objectId, amount: 0 } };
    }
    if (mode !== "payment") return ignore(`checkout mode ${mode ?? "unknown"} carries no payment`);
    const paid = type === "checkout.session.async_payment_succeeded" || o.payment_status === "paid";
    const amount = intOf(o.amount_total);
    if (!paid || !amount || !currency) {
      // Unpaid (async methods: wait for async_payment_succeeded) or free: still link the customer.
      return { action: "record", record: { ...base, type: "link", external_id: objectId, amount: 0 } };
    }
    // With invoice_creation the session also produces an invoice.paid; keying on the invoice (or
    // the PaymentIntent) makes the two events one payment.
    const external = idOf(o.invoice) ?? idOf(o.payment_intent) ?? objectId;
    return { action: "record", record: { ...base, type: "new", external_id: external, amount: minorToMajor(amount, currency) } };
  }

  if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
    const amount = intOf(o.amount_paid);
    if (!amount || !currency) return ignore("invoice paid nothing (trial or credit)");
    const reason = str(o.billing_reason, 50);
    const renewal = reason === "subscription_cycle" || reason === "subscription_update" || reason === "subscription_threshold";
    return {
      action: "record",
      record: { ...base, type: renewal ? "renewal" : "new", external_id: objectId, amount: minorToMajor(amount, currency) },
    };
  }

  if (type === "payment_intent.succeeded") {
    // Opt-in only: a PaymentIntent you created with our metadata, not one behind Checkout or an invoice.
    const md = obj(o.metadata);
    if (!md || !(str(md.afs_visitor_id) || str(md.afs_session_id) || str(md.afs_user_id)))
      return ignore("payment_intent without afs_* metadata (Checkout and invoices are counted from their own events)");
    if (o.invoice) return ignore("payment_intent of an invoice (counted from invoice.paid)");
    const amount = intOf(o.amount_received);
    if (!amount || !currency) return ignore("payment_intent received nothing");
    return { action: "record", record: { ...base, type: "new", external_id: objectId, amount: minorToMajor(amount, currency) } };
  }

  if (type === "charge.refunded") {
    const amount = intOf(o.amount_refunded);
    if (!amount || !currency) return ignore("charge has no refunded amount");
    const originals = [idOf(o.invoice), idOf(o.payment_intent)].filter((x): x is string => !!x);
    // amount_refunded is cumulative, so a later partial refund replaces the earlier figure.
    return {
      action: "record",
      record: {
        ...base,
        type: "refund",
        external_id: `refund:${objectId}`,
        amount: minorToMajor(amount, currency),
        original_refs: originals,
      },
    };
  }

  return ignore(`event type ${type} is not used`);
}
