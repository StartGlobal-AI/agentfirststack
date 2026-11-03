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
  } = {},
) {
  const sent: Sent[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  let clock = 1_000_000;
  const url = new URL("https://example.com/?utm_source=x");
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
    document: {
      currentScript: script,
      documentElement: doc,
      querySelector: (sel: string) => (sel.startsWith("meta") ? (opts.meta404 ? {} : null) : script),
      referrer: opts.referrer ?? "https://www.google.com/",
      visibilityState: "visible",
      addEventListener: (t: string, f: (e: unknown) => void) => (docListeners[t] ||= []).push(f),
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
    store,
    afsa,
    ctx,
    tick: (ms: number) => (clock += ms),
    fire: (t: string, e: unknown = {}) => [...(listeners[t] ?? []), ...(docListeners[t] ?? [])].forEach((f) => f(e)),
    click: (href: string) => docListeners.click?.forEach((f) => f({ target: { closest: () => ({ href }) } })),
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
    // Budget: 3.4 KB minified (scroll depth, Web Vitals, 404 and form tracking took it from 2.2 KB).
    expect(TRACKER.length).toBeLessThan(3400);
    expect(gzipSync(TRACKER).length).toBeLessThan(1900);
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
