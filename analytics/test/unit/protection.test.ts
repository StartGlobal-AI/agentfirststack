import { ATTACK_COOLDOWN_MS, type ProtectionMode, SPIKE_WINDOW_MS } from "@afs/shared";
import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import { ENDED_SHOWN_MS, Guard } from "../../src/do/protection";
import { purgeQuarantine, quarantineSummary, releaseQuarantine } from "../../src/do/quarantine";
import type { EnrichedEvent, IngestResponse } from "../../src/lib/types";
import { DAY, HOUR, MIN, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

/** A network operator that carries people's own browsing (not a data centre). */
const RESIDENTIAL = 7922;
/** Amazon AWS: a data centre. */
const AWS = 16509;

const pv = (net: string, over: Partial<EnrichedEvent> = {}) =>
  ev({ net_hash: net, visitor_hash: `v_${net}`, ts: NOW - MIN, asn: RESIDENTIAL, ...over });

describe("attack protection in the engine", () => {
  let db: ReturnType<typeof memoryDb>;
  let guard: Guard;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ created_at: NOW - 30 * DAY }));
    guard = new Guard(db);
  });

  /** One ingest the way SiteDO runs it. */
  function ingest(
    events: EnrichedEvent[],
    o: { now?: number; mode?: ProtectionMode; share?: number; qCap?: number; siteDaily?: number; spikeMin?: number } = {},
  ): IngestResponse {
    const now = o.now ?? NOW;
    const mode = o.mode ?? "auto";
    const res = engine.ingest(db, events, now, {
      caps: {
        siteDaily: o.siteDaily ?? Number.POSITIVE_INFINITY,
        accountDaily: Number.POSITIVE_INFINITY,
        platformDaily: Number.POSITIVE_INFINITY,
      },
      quarantine: (e) => guard.classify(e, { mode, share: o.share ?? Number.POSITIVE_INFINITY, now }),
      quarantineDaily: o.qCap,
    });
    guard.afterIngest(events, res.results, { mode, spikeMin: o.spikeMin ?? 1000, createdAt: NOW - 30 * DAY, now });
    return res;
  }
  const one = (e: EnrichedEvent, o: Parameters<typeof ingest>[1] = {}) => ingest([e], o).results[0]!;
  const pageviews = (debug?: "quarantined" | "include") =>
    (engine.stats(db, settings(), { metrics: ["pageviews"], filters: [], period: "today", debug }, NOW) as any).metrics.pageviews as number;

  it("past a network's share its events are quarantined, out of reports and the budget; other networks are untouched", () => {
    const share = 3;
    const out = Array.from({ length: 6 }, (_, i) => one(pv("n1", { pathname: `/p${i}` }), { share, siteDaily: 6 }));
    expect(out.map((r) => r.quarantined ?? null)).toEqual([null, null, null, "network_share", "network_share", "network_share"]);
    expect(out.every((r) => r.ok && r.visitor_id && r.session_id)).toBe(true);
    // The budget (6) still has room for another network's 3 events: the quarantined ones didn't use it.
    for (let i = 0; i < 3; i++) expect(one(pv("n2"), { share, siteDaily: 6 })).toMatchObject({ ok: true });
    expect(one(pv("n3"), { share, siteDaily: 6 })).toMatchObject({ ok: false, reason: "daily_limit" });
    expect(engine.usageOn(db, "2026-11-03")).toMatchObject({ events: 6, quarantined: 3 });
    expect(pageviews()).toBe(6);
    expect(pageviews("include")).toBe(6);
    expect(pageviews("quarantined")).toBe(3);
    const rows = db.all("SELECT debug, quarantine FROM events WHERE debug = 2");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.quarantine === "network_share")).toBe(true);
    // One upsert per browser event: one row per network today.
    // (n3 was refused by the daily cap before it was counted.)
    expect(db.all("SELECT net, events FROM net_daily ORDER BY net").map((r) => [r.net, r.events])).toEqual([
      ["n1", 6],
      ["n2", 3],
    ]);
    const v = guard.view("auto", NOW);
    expect(v).toMatchObject({
      state: "contained",
      since: NOW,
      quarantined: 3,
      quarantined_today: 3,
      busiest_network_today: 6,
      networks_over_share_today: 1,
    });
    expect(v.reasons).toEqual([{ kind: "network_share", detail: expect.stringContaining("1 network passed 3") }]);
  });

  it("server events are never quarantined", () => {
    for (let i = 0; i < 5; i++) expect(one(pv("n1", { origin: "server" }), { share: 1 }).quarantined).toBeUndefined();
    expect(engine.usageOn(db, "2026-11-03").quarantined).toBe(0);
    expect(guard.view("auto", NOW).state).toBe("none");
  });

  it("the quarantine has its own daily cap: past it, events are dropped as quarantine_full", () => {
    const res = ingest(
      Array.from({ length: 5 }, () => pv("n1")),
      { share: 1, qCap: 2 },
    ).results;
    expect(res.map((r) => r.quarantined ?? r.reason ?? "ok")).toEqual([
      "ok",
      "network_share",
      "network_share",
      "quarantine_full",
      "quarantine_full",
    ]);
    expect(db.all("SELECT count FROM drops WHERE reason = 'quarantine_full'")[0]?.count).toBe(2);
    expect(engine.usageOn(db, "2026-11-03")).toMatchObject({ events: 1, quarantined: 2 });
  });

  it("an engagement beacon from a quarantined network still finds its pageview but costs no budget", () => {
    one(pv("n1"), { share: 1 });
    expect(one(pv("n1", { pathname: "/q" }), { share: 1 }).quarantined).toBe("network_share");
    const e = one(pv("n1", { name: "engagement", pathname: "/q", engagement_ms: 5000, ts: NOW - MIN + 1000 }), { share: 1 });
    expect(e).toMatchObject({ ok: true, engagement: true, quarantined: "network_share", uncounted: true });
    expect(engine.usageOn(db, "2026-11-03")).toMatchObject({ events: 1, quarantined: 1 });
    expect(db.all("SELECT engagement_ms FROM events WHERE pathname = '/q'")[0]?.engagement_ms).toBe(5000);
  });

  it("protection off: nothing is quarantined, but a network over its share is still reported", () => {
    for (let i = 0; i < 4; i++) expect(one(pv("n1"), { share: 2, mode: "off" }).quarantined).toBeUndefined();
    expect(engine.usageOn(db, "2026-11-03")).toMatchObject({ events: 4, quarantined: 0 });
    const v = guard.view("off", NOW);
    expect(v).toMatchObject({ mode: "off", state: "contained", quarantined: 0 });
    expect(v.reasons[0]!.detail).toContain("protection is off");
  });

  it("a spike marks the site under attack: data-centre traffic is quarantined, residential traffic isn't, until the cooldown", () => {
    const o = { spikeMin: 5 };
    // No history: the threshold is SPIKE_MIN_EVENTS. Four events are not a spike; a data centre is accepted.
    for (let i = 0; i < 4; i++) one(pv(`r${i}`), o);
    expect(guard.view("auto", NOW).state).toBe("none");
    expect(one(pv("dc0", { asn: AWS }), o).quarantined).toBeUndefined(); // the 5th accepted event: a spike
    const v = guard.view("auto", NOW);
    expect(v).toMatchObject({ state: "under_attack", since: NOW });
    expect(v.reasons[0]).toMatchObject({ kind: "spike", detail: expect.stringContaining("5 browser events in 15 minutes") });
    // Under attack: data-centre traffic is set aside, people's own networks are not (a viral spike stays counted).
    expect(one(pv("dc1", { asn: AWS }), { ...o, now: NOW + MIN }).quarantined).toBe("datacenter");
    expect(one(pv("r9", { asn: RESIDENTIAL }), { ...o, now: NOW + MIN }).quarantined).toBeUndefined();
    expect(one(pv("srv", { asn: AWS, origin: "server" }), { ...o, now: NOW + MIN }).quarantined).toBeUndefined();
    expect(guard.view("auto", NOW + MIN).reasons.map((r) => r.kind)).toEqual(["spike", "datacenter"]);
    expect(guard.view("auto", NOW + MIN).quarantined).toBe(1);
    // The last trigger was the spiking window's last event; an hour after it the episode ends.
    const later = NOW + MIN + ATTACK_COOLDOWN_MS + 1;
    expect(one(pv("dc2", { asn: AWS, ts: later - MIN }), { ...o, now: later }).quarantined).toBeUndefined();
    const ended = guard.view("auto", later);
    expect(ended).toMatchObject({ state: "ended", since: NOW, ended_at: NOW + MIN + ATTACK_COOLDOWN_MS });
    // Reported for 24 hours after it ended, then gone.
    expect(guard.view("auto", ended.ended_at! + ENDED_SHOWN_MS + 1).state).toBe("none");
  });

  it("a network over its share opens a contained episode that a spike turns into an attack", () => {
    const o = { share: 2, spikeMin: 6 };
    for (let i = 0; i < 3; i++) one(pv("n1"), o);
    expect(guard.view("auto", NOW).state).toBe("contained");
    // Contained only: data-centre traffic is still counted.
    expect(one(pv("dc", { asn: AWS }), o).quarantined).toBeUndefined();
    for (let i = 0; i < 3; i++) one(pv(`r${i}`), o);
    const v = guard.view("auto", NOW);
    expect(v.state).toBe("under_attack");
    expect(v.reasons.map((r) => r.kind)).toEqual(["network_share", "spike"]);
    // Network-share events keep the episode alive: still on 59 minutes after the last one.
    one(pv("n1", { ts: NOW + 30 * MIN }), { ...o, now: NOW + 30 * MIN });
    expect(guard.view("auto", NOW + 89 * MIN).state).toBe("under_attack");
    expect(guard.view("auto", NOW + 91 * MIN).state).toBe("ended");
  });

  it("protection strict quarantines data-centre traffic at all times", () => {
    expect(one(pv("dc", { asn: AWS }), { mode: "strict" }).quarantined).toBe("datacenter");
    expect(one(pv("r", { asn: RESIDENTIAL }), { mode: "strict" }).quarantined).toBeUndefined();
    expect(one(pv("dc", { asn: AWS }), { mode: "auto" }).quarantined).toBeUndefined();
  });

  it("the usual rate comes from the previous 7 days the site existed: a busy site needs 10x its usual to spike", () => {
    // 100 events per 15 minutes on each of the last 7 days: a spike is 1000 in a window, not SPIKE_MIN_EVENTS (5).
    for (let d = 1; d <= 7; d++) engine.addUsage(db, new Date(NOW - d * DAY).toISOString().slice(0, 10), { events: 9600 });
    const start = Math.floor(NOW / SPIKE_WINDOW_MS) * SPIKE_WINDOW_MS;
    ingest(
      Array.from({ length: 20 }, (_, i) => pv(`r${i}`)),
      { spikeMin: 5, now: start + MIN },
    );
    expect(guard.view("auto", start + MIN).state).toBe("none");
    // A site created yesterday has a day of history: 9600 / 96 = 100 per window again.
    const fresh = new Guard(db);
    const res = engine.ingest(db, [pv("x")], start + 2 * MIN, {});
    fresh.afterIngest([pv("x")], res.results, { mode: "auto", spikeMin: 5, createdAt: NOW - DAY, now: start + 2 * MIN });
    expect(fresh.view("auto", start + 2 * MIN).state).toBe("none");
    // A site created today has no history: the threshold is SPIKE_MIN_EVENTS.
    const brandNew = new Guard(db);
    const evs = Array.from({ length: 5 }, (_, i) => pv(`y${i}`));
    const r2 = engine.ingest(db, evs, start + 3 * MIN, {});
    brandNew.afterIngest(evs, r2.results, { mode: "auto", spikeMin: 5, createdAt: NOW - HOUR, now: start + 3 * MIN });
    expect(brandNew.view("auto", start + 3 * MIN).state).toBe("under_attack");
  });

  it("the episode survives the object being evicted (written to meta on a state change)", () => {
    for (let i = 0; i < 2; i++) one(pv("n1"), { share: 1 });
    const again = new Guard(db);
    expect(again.view("auto", NOW + MIN)).toMatchObject({ state: "contained", since: NOW });
  });

  it("release brings quarantined events into reports and the day's usage; purge deletes them and their sessions", () => {
    for (let i = 0; i < 4; i++) one(pv("n1", { pathname: `/a${i}` }), { share: 1 });
    one(pv("dc", { asn: AWS, visitor_hash: "v_dc" }), { mode: "strict" });
    const s = settings({ created_at: NOW - 30 * DAY });
    const sum = quarantineSummary(db, s, { period: "7d" }, guard.view("auto", NOW), NOW) as any;
    expect(sum).toMatchObject({ quarantined: 4, by_reason: { network_share: 3, datacenter: 1 } });
    expect(sum.by_day).toEqual([{ day: "2026-11-03", events: 4, network_share: 3, datacenter: 1 }]);
    expect(sum.networks.find((n: any) => n.asn === AWS)).toMatchObject({ events: 1, datacenter: true });
    expect(sum.untrusted.pages.map((p: any) => p.pathname)).toContain("/a3");
    expect(pageviews()).toBe(1);

    const rel = releaseQuarantine(db, s, { period: "7d", reason: "network_share" }, NOW) as any;
    expect(rel).toMatchObject({ matched: 3, released: 3, by_day: { "2026-11-03": 3 }, more: false });
    expect(pageviews()).toBe(4);
    expect(engine.usageOn(db, "2026-11-03").events).toBe(4);

    const before = db.all("SELECT COUNT(*) AS n FROM sessions")[0]?.n;
    const pur = purgeQuarantine(db, s, { period: "7d" }, NOW) as any;
    expect(pur).toMatchObject({ matched: 1, deleted: { events: 1, sessions: 1 } });
    expect(db.all("SELECT COUNT(*) AS n FROM sessions")[0]?.n).toBe(Number(before) - 1);
    expect(pageviews("quarantined")).toBe(0);
    // The quarantine's daily count is not lowered by either.
    expect(engine.usageOn(db, "2026-11-03").quarantined).toBe(4);
  });

  it("the daily purge drops quarantined events after 7 days (with the sessions only they made) and yesterday's network counts", () => {
    one(pv("n0"), { share: 1 });
    one(pv("n0", { pathname: "/x" }), { share: 1 });
    expect(db.all("SELECT COUNT(*) AS n FROM events WHERE debug = 2")[0]?.n).toBe(1);
    engine.purge(db, 400, NOW + DAY);
    expect(db.all("SELECT COUNT(*) AS n FROM net_daily")[0]?.n).toBe(0);
    expect(db.all("SELECT COUNT(*) AS n FROM events WHERE debug = 2")[0]?.n).toBe(1);
    engine.purge(db, 400, NOW + 8 * DAY);
    expect(db.all("SELECT COUNT(*) AS n FROM events WHERE debug = 2")[0]?.n).toBe(0);
    // The session held a counted pageview too, so it stays.
    expect(db.all("SELECT COUNT(*) AS n FROM sessions")[0]?.n).toBe(1);
    // A session made only of quarantined events goes with them.
    one(pv("dc", { asn: AWS, visitor_hash: "only_dc" }), { mode: "strict" });
    engine.purge(db, 400, NOW + 8 * DAY);
    expect(db.all("SELECT COUNT(*) AS n FROM sessions WHERE visitor_id = 'only_dc'")[0]?.n).toBe(0);
  });

  it("an older DO migrates to 12: the quarantine column, index, usage counter and net_daily", () => {
    const old = memoryDb({ migrate: false });
    for (const stmt of engine.SCHEMA_V1.split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      old.run(stmt);
    old.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    engine.migrate(old);
    expect(engine.schemaVersion(old)).toBe(12);
    expect(engine.hasColumn(old, "events", "quarantine")).toBe(true);
    expect(engine.hasColumn(old, "usage", "quarantined")).toBe(true);
    expect(
      old.all("SELECT name FROM sqlite_master WHERE name IN ('net_daily', 'events_quarantined') ORDER BY name").map((r) => r.name),
    ).toEqual(["events_quarantined", "net_daily"]);
  });
});
