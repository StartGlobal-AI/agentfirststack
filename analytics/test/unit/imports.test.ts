import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { deleteImport, listImports, saveImport } from "../../src/do/imports";
import { parseImport } from "../../src/lib/imports";
import { parseFilters } from "../../src/lib/filters";
import { NOW, ev, settings } from "./fixtures";
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
  });

  it("stores idempotently per file and date range, with caps; merges into unfiltered reports before live data", () => {
    const db = memoryDb();
    const s = settings({ timezone: "UTC" });
    engine.configure(db, s);
    const caps = { maxRows: 6, maxImports: 3 };
    const a = saveImport(
      db,
      "imp_aaaaaaaaaaaaaaaa",
      { source: "plausible", kind: "visitors", file_name: "v.csv" },
      parseImport("plausible", PLAUSIBLE_VISITORS, undefined, 100).rows,
      caps,
      NOW,
    ) as any;
    expect(a).toMatchObject({ existing: false, import: { from: "2026-10-01", to: "2026-10-02", rows: 2 } });
    const again = saveImport(
      db,
      "imp_bbbbbbbbbbbbbbbb",
      { source: "plausible", kind: "visitors", file_name: "v.csv" },
      parseImport("plausible", PLAUSIBLE_VISITORS, undefined, 100).rows,
      caps,
      NOW,
    ) as any;
    expect(again).toMatchObject({ existing: true, import: { id: "imp_aaaaaaaaaaaaaaaa" } });
    saveImport(
      db,
      "imp_cccccccccccccccc",
      { source: "plausible", kind: "pages", file_name: null },
      parseImport("plausible", PLAUSIBLE_PAGES, undefined, 100).rows,
      caps,
      NOW,
    );
    const big = saveImport(
      db,
      "imp_dddddddddddddddd",
      { source: "ga4", kind: "sources", file_name: null },
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
