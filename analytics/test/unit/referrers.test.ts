import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { DEFAULT_IGNORED_REFERRERS, normalizeHostList, normalizeHostPattern, referrerIgnoredBy } from "../../src/lib/referrers";
import { MIN, NOW, type Rows, ev, google, pay, q, settings, stripeCheckout } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("ignored referrers (lib)", () => {
  it("defaults cover hosted checkouts and sign-in hosts, a pattern covers its subdomains", () => {
    for (const h of [
      "checkout.stripe.com",
      "www.paypal.com",
      "www.sandbox.paypal.com",
      "acme.lemonsqueezy.com",
      "buy.polar.sh",
      "accounts.google.com",
    ])
      expect(referrerIgnoredBy(h, null)).toBe("default");
    for (const h of ["stripe.com", "www.google.com", "news.ycombinator.com", "notpaypal.com"])
      expect(referrerIgnoredBy(h, null)).toBeNull();
    expect(referrerIgnoredBy("pay.mybank.example", ["mybank.example"])).toBe("site");
    expect(DEFAULT_IGNORED_REFERRERS.length).toBeGreaterThan(20);
  });

  it("normalises patterns: scheme, path, port, www. and *. are stripped; junk is refused", () => {
    expect(normalizeHostPattern("https://Pay.Example.com:443/checkout?x=1")).toBe("pay.example.com");
    expect(normalizeHostPattern("*.example.com")).toBe("example.com");
    expect(normalizeHostPattern("www.example.com")).toBe("example.com");
    expect(normalizeHostPattern("not a host")).toBeNull();
    expect(normalizeHostPattern("localhost")).toBeNull();
    expect(normalizeHostList(["a.example", "A.example", "bad host"], "ignored_referrers")).toEqual({
      value: ["a.example"],
      problems: [expect.stringContaining("bad host")],
    });
  });
});

describe("ignored referrers (engine): a visitor back from checkout keeps its source", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
  });

  const channels = () =>
    // NOW pins the "24h" window to the fixtures' clock; without it the window follows the wall clock.
    (engine.breakdown(db, settings(), { ...q({ metrics: ["visitors", "revenue"] }), breakdown: "channel" }, NOW) as Rows).results;

  it("a Direct session that comes back from checkout.stripe.com stays Direct, and so does its payment", () => {
    engine.configure(db, settings());
    // typed the URL, went to /pricing, paid on Stripe Checkout, came back to /thanks within the session
    engine.ingest(db, [ev({ ts: NOW - 20 * MIN, pathname: "/pricing" })], NOW);
    const back = engine.ingest(db, [ev({ ts: NOW - 10 * MIN, pathname: "/thanks", ...stripeCheckout })], NOW);
    expect(back.results[0]).toMatchObject({ ok: true });
    payments.ingestPayments(db, [pay({ ts: NOW - 10 * MIN, visitor_id: "v1", amount: 49 })], NOW);
    expect(channels()).toEqual([{ value: "Direct", visitors: 1, revenue: 49 }]);
    expect(db.all("SELECT channel, source, referrer FROM sessions")).toEqual([{ channel: "Direct", source: null, referrer: null }]);
    expect(db.all("SELECT DISTINCT referrer_host FROM events")).toEqual([{ referrer_host: null }]);
  });

  it("without the rule (a host no list ignores) the same journey would be credited to Referral", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ ts: NOW - 20 * MIN, pathname: "/pricing" })], NOW);
    const other = { ...stripeCheckout, source: "pay.unknown-psp.example", referrer_host: "pay.unknown-psp.example" };
    engine.ingest(db, [ev({ ts: NOW - 10 * MIN, pathname: "/thanks", ...other })], NOW);
    payments.ingestPayments(db, [pay({ ts: NOW - 10 * MIN, visitor_id: "v1", amount: 49 })], NOW);
    expect(channels()).toEqual([{ value: "Referral", visitors: 1, revenue: 49 }]);
  });

  it("a site's own ignored_referrers work like the defaults", () => {
    engine.configure(db, settings({ ignored_referrers: ["unknown-psp.example"] }));
    engine.ingest(db, [ev({ ts: NOW - 20 * MIN, pathname: "/pricing" })], NOW);
    const other = { ...stripeCheckout, source: "pay.unknown-psp.example", referrer_host: "pay.unknown-psp.example" };
    engine.ingest(db, [ev({ ts: NOW - 10 * MIN, pathname: "/thanks", ...other })], NOW);
    expect(channels()).toEqual([{ value: "Direct", visitors: 1, revenue: 0 }]);
  });

  it("a Google visitor back from checkout after the session timed out continues as Google, not Referral or Direct", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ ts: NOW - 90 * MIN, pathname: "/pricing", ...google })], NOW);
    // 3-D Secure took a while: back 45 minutes later, a new session
    engine.ingest(db, [ev({ ts: NOW - 45 * MIN, pathname: "/thanks", ...stripeCheckout })], NOW);
    payments.ingestPayments(db, [pay({ ts: NOW - 45 * MIN, visitor_id: "v1", amount: 99 })], NOW);
    const sessions = db.all("SELECT channel, source FROM sessions ORDER BY started_at");
    expect(sessions).toEqual([
      { channel: "Organic Search", source: "Google" },
      { channel: "Organic Search", source: "Google" },
    ]);
    expect(channels()).toEqual([{ value: "Organic Search", visitors: 1, revenue: 99 }]);
  });

  it("UTM tags on the return URL still count; a real referrer later in a Direct session is still adopted", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ ts: NOW - 20 * MIN, ...stripeCheckout, utm_source: "newsletter", utm_medium: "email" })], NOW);
    expect(db.all("SELECT channel, source FROM sessions")).toEqual([{ channel: "Email", source: "Newsletter" }]);
    engine.ingest(db, [ev({ ts: NOW - 5 * MIN, visitor_hash: "v2" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 4 * MIN, visitor_hash: "v2", ...google })], NOW);
    expect(db.all("SELECT channel FROM sessions WHERE visitor_id = 'v2'")).toEqual([{ channel: "Organic Search" }]);
  });
});
