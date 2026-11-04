import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { exportEvents } from "../../src/do/export";
import { HOUR, MIN, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("raw export", () => {
  it("pages by cursor within the range, excludes debug by default, and holds a daily budget", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 3 * HOUR, visitor_hash: "a", props: JSON.stringify({ plan: "pro" }) }),
        ev({ ts: NOW - 2 * HOUR, visitor_hash: "b" }),
        ev({ ts: NOW - HOUR, visitor_hash: "c", debug: true }),
        ev({ ts: NOW - 30 * MIN, visitor_hash: "d" }),
        ev({ ts: NOW - 10 * HOUR, visitor_hash: "old" }),
      ],
      NOW,
    );
    const q = { start: NOW - 4 * HOUR, end: NOW, after: 0, limit: 2, debug: "exclude" as const };
    const p1 = exportEvents(db, q, 100, NOW) as any;
    expect(p1.rows.map((r: any) => r.visitor_id)).toEqual(["a", "b"]);
    expect(p1.rows[0]).toMatchObject({ props: { plan: "pro" }, name: "pageview", time: new Date(NOW - 3 * HOUR).toISOString() });
    expect(p1.columns).toContain("debug");
    const p2 = exportEvents(db, { ...q, after: Number.parseInt(p1.next_cursor.slice(1), 36) }, 100, NOW) as any;
    expect(p2.rows.map((r: any) => r.visitor_id)).toEqual(["d"]);
    expect(p2.next_cursor).toBeNull();
    expect(p2.used_today).toBe(3);
    expect((exportEvents(db, { ...q, debug: "only", limit: 10 }, 100, NOW) as any).rows.map((r: any) => r.visitor_id)).toEqual(["c"]);
    expect((exportEvents(db, q, 4, NOW) as any).error.code).toBe("daily_limit");
  });
});
