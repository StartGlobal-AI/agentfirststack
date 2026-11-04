import { describe, expect, it } from "vitest";
import { annotate } from "../../src/do/annotations";
import { deleteSessions, dropKept, markKept, starredBytes, starredCopyDue, starredKey } from "../../src/do/engine";
import { dropPointerOver } from "../../src/lib/mask-rules";
import { secureOriginHost } from "../../src/lib/url";
import { click, error, meta, mousemove, net, page, snapshot, T0 } from "../fixtures/rrweb";
import { summary } from "../../src/do/engine";
import { deleteResponse } from "../../src/do/surveys";
import { queueTags, tagsClear, tagsDone, tagsDue, tagsExpire, tagsQueued, tagsRetry } from "../../src/do/tags-outbox";
import { NO_AD_CONSENT, surveyScores, tagsEvent, tagsSignalsOf } from "../../src/lib/tags";
import { analyticsEvents } from "../../src/service/analytics";
import { postTagsEvents } from "../../src/service/tags";
import { feed, NOW, sid } from "./engine-helpers";
import { memoryDb } from "./sqlite";

describe("wave 2, 1: residuals", () => {
  it("browser uploads need an https Origin (http only for localhost in dev)", () => {
    expect(secureOriginHost("https://shop.test", false)).toBe("shop.test");
    expect(secureOriginHost("http://shop.test", false)).toBeNull();
    expect(secureOriginHost("http://shop.test", true)).toBeNull();
    expect(secureOriginHost("http://localhost:3000", true)).toBe("localhost");
    expect(secureOriginHost("http://localhost:3000", false)).toBeNull();
    expect(secureOriginHost("null", true)).toBeNull();
    expect(secureOriginHost("javascript:alert(1)", true)).toBeNull();
  });

  it("pointer positions over the survey host are dropped; an interaction on it drops the event", () => {
    const over = (id: number) => id === 7;
    const move = {
      source: 1,
      positions: [
        { x: 1, y: 1, id: 3 },
        { x: 2, y: 2, id: 7 },
      ],
    };
    expect(dropPointerOver(move, over)).toBe(true);
    expect(move.positions).toEqual([{ x: 1, y: 1, id: 3 }]);
    expect(dropPointerOver({ positions: [{ id: 7 }] }, over)).toBe(false);
    expect(dropPointerOver({ source: 2, id: 7, type: 2, x: 5, y: 5 } as never, over)).toBe(false);
    expect(dropPointerOver({ source: 2, id: 3 } as never, over)).toBe(true);
  });

  it("starred sessions' chunks are copied once, counted, and queued for deletion when unstarred or deleted", () => {
    const db = memoryDb();
    const s = sid(1);
    feed(db, s, 0, [meta(T0), snapshot(T0 + 1), page(T0 + 5, 1, "/")], { bytes: 300 });
    feed(db, s, 1, [mousemove(T0 + 1000)], { bytes: 200 });
    expect(starredCopyDue(db)).toEqual([]);
    const r = annotate(db, {
      session_id: s,
      starred: true,
      max_starred: 10,
      labels_per_session: 5,
      max_labels: 10,
      now: NOW,
      max_starred_bytes: 1000,
    });
    expect(r).toMatchObject({ ok: true, starred: true, was_starred: false });
    expect(starredCopyDue(db).map((c) => [c.seq, c.bytes])).toEqual([
      [0, 300],
      [1, 200],
    ]);
    const before = Number(db.all("SELECT bytes FROM daily")[0]!.bytes);
    markKept(db, s, 0, 1, 300, NOW);
    markKept(db, s, 1, 0, 0, NOW); // the original was gone
    expect(starredCopyDue(db)).toEqual([]);
    expect(starredBytes(db)).toBe(300);
    expect(Number(db.all("SELECT bytes FROM daily")[0]!.bytes)).toBe(before + 300);
    // a second session can't be starred past the byte cap
    const t = sid(2);
    feed(db, t, 0, [meta(T0), page(T0 + 5, 1, "/")], { bytes: 900 });
    expect(
      annotate(db, {
        session_id: t,
        starred: true,
        max_starred: 10,
        labels_per_session: 5,
        max_labels: 10,
        now: NOW,
        max_starred_bytes: 1000,
      }),
    ).toEqual({
      ok: false,
      reason: "starred_bytes_limit",
    });
    expect(starredKey("rsite_x/", s, 0)).toBe(`starred/rsite_x/${s}/000000`);
    expect(dropKept(db, s, "rsite_x/", NOW)).toBe(1);
    expect(db.all("SELECT key FROM r2_pending").map((x) => x.key)).toEqual([`starred/rsite_x/${s}/000000`]);
    // deleting a session that has copies queues them with its originals
    markKept(db, s, 0, 1, 300, NOW);
    db.run("DELETE FROM r2_pending");
    deleteSessions(db, [s], { prefix: "rsite_x/" });
    expect(db.all("SELECT key FROM r2_pending ORDER BY key").map((x) => x.key)).toEqual([
      `rsite_x/${s}/000000`,
      `rsite_x/${s}/000001`,
      `starred/rsite_x/${s}/000000`,
    ]);
  });
});

describe("wave 2, 3: replay signals to a tags container", () => {
  const TAGS = { host: "shop.test", signals: tagsSignalsOf(null), visitor_id: "vid_test.1700000000", daily: null };

  it("test traffic (a forced session, a page with analytics debug on) is queued marked and sent in batches of its own", () => {
    const db = memoryDb();
    const rage = (sel: string) => [click(T0 + 1000, 1, sel), click(T0 + 1200, 1, sel), click(T0 + 1400, 1, sel)];
    const run = (n: number, meta: Record<string, unknown>) => {
      const r = feed(db, sid(n), 0, [page(T0, 1, "/"), ...rage(`#b${n}`)], { forward: true, tags: TAGS, end: true, meta });
      if (r.status !== "accepted") throw new Error("not accepted");
      return [r.test, r.forward.map((f) => f.name)];
    };
    expect(run(81, {})).toEqual([false, ["rage_click"]]);
    expect(run(82, { forced: true })).toEqual([true, ["rage_click"]]);
    expect(run(83, { debug: true })).toEqual([true, ["rage_click"]]);
    expect(run(84, {})).toEqual([false, ["rage_click"]]);
    // oldest first, one kind per batch; the marker stays in the outbox
    const batches: [boolean, string[]][] = [];
    for (let rows = tagsDue(db); rows.length; rows = tagsDue(db)) {
      expect(JSON.stringify(rows.map((r) => r.event))).not.toContain("_afsr_test");
      batches.push([rows[0]!.test, rows.map((r) => String(r.event.params.replay_session_id))]);
      tagsDone(
        db,
        rows.map((r) => r.id),
      );
    }
    expect(batches).toEqual([
      [false, [sid(81)]],
      [true, [sid(82), sid(83)]],
      [false, [sid(84)]],
    ]);
  });

  it("postTagsEvents sends test: true only for test batches; analyticsEvents marks them debug: true", async () => {
    const bodies: unknown[] = [];
    const env = {
      INTERNAL_TOKEN: "t",
      TAGS: { fetch: async (req: Request) => (bodies.push(await req.json()), Response.json({ accepted: 1 }, { status: 202 })) },
    } as never;
    const ev = tagsEvent({ name: "rage_click", key: "rp.x.1", ts: NOW, path: "/", params: {} }, "shop.test", null);
    await postTagsEvents(env, "acc", "ctr_00000000", [ev]);
    await postTagsEvents(env, "acc", "ctr_00000000", [ev], true);
    expect(bodies.map((b) => (b as { test?: boolean }).test)).toEqual([undefined, true]);
    const item = { name: "dead_click" as const, ts: NOW, path: "/", props: { replay_session_id: "rs_x" } };
    const v = { ip: null, user_agent: null, analytics_visitor_id: "vid_abcdefghij" };
    expect(analyticsEvents([item], "shop.test", v)[0]).not.toHaveProperty("debug");
    expect(analyticsEvents([item], "shop.test", v, true)[0]).toMatchObject({
      name: "dead_click",
      debug: true,
      visitor_id: "vid_abcdefghij",
    });
  });

  it("builds tags server events: deterministic event_id, page_url, short params, visitor or no ad consent", () => {
    const item = {
      name: "rage_click" as const,
      key: "rp.rs_0000000000000001.7",
      ts: T0,
      path: "/pay",
      params: { replay_session_id: "rs_0000000000000001", selector: "x".repeat(300), empty: null },
    };
    const withVisitor = tagsEvent(item, "shop.test", "vid_test.1700000000");
    expect(withVisitor).toEqual({
      name: "rage_click",
      event_id: "rp.rs_0000000000000001.7",
      timestamp: T0,
      page_url: "https://shop.test/pay",
      params: { source: "afs_replay", replay_session_id: "rs_0000000000000001", selector: "x".repeat(100) },
      visitor_id: "vid_test.1700000000",
      send_to: { ga4: { event_name: "rage_click" } },
    });
    expect(withVisitor).not.toHaveProperty("consent");
    const anonymous = tagsEvent({ ...item, path: null }, "shop.test", null);
    expect(anonymous.consent).toEqual(NO_AD_CONSENT);
    expect(anonymous.page_url).toBe("https://shop.test/");
    expect(anonymous).not.toHaveProperty("visitor_id");
    for (const e of [withVisitor, anonymous]) {
      expect(e.name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,39}$/); // the tags app's serverEventSchema
      expect(e.event_id).toMatch(/^[A-Za-z0-9_.:-]{6,100}$/);
      for (const k of Object.keys(e.params)) expect(k.length).toBeLessThanOrEqual(40);
      expect(e).not.toHaveProperty("ip");
      expect(e).not.toHaveProperty("user_agent");
    }
  });

  it("survey scores: NPS with its group, the first rating with its scale; text and choices never", () => {
    const qs = [
      { id: "q1", type: "nps" as const, scale: null },
      { id: "q2", type: "rating" as const, scale: { max: 5 } },
      { id: "q3", type: "long_text" as const, scale: null },
    ];
    expect(surveyScores(qs, { q1: 9, q2: 4, q3: "call me at 555" })).toEqual({
      nps_score: 9,
      nps_group: "promoter",
      rating_score: 4,
      rating_max: 5,
    });
    expect(surveyScores(qs, { q1: 6 })).toEqual({ nps_score: 6, nps_group: "detractor" });
    expect(surveyScores(qs, { q3: "text only" })).toBeNull();
    expect(surveyScores(qs, { q2: 9 })).toBeNull(); // out of the scale
  });

  it("settled signals are queued once each, apart from the analytics forwarding, within the site's tags budget", () => {
    const db = memoryDb();
    const s = sid(70);
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
        net(T0 + 1700, 1, "POST", "https://shop.test/api/pay", 500),
        net(T0 + 1800, 1, "POST", "https://shop.test/api/pay", 500),
      ],
      { forward: true, tags: TAGS, end: true },
    );
    if (first.status !== "accepted") throw new Error("not accepted");
    // analytics still gets its own copy
    expect(first.forward.map((f) => f.name).sort()).toEqual(["error_click", "js_error", "rage_click"]);
    expect(first.tags_queued).toBe(3);
    const rows = tagsDue(db);
    expect(rows.map((r) => r.event.name).sort()).toEqual(["api_error", "js_error", "rage_click"]);
    const api = rows.find((r) => r.event.name === "api_error")!.event;
    expect(api.params).toMatchObject({ request_method: "POST", status_code: 500, replay_session_id: s });
    expect(api.visitor_id).toBe("vid_test.1700000000");
    expect(new Set(rows.map((r) => r.event.event_id)).size).toBe(3);
    expect(summary(db, NOW).usage_today.tags_events).toBe(3);
    expect(summary(db, NOW).tags_forwarding.queued).toBe(3);
    // nothing twice
    const again = feed(db, s, 1, [mousemove(T0 + 3000)], { forward: true, tags: TAGS, end: true });
    expect(again.status === "accepted" && again.tags_queued).toBeFalsy();
    // chosen signals only; the budget holds
    const db2 = memoryDb();
    const only = feed(
      db2,
      sid(71),
      0,
      [page(T0, 1, "/"), click(T0 + 1000, 1, "#a"), click(T0 + 1200, 1, "#a"), click(T0 + 1400, 1, "#a"), error(T0 + 1500, 1, "Error: x")],
      {
        tags: { ...TAGS, signals: ["js_error"] },
        end: true,
      },
    );
    expect(only.status === "accepted" && only.tags_queued).toBe(1);
    expect(tagsDue(db2).map((r) => r.event.name)).toEqual(["js_error"]);
    const db3 = memoryDb();
    feed(db3, sid(72), 0, [page(T0, 1, "/"), error(T0 + 500, 1, "Error: a"), error(T0 + 600, 1, "Error: b")], {
      tags: { ...TAGS, daily: 1 },
      end: true,
    });
    expect(tagsQueued(db3)).toBe(1);
  });

  it("the outbox: retries, expiry after a day or 8 tries, privacy deletion with the session or the response", () => {
    const db = memoryDb();
    const s = sid(73);
    feed(db, s, 0, [page(T0, 1, "/"), error(T0 + 500, 1, "Error: a")], { tags: TAGS, end: true });
    const ev = tagsEvent(
      { name: "survey_response", key: "rp.rsr_0000000000000001", ts: NOW, path: "/", params: { nps_score: 9 } },
      "shop.test",
      null,
    );
    queueTags(db, { session_id: null, response_id: "rsr_0000000000000001", events: [ev], now: NOW });
    expect(tagsQueued(db)).toBe(2);
    const ids = tagsDue(db).map((r) => r.id);
    for (let i = 0; i < 8; i++) tagsRetry(db, ids.slice(0, 1));
    expect(tagsExpire(db, NOW)).toBe(1);
    expect(tagsQueued(db)).toBe(1);
    expect(tagsExpire(db, NOW + 2 * 86_400_000)).toBe(1);
    // with the session and with the response
    feed(db, sid(74), 0, [page(T0, 1, "/"), error(T0 + 500, 1, "Error: a")], { tags: TAGS, end: true });
    queueTags(db, { session_id: null, response_id: "rsr_0000000000000002", events: [ev], now: NOW });
    expect(tagsQueued(db)).toBe(2);
    deleteSessions(db, [sid(74)], {});
    expect(tagsQueued(db)).toBe(1);
    db.run(
      `INSERT INTO survey_responses (id, survey_id, version, session_id, user_id, created_at, updated_at, path, device, country, answers, answered, completed, test, element, net, bytes)
       VALUES ('rsr_0000000000000002', 'rsv_0000000000000001', 1, NULL, NULL, ?, ?, '/', 'desktop', 'DE', '{}', 1, 1, 0, NULL, 'n', 10)`,
      [NOW, NOW],
    );
    expect(deleteResponse(db, "rsv_0000000000000001", "rsr_0000000000000002")).toBe(true);
    expect(tagsQueued(db)).toBe(0);
    queueTags(db, { session_id: null, events: [ev], now: NOW });
    tagsDone(
      db,
      tagsDue(db).map((r) => r.id),
    );
    expect(tagsClear(db)).toBe(0);
  });
});

describe("wave 2, 4: heatmap images", () => {
  // A small recorded page as rrweb serializes it (already masked in the browser).
  const el = (
    tagName: string,
    attributes: Record<string, unknown> = {},
    childNodes: unknown[] = [],
    extra: Record<string, unknown> = {},
  ) => ({
    type: 2,
    tagName,
    attributes,
    childNodes,
    ...extra,
  });
  const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: 3, textContent: t, ...extra });
  const doc = {
    type: 0,
    childNodes: [
      { type: 1, name: "html" },
      el("html", { lang: "en" }, [
        el("head", {}, [
          el("link", { rel: "stylesheet", href: "/app.css", _cssText: "body{color:red}</style><script>x()</script>" }),
          el("link", { rel: "preload", href: "/x.js" }),
          el("meta", { "http-equiv": "refresh", content: "0;url=https://evil.test" }),
          el("script", { src: "/app.js" }, [text("alert(1)")]),
        ]),
        el("body", { onload: "steal()" }, [
          el("a", { href: "javascript:alert(1)", onclick: "x()" }, [text("**** ***")]),
          el("img", { src: "data:text/html,<script>", alt: "a" }),
          el("img", { src: "/logo.png", srcset: "/logo@2x.png 2x" }),
          el("div", { class: "secret", rr_width: "300px", rr_height: "120px" }),
          el("iframe", { src: "https://other.test/", width: "400", height: "200" }),
          el("noscript", {}, [text("Enable JS")]),
          el("p", {}, [text("<b>not markup</b> & more")]),
          el("my-card", {}, [el("span", {}, [text("in shadow")], { isShadow: true })], { isShadowHost: true }),
          el("svg", { viewBox: "0 0 10 10" }, [el("path", { d: "M0 0L10 10" }, [], { isSVG: true })], { isSVG: true }),
        ]),
      ]),
    ],
  };

  it("rebuilds static HTML from a snapshot: nothing that runs, blocked parts and frames as boxes, inlined CSS kept", async () => {
    const { snapshotToHtml, findSnapshot } = await import("../../src/lib/snapshot-html");
    const html = snapshotToHtml(doc as never, {
      baseHref: "https://shop.test/pricing",
      head: "<style>#h{}</style>",
      bodyEnd: '<div id="afs-hm"></div>',
      maxChars: 100_000,
    })!;
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<base href="https://shop.test/pricing"><meta charset="utf-8"><style>#h{}</style>');
    expect(html).toContain("<style>body{color:red}\\3c /style>\\3c script>x()\\3c /script></style>"); // can't close the element
    expect(html).not.toMatch(/<script|onload=|onclick=|javascript:|http-equiv|preload|Enable JS|data:text/i);
    expect(html).toContain('<img src="/logo.png" srcset="/logo@2x.png 2x">');
    expect(html).toContain("width:300px;height:120px"); // the blocked element's box, not its content
    expect(html).not.toContain("secret");
    expect(html).toContain("width:400px;height:200px"); // the iframe's box
    expect(html).toContain("&lt;b&gt;not markup&lt;/b&gt; &amp; more");
    expect(html).toContain('<my-card><template shadowrootmode="open"><span>in shadow</span></template></my-card>');
    expect(html).toContain('<path d="M0 0L10 10"></path>');
    expect(html.indexOf('<div id="afs-hm">')).toBeLessThan(html.indexOf("</body>"));
    expect(snapshotToHtml(doc as never, { baseHref: "https://shop.test/", head: "", bodyEnd: "", maxChars: 100 })).toBeNull();
    const found = findSnapshot([meta(T0, "https://shop.test/pricing", 1280, 800), { type: 2, timestamp: T0, data: { node: doc } }]);
    expect(found).toMatchObject({ href: "https://shop.test/pricing", width: 1280, height: 800 });
  });

  it("the overlay: dots by signal, reach and attention bands, an escaped legend", async () => {
    const { overlayHtml } = await import("../../src/lib/heatmap-overlay");
    const base = {
      dots: [
        { x_pct: 10.25, y_pct: 20.125, n: 10, rage: 6, dead: 0, error: 0 },
        { x_pct: 50, y_pct: 50, n: 2, rage: 0, dead: 0, error: 0 },
      ],
      reach: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => ({ pct, share: 1 - pct / 100 })),
      attention: Array.from({ length: 10 }, (_, i) => ({ from_pct: i * 10, to_pct: (i + 1) * 10, time_share: i === 0 ? 0.5 : 0.05 })),
      legend: {
        path: '/p"><img src=x onerror=1>',
        device: "desktop",
        range: "30d",
        clicks: 12,
        pageviews: 3,
        snapshot_at: "2026-11-03 10:00 UTC",
      },
    };
    const click = overlayHtml({ ...base, type: "click" });
    expect(click).toContain("left:10.3%;top:20.1%");
    expect(click).toContain("rgba(220,38,38"); // rage dominates: red
    expect(click).toContain("rgba(37,99,235"); // plain clicks: blue
    expect(click).not.toContain("<img");
    expect(click).toContain("&lt;img src=x onerror=1&gt;");
    const scroll = overlayHtml({ ...base, type: "scroll" });
    expect(scroll).toContain("100% reached");
    expect(scroll).toContain("10% reached");
    expect(overlayHtml({ ...base, type: "attention" })).toContain("50% of time");
  });

  it("requests are limited to the site's hosts; the snapshot is the latest stored page load, clicks are binned", async () => {
    const { requestPatterns } = await import("../../src/service/heatmap-image");
    const pats = requestPatterns({ domain: "shop.test", allowed_hostnames: '["*.cdn.test"]' } as never).map((p) => new RegExp(p));
    const ok = (u: string) => pats.some((p) => p.test(u));
    expect(ok("https://shop.test/app.css")).toBe(true);
    expect(ok("https://img.shop.test/a.png")).toBe(true);
    expect(ok("https://x.cdn.test/f.woff2")).toBe(true);
    expect(ok("https://cdn.test/f.woff2")).toBe(false);
    expect(ok("https://shop.test.evil.test/x")).toBe(false);
    expect(ok("http://shop.test/x")).toBe(false);
    expect(ok("data:image/png;base64,AAAA")).toBe(true);

    const { clickDots, latestSnapshot } = await import("../../src/do/heatmap-image");
    const db = memoryDb();
    const a = sid(80);
    const b = sid(81);
    feed(db, a, 0, [
      meta(T0),
      snapshot(T0 + 1),
      page(T0 + 5, 1, "/pricing"),
      click(T0 + 1000, 1, "#buy", { x: 720, y: 1500, w: 1440, dh: 3000 }),
    ]);
    feed(db, b, 0, [
      meta(T0 + 60_000),
      snapshot(T0 + 60_001),
      page(T0 + 60_005, 1, "/pricing"),
      click(T0 + 61_000, 1, "#buy", { x: 720, y: 1500, w: 1440, dh: 3000 }),
    ]);
    // a SPA navigation has no snapshot of its own
    feed(db, b, 1, [page(T0 + 70_000, 2, "/pricing", { nav: "push" })]);
    const q = { page: "/pricing", device: "desktop", start: T0 - 1000, end: NOW };
    expect(latestSnapshot(db, q)).toMatchObject({ session_id: b, seq: 0, path: "/pricing" });
    expect(latestSnapshot(db, { ...q, device: "mobile" })).toBeNull();
    expect(clickDots(db, q)).toEqual([{ x_pct: 50.25, y_pct: 50.125, n: 2, rage: 0, dead: expect.any(Number), error: 0 }]);
  });
});

describe("wave 2, 5: the opt-in email question", () => {
  it("needs a consent line, is never required, logic only on answered; the address only with consent", async () => {
    const { normalizeQuestions, validateAnswers, answerSummary, redactEmails } = await import("../../src/lib/survey-def");
    const bad = normalizeQuestions(
      [
        { type: "email", text: "Follow up?", required: true, logic: [{ if: { equals: "x" }, goto: "end" }] },
        { type: "long_text", text: "More?", consent_text: "ignored" },
      ] as never,
      20,
    );
    expect(bad.problems.join(" ")).toMatch(/consent_text/);
    expect(bad.problems.join(" ")).toMatch(/can't be required/);
    expect(bad.problems.join(" ")).toMatch(/answered/);
    expect(bad.questions[1]).not.toHaveProperty("consent_text");
    const { questions: qs, problems } = normalizeQuestions(
      [
        { type: "nps", text: "Recommend?" },
        { type: "email", text: "Follow up?", consent_text: "You may email me about this answer only." },
      ] as never,
      20,
    );
    expect(problems).toEqual([]);
    const opts = { maxChars: 2000, scrub: true, complete: true };
    const ok = validateAnswers(qs, { q1: 9, q2: { email: " person@example.test ", consent: true } }, opts);
    expect(ok).toEqual({ answers: { q1: 9, q2: "person@example.test" }, answered: 2 }); // not scrubbed: it is the answer
    expect(validateAnswers(qs, { q2: { email: "person@example.test" } }, opts)).toMatchObject({ error: "invalid_answer" });
    expect(validateAnswers(qs, { q2: { email: "person@example.test", consent: "yes" } }, opts)).toMatchObject({ error: "invalid_answer" });
    expect(validateAnswers(qs, { q2: "person@example.test" }, opts)).toMatchObject({ error: "invalid_answer" });
    expect(validateAnswers(qs, { q2: { email: "not an address", consent: true } }, opts)).toMatchObject({ error: "invalid_answer" });
    expect(validateAnswers(qs, { q2: { email: "a@b.test<script>", consent: true } }, opts)).toMatchObject({ error: "invalid_answer" });
    expect(validateAnswers(qs, { q1: 3 }, opts)).toMatchObject({ answered: 1 }); // skipping it is fine
    const answers = (ok as { answers: Record<string, string | number> }).answers;
    expect(answerSummary(qs, answers)).toBe("q1=9 (promoter), q2=(email given)");
    expect(redactEmails(qs, answers)).toEqual({ q1: 9, q2: "(email given: list_survey_responses)" });
  });

  it("results count addresses given and never list them", async () => {
    const { surveyResults } = await import("../../src/lib/survey-results");
    const qs = [{ id: "q1", type: "email" as const, text: "Follow up?", consent_text: "ok" }];
    const r = surveyResults(
      qs,
      [
        { id: "rsr_1", session_id: null, answers: { q1: "person@example.test" }, completed: true } as never,
        { id: "rsr_2", session_id: null, answers: {}, completed: true } as never,
      ],
      2,
    );
    expect(JSON.stringify(r)).not.toContain("person@example.test");
    expect(r.questions[0]).toMatchObject({ type: "email", emails_given: 1 });
  });
});
