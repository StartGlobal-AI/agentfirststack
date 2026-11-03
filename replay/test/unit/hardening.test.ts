/**
 * The security, abuse and cost hardening, pure parts: domain rules, scrubbing, the attribute
 * allowlist, linear rage detection, the engine's counters and budgets, tombstones, pending R2
 * deletes, bounded retention, the in-place DO migration and the index it uses.
 */
import { describe, expect, it } from "vitest";
import {
  clearPending,
  deleteSessions,
  housekeeping,
  linkChunk,
  maintain,
  migrate,
  pendingDue,
  purgeRound,
  recordDrop,
  rollup,
  SCHEMA_V1,
  schemaVersion,
  summary,
} from "../../src/do/engine";
import { scrubAttributes } from "../../src/lib/attrs";
import { rawLabel, type El } from "../../src/lib/describe";
import { accountBudget, ingestCaps, platformBudget } from "../../src/lib/limits";
import { cleanText, inputValueVisible, scrubCss, scrubLink, scrubPath, scrubResource, scrubSrcset } from "../../src/lib/mask-rules";
import { Sampler } from "../../src/lib/sampler";
import { type ClickPoint, detectRage, RAGE_MIN_CLICKS, RAGE_WINDOW_MS } from "../../src/lib/signals";
import { checkHostPattern, hostProblem, normalizeDomain, siteHostAllowed } from "../../src/lib/url";
import { click, error, mousemove, page, T0 } from "../fixtures/rrweb";
import { feed, NOW, sid } from "./engine-helpers";
import { memoryDb } from "./sqlite";

const DAY = 86_400_000;
const today = new Date(NOW).toISOString().slice(0, 10);
const noCap = { sessions: null, chunks: null, bytes: null, derived: null };

describe("domains a site can claim (C1)", () => {
  it("refuses IPs, single labels, public suffixes and ports; normalises the rest", () => {
    expect(normalizeDomain("https://www.Shop.example.com/x?y")).toBe("shop.example.com");
    for (const [input, problem] of [
      ["1.2.3.4", "ip"],
      ["http://0x7f.1/", "ip"],
      ["[::1]", "ip"],
      ["com", "single_label"],
      ["localhost", "single_label"],
      ["co.uk", "public_suffix"],
      ["github.io", "public_suffix"],
      ["www.pages.dev", "public_suffix"],
      ["example.com:8443", "invalid"],
      ["exa mple.com", "invalid"],
    ] as const)
      expect(() => normalizeDomain(input), input).toThrowError(expect.objectContaining({ problem }));
    expect(normalizeDomain("me.github.io")).toBe("me.github.io");
    expect(normalizeDomain("shop.example.co.uk")).toBe("shop.example.co.uk");
    expect(normalizeDomain("localhost", true)).toBe("localhost");
    expect(hostProblem("127.0.0.1", true)).toBeNull();
  });
  it("allowed_hostnames: no wildcards over TLDs or public suffixes; old unsafe entries stop matching", () => {
    expect(checkHostPattern("*.Example.net")).toEqual({ pattern: "*.example.net" });
    for (const p of ["*.com", "*.co.uk", "*.github.io", "*.vercel.app", "10.0.0.1", "*", "*.*.com"])
      expect("problem" in checkHostPattern(p), p).toBe(true);
    // a row stored before the rules: "*.com" no longer admits every .com site
    expect(siteHostAllowed("victim.com", "mine.test", ["*.com"], false)).toBe(false);
    expect(siteHostAllowed("a.example.net", "mine.test", ["*.example.net"], false)).toBe(true);
    expect(siteHostAllowed("1.2.3.4", "mine.test", null, false)).toBe(false);
    expect(siteHostAllowed("localhost", "mine.test", null, true)).toBe(true);
  });
});

describe("what leaves the browser (M1, M2)", () => {
  it("links lose queries, fragments and id-like segments; mailto/tel keep only the scheme", () => {
    expect(scrubLink("https://x.test/orders/12345/jane%40x.test?token=a#frag")).toBe("https://x.test/orders/:id/:id");
    expect(scrubLink("/u/9f1c2a7e-1b2c-4d5e-8f90-123456789abc/settings")).toBe("/u/:id/settings");
    expect(scrubLink("/reset/eyJhbGciOiJIUzI1NiJ9abc123")).toBe("/reset/:id");
    expect(scrubLink("/products/iphone-15-pro-256gb")).toBe("/products/iphone-15-pro-256gb");
    expect(scrubLink("/blog/2")).toBe("/blog/2");
    expect(scrubLink("mailto:jane@x.test?subject=hi")).toBe("mailto:");
    expect(scrubLink("tel:+15551234567")).toBe("tel:");
    expect(scrubLink("javascript:alert(1)")).toBe("javascript:");
    expect(scrubLink("#pricing")).toBe("#pricing");
    expect(scrubLink("#access_token=abc.def")).toBe("#");
    expect(scrubPath("/a/jane@x.test/b")).toBe("/a/:id/b");
  });
  it("resources (img, srcset, CSS url()) keep their path but no query; data:image stays", () => {
    expect(scrubResource("https://cdn.test/a/photo.jpg?sig=secret&u=jane@x.test")).toBe("https://cdn.test/a/photo.jpg");
    expect(scrubResource("https://www.gravatar.com/avatar/205e460b479e2e5b48aec07710c08d50")).toBe("https://www.gravatar.com/avatar/:id");
    expect(scrubResource("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(scrubResource("data:text/html,<script>")).toBe("data:");
    expect(scrubSrcset("a.png?x=1 1x, /b.png?t=2 2x")).toBe("a.png 1x, /b.png 2x");
    expect(scrubCss("background:url('/bg.png?token=abc') no-repeat; mask: url(x.svg#m)")).toBe(
      "background:url('/bg.png') no-repeat; mask: url(x.svg)",
    );
  });
  it("control characters, separators, bidi overrides and zero-width characters are removed", () => {
    const s = ["a", "\n", "b", String.fromCharCode(0x2028), "c", String.fromCharCode(0x202e), "d", String.fromCharCode(0x200b), "e"].join(
      "",
    );
    expect(cleanText(s)).toBe("a b cde");
    expect(cleanText("x\r\ny\tz", true)).toBe("x\ny z");
  });
  it("attributes are an allowlist: text masked by the rule, URLs scrubbed, the rest dropped", () => {
    const attrs: Record<string, unknown> = {
      class: "btn primary",
      title: "Jane Doe",
      "data-state": "open",
      "data-user-email": "jane@x.test",
      "aria-label": "Account of Jane",
      "aria-expanded": "true",
      "aria-controls": "menu-1",
      href: "https://x.test/u/12345?t=1",
      src: "/img/a.png?sig=1",
      srcset: "/a.png?x 1x",
      style: "background:url(/b.png?tok=1)",
      onclick: "steal()",
      nonce: "abc",
      "x-custom": "secret",
      value: "Jane",
      rr_width: "100px",
    };
    scrubAttributes("button", attrs, { rule: () => "mask", svg: false });
    expect(attrs).toEqual({
      class: "btn primary",
      title: "**** ***",
      "data-state": "open",
      "data-user-email": "***********",
      "aria-label": "******* ** ****",
      "aria-expanded": "true",
      "aria-controls": "menu-1",
      href: "https://x.test/u/:id",
      src: "/img/a.png",
      srcset: "/a.png 1x",
      style: "background:url(/b.png)",
      value: "****",
      rr_width: "100px",
    });
    const meta: Record<string, unknown> = { name: "csrf-token", content: "s3cr3t" };
    scrubAttributes("meta", meta, { rule: () => "show", svg: false });
    expect(meta).toEqual({ name: "csrf-token" });
    const svg: Record<string, unknown> = { d: "M0 0L10 10", viewBox: "0 0 10 10", "aria-label": "Jane", onload: "x()" };
    scrubAttributes("path", svg, { rule: () => "mask", svg: true });
    expect(svg).toEqual({ d: "M0 0L10 10", viewBox: "0 0 10 10", "aria-label": "****" });
    const hidden: Record<string, unknown> = { type: "hidden", value: "csrf123" };
    scrubAttributes("input", hidden, { rule: () => "show", svg: false });
    expect(hidden.value).toBe("*******");
    const mutation: Record<string, unknown> = { style: { "background-image": "url(/x.png?token=1)", color: false } };
    scrubAttributes("div", mutation, { rule: () => "show", svg: false });
    expect(mutation.style).toEqual({ "background-image": "url(/x.png)", color: false });
  });
  it("typed values show only inside [data-afsr-unmask] on the page, never for secret fields (H3)", () => {
    expect(inputValueVisible("text", null, "q", true, false)).toBe(true);
    expect(inputValueVisible("text", null, "q", false, false)).toBe(false); // unmask_selectors alone never reveal values
    expect(inputValueVisible("text", null, "q", true, true)).toBe(false);
    expect(inputValueVisible("password", null, "pw", true, false)).toBe(false);
    expect(inputValueVisible("text", "cc-number", "card", true, false)).toBe(false);
  });
  it("click labels mask each part by its own rule and never name blocked parts", () => {
    const text = (n: string, rule: "mask" | "show") => ({ n, rule });
    const parts = [text("Pay ", "show"), text("€49", "mask")];
    const btn: El = { tagName: "BUTTON", id: "", parentElement: null, getAttribute: () => null, children: [], textContent: "Pay €49" };
    const masked = (e: El) => (e === btn ? parts.map((p) => (p.rule === "mask" ? p.n.replace(/\S/g, "*") : p.n)).join("") : "");
    expect(rawLabel(btn)).toBe("Pay €49");
    expect(rawLabel(btn, masked)).toBe("Pay ***");
  });
});

describe("rage detection is linear (H4)", () => {
  const brute = (clicks: ClickPoint[]) => {
    const rage = clicks.map(() => false);
    for (let j = 0; j < clicks.length; j++) {
      const m = [j];
      for (let i = j - 1; i >= 0 && clicks[j]!.ts - clicks[i]!.ts <= RAGE_WINDOW_MS; i--)
        if (
          clicks[i]!.pv === clicks[j]!.pv &&
          (clicks[i]!.selector === clicks[j]!.selector || Math.hypot(clicks[i]!.x - clicks[j]!.x, clicks[i]!.y - clicks[j]!.y) <= 30)
        )
          m.push(i);
      if (m.length >= RAGE_MIN_CLICKS) for (const k of m) rage[k] = true;
    }
    return rage;
  };
  it("matches the exhaustive definition whenever clicks are at most 20 per second", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 20; run++) {
      const clicks: ClickPoint[] = [];
      let ts = T0;
      for (let i = 0; i < 300; i++) {
        ts += 50 + Math.floor(rnd() * 400);
        clicks.push({ ts, pv: 1, selector: `#b${Math.floor(rnd() * 3)}`, x: Math.floor(rnd() * 100), y: 0 });
      }
      expect(detectRage(clicks).rage).toEqual(brute(clicks));
    }
  });
  it("10,000 clicks in one second (crafted overlapping chunks) take milliseconds, not seconds", () => {
    const clicks = Array.from({ length: 10_000 }, (_, i) => ({ ts: T0 + (i % 1000), pv: 1, selector: "#x", x: 1, y: 1 }));
    clicks.sort((a, b) => a.ts - b.ts);
    const t = performance.now();
    detectRage(clicks);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("daily counters and budgets (C2)", () => {
  it("forced sessions have their own small quota; the rest count against the site's daily cap", () => {
    const db = memoryDb();
    const lim = { limits: { daily_sessions: 1, forced_daily: 1 } };
    expect(feed(db, sid(1), 0, [page(T0, 1, "/")], lim).status).toBe("accepted");
    expect(feed(db, sid(2), 0, [page(T0, 1, "/")], { ...lim, meta: { forced: true } }).status).toBe("accepted");
    expect(feed(db, sid(3), 0, [page(T0, 1, "/")], { ...lim, meta: { forced: true } })).toMatchObject({ reason: "forced_daily_limit" });
    expect(feed(db, sid(4), 0, [page(T0, 1, "/")], lim)).toMatchObject({ reason: "daily_session_limit" });
    expect(summary(db, NOW).usage_today).toMatchObject({ sessions: 2, forced_sessions: 1 });
  });
  it("one network starts at most net_daily sessions per site and day", () => {
    const db = memoryDb();
    const lim = { limits: { daily_sessions: null, net_daily: 2 } };
    feed(db, sid(1), 0, [page(T0, 1, "/")], { ...lim, net: "n1" });
    feed(db, sid(2), 0, [page(T0, 1, "/")], { ...lim, net: "n1" });
    expect(feed(db, sid(3), 0, [page(T0, 1, "/")], { ...lim, net: "n1" })).toMatchObject({ reason: "ip_daily_limit", stop: true });
    expect(feed(db, sid(4), 0, [page(T0, 1, "/")], { ...lim, net: "n2" }).status).toBe("accepted");
    // running sessions from that network continue
    expect(feed(db, sid(1), 1, [click(T0 + 100, 1, "#a")], { ...lim, net: "n1" }).status).toBe("accepted");
  });
  it("the account's budget counts the D1 totals plus what this site hasn't reported", () => {
    const db = memoryDb();
    const account = { ...noCap, sessions: 3, bytes: 5_000 };
    const usage = { day: today, account: { sessions: 1, chunks: 1, bytes: 1_000, derived: 0 }, platform: null };
    const lim = { limits: { daily_sessions: null, account }, usage };
    expect(feed(db, sid(1), 0, [page(T0, 1, "/")], lim).status).toBe("accepted");
    expect(feed(db, sid(2), 0, [page(T0, 1, "/")], lim).status).toBe("accepted");
    expect(feed(db, sid(3), 0, [page(T0, 1, "/")], lim)).toMatchObject({ reason: "account_daily_limit", counter: "sessions" });
    // bytes: 1000 (D1) + 2000 (local) + 3000 > 5000
    expect(feed(db, sid(1), 1, [click(T0 + 10, 1, "#a")], { ...lim, bytes: 3_000 })).toMatchObject({
      reason: "account_daily_limit",
      counter: "bytes",
      stop: true,
    });
    // a snapshot from another day doesn't count
    expect(feed(db, sid(1), 1, [click(T0 + 10, 1, "#a")], { ...lim, usage: { ...usage, day: "2000-01-01" } }).status).toBe("accepted");
  });
  it("the deployment's budget refuses everyone past it", () => {
    const db = memoryDb();
    const usage = { day: today, account: null, platform: { sessions: 0, chunks: 0, bytes: 0, derived: 999 } };
    const r = feed(db, sid(1), 0, [page(T0, 1, "/"), click(T0 + 10, 1, "#a"), click(T0 + 900, 1, "#b")], {
      limits: { daily_sessions: null, platform: { ...noCap, derived: 1000 } },
      usage,
    });
    expect(r).toMatchObject({ status: "rejected", reason: "platform_budget", counter: "derived" });
  });
  it("derived rows per session and chunks per session follow the vars", () => {
    const db = memoryDb();
    const lim = { limits: { derived_per_session: 3, chunks_per_session: 2 } };
    feed(db, sid(1), 0, [page(T0, 1, "/"), ...[1, 2, 3, 4, 5].map((i) => click(T0 + i * 200, 1, `#b${i}`))], lim);
    expect(db.all("SELECT COUNT(*) AS n FROM events WHERE session_id = ?", [sid(1)])[0]!.n).toBe(3);
    expect(db.all("SELECT limited FROM sessions WHERE id = ?", [sid(1)])[0]!.limited).toBe("events");
    feed(db, sid(1), 1, [mousemove(T0 + 2000)], lim);
    expect(feed(db, sid(1), 2, [mousemove(T0 + 3000)], lim)).toMatchObject({ reason: "session_chunk_limit" });
  });
  it("forwarding to analytics stops at the daily cap", () => {
    const db = memoryDb();
    const burst = (base: number, sel: string) => [0, 200, 400].map((d) => click(base + d, 1, sel));
    const first = feed(db, sid(1), 0, [page(T0, 1, "/"), ...burst(T0 + 1000, "#a"), ...burst(T0 + 5000, "#b")], {
      forward: true,
      end: true,
      limits: { forward_daily: 1 },
    });
    expect(first.status === "accepted" && first.forward.map((f) => f.name)).toEqual(["rage_click"]);
    expect(summary(db, NOW).usage_today.forwarded_events).toBe(1);
  });
  it("unreported deltas are reported once", async () => {
    const { unreported, markReported } = await import("../../src/do/engine");
    const db = memoryDb();
    feed(db, sid(1), 0, [page(T0, 1, "/")], { bytes: 700 });
    const u = unreported(db);
    expect(u).toEqual([{ day: today, delta: { sessions: 1, chunks: 1, bytes: 700, derived: 0 } }]);
    markReported(db, u);
    expect(unreported(db)).toEqual([]);
  });
  it("account and platform budgets come from the vars, UNCLAIMED_ variants for unclaimed accounts", () => {
    const env = {
      MAX_BYTES_PER_ACCOUNT_PER_DAY: "100",
      UNCLAIMED_MAX_BYTES_PER_ACCOUNT_PER_DAY: "10",
      MAX_PLATFORM_CHUNKS_PER_DAY: "5",
    } as never;
    expect(accountBudget(env, { suspended: false, claimed: true }).bytes).toBe(100);
    expect(accountBudget(env, { suspended: false, claimed: false }).bytes).toBe(10);
    expect(accountBudget(env, { suspended: false, claimed: true }).sessions).toBeNull();
    expect(platformBudget(env, { suspended: false, claimed: true }).chunks).toBe(5);
    // unverified sites get the trial cap; verified ones the site cap
    const caps = (verified: boolean) =>
      ingestCaps({ MAX_SESSIONS_PER_SITE_PER_DAY: "200" } as never, { suspended: false, claimed: true }, verified);
    expect(caps(false).daily_sessions).toBe(20);
    expect(caps(true).daily_sessions).toBe(200);
    expect(caps(true)).toMatchObject({ derived_per_chunk: 500, derived_per_session: 1500, forced_daily: 20, net_daily: 50 });
  });
});

describe("deletion and retention (H2, LOW)", () => {
  it("privacy deletes tombstone the session for two days and queue its R2 keys until confirmed", () => {
    const db = memoryDb();
    feed(db, sid(1), 0, [page(T0, 1, "/")]);
    feed(db, sid(1), 1, [mousemove(T0 + 100)]);
    const d = deleteSessions(db, [sid(1)], { prefix: "rsite_x/", not_before: NOW + 60_000, tombstone_at: NOW });
    expect(d.deleted).toEqual([sid(1)]);
    expect(feed(db, sid(1), 2, [mousemove(T0 + 200)])).toEqual({ status: "rejected", reason: "session_deleted", stop: true });
    expect(pendingDue(db, NOW)).toEqual([]);
    const due = pendingDue(db, NOW + 60_000);
    expect(due).toEqual([`rsite_x/${sid(1)}/000000`, `rsite_x/${sid(1)}/000001`]);
    clearPending(db, due);
    expect(pendingDue(db, NOW + 60_000)).toEqual([]);
    housekeeping(db, NOW + 3 * DAY, null);
    expect(feed(db, sid(1), 3, [page(T0, 1, "/")], { now: NOW + 3 * DAY }).status).toBe("accepted");
  });
  it("purge rounds are bounded by keys; maintain loops until done or the deadline", () => {
    const db = memoryDb();
    for (let i = 1; i <= 6; i++) for (let q = 0; q < 3; q++) feed(db, sid(i), q, q === 0 ? [page(T0, 1, "/")] : [mousemove(T0 + q * 10)]);
    const r = purgeRound(db, { now: NOW, cutoff: NOW, heat_cutoff: null, prefix: "p/", max_keys: 7 });
    expect(r.deleted).toHaveLength(2);
    expect(r.more).toBe(true);
    const m = maintain(db, { now: NOW, cutoff: NOW, heat_cutoff: null, prefix: "p/", max_keys: 7, deadline: Date.now() + 5_000 });
    expect(m).toMatchObject({ sessions_deleted: 4, more: false });
    expect(pendingDue(db, NOW, 100)).toHaveLength(18);
    // nothing past the deadline
    feed(db, sid(9), 0, [page(T0, 1, "/")]);
    expect(maintain(db, { now: NOW, cutoff: NOW, heat_cutoff: null, prefix: "p/", deadline: 0 }).sessions_deleted).toBe(0);
    // unknown retention (no config yet): nothing is deleted
    expect(purgeRound(db, { now: NOW, cutoff: null, heat_cutoff: null }).deleted).toEqual([]);
  });
  it("rollups are bounded per call and say when there is more", () => {
    const db = memoryDb();
    for (let d = 0; d < 5; d++)
      feed(db, sid(d + 1), 0, [page(T0 + d * DAY, 1, "/"), click(T0 + d * DAY + 10, 1, "#a")], { now: T0 + d * DAY + 60_000 });
    const a = rollup(db, T0 + 10 * DAY, 2);
    expect(a.rolled).toHaveLength(2);
    expect(a.more).toBe(true);
    expect(rollup(db, T0 + 10 * DAY, 31)).toMatchObject({ more: false });
  });
  it("refusal counts take a count, and samples are dropped after a day", () => {
    const db = memoryDb();
    recordDrop(db, "origin_not_allowed", "evil.test", NOW - 2 * DAY, 5);
    recordDrop(db, "origin_not_allowed", null, NOW - 2 * DAY, 2);
    housekeeping(db, NOW, null);
    const s = summary(db, NOW);
    expect(s.dropped_last_7d.origin_not_allowed).toMatchObject({ count: 7 });
    expect(s.drop_samples.origin_not_allowed).toBeUndefined();
    const sm = new Sampler(1000);
    expect(sm.take("k", 0, "a")).toEqual({ count: 1, sample: "a" });
    expect(sm.take("k", 10, "b")).toBeNull();
    expect(sm.take("k", 20, null)).toBeNull();
    expect(sm.take("k", 2000, null)).toEqual({ count: 3, sample: "b" });
  });
});

describe("share-link chunks (H1)", () => {
  it("serve only chunks with rrweb events, within the link's daily byte budget", () => {
    const db = memoryDb();
    feed(db, sid(1), 0, [page(T0, 1, "/")], { bytes: 600 });
    feed(db, sid(1), 1, [], { bytes: 50 });
    const q = { link_id: "rpl_1", session_id: sid(1), now: NOW, budget: 1000 };
    expect(linkChunk(db, { ...q, seq: 0 })).toEqual({ ok: true, bytes: 600 });
    expect(linkChunk(db, { ...q, seq: 1 })).toEqual({ ok: false, reason: "not_found" });
    expect(linkChunk(db, { ...q, seq: 7 })).toEqual({ ok: false, reason: "not_found" });
    expect(linkChunk(db, { ...q, seq: 0 })).toEqual({ ok: false, reason: "budget" });
    expect(linkChunk(db, { ...q, seq: 0, now: NOW + DAY })).toEqual({ ok: true, bytes: 600 });
  });
});

describe("Durable Object schema (C2: in-place migration, fewer index writes)", () => {
  it("a version-1 database migrates in place: old indexes dropped, counters seeded, idempotent", () => {
    const db = memoryDb(false);
    for (const s of SCHEMA_V1.split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      db.run(s);
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    db.run("INSERT INTO sessions (id, started_at, last_at, received_at, day, chunks, bytes) VALUES (?, ?, ?, ?, ?, 2, 900)", [
      sid(1),
      NOW,
      NOW,
      NOW,
      today,
    ]);
    migrate(db, NOW);
    expect(schemaVersion(db)).toBe(2);
    const indexes = () =>
      db
        .all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
        .map((r) => String(r.name))
        .sort();
    expect(indexes()).toEqual(["events_ce", "events_fingerprint", "events_session"]);
    expect(summary(db, NOW).usage_today).toMatchObject({ sessions: 1, chunks: 2, bytes: 900 });
    migrate(db, NOW); // again: nothing recreated
    expect(indexes()).toEqual(["events_ce", "events_fingerprint", "events_session"]);
  });
  it("time-range queries over clicks and errors use the partial index", () => {
    const db = memoryDb();
    const plan = (sql: string) => JSON.stringify(db.all(`EXPLAIN QUERY PLAN ${sql}`));
    expect(plan("SELECT COUNT(*) FROM events WHERE kind IN ('click', 'error') AND kind = 'click' AND ts >= 1 AND ts < 2")).toContain(
      "events_ce",
    );
    expect(
      plan("SELECT COUNT(*) FROM events e WHERE e.kind IN ('click', 'error') AND e.kind = 'error' AND e.ts >= 1 AND e.ts <= 2"),
    ).toContain("events_ce");
    // an input, event, scroll or mark insert touches only events_session (and the table)
    feed(db, sid(1), 0, [page(T0, 1, "/"), error(T0 + 1, 1, "boom")]);
    expect(db.all("SELECT COUNT(*) AS n FROM events INDEXED BY events_ce WHERE kind IN ('click', 'error') AND kind = 'error'")[0]!.n).toBe(
      1,
    );
  });
});
