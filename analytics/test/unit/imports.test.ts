import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { compareImports } from "../../src/do/import-compare";
import { IMPORTS_SQL, deleteImport, listImports, saveImport } from "../../src/do/imports";
import { type ImportKind, type ImportSource, parseImport, parseReport, parseRows } from "../../src/lib/imports";
import { parseFilters } from "../../src/lib/filters";
import { DAY, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const PLAUSIBLE_VISITORS =
  "date,visitors,pageviews,bounces,visits,visit_duration\n2026-10-01,10,30,4,12,600\n2026-10-02,20,50,10,25,1250\n";
const PLAUSIBLE_PAGES =
  "date,hostname,page,visits,visitors,pageviews,exits,time_on_page\n2026-10-01,example.com,/,8,7,20,5,100\n2026-10-01,example.com,/pricing,4,3,10,2,50\n2026-10-02,example.com,/,10,9,30,6,90\n";
const GA4_SOURCES = `# ----------------------------------------
# Traffic acquisition: Session source
# Start date: 20261001
# End date: 20261002
# ----------------------------------------
Date,Session source / medium,Sessions,Active users,Views,Bounce rate
20261001,google / organic,"1,200",900,3000,0.5
20261002,(direct) / (none),100,80,150,40%
,Grand total,1300,980,3150,0.49
`;
const CAPS = { maxRows: 1e9, maxImports: 1e9 };
const meta = (source: ImportSource, kind: ImportKind, tool: string | null = null) => ({
  source,
  tool,
  kind,
  file_name: null,
});

describe("imports", () => {
  it("parses Plausible and GA4 CSVs (kind detected, totals rows skipped)", () => {
    const v = parseImport("plausible", PLAUSIBLE_VISITORS, undefined, 1000);
    expect(v.kind).toBe("visitors");
    expect(v.rows[1]).toEqual({ day: "2026-10-02", value: "", visitors: 20, visits: 25, pageviews: 50, bounces: 10, visit_duration: 1250 });
    expect(parseImport("plausible", PLAUSIBLE_PAGES, undefined, 1000).kind).toBe("pages");
    const g = parseImport("ga4", GA4_SOURCES, undefined, 1000);
    expect(g).toMatchObject({ kind: "sources", skipped: 1 });
    expect(g.rows).toEqual([
      { day: "2026-10-01", value: "google", visitors: 900, visits: 1200, pageviews: 3000, bounces: 600, visit_duration: 0 },
      { day: "2026-10-02", value: "(none)", visitors: 80, visits: 100, pageviews: 150, bounces: 40, visit_duration: 0 },
    ]);
    expect(() => parseImport("ga4", "Page path,Views\n/,1\n", undefined, 10)).toThrow(/date column/);
    // Plausible's direct traffic is "Direct / None": reports call it (none)
    const ps = parseImport(
      "plausible",
      "date,source,visitors,visits\n2026-10-01,Direct / None,5,6\n2026-10-01,Google,3,3\n",
      undefined,
      10,
    );
    expect(ps.rows.map((r) => r.value)).toEqual(["(none)", "Google"]);
  });

  it("stores idempotently per file and date range, with caps; merges into unfiltered reports before live data", () => {
    const db = memoryDb();
    const s = settings({ timezone: "UTC" });
    engine.configure(db, s);
    const caps = { maxRows: 6, maxImports: 3 };
    const a = saveImport(
      db,
      "imp_aaaaaaaaaaaaaaaa",
      { source: "plausible", tool: null, kind: "visitors", file_name: "v.csv" },
      parseImport("plausible", PLAUSIBLE_VISITORS, undefined, 100).rows,
      caps,
      NOW,
    ) as any;
    expect(a).toMatchObject({ existing: false, import: { from: "2026-10-01", to: "2026-10-02", rows: 2, tool: null } });
    const again = saveImport(
      db,
      "imp_bbbbbbbbbbbbbbbb",
      { source: "plausible", tool: null, kind: "visitors", file_name: "v.csv" },
      parseImport("plausible", PLAUSIBLE_VISITORS, undefined, 100).rows,
      caps,
      NOW,
    ) as any;
    expect(again).toMatchObject({ existing: true, import: { id: "imp_aaaaaaaaaaaaaaaa" } });
    saveImport(
      db,
      "imp_cccccccccccccccc",
      { source: "plausible", tool: null, kind: "pages", file_name: null },
      parseImport("plausible", PLAUSIBLE_PAGES, undefined, 100).rows,
      caps,
      NOW,
    );
    const big = saveImport(
      db,
      "imp_dddddddddddddddd",
      { source: "ga4", tool: null, kind: "sources", file_name: null },
      parseImport("ga4", GA4_SOURCES, undefined, 100).rows.concat({
        day: "2026-10-03",
        value: "x",
        visitors: 1,
        visits: 1,
        pageviews: 1,
        bounces: 0,
        visit_duration: 0,
      }),
      caps,
      NOW,
    ) as any;
    expect(big.error.code).toBe("quota_exceeded");
    // Live data starts 2026-11-03: October is imported only.
    engine.ingest(db, [ev({ ts: NOW - 60_000, visitor_hash: "v1", pathname: "/" })], NOW);
    const q = { from: "2026-10-01", to: "2026-11-03", metrics: ["visitors", "visits", "pageviews", "bounce_rate"], filters: [] };
    const plain = engine.stats(db, s, q as any, NOW) as any;
    const withImp = engine.stats(db, s, { ...q, imported: true } as any, NOW) as any;
    expect(plain.metrics.visitors).toBe(1);
    expect(withImp.metrics).toMatchObject({ visitors: 31, visits: 38, pageviews: 81 });
    expect(withImp.imported).toMatchObject({ included: true, days: 2 });
    const filtered = engine.stats(db, s, { ...q, imported: true, filters: parseFilters("country==DE") } as any, NOW) as any;
    expect(filtered.imported.included).toBe(false);
    const pages = engine.breakdown(
      db,
      s,
      { ...q, metrics: ["visitors", "pageviews"], breakdown: "page", imported: true } as any,
      NOW,
    ) as any;
    expect(pages.results.map((r: any) => [r.value, r.visitors, r.pageviews])).toEqual([
      ["/", 17, 51],
      ["/pricing", 3, 10],
    ]);
    const ts = engine.timeseries(db, s, { ...q, metrics: ["visitors"], interval: "day", imported: true } as any, NOW) as any;
    expect(ts.results.find((r: any) => r.date === "2026-10-02").visitors).toBe(20);
    expect((listImports(db) as any).live_data_from).toBe("2026-11-03");
    expect(deleteImport(db, "imp_cccccccccccccccc")).toEqual({ deleted: true, rows_deleted: 3 });
  });
});

describe("imports from any tool: generic CSV and rows", () => {
  it("reads the generic columns: kind from the one dimension, rates and durations weighted by visits", () => {
    const totals = parseImport(
      "other",
      "Date,Visitors,Visits,Pageviews,Bounce Rate,Visit Duration\n2026-10-01,10,20,40,50%,1:30\n2026-10-02,5,10,12,30,45\nTotal,15,30,52,,\n",
      undefined,
      100,
    );
    expect(totals).toMatchObject({ kind: "visitors", skipped: 1 });
    expect(totals.rows).toEqual([
      { day: "2026-10-01", value: "", visitors: 10, visits: 20, pageviews: 40, bounces: 10, visit_duration: 1800 },
      { day: "2026-10-02", value: "", visitors: 5, visits: 10, pageviews: 12, bounces: 3, visit_duration: 450 },
    ]);
    const kinds = {
      page: ["https://example.com/blog?ref=x", "/blog"],
      source: ["Direct", "(none)"],
      country: ["Germany", "DE"],
      device: ["Mobile", "mobile"],
    } as const;
    for (const [col, [raw, stored]] of Object.entries(kinds)) {
      const p = parseImport("other", `date,${col},visitors\n2026-10-01,${raw},3\n`, undefined, 10);
      expect(p.kind).toBe({ page: "pages", source: "sources", country: "countries", device: "devices" }[col]);
      expect(p.rows[0]!.value).toBe(stored);
    }
    expect(parseImport("other", "date,country,visitors\n2026-10-01,de,3\n", undefined, 10).rows[0]!.value).toBe("DE");
  });

  it("JSON rows give the same rows as the CSV; bad shapes are hinted", () => {
    const csv = parseImport(
      "other",
      "date,page,visitors,visits,pageviews,bounce_rate,visit_duration\n2026-10-01,/a,3,4,9,25,60\n2026-10-01,/a?x=1,1,1,1,0,0\n",
      undefined,
      10,
    );
    const rows = parseRows(
      [
        { date: "2026-10-01", page: "/a", visitors: 3, visits: 4, pageviews: 9, bounce_rate: 25, visit_duration: 60 },
        { date: "2026-10-01", page: "/a?x=1", visitors: "1", visits: 1, pageviews: 1, bounce_rate: 0, visit_duration: null },
      ],
      undefined,
    );
    expect(rows).toEqual(csv);
    expect(rows.rows).toEqual([{ day: "2026-10-01", value: "/a", visitors: 4, visits: 5, pageviews: 10, bounces: 1, visit_duration: 240 }]);
    expect(() => parseImport("other", "date,pageviews\n2026-10-01,3\n", undefined, 10)).toThrow(/no visitors/);
    expect(() => parseImport("other", "visitors\n3\n", undefined, 10)).toThrow(/no date/);
    expect(() => parseRows([{ date: "2026-10-01", visitors: 1, page: "/", country: "DE" }], undefined)).toThrow(/more than one breakdown/);
    expect(() => parseRows([{ date: "2026-10-01", visitors: 1, page: "/" }], "visitors")).toThrow(/doesn't match/);
    expect(() => parseRows([{ date: "10/01/2026", visitors: 1 }], undefined)).toThrow(/No row had a date/);
  });

  it("keeps each tool's files apart: idempotent per (source, tool, kind, date range), listed with the tool", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    const rows = parseRows([{ date: "2026-10-01", visitors: 3 }], undefined).rows;
    const a = saveImport(db, "imp_aaaaaaaaaaaaaaaa", meta("other", "visitors", "fathom"), rows, CAPS, NOW) as any;
    const b = saveImport(db, "imp_bbbbbbbbbbbbbbbb", meta("other", "visitors", "umami"), rows, CAPS, NOW) as any;
    const again = saveImport(db, "imp_cccccccccccccccc", meta("other", "visitors", "fathom"), rows, CAPS, NOW) as any;
    saveImport(db, "imp_dddddddddddddddd", meta("plausible", "visitors"), rows, CAPS, NOW);
    expect([a.existing, b.existing, again.existing, again.import.id]).toEqual([false, false, true, "imp_aaaaaaaaaaaaaaaa"]);
    expect(again.import).toMatchObject({ source: "other", tool: "fathom", kind: "visitors" });
    expect((listImports(db) as any).imports.map((i: any) => [i.source, i.tool])).toEqual([
      ["other", "fathom"],
      ["other", "umami"],
      ["plausible", null],
    ]);
  });

  it("migration 10 adds imports.tool to a DO that has imports, keeping them and their key", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    db.run("DROP TABLE imports");
    for (const s of IMPORTS_SQL) db.run(s); // the table as versions 8 and 9 left it
    db.run(
      "INSERT INTO imports (id, source, kind, file_name, from_day, to_day, rows, created_at, updated_at) VALUES ('imp_oooooooooooooooo', 'ga4', 'visitors', 'old.csv', '2026-10-01', '2026-10-01', 1, 1, 1)",
    );
    db.run("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
    expect(engine.hasColumn(db, "imports", "tool")).toBe(false);
    engine.migrate(db);
    expect(engine.schemaVersion(db)).toBe(engine.SCHEMA_VERSION);
    expect(engine.hasColumn(db, "imports", "tool")).toBe(true);
    expect(db.all("SELECT id, source, tool, file_name FROM imports")).toEqual([
      { id: "imp_oooooooooooooooo", source: "ga4", tool: "", file_name: "old.csv" },
    ]);
    const rows = parseRows([{ date: "2026-10-01", visitors: 3 }], undefined).rows;
    expect((saveImport(db, "imp_nnnnnnnnnnnnnnnn", meta("ga4", "visitors"), rows, CAPS, NOW) as any).import.id).toBe(
      "imp_oooooooooooooooo",
    );
    engine.migrate(db); // idempotent
    expect(db.all("SELECT COUNT(*) AS n FROM imports")[0]!.n).toBe(1);
  });
});

/** A GA4 runReport response, as the Data API and the GA4 MCP server return it. */
function ga4Report(dims: string[], mets: string[], rows: (string | number)[][], extra: Record<string, unknown> = {}) {
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: mets.map((name) => ({ name, type: "TYPE_INTEGER" })),
    rows: rows.map((r) => ({
      dimensionValues: r.slice(0, dims.length).map((value) => ({ value: String(value) })),
      metricValues: r.slice(dims.length).map((value) => ({ value: String(value) })),
    })),
    rowCount: rows.length,
    kind: "analyticsData#runReport",
    ...extra,
  };
}

describe("GA4 Data API report JSON", () => {
  it("gives the same rows as the equivalent report CSV", () => {
    const csv = parseImport(
      "ga4",
      "Date,Page path + query string,Active users,Sessions,Views,Bounce rate,Average session duration\n20261001,/pricing?plan=pro,4,5,9,0.2,30\n20261001,/pricing,2,2,3,0.5,10\n20261002,/,7,8,10,0.25,12.5\n",
      undefined,
      100,
    );
    const json = parseReport(
      "ga4",
      ga4Report(
        ["date", "pagePathPlusQueryString"],
        ["activeUsers", "sessions", "screenPageViews", "bounceRate", "averageSessionDuration"],
        [
          ["20261001", "/pricing?plan=pro", 4, 5, 9, 0.2, 30],
          ["20261001", "/pricing", 2, 2, 3, 0.5, 10],
          ["20261002", "/", 7, 8, 10, 0.25, 12.5],
        ],
      ),
      {},
      undefined,
      100,
    );
    expect(json).toEqual(csv);
    expect(json.rows[0]).toEqual({
      day: "2026-10-01",
      value: "/pricing",
      visitors: 6,
      visits: 7,
      pageviews: 12,
      bounces: 2,
      visit_duration: 170,
    });
    // sources: (direct) -> (none), medium dropped; countries: names -> ISO; snake_case (protobuf dicts) works too
    const src = parseReport(
      "ga4",
      ga4Report(
        ["date", "sessionSourceMedium"],
        ["totalUsers", "sessions"],
        [
          ["20261001", "(direct) / (none)", 3, 4],
          ["20261001", "google / cpc", 2, 2],
        ],
      ),
      {},
      undefined,
      100,
    );
    expect(src).toMatchObject({
      kind: "sources",
      rows: [
        { value: "(none)", visitors: 3 },
        { value: "google", visitors: 2 },
      ],
    });
    const snake = {
      dimension_headers: [{ name: "date" }, { name: "country" }],
      metric_headers: [{ name: "activeUsers" }],
      rows: [{ dimension_values: [{ value: "20261001" }, { value: "Germany" }], metric_values: [{ value: "5" }] }],
      row_count: 1,
    };
    expect(parseReport("ga4", snake, {}, undefined, 100)).toMatchObject({ kind: "countries", rows: [{ value: "DE", visitors: 5 }] });
  });

  it("says which dimensions and metrics to request when a report can't be mapped", () => {
    const bad = (report: unknown) => {
      try {
        parseReport("ga4", report, {}, undefined, 100);
      } catch (e: any) {
        return { message: e.message as string, hint: e.hint as string };
      }
      throw new Error("expected an ImportError");
    };
    const noDate = bad(ga4Report(["pagePath"], ["activeUsers"], [["/", 1]]));
    expect(noDate.message).toMatch(/no date dimension/);
    expect(noDate.hint).toMatch(/"name":"date".*pagePath.*activeUsers/);
    expect(bad(ga4Report(["date", "city"], ["activeUsers"], [["20261001", "Berlin", 1]])).message).toMatch(/can't be imported: city/);
    expect(bad(ga4Report(["date", "pagePath", "country"], ["activeUsers"], [])).message).toMatch(/more than one breakdown/);
    expect(bad(ga4Report(["date"], ["sessions"], [["20261001", 1]])).message).toMatch(/no users metric/);
    expect(bad(ga4Report(["date"], ["activeUsers"], [["20261001", 1]], { rowCount: 25000 })).hint).toMatch(/limit of at least 25000/);
    expect(bad({ results: [] }).hint).toMatch(/source plausible/);
    expect(bad({ foo: 1 }).message).toMatch(/not a GA4 runReport/);
  });
});

describe("Plausible Stats API v2 JSON", () => {
  it("maps time:day plus one breakdown, from the echoed query or dimensions / metrics given", () => {
    const report = {
      results: [
        { dimensions: ["2026-10-01", "Germany"], metrics: [10, 12, 30, 50, 60] },
        { dimensions: ["2026-10-02", "Estonia"], metrics: [3, 4, 5, 25, 10] },
      ],
      meta: {},
      query: {
        site_id: "example.com",
        metrics: ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"],
        dimensions: ["time:day", "visit:country_name"],
        date_range: ["2026-10-01T00:00:00+00:00", "2026-10-02T23:59:59+00:00"],
      },
    };
    const p = parseReport("plausible", report, {}, undefined, 100);
    expect(p).toMatchObject({ kind: "countries", skipped: 0 });
    expect(p.rows).toEqual([
      { day: "2026-10-01", value: "DE", visitors: 10, visits: 12, pageviews: 30, bounces: 6, visit_duration: 720 },
      { day: "2026-10-02", value: "EE", visitors: 3, visits: 4, pageviews: 5, bounces: 1, visit_duration: 40 },
    ]);
    const bare = { results: [{ dimensions: ["2026-10-01", "Direct / None"], metrics: [7] }] };
    expect(
      parseReport("plausible", bare, { dimensions: ["time:day", "visit:source"], metrics: ["visitors"] }, undefined, 100),
    ).toMatchObject({
      kind: "sources",
      rows: [{ value: "(none)", visitors: 7 }],
    });
    expect(() => parseReport("plausible", bare, {}, undefined, 100)).toThrow(/doesn't say which dimensions/);
    expect(() =>
      parseReport("plausible", { ...bare, query: { dimensions: ["visit:source"], metrics: ["visitors"] } }, {}, undefined, 100),
    ).toThrow(/no time:day/);
    expect(() =>
      parseReport(
        "plausible",
        { ...bare, query: { dimensions: ["time:day", "visit:browser"], metrics: ["visitors"] } },
        {},
        undefined,
        100,
      ),
    ).toThrow(/can't be imported: visit:browser/);
    expect(() => parseReport("plausible", ga4Report(["date"], ["activeUsers"], [["20261001", 1]]), {}, undefined, 100)).toThrow(/GA4/);
  });
});

describe("compare with the old tool", () => {
  const tz = settings({ timezone: "UTC" });
  /** Live visitors per day (days ago from NOW), plus imported daily visitors of one tool. */
  function site(
    live: Record<number, number>,
    imported: Record<number, number>,
    tool: [source: "ga4" | "plausible" | "other", tool: string | null] = ["ga4", null],
  ) {
    const db = memoryDb();
    engine.configure(db, tz);
    const evs = Object.entries(live).flatMap(([ago, count]) =>
      Array.from({ length: count }, (_, i) => ev({ ts: NOW - Number(ago) * DAY, visitor_hash: `v${ago}_${i}` })),
    );
    engine.ingest(db, evs, NOW);
    const ymd = (ago: number) => new Date(NOW - ago * DAY).toISOString().slice(0, 10);
    const rows = Object.entries(imported).map(([ago, visitors]) => ({ date: ymd(Number(ago)), visitors }));
    if (rows.length) saveImport(db, "imp_aaaaaaaaaaaaaaaa", meta(tool[0], "visitors", tool[1]), parseRows(rows, undefined).rows, CAPS, NOW);
    return db;
  }

  it("close, lower and higher on complete days after the first live day (today and test traffic left out)", () => {
    // live from 6 days ago (left out: partial); days 5..1 compared; today (0) left out
    const live = { 6: 50, 5: 10, 4: 10, 3: 10, 2: 10, 1: 10, 0: 99 };
    const close = compareImports(site(live, { 6: 80, 5: 11, 4: 9, 3: 10, 2: 12, 1: 10, 0: 5 }), tz, {}, NOW) as any;
    expect(close).toMatchObject({
      source: "ga4",
      tool: null,
      overlap_days: 5,
      ratio: 0.96,
      verdict: "close",
      live_data_from: "2026-10-28",
    });
    expect(close.days[0]).toEqual({ date: "2026-10-29", imported_visitors: 11, live_visitors: 10 });
    expect(close.days.at(-1).date).toBe("2026-11-02");
    expect(close.note).toMatch(/bots.*consent banner.*ad blockers.*snippet.*cookie/);
    const lower = compareImports(site(live, { 5: 20, 4: 20, 3: 20 }, ["other", "fathom"]), tz, {}, NOW) as any;
    expect(lower).toMatchObject({ source: "other", tool: "fathom", overlap_days: 3, ratio: 0.5, verdict: "lower" });
    expect(lower.note).toMatch(/50% fewer visitors than fathom.*Keep fathom installed until the verdict is close/);
    expect(lower.next_steps.join(" ")).toMatch(/breakdown=page/);
    const higher = compareImports(site(live, { 3: 5, 2: 5, 1: 6 }, ["plausible", null]), tz, {}, NOW) as any;
    expect(higher).toMatchObject({ source: "plausible", overlap_days: 3, ratio: 1.88, verdict: "higher" });
    // debug traffic doesn't count as live visitors
    const db = site({ 4: 2, 3: 2, 2: 2, 1: 2 }, { 3: 2, 2: 2, 1: 2 });
    engine.ingest(
      db,
      Array.from({ length: 20 }, (_, i) => ev({ ts: NOW - 2 * DAY, visitor_hash: `d${i}`, debug: true })),
      NOW,
    );
    expect(compareImports(db, tz, {}, NOW)).toMatchObject({ ratio: 1, verdict: "close" });
  });

  it("not_enough_overlap with fewer than 3 days, no live data or no import; the source with the most overlap by default", () => {
    const few = compareImports(site({ 3: 5, 2: 5, 1: 5 }, { 2: 5, 1: 5 }), tz, {}, NOW) as any;
    expect(few).toMatchObject({ overlap_days: 2, ratio: 1, verdict: "not_enough_overlap" });
    expect(few.next_steps.join(" ")).toMatch(/Import GA4's daily visitors for 2026-11-01 to 2026-11-02/);
    const none = compareImports(site({}, { 2: 5 }), tz, {}, NOW) as any;
    expect(none).toMatchObject({
      source: "ga4",
      overlap_days: 0,
      days: [],
      ratio: null,
      verdict: "not_enough_overlap",
      live_data_from: null,
    });
    expect(none.next_steps[0]).toMatch(/Install the tracker/);
    const empty = compareImports(site({ 5: 1, 4: 1, 3: 1, 2: 1 }, {}), tz, {}, NOW) as any;
    expect(empty).toMatchObject({ source: null, tool: null, overlap_days: 0, verdict: "not_enough_overlap" });
    // two tools: the one with more overlapping days wins unless asked for
    const db = site({ 5: 4, 4: 4, 3: 4, 2: 4, 1: 4 }, { 4: 4, 3: 4, 2: 4, 1: 4 }, ["other", "umami"]);
    const ymd = (ago: number) => new Date(NOW - ago * DAY).toISOString().slice(0, 10);
    saveImport(
      db,
      "imp_bbbbbbbbbbbbbbbb",
      meta("ga4", "visitors"),
      parseRows(
        [1, 2].map((a) => ({ date: ymd(a), visitors: 1 })),
        undefined,
      ).rows,
      CAPS,
      NOW,
    );
    expect(compareImports(db, tz, {}, NOW)).toMatchObject({ source: "other", tool: "umami", overlap_days: 4, verdict: "close" });
    expect(compareImports(db, tz, { source: "ga4" }, NOW)).toMatchObject({
      source: "ga4",
      tool: null,
      overlap_days: 2,
      verdict: "not_enough_overlap",
    });
  });
});
