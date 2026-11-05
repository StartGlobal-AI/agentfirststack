/**
 * Browser test traffic in the real bundled runtime: ?afsa_debug=1 (kept for the tab in
 * sessionStorage afsa_debug, the analytics tracker's flag), afst('test', true | false), preview.
 * Ad and vendor pixels don't run there (reported as test_skipped), the analytics tag and the
 * owner's custom code do, and /collect hits carry test: 1.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ContainerConfig } from "../src/config/schema";
import { browser, loadRuntimes, serve } from "./fixtures/browser";

beforeAll(async () => {
  await loadRuntimes();
});

type Win = Record<string, unknown>;
const gtagCalls = (w: Win) =>
  ((w.dataLayer as unknown[]) ?? [])
    .filter((x) => Object.prototype.toString.call(x) === "[object Arguments]")
    .map((a) => Array.from(a as ArrayLike<unknown>));
const log = (w: Win) => (w.__afst_debug as { kind: string; msg: string }[]) ?? [];
const fired = (w: Win) =>
  log(w)
    .filter((l) => l.kind === "fire")
    .map((l) => l.msg);
const afst = (w: Win) => w.afst as (...a: unknown[]) => unknown;
const afsaQueue = (w: Win) => ((w.afsa as { q?: ArrayLike<unknown>[] })?.q ?? []).map((a) => Array.from(a));
const allPages = { id: "all_pages", type: "page_view" } as const;

const PIXEL_GLOBALS = ["fbq", "ttq", "lintrk", "uetq", "rdt", "twq", "pintrk", "snaptr"];
const VENDOR_HOSTS = /googletagmanager|connect\.facebook|analytics\.tiktok|snap\.licdn|bat\.bing|redditstatic|ads-twitter|pinimg|sc-static/;

/** Every tag type on page_view, and a purchase conversion sent to pixels and analytics. */
const cfg: ContainerConfig = {
  variables: [{ name: "v", type: "data_layer", key: "value" }],
  triggers: [allPages, { id: "buy", type: "custom_event", event: "purchase" }],
  tags: [
    { id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] },
    { id: "ads", type: "google_ads", params: { conversion_id: "AW-123456789", conversion_label: "lbl" }, triggers: ["all_pages"] },
    { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
    { id: "tt", type: "tiktok_pixel", params: { pixel_id: "C1A2B3C4D5E6F7G8H9I0" }, triggers: ["all_pages"] },
    { id: "li", type: "linkedin_insight", params: { partner_id: "123456" }, triggers: ["all_pages"] },
    { id: "uet", type: "microsoft_uet", params: { tag_id: "12345678" }, triggers: ["all_pages"] },
    { id: "rd", type: "reddit_pixel", params: { pixel_id: "a2_abcdef" }, triggers: ["all_pages"] },
    { id: "x", type: "x_pixel", params: { pixel_id: "o1abc" }, triggers: ["all_pages"] },
    { id: "pin", type: "pinterest_tag", params: { tag_id: "2612345678901" }, triggers: ["all_pages"] },
    { id: "snap", type: "snap_pixel", params: { pixel_id: "6f5c0b3e-4a2d-4c1b-9e8f-1a2b3c4d5e6f" }, triggers: ["all_pages"] },
    { id: "img", type: "image_pixel", params: { url: "https://px.example.net/i" }, triggers: ["all_pages"] },
    { id: "an", type: "analytics", params: { site_id: "site_abc123", base_url: "https://analytics.example.net" }, triggers: ["all_pages"] },
    { id: "html", type: "custom_html", params: { html: "<b>x</b>" }, triggers: ["all_pages"] },
    { id: "js", type: "custom_js", params: { code: "if (afst('get', 'test')) afst('event', 'saw_test');" }, triggers: ["all_pages"] },
  ],
  conversions: [
    {
      name: "purchase",
      trigger: "buy",
      value: "v",
      currency: "USD",
      send_to: {
        meta: { event_name: "Purchase" },
        ga4: { event_name: "purchase" },
        tiktok: { event_name: "CompletePayment" },
        analytics: { event_name: "purchase" },
      },
      server: true,
    },
  ],
  settings: { report_tag_fires: true },
};
const PIXEL_IDS = ["ga4", "ads", "meta", "tt", "li", "uet", "rd", "x", "pin", "snap", "img"];

/** Assert no ad/vendor pixel ran (no globals, no vendor scripts, no gtag config/event). */
function noPixels(b: ReturnType<typeof browser>) {
  for (const g of PIXEL_GLOBALS) expect(b.win[g], g).toBeUndefined();
  expect(b.scripts().filter((s) => VENDOR_HOSTS.test(String(s)))).toEqual([]);
  expect(gtagCalls(b.win).filter((c) => c[0] === "config" || c[0] === "event")).toEqual([]);
  expect(fired(b.win).filter((m) => m.includes("image pixel"))).toEqual([]);
}

describe("?afsa_debug=1 marks the tab as test traffic", () => {
  it("ad pixels don't fire; analytics (debug), custom_html and custom_js do; hits carry test: 1", () => {
    const b = browser("https://shop.test/?afsa_debug=1");
    b.run(serve(cfg));
    expect(fired(b.win)).toEqual(["tag an (analytics)", "tag html (custom_html)", "tag js (custom_js)"]);
    (b.win.dataLayer as unknown[]).push({ event: "purchase", value: 42 });

    expect(b.session.afsa_debug).toBe("1"); // the analytics tracker's flag, kept for the tab
    noPixels(b);
    // custom code still runs and can tell: afst('get', 'test')
    expect((b.win.dataLayer as Record<string, unknown>[]).some((e) => e.event === "saw_test")).toBe(true);
    expect(afst(b.win)("get", "test")).toBe(true);
    // The analytics tag: afsa('debug') before anything else, data-debug on the tracker.
    const q = afsaQueue(b.win);
    expect(q[0]).toEqual(["debug"]);
    expect(q).toContainEqual(["revenue", "purchase", 42, "USD", expect.objectContaining({ event_id: expect.any(String) })]);
    const s = b.doc.querySelectorAll("script").find((x) => String(x.src ?? x.attrs.src).includes("/s.js"));
    expect(s?.attrs["data-debug"]).toBe("true");
    // Each pixel is logged as skipped with the reason.
    const skips = log(b.win).filter((l) => l.kind === "skip");
    expect(
      skips.some(
        (l) =>
          l.msg ===
          "tag meta (meta_pixel): test traffic: ad pixels don't fire in the browser; the server-side conversion is sent in test mode",
      ),
    ).toBe(true);
    expect(skips.some((l) => l.msg.startsWith("conversion purchase -> meta: test traffic"))).toBe(true);

    const visit = b.fetches.find((f) => f.body.type === "visit")!.body;
    expect(visit.test).toBe(1);
    const conv = b.fetches.find((f) => f.body.type === "conversion")!.body;
    expect(conv).toMatchObject({ test: 1, name: "purchase", value: 42, fired: ["analytics"] });
  });

  it("report_tag_fires counts the pixels as test_skipped (not fired), the rest as fired", () => {
    const b = browser("https://shop.test/?afsa_debug=1", { manualTimers: true });
    b.run(serve(cfg));
    b.winFire("pagehide");
    const tags = b.fetches.find((f) => f.body.type === "tags")!;
    expect(tags.body.test).toBe(1);
    const fires = tags.body.fires as { tag_id: string; status: string; n: number }[];
    for (const id of PIXEL_IDS) expect(fires, id).toContainEqual({ tag_id: id, status: "test_skipped", n: 1 });
    for (const id of ["an", "html", "js"]) expect(fires, id).toContainEqual({ tag_id: id, status: "fired", n: 1 });
    expect(fires.filter((f) => f.status === "fired" && PIXEL_IDS.includes(f.tag_id))).toEqual([]);
  });

  it("lasts for the tab (sessionStorage afsa_debug, also when the analytics tracker set it) until ?afsa_debug=0", () => {
    // A later page without the parameter: the flag the first page (or afsa('debug')) stored.
    const next = browser("https://shop.test/pricing");
    next.session.afsa_debug = "1";
    next.run(serve(cfg));
    noPixels(next);
    expect(next.fetches.find((f) => f.body.type === "visit")!.body.test).toBe(1);

    // ?afsa_debug=0 ends it (stored "0", as the analytics tracker does): pixels fire again.
    const off = browser("https://shop.test/?afsa_debug=0");
    off.session.afsa_debug = "1";
    off.run(serve(cfg));
    expect(off.session.afsa_debug).toBe("0");
    expect(off.win.fbq).toBeDefined();
    expect(gtagCalls(off.win).some((c) => c[0] === "config" && c[1] === "G-ABC123XYZ")).toBe(true);
    expect(afst(off.win)("get", "test")).toBe(false);
    expect(off.fetches.find((f) => f.body.type === "visit")!.body.test).toBeUndefined();
    expect(afsaQueue(off.win).some((c) => c[0] === "debug")).toBe(false);
  });

  it("live_only tags are skipped; a sequenced pixel and one released later by consent don't run either", () => {
    const b = browser("https://shop.test/?afsa_debug=1");
    b.run(
      serve({
        triggers: [allPages],
        tags: [
          { id: "live", type: "custom_js", params: { code: "1" }, triggers: ["all_pages"], live_only: true },
          { id: "setup", type: "custom_js", params: { code: "1" }, triggers: [] },
          { id: "seq", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"], after: { tag: "setup" } },
          { id: "later", type: "tiktok_pixel", params: { pixel_id: "C1A2B3C4D5E6F7G8H9I0" }, triggers: ["all_pages"] },
        ],
        consent: { mode: "opt_in" },
      }),
    );
    afst(b.win)("consent", "update", { ad_storage: "granted", analytics_storage: "granted" });
    expect(b.win.fbq).toBeUndefined();
    expect(b.win.ttq).toBeUndefined();
    const skips = log(b.win)
      .filter((l) => l.kind === "skip")
      .map((l) => l.msg);
    expect(skips).toEqual(
      expect.arrayContaining([
        "tag live: live_only: not fired in test traffic (preview, ?afsa_debug=1)",
        expect.stringMatching(/^tag seq \(meta_pixel\): test traffic/),
        expect.stringMatching(/^tag later \(tiktok_pixel\): test traffic/),
      ]),
    );
    expect(fired(b.win).filter((m) => !m.endsWith("(released by consent)"))).toEqual(["tag setup (custom_js)"]);
  });
});

describe("afst('test', true | false) and afst('get', 'test')", () => {
  it("queued before the snippet loads, it covers the first page view; false turns pixels back on", () => {
    const b = browser("https://shop.test/", {
      window: {
        // The snippet's queue stub, called before the runtime loaded.
        afst: Object.assign(
          function stub() {
            /* queued */
          },
          { q: [["test", true]] },
        ),
      },
    });
    b.run(serve(cfg));
    expect(b.session.afsa_debug).toBe("1");
    expect(afst(b.win)("get", "test")).toBe(true);
    noPixels(b);
    expect(afsaQueue(b.win)[0]).toEqual(["debug"]);

    afst(b.win)("test", false);
    expect(b.session.afsa_debug).toBe("0");
    expect(afst(b.win)("get", "test")).toBe(false);
    // The analytics tracker is told at once (afsa('debug', false)), as afsa('debug', false) would.
    expect(afsaQueue(b.win).at(-1)).toEqual(["debug", false]);
    (b.win.dataLayer as unknown[]).push({ event: "purchase", value: 5 });
    expect(b.win.fbq).toBeDefined(); // the conversion's Meta pixel ran
    const conv = b.fetches.filter((f) => f.body.type === "conversion").at(-1)!.body;
    expect(conv.test).toBeUndefined();
    expect(conv.fired).toEqual(expect.arrayContaining(["meta_pixel", "ga4", "tiktok_pixel", "analytics"]));

    afst(b.win)("test", true);
    expect(b.session.afsa_debug).toBe("1");
    expect(afsaQueue(b.win).at(-1)).toEqual(["debug", true]);
  });

  it("without sessionStorage the flag lasts for the page", () => {
    const b = browser("https://shop.test/", { window: { sessionStorage: undefined } });
    b.run(serve(cfg));
    expect(afst(b.win)("get", "test")).toBe(false);
    afst(b.win)("test");
    expect(afst(b.win)("get", "test")).toBe(true);
    (b.win.dataLayer as unknown[]).push({ event: "purchase", value: 5 });
    const conv = b.fetches.find((f) => f.body.type === "conversion")!.body;
    expect(conv).toMatchObject({ test: 1, fired: ["analytics"] });
  });
});

describe("preview is test traffic", () => {
  it("the preview log reports pixels as test_skipped with the reason, and conversions say which platforms were held", () => {
    const b = browser("https://shop.test/");
    b.run(serve({ ...cfg, settings: {} }, { preview: "prv_abcdefghijklmnopqrstuvwx" }));
    (b.win.dataLayer as unknown[]).push({ event: "purchase", value: 3 });
    noPixels(b);
    // The runtime doesn't store the tab flag for preview (the analytics tracker's afsa('debug') does).
    expect(b.session.afsa_debug).toBeUndefined();
    const entries = b.fetches.filter((f) => f.body.type === "debug").flatMap((f) => f.body.entries as Record<string, unknown>[]);
    const pv = entries.find((e) => e.event === "page_view")!;
    const tags = pv.tags as { id: string; status: string; reason?: string }[];
    expect(tags.find((t) => t.id === "meta")).toEqual({
      id: "meta",
      type: "meta_pixel",
      status: "test_skipped",
      reason: "test traffic: ad pixels don't fire in the browser; the server-side conversion is sent in test mode",
      trigger: "all_pages",
    });
    for (const id of PIXEL_IDS) expect(tags.find((t) => t.id === id)?.status, id).toBe("test_skipped");
    for (const id of ["an", "html", "js"]) expect(tags.find((t) => t.id === id)?.status, id).toBe("fired");
    const purchase = entries.find((e) => e.event === "purchase")!;
    expect(purchase.conversions).toEqual([
      {
        name: "purchase",
        status: "fired",
        platforms: ["analytics"],
        reason: "meta, ga4, tiktok: test traffic: ad pixels don't fire in the browser; the server-side conversion is sent in test mode",
      },
    ]);
    expect(b.fetches.find((f) => f.body.type === "conversion")!.body).toMatchObject({ test: 1, preview: "prv_abcdefghijklmnopqrstuvwx" });
  });
});
