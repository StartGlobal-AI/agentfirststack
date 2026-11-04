import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { listSessions, realtimeMap } from "../../src/do/sessions-list";
import { parseFilters } from "../../src/lib/filters";
import { DAY, HOUR, MIN, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("session list, realtime map, visitor_type, did filters", () => {
  const s = settings({ visitor_id_mode: "persistent" });
  const setup = () => {
    const db = memoryDb();
    engine.configure(db, s);
    engine.ingest(
      db,
      [
        // a: yesterday, then today (returning); signs up today
        ev({ ts: NOW - DAY, visitor_hash: "a", pathname: "/" }),
        ev({
          ts: NOW - 3 * HOUR,
          visitor_hash: "a",
          pathname: "/pricing",
          city: "Berlin",
          country: "DE",
          latitude: 52.52,
          longitude: 13.4,
        }),
        ev({
          ts: NOW - 3 * HOUR + MIN,
          visitor_hash: "a",
          name: "signup",
          props: JSON.stringify({ replay_session_id: "rs_abcdef123" }),
          city: "Berlin",
          country: "DE",
          latitude: 52.52,
          longitude: 13.4,
        }),
        // b: new today, buys; c: new today, nothing
        ev({ ts: NOW - 2 * HOUR, visitor_hash: "b", pathname: "/", city: "Paris", country: "FR", latitude: 48.86, longitude: 2.35 }),
        ev({ ts: NOW - 2 * HOUR + MIN, origin: "server", visitor_hash: "b", name: "purchase", revenue: 20, currency: "USD" }),
        ev({ ts: NOW - 10 * MIN, visitor_hash: "c", pathname: "/blog", city: "Paris", country: "FR", latitude: 48.86, longitude: 2.35 }),
        ev({ ts: NOW - 5 * MIN, visitor_hash: "d", pathname: "/" }),
      ],
      NOW,
    );
    return db;
  };

  it("visitor_type splits new and returning; did==X / did!=Y keep visitors who did or didn't", () => {
    const db = setup();
    const b = engine.breakdown(
      db,
      s,
      { period: "today", metrics: ["visitors"], filters: [], breakdown: "visitor_type" } as any,
      NOW,
    ) as any;
    expect(Object.fromEntries(b.results.map((r: any) => [r.value, r.visitors]))).toEqual({ new: 3, returning: 1 });
    const ret = engine.stats(
      db,
      s,
      { period: "today", metrics: ["visitors"], filters: parseFilters("visitor_type==returning") } as any,
      NOW,
    ) as any;
    expect(ret.metrics.visitors).toBe(1);
    const did = engine.stats(
      db,
      s,
      { period: "today", metrics: ["visitors"], filters: parseFilters("did==signup|purchase") } as any,
      NOW,
    ) as any;
    expect(did.metrics.visitors).toBe(2);
    const not = engine.stats(
      db,
      s,
      { period: "today", metrics: ["visitors"], filters: parseFilters("did!=purchase;did!=signup") } as any,
      NOW,
    ) as any;
    expect(not.metrics.visitors).toBe(2);
    const sub = engine.stats(db, s, { period: "today", metrics: ["visitors"], filters: parseFilters("did~sign") } as any, NOW) as any;
    expect(sub.metrics.visitors).toBe(1);
  });

  it("lists sessions (filtered, sorted, paged) with replay links; maps the last 30 minutes", () => {
    const db = setup();
    const all = listSessions(
      db,
      s,
      { period: "today", filters: [], limit: 10, offset: 0 } as any,
      { site_id: "rsite_x", base: "https://replay.test" },
      NOW,
    ) as any;
    expect(all.total).toBe(4);
    expect(all.sessions[0].visitor_id).toBe("d"); // newest first
    const a = all.sessions.find((x: any) => x.visitor_id === "a");
    expect(a).toMatchObject({
      pageviews: 1,
      events: 2,
      replay: { session_id: "rs_abcdef123", url: "https://replay.test/v1/sites/rsite_x/sessions/rs_abcdef123" },
    });
    const byRev = listSessions(db, s, { period: "today", filters: [], sort: "revenue", limit: 1, offset: 0 } as any, null, NOW) as any;
    expect(byRev.sessions[0]).toMatchObject({ visitor_id: "b", revenue: 20 });
    expect(byRev.next_offset).toBe(1);
    const fr = listSessions(
      db,
      s,
      { period: "today", filters: parseFilters("country==FR"), limit: 10, offset: 0 } as any,
      null,
      NOW,
    ) as any;
    expect(fr.sessions.map((x: any) => x.visitor_id).sort()).toEqual(["b", "c"]);
    const map = realtimeMap(db, { filters: [] }, NOW) as any;
    expect(map).toMatchObject({
      minutes: 30,
      visitors: 2,
      unlocated_visitors: 1,
      points: [{ city: "Paris", latitude: 48.86, longitude: 2.35, visitors: 1 }],
    });
  });
});
