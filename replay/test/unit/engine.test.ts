import { describe, expect, it } from "vitest";
import { chunkKey, deleteSessions, purge, rollup, summary } from "../../src/do/engine";
import { funnelDropoffs, heatmap, listErrors, searchSessions, summarizeSessions } from "../../src/do/queries";
import type { EventRow, PageRow, SessionRow } from "../../src/lib/rows";
import { click, error, event, hide, input, meta, mousemove, mutation, page, scroll, snapshot, T0 } from "../fixtures/rrweb";
import { feed, NOW, sid } from "./engine-helpers";
import { memoryDb } from "./sqlite";

const session = (db: ReturnType<typeof memoryDb>, id: string) =>
  db.all("SELECT * FROM sessions WHERE id = ?", [id])[0] as unknown as SessionRow;
const clicks = (db: ReturnType<typeof memoryDb>, id: string) =>
  db.all("SELECT * FROM events WHERE session_id = ? AND kind = 'click' ORDER BY ts", [id]) as unknown as EventRow[];
const ALL = { start: 0, end: Number.MAX_SAFE_INTEGER };

describe("ingest: one session", () => {
  it("stores pages, events and counters, and scores frustration", () => {
    const db = memoryDb();
    const s = sid(1);
    const r = feed(db, s, 0, [
      meta(T0),
      snapshot(T0 + 1),
      page(T0 + 10, 1, "/pricing"),
      click(T0 + 2000, 1, "#plans button.cta", { l: "Start trial" }),
      mutation(T0 + 2100),
      page(T0 + 2200, 2, "/signup", { nav: "push", r: "/pricing" }),
      input(T0 + 4000, 2, "#email"),
      click(T0 + 6000, 2, "#submit"),
      click(T0 + 6300, 2, "#submit"),
      click(T0 + 6600, 2, "#submit"),
      error(T0 + 6700, 2, "TypeError: cannot submit"),
      mousemove(T0 + 9000),
    ]);
    expect(r).toMatchObject({ status: "accepted", new_session: true, forward: [] });
    const row = session(db, s);
    expect(row).toMatchObject({
      started_at: T0,
      last_at: T0 + 9000,
      duration_ms: 9000,
      entry_path: "/pricing",
      exit_path: "/signup",
      pageviews: 2,
      clicks: 4,
      inputs: 1,
      errors: 1,
      rage_clicks: 1,
      error_clicks: 1,
      device: "desktop",
      country: "DE",
      viewport_w: 1440,
    });
    // three dead rage clicks on an interactive element, one error click, one error
    expect(row.dead_clicks).toBe(3);
    expect(row.dead_interactive).toBe(3);
    expect(row.frustration).toBe(25 + 20 + 30 + 8);
    const pages = db.all("SELECT * FROM pages WHERE session_id = ? ORDER BY pv", [s]) as unknown as PageRow[];
    expect(pages.map((p) => [p.path, p.left_at])).toEqual([
      ["/pricing", T0 + 2200],
      ["/signup", T0 + 9000],
    ]);
    const err = db.all("SELECT * FROM events WHERE kind = 'error'")[0] as unknown as EventRow;
    expect(err).toMatchObject({ error_click: 1, selector: "#submit", path: "/signup" });
    expect(clicks(db, s).map((c) => [c.selector, c.rage, c.rage_start, c.dead])).toEqual([
      ["#plans button.cta", 0, 0, 0],
      ["#submit", 1, 1, 1],
      ["#submit", 1, 0, 1],
      ["#submit", 1, 0, 1],
    ]);
  });

  it("a duplicate seq is a no-op", () => {
    const db = memoryDb();
    const ev = [page(T0, 1, "/"), click(T0 + 100, 1, "#a")];
    feed(db, sid(2), 0, ev);
    expect(feed(db, sid(2), 0, ev)).toEqual({ status: "duplicate" });
    expect(session(db, sid(2)).clicks).toBe(1);
    expect(session(db, sid(2)).chunks).toBe(1);
  });

  it("a session keeps the clock correction of its first chunk, so chunks stay in order", () => {
    const db = memoryDb();
    const s = sid(4);
    feed(db, s, 0, [page(T0, 1, "/a")], { skew: 120_000 });
    feed(db, s, 1, [page(T0 + 3000, 2, "/b")], { skew: 111_000 });
    const pages = db.all("SELECT pv, ts FROM pages WHERE session_id = ? ORDER BY pv", [s]);
    expect(pages).toEqual([
      { pv: 1, ts: T0 + 120_000 },
      { pv: 2, ts: T0 + 123_000 },
    ]);
    expect(session(db, s)).toMatchObject({ skew_ms: 120_000, started_at: T0 + 120_000 });
  });

  it("events that arrive before their page learn its path when it comes", () => {
    const db = memoryDb();
    feed(db, sid(3), 0, [meta(T0), snapshot(T0), page(T0 + 10, 1, "/")]);
    feed(db, sid(3), 2, [click(T0 + 1500, 2, "#early"), scroll(T0 + 1600, 2, 900)]);
    expect(clicks(db, sid(3))[0]!.path).toBeNull();
    feed(db, sid(3), 1, [page(T0 + 1010, 2, "/landing")]);
    expect(clicks(db, sid(3))[0]!.path).toBe("/landing");
    const p = db.all("SELECT path, max_scroll FROM pages WHERE session_id = ? AND pv = 2", [sid(3)]);
    expect(p).toEqual([{ path: "/landing", max_scroll: 60 }]);
  });

  it("a new session starts with the chunk that names its page; one that overtakes it is refused without stopping", () => {
    const db = memoryDb();
    expect(feed(db, sid(4), 1, [click(T0 + 500, 1, "#early")])).toEqual({ status: "rejected", reason: "page_host_required", stop: false });
    expect(feed(db, sid(4), 0, [page(T0, 1, "/")]).status).toBe("accepted");
  });
});

describe("ingest: signals across chunk boundaries", () => {
  it("an open click is resolved by the next chunk's first second (in order)", () => {
    const db = memoryDb();
    const s = sid(10);
    feed(db, s, 0, [page(T0, 1, "/"), click(T0 + 4800, 1, "#menu")], { t: T0 + 5000 });
    expect(clicks(db, s)[0]).toMatchObject({ dead: 1, open: 1 });
    feed(db, s, 1, [mutation(T0 + 5300), mousemove(T0 + 9000)]);
    expect(clicks(db, s)[0]).toMatchObject({ dead: 0, open: 0 });
    expect(session(db, s).dead_clicks).toBe(0);
  });

  it("... and when the later chunk arrives first", () => {
    const db = memoryDb();
    const s = sid(11);
    feed(db, s, 0, [page(T0, 1, "/")], { t: T0 + 100 });
    feed(db, s, 2, [mutation(T0 + 5300), mousemove(T0 + 9000)]);
    feed(db, s, 1, [click(T0 + 4800, 1, "#menu")], { t: T0 + 5000 });
    expect(clicks(db, s)[0]).toMatchObject({ dead: 0, open: 0 });
  });

  it("stays dead (and closed) when the contiguous next chunk shows no effect", () => {
    const db = memoryDb();
    const s = sid(12);
    feed(db, s, 0, [page(T0, 1, "/"), click(T0 + 4800, 1, "#broken")], { t: T0 + 5000 });
    feed(db, s, 1, [mousemove(T0 + 6500), mutation(T0 + 9000)]);
    expect(clicks(db, s)[0]).toMatchObject({ dead: 1, open: 0 });
    expect(session(db, s)).toMatchObject({ dead_clicks: 1, dead_interactive: 1 });
  });

  it("a navigation in the next chunk counts as an effect", () => {
    const db = memoryDb();
    const s = sid(13);
    feed(db, s, 0, [page(T0, 1, "/"), click(T0 + 4900, 1, "a.next", { tg: "a" })], { t: T0 + 5000 });
    feed(db, s, 1, [page(T0 + 5400, 2, "/next", { nav: "push" })]);
    expect(clicks(db, s)[0]!.dead).toBe(0);
  });

  it("a rage burst split over two chunks is one burst", () => {
    const db = memoryDb();
    const s = sid(14);
    feed(db, s, 0, [page(T0, 1, "/"), click(T0 + 4700, 1, "#pay"), click(T0 + 4900, 1, "#pay")], { t: T0 + 5000 });
    expect(session(db, s).rage_clicks).toBe(0);
    feed(db, s, 1, [click(T0 + 5100, 1, "#pay"), click(T0 + 5300, 1, "#pay")]);
    expect(clicks(db, s).map((c) => [c.rage, c.rage_start])).toEqual([
      [1, 1],
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    expect(session(db, s).rage_clicks).toBe(1);
  });

  it("an error in the next chunk makes the last click an error click", () => {
    const db = memoryDb();
    const s = sid(15);
    feed(db, s, 0, [page(T0, 1, "/checkout"), click(T0 + 4900, 1, "#pay", { l: "***" })], { t: T0 + 5000 });
    feed(db, s, 1, [error(T0 + 5200, 1, "Error: payment failed")]);
    expect(clicks(db, s)[0]!.error_click).toBe(1);
    expect(db.all("SELECT selector, label, error_click FROM events WHERE kind = 'error'")).toEqual([
      { selector: "#pay", label: "***", error_click: 1 },
    ]);
    expect(session(db, s).error_clicks).toBe(1);
  });

  it("quick backs and excessive scrolling across chunks", () => {
    const db = memoryDb();
    const s = sid(16);
    feed(db, s, 0, [page(T0, 1, "/pricing"), page(T0 + 20_000, 2, "/enterprise", { nav: "push" })]);
    feed(db, s, 1, [page(T0 + 23_000, 3, "/pricing", { nav: "pop" })]);
    const ys = [0, 900, 1800, 2100, 1200, 300, 1500, 2100, 900, 0, 1800];
    feed(
      db,
      s,
      2,
      ys.slice(0, 6).map((y, i) => scroll(T0 + 24_000 + i * 300, 3, y)),
    );
    expect(session(db, s).excessive_scrolls).toBe(0);
    feed(
      db,
      s,
      3,
      ys.slice(6).map((y, i) => scroll(T0 + 26_000 + i * 300, 3, y)),
    );
    const pages = db.all("SELECT pv, quick_back, excessive_scroll, reversals FROM pages WHERE session_id = ? ORDER BY pv", [s]);
    expect(pages).toEqual([
      { pv: 1, quick_back: 0, excessive_scroll: 0, reversals: 0 },
      { pv: 2, quick_back: 1, excessive_scroll: 0, reversals: 0 },
      { pv: 3, quick_back: 0, excessive_scroll: 1, reversals: 4 },
    ]);
    expect(session(db, s)).toMatchObject({ quick_backs: 1, excessive_scrolls: 1 });
    // scroll milestones are recorded once per pageview
    expect(
      db
        .all("SELECT detail FROM events WHERE session_id = ? AND kind = 'scroll' AND pv = 3", [s])
        .map((r) => JSON.parse(String(r.detail)).pct),
    ).toEqual([50, 75, 100]);
  });
});

describe("ingest: limits", () => {
  it("MAX_SESSIONS_PER_SITE_PER_DAY refuses new sessions, not running ones", () => {
    const db = memoryDb();
    const lim = { limits: { daily_sessions: 2 } };
    feed(db, sid(20), 0, [page(T0, 1, "/")], lim);
    feed(db, sid(21), 0, [page(T0, 1, "/")], lim);
    expect(feed(db, sid(22), 0, [page(T0, 1, "/")], lim)).toEqual({ status: "rejected", reason: "daily_session_limit", stop: true });
    expect(feed(db, sid(21), 1, [click(T0 + 10, 1, "#a")], lim).status).toBe("accepted");
    // the count never goes down: deleting the day's sessions frees nothing
    deleteSessions(db, [sid(20), sid(21)]);
    expect(feed(db, sid(23), 0, [page(T0, 1, "/")], lim)).toMatchObject({ reason: "daily_session_limit" });
    expect(summary(db, NOW).usage_today).toMatchObject({ sessions: 2, chunks: 3 });
    // the next UTC day starts fresh
    expect(feed(db, sid(22), 0, [page(T0, 1, "/")], { ...lim, now: NOW + 86_400_000 }).status).toBe("accepted");
  });
  it("per-session bytes, duration and browser", () => {
    const db = memoryDb();
    feed(db, sid(23), 0, [page(T0, 1, "/")], { bytes: 600, limits: { session_bytes: 1000 } });
    expect(feed(db, sid(23), 1, [click(T0 + 10, 1, "#a")], { bytes: 600, limits: { session_bytes: 1000 } })).toMatchObject({
      reason: "session_bytes_limit",
      stop: true,
    });
    expect(session(db, sid(23)).limited).toBe("session_bytes_limit");
    feed(db, sid(24), 0, [page(T0, 1, "/")]);
    expect(feed(db, sid(24), 1, [click(T0 + 40 * 60_000, 1, "#a")])).toMatchObject({ reason: "max_duration" });
    expect(feed(db, sid(24), 2, [click(T0 + 1000, 1, "#a")], { meta: { ua_hash: "other" } })).toMatchObject({ reason: "session_mismatch" });
  });
});

describe("forwarding to analytics", () => {
  it("hands out settled signals once; open dead clicks wait for the next chunk or the page end", () => {
    const db = memoryDb();
    const s = sid(30);
    const first = feed(
      db,
      s,
      0,
      [
        page(T0, 1, "/checkout"),
        click(T0 + 1000, 1, "#pay"),
        click(T0 + 1200, 1, "#pay"),
        click(T0 + 1400, 1, "#pay"),
        error(T0 + 1500, 1, "Error: boom"),
        error(T0 + 1600, 1, "Error: boom"),
        click(T0 + 9500, 1, "#late"),
      ],
      { forward: true, t: T0 + 10_000 },
    );
    if (first.status !== "accepted") throw new Error("not accepted");
    // the three dead clicks are one rage burst: sent as one rage_click, not three dead_clicks
    expect(first.forward.map((f) => f.name).sort()).toEqual(["error_click", "js_error", "rage_click"]);
    expect(first.forward.find((f) => f.name === "js_error")!.props).toMatchObject({ replay_session_id: s, message: "Error: boom" });
    const second = feed(db, s, 1, [mousemove(T0 + 11_000)], { forward: true, end: true });
    if (second.status !== "accepted") throw new Error("not accepted");
    expect(second.forward.map((f) => [f.name, f.props.selector])).toEqual([["dead_click", "#late"]]);
    const third = feed(db, s, 2, [mousemove(T0 + 12_000)], { forward: true, end: true });
    expect(third.status === "accepted" && third.forward).toEqual([]);
  });
});

/** Three sessions to query over. */
function corpus() {
  const db = memoryDb();
  // 1: rage on the pay button, error, mobile, from DE
  feed(
    db,
    sid(41),
    0,
    [
      meta(T0, "https://shop.test/", 390, 800),
      page(T0, 1, "/pricing"),
      scroll(T0 + 500, 1, 1500),
      page(T0 + 5000, 2, "/checkout"),
      click(T0 + 6000, 2, "#pay", { l: "Pay", top: 70 }),
      click(T0 + 6200, 2, "#pay", { l: "Pay", top: 70 }),
      click(T0 + 6400, 2, "#pay", { l: "Pay", top: 70 }),
      error(T0 + 6500, 2, "TypeError: card is undefined"),
      event(T0 + 6600, 2, "checkout_failed"),
      mousemove(T0 + 30_000),
    ],
    { meta: { device: "mobile", user_id: "u_1" } },
  );
  // 2: calm, reaches the thank-you page
  feed(
    db,
    sid(42),
    0,
    [
      page(T0 + 60_000, 1, "/pricing"),
      page(T0 + 62_000, 2, "/checkout"),
      click(T0 + 63_000, 2, "#pay", { l: "Pay", top: 70 }),
      mutation(T0 + 63_200),
      page(T0 + 65_000, 3, "/thanks"),
      mousemove(T0 + 70_000),
    ],
    { meta: { country: "US" } },
  );
  // 3: dead click on a non-interactive heading, leaves on pricing
  feed(
    db,
    sid(43),
    0,
    [page(T0 + 120_000, 1, "/pricing"), click(T0 + 121_000, 1, "h1", { l: "Plans", tg: "h1", i: 0, top: 2 }), mousemove(T0 + 125_000)],
    {
      meta: { country: "US", analytics_visitor_id: "vid_12345678" },
    },
  );
  return db;
}

describe("queries", () => {
  it("search filters, sorts and paginates with a stable cursor", () => {
    const db = corpus();
    const q = (f: Record<string, unknown>) =>
      searchSessions(db, { ...ALL, sort: "frustration", limit: 10, ...f }).sessions.map((s) => s.id);
    expect(q({})).toEqual([sid(41), sid(43), sid(42)]);
    expect(q({ sort: "recent" })).toEqual([sid(43), sid(42), sid(41)]);
    expect(q({ page: "/check*" })).toEqual([sid(41), sid(42)]);
    expect(q({ exit_page: "/pricing" })).toEqual([sid(43)]);
    expect(q({ signal: "rage_click" })).toEqual([sid(41)]);
    expect(q({ signal: "dead_click" })).toEqual([sid(41), sid(43)]);
    expect(q({ has_error: false })).toEqual([sid(43), sid(42)]);
    expect(q({ device: "Mobile" })).toEqual([sid(41)]);
    expect(q({ country: "us" })).toEqual([sid(43), sid(42)]);
    expect(q({ min_duration_ms: 20_000 })).toEqual([sid(41)]);
    expect(q({ clicked: "#pay" })).toEqual([sid(41), sid(42)]);
    expect(q({ clicked: "Plans" })).toEqual([sid(43)]);
    expect(q({ event: "checkout_failed" })).toEqual([sid(41)]);
    expect(q({ user_id: "u_1" })).toEqual([sid(41)]);
    expect(q({ analytics_visitor_id: "vid_12345678" })).toEqual([sid(43)]);
    expect(q({ session_ids: [sid(42), sid(43)] })).toEqual([sid(43), sid(42)]);
    const p1 = searchSessions(db, { ...ALL, sort: "recent", limit: 2 });
    expect(p1.total).toBe(3);
    const cursor = JSON.parse(atob(p1.next_cursor!.replace(/-/g, "+").replace(/_/g, "/")));
    const p2 = searchSessions(db, { ...ALL, sort: "recent", limit: 2, cursor });
    expect([...p1.sessions, ...p2.sessions].map((s) => s.id)).toEqual([sid(43), sid(42), sid(41)]);
    expect(p2.next_cursor).toBeNull();
  });

  it("summarize groups patterns deterministically with example sessions and findings", () => {
    const db = corpus();
    const r = summarizeSessions(db, { ...ALL, sort: "frustration", limit: 100, top: 5 });
    if ("empty" in r) throw new Error("empty");
    expect(r.sessions_considered).toBe(3);
    expect(r.sessions_with).toMatchObject({ rage_click: 1, js_error: 1, dead_click: 2, dead_click_interactive: 1 });
    expect(r.top_rage_targets[0]).toMatchObject({
      path: "/checkout",
      selector: "#pay",
      label: "Pay",
      sessions: 1,
      bursts: 1,
      example_session_ids: [sid(41)],
    });
    expect(r.top_errors[0]).toMatchObject({ message: "TypeError: card is undefined", sessions: 1, after_click: 1 });
    expect(r.not_clickable_but_clicked[0]).toMatchObject({ selector: "h1", label: "Plans", interactive: false });
    expect(r.exit_pages[0]).toEqual({ value: "/checkout", sessions: 1 });
    expect(r.common_journeys.map((j) => j.pages)).toEqual(["/pricing", "/pricing > /checkout", "/pricing > /checkout > /thanks"]);
    expect(r.findings[0]).toBe('1 of 3 sessions (33%) rage-clicked "Pay" {#pay} on /checkout.');
    expect(summarizeSessions(db, { ...ALL, sort: "recent", limit: 10, top: 5, page: "/nope" })).toMatchObject({
      empty: true,
      sessions_considered: 0,
    });
  });

  it("heatmap: clicks per element with shares and positions, scroll reach; rollups agree with live data", () => {
    const db = corpus();
    const live = heatmap(db, { ...ALL, page: "/checkout", limit: 10 });
    expect(live.clicks).toBe(4);
    expect(live.elements[0]).toMatchObject({
      selector: "#pay",
      clicks: 4,
      sessions: 2,
      rage_clicks: 3,
      rage_share: 0.75,
      dead_clicks: 3,
      position_pct: 70,
    });
    expect(live.pageviews).toBe(2);
    const pricing = heatmap(db, { ...ALL, page: "/pricing", limit: 10 });
    expect(pricing.scroll.reach.find((r) => r.pct === 30)!.share).toBe(1); // 900/3000 seen on load by all
    expect(pricing.scroll.reach.find((r) => r.pct === 80)!.share).toBe(0.333); // one of three scrolled to 80%
    expect(pricing.elements.find((e) => e.selector === "h1")).toMatchObject({ interactive: false, reached_by_share: 1 });
    expect(heatmap(db, { ...ALL, page: "/checkout", device: "mobile", limit: 10 }).clicks).toBe(3);
    // Roll everything up, purge the raw rows: the heatmap reads the daily aggregates instead.
    const later = T0 + 10 * 86_400_000;
    expect(rollup(db, later).rolled).toContain(new Date(T0).toISOString().slice(0, 10));
    const p = purge(db, { now: later, cutoff: later, heat_cutoff: T0 - 86_400_000 });
    expect(p.deleted).toHaveLength(3);
    const rolled = heatmap(db, { start: T0 - 86_400_000, end: later, page: "/checkout", limit: 10 });
    expect(rolled.elements[0]).toMatchObject({ selector: "#pay", clicks: 4, rage_clicks: 3, dead_clicks: 3, position_pct: 70 });
    expect(rolled.pageviews).toBe(2);
    expect(rolled.rolled_up_through).not.toBeNull();
  });

  it("errors are grouped by fingerprint with the click that triggered them", () => {
    const db = corpus();
    feed(db, sid(44), 0, [page(T0 + 200_000, 1, "/checkout"), error(T0 + 200_500, 1, "TypeError: card is undefined")], {
      meta: { browser: "Firefox" },
    });
    const r = listErrors(db, { ...ALL, limit: 10 });
    expect(r).toMatchObject({ occurrences: 2, sessions_with_errors: 2, groups: 1 });
    expect(r.errors[0]).toMatchObject({
      message: "TypeError: card is undefined",
      occurrences: 2,
      sessions: 2,
      after_click: 1,
      source: "https://shop.test/assets/app.3f9a2b1c.js",
      line: 1,
      triggered_by: [{ selector: "#pay", label: "Pay", count: 1 }],
      pages: [{ value: "/checkout", count: 2 }],
    });
    expect(r.errors[0]!.browsers.map((b) => b.value).sort()).toEqual(["Chrome 131", "Firefox 131"]);
    expect(listErrors(db, { ...ALL, limit: 10, browser: "firefox" }).occurrences).toBe(1);
    expect(listErrors(db, { ...ALL, limit: 10, page: "/pricing" }).occurrences).toBe(0);
  });

  it("funnel drop-offs: steps in order within a session, and who stopped where", () => {
    const db = corpus();
    const steps = [
      { type: "page" as const, pattern: "/pricing" },
      { type: "page" as const, pattern: "/checkout" },
      { type: "page" as const, pattern: "/thanks" },
    ];
    const r = funnelDropoffs(db, { ...ALL, steps, drop_step: 2, limit: 10, max_sessions: 100 });
    expect(r.steps.map((s) => [s.sessions, s.dropped])).toEqual([
      [3, 1],
      [2, 1],
      [1, null],
    ]);
    expect(r.dropped).toEqual({ step: 2, total: 1, session_ids: [sid(41)] });
    const ev = funnelDropoffs(db, { ...ALL, steps: [steps[1]!, { type: "event", name: "checkout_failed" }], limit: 10, max_sessions: 100 });
    expect(ev.steps.map((s) => s.sessions)).toEqual([2, 1]);
  });

  it("deleting sessions returns their R2 keys; purge deletes by start time", () => {
    const db = corpus();
    feed(db, sid(41), 1, [mousemove(T0 + 31_000)]);
    const d = deleteSessions(db, [sid(41), "rs_doesnotexist0000"]);
    expect(d).toEqual({ deleted: [sid(41)], keys: [chunkKey(sid(41), 0), chunkKey(sid(41), 1)] });
    expect(chunkKey(sid(41), 1)).toBe(`${sid(41)}/000001`);
    expect(db.all("SELECT COUNT(*) AS n FROM events WHERE session_id = ?", [sid(41)])[0]!.n).toBe(0);
    const p = purge(db, { now: NOW, cutoff: T0 + 90_000, heat_cutoff: 0 });
    expect(p.deleted).toEqual([sid(42)]);
    expect(searchSessions(db, { ...ALL, sort: "recent", limit: 10 }).sessions.map((s) => s.id)).toEqual([sid(43)]);
    expect(summary(db, NOW).sessions_total).toBe(1);
  });
});
