import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { applySubscriptions, listSubscriptions, mrrReport, snapshotHistory } from "../../src/do/subscriptions";
import { deleteIdentity } from "../../src/do/privacy";
import { type SubscriptionInput, monthlyAmount, stripeSubscriptionState, transitions } from "../../src/lib/subscriptions";
import { DAY, MIN, NOW, ev, google, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const sub = (over: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  provider: "stripe",
  external_id: "sub_1",
  customer: null,
  status: "active",
  plan: "pro",
  currency: "USD",
  mrr: 50,
  price_mrr: 50,
  interval: "month",
  interval_count: 1,
  quantity: 1,
  trial_start: null,
  trial_end: null,
  started_at: NOW - 10 * DAY,
  canceled_at: null,
  ended_at: null,
  cancel_at_period_end: false,
  ts: NOW - 10 * DAY,
  visitor_id: null,
  session_id: null,
  user_id: null,
  livemode: true,
  ...over,
});

/** A Stripe subscription object (API 2024-06-20 shape), the parts we read. */
const stripeSub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  object: "subscription",
  status: "active",
  currency: "usd",
  customer: "cus_1",
  livemode: true,
  start_date: Math.floor((NOW - 40 * DAY) / 1000),
  created: Math.floor((NOW - 40 * DAY) / 1000),
  items: {
    data: [
      {
        quantity: 2,
        price: { id: "price_1", nickname: "Team", unit_amount: 1200, currency: "usd", recurring: { interval: "year", interval_count: 1 } },
      },
    ],
  },
  metadata: { afs_visitor_id: "visitor_abc123" },
  ...over,
});

describe("MRR of a subscription", () => {
  it("normalises intervals to a month", () => {
    expect(monthlyAmount(120, "year")).toBe(10);
    expect(monthlyAmount(30, "month", 3)).toBe(10);
    expect(monthlyAmount(12, "week")).toBeCloseTo(52, 6);
    expect(monthlyAmount(1, "day")).toBeCloseTo(365 / 12, 6);
  });

  it("reads Stripe items, quantity, discounts, pauses and statuses", () => {
    const s = stripeSubscriptionState(stripeSub(), NOW, NOW)!;
    // 2 seats x 12.00 a year = 2.00 a month
    expect(s).toMatchObject({
      status: "active",
      mrr: 2,
      price_mrr: 2,
      currency: "USD",
      plan: "Team",
      quantity: 2,
      interval: "year",
      visitor_id: "visitor_abc123",
      customer_raw: "cus_1",
    });
    const pct = stripeSubscriptionState(stripeSub({ discount: { coupon: { duration: "forever", percent_off: 25 } } }), NOW, NOW)!;
    expect(pct.mrr).toBe(1.5);
    const once = stripeSubscriptionState(stripeSub({ discount: { coupon: { duration: "once", percent_off: 50 } } }), NOW, NOW)!;
    expect(once.mrr).toBe(2);
    const ended = stripeSubscriptionState(
      stripeSub({ discount: { end: Math.floor((NOW - DAY) / 1000), coupon: { duration: "repeating", percent_off: 50 } } }),
      NOW,
      NOW,
    )!;
    expect(ended.mrr).toBe(2);
    // amount_off is per invoice (a year here): 12.00 off a year = 1.00 a month
    const off = stripeSubscriptionState(
      stripeSub({ discount: { coupon: { duration: "forever", amount_off: 1200, currency: "usd" } } }),
      NOW,
      NOW,
    )!;
    expect(off.mrr).toBe(1);
    const paused = stripeSubscriptionState(stripeSub({ pause_collection: { behavior: "void" } }), NOW, NOW)!;
    expect([paused.mrr, paused.price_mrr]).toEqual([0, 2]);
    expect(stripeSubscriptionState(stripeSub({ status: "trialing" }), NOW, NOW)!.mrr).toBe(0);
    expect(stripeSubscriptionState(stripeSub({ status: "past_due" }), NOW, NOW)!.mrr).toBe(2);
    expect(stripeSubscriptionState(stripeSub({ status: "bogus" }), NOW, NOW)).toBeNull();
    // zero-decimal currency
    const jpy = stripeSubscriptionState(
      stripeSub({ currency: "jpy", items: { data: [{ price: { unit_amount: 1000, recurring: { interval: "month" } } }] } }),
      NOW,
      NOW,
    )!;
    expect(jpy.mrr).toBe(1000);
  });

  it("derives movements between states", () => {
    const k = (c: ReturnType<typeof transitions>) => c.map((x) => x.kind);
    expect(k(transitions(null, { status: "trialing", mrr: 0 }, false))).toEqual(["trial_start"]);
    expect(k(transitions({ status: "trialing", mrr: 0 }, { status: "active", mrr: 10 }, false))).toEqual(["trial_converted", "new"]);
    expect(k(transitions({ status: "trialing", mrr: 0 }, { status: "canceled", mrr: 0 }, false))).toEqual(["trial_canceled"]);
    expect(k(transitions({ status: "active", mrr: 10 }, { status: "active", mrr: 20 }, true))).toEqual(["expansion"]);
    expect(k(transitions({ status: "active", mrr: 20 }, { status: "active", mrr: 5 }, true))).toEqual(["contraction"]);
    expect(k(transitions({ status: "active", mrr: 20 }, { status: "canceled", mrr: 0 }, true))).toEqual(["churn"]);
    expect(k(transitions({ status: "paused", mrr: 0 }, { status: "active", mrr: 20 }, true))).toEqual(["reactivation"]);
    expect(k(transitions({ status: "active", mrr: 20 }, { status: "past_due", mrr: 20 }, true))).toEqual([]);
  });

  it("reconstructs the history of a first-seen subscription from its dates", () => {
    const k = (p: Partial<SubscriptionInput>) =>
      snapshotHistory({ ...sub(p), price_mrr: p.price_mrr ?? 50 }).map((c) => `${c.kind}@${(NOW - c.ts) / DAY}`);
    expect(k({})).toEqual(["new@10"]);
    expect(k({ status: "trialing", mrr: 0, trial_start: NOW - 3 * DAY, trial_end: NOW + 11 * DAY })).toEqual(["trial_start@3"]);
    expect(k({ trial_start: NOW - 30 * DAY, trial_end: NOW - 16 * DAY, started_at: NOW - 30 * DAY })).toEqual([
      "trial_start@30",
      "trial_converted@16",
      "new@16",
    ]);
    expect(k({ status: "canceled", mrr: 0, trial_start: NOW - 30 * DAY, trial_end: NOW - 16 * DAY, ended_at: NOW - 20 * DAY })).toEqual([
      "trial_start@30",
      "trial_canceled@20",
    ]);
    expect(k({ status: "canceled", mrr: 0, ended_at: NOW - 2 * DAY })).toEqual(["new@10", "churn@2"]);
    expect(k({ status: "incomplete_expired", mrr: 0 })).toEqual([]);
  });
});

describe("subscriptions in the site's DO", () => {
  let db: ReturnType<typeof memoryDb>;
  const s = settings({ visitor_id_mode: "persistent" });
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, s);
    engine.ingest(db, [ev({ ts: NOW - 41 * DAY, visitor_hash: "visitor_abc123", ...google })], NOW);
    engine.ingest(
      db,
      [
        ev({
          ts: NOW - 41 * DAY,
          visitor_hash: "visitor_def456",
          utm_source: "newsletter",
          utm_campaign: "launch",
          source: "newsletter",
          channel: "Email",
        }),
      ],
      NOW,
    );
  });

  it("applies states once, ignores stale ones and attributes to the linked session", () => {
    const first = applySubscriptions(db, [sub({ visitor_id: "visitor_abc123", started_at: NOW - 40 * DAY, ts: NOW - 40 * DAY })], NOW);
    expect(first[0]).toMatchObject({ ok: true, existing: false, changed: true, linked_by: "visitor", changes: ["new"] });
    expect(
      applySubscriptions(db, [sub({ visitor_id: "visitor_abc123", started_at: NOW - 40 * DAY, ts: NOW - 40 * DAY })], NOW)[0],
    ).toMatchObject({ existing: true, changed: false });
    const up = applySubscriptions(db, [sub({ mrr: 80, price_mrr: 80, ts: NOW - 5 * DAY })], NOW);
    expect(up[0]).toMatchObject({ changed: true, changes: ["expansion"] });
    // A late retry of an older state changes nothing.
    expect(applySubscriptions(db, [sub({ mrr: 50, ts: NOW - 20 * DAY })], NOW)[0]).toMatchObject({ stale: true, changed: false });
    const list = listSubscriptions(db, { limit: 10, offset: 0 }) as any;
    expect(list.subscriptions[0]).toMatchObject({ mrr: 80, channel: "Organic Search", source: "Google", linked_by: "visitor" });
  });

  it("reports MRR, movements, churn, trial conversion and breakdowns", () => {
    applySubscriptions(
      db,
      [
        sub({
          external_id: "sub_a",
          visitor_id: "visitor_abc123",
          started_at: NOW - 40 * DAY,
          ts: NOW - 40 * DAY,
          mrr: 100,
          price_mrr: 100,
        }),
        sub({ external_id: "sub_b", visitor_id: "visitor_def456", started_at: NOW - 35 * DAY, ts: NOW - 35 * DAY, mrr: 50, price_mrr: 50 }),
        sub({
          external_id: "sub_t",
          status: "trialing",
          mrr: 0,
          trial_start: NOW - 25 * DAY,
          trial_end: NOW - 11 * DAY,
          started_at: NOW - 25 * DAY,
          ts: NOW - 25 * DAY,
        }),
      ],
      NOW,
    );
    applySubscriptions(
      db,
      [
        sub({
          external_id: "sub_t",
          status: "active",
          mrr: 30,
          price_mrr: 30,
          trial_start: NOW - 25 * DAY,
          trial_end: NOW - 11 * DAY,
          ts: NOW - 11 * DAY,
        }),
      ],
      NOW,
    );
    applySubscriptions(
      db,
      [sub({ external_id: "sub_b", status: "canceled", mrr: 0, price_mrr: 50, ended_at: NOW - 3 * DAY, ts: NOW - 3 * DAY })],
      NOW,
    );
    applySubscriptions(db, [sub({ external_id: "sub_a", mrr: 120, price_mrr: 120, ts: NOW - 2 * DAY })], NOW);
    // Test mode: out of MRR unless include_test.
    applySubscriptions(db, [sub({ external_id: "sub_test", livemode: false, mrr: 999, price_mrr: 999 })], NOW);

    const r = mrrReport(db, s, { period: "30d", breakdown: "channel" } as any, NOW) as any;
    expect(r.current).toMatchObject({ mrr: 150, arr: 1800, active_subscriptions: 2, trialing: 0, currency: "USD" });
    expect(r.totals).toMatchObject({
      mrr_at_start: 150,
      mrr_at_end: 150,
      new_mrr: 30,
      expansion_mrr: 20,
      churned_mrr: 50,
      contraction_mrr: 0,
      trials_started: 1,
      trials_converted: 1,
      trial_conversion_rate: 100,
      customer_churn_rate: 50,
      revenue_churn_rate: 33.3,
    });
    expect(r.series.at(-1).mrr).toBe(150);
    const byChannel = Object.fromEntries(r.breakdown.results.map((x: any) => [x.value, x]));
    expect(byChannel["Organic Search"]).toMatchObject({ mrr: 120, expansion_mrr: 20 });
    expect(byChannel.Email).toMatchObject({ mrr: 0, churned_mrr: 50, customer_churn_rate: 100 });
    expect(byChannel["(none)"]).toMatchObject({ mrr: 30, new_mrr: 30, trials_converted: 1 });
    const withTest = mrrReport(db, s, { period: "30d", include_test: true } as any, NOW) as any;
    expect(withTest.current.mrr).toBe(1149);
    const old = mrrReport(db, s, { period: "90d", interval: "month" } as any, NOW) as any;
    expect(old.totals.mrr_at_start).toBe(0);
    expect(old.totals.new_mrr).toBe(180);
  });

  it("reports per currency when subscriptions are in more than one", () => {
    applySubscriptions(
      db,
      [sub({ external_id: "sub_e", currency: "EUR", mrr: 10, price_mrr: 10 }), sub({ external_id: "sub_u", mrr: 20, price_mrr: 20 })],
      NOW,
    );
    const r = mrrReport(db, s, { period: "30d" } as any, NOW) as any;
    expect(r.current.mrr).toBeNull();
    expect(r.current.by_currency).toEqual({ EUR: { mrr: 10, active: 1 }, USD: { mrr: 20, active: 1 } });
    expect(r.note).toMatch(/currency/);
  });

  it("erasure unlinks (or deletes) the person's subscriptions", () => {
    applySubscriptions(db, [sub({ visitor_id: "visitor_abc123", started_at: NOW - 40 * DAY, ts: NOW - 40 * DAY })], NOW);
    const out = deleteIdentity(db, "visitor_abc123") as any;
    expect(out.subscriptions).toEqual({ unlinked: 1 });
    const row = db.all("SELECT visitor_id, session_id, channel, mrr FROM subscriptions")[0]!;
    expect(row).toMatchObject({ visitor_id: null, session_id: null, channel: "Organic Search", mrr: 50 });
    applySubscriptions(db, [sub({ external_id: "sub_2", visitor_id: "visitor_def456", ts: NOW - MIN })], NOW);
    expect((deleteIdentity(db, "visitor_def456", { payments: "delete" }) as any).subscriptions).toEqual({ deleted: 1 });
    expect(db.all("SELECT COUNT(*) AS n FROM subscription_changes WHERE sub_ref = 'stripe:sub_2'")[0]!.n).toBe(0);
  });
});
