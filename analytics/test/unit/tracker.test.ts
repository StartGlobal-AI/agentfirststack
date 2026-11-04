import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { QUEUE_STUB } from "../../src/service/install";

// The built bundle (pnpm test runs scripts/build-tracker.mjs first).
const TRACKER = readFileSync(new URL("../../dist/tracker.txt", import.meta.url), "utf8");

type Sent = { via: "fetch" | "beacon"; url: string; body: Record<string, unknown> };

/** A tiny fake browser: just the APIs the tracker touches. */
function browser(
  opts: {
    src?: string;
    attrs?: Record<string, string>;
    response?: Record<string, unknown>;
    storage?: Record<string, string>;
    preload?: unknown[][];
    stubCalls?: string;
    /** fake PerformanceObserver: entries per type, delivered on observe() */
    perf?: Record<string, Record<string, unknown>[]>;
    status?: number;
    meta404?: boolean;
    referrer?: string;
    /** window.afsr before the tracker runs (the replay snippet installed directly) */
    afsr?: unknown;
    /** elements with data-afsa-view, and whether each is visible */
    views?: { attrs: Record<string, string>; visible: boolean }[];
    title?: string;
    innerWidth?: number;
    hash?: string;
  } = {},
) {
  const sent: Sent[] = [];
  const scripts: { tag: string; src?: string; async?: boolean }[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  let clock = 1_000_000;
  const url = new URL(`https://example.com/?utm_source=x${opts.hash ?? ""}`);
  const timers: (() => void)[] = [];
  const formEls: Record<string, unknown> = {};
  const observers: { threshold: number; el: unknown }[] = [];
  const location = {
    get href() {
      return url.href;
    },
    get pathname() {
      return url.pathname;
    },
    get search() {
      return url.search;
    },
    get host() {
      return url.host;
    },
    get hash() {
      return url.hash;
    },
  };
  const attrs: Record<string, string> = { "data-site": "site_0123456789abcdef", ...(opts.attrs ?? {}) };
  const script = { src: opts.src ?? "https://analytics.example.net/s.js", getAttribute: (k: string) => attrs[k] ?? null };
  const store: Record<string, string> = { ...(opts.storage ?? {}) };
  const doc = { scrollHeight: 2000 };
  const ctx: Record<string, unknown> = {
    URL,
    JSON,
    Promise,
    Math,
    Date: { now: () => clock },
    scrollY: 0,
    innerHeight: 500,
    innerWidth: opts.innerWidth,
    setTimeout: (f: () => void) => timers.push(f),
    IntersectionObserver: function (
      this: { cb: (es: unknown[]) => void; o: { threshold: number } },
      cb: (es: unknown[]) => void,
      o: { threshold: number },
    ) {
      this.cb = cb;
      this.o = o;
    },
    document: {
      currentScript: script,
      documentElement: doc,
      title: opts.title ?? "Home",
      querySelectorAll: (sel: string) =>
        sel === "[data-afsa-view]"
          ? (opts.views ?? []).map((v) => ({ visible: v.visible, getAttribute: (k: string) => v.attrs[k] ?? null }))
          : [],
      querySelector: (sel: string) => (sel.startsWith("meta") ? (opts.meta404 ? {} : null) : script),
      referrer: opts.referrer ?? "https://www.google.com/",
      visibilityState: "visible",
      addEventListener: (t: string, f: (e: unknown) => void) => (docListeners[t] ||= []).push(f),
      createElement: (tag: string) => ({ tag }),
      head: { appendChild: (el: { tag: string }) => scripts.push(el) },
    },
    navigator: {
      webdriver: false,
      sendBeacon: (u: string, data: string) => {
        sent.push({ via: "beacon", url: u, body: JSON.parse(data) });
        return true;
      },
    },
    location,
    history: {
      pushState: (_s: unknown, _t: string, u: string) => {
        const n = new URL(u, url);
        url.href = n.href;
      },
      replaceState: (_s: unknown, _t: string, u: string) => {
        const n = new URL(u, url);
        url.href = n.href;
      },
    },
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => (store[k] = v),
      removeItem: (k: string) => delete store[k],
    },
    fetch: (u: string, init: { body: string }) => {
      sent.push({ via: "fetch", url: u, body: JSON.parse(init.body) });
      return Promise.resolve({ json: () => Promise.resolve(opts.response ?? { ok: true, v: "vid_from_server" }) });
    },
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ||= []).push(f),
  };
  ctx.window = ctx;
  const IO = ctx.IntersectionObserver as unknown as { prototype: Record<string, unknown> };
  IO.prototype.observe = function (this: { cb: (es: unknown[]) => void; o: { threshold: number } }, el: { visible: boolean }) {
    observers.push({ threshold: this.o.threshold, el });
    this.cb([{ isIntersecting: el.visible, target: el }]);
  };
  IO.prototype.disconnect = () => {};
  if (opts.afsr) ctx.afsr = opts.afsr;
  if (opts.perf) {
    const perf = opts.perf;
    const PO = function (this: { cb: (l: unknown) => void }, cb: (l: unknown) => void) {
      this.cb = cb;
    } as unknown as { new (cb: (l: unknown) => void): unknown; supportedEntryTypes: string[] };
    (PO as unknown as { prototype: Record<string, unknown> }).prototype.observe = function (
      this: { cb: (l: unknown) => void },
      o: { type: string },
    ) {
      this.cb({ getEntries: () => perf[o.type] ?? [] });
    };
    PO.supportedEntryTypes = Object.keys(perf);
    ctx.PerformanceObserver = PO;
    ctx.performance = { getEntriesByType: () => [{ responseStatus: opts.status ?? 200 }] };
  }
  if (opts.preload) {
    // the queue stub from the install snippet
    const q: unknown[] = [];
    const stub = Object.assign((...a: unknown[]) => q.push(a), { q });
    for (const call of opts.preload) stub(...call);
    ctx.afsa = stub;
  }
  if (opts.stubCalls) {
    // the real queue stub from the install snippet, then calls made before the tracker loads
    runInNewContext(QUEUE_STUB.replace(/^<script>|<\/script>$/g, ""), ctx);
    runInNewContext(opts.stubCalls, ctx);
  }
  runInNewContext(TRACKER, ctx);
  const afsa = ctx.afsa as ((...a: unknown[]) => void) & { visitorId: () => string | null };
  return {
    sent,
    scripts,
    store,
    afsa,
    ctx,
    tick: (ms: number) => (clock += ms),
    fire: (t: string, e: unknown = {}) => [...(listeners[t] ?? []), ...(docListeners[t] ?? [])].forEach((f) => f(e)),
    click: (href: string) =>
      docListeners.click?.forEach((f) => f({ type: "click", target: { closest: (sel: string) => (sel === "a" ? { href } : null) } })),
    /** a click on an element with data-afsa-* attributes (and optionally inside a link) */
    clickEl: (attrs: Record<string, string>, href?: string) =>
      docListeners.click?.forEach((f) =>
        f({
          type: "click",
          target: {
            closest: (sel: string) =>
              sel === "a"
                ? href
                  ? { href }
                  : null
                : {
                    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
                    getAttribute: (k: string) => attrs[k] ?? null,
                  },
          },
        }),
      ),
    /** an input event in a form (the same id = the same form element) */
    input: (form: Record<string, string> | null) => {
      const el = form && (formEls[form.id ?? ""] ??= { id: form.id ?? "", getAttribute: (k: string) => form[k] ?? null });
      docListeners.input?.forEach((f) => f({ target: { form: el } }));
    },
    runTimers: () => timers.splice(0).forEach((f) => f()),
    observers,
    location: url,
    submit: (form: Record<string, string>) =>
      docListeners.submit?.forEach((f) => f({ target: { id: form.id ?? "", getAttribute: (k: string) => form[k] ?? null } })),
    scroll: (y: number) => {
      ctx.scrollY = y;
      listeners.scroll?.forEach((f) => f({}));
    },
    history: ctx.history as {
      pushState: (s: unknown, t: string, u: string) => void;
      replaceState: (s: unknown, t: string, u: string) => void;
    },
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}

describe("tracker (/s.js)", () => {
  it("is small and carries the verify marker", () => {
    expect(TRACKER.startsWith("/*! afs-analytics */")).toBe(true);
    // Budget: 5.1 KB minified, 2.75 KB gzip. Scroll depth, Web Vitals, 404 and form tracking took it
    // from 2.2 KB to 3.4 KB; loading the replay recorder of linked sites added 0.2 KB; the wave-1
    // pack (debug flag, hash routing, attribute click events, element visibility, global and
    // per-pageview props, beforeSend, download extensions, redirect links, non-interactive events,
    // form_start, page title, viewport width) 1.5 KB minified / 0.7 KB gzip. Language, extra UTM
    // tags, site search and content groups are read on the server and cost the tracker nothing.
    expect(TRACKER.length).toBeLessThan(5100);
    expect(gzipSync(TRACKER).length).toBeLessThan(2750);
  });

  it("exposes window.afsa and nothing under the old sga name", () => {
    const b = browser();
    expect(typeof b.afsa).toBe("function");
    expect(typeof b.afsa.visitorId).toBe("function");
    expect(b.ctx.sga).toBeUndefined();
    expect(TRACKER).not.toMatch(/\bsga/);
  });

  it("sends a pageview to the script's origin, then queued calls (identify first)", async () => {
    const b = browser({
      preload: [
        ["event", "early", { a: 1 }],
        ["identify", "user_1"],
      ],
    });
    expect(b.sent[0]).toEqual({
      via: "fetch",
      url: "https://analytics.example.net/e",
      body: {
        s: "site_0123456789abcdef",
        n: "pageview",
        u: "https://example.com/?utm_source=x",
        r: "https://www.google.com/",
        i: "user_1",
      },
    });
    expect(b.sent[1]!.body).toMatchObject({ n: "early", p: { a: 1 }, i: "user_1" });
    await b.flush();
    expect(b.afsa.visitorId()).toBe("vid_from_server");
    expect(b.store).toEqual({}); // cookieless: nothing stored
  });

  it("the install snippet's queue stub keeps afsa() calls made before load", () => {
    const b = browser({ stubCalls: "afsa('identify', 'u_9'); afsa('event', 'early')" });
    expect(b.sent.map((x) => [x.body.n, x.body.i])).toEqual([
      ["pageview", "u_9"],
      ["early", "u_9"],
    ]);
  });

  it("posts to the same path prefix when proxied, or to data-api", () => {
    expect(browser({ src: "https://example.com/_a/s.js" }).sent[0]!.url).toBe("https://example.com/_a/e");
    expect(browser({ attrs: { "data-api": "https://c.example.com/collect" } }).sent[0]!.url).toBe("https://c.example.com/collect");
  });

  it("tracks SPA navigations, dedupes same-URL replaceState, and beacons engagement for the page left", () => {
    const b = browser();
    b.tick(5000);
    b.history.pushState({}, "", "/pricing");
    expect(b.sent.slice(1).map((s) => [s.via, s.body.n, s.body.u, s.body.e])).toEqual([
      ["beacon", "engagement", "https://example.com/?utm_source=x", 5000],
      ["fetch", "pageview", "https://example.com/pricing", undefined],
    ]);
    b.history.replaceState({}, "", "/pricing");
    expect(b.sent).toHaveLength(3);
    b.fire("popstate");
    expect(b.sent).toHaveLength(3);
    b.tick(2500);
    b.fire("pagehide");
    expect(b.sent[3]).toMatchObject({ via: "beacon", body: { n: "engagement", e: 2500, u: "https://example.com/pricing" } });
  });

  it("custom events, revenue, outbound links and downloads", () => {
    const b = browser();
    b.afsa("event", "signup", { plan: "pro" });
    b.afsa("revenue", "purchase", 49, "USD", { order_id: "A-1" });
    b.click("https://other.org/path?secret=1");
    b.click("https://example.com/files/report.pdf");
    b.click("https://example.com/internal");
    expect(b.sent.slice(1).map((s) => [s.via, s.body.n, s.body.p, s.body.$])).toEqual([
      ["fetch", "signup", { plan: "pro" }, undefined],
      ["fetch", "purchase", { order_id: "A-1" }, [49, "USD"]],
      ["beacon", "outbound_click", { url: "https://other.org/path" }, undefined],
      ["beacon", "file_download", { url: "https://example.com/files/report.pdf" }, undefined],
    ]);
  });

  it("data-auto=false disables outbound/download tracking", () => {
    const b = browser({ attrs: { "data-auto": "false" } });
    b.click("https://other.org/");
    expect(b.sent).toHaveLength(1);
  });

  it("persistent mode stores the server's id and sends it back; cookieless clears it", async () => {
    const b = browser({ response: { ok: true, v: "persist_abc123", p: 1 } });
    await b.flush();
    expect(b.store.afsa_vid).toBe("persist_abc123");
    b.afsa("event", "x");
    expect(b.sent[1]!.body.id).toBe("persist_abc123");
    const c = browser({ storage: { afsa_vid: "old_id_123" } });
    expect(c.sent[0]!.body.id).toBe("old_id_123");
    await c.flush();
    expect(c.store.afsa_vid).toBeUndefined();
  });

  it("afsa('debug') and data-debug=\"true\" mark events as test traffic (dbg: 1), also when queued before load", () => {
    const b = browser({ attrs: { "data-debug": "true" } });
    expect(b.sent[0]!.body.dbg).toBe(1);
    const q = browser({ preload: [["debug"], ["event", "x"]] });
    expect(q.sent.map((s) => s.body.dbg)).toEqual([1, 1]);
    q.afsa("debug", false);
    q.afsa("event", "y");
    expect(q.sent[2]!.body.dbg).toBeUndefined();
    expect(browser().sent[0]!.body.dbg).toBeUndefined();
  });

  it("flags webdriver and GPC, honours afsa_ignore", () => {
    const b = browser();
    (b.ctx.navigator as Record<string, unknown>).webdriver = true;
    (b.ctx.navigator as Record<string, unknown>).globalPrivacyControl = true;
    b.afsa("event", "x");
    expect(b.sent[1]!.body).toMatchObject({ b: 1, d: 1 });
    expect(browser({ storage: { afsa_ignore: "1" } }).sent).toHaveLength(0);
  });
});

describe("tracker: scroll depth, Web Vitals, 404 and forms", () => {
  it("the engagement beacon carries max scroll depth and the page load's vitals", () => {
    const b = browser({
      perf: {
        "largest-contentful-paint": [{ startTime: 900.4 }, { startTime: 1800.6 }],
        event: [
          { interactionId: 1, duration: 64 },
          { interactionId: 0, duration: 500 }, // not an interaction
          { interactionId: 2, duration: 232 },
        ],
        "layout-shift": [
          { startTime: 2000, value: 0.05 },
          { startTime: 2500, value: 0.02, hadRecentInput: true },
          { startTime: 2600, value: 0.04 },
          { startTime: 9000, value: 0.01 }, // new session window
        ],
      },
    });
    b.scroll(700); // (700 + 500) / 2000 = 60%
    b.scroll(100); // max is kept
    b.tick(3000);
    b.fire("pagehide");
    const eng = b.sent.find((s) => s.body.n === "engagement")!;
    expect(eng.body).toMatchObject({ e: 3000, sd: 60, v: [1801, 232, 90] });
  });

  it("vitals describe the loaded page only: none after an SPA navigation", () => {
    const b = browser({ perf: { "largest-contentful-paint": [{ startTime: 1000 }] } });
    b.tick(2000);
    b.history.pushState({}, "", "/next");
    b.tick(2000);
    b.fire("pagehide");
    const [first, second] = b.sent.filter((s) => s.body.n === "engagement");
    expect(first!.body.v).toEqual([1000]);
    expect(second!.body.v).toBeUndefined();
    expect(second!.body.sd).toBe(25); // 500 / 2000
  });

  it("without PerformanceObserver nothing breaks and no vitals are sent", () => {
    const b = browser();
    b.tick(1500);
    b.fire("pagehide");
    expect(b.sent.find((s) => s.body.n === "engagement")!.body.v).toEqual([]);
  });

  it('data-404="true" sends a 404 event (status 404 or the meta hint), with the referrer path only', () => {
    expect(
      browser({ attrs: { "data-404": "true" }, perf: {}, status: 404, referrer: "https://www.google.com/page?q=secret" }).sent.map((s) => [
        s.body.n,
        s.body.p,
      ]),
    ).toEqual([
      ["pageview", undefined],
      ["404", { from: "https://www.google.com/page" }],
    ]);
    expect(browser({ attrs: { "data-404": "true" }, meta404: true, perf: {} }).sent.map((s) => s.body.n)).toEqual(["pageview", "404"]);
    expect(browser({ attrs: { "data-404": "true" }, perf: {}, status: 200 }).sent).toHaveLength(1);
    expect(browser({ perf: {}, status: 404 }).sent).toHaveLength(1); // opt-in only
    const b = browser();
    b.afsa("404");
    expect(b.sent[1]!.body.n).toBe("404");
  });

  it('data-forms="true" sends form_submit with the form id, name or action path, never values', () => {
    const b = browser({ attrs: { "data-forms": "true" } });
    b.submit({ id: "contact" });
    b.submit({ name: "newsletter" });
    b.submit({ action: "/subscribe?ref=x" });
    expect(b.sent.slice(1).map((s) => [s.via, s.body.n, s.body.p])).toEqual([
      ["beacon", "form_submit", { form: "contact" }],
      ["beacon", "form_submit", { form: "newsletter" }],
      ["beacon", "form_submit", { form: "/subscribe" }],
    ]);
    const off = browser();
    off.submit({ id: "contact" });
    expect(off.sent).toHaveLength(1);
  });
});

describe("tracker: wave-1 collection pack", () => {
  it("hash routing: #/routes are pageviews (h: 1), plain anchors are not new pages", () => {
    const b = browser({ attrs: { "data-hash": "true" }, hash: "#/inbox" });
    expect(b.sent[0]!.body).toMatchObject({ n: "pageview", h: 1, u: "https://example.com/?utm_source=x#/inbox" });
    b.location.hash = "#/settings";
    b.fire("hashchange");
    expect(b.sent.filter((s) => s.body.n === "pageview")).toHaveLength(2);
    b.fire("hashchange");
    expect(b.sent.filter((s) => s.body.n === "pageview")).toHaveLength(2);
    const off = browser({ hash: "#x" });
    expect(off.sent[0]!.body.h).toBeUndefined();
  });

  it("data-afsa-event clicks send the event with data-afsa-prop-* (kebab to snake case)", () => {
    const b = browser();
    b.clickEl({ "data-afsa-event": "signup", "data-afsa-prop-plan": "pro", "data-afsa-prop-billing-cycle": "yearly", class: "btn" });
    expect(b.sent[1]).toMatchObject({ via: "beacon", body: { n: "signup", p: { plan: "pro", billing_cycle: "yearly" } } });
  });

  it("element_view once per pageview per name, with the element's threshold", () => {
    const b = browser({
      views: [
        { attrs: { "data-afsa-view": "pricing_table", "data-afsa-view-threshold": "0.8" }, visible: true },
        { attrs: { "data-afsa-view": "footer" }, visible: false },
      ],
    });
    b.runTimers();
    expect(b.sent.filter((s) => s.body.n === "element_view").map((s) => s.body.p)).toEqual([{ name: "pricing_table" }]);
    expect(b.observers.map((o) => o.threshold)).toEqual([0.8, 0.5]);
    b.runTimers();
    expect(b.sent.filter((s) => s.body.n === "element_view")).toHaveLength(1);
    b.history.pushState({}, "", "/next");
    b.runTimers();
    expect(b.sent.filter((s) => s.body.n === "element_view")).toHaveLength(2);
  });

  it("global props (data-props, afsa('props')) ride on every event; pageview props and a custom URL", () => {
    const b = browser({ attrs: { "data-props": '{"variant":"b"}' }, preload: [["props", { plan: "pro" }]] });
    expect(b.sent[0]!.body.p).toEqual({ variant: "b", plan: "pro" });
    b.afsa("event", "x", { a: 1 });
    expect(b.sent[1]!.body.p).toEqual({ variant: "b", plan: "pro", a: 1 });
    b.afsa("pageview", { url: "/users/:id", props: { section: "account" } });
    expect(b.sent[2]!.body).toMatchObject({
      n: "pageview",
      u: "https://example.com/users/:id",
      p: { variant: "b", plan: "pro", section: "account" },
    });
    b.tick(2000);
    b.fire("pagehide");
    expect(b.sent[3]!.body).toMatchObject({ n: "engagement", u: "https://example.com/users/:id" });
    expect(b.sent[3]!.body.p).toBeUndefined();
  });

  it("data-before-send can rewrite or drop a payload", () => {
    const b = browser({ attrs: { "data-before-send": "scrub" } });
    expect(b.sent).toHaveLength(1);
    const c = browser({ attrs: { "data-before-send": "scrub" } });
    (c.ctx as Record<string, unknown>).scrub = (n: string, p: Record<string, unknown>) =>
      n === "secret" ? null : { ...p, u: "https://example.com/redacted" };
    c.afsa("event", "secret");
    c.afsa("event", "fine");
    expect(c.sent.map((s) => [s.body.n, s.body.u])).toEqual([
      ["pageview", "https://example.com/?utm_source=x"],
      ["fine", "https://example.com/redacted"],
    ]);
  });

  it("custom download extensions and same-host redirect paths as outbound clicks", () => {
    const b = browser({ attrs: { "data-downloads": "pdf,sketch", "data-link-paths": "/go/*,/out/*" } });
    b.click("https://example.com/a.sketch");
    b.click("https://example.com/a.zip");
    b.click("https://example.com/go/partner?x=1");
    b.click("https://example.com/internal");
    expect(b.sent.slice(1).map((s) => [s.body.n, s.body.p])).toEqual([
      ["file_download", { url: "https://example.com/a.sketch" }],
      ["outbound_click", { url: "https://example.com/go/partner" }],
    ]);
  });

  it("non-interactive events, form_start once per form, title and viewport width on pageviews", () => {
    const b = browser({ attrs: { "data-forms": "true", "data-title": "true" }, title: "Pricing | Example", innerWidth: 1280 });
    expect(b.sent[0]!.body).toMatchObject({ t: "Pricing | Example", w: 1280 });
    b.afsa("event", "impression", { slot: "hero" }, { interactive: false });
    expect(b.sent[1]!.body).toMatchObject({ n: "impression", ni: 1 });
    b.input({ id: "contact" });
    b.input({ id: "contact" });
    b.input(null);
    expect(b.sent.filter((s) => s.body.n === "form_start").map((s) => s.body.p)).toEqual([{ form: "contact" }]);
    expect(browser().sent[0]!.body.t).toBeUndefined();
  });
});

describe("tracker: replay loader of a linked site", () => {
  const R = "https://replay.example.net/r/rsite_0123456789abcdef.js";

  it("adds <script async src=r> once per page load, not again on SPA navigations", async () => {
    const b = browser({ response: { ok: true, v: "vid_1", r: R } });
    await b.flush();
    expect(b.scripts).toEqual([{ tag: "script", src: R, async: true }]);
    b.history.pushState({}, "", "/pricing");
    b.afsa("event", "signup");
    await b.flush();
    expect(b.sent.filter((s) => s.via === "fetch")).toHaveLength(3);
    expect(b.scripts).toHaveLength(1);
    expect(b.afsa.visitorId()).toBe("vid_1"); // the rest of the answer is still read
  });

  it("also from an answer that dropped the event (bots, exclusions, budgets: the loader decides)", async () => {
    const b = browser({ response: { ok: false, dropped: "bot", reason: "webdriver", r: R } });
    await b.flush();
    expect(b.scripts.map((s) => s.src)).toEqual([R]);
  });

  it("only https, or http on localhost / 127.0.0.1", async () => {
    const loads = async (r: string) => {
      const b = browser({ response: { ok: true, v: "vid_1", r } });
      await b.flush();
      return b.scripts.length;
    };
    expect(await loads("http://replay.example.net/r/rsite_0123456789abcdef.js")).toBe(0);
    expect(await loads("http://localhost.evil.test/r/rsite_0123456789abcdef.js")).toBe(0);
    expect(await loads("javascript:alert(1)")).toBe(0);
    expect(await loads("//replay.example.net/r/rsite_0123456789abcdef.js")).toBe(0);
    expect(await loads("http://localhost:8790/r/rsite_0123456789abcdef.js")).toBe(1);
    expect(await loads("http://127.0.0.1/r/rsite_0123456789abcdef.js")).toBe(1);
  });

  it("nothing without r, and nothing when the replay snippet is installed directly", async () => {
    const plain = browser();
    await plain.flush();
    expect(plain.scripts).toHaveLength(0);
    const direct = browser({ response: { ok: true, v: "vid_1", r: R }, afsr: Object.assign(() => {}, { sessionId: () => "rs_x" }) });
    await direct.flush();
    expect(direct.scripts).toHaveLength(0);
    // the install snippet's queue stub alone (loader not run yet) doesn't count as installed
    const stub = browser({ response: { ok: true, v: "vid_1", r: R }, afsr: Object.assign(() => {}, { q: [] }) });
    await stub.flush();
    expect(stub.scripts).toHaveLength(1);
  });
});
