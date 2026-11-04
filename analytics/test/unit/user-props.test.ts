import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { deleteIdentity } from "../../src/do/privacy";
import { listUserProps, userPropsOf } from "../../src/do/user-props";
import { parseFilters, parseMetrics } from "../../src/lib/filters";
import { HOUR, MIN, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("user properties", () => {
  it("keep the last value per user; browser values never replace server ones; null unsets; keys are capped", () => {
    const db = memoryDb();
    engine.configure(db, settings({ browser_user_props: true }));
    const t = NOW - HOUR;
    engine.ingest(
      db,
      [
        ev({ ts: t, origin: "server", user_id: "u1", name: "login", user_props: { plan: "pro", seats: "5" } }),
        ev({ ts: t + MIN, origin: "browser", user_id: "u1", user_props: { plan: "free", theme: "dark" } }),
        ev({ ts: t - MIN, origin: "server", user_id: "u1", name: "x", user_props: { seats: "3" } }), // older: ignored
        ev({ ts: t + 2 * MIN, origin: "server", user_id: "u2", name: "login", user_props: { plan: "free" } }),
        ev({ ts: t + 3 * MIN, origin: "server", user_id: "u2", name: "x", user_props: { plan: null } }),
      ],
      NOW,
    );
    expect(userPropsOf(db, "u1")).toEqual({ plan: "pro", seats: "5", theme: "dark" });
    expect(userPropsOf(db, "u2")).toEqual({});
    expect((listUserProps(db) as any).keys.map((k: any) => k.key).sort()).toEqual(["plan", "seats", "theme"]);
    // Server keys so far: plan, seats (theme was created by a browser and has its own budget).
    engine.ingest(db, [ev({ ts: t + 4 * MIN, origin: "server", user_id: "u3", name: "x", user_props: { a: "1", plan: "team" } })], NOW, {
      userPropKeys: 2,
    });
    expect(userPropsOf(db, "u3")).toEqual({ plan: "team" });
    expect(db.all("SELECT reason FROM drops WHERE reason LIKE '%user_prop_keys_limit'")).toHaveLength(1);
    expect((deleteIdentity(db, "user:u1") as any).sessions_deleted).toBeGreaterThan(0);
    expect(userPropsOf(db, "u1")).toEqual({});
  });

  it("break down and filter by user:<key>", () => {
    const db = memoryDb();
    const s = settings();
    engine.configure(db, s);
    const t = NOW - HOUR;
    engine.ingest(
      db,
      [
        ev({ ts: t, origin: "server", visitor_hash: "a", user_id: "u1", name: "login", user_props: { plan: "pro" } }),
        ev({ ts: t + MIN, visitor_hash: "a", user_id: "u1" }),
        ev({ ts: t, origin: "server", visitor_hash: "b", user_id: "u2", name: "login", user_props: { plan: "free" } }),
        ev({ ts: t, visitor_hash: "c" }),
      ],
      NOW,
    );
    const b = engine.breakdown(
      db,
      s,
      { period: "today", metrics: ["visitors", "events"], filters: [], breakdown: "user:plan" } as any,
      NOW,
    ) as any;
    expect(Object.fromEntries(b.results.map((r: any) => [r.value, r.visitors]))).toEqual({ pro: 1, free: 1, "(none)": 1 });
    const f = engine.stats(db, s, { period: "today", metrics: ["events"], filters: parseFilters("user:plan==pro") } as any, NOW) as any;
    expect(f.metrics.events).toBe(2);
  });
});

describe("custom metrics over numeric props", () => {
  it("sum / avg / min / max in stats, breakdowns and timeseries; non-numbers are skipped", () => {
    const db = memoryDb();
    const s = settings();
    engine.configure(db, s);
    const t = NOW - HOUR;
    engine.ingest(
      db,
      [
        ev({ ts: t, name: "quote", props: JSON.stringify({ amount: "10" }), country: "DE" }),
        ev({ ts: t, name: "quote", props: JSON.stringify({ amount: "30.5" }), country: "DE" }),
        ev({ ts: t, name: "quote", props: JSON.stringify({ amount: "-2" }), country: "FR" }),
        ev({ ts: t, name: "quote", props: JSON.stringify({ amount: "n/a" }), country: "FR" }),
        ev({ ts: t, name: "quote", props: JSON.stringify({ other: "1" }), country: "FR" }),
      ],
      NOW,
    );
    const metrics = parseMetrics("events,sum:prop:amount,avg:prop:amount,min:prop:amount,max:prop:amount", []);
    const st = engine.stats(db, s, { period: "today", metrics, filters: [] } as any, NOW) as any;
    expect(st.metrics).toEqual({
      events: 5,
      "sum:prop:amount": 38.5,
      "avg:prop:amount": 12.833,
      "min:prop:amount": -2,
      "max:prop:amount": 30.5,
    });
    const b = engine.breakdown(db, s, { period: "today", metrics, filters: [], breakdown: "country" } as any, NOW) as any;
    expect(b.results.find((r: any) => r.value === "FR")).toMatchObject({ "sum:prop:amount": -2, "avg:prop:amount": -2 });
    const ts = engine.timeseries(
      db,
      s,
      { period: "today", interval: "hour", metrics: ["sum:prop:amount"], filters: [] } as any,
      NOW,
    ) as any;
    expect(ts.results.reduce((a: number, r: any) => a + (r["sum:prop:amount"] ?? 0), 0)).toBe(38.5);
    expect(() => parseMetrics("sum:prop:a,sum:prop:b,sum:prop:c,sum:prop:d,sum:prop:e,sum:prop:f", [])).toThrow(/At most 5/);
    expect(() => parseMetrics("median:prop:a", [])).toThrow(/Unknown metric/);
  });
});

describe("browser user properties (security review finding 5)", () => {
  it("are dropped unless the site opts in, with a warning; identify still works", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    engine.ingest(db, [ev({ ts: NOW - MIN, origin: "browser", user_id: "u1", user_props: { plan: "free" } })], NOW);
    expect(userPropsOf(db, "u1")).toEqual({});
    expect(db.all("SELECT user_id FROM events")[0]).toMatchObject({ user_id: "u1" });
    expect(db.all("SELECT reason FROM drops WHERE reason LIKE '%browser_user_props_ignored'")).toHaveLength(1);
  });

  it("browser-created keys have their own budget and never use up the server keys", () => {
    const db = memoryDb();
    engine.configure(db, settings({ browser_user_props: true }));
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "x"]));
    engine.ingest(db, [ev({ ts: NOW - 2 * MIN, origin: "browser", user_id: "attacker", user_props: many })], NOW, {
      userPropKeys: 5,
      browserUserPropKeys: 3,
    });
    expect(Object.keys(userPropsOf(db, "attacker"))).toHaveLength(3);
    const server = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, "y"]));
    engine.ingest(db, [ev({ ts: NOW - MIN, origin: "server", name: "login", user_id: "u9", user_props: server })], NOW, {
      userPropKeys: 5,
      browserUserPropKeys: 3,
    });
    expect(Object.keys(userPropsOf(db, "u9")).sort()).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    // A server can still use a key browsers created first (it becomes a server key).
    engine.ingest(db, [ev({ ts: NOW, origin: "server", name: "x", user_id: "u10", user_props: { k0: "z" } })], NOW, {
      userPropKeys: 6,
      browserUserPropKeys: 3,
    });
    expect(userPropsOf(db, "u10")).toEqual({ k0: "z" });
  });
});

describe("user properties and retention (security review finding 8)", () => {
  it("are purged once last set before the retention window", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    engine.ingest(db, [ev({ ts: NOW - 20 * 86_400_000, origin: "server", name: "x", user_id: "old", user_props: { plan: "pro" } })], NOW);
    engine.ingest(db, [ev({ ts: NOW - MIN, origin: "server", name: "x", user_id: "new", user_props: { plan: "team" } })], NOW);
    engine.purge(db, 10, NOW);
    expect(userPropsOf(db, "old")).toEqual({});
    expect(userPropsOf(db, "new")).toEqual({ plan: "team" });
  });
});
