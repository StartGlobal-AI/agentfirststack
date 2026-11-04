import { beforeEach, describe, expect, it } from "vitest";
import { digest } from "../../src/do/digest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { nextRunAt, reportPeriod } from "../../src/service/reports";
import { DAY, NOW, ev, google, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("digest", () => {
  let db: ReturnType<typeof memoryDb>;
  const goals = [{ id: "g", name: "Signup", type: "event" as const, match: "signup", value: null, created_at: NOW }];
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ goals }));
    // previous 7 days: 1 visitor; this 7 days: 3 visitors, a signup and a purchase
    engine.ingest(db, [ev({ ts: NOW - 10 * DAY, visitor_hash: "old" })], NOW);
    engine.ingest(
      db,
      [ev({ ts: NOW - 2 * DAY, visitor_hash: "a", ...google }), ev({ ts: NOW - 2 * DAY + 1000, visitor_hash: "a", name: "signup" })],
      NOW,
    );
    engine.ingest(db, [ev({ ts: NOW - DAY, visitor_hash: "b" }), ev({ ts: NOW - DAY, visitor_hash: "c", ...google })], NOW);
    payments.ingestPayments(db, [pay({ visitor_id: "a", ts: NOW - 2 * DAY + 2000, amount: 30 })], NOW);
  });

  it("kpis and revenue with the change vs the previous period, goals, channels, top lists, movers", () => {
    const d = digest(db, settings({ goals }), { period: "7d" }, NOW) as any;
    expect(d.kpis.visitors).toEqual({ value: 3, previous: 1, change_percent: 200 });
    expect(d.kpis.conversions).toMatchObject({ value: 1, previous: 0 });
    expect(d.revenue.revenue).toMatchObject({ value: 30, previous: 0 });
    expect(d.revenue.average_order_value.value).toBe(30);
    expect(d.goals).toEqual([{ name: "Signup", conversions: 1, visitors: 1, conversion_rate: 33.3, revenue: 0, change_percent: null }]);
    expect(d.channels.map((c: any) => c.value)).toEqual(["Organic Search", "Direct"]);
    expect(d.top_sources[0]).toMatchObject({ value: "Google", visitors: 2 });
    expect(d.movers.gainers[0]).toMatchObject({ value: "Google" });
  });
});

describe("report schedules", () => {
  // Tue 3 Nov 2026, 15:00 UTC
  it("weekly: the next chosen weekday at the hour (site timezone); monthly: the next day_of_month", () => {
    expect(new Date(nextRunAt({ cadence: "weekly", weekday: 1, day_of_month: null, hour: 8 }, "UTC", NOW)).toISOString()).toBe(
      "2026-11-09T08:00:00.000Z",
    );
    expect(new Date(nextRunAt({ cadence: "weekly", weekday: 2, day_of_month: null, hour: 16 }, "UTC", NOW)).toISOString()).toBe(
      "2026-11-03T16:00:00.000Z",
    );
    expect(new Date(nextRunAt({ cadence: "weekly", weekday: 2, day_of_month: null, hour: 9 }, "Europe/Berlin", NOW)).toISOString()).toBe(
      "2026-11-10T08:00:00.000Z",
    );
    expect(new Date(nextRunAt({ cadence: "monthly", weekday: null, day_of_month: 1, hour: 8 }, "UTC", NOW)).toISOString()).toBe(
      "2026-12-01T08:00:00.000Z",
    );
  });
  it("periods: the 7 days before a weekly send, the previous month for a monthly one", () => {
    expect(reportPeriod("weekly", "UTC", Date.UTC(2026, 10, 9, 8))).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(reportPeriod("monthly", "UTC", Date.UTC(2026, 11, 1, 8))).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(reportPeriod("monthly", "UTC", Date.UTC(2026, 0, 1, 8))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});
