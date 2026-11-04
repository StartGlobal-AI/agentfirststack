import { beforeEach, describe, expect, it } from "vitest";
import { attribution } from "../../src/do/attribution";
import * as engine from "../../src/do/engine";
import { insights } from "../../src/do/insights";
import { deleteIdentity } from "../../src/do/privacy";
import { parseFunnelSteps } from "../../src/lib/query";
import type { EnrichedEvent } from "../../src/lib/types";
import { MIN, NOW, ev, google, q, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

/**
 * Server events sent with visit: false (an agent signing up with curl): they count as events,
 * conversions and revenue, never as visitors, visits, bounces or entry pages.
 */

const GOALS = [{ id: "g", name: "Signup", type: "event" as const, match: "signup", value: null, created_at: NOW }];
/** A backend event with no browser behind it. */
const backend = (over: Partial<EnrichedEvent> = {}) =>
  ev({
    origin: "server",
    name: "signup",
    hostname: null,
    pathname: null,
    url: null,
    browser: null,
    browser_version: null,
    os: null,
    os_version: null,
    device: null,
    visit: false,
    ...over,
  });

describe("server events with visit: false", () => {
  let db: ReturnType<typeof memoryDb>;
  let results: ReturnType<typeof engine.ingest>["results"];
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ goals: GOALS }));
    // one human from Google: two pageviews, then signs up on the backend while the visit is live
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 20 * MIN, visitor_hash: "human", pathname: "/", ...google }),
        ev({ ts: NOW - 19 * MIN, visitor_hash: "human", pathname: "/pricing" }),
      ],
      NOW,
    );
    // three agents sign up with curl: no visit to join
    results = engine.ingest(
      db,
      [
        backend({ ts: NOW - 15 * MIN, visitor_hash: "agent1", user_id: "u_agent1" }),
        backend({ ts: NOW - 14 * MIN, visitor_hash: "agent2", user_id: "u_agent2", revenue: 20, currency: "USD" }),
        backend({ ts: NOW - 13 * MIN, visitor_hash: "agent3" }),
        backend({ ts: NOW - 12 * MIN, visitor_hash: "human", user_id: "u_human" }),
      ],
      NOW,
    ).results;
  });

  const stats = (metrics: string[]) => (engine.stats(db, settings(), q({ metrics }) as any, NOW) as any).metrics;
  const breakdown = (by: string, metrics: string[]) =>
    (engine.breakdown(db, settings(), { ...q({ metrics }), breakdown: by } as any, NOW) as any).results;

  it("create no visitor and no session: the answer has no ids; one that finds a live visit joins it", () => {
    expect(results.slice(0, 3)).toEqual([
      { ok: true, no_visit: true, new_session: false },
      { ok: true, no_visit: true, new_session: false },
      { ok: true, no_visit: true, new_session: false },
    ]);
    const human = db.all("SELECT id FROM sessions WHERE visitor_id = 'human'")[0]!.id;
    expect(results[3]).toMatchObject({ ok: true, visitor_id: "human", session_id: human, new_session: false });
    expect(db.all("SELECT COUNT(*) AS n FROM sessions")[0]!.n).toBe(1);
    expect(db.all("SELECT name, no_visit FROM events WHERE origin = 'server' ORDER BY ts")).toEqual([
      { name: "signup", no_visit: 1 },
      { name: "signup", no_visit: 1 },
      { name: "signup", no_visit: 1 },
      { name: "signup", no_visit: 0 },
    ]);
    // no first touch for an identity with no session
    expect(db.all("SELECT ident FROM identities ORDER BY ident").map((r) => r.ident)).toEqual(["human", "user:u_human"]);
  });

  it("count as events, conversions and revenue, never in visitors, visits, bounce rate or entry pages", () => {
    expect(
      stats([
        "visitors",
        "visits",
        "events",
        "pageviews",
        "conversions",
        "conversion_rate",
        "revenue",
        "bounce_rate",
        "visit_conversion_rate",
      ]),
    ).toMatchObject({
      visitors: 1,
      visits: 1,
      events: 6,
      pageviews: 2,
      conversions: 4,
      // converted visitors / visitors: only the human is a visitor
      conversion_rate: 100,
      visit_conversion_rate: 100,
      revenue: 20,
      bounce_rate: 0,
    });
    expect(breakdown("entry_page", ["visitors", "visits"])).toEqual([{ value: "/", visitors: 1, visits: 1 }]);
    // by channel: the agents' signups are Direct conversions with no visitors
    expect(breakdown("channel", ["visitors", "events", "conversions"])).toEqual([
      { value: "Organic Search", visitors: 1, events: 3, conversions: 1 },
      { value: "Direct", visitors: 0, events: 3, conversions: 3 },
    ]);
    const goal = breakdown("goal", ["visitors"]);
    expect(goal).toEqual([expect.objectContaining({ value: "Signup", visitors: 1, conversions: 4, conversion_rate: 100 })]);
    const series = (
      engine.timeseries(db, settings(), { ...q({ metrics: ["visitors", "conversions"] }), interval: "day" } as any, NOW) as any
    ).results;
    expect(series.at(-1)).toMatchObject({ visitors: 1, conversions: 4 });
    const rt = engine.realtime(db, { filters: [] }, NOW) as any;
    expect(rt).toMatchObject({ visitors_last_30m: 1, events_last_30m: 6 });
    const ins = insights(db, settings(), { period: "24h", filters: [], goal: "Signup" } as any, NOW) as any;
    expect(ins.kpis).toMatchObject({ visitors: 1, converters: 1 });
  });

  it("stay out of visit funnels; person funnels follow their user", () => {
    const f = (steps: string, window?: string) =>
      (engine.funnel(db, settings(), { period: "24h", filters: [], steps: parseFunnelSteps(steps), window } as any, NOW) as any).steps.map(
        (s: { visitors: number }) => s.visitors,
      );
    expect(f("event:signup,/pricing")).toEqual([1, 0]);
    expect(f("/pricing,event:signup")).toEqual([1, 1]);
    // a person funnel counts every person who signed up: the human and the three agents
    expect(f("event:signup,/pricing", "1d")[0]).toBe(4);
  });

  it("attribution: a conversion with no visit is credited to the person's sessions, else to (no session)", () => {
    const a = attribution(
      db,
      settings(),
      {
        period: "24h",
        filters: [],
        goal: "Signup",
        model: "last_touch",
        lookback_days: 30,
        breakdown: "channel",
        paths: false,
        limit: 10,
      } as any,
      NOW,
    ) as any;
    expect(a.conversions).toBe(4);
    expect(a.results).toEqual([
      { value: "(no session)", conversions: 3, revenue: 20, share: 75 },
      { value: "Organic Search", conversions: 1, revenue: 0, share: 25 },
    ]);
  });

  it("an expired visit is not reopened, and the visitor's later browser visit is a normal one", () => {
    // the human's visit ended at NOW - 12 min; 50 minutes later it is over
    const later = engine.ingest(db, [backend({ ts: NOW + 38 * MIN, visitor_hash: "human" })], NOW + 40 * MIN).results[0];
    expect(later).toMatchObject({ ok: true, no_visit: true });
    expect(db.all("SELECT COUNT(*) AS n FROM sessions")[0]!.n).toBe(1);
    const back = engine.ingest(db, [ev({ ts: NOW + 39 * MIN, visitor_hash: "human" })], NOW + 40 * MIN).results[0];
    expect(back).toMatchObject({ ok: true, new_session: true, visitor_id: "human" });
  });

  it("erasure of a user deletes their no-visit events too", () => {
    expect(deleteIdentity(db, "user:u_agent1")).toMatchObject({ events_deleted: 1, sessions_deleted: 0 });
    expect(db.all("SELECT COUNT(*) AS n FROM events WHERE user_id = 'u_agent1'")[0]!.n).toBe(0);
    expect(deleteIdentity(db, "agent3")).toMatchObject({ events_deleted: 1 });
    expect(deleteIdentity(db, "user:u_agent1")).toBeNull();
  });

  it("validate_only shows the row it would store, no_visit included", () => {
    const dry = engine.ingest(db, [backend({ visitor_hash: "agent9" })], NOW, { dryRun: true }).results[0]!;
    expect(dry).toMatchObject({ ok: true, no_visit: true, stored: { name: "signup", no_visit: true, origin: "server" } });
    expect(db.all("SELECT COUNT(*) AS n FROM events WHERE visitor_id = 'agent9'")[0]!.n).toBe(0);
  });
});
