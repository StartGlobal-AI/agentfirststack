import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { csvCell, csvRows, toCsv } from "../../src/lib/csv";
import { type Metric, parseFilterJson, parseFilters } from "../../src/lib/filters";
import { wildcardGlob } from "../../src/lib/query";
import { resolvePeriod } from "../../src/lib/time";
import type { Goal } from "../../src/lib/types";
import { DAY, MIN, NOW, type Rows, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const q = (over: Record<string, unknown> = {}) => ({ period: "24h" as const, metrics: ["visitors"] as Metric[], filters: [], ...over });

describe("wildcards and nested filter groups", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings());
    engine.ingest(
      db,
      [
        ev({ visitor_hash: "a", pathname: "/blog/one", country: "US", device: "desktop" }),
        ev({ visitor_hash: "b", pathname: "/blog/two", country: "DE", device: "mobile" }),
        ev({ visitor_hash: "c", pathname: "/docs/x*y", country: "US", device: "mobile" }),
        ev({ visitor_hash: "d", pathname: "/pricing", country: "FR", device: "desktop" }),
      ],
      NOW,
    );
  });
  const visitors = (filters: string, where?: unknown) =>
    (engine.stats(db, settings(), q({ filters: parseFilters(filters), where: where ? parseFilterJson(where) : null }), NOW) as any).metrics
      .visitors;

  it("* in == and != is a wildcard; \\* is a literal star; [ and ? are literal", () => {
    expect(visitors("page==/blog/*")).toBe(2);
    expect(visitors("page!=/blog/*")).toBe(2);
    expect(visitors("page==/docs/x\\*y")).toBe(1);
    expect(visitors("page==/docs/x\\*")).toBe(0);
    expect(visitors("page==/blog/*|/pricing")).toBe(3);
    expect(wildcardGlob("/a?b[c]/*")).toBe("/a[?]b[[]c]/*");
  });

  it("filters_json: OR across keys, nested AND, NOT; ANDed with filters", () => {
    expect(
      visitors("", [
        "or",
        [
          ["==", "country", ["FR"]],
          ["==", "device", ["mobile"]],
        ],
      ]),
    ).toBe(3);
    expect(
      visitors("", [
        "or",
        [
          ["==", "country", ["FR"]],
          [
            "and",
            [
              ["==", "country", ["US"]],
              ["==", "device", ["mobile"]],
            ],
          ],
        ],
      ]),
    ).toBe(2);
    expect(visitors("", ["not", ["==", "country", ["US"]]])).toBe(2);
    expect(
      visitors("device==desktop", [
        "or",
        [
          ["==", "country", ["US"]],
          ["==", "country", ["DE"]],
        ],
      ]),
    ).toBe(1);
  });

  it("rejects bad groups with a clear message", () => {
    expect(() => parseFilterJson('["xor", []]')).toThrow(/Unknown filters_json op/);
    expect(() => parseFilterJson(["==", "nope", ["x"]])).toThrow(/Unknown filter key/);
    expect(() => parseFilterJson(["not", ["not", ["not", ["not", ["==", "country", ["US"]]]]]])).toThrow(/nested too deeply/);
    expect(() => parseFilterJson("{bad")).toThrow(/not valid JSON/);
  });
});

describe("breakdowns: several dimensions, pagination, sort", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings());
    const rows = [
      ["a", "US", "desktop", "/x"],
      ["b", "US", "desktop", "/x"],
      ["c", "US", "mobile", "/y"],
      ["d", "DE", "mobile", "/y"],
      ["e", "DE", "desktop", "/z"],
    ] as const;
    for (const [v, country, device, page] of rows)
      engine.ingest(db, [ev({ visitor_hash: v, country, device, pathname: page, region: "R", city: "C" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - DAY - MIN, visitor_hash: "old", country: "US", device: "desktop" })], NOW);
  });
  const bd = (over: Record<string, unknown>) =>
    engine.breakdown(db, settings(), { ...q(), breakdown: "country", ...over } as any, NOW) as any;

  it("2-3 dimensions: each row carries every dimension; comparisons match by all of them", () => {
    const r = bd({ breakdown: ["country", "device"], compare: { mode: "previous" } });
    expect(r.property).toBe("country,device");
    expect(r.results.map((x: any) => [x.country, x.device, x.visitors, x.comparison.metrics.visitors])).toEqual([
      ["US", "desktop", 2, 1],
      ["DE", "desktop", 1, 0],
      ["DE", "mobile", 1, 0],
      ["US", "mobile", 1, 0],
    ]);
    expect(r.results[0].value).toBe("US");
    // page first internally (session-scoped), but the row's value is the first dimension asked for
    const p = bd({ breakdown: ["device", "page"] });
    expect(p.results[0]).toMatchObject({ value: "desktop", device: "desktop", page: "/x", visitors: 2 });
    // region rows still carry country
    expect(bd({ breakdown: ["region", "device"] }).results[0]).toMatchObject({
      region: "R",
      device: "desktop",
      country: expect.any(String),
    });
  });

  it("offset, total_rows, next_offset; sort by a metric ascending or by value", () => {
    const first = bd({ breakdown: ["country", "device"], limit: 2 });
    expect(first).toMatchObject({ total_rows: 4, offset: 0, next_offset: 2 });
    const second = bd({ breakdown: ["country", "device"], limit: 2, offset: 2 });
    expect(second).toMatchObject({ total_rows: 4, offset: 2, next_offset: null });
    expect(second.results).toHaveLength(2);
    expect(bd({ offset: 10 })).toMatchObject({ results: [], total_rows: 2, next_offset: null });
    expect(bd({ sort: { by: "metric", metric: "visitors", dir: "asc" } }).results.map((x: any) => x.value)).toEqual(["DE", "US"]);
    expect(bd({ sort: { by: "value", dir: "desc" } }).results.map((x: any) => x.value)).toEqual(["US", "DE"]);
    expect(bd({ breakdown: "goal", sort: { by: "value" } }).results).toEqual([]);
  });
});

describe("timestamp ranges and a per-query timezone", () => {
  it("ISO timestamps give an exact [from, to) range; previous is the same length before", () => {
    const r = resolvePeriod({ from: "2026-11-03T09:30:00Z", to: "2026-11-03T11:00:00Z" }, "UTC", NOW);
    expect(r).toMatchObject({
      exact: true,
      start: Date.UTC(2026, 10, 3, 9, 30),
      end: Date.UTC(2026, 10, 3, 11),
      interval: "hour",
      from: "2026-11-03",
    });
    expect(() => resolvePeriod({ from: "2026-11-03T11:00:00Z", to: "2026-11-03T09:00:00Z" }, "UTC", NOW)).toThrow(/before/);
  });

  it("counts only the window, buckets and periods follow the timezone override", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    engine.ingest(
      db,
      [ev({ ts: Date.UTC(2026, 10, 3, 10), visitor_hash: "in" }), ev({ ts: Date.UTC(2026, 10, 3, 12), visitor_hash: "out" })],
      NOW,
    );
    const w = engine.stats(
      db,
      settings(),
      { ...q({ from: "2026-11-03T09:30:00Z", to: "2026-11-03T11:00:00Z" }), compare: { mode: "previous" } } as any,
      NOW,
    ) as any;
    expect(w.metrics.visitors).toBe(1);
    expect(w.comparison.period).toMatchObject({ start: Date.UTC(2026, 10, 3, 8), end: Date.UTC(2026, 10, 3, 9, 30) });
    // 23:30 UTC on the 2nd is the 3rd in Tokyo
    engine.ingest(db, [ev({ ts: Date.UTC(2026, 10, 2, 23, 30), visitor_hash: "late" })], NOW);
    const tokyo = engine.timeseries(db, settings(), { ...q({ period: "7d", timezone: "Asia/Tokyo" }), interval: "day" } as any, NOW) as any;
    expect(tokyo.period.timezone).toBe("Asia/Tokyo");
    // in Tokyo all three are on the 3rd (08:30, 19:00, 21:00 JST); in UTC the late one is on the 2nd
    expect(tokyo.results.find((b: any) => b.date === "2026-11-03").visitors).toBe(3);
    const utc = engine.timeseries(db, settings(), { ...q({ period: "7d" }), interval: "day" } as any, NOW) as any;
    expect(utc.results.find((b: any) => b.date === "2026-11-02").visitors).toBe(1);
    expect(utc.results.find((b: any) => b.date === "2026-11-03").visitors).toBe(2);
  });
});

describe("goals: prop conditions and once per visit", () => {
  it("props must all match; once_per_visit counts one conversion (and one value) per session", () => {
    const db = memoryDb();
    const goals: Goal[] = [
      { id: "g1", name: "Pro signup", type: "event", match: "signup", value: null, props: { plan: "pro" }, created_at: NOW },
      { id: "g2", name: "Viewed pricing", type: "pageview", match: "/pricing", value: 5, counting: "once_per_visit", created_at: NOW + 1 },
    ];
    engine.configure(db, settings({ goals }));
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 30 * MIN, name: "signup", props: '{"plan":"pro"}' }),
        ev({ ts: NOW - 29 * MIN, name: "signup", props: '{"plan":"free"}' }),
        ev({ ts: NOW - 28 * MIN, pathname: "/pricing" }),
        ev({ ts: NOW - 27 * MIN, pathname: "/pricing" }),
        ev({ ts: NOW - 26 * MIN, pathname: "/pricing", visitor_hash: "v2" }),
      ],
      NOW,
    );
    const rows = (
      engine.breakdown(
        db,
        settings({ goals }),
        { ...q({ metrics: ["visitors", "conversions", "revenue"] }), breakdown: "goal" } as any,
        NOW,
      ) as Rows
    ).results;
    expect(rows.map((r) => [r.value, r.conversions, r.revenue, r.goal_value])).toEqual([
      ["Viewed pricing", 2, 0, 10],
      ["Pro signup", 1, 0, 0],
    ]);
    const t = engine.stats(db, settings({ goals }), q({ metrics: ["conversions", "revenue", "goal_value"] }), NOW) as any;
    expect(t.metrics).toEqual({ conversions: 3, revenue: 0, goal_value: 10 });
  });
});

describe("CSV", () => {
  it("quotes, neutralises formulas, flattens comparisons", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell(-1)).toBe("-1");
    expect(csvCell("a,b")).toBe('"a,b"');
    const out = toCsv([{ value: "/x", visitors: 2, comparison: { metrics: { visitors: 1 }, change_percent: { visitors: 100 } } }]);
    expect(out).toBe("value,visitors,visitors_previous,visitors_change_percent\r\n/x,2,1,100\r\n");
    expect(csvRows("stats", { period: { from: "a", to: "b" }, metrics: { visitors: 3 } })).toEqual([{ from: "a", to: "b", visitors: 3 }]);
  });
});
