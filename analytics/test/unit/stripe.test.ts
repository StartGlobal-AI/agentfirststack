import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  linkIdentifiers,
  minorToMajor,
  normalizeStripeEvent,
  parseStripeSignature,
  stripeSignatureHeader,
  verifyStripeSignature,
} from "../../src/lib/stripe";

const SECRET = "whsec_test_0123456789abcdef";
const NOW = 1_793_700_000_000;
const T = NOW / 1000;
/** Computed independently of the code under test (Node's crypto, Stripe's documented scheme). */
const sign = (payload: string, t: number, secret = SECRET) => createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

describe("Stripe-Signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });

  it("parses t and every v1, ignoring v0 and junk", () => {
    const h = `t=${T},v1=${"a".repeat(64)},v0=${"b".repeat(64)},v1=${"C".repeat(64)},x=1`;
    expect(parseStripeSignature(h)).toEqual({ t: T, v1: ["a".repeat(64), "c".repeat(64)] });
    expect(parseStripeSignature("v1=abc")).toBeNull();
    expect(parseStripeSignature(null)).toBeNull();
  });

  it("accepts Stripe's HMAC-SHA256 over '<t>.<body>' within 5 minutes", async () => {
    const h = `t=${T},v1=${sign(body, T)}`;
    expect(await verifyStripeSignature(body, h, SECRET, NOW)).toEqual({ ok: true, t: T });
    expect(await stripeSignatureHeader(body, SECRET, T)).toBe(h);
    expect((await verifyStripeSignature(body, `t=${T - 299},v1=${sign(body, T - 299)}`, SECRET, NOW)).ok).toBe(true);
  });

  it("accepts any v1 while a secret is being rolled", async () => {
    const h = `t=${T},v1=${sign(body, T, "whsec_old_secret_value")},v1=${sign(body, T)}`;
    expect((await verifyStripeSignature(body, h, SECRET, NOW)).ok).toBe(true);
  });

  it("rejects a wrong secret, a changed body, an old or future timestamp and a missing header", async () => {
    expect(await verifyStripeSignature(body, `t=${T},v1=${sign(body, T, "whsec_other_secret_x")}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
    expect((await verifyStripeSignature(`${body} `, `t=${T},v1=${sign(body, T)}`, SECRET, NOW)).ok).toBe(false);
    expect(await verifyStripeSignature(body, `t=${T - 301},v1=${sign(body, T - 301)}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: "timestamp_outside_tolerance",
    });
    expect((await verifyStripeSignature(body, `t=${T + 301},v1=${sign(body, T + 301)}`, SECRET, NOW)).ok).toBe(false);
    expect(await verifyStripeSignature(body, undefined, SECRET, NOW)).toEqual({ ok: false, reason: "missing_signature" });
  });
});

describe("Stripe events -> payments", () => {
  const ev = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: `evt_${type.replace(/\W/g, "")}`,
    type,
    created: T,
    livemode: true,
    data: { object: { id: "obj_1", ...object } },
    ...extra,
  });

  it("amounts: two-, zero- and three-decimal currencies", () => {
    expect(minorToMajor(4900, "usd")).toBe(49);
    expect(minorToMajor(5000, "JPY")).toBe(5000);
    expect(minorToMajor(12345, "KWD")).toBe(12.345);
  });

  it("checkout (payment mode, paid) is a new payment keyed on its PaymentIntent", () => {
    const a = normalizeStripeEvent(
      ev("checkout.session.completed", {
        id: "cs_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 4900,
        currency: "usd",
        payment_intent: "pi_1",
        customer: "cus_1",
        metadata: { afs_visitor_id: "0123456789abcdef" },
      }),
    );
    expect(a).toEqual({
      action: "record",
      record: expect.objectContaining({
        provider: "stripe",
        event_id: "evt_checkoutsessioncompleted",
        type: "new",
        external_id: "pi_1",
        amount: 49,
        currency: "USD",
        ts: NOW,
        customer: "cus_1",
        visitor_id: "0123456789abcdef",
        livemode: true,
      }),
    });
  });

  it("checkout in subscription mode only links the customer (revenue comes from invoice.paid)", () => {
    const a = normalizeStripeEvent(
      ev("checkout.session.completed", { mode: "subscription", customer: "cus_2", client_reference_id: "afs_abcdef0123456789" }),
    );
    expect(a).toMatchObject({
      action: "record",
      record: { type: "link", amount: 0, customer: "cus_2", visitor_id: "abcdef0123456789", user_id: null },
    });
  });

  it("invoices: subscription_create is new, subscription_cycle is a renewal, $0 is ignored", () => {
    const inv = (reason: string, amount = 1900) =>
      normalizeStripeEvent(
        ev("invoice.paid", { id: "in_1", amount_paid: amount, currency: "eur", billing_reason: reason, customer: "cus_3" }),
      );
    expect(inv("subscription_create")).toMatchObject({ record: { type: "new", external_id: "in_1", amount: 19, currency: "EUR" } });
    expect(inv("subscription_cycle")).toMatchObject({ record: { type: "renewal" } });
    expect(inv("subscription_cycle", 0)).toMatchObject({ action: "ignore" });
  });

  it("subscription metadata on the invoice (old and new API shapes) links the visitor", () => {
    const old = ev("invoice.paid", {
      amount_paid: 100,
      currency: "usd",
      subscription_details: { metadata: { afs_visitor_id: "visitor_old_1" } },
    });
    const basil = ev("invoice.paid", {
      amount_paid: 100,
      currency: "usd",
      parent: { subscription_details: { metadata: { afs_visitor_id: "visitor_new_1" } } },
    });
    expect(normalizeStripeEvent(old)).toMatchObject({ record: { visitor_id: "visitor_old_1" } });
    expect(normalizeStripeEvent(basil)).toMatchObject({ record: { visitor_id: "visitor_new_1" } });
  });

  it("charge.refunded is a cumulative refund pointing at the paid object", () => {
    const a = normalizeStripeEvent(
      ev("charge.refunded", { id: "ch_1", amount_refunded: 1500, currency: "usd", payment_intent: "pi_1", customer: "cus_1" }),
    );
    expect(a).toMatchObject({ record: { type: "refund", external_id: "refund:ch_1", amount: 15, original_refs: ["pi_1"] } });
  });

  it("payment_intent.succeeded counts only with afs_* metadata and no invoice", () => {
    const pi = (o: Record<string, unknown>) =>
      normalizeStripeEvent(ev("payment_intent.succeeded", { amount_received: 500, currency: "usd", ...o }));
    expect(pi({})).toMatchObject({ action: "ignore" });
    expect(pi({ metadata: { afs_visitor_id: "abcdefgh12345678" }, invoice: "in_9" })).toMatchObject({ action: "ignore" });
    expect(pi({ metadata: { afs_visitor_id: "abcdefgh12345678" } })).toMatchObject({ record: { type: "new", amount: 5 } });
  });

  it("metadata is untrusted: bad ids are dropped, client_reference_id may be a user id", () => {
    expect(linkIdentifiers({ metadata: { afs_visitor_id: "x".repeat(65), afs_session_id: "nope" } })).toEqual({
      visitor_id: null,
      session_id: null,
      user_id: null,
    });
    expect(linkIdentifiers({ client_reference_id: "42" })).toEqual({ visitor_id: null, session_id: null, user_id: "42" });
    expect(linkIdentifiers({ client_reference_id: "user_12345678" })).toEqual({
      visitor_id: "user_12345678",
      session_id: null,
      user_id: "user_12345678",
    });
    expect(linkIdentifiers({ metadata: { afs_session_id: "s0123456789abcde" } }).session_id).toBe("s0123456789abcde");
  });

  it("everything else is acknowledged and ignored", () => {
    expect(normalizeStripeEvent(ev("customer.created", {}))).toMatchObject({ action: "ignore" });
    expect(normalizeStripeEvent({ nope: true })).toMatchObject({ action: "ignore" });
    expect(normalizeStripeEvent(ev("checkout.session.completed", { mode: "setup" }))).toMatchObject({ action: "ignore" });
  });
});
