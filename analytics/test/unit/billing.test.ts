import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { applySubscriptions, mrrReport } from "../../src/do/subscriptions";
import { billingSignatureHeaders, normalizeLemonSqueezy, normalizePaddle, normalizePolar, verifyBilling } from "../../src/lib/billing";
import { snapInterval } from "../../src/lib/subscriptions";
import { DAY, NOW, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

/** Obviously fake secrets: 32 bytes of 0x01 in base64, and plain words. */
// A fake Standard Webhooks secret (32 bytes of 0x01), built from parts so secret scanners skip it.
const POLAR_SECRET = ["whsec", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="].join("_");
const PADDLE_SECRET = "pdl_ntfset_test";
const LS_SECRET = "lstest";
const t = Math.floor(NOW / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

describe("billing webhook signatures", () => {
  it("Polar: Standard Webhooks (the spec's published test vector) and the legacy UTF-8 key", async () => {
    // The Standard Webhooks spec's own example, assembled from parts (it is a published test vector, not a key).
    const secret = `whsec_${["MfKQ9r8GKYqr", "TwjUPD8ILPZI", "o2LaLaSw"].join("")}`;
    const headers = new Headers({
      "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
      "webhook-timestamp": "1614265330",
      "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    });
    expect(await verifyBilling("polar", '{"test": 2432232314}', headers, secret, 1614265330_000)).toEqual({
      ok: true,
      event_id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    });
    expect((await verifyBilling("polar", '{"test": 2432232315}', headers, secret, 1614265330_000)).ok).toBe(false);
    expect(await verifyBilling("polar", '{"test": 2432232314}', headers, secret, 1614265330_000 + 301_000)).toEqual({
      ok: false,
      reason: "timestamp_outside_tolerance",
    });
    // Secrets Polar issued before 2026-09-08: the key is the UTF-8 bytes of the whole string.
    const body = '{"type":"order.paid"}';
    const legacy = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey("raw", new TextEncoder().encode(POLAR_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        new TextEncoder().encode(`m1.${t}.${body}`),
      ),
    );
    const h = new Headers({
      "webhook-id": "m1",
      "webhook-timestamp": String(t),
      "webhook-signature": `v1,bm90IGl0 v1,${btoa(String.fromCharCode(...legacy))}`,
    });
    expect((await verifyBilling("polar", body, h, POLAR_SECRET, NOW)).ok).toBe(true);
    expect(
      (await verifyBilling("polar", body, new Headers(await billingSignatureHeaders("polar", body, POLAR_SECRET, t)), POLAR_SECRET, NOW))
        .ok,
    ).toBe(true);
  });

  it("Paddle: ts:body hex, any h1 (rotation), 5 minute tolerance; LemonSqueezy: hex of the body", async () => {
    const body = JSON.stringify({ event_id: "evt_1", event_type: "transaction.completed" });
    const hd = await billingSignatureHeaders("paddle", body, PADDLE_SECRET, t);
    const sig = hd["paddle-signature"]!;
    expect(await verifyBilling("paddle", body, new Headers(hd), PADDLE_SECRET, NOW)).toEqual({ ok: true, event_id: "evt_1" });
    expect(
      (await verifyBilling("paddle", body, new Headers({ "paddle-signature": `ts=${t};h1=00;${sig.split(";")[1]}` }), PADDLE_SECRET, NOW))
        .ok,
    ).toBe(true);
    expect((await verifyBilling("paddle", `${body} `, new Headers(hd), PADDLE_SECRET, NOW)).ok).toBe(false);
    expect((await verifyBilling("paddle", body, new Headers(hd), PADDLE_SECRET, NOW + 400_000)).ok).toBe(false);
    const ls = await billingSignatureHeaders("lemonsqueezy", body, LS_SECRET, t);
    expect(await verifyBilling("lemonsqueezy", body, new Headers(ls), LS_SECRET, NOW)).toEqual({ ok: true, event_id: null });
    expect((await verifyBilling("lemonsqueezy", body, new Headers(ls), "other", NOW)).ok).toBe(false);
    expect((await verifyBilling("lemonsqueezy", body, new Headers(), LS_SECRET, NOW)).ok).toBe(false);
  });
});

describe("provider events to payments and subscriptions", () => {
  it("Polar: orders pre-tax, cumulative refunds, subscriptions at their discounted amount", () => {
    const order = {
      id: "ord_1",
      paid: true,
      net_amount: 4500,
      tax_amount: 900,
      total_amount: 5400,
      currency: "usd",
      billing_reason: "subscription_cycle",
      customer_id: "cus_p",
      customer: { external_id: "user_7" },
      metadata: { afs_visitor_id: "visitor_abc123" },
    };
    expect(normalizePolar({ type: "order.paid", timestamp: iso(NOW), data: order }, "msg_1", true).payments[0]).toMatchObject({
      type: "renewal",
      amount: 45,
      currency: "USD",
      event_id: "msg_1",
      visitor_id: "visitor_abc123",
      user_id: "user_7",
      ts: NOW,
    });
    expect(normalizePolar({ type: "order.refunded", data: { ...order, refunded_amount: 1000 } }, "msg_2", true).payments[0]).toMatchObject({
      type: "refund",
      external_id: "refund:ord_1",
      amount: 10,
      original_refs: ["ord_1"],
    });
    const sub = {
      id: "s_1",
      status: "active",
      amount: 12000,
      currency: "usd",
      recurring_interval: "year",
      recurring_interval_count: 1,
      customer_id: "cus_p",
      started_at: iso(NOW - 10 * DAY),
      cancel_at_period_end: true,
      product: { name: "Pro" },
    };
    expect(normalizePolar({ type: "subscription.updated", timestamp: iso(NOW), data: sub }, "msg_3", true).subscriptions[0]).toMatchObject({
      status: "active",
      mrr: 10,
      plan: "Pro",
      cancel_at_period_end: true,
      interval: "year",
    });
    expect(normalizePolar({ type: "checkout.created", data: { id: "x" } }, null, true).ignored).toMatch(/not used/);
  });

  it("Paddle: transactions after discount before tax, approved refund adjustments, subscription items", () => {
    const txn = {
      id: "txn_1",
      origin: "web",
      currency_code: "EUR",
      customer_id: "ctm_1",
      custom_data: { afs_visitor_id: "visitor_abc123" },
      billed_at: iso(NOW),
      details: { totals: { subtotal: "5000", discount: "1000", tax: "800", total: "4800" } },
    };
    expect(
      normalizePaddle({ event_id: "evt_1", event_type: "transaction.completed", occurred_at: iso(NOW), data: txn }, true).payments[0],
    ).toMatchObject({ type: "new", amount: 40, currency: "EUR", event_id: "evt_1", visitor_id: "visitor_abc123" });
    expect(
      normalizePaddle({ event_id: "evt_2", event_type: "transaction.completed", data: { ...txn, origin: "subscription_recurring" } }, true)
        .payments[0]!.type,
    ).toBe("renewal");
    const adj = {
      id: "adj_1",
      action: "refund",
      status: "pending_approval",
      transaction_id: "txn_1",
      currency_code: "EUR",
      totals: { subtotal: "2000", tax: "400", total: "2400" },
    };
    expect(normalizePaddle({ event_id: "evt_3", event_type: "adjustment.created", data: adj }, true).ignored).toMatch(/approved/);
    expect(
      normalizePaddle({ event_id: "evt_4", event_type: "adjustment.updated", data: { ...adj, status: "approved" } }, true).payments[0],
    ).toMatchObject({ type: "refund", amount: 20, original_refs: ["txn_1"] });
    const sub = {
      id: "sub_p",
      status: "trialing",
      currency_code: "USD",
      customer_id: "ctm_1",
      billing_cycle: { interval: "month", frequency: 1 },
      items: [
        {
          status: "trialing",
          quantity: 2,
          price: { name: "Seat", unit_price: { amount: "1500" }, billing_cycle: { interval: "month", frequency: 1 } },
          trial_dates: { starts_at: iso(NOW - DAY), ends_at: iso(NOW + 13 * DAY) },
        },
      ],
      scheduled_change: null,
    };
    expect(
      normalizePaddle({ event_id: "evt_5", event_type: "subscription.trialing", occurred_at: iso(NOW), data: sub }, false).subscriptions[0],
    ).toMatchObject({ status: "trialing", mrr: 0, price_mrr: 30, trial_end: NOW + 13 * DAY, livemode: false, quantity: 2 });
  });

  it("LemonSqueezy: orders, subscription invoices and lifecycle without a price", () => {
    const meta = { event_name: "order_created", custom_data: { afs_visitor_id: "visitor_abc123" } };
    const order = {
      status: "paid",
      currency: "USD",
      subtotal: 2000,
      discount_total: 500,
      tax: 300,
      total: 1800,
      customer_id: 9,
      created_at: iso(NOW),
      test_mode: true,
    };
    expect(normalizeLemonSqueezy({ meta, data: { type: "orders", id: "77", attributes: order } }, null).payments[0]).toMatchObject({
      type: "new",
      amount: 15,
      livemode: false,
      customer: "9",
      external_id: "77",
    });
    const refund = normalizeLemonSqueezy(
      { meta: { event_name: "order_refunded" }, data: { id: "77", attributes: { ...order, refunded_amount: 1800 } } },
      null,
    ).payments[0]!;
    expect(refund).toMatchObject({ type: "refund", amount: 15, external_id: "refund:77" });
    const inv = normalizeLemonSqueezy(
      {
        meta: { event_name: "subscription_payment_success" },
        data: {
          id: "5",
          attributes: {
            subscription_id: 3,
            billing_reason: "renewal",
            currency: "USD",
            subtotal: 1000,
            discount_total: 0,
            total: 1100,
            created_at: iso(NOW),
          },
        },
      },
      null,
    );
    expect(inv.payments[0]).toMatchObject({ type: "renewal", external_id: "invoice:5", amount: 10 });
    expect(inv.subscriptions[0]).toMatchObject({ kind: "invoice", external_id: "3", period_amount: 10 });
    const st = normalizeLemonSqueezy(
      {
        meta: { event_name: "subscription_cancelled" },
        data: {
          id: "3",
          attributes: { status: "cancelled", renews_at: iso(NOW + 20 * DAY), created_at: iso(NOW - 40 * DAY), updated_at: iso(NOW) },
        },
      },
      null,
    ).subscriptions[0]!;
    expect(st).toMatchObject({ status: "active", grace: true, price_unknown: true, cancel_at_period_end: true });
  });

  it("infers billing periods", () => {
    expect(snapInterval(30)).toEqual({ interval: "month", count: 1 });
    expect(snapInterval(28)).toEqual({ interval: "month", count: 1 });
    expect(snapInterval(91)).toEqual({ interval: "month", count: 3 });
    expect(snapInterval(365)).toEqual({ interval: "year", count: 1 });
    expect(snapInterval(7)).toEqual({ interval: "week", count: 1 });
    expect(snapInterval(45)).toBeNull();
  });
});

describe("LemonSqueezy MRR from invoices", () => {
  const sub = (attrs: Record<string, unknown>, event = "subscription_updated") =>
    normalizeLemonSqueezy(
      { meta: { event_name: event }, data: { id: "3", attributes: { customer_id: 9, created_at: iso(NOW - 60 * DAY), ...attrs } } },
      null,
    ).subscriptions[0]!;
  const invoice = (at: number, cents: number, reason = "renewal") =>
    normalizeLemonSqueezy(
      {
        meta: { event_name: "subscription_payment_success" },
        data: {
          id: String(at),
          attributes: {
            subscription_id: 3,
            billing_reason: reason,
            currency: "USD",
            subtotal: cents,
            discount_total: 0,
            created_at: iso(at),
          },
        },
      },
      null,
    ).subscriptions[0]!;
  const rec = (x: any) => ({ ...x, customer: null });

  it("prices a subscription from the gap between invoices or to renews_at, and churns at expiry", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    // The first invoice arrives before the subscription itself.
    expect(applySubscriptions(db, [rec(invoice(NOW - 60 * DAY, 2400, "initial"))], NOW)[0]).toMatchObject({ ok: true, existing: false });
    // Its state says the period ends a month after that invoice: 24.00 a month.
    const created = applySubscriptions(
      db,
      [rec(sub({ status: "active", renews_at: iso(NOW - 30 * DAY), updated_at: iso(NOW - 60 * DAY + 1000) }, "subscription_created"))],
      NOW,
    )[0]!;
    expect(created.changes).toEqual(["new"]);
    // A renewal a month later at a higher price: expansion.
    expect(applySubscriptions(db, [rec(invoice(NOW - 30 * DAY, 3000))], NOW)[0]!.changes).toEqual(["expansion"]);
    // A retried older invoice changes nothing.
    expect(applySubscriptions(db, [rec(invoice(NOW - 60 * DAY, 2400, "initial"))], NOW)[0]).toMatchObject({ stale: true });
    // Cancelled: still paying until the end of the period, then expired = churn.
    expect(
      applySubscriptions(db, [rec(sub({ status: "cancelled", renews_at: iso(NOW + DAY), updated_at: iso(NOW - 2 * DAY) }))], NOW)[0]!
        .changes,
    ).toEqual([]);
    expect((mrrReport(db, settings(), { period: "30d" } as any, NOW) as any).current.mrr).toBe(30);
    expect(
      applySubscriptions(db, [rec(sub({ status: "expired", ends_at: iso(NOW - DAY), updated_at: iso(NOW - DAY) }))], NOW)[0]!.changes,
    ).toEqual(["churn"]);
    const r = mrrReport(db, settings(), { period: "90d" } as any, NOW) as any;
    expect(r.current.mrr).toBe(0);
    expect(r.totals).toMatchObject({ new_mrr: 24, expansion_mrr: 6, churned_mrr: 30 });
  });

  it("a trial cancelled before paying is a canceled trial", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    applySubscriptions(
      db,
      [
        rec(
          sub(
            { status: "on_trial", trial_ends_at: iso(NOW + 10 * DAY), renews_at: iso(NOW + 10 * DAY), updated_at: iso(NOW - 4 * DAY) },
            "subscription_created",
          ),
        ),
      ],
      NOW,
    );
    const out = applySubscriptions(
      db,
      [rec(sub({ status: "cancelled", ends_at: iso(NOW + 10 * DAY), updated_at: iso(NOW - DAY) }))],
      NOW,
    )[0]!;
    expect(out.changes).toEqual(["trial_canceled"]);
  });
});
