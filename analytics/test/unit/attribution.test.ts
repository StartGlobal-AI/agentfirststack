import { beforeEach, describe, expect, it } from "vitest";
import { attribution, credits } from "../../src/do/attribution";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { DAY, MIN, NOW, ev, google, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const fb = { source: "Facebook", channel: "Organic Social" as const, referrer_host: "l.facebook.com", referrer: "facebook.com" };
const tp = (ts: number, channel: string) => ({ ts, value: channel, channel });

describe("attribution models", () => {
  const path = [tp(NOW - 10 * DAY, "Organic Search"), tp(NOW - 5 * DAY, "Organic Social"), tp(NOW - DAY, "Email"), tp(NOW - MIN, "Direct")];
  it("each model's credits sum to 1", () => {
    expect(credits("last_touch", path, NOW)).toEqual([0, 0, 0, 1]);
    expect(credits("first_touch", path, NOW)).toEqual([1, 0, 0, 0]);
    expect(credits("last_non_direct", path, NOW)).toEqual([0, 0, 1, 0]);
    expect(credits("last_non_direct", [tp(NOW, "Direct")], NOW)).toEqual([1]);
    expect(credits("linear", path, NOW)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(credits("position_based", path, NOW)).toEqual([0.4, 0.1, 0.1, 0.4]);
    expect(credits("position_based", path.slice(0, 2), NOW)).toEqual([0.5, 0.5]);
    const td = credits("time_decay", path, NOW);
    expect(td.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(td[3]! / td[2]!).toBeCloseTo(2 ** (1 / 7), 2); // a day apart, 7-day half-life
    expect(td[0]).toBeLessThan(td[1]!);
  });
});

describe("attribution over a person's sessions", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings());
    // u1: Google 10 days ago (anonymous visitor v1, then identified), Facebook 3 days ago (another
    // device), Direct today, then buys 100. Each device is identified by the site's server (a
    // browser afsa('identify') alone doesn't merge identities: see the test at the end).
    const login = (visitor: string, ts: number) =>
      ev({
        ts,
        visitor_hash: visitor,
        origin: "server",
        name: "login",
        user_id: "u1",
        channel: "Direct",
        source: null,
        referrer_host: null,
        referrer: null,
      });
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 10 * DAY, visitor_hash: "v1", ...google }),
        ev({ ts: NOW - 10 * DAY + MIN, visitor_hash: "v1", origin: "server", name: "signup", user_id: "u1" }),
      ],
      NOW,
    );
    engine.ingest(db, [ev({ ts: NOW - 3 * DAY, visitor_hash: "v2", user_id: "u1", ...fb }), login("v2", NOW - 3 * DAY + MIN)], NOW);
    engine.ingest(db, [ev({ ts: NOW - 30 * MIN, visitor_hash: "v3", user_id: "u1" }), login("v3", NOW - 29 * MIN)], NOW);
    payments.ingestPayments(db, [pay({ user_id: "u1", amount: 100, ts: NOW - 20 * MIN })], NOW);
    // an anonymous buyer from Google today
    engine.ingest(db, [ev({ ts: NOW - 40 * MIN, visitor_hash: "anon", ...google })], NOW);
    payments.ingestPayments(db, [pay({ external_id: "p2", visitor_id: "anon", amount: 50, ts: NOW - 39 * MIN })], NOW);
  });
  const run = (o: Record<string, unknown> = {}) =>
    attribution(
      db,
      settings(),
      {
        period: "7d",
        filters: [],
        model: "last_non_direct",
        lookback_days: 30,
        breakdown: "channel",
        paths: false,
        limit: 50,
        ...o,
      } as any,
      NOW,
    ) as any;

  it("last_non_direct credits Facebook for the user's purchase and Google for the anonymous one", () => {
    const r = run();
    expect(r).toMatchObject({ conversions: 2, revenue: 150, sampled: false });
    expect(r.results).toEqual([
      { value: "Organic Social", conversions: 1, revenue: 100, share: 50 },
      { value: "Organic Search", conversions: 1, revenue: 50, share: 50 },
    ]);
    expect(r.identity.note).toContain("same UTC day");
  });

  it("first_touch reaches the user's first anonymous session; linear splits; lookback cuts", () => {
    expect(run({ model: "first_touch" }).results).toEqual([{ value: "Organic Search", conversions: 2, revenue: 150, share: 100 }]);
    const lin = run({ model: "linear" }).results;
    expect(lin.find((x: any) => x.value === "Direct")).toMatchObject({ conversions: 0.33, revenue: 33.33 });
    expect(run({ model: "first_touch", lookback_days: 5 }).results.find((x: any) => x.value === "Organic Social")).toMatchObject({
      conversions: 1,
    });
  });

  it("conversion paths: sequences with medians; a goal as the target", () => {
    const r = run({ paths: true });
    expect(r.paths).toEqual([
      {
        path: ["Organic Search", "Organic Social", "Direct"],
        conversions: 1,
        revenue: 100,
        median_days_to_convert: 10,
        median_touchpoints: 3,
      },
      { path: ["Organic Search"], conversions: 1, revenue: 50, median_days_to_convert: 0, median_touchpoints: 1 },
    ]);
    expect(run({ goal: "Nope" }).error.code).toBe("unknown_goal");
    engine.configure(db, settings({ goals: [{ id: "g", name: "Signup", type: "event", match: "signup", value: 10, created_at: NOW }] }));
    const g = attribution(
      db,
      settings(),
      {
        period: "30d",
        filters: [],
        goal: "Signup",
        model: "last_touch",
        lookback_days: 30,
        breakdown: "source",
        paths: false,
        limit: 50,
      } as any,
      NOW,
    ) as any;
    // The goal's value is credited as goal_value, never as revenue.
    expect(g.results).toEqual([{ value: "Google", conversions: 1, revenue: 0, goal_value: 10, share: 100 }]);
    expect(g).toMatchObject({ revenue: 0, goal_value: 10 });
  });

  it("a browser-sent user id can't move a purchase's credit or first touch (unless the site trusts browser ids)", () => {
    // Before u2 ever signs up, someone visits from their own campaign and calls afsa('identify', 'u2').
    const evil = {
      source: "evil",
      channel: "Paid Search" as const,
      utm_source: "evil",
      utm_campaign: "steal",
      referrer_host: null,
      referrer: null,
    };
    engine.ingest(db, [ev({ ts: NOW - 6 * DAY, visitor_hash: "attacker", user_id: "u2", ...evil })], NOW);
    // u2's real visit from Google, identified by the site's server, then a purchase.
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 2 * DAY, visitor_hash: "real", ...google }),
        ev({ ts: NOW - 2 * DAY + MIN, visitor_hash: "real", origin: "server", name: "signup", user_id: "u2" }),
      ],
      NOW,
    );
    payments.ingestPayments(db, [pay({ external_id: "p3", user_id: "u2", amount: 70, ts: NOW - 2 * DAY + 2 * MIN })], NOW);
    const credited = (s = settings()) =>
      (
        attribution(
          db,
          s,
          { period: "7d", filters: [], model: "first_touch", lookback_days: 30, breakdown: "channel", paths: false, limit: 50 } as any,
          NOW,
        ) as any
      ).results;
    // The attacker's session is not one of u2's touchpoints: Google gets the 70.
    expect(credited().find((x: any) => x.value === "Paid Search")).toBeUndefined();
    expect(credited().find((x: any) => x.value === "Organic Search")).toMatchObject({ revenue: 220 });
    // u2's first touch is the real Google visit, and the attacker's visitor is not linked to u2.
    const ident = (id: string) => db.all("SELECT channel, canonical FROM identities WHERE ident = ?", [id])[0];
    expect(ident("user:u2")).toMatchObject({ channel: "Organic Search" });
    expect(ident("attacker")).toMatchObject({ canonical: null, channel: "Paid Search" });
    // The browser id still marks the attacker's own visit (people views): it is just not trusted.
    expect(db.all("SELECT user_id, user_source FROM sessions WHERE visitor_id = 'attacker'")[0]).toMatchObject({
      user_id: "u2",
      user_source: "browser",
    });
    // A site that opts in (trust_browser_user_id) gets the old behaviour for its sessions.
    expect(credited(settings({ trust_browser_user_id: true })).find((x: any) => x.value === "Paid Search")).toMatchObject({
      conversions: 1,
    });
  });
});
