/**
 * Runs the real bundled runtime, served exactly as /c/:id.js would serve it (compileScript), in a
 * small fake window/document (neither jsdom nor happy-dom is installed). Checks dataLayer
 * handling, triggers, consent gating, the event_id shared by pixels and /collect, and click-id
 * cookie capture.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bundleRuntime } from "../scripts/build-runtime.mjs";
import type { ContainerConfig } from "../src/config/schema";
import { sha256HexSync } from "../src/lib/sha256";
import { compileScript } from "../src/service/script";

let RUNTIME = "";
beforeAll(async () => {
  RUNTIME = await bundleRuntime();
});

const CID = "ctr_abcdefgh12345678";
const BASE = "https://tags.example.net";

interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  children: FakeEl[];
  parentNode?: FakeEl;
  src?: string;
  async?: boolean;
  value?: string;
  text?: string;
  textContent?: string;
  style: Record<string, string>;
  innerHTML?: string;
  nodeType: number;
  onload?: () => void;
  onerror?: () => void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  insertBefore(c: FakeEl, ref: FakeEl): FakeEl;
  matches(sel: string): boolean;
  closest(sel: string): FakeEl | null;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
}

/** Minimal selector support: tag, #id, .class, [attr], [attr=value], [attr^=value], comma lists. */
function matchesSel(el: FakeEl, sel: string): boolean {
  return sel.split(",").some((part) => {
    const s = part.trim();
    const m = /^([a-z]+)?(#[\w-]+)?(\.[\w-]+)?(\[([\w-]+)(?:(\^?=)['"]?([^'"\]]*)['"]?)?\])?$/i.exec(s);
    if (!m) return false;
    const [, tag, id, cls, , attr, op, val] = m;
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    if (id && el.attrs.id !== id.slice(1)) return false;
    if (cls && !(el.attrs.class ?? "").split(/\s+/).includes(cls.slice(1))) return false;
    if (attr) {
      const v = el.attrs[attr];
      if (v === undefined) return false;
      if (op === "=" && v !== val) return false;
      if (op === "^=" && !v.startsWith(val ?? "")) return false;
    }
    return true;
  });
}

function el(tagName: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
  const e: FakeEl = {
    tagName: tagName.toUpperCase(),
    attrs: { ...attrs },
    children: [],
    style: {},
    nodeType: 1,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? 0 : i, 0, c);
      return c;
    },
    matches(sel) {
      return matchesSel(this, sel);
    },
    closest(sel) {
      let cur: FakeEl | undefined = this;
      while (cur) {
        if (cur.nodeType === 1 && matchesSel(cur, sel)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out: FakeEl[] = [];
      const walk = (n: FakeEl) => {
        for (const c of n.children) {
          if (matchesSel(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    },
  };
  for (const c of children) e.appendChild(c);
  return e;
}

function browser(url: string, opts: { cookies?: Record<string, string>; scriptSrc?: string; dataLayer?: unknown[]; body?: FakeEl[] } = {}) {
  const u = new URL(url);
  const jar: Record<string, string> = { ...(opts.cookies ?? {}) };
  const fetches: { url: string; body: Record<string, unknown>; init: Record<string, unknown> }[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const winListeners: Record<string, ((e: unknown) => void)[]> = {};
  const session: Record<string, string> = {};
  const body = el("body", {}, opts.body ?? []);
  const head = el("head");
  const html = el("html", {}, [head, body]);
  const self = el("script", { src: opts.scriptSrc ?? `${BASE}/c/${CID}.js` });
  self.src = self.attrs.src;
  head.appendChild(self);
  const doc = {
    get cookie() {
      return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
    set cookie(c: string) {
      const [pair, ...attrs] = c.split(";");
      const i = pair!.indexOf("=");
      const k = pair!.slice(0, i).trim();
      const v = pair!.slice(i + 1);
      if (attrs.some((a) => /max-age=0\b/i.test(a.trim()))) delete jar[k];
      else jar[k] = v;
    },
    currentScript: self,
    referrer: "https://www.google.com/",
    title: "Test page",
    readyState: "complete",
    head,
    body,
    documentElement: html,
    createElement: (t: string) => el(t),
    getElementsByTagName: (t: string) => html.querySelectorAll(t),
    querySelectorAll: (s: string) => html.querySelectorAll(s),
    querySelector: (s: string) => html.querySelector(s),
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f),
  };
  const win: Record<string, unknown> = {
    document: doc,
    location: {
      href: u.href,
      search: u.search,
      pathname: u.pathname,
      hostname: u.hostname,
      host: u.host,
      protocol: u.protocol,
      origin: u.origin,
    },
    navigator: { userAgent: "test" },
    sessionStorage: {
      getItem: (k: string) => session[k] ?? null,
      setItem: (k: string, v: string) => {
        session[k] = v;
      },
      removeItem: (k: string) => {
        delete session[k];
      },
    },
    history: { pushState() {}, replaceState() {} },
    addEventListener: (t: string, f: (e: unknown) => void) => (winListeners[t] ??= []).push(f),
    setTimeout: (f: () => void) => {
      f();
      return 1;
    },
    setInterval: () => 1,
    clearInterval: () => undefined,
    innerHeight: 800,
    scrollY: 0,
    fetch: (url: string, init: Record<string, unknown>) => {
      fetches.push({ url, body: JSON.parse(String(init.body)), init });
      return Promise.resolve({ ok: true });
    },
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
  };
  win.window = win;
  if (opts.dataLayer) win.dataLayer = opts.dataLayer;
  const run = (script: string) => {
    // `with` makes the fake window the global scope for the served script.
    // eslint-disable-next-line no-new-func
    new Function("__w", `with (__w) { ${script} }`)(win);
  };
  const dispatch = (type: string, target: FakeEl) => {
    for (const f of listeners[type] ?? []) f({ type, target });
  };
  const scripts = () => html.querySelectorAll("script").map((s) => s.src ?? s.attrs.src);
  return { win, doc, jar, fetches, run, dispatch, scripts, session };
}

function serve(cfg: ContainerConfig, opts: { geo?: { country?: string; region?: string }; preview?: string } = {}) {
  return compileScript(
    RUNTIME,
    { id: CID, v: opts.preview ? "draft" : 3, d: "shop.test", cfg, base: BASE, ...(opts.preview ? { preview: opts.preview } : {}) },
    opts.geo ?? { country: "US", region: "CA" },
  );
}

const purchaseConfig: ContainerConfig = {
  variables: [
    { name: "order_value", type: "data_layer", key: "ecommerce.value" },
    { name: "order_currency", type: "data_layer", key: "ecommerce.currency" },
    { name: "order_id", type: "data_layer", key: "ecommerce.transaction_id" },
    { name: "email", type: "data_layer", key: "user.email" },
  ],
  triggers: [
    { id: "all_pages", type: "page_view" },
    { id: "purchase_dl", type: "custom_event", event: "purchase" },
  ],
  tags: [
    { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
    { id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] },
    { id: "tiktok", type: "tiktok_pixel", params: { pixel_id: "C1A2B3C4D5E6F7G8H9I0" }, triggers: ["all_pages"] },
  ],
  conversions: [
    {
      name: "purchase",
      trigger: "purchase_dl",
      value: "order_value",
      currency: { var: "order_currency" },
      transaction_id: "order_id",
      user_data: { email: "email" },
      send_to: { meta: { event_name: "Purchase" }, ga4: { event_name: "purchase" }, tiktok: { event_name: "CompletePayment" } },
      server: true,
    },
  ],
};

type Q = unknown[][];
const fbqCalls = (win: Record<string, unknown>) => ((win.fbq as { queue: ArrayLike<unknown>[] }).queue ?? []).map((a) => Array.from(a));
const gtagCalls = (win: Record<string, unknown>) =>
  ((win.dataLayer as unknown[]) ?? [])
    .filter((x) => Object.prototype.toString.call(x) === "[object Arguments]")
    .map((a) => Array.from(a as ArrayLike<unknown>));

describe("runtime: served /c/:id.js in a simulated browser", () => {
  it("processes dataLayer entries pushed before load, then wrapped pushes; one event_id across pixels and /collect", () => {
    const b = browser("https://shop.test/thank-you", {
      dataLayer: [
        {
          event: "purchase",
          ecommerce: { value: "1,234.50", currency: "usd", transaction_id: "T-1" },
          user: { email: " Jane@Example.com " },
        },
      ],
    });
    b.run(serve(purchaseConfig));
    const w = b.win;

    // Base tags fired on page_view, before the queued purchase.
    const fbq = fbqCalls(w);
    expect(fbq[0]).toEqual(["init", "1234567890123456", {}]);
    expect(fbq[1]).toEqual(["trackSingle", "1234567890123456", "PageView", {}]);
    expect(gtagCalls(w).some((c) => c[0] === "config" && c[1] === "G-ABC123XYZ")).toBe(true);
    expect(gtagCalls(w).find((c) => c[0] === "consent")).toEqual([
      "consent",
      "default",
      expect.objectContaining({ ad_storage: "granted" }),
    ]);

    // The purchase: same event_id in fbq eventID, ttq event_id, gtag transaction id fallback and /collect.
    const purchase = fbq.find((c) => c[2] === "Purchase")!;
    const eventId = (purchase[4] as { eventID: string }).eventID;
    expect(eventId).toMatch(/^[a-z0-9]+\.[a-z0-9]{14}$/);
    expect(purchase[3]).toMatchObject({ value: 1234.5, currency: "USD", order_id: "T-1" });
    const ttq = (w.ttq as { _i: Record<string, unknown[][]> })._i["C1A2B3C4D5E6F7G8H9I0"]!;
    const ttTrack = ttq.find((c) => c[0] === "track")!;
    expect(ttTrack).toEqual([
      "track",
      "CompletePayment",
      expect.objectContaining({ value: 1234.5, currency: "USD", order_id: "T-1" }),
      { event_id: eventId },
    ]);
    const gaPurchase = gtagCalls(w).find((c) => c[0] === "event" && c[1] === "purchase")!;
    expect(gaPurchase[2]).toMatchObject({
      value: 1234.5,
      currency: "USD",
      transaction_id: "T-1",
      event_id: eventId,
      send_to: "G-ABC123XYZ",
    });

    const conv = b.fetches.find((f) => f.body.type === "conversion")!;
    expect(conv.url).toBe(`${BASE}/collect`);
    expect(conv.init.headers).toEqual({ "content-type": "text/plain" });
    expect(conv.body).toMatchObject({
      container_id: CID,
      event_id: eventId,
      name: "purchase",
      value: 1234.5,
      currency: "USD",
      transaction_id: "T-1",
      user_data: { em: sha256HexSync("jane@example.com") },
      fired: ["meta_pixel", "ga4", "tiktok_pixel"],
    });
    expect(JSON.stringify(b.fetches)).not.toContain("jane@example.com");

    // A later push goes through the wrapped dataLayer.push with nested key lookup.
    (w.dataLayer as unknown[]).push({ event: "purchase", ecommerce: { value: 20, transaction_id: "T-2" } });
    const second = b.fetches.filter((f) => f.body.type === "conversion")[1]!;
    expect(second.body).toMatchObject({ value: 20, currency: "USD", transaction_id: "T-2" }); // currency kept from the merged model
    expect(second.body.event_id).not.toBe(eventId);
    // Meta advanced matching got the hashed email.
    expect(fbqCalls(w).some((c) => c[0] === "init" && (c[2] as { em?: string }).em === sha256HexSync("jane@example.com"))).toBe(true);
  });

  it("captures click ids and UTMs into first-party cookies and the landing /collect hit", () => {
    const b = browser("https://shop.test/landing?gclid=Cj0KCQabc123&fbclid=FBCLIDxyz&utm_source=google&utm_campaign=spring");
    b.run(serve(purchaseConfig));
    expect(b.jar._afst_gclid).toBe("Cj0KCQabc123");
    expect(b.jar._fbc).toMatch(/^fb\.1\.\d{13}\.FBCLIDxyz$/);
    expect(b.jar._fbp).toMatch(/^fb\.1\.\d{13}\.\d{10}$/);
    expect(b.jar._afst_vid).toMatch(/^[a-z0-9]{16}\.\d{10}$/);
    expect(JSON.parse(decodeURIComponent(b.jar._afst_ft!))).toMatchObject({
      utm_source: "google",
      utm_campaign: "spring",
      click_ids: "gclid,fbclid",
    });
    const visit = b.fetches.find((f) => f.body.type === "visit")!;
    expect(visit.body).toMatchObject({
      visitor_id: b.jar._afst_vid,
      click_ids: { gclid: "Cj0KCQabc123", fbclid: "FBCLIDxyz" },
      utm: { utm_source: "google", utm_campaign: "spring" },
      new_visitor: true,
    });

    // Next page view (same tab): click id comes from the cookie; no new visit hit.
    const b2 = browser("https://shop.test/pricing", { cookies: { ...b.jar } });
    b2.session[`_afst_s_${CID}`] = "1";
    b2.run(serve(purchaseConfig));
    expect(b2.fetches.filter((f) => f.body.type === "visit")).toHaveLength(0);
    (b2.win.dataLayer as unknown[]).push({ event: "purchase", ecommerce: { value: 5, currency: "EUR" } });
    expect(b2.fetches[0]!.body).toMatchObject({ click_ids: { gclid: "Cj0KCQabc123" }, visitor_id: b.jar._afst_vid });
  });

  it("fires triggers only when conditions match", () => {
    const cfg: ContainerConfig = {
      triggers: [{ id: "thanks", type: "page_view", conditions: [{ var: "page_path", op: "starts_with", value: "/thank-you" }] }],
      tags: [{ id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456", event_name: "Lead" }, triggers: ["thanks"] }],
    };
    const a = browser("https://shop.test/pricing");
    a.run(serve(cfg));
    expect(a.win.fbq).toBeUndefined();
    const b = browser("https://shop.test/thank-you?x=1");
    b.run(serve(cfg));
    expect(fbqCalls(b.win).find((c) => c[0] === "trackSingle")).toEqual(["trackSingle", "1234567890123456", "Lead", {}]);
  });

  it("form_submit trigger reads the email from the submitted form and hashes it synchronously", () => {
    const email = el("input", { type: "email", name: "email" });
    email.value = "Lead@Example.COM";
    const form = el("form", { id: "contact" }, [email]);
    const b = browser("https://shop.test/contact", { body: [form] });
    b.run(
      serve({
        variables: [{ name: "lead_email", type: "dom_value", selector: "input[type=email]" }],
        triggers: [{ id: "lead_form", type: "form_submit", selector: "form#contact" }],
        conversions: [
          {
            name: "lead",
            trigger: "lead_form",
            user_data: { email: "lead_email" },
            send_to: { analytics: { event_name: "lead" } },
            server: true,
          },
        ],
      }),
    );
    b.dispatch("submit", form);
    const conv = b.fetches.find((f) => f.body.type === "conversion")!;
    expect(conv.body).toMatchObject({ name: "lead", user_data: { em: sha256HexSync("lead@example.com") } });
  });

  it("consent: EEA visitors are blocked until granted; Consent Mode v2 passthrough; queued tags then fire", () => {
    const cfg: ContainerConfig = {
      ...purchaseConfig,
      consent: {
        mode: "none",
        regions: { EEA: { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" } },
      },
    };
    const b = browser("https://shop.test/?gclid=G123", {
      dataLayer: [{ event: "purchase", ecommerce: { value: 9, currency: "EUR" }, user: { email: "x@example.com" } }],
    });
    b.run(serve(cfg, { geo: { country: "DE" } }));
    const w = b.win;
    expect(w.fbq).toBeUndefined();
    expect(b.jar._afst_gclid).toBeUndefined();
    expect(b.jar._afst_vid).toBeUndefined();
    expect(gtagCalls(w).find((c) => c[0] === "consent")).toEqual([
      "consent",
      "default",
      expect.objectContaining({ ad_storage: "denied", analytics_storage: "denied", ad_user_data: "denied" }),
    ]);
    const conv = b.fetches.find((f) => f.body.type === "conversion")!;
    expect(conv.body.user_data).toEqual({});
    expect(conv.body.visitor_id).toBeUndefined();
    expect(conv.body.consent).toMatchObject({ ad_storage: "denied" });

    (w.afst as (...a: unknown[]) => void)("consent", "update", { ad_storage: "granted", analytics_storage: "granted" });
    expect(gtagCalls(w).find((c) => c[0] === "consent" && c[1] === "update")).toEqual([
      "consent",
      "update",
      expect.objectContaining({ ad_storage: "granted", ad_user_data: "granted" }),
    ]);
    expect(fbqCalls(w).some((c) => c[2] === "PageView")).toBe(true);
    expect(fbqCalls(w).some((c) => c[2] === "Purchase")).toBe(true); // released from the consent queue
    expect(b.jar._afst_gclid).toBe("G123");
    expect(JSON.parse(decodeURIComponent(b.jar._afst_consent!))).toMatchObject({ ad_storage: "granted" });
  });

  it("follows a CMP's gtag('consent','update') from the dataLayer", () => {
    const b = browser("https://shop.test/");
    b.run(serve({ ...purchaseConfig, consent: { mode: "opt_in" } }));
    expect(b.win.fbq).toBeUndefined();
    const dl = b.win.dataLayer as unknown[];
    (function (..._a: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      dl.push(arguments);
    })("consent", "update", { ad_storage: "granted", analytics_storage: "granted" });
    expect(fbqCalls(b.win).some((c) => c[2] === "PageView")).toBe(true);
  });

  it("preview: ?afst_preview hands off to the draft build; the draft build runs with debug logging", () => {
    const b = browser("https://shop.test/?afst_preview=prv_abcdefghijklmnopqrstuvwx");
    b.run(serve(purchaseConfig));
    expect(b.scripts()).toContain(`${BASE}/c/${CID}.js?preview=prv_abcdefghijklmnopqrstuvwx`);
    expect(b.win.fbq).toBeUndefined();
    expect(b.session[`_afst_preview_${CID}`]).toBe("prv_abcdefghijklmnopqrstuvwx");

    b.run(serve(purchaseConfig, { preview: "prv_abcdefghijklmnopqrstuvwx" }));
    expect(fbqCalls(b.win).some((c) => c[2] === "PageView")).toBe(true);
    const log = b.win.__afst_debug as { msg: string }[];
    expect(log.some((l) => l.msg.includes("PREVIEW"))).toBe(true);
    expect(b.fetches.find((f) => f.body.type === "visit")!.body.preview).toBe("prv_abcdefghijklmnopqrstuvwx");
  });

  it("first-party proxy: posts to <prefix>/collect next to the script", () => {
    const b = browser("https://shop.test/thank-you", {
      scriptSrc: "https://shop.test/_t/c/ctr_abcdefgh12345678.js",
      dataLayer: [{ event: "purchase", ecommerce: { value: 1, currency: "USD" } }],
    });
    b.run(serve(purchaseConfig));
    const conv = b.fetches.find((f) => f.body.type === "conversion")!;
    expect(conv.url).toBe("https://shop.test/_t/collect");
    expect(conv.body).toMatchObject({ first_party: true, cookie_domain: "shop.test" });
    expect(conv.init.credentials).toBe("include");
  });

  it("custom_html: a malicious url_param can't inject markup or script (DOM XSS)", () => {
    const attack = `"><img src=x onerror=alert(1)></script><script>alert(2)</script>`;
    const b = browser(`https://shop.test/landing?q=${encodeURIComponent(attack)}&next=${encodeURIComponent("javascript:alert(3)")}`);
    b.run(
      serve({
        variables: [
          { name: "q", type: "url_param", param: "q" },
          { name: "next", type: "url_param", param: "next" },
        ],
        triggers: [{ id: "all_pages", type: "page_view" }],
        tags: [
          {
            id: "banner",
            type: "custom_html",
            params: {
              html: `<div class="promo" title="{{q}}">Hi {{q}} <a href="{{next}}">go</a></div><script>window.promo = "{{q}}";</script>`,
            },
            triggers: ["all_pages"],
          },
        ],
      }),
    );
    const holder = b.doc.body.querySelector("[data-afst-tag=banner]")!;
    const html = holder.innerHTML!;
    // The owner's template markup is intact; the value contributes no tags, quotes or parentheses.
    expect(html.startsWith(`<div class="promo" title="&#34;&#62;&#60;img&#32;src&#61;x`)).toBe(true);
    expect(html).toContain(`<script>window.promo = "&#34;&#62;`);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<img|onerror=|alert\(/);
    expect(html).toContain(`<a href="">go</a>`); // javascript: URL dropped
  });

  it("analytics tag: loads the tracker and queues on window.afsa (not sga); /collect carries afsa.visitorId()", () => {
    const cfg: ContainerConfig = {
      variables: [{ name: "order_value", type: "data_layer", key: "ecommerce.value" }],
      triggers: [
        { id: "all_pages", type: "page_view" },
        { id: "purchase_dl", type: "custom_event", event: "purchase" },
      ],
      tags: [
        {
          id: "an",
          type: "analytics",
          params: { site_id: "site_abc123", base_url: "https://analytics.example.net" },
          triggers: ["all_pages"],
        },
      ],
      conversions: [
        {
          name: "purchase",
          trigger: "purchase_dl",
          value: "order_value",
          currency: "USD",
          send_to: { analytics: { event_name: "purchase" } },
          server: true,
        },
      ],
    };
    const b = browser("https://shop.test/thank-you", { dataLayer: [{ event: "purchase", ecommerce: { value: 12 } }] });
    b.run(serve(cfg));
    const w = b.win;
    expect(w.sga).toBeUndefined();
    expect(typeof w.afsa).toBe("function");
    const q = ((w.afsa as { q?: ArrayLike<unknown>[] }).q ?? []).map((a) => Array.from(a));
    expect(q).toContainEqual(["revenue", "purchase", 12, "USD", expect.objectContaining({ event_id: expect.any(String) })]);
    const tracker = b.doc.head.querySelectorAll("script").find((s) => s.src === "https://analytics.example.net/s.js")!;
    expect(tracker.attrs["data-site"]).toBe("site_abc123");
    expect(b.fetches.find((f) => f.body.type === "conversion")!.body.fired).toEqual(["analytics"]);

    // Once the tracker has loaded, its visitor id rides along so the analytics destination joins it.
    const b2 = browser("https://shop.test/thank-you");
    (b2.win as Record<string, unknown>).afsa = Object.assign(function () {}, { visitorId: () => "afsa_vid_123" });
    (b2.win as Record<string, unknown>).sga = Object.assign(function () {}, { visitorId: () => "old_sga_id" });
    b2.run(serve(cfg));
    (b2.win.dataLayer as unknown[]).push({ event: "purchase", ecommerce: { value: 3 } });
    expect(b2.fetches.find((f) => f.body.type === "conversion")!.body.analytics_visitor_id).toBe("afsa_vid_123");
  });

  it("the browser API is window.afst only (no sgt alias) and debug/preview use afst_ query params", () => {
    const b = browser("https://shop.test/?afst_debug=1&sgt_preview=prv_abcdefghijklmnopqrstuvwx");
    b.run(serve(purchaseConfig));
    expect(typeof b.win.afst).toBe("function");
    expect(b.win.sgt).toBeUndefined();
    expect(b.scripts().some((s) => String(s).includes("preview="))).toBe(false); // old param ignored
    expect((b.win.__afst_debug as unknown[]).length).toBeGreaterThan(0);
    expect(Object.keys(b.jar).filter((k) => k.startsWith("_sgt"))).toEqual([]);
    expect(b.jar._afst_vid).toBeTruthy();
  });

  it("honours dataLayer eventCallback when GTM isn't on the page, and the afst() queue stub", () => {
    let called = 0;
    const b = browser("https://shop.test/", { dataLayer: [{ event: "purchase", eventCallback: () => called++ }] });
    (b.win as Record<string, unknown>).afst = Object.assign(function () {}, { q: [["identify", "user_42", { email: "u@example.com" }]] });
    b.run(serve(purchaseConfig));
    expect(called).toBe(1);
    expect((b.win.afst as (...a: unknown[]) => unknown)("get", "visitor_id")).toMatch(/^[a-z0-9]{16}\./);
    (b.win.dataLayer as unknown[]).push({ event: "purchase", ecommerce: { value: 3, currency: "USD" } });
    const last = b.fetches.filter((f) => f.body.type === "conversion").pop()!;
    expect(last.body).toMatchObject({ user_id: "user_42", user_data: { em: sha256HexSync("u@example.com"), external_id: "user_42" } });
  });
});
