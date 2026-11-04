import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { paths } from "../../src/do/paths";
import { parseFilters } from "../../src/lib/filters";
import { parseFunnelStep, parseFunnelSteps } from "../../src/lib/query";
import { DAY, MIN, NOW, ev, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const funnel = (db: ReturnType<typeof memoryDb>, s: string, over: Record<string, unknown> = {}) =>
  engine.funnel(
    db,
    settings({ visitor_id_mode: "persistent" }),
    { period: "7d", filters: [], steps: parseFunnelSteps(s), ...over } as any,
    NOW,
  ) as any;

describe("funnel v2", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ visitor_id_mode: "persistent" }));
    // a: /pricing then /signup in one session, and pays; b: /signup then /pricing (wrong order)
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 60 * MIN, visitor_hash: "a", pathname: "/pricing" }),
        ev({ ts: NOW - 59 * MIN, visitor_hash: "a", pathname: "/signup" }),
      ],
      NOW,
    );
    payments.ingestPayments(db, [pay({ visitor_id: "a", ts: NOW - 58 * MIN, amount: 40 })], NOW);
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 60 * MIN, visitor_hash: "b", pathname: "/signup" }),
        ev({ ts: NOW - 59 * MIN, visitor_hash: "b", pathname: "/pricing" }),
      ],
      NOW,
    );
    // c: /pricing today, /signup two days later (another session)
    engine.ingest(db, [ev({ ts: NOW - 3 * DAY, visitor_hash: "c", pathname: "/pricing" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - DAY, visitor_hash: "c", pathname: "/signup" })], NOW);
  });

  it("ordered within a session, with revenue per step", () => {
    const f = funnel(db, "/pricing,/signup");
    expect(f.steps.map((s: any) => [s.visitors, s.sessions, s.revenue, s.revenue_per_visitor])).toEqual([
      [3, 3, 40, 13.33],
      [1, 1, 40, 40],
    ]);
    expect(f).toMatchObject({ mode: "ordered", window: "session" });
  });

  it("any order, and a window across sessions for the same person", () => {
    expect(funnel(db, "/pricing,/signup", { mode: "any" }).steps.map((s: any) => s.visitors)).toEqual([3, 2]);
    expect(funnel(db, "/pricing,/signup", { window: "7d" }).steps.map((s: any) => s.visitors)).toEqual([3, 2]);
    expect(funnel(db, "/pricing,/signup", { window: "1d" }).steps.map((s: any) => s.visitors)).toEqual([3, 1]);
    expect(funnel(db, "/pricing,/signup", { window: "7d", mode: "any" }).steps.map((s: any) => s.visitors)).toEqual([3, 3]);
  });

  it("comparison per step and side-by-side segments", () => {
    const f = funnel(db, "/pricing,/signup", { compare: { mode: "previous" } });
    expect(f.steps[0].comparison).toMatchObject({ visitors: 0, change_percent: { visitors: null } });
    const s = funnel(db, "/pricing,/signup", {
      segments: [
        {
          id: "seg_a",
          name: "A only",
          filters: parseFilters("page==/pricing|/signup"),
          where: { or: [{ key: "page", op: "==", values: ["/signup"] }] },
        },
      ],
    });
    expect(s.segments[0]).toMatchObject({ segment: { id: "seg_a", name: "A only" } });
    expect(s.segments[0].steps[0].visitors).toBe(0); // only /signup events pass the segment
  });
});

describe("paths", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings());
    const visit = (v: string, pages: string[]) =>
      engine.ingest(
        db,
        pages.map((p, i) =>
          p.startsWith("event:")
            ? ev({ ts: NOW - 30 * MIN + i * 1000, visitor_hash: v, name: p.slice(6) })
            : ev({ ts: NOW - 30 * MIN + i * 1000, visitor_hash: v, pathname: p }),
        ),
        NOW,
      );
    visit("a", ["/", "/pricing", "/pricing", "/signup", "event:signup", "/welcome"]);
    visit("b", ["/blog", "/pricing", "/docs"]);
    visit("c", ["/pricing", "/signup", "/welcome"]);
    visit("d", ["/docs"]);
  });
  const run = (o: Record<string, unknown>) =>
    paths(
      db,
      settings(),
      {
        period: "24h",
        filters: [],
        direction: "forward",
        steps: 2,
        node: "page",
        limit: 10,
        anchor: parseFunnelStep("/pricing"),
        ...o,
      } as any,
      NOW,
    ) as any;

  it("forward from a page: next steps with shares and exits, repeats collapsed, top paths", () => {
    const r = run({});
    expect(r.anchored).toEqual({ sessions: 3, visitors: 3 });
    expect(r.columns[0]).toEqual({
      step: 1,
      sessions: 3,
      exits: 0,
      rows: [
        { value: "/signup", sessions: 2, share: 66.7 },
        { value: "/docs", sessions: 1, share: 33.3 },
      ],
    });
    expect(r.columns[1]).toMatchObject({ step: 2, sessions: 2, exits: 1, rows: [{ value: "/welcome", sessions: 2 }] });
    expect(r.top_paths[0]).toEqual({ steps: ["/signup", "/welcome"], sessions: 2, share: 66.7 });
  });

  it("backward from an event, and node=any shows custom events", () => {
    const back = run({ anchor: parseFunnelStep("event:signup"), direction: "backward" });
    expect(back.anchored.sessions).toBe(1);
    expect(back.columns[0].rows).toEqual([{ value: "/signup", sessions: 1, share: 100 }]);
    expect(back.top_paths[0].steps).toEqual(["/pricing", "/signup"]);
    const any = run({ node: "any", steps: 3 });
    expect(any.top_paths.find((p: any) => p.steps.includes("event:signup")).steps).toEqual(["/signup", "event:signup", "/welcome"]);
  });

  it("an unknown goal anchor is an error with a hint", () => {
    expect(run({ anchor: parseFunnelStep("goal:Nope") }).error.code).toBe("unknown_goal");
  });
});
