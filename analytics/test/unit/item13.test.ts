import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { alertAnnotation, annotationsIn } from "../../src/do/annotations";
import { parseFilters } from "../../src/lib/filters";
import { HOUR, MIN, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("channel groups, session timeout, alert annotations", () => {
  it("custom channel groups are a query-time dimension and filter, first match wins, else the built-in channel", () => {
    const db = memoryDb();
    const s = settings({
      channel_groups: [
        { name: "Partners", source: ["partner-*"] },
        { name: "Paid Social", medium: ["paid_social", "cpc"], source: ["facebook", "Instagram"] },
      ],
    });
    engine.configure(db, s);
    engine.ingest(
      db,
      [
        ev({ visitor_hash: "a", source: "partner-acme", channel: "Referral" }),
        ev({ visitor_hash: "b", source: "instagram", utm_medium: "CPC", channel: "Paid Social" }),
        ev({ visitor_hash: "c", source: "facebook", utm_medium: "organic", channel: "Organic Social" }),
        ev({ visitor_hash: "d", channel: "Direct" }),
      ],
      NOW,
    );
    const b = engine.breakdown(
      db,
      s,
      { period: "today", metrics: ["visitors"], filters: [], breakdown: "channel_group" } as any,
      NOW,
    ) as any;
    expect(Object.fromEntries(b.results.map((r: any) => [r.value, r.visitors]))).toEqual({
      Partners: 1,
      "Paid Social": 1,
      "Organic Social": 1,
      Direct: 1,
    });
    const f = engine.stats(
      db,
      s,
      { period: "today", metrics: ["visitors"], filters: parseFilters("channel_group==Partners") } as any,
      NOW,
    ) as any;
    expect(f.metrics.visitors).toBe(1);
  });

  it("the session timeout is the site's", () => {
    const db = memoryDb();
    const s10 = settings({ session_timeout_minutes: 10 });
    engine.configure(db, s10);
    engine.ingest(db, [ev({ ts: NOW - HOUR, visitor_hash: "a" }), ev({ ts: NOW - HOUR + 15 * MIN, visitor_hash: "a" })], NOW);
    expect(db.all("SELECT COUNT(*) AS n FROM sessions")[0]!.n).toBe(2);
    const db2 = memoryDb();
    engine.configure(db2, settings());
    engine.ingest(db2, [ev({ ts: NOW - HOUR, visitor_hash: "a" }), ev({ ts: NOW - HOUR + 15 * MIN, visitor_hash: "a" })], NOW);
    expect(db2.all("SELECT COUNT(*) AS n FROM sessions")[0]!.n).toBe(1);
  });

  it("an alert that fired is an annotation (once per alert and minute)", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    const a = { alert_id: "alr_x", ts: NOW - MIN, title: "Alert: Spike", description: "visitors 3x the usual", details: { value: 30 } };
    alertAnnotation(db, a, NOW);
    alertAnnotation(db, a, NOW);
    const list = annotationsIn(db, settings(), NOW - HOUR, NOW, "alert") as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "alert", title: "Alert: Spike", source: "alert" });
  });
});
