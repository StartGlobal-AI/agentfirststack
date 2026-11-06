/**
 * Hardening round (abuse guardrails), pure parts: a site's own daily budget so a flooded site stops
 * alone, the network's byte share of a site's day, attack mode (no new data-centre sessions while a
 * site is under attack), and the caps' defaults from the vars.
 */
import { describe, expect, it } from "vitest";
import { ATTACK_MIN_SESSIONS, attackThreshold, noteSessionAttempt, summary } from "../../src/do/engine";
import { claimedFirstCap, ingestCaps, siteBudget } from "../../src/lib/limits";
import { click, page, T0 } from "../fixtures/rrweb";
import { feed, NOW, sid } from "./engine-helpers";
import { memoryDb } from "./sqlite";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const noCap = { sessions: null, chunks: null, bytes: null, derived: null };
const claimed = { suspended: false, claimed: true };
const unclaimed = { suspended: false, claimed: false };

describe("a site's own daily budget (one flooded site can't stop the account's other sites)", () => {
  it("refuses that site past its budget, with the counter, before the account's budget is reached", () => {
    const db = memoryDb();
    const lim = { limits: { daily_sessions: null, site: { ...noCap, bytes: 2_500 }, account: { ...noCap, bytes: 10_000 } } };
    expect(feed(db, sid(1), 0, [page(T0, 1, "/")], { ...lim, bytes: 1_000 }).status).toBe("accepted");
    expect(feed(db, sid(1), 1, [click(T0 + 100, 1, "#a")], { ...lim, bytes: 1_000 }).status).toBe("accepted");
    expect(feed(db, sid(1), 2, [click(T0 + 200, 1, "#b")], { ...lim, bytes: 1_000 })).toMatchObject({
      status: "rejected",
      reason: "site_daily_limit",
      counter: "bytes",
      stop: true,
    });
    // a smaller chunk still fits
    expect(feed(db, sid(1), 2, [click(T0 + 200, 1, "#b")], { ...lim, bytes: 400 }).status).toBe("accepted");
    // the account's own budget is still the reason when it is the one passed
    const usage = {
      day: new Date(NOW).toISOString().slice(0, 10),
      account: { sessions: 0, chunks: 0, bytes: 9_000, derived: 0 },
      platform: null,
    };
    expect(feed(memoryDb(), sid(2), 0, [page(T0, 1, "/")], { ...lim, usage, bytes: 1_500 })).toMatchObject({
      reason: "account_daily_limit",
    });
  });

  it("defaults to half the account's budget per counter; the vars (and UNCLAIMED_) win; none without budgets", () => {
    const env = {
      MAX_CHUNKS_PER_ACCOUNT_PER_DAY: "100",
      MAX_BYTES_PER_ACCOUNT_PER_DAY: "1000",
      UNCLAIMED_MAX_BYTES_PER_ACCOUNT_PER_DAY: "400",
      MAX_DERIVED_PER_SITE_PER_DAY: "7",
      MAX_SESSIONS_PER_ACCOUNT_PER_DAY: "10",
    } as never;
    const c = ingestCaps(env, claimed, true);
    expect(c.site).toEqual({ sessions: null, chunks: 50, bytes: 500, derived: 7 });
    expect(c.daily_sessions).toBe(5); // MAX_SESSIONS_PER_SITE_PER_DAY unset: half the account's sessions
    expect(c.net_bytes).toBe(50); // a tenth of the site's byte budget
    expect(ingestCaps(env, unclaimed, true).site.bytes).toBe(200);
    const explicit = {
      ...(env as object),
      MAX_BYTES_PER_SITE_PER_DAY: "900",
      MAX_SESSIONS_PER_SITE_PER_DAY: "8",
      MAX_BYTES_PER_IP_PER_SITE_PER_DAY: "33",
    };
    expect(ingestCaps(explicit as never, claimed, true)).toMatchObject({ site: { bytes: 900 }, daily_sessions: 8, net_bytes: 33 });
    // nothing configured: no site budget, no network byte share (self-hosting stays uncapped)
    const none = ingestCaps({} as never, claimed, true);
    expect(none.site).toEqual(noCap);
    expect(none).toMatchObject({ daily_sessions: null, net_bytes: null });
    // a share of a tiny budget is at least 1
    expect(siteBudget({} as never, claimed, { ...noCap, chunks: 1 }).chunks).toBe(1);
  });
});

describe("the network's byte share of a site's day", () => {
  it("bounds the bytes one network sends a site, every chunk counted; other networks continue", () => {
    const db = memoryDb();
    const lim = { limits: { daily_sessions: null, net_bytes: 2_500 } };
    expect(feed(db, sid(1), 0, [page(T0, 1, "/")], { ...lim, net: "n1", bytes: 1_000 }).status).toBe("accepted");
    expect(feed(db, sid(2), 0, [page(T0, 1, "/")], { ...lim, net: "n1", bytes: 1_000 }).status).toBe("accepted");
    // a running session's chunk from that network counts too
    expect(feed(db, sid(1), 1, [click(T0 + 100, 1, "#a")], { ...lim, net: "n1", bytes: 1_000 })).toMatchObject({
      reason: "ip_bytes_limit",
      stop: true,
    });
    expect(feed(db, sid(3), 0, [page(T0, 1, "/")], { ...lim, net: "n2", bytes: 1_000 }).status).toBe("accepted");
    expect(db.all("SELECT net, sessions, bytes FROM net_daily ORDER BY net")).toEqual([
      { net: "n1", sessions: 2, bytes: 2_000 },
      { net: "n2", sessions: 1, bytes: 1_000 },
    ]);
  });
});

describe("attack mode: no new data-centre sessions while a site is under attack", () => {
  const flood = (db: ReturnType<typeof memoryDb>, from: number, n: number, now = NOW) => {
    for (let i = 0; i < n; i++) feed(db, sid(from + i), 0, [page(T0, 1, "/")], { now, net: `r${from + i}` });
  };

  it("data-centre networks record as usual until a spike; then they start no session and don't count", () => {
    const db = memoryDb();
    expect(feed(db, sid(1), 0, [page(T0, 1, "/")], { dc: true, net: "dc1" }).status).toBe("accepted");
    flood(db, 100, ATTACK_MIN_SESSIONS - 1);
    expect(summary(db, NOW).protection).toMatchObject({ state: "under_attack", threshold_per_window: ATTACK_MIN_SESSIONS });
    const before = summary(db, NOW).usage_today.sessions;
    expect(feed(db, sid(2), 0, [page(T0, 1, "/")], { dc: true, net: "dc2" })).toMatchObject({
      status: "rejected",
      reason: "datacenter_under_attack",
      stop: true,
    });
    expect(summary(db, NOW).usage_today.sessions).toBe(before);
    expect(db.all("SELECT 1 FROM sessions WHERE id = ?", [sid(2)])).toHaveLength(0);
    // residential visitors, running data-centre sessions and ?afsr=1 tests are not affected
    expect(feed(db, sid(3), 0, [page(T0, 1, "/")], { net: "res" }).status).toBe("accepted");
    expect(feed(db, sid(1), 1, [click(T0 + 100, 1, "#a")], { dc: true, net: "dc1" }).status).toBe("accepted");
    expect(feed(db, sid(4), 0, [page(T0, 1, "/")], { dc: true, net: "dc3", meta: { forced: true } }).status).toBe("accepted");
    // an hour after the last spiking window, it ends
    const later = NOW + HOUR + 20 * 60_000;
    expect(summary(db, later).protection.state).toBe("none");
    expect(feed(db, sid(5), 0, [page(T0, 1, "/")], { dc: true, net: "dc4", now: later }).status).toBe("accepted");
  });

  it("the threshold follows the site's usual rate over the previous 7 days, and a flood costs at most threshold writes per window", () => {
    const db = memoryDb();
    // 10 sessions per 15 minutes on each of the previous 7 days
    for (let d = 1; d <= 7; d++)
      db.run("INSERT INTO daily (day, sessions) VALUES (?, ?)", [new Date(NOW - d * DAY).toISOString().slice(0, 10), 960]);
    expect(attackThreshold(10)).toBe(100);
    for (let i = 0; i < ATTACK_MIN_SESSIONS + 5; i++) expect(noteSessionAttempt(db, NOW)).toBe(false);
    for (let i = ATTACK_MIN_SESSIONS + 5; i < 99; i++) noteSessionAttempt(db, NOW);
    expect(noteSessionAttempt(db, NOW)).toBe(true);
    for (let i = 0; i < 50; i++) noteSessionAttempt(db, NOW);
    const state = JSON.parse(String(db.all("SELECT value FROM meta WHERE key = 'attack'")[0]!.value));
    expect(state).toMatchObject({ attempts: 100, baseline: 10, since: NOW, last_seen_at: NOW });
    // a new window starts counting again; the episode lasts an hour after its last spiking window
    expect(noteSessionAttempt(db, NOW + 50 * 60_000)).toBe(true);
    expect(JSON.parse(String(db.all("SELECT value FROM meta WHERE key = 'attack'")[0]!.value)).attempts).toBe(1);
  });
});

describe("claimed-first caps (heatmap images)", () => {
  it("unclaimed accounts get only UNCLAIMED_<NAME> (default 0), never the claimed value", () => {
    const name = "MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY";
    expect(claimedFirstCap({} as never, claimed, name, 30, 0)).toBe(30);
    expect(claimedFirstCap({} as never, unclaimed, name, 30, 0)).toBe(0);
    expect(claimedFirstCap({ [name]: "100" } as never, unclaimed, name, 30, 0)).toBe(0);
    expect(claimedFirstCap({ [name]: "100", [`UNCLAIMED_${name}`]: "5" } as never, unclaimed, name, 30, 0)).toBe(5);
    expect(claimedFirstCap({ [name]: "100", [`UNCLAIMED_${name}`]: "5" } as never, claimed, name, 30, 0)).toBe(100);
  });
});
