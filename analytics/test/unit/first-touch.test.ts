import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { deleteIdentity } from "../../src/do/privacy";
import { retention } from "../../src/do/retention";
import { parseFilters } from "../../src/lib/filters";
import { DAY, MIN, NOW, ev, google, q, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const fb = { source: "Facebook", channel: "Organic Social" as const, referrer_host: "l.facebook.com", referrer: "facebook.com" };

describe("first touch", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ visitor_id_mode: "persistent" }));
  });
  const ids = () => db.all("SELECT ident, canonical, channel, entry_page FROM identities ORDER BY ident");

  it("keeps each identity's first session; a later sign-up merges the visitor into its user", () => {
    engine.ingest(db, [ev({ ts: NOW - 3 * DAY, visitor_hash: "va", pathname: "/blog", ...google })], NOW);
    engine.ingest(db, [ev({ ts: NOW - DAY, visitor_hash: "va", ...fb })], NOW); // a later session: first touch stays Google
    engine.ingest(db, [ev({ ts: NOW - DAY + MIN, visitor_hash: "va", origin: "server", name: "signup", user_id: "u1" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 10 * MIN, visitor_hash: "vb", user_id: "u1", ...fb })], NOW); // the same user on another device
    expect(ids()).toEqual([
      { ident: "user:u1", canonical: null, channel: "Organic Search", entry_page: "/blog" },
      { ident: "va", canonical: "user:u1", channel: "Organic Search", entry_page: "/blog" },
      { ident: "vb", canonical: "user:u1", channel: "Organic Search", entry_page: "/blog" },
    ]);
    const rows = engine.breakdown(
      db,
      settings(),
      { ...q({ period: "7d", metrics: ["visitors", "events"] }), breakdown: "first_channel" } as any,
      NOW,
    ) as any;
    expect(rows.results).toEqual([{ value: "Organic Search", visitors: 2, events: 4 }]);
    expect(rows.notes.join(" ")).toContain("first_* dimensions");
    const f = engine.stats(
      db,
      settings(),
      q({ period: "7d", metrics: ["visitors"], filters: parseFilters("first_entry_page==/blog") }),
      NOW,
    ) as any;
    expect(f.metrics.visitors).toBe(2);
  });

  it("a backdated server event replaces the first touch; a Direct session that adopts a source updates it", () => {
    engine.ingest(db, [ev({ ts: NOW - DAY, visitor_hash: "v", ...fb })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 5 * DAY, visitor_hash: "v", origin: "server", name: "x", ...google })], NOW);
    expect(ids()).toEqual([{ ident: "v", canonical: null, channel: "Organic Search", entry_page: null }]);
    engine.ingest(db, [ev({ ts: NOW - 30 * MIN, visitor_hash: "w", origin: "server", name: "x" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 29 * MIN, visitor_hash: "w", pathname: "/landing", ...fb })], NOW);
    expect(db.all("SELECT channel, entry_page FROM identities WHERE ident = 'w'")).toEqual([
      { channel: "Organic Social", entry_page: "/landing" },
    ]);
  });

  it("the migration backfills identities from stored sessions; erasure and retention remove them", () => {
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 2 * DAY, visitor_hash: "old", ...google }),
        ev({ ts: NOW - 2 * DAY + MIN, visitor_hash: "old", origin: "server", name: "s", user_id: "uo" }),
      ],
      NOW,
    );
    db.run("DELETE FROM identities");
    db.run("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
    db.run("DROP TABLE identities");
    engine.migrate(db);
    expect(ids()).toEqual([
      { ident: "old", canonical: "user:uo", channel: "Organic Search", entry_page: "/" },
      { ident: "user:uo", canonical: null, channel: "Organic Search", entry_page: "/" },
    ]);
    deleteIdentity(db, "user:uo");
    expect(ids()).toEqual([]);
    engine.ingest(db, [ev({ ts: NOW - 100 * DAY, visitor_hash: "ancient" })], NOW - 100 * DAY);
    engine.purge(db, 30, NOW);
    expect(ids()).toEqual([]);
  });
});

describe("retention cohorts", () => {
  it("weekly cohorts by first-seen week with returns per later week, split by first channel (persistent mode)", () => {
    const db = memoryDb();
    const s = settings({ visitor_id_mode: "persistent" });
    engine.configure(db, s);
    // NOW is Tue 3 Nov 2026; weeks start Monday: 19 Oct, 26 Oct, 2 Nov
    const at = (d: string, h = 12) => Date.parse(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
    for (const [v, first, ...back] of [
      ["a", "2026-10-19", "2026-10-27", "2026-11-02"],
      ["b", "2026-10-20", "2026-11-03"],
      ["c", "2026-10-21"],
      ["d", "2026-10-27", "2026-11-02"],
    ] as const) {
      engine.ingest(db, [ev({ ts: at(first), visitor_hash: v, ...(v === "c" ? fb : google) })], NOW);
      for (const b of back) engine.ingest(db, [ev({ ts: at(b), visitor_hash: v })], NOW);
    }
    const r = retention(db, s, { interval: "week", periods: 3, filters: [] }, NOW) as any;
    expect(r.population).toBe("all_visitors");
    expect(r.cohorts.map((c: any) => [c.cohort, c.size, c.retained, c.rates])).toEqual([
      ["2026-10-19", 3, [3, 1, 2], [100, 33.3, 66.7]],
      ["2026-10-26", 1, [1, 1], [100, 100]],
    ]);
    const split = retention(db, s, { interval: "week", periods: 3, filters: [], breakdown: "first_channel" }, NOW) as any;
    expect(split.cohorts.map((c: any) => [c.cohort, c.first_channel, c.size])).toEqual([
      ["2026-10-19", "Organic Search", 2],
      ["2026-10-19", "Organic Social", 1],
      ["2026-10-26", "Organic Search", 1],
    ]);
    const only = retention(db, s, { interval: "week", periods: 3, filters: parseFilters("first_channel==Organic Social") }, NOW) as any;
    expect(only.cohorts.map((c: any) => c.size)).toEqual([1]);
    expect((retention(db, s, { interval: "week", periods: 3, filters: parseFilters("country==US") }, NOW) as any).error.code).toBe(
      "bad_request",
    );
  });

  it("cookieless: only identified users count, and the answer says why", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 8 * DAY, visitor_hash: "anon" }),
        ev({ ts: NOW - 8 * DAY, visitor_hash: "x", origin: "server", name: "s", user_id: "u" }),
      ],
      NOW,
    );
    engine.ingest(db, [ev({ ts: NOW - DAY, visitor_hash: "y", origin: "server", name: "s", user_id: "u" })], NOW);
    const r = retention(db, settings(), { interval: "week", periods: 3, filters: [] }, NOW) as any;
    expect(r.population).toBe("identified_users");
    expect(r.cohorts).toEqual([expect.objectContaining({ size: 1, retained: [1, 1] })]);
    expect(r.identity.note).toContain("identified users only");
  });
});
