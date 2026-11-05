import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { siteUsage } from "../../src/do/usage";
import { userPropKeyCounts } from "../../src/do/user-props";
import { HOUR, MIN, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("site usage counters (GET /v1/usage)", () => {
  it("user property keys: server and browser-only keys counted apart, as setUserProps budgets them", () => {
    const db = memoryDb();
    engine.configure(db, settings({ browser_user_props: true }));
    expect(userPropKeyCounts(db)).toEqual({ server: 0, browser: 0 });
    const t = NOW - HOUR;
    engine.ingest(
      db,
      [
        ev({ ts: t, origin: "server", user_id: "u1", name: "login", user_props: { plan: "pro", seats: "5" } }),
        ev({ ts: t + MIN, origin: "browser", user_id: "u2", user_props: { theme: "dark", plan: "free" } }),
        ev({ ts: t + 2 * MIN, origin: "browser", user_id: "u3", user_props: { theme: "light", lang: "de" } }),
        ev({ ts: t + 3 * MIN, origin: "server", user_id: "u3", name: "x", user_props: { lang: "en" } }),
      ],
      NOW,
    );
    // plan, seats, lang were set by a server (lang after a browser created it); theme only by browsers
    expect(userPropKeyCounts(db)).toEqual({ server: 3, browser: 1 });
    const keys = db.all("SELECT key, MAX(source = 'server') AS srv FROM user_props GROUP BY key");
    expect(keys.filter((k) => Number(k.srv) === 1)).toHaveLength(3);
  });

  it("today's events, annotations and imports; zero on an empty site", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    expect(siteUsage(db, NOW)).toMatchObject({ events_today: 0, annotations: 0, imports: 0, imported_rows: 0, cost_rows: 0 });
    engine.ingest(db, [ev({ ts: NOW - MIN }), ev({ ts: NOW - 2 * MIN, name: "signup" })], NOW);
    const u = siteUsage(db, NOW);
    expect(u.day).toBe("2026-11-03");
    expect(u.events_today).toBe(engine.usageOn(db, "2026-11-03").events);
    expect(u.events_today).toBeGreaterThanOrEqual(2);
  });
});
