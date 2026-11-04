import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { listCosts, upsertCosts } from "../../src/do/costs";
import { parseCsv } from "../../src/lib/csv";
import { parseFilters } from "../../src/lib/filters";
import { DAY, HOUR, NOW, ev, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const row = (over: Record<string, unknown> = {}) => ({
  day: "2026-11-03",
  source: "google",
  campaign: "brand",
  medium: "cpc",
  cost: 50,
  currency: "USD",
  clicks: 10,
  impressions: 100,
  ...over,
});

describe("cost rows", () => {
  it("upsert by (day, source, campaign), with a cap", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    expect(upsertCosts(db, [row(), row({ campaign: "generic" })], 3).results.map((r) => r.existing)).toEqual([false, false]);
    expect(upsertCosts(db, [row()], 3).results[0]).toEqual({ ok: true, existing: true, changed: false });
    expect(upsertCosts(db, [row({ cost: 60 })], 3).results[0]).toEqual({ ok: true, existing: true, changed: true });
    const capped = upsertCosts(db, [row({ day: "2026-11-02" }), row({ day: "2026-11-01" })], 3);
    expect(capped.results.map((r) => r.reason ?? "ok")).toEqual(["ok", "cost_rows_limit"]);
    expect(capped.stored).toBe(3);
    const l = listCosts(db, { from: "2026-11-01", to: "2026-11-03", limit: 10, offset: 0 }) as any;
    expect([l.total, l.total_cost]).toEqual([3, 110 + 50]);
  });

  it("parses CSV with quotes and CRLF", () => {
    const { rows, more } = parseCsv(
      '﻿Date,Source,Campaign,Cost\r\n2026-11-03,google,"brand, exact",12.5\r\n2026-11-03,meta,"say ""hi""",3\n',
      10,
    );
    expect(more).toBe(false);
    expect(rows).toEqual([
      { date: "2026-11-03", source: "google", campaign: "brand, exact", cost: "12.5" },
      { date: "2026-11-03", source: "meta", campaign: 'say "hi"', cost: "3" },
    ]);
    expect(parseCsv("a\n1\n2\n3\n", 2).more).toBe(true);
  });
});

describe("cost metrics in reports", () => {
  let db: ReturnType<typeof memoryDb>;
  const s = settings({ visitor_id_mode: "persistent" });
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, s);
    const paid = (v: string, campaign: string, src = "google") =>
      ev({
        ts: NOW - 2 * HOUR,
        visitor_hash: v,
        utm_source: src,
        utm_medium: "cpc",
        utm_campaign: campaign,
        source: src === "google" ? "Google" : "Facebook",
        channel: "Paid Search",
      });
    engine.ingest(
      db,
      [
        paid("a", "brand"),
        paid("b", "brand"),
        paid("c", "generic"),
        paid("d", "retarget", "facebook"),
        ev({ ts: NOW - 2 * HOUR, visitor_hash: "e" }),
      ],
      NOW,
    );
    payments.ingestPayments(
      db,
      [
        pay({ external_id: "p1", visitor_id: "a", amount: 200, ts: NOW - HOUR }),
        pay({ external_id: "p2", visitor_id: "d", amount: 30, ts: NOW - HOUR }),
      ],
      NOW,
    );
    upsertCosts(
      db,
      [
        row({ cost: 40 }),
        row({ campaign: "generic", cost: 60 }),
        row({ source: "facebook", campaign: "retarget", cost: 15 }),
        row({ day: "2026-11-02", cost: 100 }),
      ],
      100,
    );
  });

  it("stats: cost, roas, cac, cost per visit; utm filters narrow the cost, other filters null it", () => {
    const st = engine.stats(db, s, { period: "today", metrics: ["cost", "roas", "cac", "cost_per_visit"], filters: [] } as any, NOW) as any;
    expect(st.metrics).toEqual({ cost: 115, roas: 2, cac: 57.5, cost_per_visit: 23 });
    const g = engine.stats(
      db,
      s,
      { period: "today", metrics: ["cost", "roas"], filters: parseFilters("utm_source==google") } as any,
      NOW,
    ) as any;
    expect(g.metrics).toEqual({ cost: 100, roas: 2 });
    const c = engine.stats(
      db,
      s,
      { period: "today", metrics: ["cost", "visitors"], filters: parseFilters("country==DE") } as any,
      NOW,
    ) as any;
    expect(c.metrics.cost).toBeNull();
    expect(c.notes.join(" ")).toContain("Cost metrics");
    const two = engine.stats(db, s, { period: "7d", metrics: ["cost"], filters: [] } as any, NOW) as any;
    expect(two.metrics.cost).toBe(215);
  });

  it("breakdowns by utm_campaign / utm_source / source, and timeseries by day", () => {
    const b = engine.breakdown(
      db,
      s,
      { period: "today", metrics: ["visits", "revenue", "cost", "roas", "cpa"], filters: [], breakdown: "utm_campaign" } as any,
      NOW,
    ) as any;
    const by = Object.fromEntries(b.results.map((r: any) => [r.value, r]));
    expect(by.brand).toEqual({ value: "brand", visits: 2, revenue: 200, cost: 40, roas: 5, cpa: null });
    expect(by.generic).toMatchObject({ cost: 60, roas: 0 });
    expect(by.retarget).toMatchObject({ cost: 15, roas: 2 });
    const src = engine.breakdown(db, s, { period: "today", metrics: ["cost"], filters: [], breakdown: "source" } as any, NOW) as any;
    expect(Object.fromEntries(src.results.map((r: any) => [r.value, r.cost]))).toMatchObject({ Google: 100, Facebook: 15 });
    const dev = engine.breakdown(db, s, { period: "today", metrics: ["cost"], filters: [], breakdown: "device" } as any, NOW) as any;
    expect(dev.results[0].cost).toBeNull();
    const ts = engine.timeseries(db, s, { period: "7d", interval: "day", metrics: ["cost", "visits"], filters: [] } as any, NOW) as any;
    expect(Object.fromEntries(ts.results.map((r: any) => [r.date, r.cost]))).toMatchObject({
      "2026-11-02": 100,
      "2026-11-03": 115,
      "2026-11-01": 0,
    });
    const hourly = engine.timeseries(db, s, { period: "today", interval: "hour", metrics: ["cost"], filters: [] } as any, NOW) as any;
    expect(hourly.results[0].cost).toBeNull();
    expect(Object.keys(ts.results[0])).toEqual(["date", "cost", "visits"]);
    void DAY;
  });
});
