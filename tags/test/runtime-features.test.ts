/** The variable pack, trigger pack, tag options, preview trace, tag telemetry and extension-bundle features, in the real bundled runtime. */
import { beforeAll, describe, expect, it } from "vitest";
import type { ContainerConfig } from "../src/config/schema";
import { sha256HexSync } from "../src/lib/sha256";
import { tcfConsent } from "../src/lib/consent";
import { linkerValue, readLinker } from "../src/lib/linker";
import { needsExt } from "../src/service/script";
import { browser, el, loadRuntimes, serve } from "./fixtures/browser";

beforeAll(async () => {
  await loadRuntimes();
});

type Win = Record<string, unknown>;
const gtagCalls = (w: Win) =>
  ((w.dataLayer as unknown[]) ?? [])
    .filter((x) => Object.prototype.toString.call(x) === "[object Arguments]")
    .map((a) => Array.from(a as ArrayLike<unknown>));
const fbq = (w: Win) => ((w.fbq as { queue?: ArrayLike<unknown>[] })?.queue ?? []).map((a) => Array.from(a));
const log = (w: Win) => (w.__afst_debug as { kind: string; msg: string; data?: Record<string, unknown> }[]) ?? [];
const fired = (w: Win) =>
  log(w)
    .filter((l) => l.kind === "fire")
    .map((l) => l.msg);
const allPages = { id: "all_pages", type: "page_view" } as const;

describe("variable pack", () => {
  it("lookup, regex_table ($1), url components, event_attr, format and built-ins", () => {
    const link = el("a", { href: "https://www.partner.example.net/shop?ref=abc#top", "data-product-id": "SKU-9", target: "_blank" });
    const b = browser("https://shop.test/blog/how-to?plan=Pro", {
      body: [link],
      cookies: { _ga: "GA1.1.123456789.1700000000" },
    });
    const cfg: ContainerConfig = {
      variables: [
        { name: "plan", type: "url_param", param: "plan", format: { lowercase: true } },
        { name: "plan_value", type: "lookup", input: "plan", map: { pro: 99, basic: 19 }, default: 0 },
        {
          name: "section",
          type: "regex_table",
          input: "page_path",
          rows: [{ pattern: "/blog/(.*)", output: "blog:$1" }],
          default: "other",
        },
        { name: "link_host", type: "url", component: "host", source: "click_url", strip_www: true },
        { name: "link_ref", type: "url", component: "param", param: "ref", source: "click_url" },
        { name: "product", type: "event_attr", attr: "data-product-id" },
        { name: "missing", type: "data_layer", key: "nope", format: { map_undefined: "n/a" } },
        { name: "price", type: "constant", value: "1,234.50", format: { number: true } },
        { name: "common", type: "param_set", params: { section: "{{section}}", plan_value: "{{plan_value}}" } },
      ],
      triggers: [allPages, { id: "clicks", type: "click" }],
      tags: [
        {
          id: "page",
          type: "ga4",
          triggers: ["all_pages"],
          params: {
            measurement_id: "G-ABC123XYZ",
            event_name: "page",
            event_params_from: "common",
            event_params: {
              price: "{{price}}",
              missing: "{{missing}}",
              cid: "{{container_id}}",
              env: "{{environment}}",
              ga: "{{ga_client_id}}",
            },
          },
        },
        {
          id: "click_ev",
          type: "ga4",
          params: {
            measurement_id: "G-ABC123XYZ",
            event_name: "outbound",
            event_params: { host: "{{link_host}}", ref: "{{link_ref}}", product: "{{product}}", target: "{{click_target}}" },
          },
          triggers: ["clicks"],
        },
      ],
    };
    b.run(serve(cfg, { env: { name: "staging", token: "envt_x" } }));
    const page = gtagCalls(b.win).find((c) => c[0] === "event" && c[1] === "page")![2];
    expect(page).toMatchObject({
      section: "blog:how-to",
      plan_value: 99,
      price: 1234.5,
      missing: "n/a",
      cid: "ctr_abcdefgh12345678",
      env: "staging",
      ga: "123456789.1700000000",
    });
    b.dispatch("click", link);
    const out = gtagCalls(b.win).find((c) => c[0] === "event" && c[1] === "outbound")![2];
    expect(out).toMatchObject({ host: "partner.example.net", ref: "abc", product: "SKU-9", target: "_blank" });
    // Environment snippets tag their hits.
    expect(b.fetches.find((f) => f.body.type === "visit")!.body.env).toBe("envt_x");
  });
});

describe("variable cycles", () => {
  it("a self-referencing param_set in a previewed draft ends instead of overflowing the stack", () => {
    const b = browser("https://shop.test/");
    b.run(
      serve(
        {
          variables: [{ name: "loop", type: "param_set", params: { again: "{{loop}}" } }],
          triggers: [allPages],
          tags: [
            {
              id: "g",
              type: "ga4",
              params: { measurement_id: "G-ABC123XYZ", event_name: "x", event_params_from: "loop" },
              triggers: ["all_pages"],
            },
          ],
        },
        { preview: "prv_abcdefghijklmnopqrstuvwx" },
      ),
    );
    expect(gtagCalls(b.win).some((c) => c[0] === "event" && c[1] === "x")).toBe(true);
  });
});

describe("trigger pack", () => {
  it("consent_init -> init -> page_view -> dom_ready -> window_loaded, in that order", () => {
    const b = browser("https://shop.test/");
    const types = ["window_loaded", "dom_ready", "page_view", "init", "consent_init"] as const;
    b.run(
      serve({
        triggers: types.map((t) => ({ id: t, type: t })),
        tags: types.map((t) => ({ id: `t_${t}`, type: "custom_js", params: { code: "1" }, triggers: [t] })),
      }),
    );
    expect(fired(b.win)).toEqual([
      "tag t_consent_init (custom_js)",
      "tag t_init (custom_js)",
      "tag t_page_view (custom_js)",
      "tag t_dom_ready (custom_js)",
      "tag t_window_loaded (custom_js)",
    ]);
  });

  it("event_regex, numeric and CSS-selector operators, trigger groups once per page", () => {
    const btn = el("button", { class: "buy big" });
    const b = browser("https://shop.test/", { body: [btn] });
    b.run(
      serve({
        variables: [{ name: "v", type: "data_layer", key: "value" }],
        triggers: [
          { id: "any_cart", type: "custom_event", event_regex: "^(add|remove)_cart$" },
          { id: "big", type: "custom_event", event: "order", conditions: [{ var: "v", op: "gt", value: 100 }] },
          { id: "buy_btn", type: "click", conditions: [{ var: "click_element", op: "matches_css_selector", value: ".buy" }] },
          { id: "both", type: "trigger_group", triggers: ["any_cart", "buy_btn"] },
        ],
        tags: ["any_cart", "big", "buy_btn", "both"].map((t) => ({
          id: `t_${t}`,
          type: "custom_js",
          params: { code: "1" },
          triggers: [t],
        })),
      }),
    );
    const dl = b.win.dataLayer as unknown[];
    dl.push(
      { event: "add_cart" },
      { event: "remove_cart" },
      { event: "add_carts" },
      { event: "order", value: 50 },
      { event: "order", value: "150" },
    );
    expect(fired(b.win).filter((m) => m.includes("any_cart"))).toHaveLength(2);
    expect(fired(b.win).filter((m) => m.includes("t_big"))).toHaveLength(1);
    expect(fired(b.win).some((m) => m.includes("t_both"))).toBe(false);
    b.dispatch("click", btn);
    b.dispatch("click", btn);
    expect(fired(b.win).filter((m) => m.includes("t_buy_btn"))).toHaveLength(2);
    expect(fired(b.win).filter((m) => m.includes("t_both"))).toHaveLength(1);
  });

  it("check_validation: a form whose submit the site cancelled doesn't fire", () => {
    const form = el("form", { id: "f" });
    const b = browser("https://shop.test/", { body: [form] });
    b.run(
      serve({
        triggers: [
          { id: "checked", type: "form_submit", check_validation: true },
          { id: "any", type: "form_submit" },
        ],
        tags: [
          { id: "t_checked", type: "custom_js", params: { code: "1" }, triggers: ["checked"] },
          { id: "t_any", type: "custom_js", params: { code: "1" }, triggers: ["any"] },
        ],
      }),
    );
    // The site's own validation runs between our capture and bubble listeners.
    b.dispatch("submit", form, { defaultPrevented: true });
    expect(fired(b.win)).toEqual(["tag t_any (custom_js)"]);
    b.dispatch("submit", form);
    expect(fired(b.win)).toEqual(["tag t_any (custom_js)", "tag t_any (custom_js)", "tag t_checked (custom_js)"]);
  });

  it("scroll depth in pixels and horizontally; visibility with once per page; history built-ins", () => {
    const box = el("div", { id: "box" });
    const box2 = el("div", { id: "box2", class: "seen" });
    const b = browser("https://shop.test/a", { body: [box, box2] });
    b.run(
      serve({
        triggers: [
          { id: "px", type: "scroll_depth", pixels: [500] },
          { id: "hz", type: "scroll_depth", percentages: [50], direction: "horizontal" },
          { id: "vis", type: "element_visible", selector: "div", once: "page" },
          { id: "nav", type: "history_change" },
        ],
        tags: [
          { id: "t_px", type: "custom_js", params: { code: "1" }, triggers: ["px"] },
          { id: "t_hz", type: "custom_js", params: { code: "1" }, triggers: ["hz"] },
          { id: "t_vis", type: "custom_js", params: { code: "1" }, triggers: ["vis"] },
          {
            id: "t_nav",
            type: "ga4",
            params: {
              measurement_id: "G-ABC123XYZ",
              event_name: "nav",
              event_params: { src: "{{history_source}}", from: "{{history_old_url}}" },
            },
            triggers: ["nav"],
          },
        ],
      }),
    );
    const w = b.win as Record<string, unknown> & { scrollY: number; scrollX: number };
    (b.doc.documentElement as unknown as Record<string, number>).scrollHeight = 5000;
    (b.doc.documentElement as unknown as Record<string, number>).scrollWidth = 3000;
    w.innerWidth = 1000;
    w.scrollY = 600;
    w.scrollX = 1200;
    b.winFire("scroll");
    expect(fired(b.win)).toEqual(expect.arrayContaining(["tag t_px (custom_js)", "tag t_hz (custom_js)"]));
    b.intersect(true, 0.7);
    expect(fired(b.win).filter((m) => m.includes("t_vis"))).toHaveLength(1);
    (b.win.location as Record<string, string>).href = "https://shop.test/b";
    (b.win.history as { pushState: () => void }).pushState();
    const nav = gtagCalls(b.win).find((c) => c[0] === "event" && c[1] === "nav")![2];
    expect(nav).toMatchObject({ src: "pushState", from: "https://shop.test/a" });
  });
});

describe("tag options", () => {
  it("priority, schedule, live_only, data-afst-block and sequencing", () => {
    const b = browser("https://shop.test/", { scriptAttrs: { "data-afst-block": "custom_html" } });
    b.run(
      serve(
        {
          triggers: [allPages, { id: "never", type: "custom_event", event: "never" }],
          tags: [
            { id: "low", type: "custom_js", params: { code: "1" }, triggers: ["all_pages"] },
            { id: "high", type: "custom_js", params: { code: "1" }, triggers: ["all_pages"], priority: 10 },
            { id: "expired", type: "custom_js", params: { code: "1" }, triggers: ["all_pages"], schedule: { end: "2020-01-01T00:00:00Z" } },
            { id: "live", type: "custom_js", params: { code: "1" }, triggers: ["all_pages"], live_only: true },
            { id: "html", type: "custom_html", params: { html: "<b>x</b>" }, triggers: ["all_pages"] },
            { id: "main", type: "custom_js", params: { code: "1" }, triggers: ["all_pages"], after: { tag: "setup" } },
            { id: "setup", type: "custom_js", params: { code: "1" }, triggers: ["never"] },
          ],
        },
        { preview: "prv_abcdefghijklmnopqrstuvwx" },
      ),
    );
    expect(fired(b.win)).toEqual(["tag high (custom_js)", "tag low (custom_js)", "tag setup (custom_js)", "tag main (custom_js)"]);
    const skips = log(b.win)
      .filter((l) => l.kind === "skip")
      .map((l) => l.msg);
    expect(skips).toEqual(
      expect.arrayContaining([
        "tag expired: outside its schedule",
        "tag live: live_only: not fired in preview",
        "tag html: custom_html is blocked on this page (data-afst-block)",
      ]),
    );
  });

  it("snap_pixel with send_to.snap (client_dedup_id = event_id), image_pixel, gtag config_params, Ads dynamic remarketing", () => {
    const b = browser("https://shop.test/?q=a%20b&id=x/y", {
      dataLayer: [{ event: "purchase", ecommerce: { value: 20, items: [{ item_id: "S1" }, { item_id: "S2" }] } }],
    });
    b.run(
      serve({
        variables: [
          { name: "v", type: "data_layer", key: "ecommerce.value" },
          { name: "items", type: "data_layer", key: "ecommerce.items" },
          { name: "q", type: "url_param", param: "q" },
        ],
        triggers: [allPages, { id: "p", type: "custom_event", event: "purchase" }],
        tags: [
          { id: "snap", type: "snap_pixel", params: { pixel_id: "6f5c0b3e-4a2d-4c1b-9e8f-1a2b3c4d5e6f" }, triggers: ["all_pages"] },
          { id: "img", type: "image_pixel", params: { url: "https://px.example.net/i?q={{q}}&v={{v}}" }, triggers: ["p"] },
          {
            id: "g",
            type: "ga4",
            params: { measurement_id: "G-ABC123XYZ", config_params: { cookie_prefix: "shop", user_id: "{{q}}" } },
            triggers: ["all_pages"],
          },
          { id: "ads", type: "google_ads", params: { conversion_id: "AW-123456789" }, triggers: ["all_pages"] },
        ],
        conversions: [
          {
            name: "purchase",
            trigger: "p",
            value: "v",
            currency: "USD",
            items: "items",
            send_to: { snap: { event_name: "PURCHASE" }, google_ads: { remarketing: true } },
          },
        ],
      }),
    );
    const snap = ((b.win.snaptr as { queue: ArrayLike<unknown>[] }).queue ?? []).map((a) => Array.from(a));
    expect(snap[0]).toEqual(["init", "6f5c0b3e-4a2d-4c1b-9e8f-1a2b3c4d5e6f", {}]);
    expect(snap[1]).toEqual(["track", "PAGE_VIEW", {}]);
    const conv = b.fetches.find((f) => f.body.type === "conversion")!;
    expect(snap.find((c) => c[1] === "PURCHASE")![2]).toMatchObject({
      price: 20,
      currency: "USD",
      client_dedup_id: conv.body.event_id,
      item_ids: ["S1", "S2"],
    });
    expect(conv.body.fired).toEqual(["snap_pixel", "google_ads"]);
    const img = log(b.win).find((l) => l.msg === "image pixel img")!.data!.url as string;
    expect(img).toMatch(/^https:\/\/px\.example\.net\/i\?q=a%20b&v=20&afst_cb=[a-z0-9]+$/);
    expect(gtagCalls(b.win).find((c) => c[0] === "config" && c[1] === "G-ABC123XYZ")![2]).toMatchObject({
      cookie_prefix: "shop",
      user_id: "a b",
      send_page_view: true,
    });
    expect(gtagCalls(b.win).find((c) => c[0] === "event" && c[1] === "purchase")![2]).toEqual({
      send_to: "AW-123456789",
      value: 20,
      items: [
        { id: "S1", google_business_vertical: "retail" },
        { id: "S2", google_business_vertical: "retail" },
      ],
    });
  });
});

describe("preview log and tag telemetry", () => {
  it("preview posts a trace: matched triggers, tags fired / blocked / not fired and why", () => {
    const b = browser("https://shop.test/pricing");
    b.run(
      serve(
        {
          triggers: [
            allPages,
            { id: "thanks", type: "page_view", conditions: [{ var: "page_path", op: "starts_with", value: "/thank-you" }] },
          ],
          tags: [
            { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"], consent: ["ad_storage"] },
            { id: "lead", type: "custom_js", params: { code: "1" }, triggers: ["thanks"] },
          ],
          consent: { mode: "opt_in" },
        },
        { preview: "prv_abcdefghijklmnopqrstuvwx" },
      ),
    );
    const debug = b.fetches.filter((f) => f.body.type === "debug").flatMap((f) => f.body.entries as Record<string, unknown>[]);
    const pv = debug.find((e) => e.event === "page_view")!;
    expect(pv.page).toBe("/pricing");
    expect(pv.triggers).toEqual([
      { id: "all_pages", matched: true },
      { id: "thanks", matched: false, reason: 'page_path "/pricing" fails starts_with "/thank-you"' },
    ]);
    expect(pv.tags).toEqual([
      { id: "meta", type: "meta_pixel", status: "blocked", reason: "waits for consent: ad_storage", trigger: "all_pages" },
      { id: "lead", type: "custom_js", status: "not_fired", reason: 'trigger thanks: page_path "/pricing" fails starts_with "/thank-you"' },
    ]);
    expect(b.fetches.find((f) => f.body.type === "debug")!.body.preview).toBe("prv_abcdefghijklmnopqrstuvwx");
  });

  it("report_tag_fires sends per-tag counts (not in preview)", () => {
    const b = browser("https://shop.test/");
    const cfg: ContainerConfig = {
      triggers: [allPages],
      tags: [
        { id: "ok", type: "custom_js", params: { code: "1" }, triggers: ["all_pages"] },
        { id: "boom", type: "custom_js", params: { code: "throw new Error('x')" }, triggers: ["all_pages"] },
      ],
      settings: { report_tag_fires: true },
    };
    b.run(serve(cfg));
    const fires = b.fetches.filter((f) => f.body.type === "tags").flatMap((f) => f.body.fires as unknown[]);
    expect(fires).toEqual(
      expect.arrayContaining([
        { tag_id: "ok", status: "fired", n: 1 },
        { tag_id: "boom", status: "error", n: 1 },
      ]),
    );
    const p = browser("https://shop.test/");
    p.run(serve(cfg, { preview: "prv_abcdefghijklmnopqrstuvwx" }));
    expect(p.fetches.some((f) => f.body.type === "tags")).toBe(false);
  });
});

describe("extension bundle", () => {
  it("is served only when the config needs it", () => {
    expect(needsExt({ triggers: [allPages] })).toBe(false);
    expect(needsExt({ triggers: [{ id: "v", type: "video", statuses: ["start"] }] })).toBe(true);
    expect(needsExt({ settings: { cross_domain: ["a.example.net"] } })).toBe(true);
    expect(needsExt({ consent: { tcf: true } })).toBe(true);
    expect(needsExt({ triggers: [{ id: "c", type: "click", wait_for_tags_ms: 500 }] })).toBe(true);
  });

  it("wait_for_tags_ms holds a link click until the tags' scripts settle, then navigates", () => {
    const a = el("a", { href: "https://shop.test/next" });
    (a as unknown as { href: string }).href = "https://shop.test/next";
    const b = browser("https://shop.test/", { body: [a], manualTimers: true });
    b.run(
      serve({
        triggers: [{ id: "out", type: "click", links_only: true, wait_for_tags_ms: 1000 }],
        tags: [{ id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456", event_name: "Lead" }, triggers: ["out"] }],
      }),
    );
    const e = b.dispatch("click", a);
    expect(e.defaultPrevented).toBe(true);
    expect(fbq(b.win).some((c) => c[2] === "Lead")).toBe(true);
    const fbevents = b.doc.head.querySelectorAll("script").find((s) => String(s.src).includes("fbevents"))!;
    fbevents.onload!();
    b.flushTimers();
    expect((b.win.location as { href: string }).href).toBe("https://shop.test/next");
  });

  it("wait_for_tags_ms on a form resubmits it with the prototype's submit()", () => {
    const form = el("form", { id: "f" });
    const b = browser("https://shop.test/", { body: [form] });
    b.run(
      serve({
        triggers: [{ id: "sub", type: "form_submit", wait_for_tags_ms: 300 }],
        tags: [{ id: "t", type: "custom_js", params: { code: "1" }, triggers: ["sub"] }],
      }),
    );
    expect(b.dispatch("submit", form).defaultPrevented).toBe(true);
    expect(b.submitted).toEqual([form]);
  });

  it("cross-domain: decorates links to listed hosts and adopts the visitor on the other side", () => {
    const out = el("a", { href: "https://checkout.example.net/cart" });
    (out as unknown as { href: string }).href = "https://checkout.example.net/cart";
    const other = el("a", { href: "https://elsewhere.example.org/" });
    (other as unknown as { href: string }).href = "https://elsewhere.example.org/";
    const cfg: ContainerConfig = { triggers: [allPages], settings: { cross_domain: ["checkout.example.net"] } };
    const b = browser("https://shop.test/?gclid=GCLID-1", { body: [out, other] });
    b.run(serve(cfg));
    b.dispatch("mousedown", out);
    b.dispatch("mousedown", other);
    const href = (out as unknown as { href: string }).href;
    expect(href).toMatch(/^https:\/\/checkout\.example\.net\/cart\?_afst=1\.[a-f0-9]{10}\./);
    expect((other as unknown as { href: string }).href).toBe("https://elsewhere.example.org/");
    const vid = b.jar._afst_vid;

    const c = browser(href);
    c.run(serve(cfg));
    expect(c.jar._afst_vid).toBe(vid);
    expect(c.jar._afst_gclid).toBe("GCLID-1");
    // A stale or foreign link value is ignored.
    expect(readLinker(linkerValue({ v: "abcdef.1" }, "test", Date.now() - 10 * 60_000), "test", Date.now())).toBeNull();
    expect(readLinker(linkerValue({ v: "abcdef.1" }, "other-ua", Date.now()), "test", Date.now())).toBeNull();
  });

  it("TCF v2: purposes map to consent; the TC string rides along", () => {
    expect(tcfConsent({ purpose: { consents: { 1: true, 7: true } } })).toEqual({
      ad_storage: "granted",
      analytics_storage: "denied",
      ad_user_data: "granted",
      ad_personalization: "denied",
    });
    const b = browser("https://shop.test/");
    let listener: ((td: unknown, ok: boolean) => void) | undefined;
    (b.win as Win).__tcfapi = (_c: string, _v: number, cb: (td: unknown, ok: boolean) => void) => {
      listener = cb;
    };
    b.run(
      serve({
        triggers: [allPages, { id: "p", type: "custom_event", event: "purchase" }],
        tags: [{ id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] }],
        conversions: [{ name: "purchase", trigger: "p", send_to: { meta: { event_name: "Lead" } } }],
        consent: { mode: "opt_in", tcf: true },
      }),
    );
    expect(b.win.fbq).toBeUndefined();
    listener!(
      {
        gdprApplies: true,
        eventStatus: "useractioncomplete",
        tcString: "CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA",
        purpose: { consents: { 1: true, 3: true, 4: true, 7: true, 8: true } },
      },
      true,
    );
    expect(fbq(b.win).some((c) => c[2] === "PageView")).toBe(true);
    (b.win.dataLayer as unknown[]).push({ event: "purchase" });
    expect(b.fetches.find((f) => f.body.type === "conversion")!.body.tcf).toEqual({
      gdpr_applies: true,
      tc_string: "CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA",
    });
  });

  it('user_data "auto" hashes the submitted form\'s email and phone; js_error triggers carry error built-ins', () => {
    const email = el("input", { type: "email", name: "work_email" });
    email.value = "Lead@Example.com";
    const phone = el("input", { name: "phone" });
    phone.value = "+1 650 555 1212";
    const form = el("form", { id: "f" }, [email, phone]);
    const b = browser("https://shop.test/", { body: [form] });
    b.run(
      serve({
        triggers: [
          { id: "sub", type: "form_submit" },
          { id: "err", type: "js_error" },
        ],
        tags: [
          {
            id: "e",
            type: "ga4",
            params: {
              measurement_id: "G-ABC123XYZ",
              event_name: "js_error",
              event_params: { m: "{{error_message}}", l: "{{error_line}}" },
            },
            triggers: ["err"],
          },
        ],
        conversions: [{ name: "lead", trigger: "sub", user_data: "auto", send_to: { analytics: {} }, server: true }],
      }),
    );
    b.dispatch("submit", form);
    expect(b.fetches.find((f) => f.body.type === "conversion")!.body.user_data).toMatchObject({
      em: sha256HexSync("lead@example.com"),
      ph_e164: sha256HexSync("+16505551212"),
    });
    b.winFire("error", { message: "boom", filename: "https://shop.test/app.js", lineno: 7 });
    expect(gtagCalls(b.win).find((c) => c[0] === "event" && c[1] === "js_error")![2]).toMatchObject({ m: "boom", l: 7 });
  });

  it("video: HTML5 start, progress thresholds and complete", () => {
    const v = el("video", { title: "Demo" }) as unknown as Record<string, unknown>;
    Object.assign(v, { duration: 100, currentTime: 0, currentSrc: "https://cdn.example.net/demo.mp4" });
    const b = browser("https://shop.test/", { body: [v as never] });
    b.run(
      serve({
        triggers: [{ id: "vid", type: "video", statuses: ["start", "progress", "complete"], percentages: [25, 50] }],
        tags: [
          {
            id: "t",
            type: "ga4",
            params: {
              measurement_id: "G-ABC123XYZ",
              event_name: "video",
              event_params: { s: "{{video_status}}", p: "{{video_percent}}", t: "{{video_title}}" },
            },
            triggers: ["vid"],
          },
        ],
      }),
    );
    b.dispatch("play", v as never);
    v.currentTime = 30;
    b.dispatch("timeupdate", v as never);
    v.currentTime = 60;
    b.dispatch("timeupdate", v as never);
    b.dispatch("timeupdate", v as never);
    b.dispatch("ended", v as never);
    const calls = gtagCalls(b.win)
      .filter((c) => c[0] === "event" && c[1] === "video")
      .map((c) => `${(c[2] as { s: string }).s}:${(c[2] as { p: number }).p}`);
    expect(calls).toEqual(["start:0", "progress:25", "progress:50", "complete:60"]);
  });
});

describe("settings.respect_dnt: Global Privacy Control and Do Not Track", () => {
  const cfg: ContainerConfig = {
    triggers: [allPages, { id: "p", type: "custom_event", event: "purchase" }],
    tags: [
      { id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] },
      { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
    ],
    conversions: [{ name: "purchase", trigger: "p", send_to: { meta: { event_name: "Purchase" } }, server: true }],
  };
  const run = (opts: Parameters<typeof browser>[1], config: ContainerConfig = cfg) => {
    const b = browser("https://shop.test/landing?gclid=TEST-GCLID-1", opts);
    b.run(serve(config));
    (b.win.dataLayer as unknown[] | undefined)?.push({ event: "purchase" });
    return b;
  };
  const nothingRan = (b: ReturnType<typeof browser>) => {
    expect(b.fetches).toEqual([]); // no /collect
    expect(Object.keys(b.jar)).toEqual([]); // no cookies (visitor id, click ids, consent)
    expect(b.scripts().filter((s) => !String(s).includes("/c/"))).toEqual([]); // no vendor scripts
    expect(b.win.fbq).toBeUndefined();
    expect(gtagCalls(b.win)).toEqual([]);
    expect(b.session).toEqual({});
    // The page's own afst() calls (a consent banner) still work: a no-op.
    expect(typeof b.win.afst).toBe("function");
    expect((b.win.afst as (...a: unknown[]) => unknown)("consent", "update", { ad_storage: "granted" })).toBeUndefined();
  };

  it("navigator.globalPrivacyControl: nothing runs", () => {
    const b = run({ navigator: { globalPrivacyControl: true } });
    nothingRan(b);
    expect(log(b.win).some((l) => /respect_dnt/.test(l.msg))).toBe(true);
  });
  it('doNotTrack "1" (navigator or the legacy window property): nothing runs', () => {
    nothingRan(run({ navigator: { doNotTrack: "1" } }));
    nothingRan(run({ window: { doNotTrack: "1" } }));
  });
  it('without a signal, or with doNotTrack "0", tags and /collect run as usual', () => {
    for (const nav of [{}, { doNotTrack: "0", globalPrivacyControl: false }]) {
      const b = run({ navigator: nav });
      expect(b.fetches.some((f) => f.body.type === "conversion")).toBe(true);
      expect(Object.keys(b.jar)).toContain("_afst_vid");
      expect(fbq(b.win).length).toBeGreaterThan(0);
    }
  });
  it("respect_dnt: false runs anyway", () => {
    const b = run({ navigator: { globalPrivacyControl: true } }, { ...cfg, settings: { respect_dnt: false } });
    expect(b.fetches.some((f) => f.body.type === "conversion")).toBe(true);
    expect(fbq(b.win).length).toBeGreaterThan(0);
  });
});

describe("the analytics tag marks preview traffic as analytics test traffic", () => {
  const cfg: ContainerConfig = {
    triggers: [allPages, { id: "p", type: "custom_event", event: "sign_up" }],
    tags: [
      {
        id: "an",
        type: "analytics",
        params: { site_id: "site_abc123", base_url: "https://analytics.example.net" },
        triggers: ["all_pages"],
      },
    ],
    conversions: [{ name: "sign_up", trigger: "p", send_to: { analytics: { event_name: "sign_up" } } }],
  };
  const analyticsScript = (b: ReturnType<typeof browser>) =>
    b.doc.querySelectorAll("script").find((x) => String(x.src ?? x.attrs.src).includes("/s.js"));
  it("preview: afsa('debug') before anything else, and data-debug on the tracker", () => {
    const b = browser("https://shop.test/");
    b.run(serve(cfg, { preview: "prv_aaaaaaaaaaaaaaaaaaaaaaaa" }));
    (b.win.dataLayer as unknown[]).push({ event: "sign_up" });
    const q = ((b.win.afsa as { q?: ArrayLike<unknown>[] }).q ?? []).map((a) => Array.from(a));
    expect(q[0]).toEqual(["debug"]);
    expect(q.some((c) => c[0] === "event" && c[1] === "sign_up")).toBe(true);
    expect(analyticsScript(b)?.attrs["data-debug"]).toBe("true");
  });
  it("live: no debug flag", () => {
    const b = browser("https://shop.test/");
    b.run(serve(cfg));
    (b.win.dataLayer as unknown[]).push({ event: "sign_up" });
    const q = ((b.win.afsa as { q?: ArrayLike<unknown>[] }).q ?? []).map((a) => Array.from(a));
    expect(q.some((c) => c[0] === "debug")).toBe(false);
    expect(analyticsScript(b)?.attrs["data-debug"]).toBeUndefined();
  });
});
