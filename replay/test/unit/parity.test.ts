import { describe, expect, it } from "vitest";
import { addNote, annotate } from "../../src/do/annotations";
import { deleteSessions, linkChunk, playableChunks, purgeRound, rollup, segmentHit, signalSpikes } from "../../src/do/engine";
import {
  bucketStart,
  type EventMatch,
  funnelDropoffs,
  heatmap,
  listErrors,
  type MetricsBy,
  metrics,
  searchSessions,
  summarizeSessions,
  transcriptData,
} from "../../src/do/queries";
import { consentRequiredIn, ipInRanges, parseCidr } from "../../src/lib/ip";
import { requestUrl } from "../../src/lib/mask-rules";
import { ACTIVE_GAP_MS, activitySegments, attentionAdd, cleanTagValues, deriveChunk } from "../../src/lib/derive";
import { hashUserId, userIdForms } from "../../src/lib/hash";
import { buildTimeline, entryLine } from "../../src/lib/transcript";
import { BUILTIN_EVENTS } from "../../src/service/event-definitions";
import { parseTagFilters } from "../../src/service/sessions";
import { click, envelope, error, event, meta, mousemove, mutation, net, page, scroll, snapshot, T0, tag } from "../fixtures/rrweb";
import { feed, NOW, sid } from "./engine-helpers";
import { memoryDb } from "./sqlite";

const ALL = { start: 0, end: Number.MAX_SAFE_INTEGER };
const ids = (r: { sessions: { id: string }[] }) => r.sessions.map((s) => s.id).sort();

describe("1. custom tags and identify attributes", () => {
  it("derives afs.tag: key rules, at most 5 values, scrubbed like error messages", () => {
    const d = deriveChunk(
      envelope(sid(1), 0, [
        tag(T0, 1, "plan", ["pro", "pro", "trial"]),
        tag(T0 + 1, 1, "bad key!", "x"),
        tag(T0 + 2, 1, "email", "jane@example.com"),
        tag(T0 + 3, 1, "many", ["a", "b", "c", "d", "e", "f", "g"]),
        tag(T0 + 4, 1, "obj", { nested: 1 }),
        tag(T0 + 5, 1, "__proto__", "x"),
      ]),
      { minTs: T0 - 1000, maxTs: T0 + 10_000 },
    );
    expect(d.tags.map((t) => [t.key, t.values])).toEqual([
      ["plan", ["pro", "trial"]],
      ["email", ["[email]"]],
      ["many", ["a", "b", "c", "d", "e"]],
    ]);
    expect(d.invalid).toBe(2);
    expect(cleanTagValues(["word ".repeat(60), 3, true, null, "a\u202eb", "y"])).toEqual([
      `${"word ".repeat(20).slice(0, 99)}…`,
      "3",
      "true",
      "ab",
    ]);
  });

  it("stores tags per session (20 keys, 5 values), re-sends are free, filters with negation, summary and transcript", () => {
    const db = memoryDb();
    const a = sid(1);
    const b = sid(2);
    feed(db, a, 0, [meta(T0), snapshot(T0 + 1), page(T0 + 5, 1, "/"), tag(T0 + 10, 1, "plan", "pro"), tag(T0 + 11, 1, "exp", "B")]);
    // the next page load re-sends the tab's tags: nothing new is counted
    const before = db.all("SELECT derived FROM sessions WHERE id = ?", [a])[0]!.derived;
    feed(db, a, 1, [page(T0 + 2000, 2, "/x"), tag(T0 + 2001, 2, "plan", "pro")]);
    expect(db.all("SELECT derived FROM sessions WHERE id = ?", [a])[0]!.derived).toBe(before);
    feed(db, b, 0, [meta(T0), snapshot(T0 + 1), page(T0 + 5, 1, "/"), tag(T0 + 10, 1, "plan", "free")]);
    const q = (tags: ReturnType<typeof parseTagFilters>) => ids(searchSessions(db, { ...ALL, tags, sort: "recent", limit: 10 }));
    expect(q(parseTagFilters(["plan:pro"]))).toEqual([a]);
    expect(q(parseTagFilters(["plan"]))).toEqual([a, b]);
    expect(q(parseTagFilters(["!exp:B"]))).toEqual([b]);
    expect(q(parseTagFilters(["plan:pro", "exp:B"]))).toEqual([a]);
    expect(() => parseTagFilters(["bad key:x"])).toThrow(/tag/);
    const many = Array.from({ length: 25 }, (_, i) => tag(T0 + 20 + i, 1, `k${i}`, ["1", "2", "3", "4", "5", "6"]));
    feed(db, b, 1, many);
    expect(db.all("SELECT COUNT(DISTINCT key) AS n FROM session_tags WHERE session_id = ?", [b])[0]!.n).toBe(20);
    expect(db.all("SELECT COUNT(*) AS n FROM session_tags WHERE session_id = ? AND key = 'k0'", [b])[0]!.n).toBe(5);
    expect(db.all("SELECT limited FROM sessions WHERE id = ?", [b])[0]!.limited).toBe("events");
    const sum = summarizeSessions(db, { ...ALL, session_ids: [a, b], sort: "recent", limit: 10, top: 3 });
    expect("top_tags" in sum && sum.top_tags[0]).toMatchObject({ key: "exp", value: "B", sessions: 1, example_session_ids: [a] });
    const t = transcriptData(db, a, { maxEvents: 100 })!;
    const lines = buildTimeline(t.session, t.pages, t.events, t.tags).map(entryLine);
    expect(lines.some((l) => l.includes('tag "plan" = "pro"'))).toBe(true);
    deleteSessions(db, [a]);
    expect(db.all("SELECT COUNT(*) AS n FROM session_tags WHERE session_id = ?", [a])[0]!.n).toBe(0);
  });

  it("hash_user_ids: the server hashes a raw id exactly like the browser", async () => {
    const h = await hashUserId("rsite_0123456789abcdef", "u_42");
    expect(h).toMatch(/^h:[0-9a-f]{32}$/);
    // node's WebCrypto, as the recorder computes it
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("afsr:rsite_0123456789abcdef:u_42"));
    expect(h.slice(2)).toBe(
      Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32),
    );
    expect(await userIdForms("rsite_0123456789abcdef", "u_42", false)).toEqual(["u_42"]);
    expect(await userIdForms("rsite_0123456789abcdef", "u_42", true)).toEqual(["u_42", h]);
    expect(await hashUserId("rsite_0123456789abcdef", h)).toBe(h);
    const db = memoryDb();
    feed(db, sid(5), 0, [meta(T0), page(T0 + 5, 1, "/"), click(T0 + 10, 1, "#a")], { meta: { user_id: h } });
    expect(ids(searchSessions(db, { ...ALL, user_ids: ["u_42", h], sort: "recent", limit: 5 }))).toEqual([sid(5)]);
  });
});

describe("3. active time and metrics over time", () => {
  it("active time: gaps of at most 5 s between activity points, joined across chunks, per page and session", () => {
    expect(
      activitySegments([
        { ts: 0, pv: 1 },
        { ts: 1000, pv: 1 },
        { ts: 30_000, pv: 1 },
        { ts: 31_000, pv: 2 },
      ]),
    ).toEqual([
      { pv: 1, first: 0, last: 30_000, ms: 1000 + ACTIVE_GAP_MS },
      { pv: 2, first: 31_000, last: 31_000, ms: 0 },
    ]);
    const db = memoryDb();
    const s = sid(1);
    feed(db, s, 0, [meta(T0), snapshot(T0 + 1), page(T0 + 5, 1, "/"), mousemove(T0 + 1000), mousemove(T0 + 3000)]);
    // the next chunk has no afs.* event first: its activity belongs to the current page (pv 1)
    feed(db, s, 1, [
      mousemove(T0 + 4000),
      mousemove(T0 + 60_000),
      page(T0 + 61_000, 2, "/b"),
      mousemove(T0 + 62_000),
      mousemove(T0 + 63_000),
    ]);
    const pages = db.all("SELECT pv, active_ms FROM pages WHERE session_id = ? ORDER BY pv", [s]);
    expect(pages.map((p) => [p.pv, p.active_ms])).toEqual([
      [1, 2000 + 1000 + ACTIVE_GAP_MS],
      [2, 1000],
    ]);
    expect(db.all("SELECT active_ms FROM sessions WHERE id = ?", [s])[0]!.active_ms).toBe(2000 + 1000 + ACTIVE_GAP_MS + 1000);
    expect(ids(searchSessions(db, { ...ALL, min_active_ms: 9000, sort: "recent", limit: 5 }))).toEqual([s]);
    expect(ids(searchSessions(db, { ...ALL, min_active_ms: 10_000, sort: "recent", limit: 5 }))).toEqual([]);
  });

  it("metrics: buckets with zeros, shares, median scroll, breakdowns per session dimension, tag and page", () => {
    const db = memoryDb();
    const day = 86_400_000;
    feed(
      db,
      sid(1),
      0,
      [
        meta(T0),
        page(T0 + 5, 1, "/a"),
        tag(T0 + 6, 1, "plan", "pro"),
        click(T0 + 10, 1, "#x"),
        click(T0 + 20, 1, "#x"),
        click(T0 + 30, 1, "#x"),
      ],
      {
        now: T0 + 60_000,
      },
    );
    feed(db, sid(2), 0, [meta(T0 + 2 * day), page(T0 + 2 * day + 5, 1, "/b"), scroll(T0 + 2 * day + 50, 1, 2100)], {
      meta: { device: "mobile" },
      now: T0 + 2 * day + 60_000,
    });
    const start = Math.floor(T0 / day) * day;
    // biome-ignore lint: test reads loosely typed JSON
    const r = metrics(db, { start, end: start + 3 * day - 1, interval: "day", limit: 10 }) as { series: any[]; totals: any };
    expect(r.series.map((b) => [b.start, b.sessions])).toEqual([
      [start, 1],
      [start + day, 0],
      [start + 2 * day, 1],
    ]);
    expect(r.totals).toMatchObject({ sessions: 2, pageviews: 2 });
    expect((r.series[0] as { share_with: { rage_click: number } }).share_with.rage_click).toBe(1);
    expect((r.series[2] as { median_scroll_pct: number }).median_scroll_pct).toBe(100);
    const by = (b: MetricsBy) =>
      (
        metrics(db, { start, end: start + 3 * day - 1, interval: "day", limit: 10, by: b }) as unknown as {
          breakdown: { value: string | null; sessions?: number; pageviews?: number; series: { sessions?: number; pageviews?: number }[] }[];
        }
      ).breakdown;
    expect(by({ kind: "session", col: "device" }).map((x) => [x.value, x.sessions])).toEqual([
      ["desktop", 1],
      ["mobile", 1],
    ]);
    expect(by({ kind: "tag", key: "plan" }).map((x) => [x.value, x.sessions, x.series.map((b) => b.sessions)])).toEqual([
      ["pro", 1, [1, 0, 0]],
    ]);
    expect(by({ kind: "page" }).map((x) => [x.value, x.pageviews])).toEqual([
      ["/a", 1],
      ["/b", 1],
    ]);
    expect(bucketStart(Date.UTC(2026, 10, 4, 15), "week")).toBe(Date.UTC(2026, 10, 2)); // a Monday
  });
});

describe("4. failed network requests", () => {
  it("the recorder's URL rule: path only on the same host, origin + path elsewhere, no query, ids masked, own requests skipped", () => {
    const page = "https://shop.test/checkout?x=1";
    expect(requestUrl("/api/orders/12345?token=abc", page, "https://replay.test")).toBe("/api/orders/:id");
    expect(requestUrl("https://api.other.test/v1/users/jane@x.test#f", page, "https://replay.test")).toBe(
      "https://api.other.test/v1/users/:id",
    );
    expect(requestUrl("https://replay.test/i?s=1", page, "https://replay.test")).toBeNull();
    expect(requestUrl("data:text/plain,hi", page, "")).toBeNull();
  });

  it("derives afs.net (failures only), stores it, links the click before it, counts api_error and scores it", () => {
    const d = deriveChunk(
      envelope(sid(1), 0, [
        net(T0, 1, "post", "/api/pay?card=4111", 500),
        net(T0 + 1, 1, "GET", "/ok", 200),
        net(T0 + 2, 1, "GET", "https://cdn.test/x.js", 0),
      ]),
      { minTs: T0 - 1000, maxTs: T0 + 10_000 },
    );
    expect(d.nets.map((n) => [n.method, n.url, n.status])).toEqual([
      ["POST", "/api/pay", 500],
      ["GET", "https://cdn.test/x.js", 0],
    ]);
    expect(d.invalid).toBe(1);
    const db = memoryDb();
    const s = sid(2);
    feed(db, s, 0, [
      meta(T0),
      snapshot(T0 + 1),
      page(T0 + 5, 1, "/checkout"),
      click(T0 + 1000, 1, "#pay", { l: "Pay" }),
      mutation(T0 + 1100),
      net(T0 + 1400, 1, "POST", "/api/pay", 502, 380),
    ]);
    const row = db.all("SELECT api_errors, error_clicks, frustration FROM sessions WHERE id = ?", [s])[0]!;
    expect(row).toMatchObject({ api_errors: 1, error_clicks: 0, frustration: 6 });
    const ev = db.all("SELECT selector, label, error_click FROM events WHERE kind = 'net'")[0]!;
    expect(ev).toMatchObject({ selector: "#pay", label: "Pay", error_click: 1 });
    expect(ids(searchSessions(db, { ...ALL, signal: "api_error", sort: "recent", limit: 5 }))).toEqual([s]);
    const errs = listErrors(db, { ...ALL, limit: 10, kind: "net" });
    expect(errs.errors[0]).toMatchObject({
      kind: "network",
      request: { method: "POST", url: "/api/pay", status: 502, avg_ms: 380 },
      after_click: 1,
    });
    expect(listErrors(db, { ...ALL, limit: 10 }).groups).toBe(0);
    const t = transcriptData(db, s, { maxEvents: 100 })!;
    const lines = buildTimeline(t.session, t.pages, t.events, t.tags).map(entryLine);
    expect(lines.find((l) => l.includes("request failed"))).toMatch(
      /request failed POST "\/api\/pay" -> 502 \(380ms\) after click on \{"#pay"\}  \[API-ERROR\]/,
    );
    const sum = summarizeSessions(db, { ...ALL, session_ids: [s], sort: "recent", limit: 10, top: 5 });
    expect("findings" in sum && sum.findings.some((f) => f.includes('"/api/pay" fail (502)'))).toBe(true);
  });

  it("console.warn is stored apart from JS errors", () => {
    const db = memoryDb();
    feed(db, sid(3), 0, [meta(T0), page(T0 + 5, 1, "/"), error(T0 + 10, 1, "deprecated API", { k: "warn" })]);
    expect(db.all("SELECT errors FROM sessions")[0]!.errors).toBe(0);
    expect(listErrors(db, { ...ALL, limit: 5, kind: "warn" }).errors[0]).toMatchObject({ kind: "console_warn", message: "deprecated API" });
  });
});

describe("6. heatmap bundle", () => {
  it("first / last click per pageview, sort by signal, conversion share per element", () => {
    const db = memoryDb();
    const a = sid(1);
    const b = sid(2);
    feed(db, a, 0, [
      meta(T0),
      page(T0 + 5, 1, "/p"),
      click(T0 + 100, 1, "#hero"),
      mutation(T0 + 150),
      click(T0 + 3000, 1, "#buy"),
      mutation(T0 + 3050),
      event(T0 + 5000, 1, "purchase"),
    ]);
    feed(db, b, 0, [meta(T0), page(T0 + 5, 1, "/p"), click(T0 + 200, 1, "#buy"), click(T0 + 400, 1, "#buy"), click(T0 + 600, 1, "#buy")]);
    const h = (o: Partial<Parameters<typeof heatmap>[1]> = {}) =>
      heatmap(db, { start: 0, end: Number.MAX_SAFE_INTEGER, page: "/p", limit: 10, ...o });
    expect(h({ click: "first" }).elements.map((e) => [e.selector, e.clicks])).toEqual([
      ["#buy", 1],
      ["#hero", 1],
    ]);
    expect(h({ click: "last" }).elements.map((e) => [e.selector, e.clicks])).toEqual([["#buy", 2]]);
    expect(h({ sort: "rage" }).elements[0]).toMatchObject({ selector: "#buy", rage_clicks: 3 });
    const conv = h({ converted_event: "purchase" }).elements;
    expect(conv.find((e) => e.selector === "#buy")).toMatchObject({ converted_sessions: 1, conversion_share: 0.5 });
    expect(conv.find((e) => e.selector === "#hero")).toMatchObject({ converted_sessions: 1, conversion_share: 1 });
  });
});

describe("7. notes, labels, stars, clips", () => {
  it("starred sessions outlive retention up to their own cutoff; notes and labels go with the session", () => {
    const db = memoryDb();
    const old = sid(1);
    const keep = sid(2);
    feed(db, old, 0, [meta(T0), page(T0 + 5, 1, "/")]);
    feed(db, keep, 0, [meta(T0), page(T0 + 5, 1, "/")]);
    expect(
      annotate(db, {
        session_id: keep,
        starred: true,
        labels: ["bug", "checkout"],
        max_starred: 1,
        labels_per_session: 5,
        max_labels: 10,
        now: NOW,
      }),
    ).toMatchObject({
      ok: true,
      starred: true,
      labels: ["bug", "checkout"],
    });
    expect(annotate(db, { session_id: old, starred: true, max_starred: 1, labels_per_session: 5, max_labels: 10, now: NOW })).toEqual({
      ok: false,
      reason: "starred_limit",
    });
    expect(
      annotate(db, { session_id: old, labels: ["a", "b", "c"], max_starred: 1, labels_per_session: 5, max_labels: 3, now: NOW }),
    ).toEqual({ ok: false, reason: "site_labels_limit" });
    expect(
      addNote(db, { id: "note_1", session_id: keep, t_ms: 1500, text: "Pay button dead", now: NOW, per_session: 1, per_site: null }),
    ).toMatchObject({ ok: true });
    expect(addNote(db, { id: "note_2", session_id: keep, t_ms: 1, text: "x", now: NOW, per_session: 1, per_site: null })).toEqual({
      ok: false,
      reason: "session_limit",
    });
    const q = (f: object) => ids(searchSessions(db, { ...ALL, sort: "recent", limit: 5, ...f }));
    expect(q({ starred: true })).toEqual([keep]);
    expect(q({ label: "bug" })).toEqual([keep]);
    expect(q({ label: "!bug" })).toEqual([old]);
    const t = transcriptData(db, keep, { maxEvents: 50 })!;
    expect(buildTimeline(t.session, t.pages, t.events, t.tags, t.notes).map(entryLine)).toContain('[00:01.5] note "Pay button dead"');
    // retention: the plain session goes, the starred one stays until the starred cutoff
    const r = purgeRound(db, { now: NOW, cutoff: NOW + 1, heat_cutoff: null, starred_cutoff: T0 - 1 });
    expect(r.deleted).toEqual([old]);
    expect(purgeRound(db, { now: NOW, cutoff: NOW + 1, heat_cutoff: null, starred_cutoff: NOW + 1 }).deleted).toEqual([keep]);
    expect(db.all("SELECT COUNT(*) AS n FROM notes")[0]!.n).toBe(0);
    expect(db.all("SELECT COUNT(*) AS n FROM session_labels")[0]!.n).toBe(0);
  });

  it("a clip serves the chunks of its window from the last full snapshot before it", () => {
    const db = memoryDb();
    const s = sid(3);
    feed(db, s, 0, [meta(T0), snapshot(T0 + 1), page(T0 + 5, 1, "/")]);
    feed(db, s, 1, [mousemove(T0 + 10_000)]);
    feed(db, s, 2, [snapshot(T0 + 20_000), mousemove(T0 + 20_500)]);
    feed(db, s, 3, [mousemove(T0 + 30_000)]);
    feed(db, s, 4, [mousemove(T0 + 40_000)]);
    expect(playableChunks(db, s, 100)).toEqual([0, 1, 2, 3, 4]);
    expect(playableChunks(db, s, 100, { start: T0 + 25_000, end: T0 + 32_000 })).toEqual([2, 3]);
    expect(playableChunks(db, s, 100, { start: T0 + 12_000, end: T0 + 15_000 })).toEqual([0, 1]);
    const q = { link_id: "l", session_id: s, now: NOW, budget: null, window: { start: T0 + 25_000, end: T0 + 32_000 } };
    expect(linkChunk(db, { ...q, seq: 4 })).toEqual({ ok: false, reason: "not_found" });
    expect(linkChunk(db, { ...q, seq: 3 })).toMatchObject({ ok: true });
  });
});

describe("8. consent and exclusion", () => {
  it("CIDRs: IPv4, IPv6, mapped IPv4, bare addresses; junk refused", () => {
    const r = ["203.0.113.0/24", "2001:db8::/32", "198.51.100.7"].map((x) => parseCidr(x)!);
    expect(ipInRanges("203.0.113.200", r)).toBe(true);
    expect(ipInRanges("203.0.114.1", r)).toBe(false);
    expect(ipInRanges("2001:db8:abcd::1", r)).toBe(true);
    expect(ipInRanges("2001:db9::1", r)).toBe(false);
    expect(ipInRanges("::ffff:203.0.113.9", r)).toBe(true);
    expect(ipInRanges("198.51.100.7", r)).toBe(true);
    expect(ipInRanges("198.51.100.8", r)).toBe(false);
    expect(ipInRanges(null, r)).toBe(false);
    for (const bad of ["300.1.1.1", "1.2.3.4/33", "2001:db8::/129", "nope", "1.2.3/8", "::1::2"]) expect(parseCidr(bad)).toBeNull();
    expect(parseCidr("0.0.0.0/0")).toMatchObject({ bits: 0 });
  });

  it("consent by region: the EEA, UK and CH (and unknown countries) wait for consent", () => {
    for (const c of ["DE", "FR", "GB", "CH", "NO", "IS", null, "XX", "T1"]) expect(consentRequiredIn(c)).toBe(true);
    for (const c of ["US", "IN", "BR", "JP"]) expect(consentRequiredIn(c)).toBe(false);
  });

  it("upgraded sessions have their own daily cap and are filterable", () => {
    const db = memoryDb();
    const limits = { upgraded_daily: 1 };
    expect(feed(db, sid(1), 0, [meta(T0), page(T0 + 5, 1, "/")], { meta: { upgraded: "checkout_error" }, limits })).toMatchObject({
      status: "accepted",
    });
    expect(feed(db, sid(2), 0, [meta(T0), page(T0 + 5, 1, "/")], { meta: { upgraded: "vip" }, limits })).toMatchObject({
      status: "rejected",
      reason: "upgraded_daily_limit",
    });
    expect(feed(db, sid(3), 0, [meta(T0), page(T0 + 5, 1, "/")], { limits })).toMatchObject({ status: "accepted" });
    expect(ids(searchSessions(db, { ...ALL, upgraded: true, sort: "recent", limit: 5 }))).toEqual([sid(1)]);
    expect(ids(searchSessions(db, { ...ALL, upgraded: false, sort: "recent", limit: 5 }))).toEqual([sid(3)]);
  });
});

describe("9. webhook sources in the engine", () => {
  it("new error groups once, segment hits once, signal spikes against the 7-day hourly average with a quiet time", () => {
    const db = memoryDb();
    const r1 = feed(db, sid(1), 0, [
      meta(T0),
      page(T0 + 5, 1, "/"),
      error(T0 + 10, 1, "TypeError: x"),
      net(T0 + 20, 1, "GET", "/api", 500),
    ]);
    expect(r1.status === "accepted" && r1.new_errors?.map((e) => e.kind)).toEqual(["js", "network"]);
    const r2 = feed(db, sid(2), 0, [meta(T0), page(T0 + 5, 1, "/"), error(T0 + 10, 1, "TypeError: x")]);
    expect(r2.status === "accepted" && r2.new_errors).toBeUndefined();
    expect(segmentHit(db, "seg_1", sid(1), NOW)).toBe(true);
    expect(segmentHit(db, "seg_1", sid(1), NOW)).toBe(false);
    // 6 sessions with rage clicks in the last hour, none in the week before
    const now = T0 + 30 * 60_000;
    for (let i = 10; i < 16; i++)
      feed(db, sid(i), 0, [
        meta(T0 + i),
        page(T0 + i + 5, 1, "/"),
        click(T0 + i + 100, 1, "#b"),
        click(T0 + i + 200, 1, "#b"),
        click(T0 + i + 300, 1, "#b"),
      ]);
    // (dead clicks too: nothing reacted to those clicks)
    expect(signalSpikes(db, now)).toContainEqual({ signal: "rage_click", sessions_last_hour: 6, baseline_per_hour: 0 });
    expect(signalSpikes(db, now + 60_000)).toEqual([]); // quiet for 6 h
  });
});

describe("10. event definitions after the fact, funnel time to convert", () => {
  it("clicks and page visits match a definition in filters and funnels; built-ins from link targets", () => {
    const db = memoryDb();
    const a = sid(1);
    feed(db, a, 0, [
      meta(T0),
      page(T0 + 5, 1, "/pricing"),
      click(T0 + 1000, 1, "#plans button.cta", { l: "Start trial" }),
      click(T0 + 2000, 1, "a.docs", { h: "/files/guide.PDF" }),
      click(T0 + 3000, 1, "a.out", { h: "https://partner.test/x" }),
      page(T0 + 7000, 2, "/thanks"),
    ]);
    feed(db, sid(2), 0, [meta(T0), page(T0 + 5, 1, "/pricing")]);
    const q = (m: EventMatch, ev = "x") => ids(searchSessions(db, { ...ALL, event: ev, event_match: m, sort: "recent", limit: 5 }));
    expect(q({ click: { selector_contains: "button.cta" } })).toEqual([a]);
    expect(q({ click: { label: "Start trial" }, page: "/pricing" })).toEqual([a]);
    expect(q({ click: { label: "Start trial" }, page: "/other" })).toEqual([]);
    expect(q({ page: "/thanks" })).toEqual([a]);
    expect(q({ page: "/thanks" }, "!x")).toEqual([sid(2)]);
    expect(q(BUILTIN_EVENTS.download!.match)).toEqual([a]);
    expect(q(BUILTIN_EVENTS.outbound_click!.match)).toEqual([a]);
    const f = funnelDropoffs(db, {
      ...ALL,
      steps: [
        { type: "page", pattern: "/pricing" },
        { type: "event", name: "trial", match: { click: { selector_contains: "button.cta" } } },
        { type: "page", pattern: "/thanks" },
      ],
      limit: 10,
      max_sessions: 100,
    });
    expect(f.steps.map((x) => [x.sessions, x.median_ms_from_previous])).toEqual([
      [2, null],
      [1, 1000 - 5],
      [1, 6000],
    ]);
  });
});

describe("11. attention map and zones", () => {
  it("attention: each band's time in view from held positions, capped per position", () => {
    // a 1000 px page, 200 px viewport: 0-200 for 2 s, then 800-1000 until 'until' (+1 s)
    expect(
      attentionAdd(
        [],
        [
          [0, 0],
          [2000, 800],
        ],
        200,
        1000,
        3000,
      ),
    ).toEqual([2000, 2000, 0, 0, 0, 0, 0, 0, 1000, 1000]);
    expect(attentionAdd([], [[0, 0]], 200, 1000, 120_000)).toEqual([30_000, 30_000, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(attentionAdd([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [], 200, 1000, 5)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("is kept per page across chunks and read back as bands with clicks; clicks are grouped by zone", () => {
    const db = memoryDb();
    const s = sid(1);
    // dh 3000, vh 900 (fixture defaults)
    feed(db, s, 0, [meta(T0), page(T0, 1, "/p"), click(T0 + 1000, 1, "#a", { z: "#hero", y: 100 }), mousemove(T0 + 3000)]);
    feed(db, s, 1, [scroll(T0 + 4000, 1, 2100), click(T0 + 5000, 1, "#b", { y: 2500, z: "footer" }), mousemove(T0 + 6000)]);
    const att = JSON.parse(String(db.all("SELECT attention FROM pages WHERE session_id = ?", [s])[0]!.attention)) as number[];
    // 0..900 px in view 4 s (load until the scroll), 2100..3000 for 2 s
    expect(att[0]).toBe(4000);
    expect(att[9]).toBe(2000);
    const h = heatmap(db, { start: 0, end: Number.MAX_SAFE_INTEGER, page: "/p", limit: 10 });
    expect(h.attention[0]).toMatchObject({ from_pct: 0, to_pct: 10, avg_visible_ms: 4000, clicks: 1 });
    expect(h.attention[8]).toMatchObject({ clicks: 1 });
    expect(h.zones.map((z) => [z.zone, z.clicks])).toEqual([
      ["#hero", 1],
      ["footer", 1],
    ]);
    // the rollup keeps attention and click bands after the rows are gone
    rollup(db, NOW + 3 * 86_400_000);
    const day = db.all("SELECT attention, click_bands FROM scroll_daily")[0]!;
    expect(JSON.parse(String(day.attention))[0]).toBe(4000);
    expect(JSON.parse(String(day.click_bands))[8]).toBe(1);
    expect(db.all("SELECT zone FROM heat_daily ORDER BY selector").map((r) => r.zone)).toEqual(["#hero", "footer"]);
  });
});

export { NOW };
