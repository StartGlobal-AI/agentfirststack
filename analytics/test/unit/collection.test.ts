import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { parseFilters } from "../../src/lib/filters";
import { hashRoute, parsePage, primaryLanguage, queryOf, screenClass } from "../../src/lib/url";
import { MIN, NOW, type Rows, ev, q, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("collection helpers", () => {
  it("hash routes, query strings, viewport classes, languages, extra UTM tags", () => {
    expect(hashRoute("https://x.test/app#/inbox/42?tab=1")).toBe("#/inbox/42");
    expect(hashRoute("https://x.test/app#!/inbox")).toBe("#!/inbox");
    expect(hashRoute("https://x.test/page#pricing")).toBeNull();
    expect(queryOf("https://x.test/s?q=Shoes&utm_source=a#x")).toBe("?q=Shoes&utm_source=a");
    expect([screenClass(375), screenClass(800), screenClass(1280), screenClass(2560), screenClass("x"), screenClass(0)]).toEqual([
      "xs",
      "sm",
      "md",
      "lg",
      null,
      null,
    ]);
    expect([primaryLanguage("en-US,en;q=0.9"), primaryLanguage("de"), primaryLanguage("*"), primaryLanguage(null)]).toEqual([
      "en",
      "de",
      null,
      null,
    ]);
    const p = parsePage(
      "https://x.test/?utm_id=c1&utm_source_platform=google_ads&utm_creative_format=video&utm_marketing_tactic=remarketing",
    );
    expect(p).toMatchObject({
      utm_id: "c1",
      utm_source_platform: "google_ads",
      utm_creative_format: "video",
      utm_marketing_tactic: "remarketing",
    });
  });
});

describe("collection in the engine", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
  });

  it("title, language, viewport class and the extra UTM tags are stored and break down; server events inherit language and screen", () => {
    engine.configure(db, settings());
    engine.ingest(
      db,
      [ev({ ts: NOW - 10 * MIN, title: "Pricing", language: "de", screen: "md", utm_id: "c1", utm_marketing_tactic: "remarketing" })],
      NOW,
    );
    engine.ingest(
      db,
      [
        ev({
          ts: NOW - 9 * MIN,
          origin: "server",
          name: "signup",
          browser: null,
          browser_version: null,
          os: null,
          os_version: null,
          device: null,
        }),
      ],
      NOW,
    );
    expect(db.all("SELECT name, title, language, screen, utm_id FROM events ORDER BY ts")).toEqual([
      { name: "pageview", title: "Pricing", language: "de", screen: "md", utm_id: "c1" },
      { name: "signup", title: null, language: "de", screen: "md", utm_id: "c1" },
    ]);
    const by = (b: string) => (engine.breakdown(db, settings(), { ...q(), breakdown: b } as any, NOW) as Rows).results.map((r) => r.value);
    expect(by("page_title").sort()).toEqual(["(none)", "Pricing"]); // the signup event has no title
    expect(by("language")).toEqual(["de"]);
    expect(by("utm_marketing_tactic")).toEqual(["remarketing"]);
  });

  it("non-interactive events don't un-bounce a session", () => {
    engine.configure(db, settings());
    engine.ingest(db, [ev({ ts: NOW - 10 * MIN }), ev({ ts: NOW - 9 * MIN, name: "impression", interactive: false })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 10 * MIN, visitor_hash: "v2" }), ev({ ts: NOW - 9 * MIN, visitor_hash: "v2", name: "click" })], NOW);
    const r = engine.stats(db, settings(), q({ metrics: ["bounce_rate", "events"] }), NOW) as any;
    expect(r.metrics).toEqual({ bounce_rate: 50, events: 4 });
  });

  it("site search: only configured params, lowercased and redacted, an extra event within the budget; the query is never stored", () => {
    engine.configure(db, settings({ search_params: ["q", "s"] }));
    engine.ingest(db, [ev({ ts: NOW - 10 * MIN, pathname: "/search", search_query: "?q=Red%20Shoes&token=secret" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 9 * MIN, pathname: "/search", search_query: "?s=jane@example.com" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 8 * MIN, pathname: "/x", search_query: "?other=1" })], NOW);
    expect(db.all("SELECT name, props FROM events WHERE name = 'site_search' ORDER BY ts")).toEqual([
      { name: "site_search", props: '{"term":"red shoes"}' },
      { name: "site_search", props: '{"term":"[email]"}' },
    ]);
    expect(JSON.stringify(db.all("SELECT * FROM events"))).not.toContain("secret");
    expect(engine.usageOn(db, "2026-11-03").events).toBe(5);
    // the extra event needs room under the daily cap
    const capped = memoryDb();
    engine.configure(capped, settings({ search_params: ["q"] }));
    const r = engine.ingest(capped, [ev({ search_query: "?q=a" })], NOW, {
      caps: { siteDaily: 1, accountDaily: Infinity, platformDaily: Infinity },
    });
    expect(r.results[0]!.ok).toBe(true);
    expect(capped.all("SELECT name FROM events")).toEqual([{ name: "pageview" }]);
    const off = memoryDb();
    engine.configure(off, settings());
    engine.ingest(off, [ev({ search_query: "?q=a" })], NOW);
    expect(off.all("SELECT name FROM events")).toEqual([{ name: "pageview" }]);
  });

  it("content groups apply at query time, to stored data too; first match wins", () => {
    engine.configure(db, settings());
    engine.ingest(
      db,
      [ev({ pathname: "/blog/a" }), ev({ pathname: "/blog/b", visitor_hash: "v2" }), ev({ pathname: "/docs/x", visitor_hash: "v3" })],
      NOW,
    );
    const groups = settings({
      content_groups: [
        { name: "Blog", match: "/blog/*" },
        { name: "Everything", match: "/*" },
      ],
    });
    engine.configure(db, groups);
    const rows = (engine.breakdown(db, groups, { ...q(), breakdown: "content_group" } as any, NOW) as Rows).results;
    expect(rows).toEqual([
      { value: "Blog", visitors: 2 },
      { value: "Everything", visitors: 1 },
    ]);
    expect((engine.stats(db, groups, q({ filters: parseFilters("content_group==Blog") }), NOW) as any).metrics.visitors).toBe(2);
    engine.configure(db, settings());
    expect((engine.breakdown(db, settings(), { ...q(), breakdown: "content_group" } as any, NOW) as Rows).results).toEqual([
      { value: "(none)", visitors: 3 },
    ]);
  });
});
