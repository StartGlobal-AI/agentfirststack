import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { type Metric, parseFilters } from "../../src/lib/filters";
import { MIN, NOW, type Rows, ev, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const NEW: Metric[] = [
  "visits",
  "engaged_visits",
  "engagement_rate",
  "engagement_time",
  "visits_per_visitor",
  "events_per_visit",
  "visit_conversion_rate",
  "average_order_value",
  "revenue_per_customer",
  "percentage",
];

describe("GA4-vocabulary metrics", () => {
  let db: ReturnType<typeof memoryDb>;
  const goals = [{ id: "goal_s", name: "Signup", type: "event" as const, match: "signup", value: null, created_at: NOW }];
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ goals }));
    const t = NOW - 60 * MIN;
    engine.ingest(db, [ev({ ts: t, visitor_hash: "v1" })], NOW);
    engine.ingest(db, [ev({ ts: t + 5_000, visitor_hash: "v1", name: "engagement", engagement_ms: 12_000 })], NOW); // engaged: 12 s
    engine.ingest(db, [ev({ ts: t, visitor_hash: "v2" })], NOW);
    engine.ingest(db, [ev({ ts: t + 3_000, visitor_hash: "v2", name: "engagement", engagement_ms: 3_000 })], NOW); // not engaged
    engine.ingest(db, [ev({ ts: t, visitor_hash: "v3" }), ev({ ts: t + MIN, visitor_hash: "v3", pathname: "/b" })], NOW); // 2 pageviews
    engine.ingest(db, [ev({ ts: t, visitor_hash: "v4" }), ev({ ts: t + MIN, visitor_hash: "v4", name: "signup" })], NOW); // converted
    payments.ingestPayments(
      db,
      [
        pay({ external_id: "a", visitor_id: "v1", amount: 100, ts: t + 2 * MIN }),
        pay({ external_id: "b", visitor_id: "v3", amount: 50, ts: t + 2 * MIN }),
        pay({ external_id: "c", visitor_id: "v1", amount: 30, type: "renewal", ts: t + 3 * MIN }),
      ],
      NOW,
    );
  });

  it("totals: engaged sessions, engagement rate and time, per-visit ratios, AOV, revenue per customer", () => {
    const r = engine.stats(db, settings({ goals }), { period: "24h", metrics: NEW, filters: [] }, NOW) as any;
    expect(r.metrics).toEqual({
      visits: 4,
      engaged_visits: 3,
      engagement_rate: 75,
      engagement_time: 15,
      visits_per_visitor: 1,
      events_per_visit: 1.5,
      visit_conversion_rate: 25,
      average_order_value: 75,
      revenue_per_customer: 90,
      percentage: 100,
    });
  });

  it("breakdown rows get percentage (share of all visitors) and the same metrics per row; sortable before limit", () => {
    const rows = (
      engine.breakdown(
        db,
        settings({ goals }),
        { period: "24h", metrics: ["visitors", "percentage", "engaged_visits"], filters: [], breakdown: "page" },
        NOW,
      ) as Rows
    ).results;
    expect(rows).toEqual([
      { value: "/", visitors: 4, percentage: 100, engaged_visits: 3 },
      { value: "/b", visitors: 1, percentage: 25, engaged_visits: 1 },
    ]);
    const filtered = (
      engine.breakdown(
        db,
        settings({ goals }),
        { period: "24h", metrics: ["percentage"], filters: parseFilters("page==/b"), breakdown: "page" },
        NOW,
      ) as Rows
    ).results;
    expect(filtered).toEqual([{ value: "/b", percentage: 100 }]);
    const byAov = (
      engine.breakdown(
        db,
        settings({ goals }),
        {
          period: "24h",
          metrics: ["average_order_value"],
          filters: [],
          breakdown: "page",
          sort: { by: "metric", metric: "average_order_value" },
        },
        NOW,
      ) as Rows
    ).results;
    expect(byAov).toEqual([
      { value: "/", average_order_value: 75 }, // (100 + 50) / 2 new purchases; the renewal isn't an order
      { value: "/b", average_order_value: 50 },
    ]);
  });

  it("without goals the engaged test still runs (time and pageviews) and visit_conversion_rate notes the missing goals", () => {
    engine.configure(db, settings());
    const r = engine.stats(
      db,
      settings(),
      { period: "24h", metrics: ["engaged_visits", "visit_conversion_rate"], filters: [] },
      NOW,
    ) as any;
    expect(r.metrics).toEqual({ engaged_visits: 2, visit_conversion_rate: 0 });
    expect(r.notes.join(" ")).toContain("No goals");
  });

  it("timeseries percentage is each bucket's share of the period's visitors", () => {
    const r = engine.timeseries(
      db,
      settings({ goals }),
      { period: "today", metrics: ["visitors", "percentage"], filters: [], interval: "day" },
      NOW,
    ) as any;
    expect(r.results).toEqual([{ date: "2026-11-03", visitors: 4, percentage: 100 }]);
  });
});
