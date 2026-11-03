import { beforeEach, describe, expect, it } from "vitest";
import * as annotations from "../../src/do/annotations";
import * as engine from "../../src/do/engine";
import { insights } from "../../src/do/insights";
import * as payments from "../../src/do/payments";
import * as people from "../../src/do/people";
import { METRICS, type Metric, parseFilters } from "../../src/lib/filters";
import type { EnrichedEvent, PaymentInput, SiteSettings } from "../../src/lib/types";
import { memoryDb } from "./sqlite";

const NOW = Date.UTC(2026, 10, 3, 15, 0); // Tue 3 Nov 2026, 15:00 UTC
const MIN = 60_000;
const DAY = 86_400_000;

const settings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  id: "site_test0000000000",
  domain: "example.com",
  name: null,
  timezone: "UTC",
  visitor_id_mode: "cookieless",
  retention_days: 400,
  allowed_hostnames: null,
  respect_dnt: false,
  created_at: NOW,
  goals: [],
  ...over,
});

function ev(over: Partial<EnrichedEvent>): EnrichedEvent {
  return {
    ts: NOW - MIN,
    name: "pageview",
    origin: "browser",
    hostname: "example.com",
    pathname: "/",
    url: "https://example.com/",
    user_id: null,
    props: null,
    revenue: null,
    currency: null,
    engagement_ms: 0,
    visitor_hash: "v1",
    client_visitor_id: null,
    explicit_visitor_id: null,
    dnt: false,
    referrer: null,
    referrer_host: null,
    source: null,
    channel: "Direct",
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_term: null,
    utm_content: null,
    click_id_type: null,
    click_id: null,
    country: null,
    region: null,
    region_code: null,
    city: null,
    continent: null,
    timezone: null,
    latitude: null,
    longitude: null,
    asn: null,
    as_org: null,
    browser: "Chrome",
    browser_version: "130",
    os: "Mac OS",
    os_version: "10.15",
    device: "desktop",
    ...over,
  };
}

const pay = (over: Partial<PaymentInput>): PaymentInput => ({
  provider: "stripe",
  external_id: "pi_1",
  event_id: null,
  type: "new",
  amount: 49,
  currency: "USD",
  ts: NOW - MIN,
  visitor_id: null,
  session_id: null,
  user_id: null,
  customer: null,
  original_refs: [],
  livemode: true,
  ...over,
});

const google = { source: "Google", channel: "Organic Search" as const, referrer_host: "www.google.com", referrer: "google.com" };
const facebook = { source: "Facebook", channel: "Organic Social" as const, referrer_host: "l.facebook.com", referrer: "facebook.com" };
const chatgpt = { source: "ChatGPT", channel: "AI Assistants" as const, referrer_host: "chatgpt.com", referrer: "chatgpt.com" };

type Rows = { results: Record<string, any>[] };
const q = (over: Record<string, unknown> = {}) => ({ period: "24h" as const, metrics: ["visitors"] as Metric[], filters: [], ...over });

let db: ReturnType<typeof memoryDb>;
beforeEach(() => {
  db = memoryDb();
});

describe("in-DO schema migration", () => {
  it("brings a version-1 DO (first release) to the current schema, keeps its data, and is idempotent", () => {
    const old = memoryDb({ migrate: false });
    for (const s of engine.SCHEMA_V1.split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      old.run(s);
    old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    old.run("INSERT INTO events (ts, name, visitor_id, session_id, origin) VALUES (1, 'pageview', 'v', 's', 'browser')");
    old.run("INSERT INTO goals (id, name, type, match, glob, value, created_at) VALUES ('g', 'G', 'event', 'x', NULL, NULL, 1)");
    expect(engine.hasColumn(old, "events", "scroll_depth")).toBe(false);
    engine.migrate(old);
    expect(engine.schemaVersion(old)).toBe(engine.SCHEMA_VERSION);
    for (const c of ["revenue_type", "scroll_depth", "lcp", "inp", "cls"]) expect(engine.hasColumn(old, "events", c)).toBe(true);
    expect(engine.hasColumn(old, "goals", "threshold")).toBe(true);
    expect(engine.hasColumn(old, "events", "id")).toBe(true);
    expect(engine.hasColumn(old, "events", "nope")).toBe(false);
    const tables = old.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('annotations', 'payments', 'payment_links', 'provider_events')",
    );
    expect(tables).toHaveLength(4);
    engine.migrate(old);
    expect(old.all("SELECT COUNT(*) AS n FROM events")[0]!.n).toBe(1);
    expect(old.all("SELECT threshold FROM goals")).toEqual([{ threshold: null }]);
  });

  it("finishes a half-applied step (a column already there) instead of failing", () => {
    const half = memoryDb({ migrate: false });
    for (const s of engine.SCHEMA_V1.split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      half.run(s);
    half.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    half.run("ALTER TABLE events ADD COLUMN revenue_type TEXT");
    engine.migrate(half);
    expect(engine.schemaVersion(half)).toBe(2);
    expect(engine.hasColumn(half, "events", "cls")).toBe(true);
  });

  it("a brand-new DO runs the same migrations", () => {
    expect(engine.schemaVersion(db)).toBe(engine.SCHEMA_VERSION);
  });
});

describe("exclusions at ingest", () => {
  it("drops by IP (v4 + v6 CIDR), path, hostname and country; counts the rule, never stores the IP", () => {
    const s = settings({
      exclusions: { ips: ["203.0.113.0/24", "2001:db8::/32"], paths: ["/admin/*"], hostnames: ["staging.example.com"], countries: ["RU"] },
    });
    engine.configure(db, s);
    const r = engine.ingest(
      db,
      [
        ev({ ip: "203.0.113.9" }),
        ev({ ip: "2001:db8::5", visitor_hash: "v2" }),
        ev({ pathname: "/admin/users", visitor_hash: "v3" }),
        ev({ hostname: "staging.example.com", visitor_hash: "v4" }),
        ev({ country: "RU", visitor_hash: "v5" }),
        ev({ ip: "198.51.100.1", visitor_hash: "v6" }),
        ev({ name: "engagement", ip: "203.0.113.9", engagement_ms: 5000 }),
        ev({ origin: "server", name: "purchase", ip: "203.0.113.50", pathname: null, url: null, visitor_hash: "v7" }),
      ],
      NOW,
    );
    expect(r.results.map((x) => x.reason ?? "ok")).toEqual([
      "excluded_ip",
      "excluded_ip",
      "excluded_path",
      "excluded_hostname",
      "excluded_country",
      "ok",
      "excluded_ip",
      "excluded_ip",
    ]);
    const drops = engine.summary(db, NOW).dropped_last_7d;
    expect(drops.excluded_ip).toMatchObject({ count: 3, sample: "203.0.113.0/24" }); // engagement not counted twice
    expect(drops.excluded_path).toMatchObject({ count: 1, sample: "/admin/*" });
    const everything = JSON.stringify([db.all("SELECT * FROM events"), db.all("SELECT * FROM drops"), db.all("SELECT * FROM sessions")]);
    expect(everything).not.toContain("203.0.113.9");
    expect(everything).not.toContain("198.51.100.1");
    expect(db.all("SELECT COUNT(*) AS n FROM events")[0]!.n).toBe(1);
  });
});

describe("scroll depth, time on page, Web Vitals and scroll goals", () => {
  it("per-page metrics, p75 vitals, and scroll goal conversions", () => {
    const s = settings({ goals: [{ id: "g", name: "Read", type: "scroll", match: "/blog/*", value: null, threshold: 75, created_at: 1 }] });
    engine.configure(db, s);
    const page = (v: string, at: number, eng: Partial<EnrichedEvent> | null) => {
      engine.ingest(db, [ev({ visitor_hash: v, ts: NOW - at * MIN, pathname: "/blog/x" })], NOW);
      if (eng) engine.ingest(db, [ev({ visitor_hash: v, ts: NOW - (at - 2) * MIN, name: "engagement", pathname: "/blog/x", ...eng })], NOW);
    };
    page("a", 10, { engagement_ms: 30_000, scroll_depth: 80, lcp: 1200, inp: 100, cls: 0.05 });
    page("b", 9, { engagement_ms: 10_000, scroll_depth: 40, lcp: 3000, inp: 300, cls: 0.2 });
    page("c", 8, { engagement_ms: 20_000, scroll_depth: 90, lcp: 2000, inp: 250, cls: 0.1 });
    engine.ingest(db, [ev({ visitor_hash: "d", ts: NOW - 5 * MIN, pathname: "/" })], NOW);
    const metrics: Metric[] = ["visitors", "pageviews", "scroll_depth", "time_on_page", "lcp_p75", "inp_p75", "cls_p75", "conversions"];
    const b = engine.breakdown(db, s, { ...q({ metrics }), breakdown: "page" }, NOW) as Rows;
    expect(b.results).toEqual([
      {
        value: "/blog/x",
        visitors: 3,
        pageviews: 3,
        scroll_depth: 70,
        time_on_page: 20,
        lcp_p75: 3000,
        inp_p75: 300,
        cls_p75: 0.2,
        conversions: 2,
      },
      {
        value: "/",
        visitors: 1,
        pageviews: 1,
        scroll_depth: null,
        time_on_page: null,
        lcp_p75: null,
        inp_p75: null,
        cls_p75: null,
        conversions: 0,
      },
    ]);
    const t = engine.stats(db, s, q({ metrics: ["lcp_p75", "conversion_rate"] }), NOW) as { metrics: Record<string, number> };
    expect(t.metrics).toEqual({ lcp_p75: 3000, conversion_rate: 50 });
  });
});

describe("payments: attribution, renewals, refunds, dedupe", () => {
  beforeEach(() => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ visitor_hash: "a", ts: NOW - 30 * MIN, pathname: "/pricing", country: "DE", ...google })], NOW);
    engine.ingest(db, [ev({ visitor_hash: "b", ts: NOW - 20 * MIN, pathname: "/", country: "US", ...facebook })], NOW);
  });

  const ingestAll = () =>
    payments.ingestPayments(
      db,
      [
        pay({ external_id: "pi_1", event_id: "evt_1", visitor_id: "a", amount: 100, customer: "cust_a", ts: NOW - 25 * MIN }),
        pay({ external_id: "pi_1", event_id: "evt_1", visitor_id: "a", amount: 100 }), // the same Stripe event again
        pay({ external_id: "pi_1", event_id: "evt_2", visitor_id: "a", amount: 100 }), // the same payment from another event
        pay({ external_id: "in_2", event_id: "evt_3", type: "renewal", amount: 30, customer: "cust_a", ts: NOW - 5 * MIN }),
        pay({ external_id: "refund:ch_1", event_id: "evt_4", type: "refund", amount: 20, original_refs: ["pi_1"], ts: NOW - 4 * MIN }),
        pay({ external_id: "refund:ch_1", event_id: "evt_5", type: "refund", amount: 40, original_refs: ["pi_1"], ts: NOW - 3 * MIN }),
        pay({ external_id: "pi_9", event_id: "evt_6", amount: 10, customer: "cust_z", ts: NOW - 2 * MIN }),
      ],
      NOW,
    );

  it("links, dedupes and nets refunds", () => {
    const out = ingestAll();
    expect(out.map((o) => [!!o.duplicate_event, !!o.existing, o.linked_by ?? null])).toEqual([
      [false, false, "visitor"],
      [true, false, null],
      [false, true, "visitor"],
      [false, false, "customer"], // renewal keeps the first payment's source
      [false, false, "original_payment"],
      [false, true, "original_payment"], // cumulative refund: amount replaced, not added
      [false, false, null],
    ]);
    const metrics: Metric[] = [
      "visitors",
      "events",
      "revenue",
      "revenue_per_visitor",
      "new_revenue",
      "renewal_revenue",
      "refunds",
      "purchases",
      "customers",
      "purchase_rate",
    ];
    const s = engine.stats(db, settings(), q({ metrics }), NOW) as { metrics: Record<string, number> };
    expect(s.metrics).toEqual({
      visitors: 2, // payments are never visits
      events: 2,
      revenue: 100, // 100 + 30 - 40 + 10
      revenue_per_visitor: 50,
      new_revenue: 110,
      renewal_revenue: 30,
      refunds: 40,
      purchases: 2,
      customers: 2,
      purchase_rate: 100,
    });
  });

  it("revenue per breakdown row, sort=revenue, page rows are session-scoped, unattributed is visible", () => {
    ingestAll();
    const by = (dim: "channel" | "page" | "country", sort?: Metric) =>
      (
        engine.breakdown(
          db,
          settings(),
          {
            ...q({ metrics: ["visitors", "revenue", "purchase_rate"], sort: sort ? { by: "metric", metric: sort } : undefined }),
            breakdown: dim,
          },
          NOW,
        ) as Rows
      ).results.map((r) => [r.value, r.visitors, r.revenue]);
    expect(by("channel", "revenue")).toEqual([
      ["Organic Search", 1, 90],
      ["Unattributed", 0, 10],
      ["Organic Social", 1, 0],
    ]);
    expect(by("channel")).toEqual([
      ["Organic Search", 1, 90],
      ["Organic Social", 1, 0],
      ["Unattributed", 0, 10],
    ]);
    expect(by("page", "revenue")).toEqual([
      ["/pricing", 1, 90],
      ["/", 1, 0],
    ]);
    expect(by("country", "revenue")[0]).toEqual(["DE", 1, 90]);
  });

  it("a later checkout link attributes the customer's earlier unlinked payments; list and delete", () => {
    ingestAll();
    const link = payments.ingestPayments(
      db,
      [pay({ type: "link", external_id: "cs_9", event_id: "evt_7", customer: "cust_z", visitor_id: "b", amount: 0 })],
      NOW,
    );
    expect(link[0]).toMatchObject({ ok: true, linked_by: "visitor" });
    const list = payments.listPayments(db, settings(), { start: 0, end: NOW + DAY, limit: 10, offset: 0 });
    expect(list).toMatchObject({ total: 4, unlinked: 0, revenue: 100 });
    const pi9 = list.payments.find((p) => p.external_id === "pi_9")!;
    expect(pi9).toMatchObject({ linked: true, linked_by: "customer", channel: "Organic Social", source: "Facebook" });
    expect(payments.deletePayment(db, String(pi9.id))).toEqual({ deleted: pi9.id });
    expect(payments.deletePayment(db, "pay_nope")).toBeNull();
    const s = engine.stats(db, settings(), q({ metrics: ["revenue"] }), NOW) as { metrics: Record<string, number> };
    expect(s.metrics.revenue).toBe(90);
    expect(payments.paymentsSummary(db, NOW)).toMatchObject({ payments_30d: 3, unlinked_30d: 0 });
  });
});

describe("comparisons per row, sort=change, movers, timeseries compare", () => {
  beforeEach(() => {
    engine.configure(db, settings());
    const visit = (v: string, at: number, src: Partial<EnrichedEvent>) => engine.ingest(db, [ev({ visitor_hash: v, ts: at, ...src })], NOW);
    for (const v of ["g1", "g2", "g3"]) visit(v, NOW - DAY - 60 * MIN, google);
    visit("f0", NOW - DAY - 60 * MIN, facebook);
    visit("g4", NOW - 60 * MIN, google);
    for (const v of ["f1", "f2", "f3", "f4"]) visit(v, NOW - 60 * MIN, facebook);
    for (const v of ["c1", "c2"]) visit(v, NOW - 60 * MIN, chatgpt);
  });

  it("rows carry comparison {metrics, change_percent}; sort=change ranks the biggest absolute moves", () => {
    const s = engine.stats(db, settings(), { ...q({ period: "today", breakdown: "source", compare: { mode: "previous" } }) }, NOW) as {
      metrics: { visitors: number };
      comparison: { metrics: { visitors: number }; period: { partial: boolean } };
      breakdown: Rows;
    };
    expect(s.metrics.visitors).toBe(7);
    expect(s.comparison).toMatchObject({ metrics: { visitors: 4 }, period: { partial: true } });
    expect(
      s.breakdown.results.map((r) => [r.value, r.visitors, r.comparison.metrics.visitors, r.comparison.change_percent.visitors]),
    ).toEqual([
      ["Facebook", 4, 1, 300],
      ["ChatGPT", 2, 0, null],
      ["Google", 1, 3, -66.7],
    ]);
    const ch = engine.breakdown(
      db,
      settings(),
      { ...q({ period: "today", compare: { mode: "previous" }, sort: { by: "change", metric: "visitors" } }), breakdown: "source" },
      NOW,
    ) as Rows;
    expect(ch.results.map((r) => [r.value, r.change])).toEqual([
      ["Facebook", 3],
      ["ChatGPT", 2],
      ["Google", -2],
    ]);
  });

  it("movers: gainers and losers", () => {
    const m = engine.movers(
      db,
      settings(),
      { ...q({ period: "today", compare: { mode: "previous" } }), breakdown: "source", metric: "visitors" },
      NOW,
    ) as {
      gainers: Record<string, any>[];
      losers: Record<string, any>[];
    };
    expect(m.gainers.map((r) => [r.value, r.change])).toEqual([
      ["Facebook", 3],
      ["ChatGPT", 2],
    ]);
    expect(m.losers.map((r) => [r.value, r.change, r.comparison.metrics.visitors])).toEqual([["Google", -2, 3]]);
  });

  it("timeseries pairs each bucket with the comparison bucket at the same position", () => {
    const t = engine.timeseries(
      db,
      settings(),
      { period: "today", metrics: ["visitors"], filters: [], compare: { mode: "previous" } },
      NOW,
    ) as unknown as {
      results: { date: string; visitors: number; comparison: { date: string; metrics: { visitors: number } } | null }[];
      comparison: { period: { from: string } };
    };
    const at14 = t.results.find((r) => r.date === "2026-11-03 14:00")!;
    expect(at14).toMatchObject({ visitors: 7, comparison: { date: "2026-11-02 14:00", metrics: { visitors: 4 } } });
    expect(t.comparison.period.from).toBe("2026-11-02");
  });
});

describe("new vs returning visitors", () => {
  it("persistent ids and user ids link earlier sessions; same-day only for anonymous cookieless ids", () => {
    const s = settings({ visitor_id_mode: "persistent" });
    engine.configure(db, s);
    engine.ingest(db, [ev({ visitor_hash: "p1", ts: NOW - 2 * DAY }), ev({ visitor_hash: "p1", ts: NOW - 60 * MIN })], NOW);
    engine.ingest(db, [ev({ visitor_hash: "p2", ts: NOW - 60 * MIN })], NOW);
    // two different daily ids, one user
    engine.ingest(
      db,
      [ev({ visitor_hash: "d1", user_id: "U1", ts: NOW - 3 * DAY }), ev({ visitor_hash: "d2", user_id: "U1", ts: NOW - 30 * MIN })],
      NOW,
    );
    const r = engine.stats(db, s, q({ metrics: ["visitors", "new_visitors", "returning_visitors"] }), NOW) as {
      metrics: Record<string, number>;
      notes?: string[];
    };
    expect(r.metrics).toEqual({ visitors: 3, new_visitors: 1, returning_visitors: 2 });
    expect(r.notes).toBeUndefined();
    const ts = engine.timeseries(
      db,
      s,
      { period: "7d", metrics: ["new_visitors", "returning_visitors"], filters: [] },
      NOW,
    ) as unknown as Rows;
    expect(ts.results.find((x) => x.date === "2026-11-03")).toMatchObject({ new_visitors: 1, returning_visitors: 2 });
    expect(ts.results.find((x) => x.date === "2026-11-01")).toMatchObject({ new_visitors: 1, returning_visitors: 0 });
    const cookieless = engine.stats(db, settings(), q({ metrics: ["returning_visitors"] }), NOW) as { notes: string[] };
    expect(cookieless.notes.join(" ")).toMatch(/rotate daily/);
  });
});

describe("visitors, sessions and journeys", () => {
  const s = settings({
    visitor_id_mode: "persistent",
    goals: [{ id: "g", name: "Signup", type: "event", match: "signup", value: null, created_at: 1 }],
  });
  beforeEach(() => {
    engine.configure(db, s);
    // x: Google three days ago, back today (direct), signs up and pays
    engine.ingest(
      db,
      [ev({ visitor_hash: "visitor_x", ts: NOW - 3 * DAY, pathname: "/blog", country: "DE", device: "mobile", ...google })],
      NOW,
    );
    engine.ingest(
      db,
      [
        ev({ visitor_hash: "visitor_x", ts: NOW - 40 * MIN, pathname: "/pricing", country: "DE", device: "mobile" }),
        ev({ visitor_hash: "visitor_x", ts: NOW - 39 * MIN, name: "signup", user_id: "U9", props: '{"plan":"pro"}' }),
      ],
      NOW,
    );
    payments.ingestPayments(db, [pay({ external_id: "pi_x", visitor_id: "visitor_x", amount: 99, ts: NOW - 35 * MIN })], NOW);
    // y: first visit today, signs up right away
    engine.ingest(
      db,
      [
        ev({ visitor_hash: "visitor_y", ts: NOW - 20 * MIN, ...facebook }),
        ev({ visitor_hash: "visitor_y", ts: NOW - 19 * MIN, name: "signup" }),
      ],
      NOW,
    );
  });

  it("lists identities with names, source, spend; filters, types, sort and pagination", () => {
    const l = people.listVisitors(db, s, { period: "7d", filters: [], limit: 1, offset: 0, sort: "revenue", type: "all" }, NOW) as Record<
      string,
      any
    >;
    expect(l.total).toBe(2);
    expect(l.next_offset).toBe(1);
    expect(l.visitors[0]).toMatchObject({
      id: "user:U9",
      identified: true,
      user_id: "U9",
      channel: "Organic Search", // first session's source
      source: "Google",
      country: "DE",
      device: "mobile",
      visits: 2,
      revenue: 99,
      customer: true,
    });
    expect(l.visitors[0].name).toMatch(/^\w+ \w+$/);
    const cust = people.listVisitors(
      db,
      s,
      { period: "7d", filters: [], limit: 10, offset: 0, sort: "last_seen", type: "customers" },
      NOW,
    ) as Record<string, any>;
    expect(cust.visitors.map((v: { id: string }) => v.id)).toEqual(["user:U9"]);
    const fb = people.listVisitors(
      db,
      s,
      { period: "7d", filters: parseFilters("channel==Organic Social"), limit: 10, offset: 0, sort: "last_seen", type: "all" },
      NOW,
    ) as Record<string, any>;
    expect(fb.visitors.map((v: { id: string }) => v.id)).toEqual(["visitor_y"]);
    const search = people.listVisitors(
      db,
      s,
      { period: "7d", filters: [], limit: 10, offset: 0, sort: "last_seen", type: "all", search: "u9" },
      NOW,
    ) as Record<string, any>;
    expect(search.total).toBe(1);
  });

  it("one visitor's timeline (including pre-identify sessions) and one session", () => {
    const v = people.getVisitor(db, s, "user:U9") as Record<string, any>;
    expect(v.visitor).toMatchObject({
      id: "user:U9",
      visits: 2,
      revenue: 99,
      first_source: { channel: "Organic Search", source: "Google" },
    });
    expect(v.visitor.time_to_first_purchase_s).toBe(Math.round((3 * DAY - 35 * MIN) / 1000));
    expect(v.timeline.map((e: { name: string }) => e.name)).toEqual(["pageview", "pageview", "signup", "payment"]);
    expect(v.timeline[2].props).toEqual({ plan: "pro" });
    expect(v.activity.map((a: { date: string }) => a.date)).toEqual(["2026-10-31", "2026-11-03"]);
    expect(people.getVisitor(db, s, "nobody_here")).toMatchObject({ error: { code: "not_found" } });
    const sess = people.getSession(db, s, String(v.sessions[1].id)) as Record<string, any>;
    expect(sess.events.map((e: { name: string }) => e.name)).toEqual(["pageview", "signup", "payment"]);
    expect(sess.revenue).toBe(99);
    expect(people.getSession(db, s, "s000000000000000")).toMatchObject({ error: { code: "not_found" } });
  });

  it("journeys to a goal and to a first purchase", () => {
    const j = people.journeys(db, s, { period: "7d", filters: [], goal: "Signup", limit: 10, offset: 0 }, NOW) as Record<string, any>;
    expect(j.summary).toMatchObject({ converters: 2, median_visits: 1.5, first_visit_rate: 50 });
    const x = j.journeys.find((r: { id: string }) => r.id === "user:U9");
    expect(x).toMatchObject({ visits: 2, channel: "Organic Search", source: "Google", last_touch: { channel: "Direct" }, revenue: 99 });
    expect(x.time_to_complete_s).toBe(Math.round((3 * DAY - 39 * MIN) / 1000));
    expect(x.touchpoints.map((t: { channel: string }) => t.channel)).toEqual(["Organic Search", "Direct"]);
    const p = people.journeys(db, s, { period: "7d", filters: [], limit: 10, offset: 0 }, NOW) as Record<string, any>;
    expect(p.journeys.map((r: { id: string }) => r.id)).toEqual(["user:U9"]);
    expect(people.journeys(db, s, { period: "7d", filters: [], goal: "Nope", limit: 10, offset: 0 }, NOW)).toMatchObject({
      error: { code: "unknown_goal" },
    });
  });

  it("insights: shares, histograms, first-visit rate, converting sources and events, heatmap", () => {
    for (let i = 0; i < 5; i++) engine.ingest(db, [ev({ visitor_hash: `filler_${i}`, ts: NOW - 10 * MIN, ...facebook })], NOW);
    const r = insights(db, s, { period: "7d", filters: [] }, NOW) as Record<string, any>;
    expect(r.kpis).toMatchObject({ visitors: 7, revenue: 99, converters: 1, revenue_per_visitor: 14.14 });
    expect(r.revenue_share.device).toEqual([{ value: "mobile", revenue: 99, share: 100 }]);
    // revenue belongs to the session it happened in (today's direct visit); journeys report the first touch
    expect(r.top_sources.by_revenue).toEqual([{ value: "Direct", visitors: 1, converters: 1, conversion_rate: 100, revenue: 99 }]);
    expect(r.time_to_convert).toMatchObject({ converters: 1, first_visit_rate: 0, median_visits: 2 });
    expect(r.time_to_convert.days_histogram.find((b: { label: string }) => b.label === "2-3 days").count).toBe(1);
    expect(r.top_converting_events).toEqual([]); // signup has 2 doers (< 3)
    const g = insights(db, s, { period: "7d", filters: [], goal: "Signup" }, NOW) as Record<string, any>;
    expect(g.kpis.converters).toBe(2);
    expect(g.time_to_convert.first_visit_rate).toBe(50);
    expect(g.heatmap.values).toHaveLength(7);
    expect(g.heatmap.peak).toMatchObject({ day: "Tue", hour: 14 });
  });
});

describe("annotations and traffic spikes", () => {
  it("CRUD with a natural key, an optional cap, and range queries", () => {
    const s = settings();
    engine.configure(db, s);
    const a = annotations.createAnnotation(db, s, { ts: NOW - DAY, end_ts: null, title: "Launch", description: null }, 2, NOW) as Record<
      string,
      any
    >;
    expect(a).toMatchObject({ existing: false, annotation: { kind: "note", date: "2026-11-02", title: "Launch", source: "api" } });
    expect(annotations.createAnnotation(db, s, { ts: NOW - DAY, end_ts: null, title: "Launch", description: null }, 2, NOW)).toMatchObject({
      existing: true,
    });
    annotations.createAnnotation(db, s, { ts: NOW, end_ts: null, title: "Deploy", description: "v2" }, 2, NOW);
    expect(annotations.createAnnotation(db, s, { ts: NOW, end_ts: null, title: "Third", description: null }, 2, NOW)).toMatchObject({
      error: { code: "quota_exceeded" },
    });
    const id = String(a.annotation.id);
    expect(annotations.updateAnnotation(db, s, id, { title: "Deploy", ts: NOW })).toMatchObject({ error: { code: "conflict" } });
    expect(annotations.updateAnnotation(db, s, id, { title: "Launch day" })).toMatchObject({ annotation: { title: "Launch day" } });
    expect(annotations.annotationsIn(db, s, NOW - 2 * DAY, NOW - DAY + 1).map((x) => x.title)).toEqual(["Launch day"]);
    expect(annotations.deleteAnnotation(db, id)).toEqual({ deleted: id });
    expect(annotations.deleteAnnotation(db, id)).toMatchObject({ error: { code: "not_found" } });
  });

  it("the alarm's spike check names the source, is idempotent, and shows on the timeseries", () => {
    const s = settings();
    engine.configure(db, s);
    const today0 = Date.UTC(2026, 10, 3);
    const evs: EnrichedEvent[] = [];
    for (let d = 15; d >= 2; d--)
      for (const i of [1, 2]) evs.push(ev({ visitor_hash: `b${d}_${i}`, ts: today0 - d * DAY + 3600_000, ...google }));
    for (let i = 0; i < 30; i++) evs.push(ev({ visitor_hash: `spike_${i}`, ts: today0 - DAY + 7200_000, ...facebook }));
    engine.ingest(db, evs, NOW);
    expect(annotations.evaluateSpikes(db, s, NOW)).toEqual(["2026-11-02"]);
    expect(annotations.evaluateSpikes(db, s, NOW)).toEqual([]); // already evaluated
    expect(annotations.evaluateSpikes(db, s, NOW + DAY)).toEqual([]); // the next day is no spike
    const spikes = annotations.annotationsIn(db, s, 0, NOW + DAY, "traffic_spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({
      date: "2026-11-02",
      title: "Traffic spike from Facebook",
      source: "auto",
      details: { visitors: 30, baseline: 2, source: "Facebook", source_visitors: 30 },
    });
    const ts = engine.timeseries(db, s, { period: "7d", metrics: ["visitors"], filters: [] }, NOW) as unknown as {
      annotations: { title: string }[];
    };
    expect(ts.annotations.map((x) => x.title)).toEqual(["Traffic spike from Facebook"]);
    // a re-run of an old day (pointer reset) writes nothing twice
    db.run("DELETE FROM meta WHERE key = 'spikes_through'");
    annotations.evaluateSpikes(db, s, NOW);
    expect(annotations.annotationsIn(db, s, 0, NOW + DAY, "traffic_spike")).toHaveLength(1);
  });

  it("purge keeps notes and drops old auto annotations and payments", () => {
    const s = settings({ retention_days: 30 });
    engine.configure(db, s);
    annotations.createAnnotation(db, s, { ts: NOW - 60 * DAY, end_ts: null, title: "Old note", description: null }, null, NOW);
    db.run(
      "INSERT INTO annotations (id, key, kind, ts, title, source, created_at, updated_at) VALUES ('ann_x', 'spike:old', 'traffic_spike', ?, 'Old spike', 'auto', 1, 1)",
      [NOW - 60 * DAY],
    );
    payments.ingestPayments(db, [pay({ external_id: "old", ts: NOW - 60 * DAY })], NOW);
    engine.purge(db, 30, NOW);
    expect(db.all("SELECT title FROM annotations")).toEqual([{ title: "Old note" }]);
    expect(db.all("SELECT COUNT(*) AS n FROM payments")[0]!.n).toBe(0);
  });
});

it("every metric is shaped (none silently missing)", () => {
  engine.configure(db, settings());
  engine.ingest(db, [ev({})], NOW);
  const s = engine.stats(db, settings(), q({ metrics: [...METRICS] }), NOW) as { metrics: Record<string, unknown> };
  expect(Object.keys(s.metrics)).toEqual([...METRICS]);
});
