import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { METRICS, parseFilters } from "../../src/lib/filters";
import { parseFunnelSteps } from "../../src/lib/query";
import type { EnrichedEvent, SiteSettings } from "../../src/lib/types";
import { memoryDb } from "./sqlite";

const NOW = Date.UTC(2026, 10, 3, 15, 0);
const MIN = 60_000;

const settings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  id: "site_test0000000000",
  domain: "example.com",
  name: null,
  timezone: "UTC",
  visitor_id_mode: "cookieless",
  retention_days: 30,
  allowed_hostnames: null,
  respect_dnt: false,
  created_at: NOW,
  goals: [],
  ...over,
});

function ev(over: Partial<EnrichedEvent>): EnrichedEvent {
  return {
    ts: NOW,
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

const q = (over: Record<string, unknown> = {}) => ({ period: "24h" as const, metrics: [...METRICS], filters: [], ...over });

describe("engine", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
  });

  it("an unconfigured site accepts nothing", () => {
    expect(engine.ingest(db, [ev({})], NOW)).toMatchObject({ known_site: false });
  });

  it("sessionises, attributes and counts", () => {
    engine.configure(db, settings());
    const google = { referrer: "google.com", referrer_host: "www.google.com", source: "Google", channel: "Organic Search" as const };
    engine.ingest(db, [ev({ ts: NOW - 50 * MIN, ...google, country: "DE", city: "Berlin" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 45 * MIN, pathname: "/pricing", country: "DE" })], NOW); // same session (5 min gap)
    engine.ingest(db, [ev({ ts: NOW - 44 * MIN, name: "signup", pathname: "/pricing", props: '{"plan":"pro"}' })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 5 * MIN, pathname: "/blog" })], NOW); // 39 min later: new session, Direct
    engine.ingest(db, [ev({ ts: NOW - 4 * MIN, visitor_hash: "v2", country: "US", channel: "AI Assistants", source: "ChatGPT" })], NOW);
    const s = engine.stats(db, settings(), q({ compare: true }), NOW) as { metrics: Record<string, number>; comparison: unknown };
    expect(s.metrics).toMatchObject({ visitors: 2, visits: 3, pageviews: 4, events: 5, views_per_visit: 1.33 });
    expect(s.metrics.bounce_rate).toBe(66.7); // 2 of 3 sessions had one pageview and no custom event
    expect(s.metrics.visit_duration).toBe(120); // (360s + 0 + 0) / 3
    const sessions = db.all("SELECT entry_page, exit_page, pageviews, custom_events, channel, country FROM sessions ORDER BY started_at");
    expect(sessions[0]).toMatchObject({
      entry_page: "/",
      exit_page: "/pricing",
      pageviews: 2,
      custom_events: 1,
      channel: "Organic Search",
      country: "DE",
    });
    // events inherit the session's attribution and geo
    expect(db.all("SELECT channel, country FROM events WHERE name = 'signup'")[0]).toEqual({ channel: "Organic Search", country: "DE" });
    const b = engine.stats(db, settings(), q({ breakdown: "channel", metrics: ["visitors", "visits"] }), NOW) as {
      breakdown: { results: { value: string; visits: number }[] };
    };
    expect(b.breakdown.results.map((r) => [r.value, r.visits])).toEqual([
      ["Organic Search", 1], // ties on visitors break on events (3), then name
      ["AI Assistants", 1],
      ["Direct", 1],
    ]);
  });

  it("server events join a session, inherit geo, and Direct sessions adopt a real source", () => {
    engine.configure(db, settings());
    engine.ingest(
      db,
      [ev({ ts: NOW - 10 * MIN, origin: "server", name: "lead", pathname: null, browser: null, device: null, os: null })],
      NOW,
    );
    engine.ingest(
      db,
      [
        ev({
          ts: NOW - 9 * MIN,
          country: "FR",
          city: "Paris",
          channel: "Paid Search",
          source: "Google",
          click_id_type: "gclid",
          click_id: "x",
        }),
      ],
      NOW,
    );
    engine.ingest(
      db,
      [
        ev({
          ts: NOW - 8 * MIN,
          origin: "server",
          name: "purchase",
          pathname: null,
          revenue: 20,
          currency: "EUR",
          browser: null,
          device: null,
        }),
      ],
      NOW,
    );
    const rows = db.all("SELECT name, channel, country, click_id_type, session_id FROM events ORDER BY ts");
    expect(new Set(rows.map((r) => r.session_id)).size).toBe(1);
    expect(rows.map((r) => [r.name, r.channel, r.country])).toEqual([
      ["lead", "Paid Search", "FR"],
      ["pageview", "Paid Search", "FR"],
      ["purchase", "Paid Search", "FR"],
    ]);
  });

  it("goals: conversions, rate, revenue (incl. goal value), goal filter and breakdown", () => {
    engine.configure(
      db,
      settings({
        browser_revenue: true,
        goals: [
          { id: "g1", name: "Signup", type: "event", match: "signup", value: 5, created_at: 1 },
          { id: "g2", name: "Thanks", type: "pageview", match: "/thanks*", value: null, created_at: 2 },
        ],
      }),
    );
    engine.ingest(db, [ev({ visitor_hash: "a", ts: NOW - 3 * MIN }), ev({ visitor_hash: "a", ts: NOW - 2 * MIN, name: "signup" })], NOW);
    engine.ingest(db, [ev({ visitor_hash: "b", ts: NOW - 3 * MIN, pathname: "/thanks/order-1", revenue: 30 })], NOW);
    engine.ingest(db, [ev({ visitor_hash: "c", ts: NOW - 3 * MIN, country: "US" }), ev({ visitor_hash: "d", ts: NOW - 3 * MIN })], NOW);
    const s = engine.stats(db, settings(), q(), NOW) as { metrics: Record<string, number> };
    expect(s.metrics).toMatchObject({ visitors: 4, conversions: 2, conversion_rate: 50, revenue: 35 });
    const f = engine.stats(db, settings(), q({ filters: parseFilters("goal==Signup") }), NOW) as { metrics: Record<string, number> };
    expect(f.metrics).toMatchObject({ visitors: 1, pageviews: 1, conversions: 1, revenue: 5 });
    const g = engine.breakdown(db, settings(), { ...q(), breakdown: "goal" }, NOW) as { results: Record<string, unknown>[] };
    expect(g.results).toEqual([
      { value: "Signup", goal_type: "event", goal_match: "signup", visitors: 1, conversions: 1, conversion_rate: 25, revenue: 5 },
      { value: "Thanks", goal_type: "pageview", goal_match: "/thanks*", visitors: 1, conversions: 1, conversion_rate: 25, revenue: 30 },
    ]);
    expect(engine.stats(db, settings(), q({ filters: parseFilters("goal==Nope") }), NOW)).toMatchObject({
      error: { code: "unknown_goal" },
    });
  });

  it("filters: ==, !=, ~, (none), prop:, entry_page; injection attempts match nothing", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ visitor_hash: "a", country: "US", pathname: "/blog/x", props: '{"plan":"pro"}' })], NOW);
    engine.ingest(db, [ev({ visitor_hash: "b", country: "DE", pathname: "/" })], NOW);
    engine.ingest(db, [ev({ visitor_hash: "c", pathname: "/Blog/y" })], NOW);
    const v = (f: string) =>
      (engine.stats(db, settings(), q({ filters: parseFilters(f), metrics: ["visitors"] }), NOW) as { metrics: { visitors: number } })
        .metrics.visitors;
    expect(v("country==US")).toBe(1);
    expect(v("country!=US")).toBe(2); // includes the visitor with no country
    expect(v("country==(none)")).toBe(1);
    expect(v("country==US|DE")).toBe(2);
    expect(v("page~/blog")).toBe(2); // contains is case-insensitive
    expect(v("page!~blog")).toBe(1);
    expect(v("prop:plan==pro")).toBe(1);
    expect(v("entry_page==/")).toBe(1);
    expect(v("country==US' OR '1'='1")).toBe(0);
    expect(db.all("SELECT COUNT(*) AS n FROM events")[0]!.n).toBe(3);
  });

  it("region/city breakdowns carry country; prop breakdown", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ visitor_hash: "a", country: "US", city: "Portland", props: '{"plan":"pro"}' })], NOW);
    engine.ingest(db, [ev({ visitor_hash: "b", country: "GB", city: "Portland" })], NOW);
    const c = engine.breakdown(db, settings(), { ...q({ metrics: ["visitors"] }), breakdown: "city" }, NOW) as { results: unknown[] };
    expect(c.results).toEqual([
      { value: "Portland", country: "GB", visitors: 1 },
      { value: "Portland", country: "US", visitors: 1 },
    ]);
    const p = engine.breakdown(db, settings(), { ...q({ metrics: ["visitors"] }), breakdown: "prop:plan" }, NOW) as { results: unknown[] };
    expect(p.results).toEqual([
      { value: "(none)", visitors: 1 },
      { value: "pro", visitors: 1 },
    ]);
  });

  it("timeseries fills every bucket in the site timezone", () => {
    const tz = settings({ timezone: "America/New_York" });
    engine.configure(db, tz);
    // 2026-11-03 01:00 UTC is still Nov 2 in New York (UTC-5)
    engine.ingest(
      db,
      [ev({ ts: Date.UTC(2026, 10, 3, 1), visitor_hash: "a" }), ev({ ts: Date.UTC(2026, 10, 3, 14), visitor_hash: "b" })],
      NOW,
    );
    const t = engine.timeseries(db, tz, { period: "7d", metrics: ["visitors", "pageviews"], filters: [] }, NOW) as unknown as {
      results: { date: string; visitors: number }[];
    };
    expect(t.results).toHaveLength(7);
    expect(t.results.find((r) => r.date === "2026-11-02")?.visitors).toBe(1);
    expect(t.results.find((r) => r.date === "2026-11-03")?.visitors).toBe(1);
    const h = engine.timeseries(db, tz, { period: "today", metrics: ["pageviews"], filters: [] }, NOW) as unknown as {
      results: { date: string; pageviews: number }[];
    };
    expect(h.results).toHaveLength(11); // 00:00-10:00 New York time; no future buckets
    expect(h.results.find((r) => r.pageviews === 1)?.date).toBe("2026-11-03 09:00");
  });

  it("funnel counts ordered steps within a session", () => {
    engine.configure(db, settings({ goals: [{ id: "g", name: "Buy", type: "event", match: "purchase", value: null, created_at: 1 }] }));
    const at = (m: number) => NOW - m * MIN;
    engine.ingest(
      db,
      [
        ev({ visitor_hash: "a", ts: at(9), pathname: "/" }),
        ev({ visitor_hash: "a", ts: at(8), pathname: "/pricing" }),
        ev({ visitor_hash: "a", ts: at(7), name: "purchase" }),
      ],
      NOW,
    );
    engine.ingest(
      db,
      [ev({ visitor_hash: "b", ts: at(9), pathname: "/pricing" }), ev({ visitor_hash: "b", ts: at(8), pathname: "/" })],
      NOW,
    ); // wrong order
    engine.ingest(
      db,
      [ev({ visitor_hash: "c", ts: at(9), pathname: "/" }), ev({ visitor_hash: "c", ts: at(8), pathname: "/pricing" })],
      NOW,
    );
    const f = engine.funnel(db, settings(), { period: "24h", filters: [], steps: parseFunnelSteps("/,/pricing,goal:Buy") }, NOW) as {
      steps: { visitors: number; conversion_rate: number; dropoff: number }[];
    };
    expect(f.steps.map((s) => s.visitors)).toEqual([3, 2, 1]);
    expect(f.steps[2]).toMatchObject({ conversion_rate: 33.3, dropoff: 1 });
    // repeating a step needs a second, later event
    const r = engine.funnel(db, settings(), { period: "24h", filters: [], steps: parseFunnelSteps("/pricing,/pricing") }, NOW) as {
      steps: { visitors: number }[];
    };
    expect(r.steps.map((s) => s.visitors)).toEqual([3, 0]);
  });

  it("engagement extends the session and the page", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ ts: NOW - MIN, pathname: "/a" })], NOW);
    expect(engine.ingest(db, [ev({ ts: NOW, name: "engagement", pathname: "/a", engagement_ms: 42_000 })], NOW).results[0]).toMatchObject({
      ok: true,
    });
    expect(db.all("SELECT engagement_ms FROM events")).toEqual([{ engagement_ms: 42_000 }]);
    expect((engine.stats(db, settings(), q({ metrics: ["visit_duration", "events"] }), NOW) as { metrics: unknown }).metrics).toEqual({
      visit_duration: 60,
      events: 1,
    });
  });

  it("allowed_hostnames, DNT and persistent ids", () => {
    const s = settings({ allowed_hostnames: ["example.com"], respect_dnt: true, visitor_id_mode: "persistent" });
    engine.configure(db, s);
    expect(engine.ingest(db, [ev({ hostname: "evil.com" })], NOW).results[0]).toMatchObject({ ok: false, reason: "hostname_not_allowed" });
    expect(engine.ingest(db, [ev({ dnt: true })], NOW).results[0]).toMatchObject({ ok: false, reason: "dnt" });
    const r = engine.ingest(db, [ev({ client_visitor_id: "persist-123" })], NOW);
    expect(r).toMatchObject({ persistent: true, results: [{ ok: true, visitor_id: "persist-123" }] });
    const sum = engine.summary(db, NOW);
    expect(sum.dropped_last_7d).toMatchObject({ hostname_not_allowed: { count: 1 }, dnt: { count: 1 } });
    // the visitor-sent hostname is only under `untrusted`
    expect(JSON.stringify(sum.dropped_last_7d)).not.toContain("evil.com");
    expect(sum.untrusted.drop_samples).toEqual({ hostname_not_allowed: "evil.com" });
  });

  it("read-only SQL: results, errors, guard, and rollback of any write", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ country: "US" })], NOW);
    expect(engine.runSql(db, "SELECT country, COUNT(*) AS n FROM events GROUP BY 1")).toMatchObject({
      columns: ["country", "n"],
      rows: [{ country: "US", n: 1 }],
      truncated: false,
    });
    expect(engine.runSql(db, "DELETE FROM events")).toMatchObject({ error: { code: "sql_rejected" } });
    expect(engine.runSql(db, "SELECT * FROM nope")).toMatchObject({ error: { code: "sql_error" } });
    // a write that slips past the guard is rolled back by the rowsWritten check
    const sneaky: typeof db = {
      ...db,
      cursor: (sql) => {
        db.run("DELETE FROM events");
        const c = db.cursor(sql);
        return { next: () => c.next(), rowsRead: 0, rowsWritten: 1 };
      },
    };
    expect(engine.runSql(sneaky, "SELECT 1")).toMatchObject({ error: { code: "sql_error" } });
    expect(db.all("SELECT COUNT(*) AS n FROM events")[0]!.n).toBe(1);
  });

  it("SQL: runaway shapes are rejected before running; legitimate joins still run", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ visitor_hash: "a" }), ev({ visitor_hash: "b", ts: NOW + MIN })], NOW);
    for (const q of [
      "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x",
      "WITH x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x",
      "SELECT COUNT(*) FROM events a, events b, events c",
      "SELECT COUNT(*) FROM events a JOIN events b",
    ]) {
      expect(engine.runSql(db, q)).toMatchObject({ error: { code: "sql_rejected" } });
    }
    expect(engine.runSql(db, "SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id")).toMatchObject({
      rows: [{ n: 2 }],
    });
  });

  it("SQL: the 1000-row cap always applies and stops stepping the cursor", () => {
    engine.configure(db, settings());
    engine.ingest(
      db,
      Array.from({ length: 40 }, (_, i) => ev({ visitor_hash: `v${i}`, ts: NOW + i })),
      NOW,
    );
    // 40 x 40 = 1600 rows, more than the cap, and LIMIT asks for even more
    const r = engine.runSql(db, "SELECT a.id, b.id AS b FROM events a JOIN events b ON b.id <> a.id LIMIT 100000");
    expect(r).toMatchObject({ row_count: engine.MAX_SQL_ROWS, truncated: true });
    let steps = 0;
    const counted: typeof db = {
      ...db,
      cursor: (sql) => {
        const c = db.cursor(sql);
        return { next: () => (steps++, c.next()), rowsRead: 0, rowsWritten: 0 };
      },
    };
    engine.runSql(counted, "SELECT a.id FROM events a JOIN events b ON b.id <> a.id");
    expect(steps).toBe(engine.MAX_SQL_ROWS + 1);
  });

  it("SQL: stops a query that keeps reading rows after its first one (rowsRead budget)", () => {
    engine.configure(db, settings());
    // a fake cursor whose every row costs 500 reads, like a correlated subquery scanning events
    const fake = (rowsTotal: number, readsPerRow: number, firstRowReads = 0): typeof db => ({
      ...db,
      cursor: () => {
        let i = 0;
        const c = {
          rowsRead: 0,
          rowsWritten: 0,
          next: () => {
            if (i >= rowsTotal) return { done: true, value: undefined } as const;
            c.rowsRead += i === 0 ? firstRowReads : readsPerRow;
            return { done: false, value: { n: i++ } } as const;
          },
        };
        return c;
      },
    });
    expect(engine.runSql(fake(100, 500), "SELECT 1", { maxRowsRead: 10_000 })).toMatchObject({ error: { code: "sql_too_expensive" } });
    // reads done before the first row (an aggregate over a big table) are not held against it
    expect(engine.runSql(fake(50, 1, 5_000_000), "SELECT 1", { maxRowsRead: 10_000 })).toMatchObject({ row_count: 50 });
    // the default budget applies when the var is unset
    expect(engine.runSql(fake(1001, 1001), "SELECT 1")).toMatchObject({ error: { code: "sql_too_expensive" } });
    expect(engine.runSql(fake(1001, 999), "SELECT 1")).toMatchObject({ row_count: 1000, truncated: true });
  });

  it("proxied events without a valid proxy key are kept and counted as warnings, not drops", () => {
    engine.configure(db, settings());
    const r = engine.ingest(db, [ev({ proxy_warning: "proxy_key_missing", hostname: "example.com" }), ev({ visitor_hash: "v2" })], NOW);
    expect(r.results.map((x) => x.ok)).toEqual([true, true]);
    const sum = engine.summary(db, NOW);
    expect(sum.warnings_last_7d).toMatchObject({ proxy_key_missing: { count: 1 } });
    expect(sum.untrusted.warning_samples).toEqual({ proxy_key_missing: "example.com" });
    expect(sum.dropped_last_7d).toEqual({});
  });

  it("retention purge", () => {
    engine.configure(db, settings({ retention_days: 30 }));
    engine.ingest(db, [ev({ ts: NOW - 40 * 86_400_000, visitor_hash: "old" }), ev({ ts: NOW - MIN, visitor_hash: "new" })], NOW);
    expect(engine.purge(db, 30, NOW)).toEqual({ events: 1, sessions: 1 });
    expect(db.all("SELECT visitor_id FROM events")).toEqual([{ visitor_id: "new" }]);
  });

  it("realtime", () => {
    engine.configure(db, settings());
    engine.ingest(
      db,
      [ev({ ts: NOW - 2 * MIN, visitor_hash: "a", country: "US" }), ev({ ts: NOW - 20 * MIN, visitor_hash: "b", pathname: "/x" })],
      NOW,
    );
    const r = engine.realtime(db, { filters: [] }, NOW) as any;
    expect(r).toMatchObject({ visitors_last_5m: 1, visitors_last_30m: 2, pageviews_last_30m: 2 });
    expect(r.recent_events).toHaveLength(2);
    expect(r.top_pages_last_30m).toHaveLength(2);
  });
});
