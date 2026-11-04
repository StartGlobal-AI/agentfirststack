import type { Conversion, Tag } from "../config/schema";
import type { HashedUserData } from "../lib/pii";
import { sha256HexSync } from "../lib/sha256";
import type { EventCtx } from "./types";

/* Vendor loaders. Each follows the vendor's official snippet (queue stub + async script) so calls
 * made before the library loads are kept, and calls go through the vendor's own queue, which is
 * what a test harness (or a debugging agent) inspects. */

type AnyFn = (...args: unknown[]) => unknown;
type W = Window & Record<string, unknown>;

export interface VendorHost {
  w: W;
  d: Document;
  base: string;
  analyticsBase?: string;
  debug: boolean;
  /** The boot config: preview builds mark analytics traffic as test traffic. */
  boot: { preview?: string };
  loadScript(src: string, attrs?: Record<string, string>): void;
  scriptStatus(src: string): "pending" | "loaded" | "error" | undefined;
  gtag(...args: unknown[]): void;
  interpolate(v: unknown, ctx: EventCtx): unknown;
  /** custom_html templating: every interpolated value HTML-encoded (see util.interpolateHtml). */
  interpolateHtml(template: string, ctx: EventCtx): string;
  /** image_pixel templating: values URL-encoded. */
  interpolateUrl(template: string, ctx: EventCtx): string;
  /** A param_set variable's params (event_params_from / config_params_from). */
  paramSet(name: string | undefined, ctx: EventCtx): Record<string, unknown>;
  log(kind: string, msg: string, data?: unknown): void;
  userHashes(): HashedUserData;
  userId(): string | undefined;
  state: {
    gtagLoaded: boolean;
    gtagConfigured: Record<string, boolean>;
    inited: Record<string, boolean>;
    matching: Record<string, string>;
  };
}

export interface ConversionData {
  event_id: string;
  name: string;
  value?: number;
  currency?: string;
  transaction_id?: string;
  items?: Record<string, unknown>[];
  params: Record<string, unknown>;
  user: HashedUserData;
}

export const GTAG_SRC = "https://www.googletagmanager.com/gtag/js?id=";

function ensureGtag(h: VendorHost, id: string) {
  const w = h.w;
  w.dataLayer = (w.dataLayer as unknown[]) || [];
  if (typeof w.gtag !== "function") {
    w.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      (w.dataLayer as unknown[]).push(arguments);
    };
  }
  if (!h.state.gtagLoaded) {
    h.state.gtagLoaded = true;
    h.loadScript(GTAG_SRC + encodeURIComponent(id));
    h.gtag("js", new Date());
  }
}

function gtagConfig(h: VendorHost, id: string, params: Record<string, unknown>) {
  ensureGtag(h, id);
  if (h.state.gtagConfigured[id]) return false;
  h.state.gtagConfigured[id] = true;
  h.gtag("config", id, params);
  return true;
}

function googleUserData(u: HashedUserData) {
  const ud: Record<string, unknown> = {};
  if (u.em_gads || u.em) ud.sha256_email_address = u.em_gads ?? u.em;
  if (u.ph_e164) ud.sha256_phone_number = u.ph_e164;
  if (u.fn || u.ln || u.zp) {
    const a: Record<string, unknown> = {};
    if (u.fn) a.sha256_first_name = u.fn;
    if (u.ln) a.sha256_last_name = u.ln;
    if (u.zp) a.postal_code = u.zp;
    if (u.country) a.country = u.country.toUpperCase();
    ud.address = a;
  }
  return ud;
}

function ensureFbq(h: VendorHost): AnyFn {
  const w = h.w;
  if (typeof w.fbq !== "function") {
    const n = function (this: unknown) {
      // eslint-disable-next-line prefer-rest-params
      const args = arguments;
      const self = n as unknown as { callMethod?: AnyFn; queue: unknown[] };
      if (self.callMethod) self.callMethod.apply(self, args as unknown as unknown[]);
      else self.queue.push(args);
    } as unknown as AnyFn & Record<string, unknown>;
    w.fbq = n;
    if (!w._fbq) w._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];
    h.loadScript("https://connect.facebook.net/en_US/fbevents.js");
  }
  return w.fbq as AnyFn;
}

function metaMatching(u: HashedUserData, userId?: string) {
  const am: Record<string, string> = {};
  if (u.em) am.em = u.em;
  if (u.ph) am.ph = u.ph;
  if (u.fn) am.fn = u.fn;
  if (u.ln) am.ln = u.ln;
  if (userId) am.external_id = sha256HexSync(userId);
  return am;
}

/** init once; re-init when a conversion brings new hashed user data (Meta's advanced matching). */
function metaInit(h: VendorHost, pixelId: string, advanced: boolean, user?: HashedUserData) {
  const fbq = ensureFbq(h);
  const key = `meta:${pixelId}`;
  const am = advanced ? metaMatching({ ...h.userHashes(), ...(user ?? {}) }, h.userId()) : {};
  const sig = JSON.stringify(am);
  if (!h.state.inited[key] || (user && Object.keys(am).length && h.state.matching[key] !== sig)) {
    h.state.matching[key] = sig;
    h.state.inited[key] = true;
    fbq("init", pixelId, am);
  }
  return fbq;
}

const META_STANDARD =
  /^(AddPaymentInfo|AddToCart|AddToWishlist|CompleteRegistration|Contact|CustomizeProduct|Donate|FindLocation|InitiateCheckout|Lead|Purchase|Schedule|Search|StartTrial|SubmitApplication|Subscribe|ViewContent|PageView)$/;

const TTQ_METHODS = [
  "page",
  "track",
  "identify",
  "instances",
  "debug",
  "on",
  "off",
  "once",
  "ready",
  "alias",
  "group",
  "enableCookie",
  "disableCookie",
  "holdConsent",
  "revokeConsent",
  "grantConsent",
];

type Ttq = unknown[] & Record<string, unknown> & { instance(id: string): Record<string, AnyFn> };

function ensureTtq(h: VendorHost, pixelId: string): Record<string, AnyFn> {
  const w = h.w;
  if (!w.ttq) {
    w.TiktokAnalyticsObject = "ttq";
    const ttq = [] as unknown as Ttq;
    w.ttq = ttq;
    const setAndDefer = (t: Record<string, unknown> & unknown[], e: string) => {
      t[e] = function () {
        // eslint-disable-next-line prefer-rest-params
        t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
      };
    };
    ttq.methods = TTQ_METHODS;
    for (const m of TTQ_METHODS) setAndDefer(ttq, m);
    ttq.instance = function (t: string) {
      const store = (ttq._i as Record<string, unknown[] & Record<string, unknown>>) || {};
      const e = store[t] || ([] as unknown as unknown[] & Record<string, unknown>);
      for (const m of TTQ_METHODS) setAndDefer(e, m);
      return e as unknown as Record<string, AnyFn>;
    };
    ttq.load = function (e: string, n?: Record<string, unknown>) {
      const r = "https://analytics.tiktok.com/i18n/pixel/events.js";
      ttq._i = (ttq._i as Record<string, unknown>) || {};
      (ttq._i as Record<string, unknown>)[e] = Object.assign([], { _u: r });
      ttq._t = (ttq._t as Record<string, unknown>) || {};
      (ttq._t as Record<string, unknown>)[e] = +new Date();
      ttq._o = (ttq._o as Record<string, unknown>) || {};
      (ttq._o as Record<string, unknown>)[e] = n || {};
      h.loadScript(`${r}?sdkid=${encodeURIComponent(e)}&lib=ttq`);
    };
  }
  const ttq = w.ttq as Ttq;
  const key = `tiktok:${pixelId}`;
  if (!h.state.inited[key]) {
    h.state.inited[key] = true;
    (ttq.load as AnyFn)(pixelId);
  }
  return ttq.instance(pixelId);
}

function ensureQueueFn(h: VendorHost, name: string, src: string, init: (f: AnyFn & Record<string, unknown>) => void) {
  const w = h.w;
  if (typeof w[name] !== "function") {
    const f = function () {
      const self = f as unknown as Record<string, unknown>;
      // eslint-disable-next-line prefer-rest-params
      const args = arguments;
      if (typeof self.exe === "function") (self.exe as AnyFn).apply(self, args as unknown as unknown[]);
      else if (typeof self.sendEvent === "function") (self.sendEvent as AnyFn).apply(self, args as unknown as unknown[]);
      else ((self.queue as unknown[]) || ((self.queue = []) as unknown[])).push(args);
    } as unknown as AnyFn & Record<string, unknown>;
    f.queue = [];
    init(f);
    w[name] = f;
    h.loadScript(src);
  }
  return w[name] as AnyFn;
}

function ensureUet(h: VendorHost, tagId: string) {
  const w = h.w;
  const key = `uet:${tagId}`;
  if (!h.state.inited[key]) {
    h.state.inited[key] = true;
    w.uetq = (w.uetq as unknown[]) || [];
    h.loadScript("https://bat.bing.com/bat.js", { "data-afst-uet": tagId });
  }
  return w.uetq as { push: AnyFn };
}

/** Called when bat.js loads (UET needs the constructor run with the queue). */
export function uetOnLoad(h: VendorHost, tagId: string) {
  const w = h.w as W & { UET?: new (o: unknown) => unknown };
  if (typeof w.UET !== "function") return;
  const o: Record<string, unknown> = { ti: tagId, enableAutoSpaTracking: true };
  o.q = w.uetq;
  w.uetq = new w.UET(o);
  (w.uetq as { push: AnyFn }).push("pageLoad");
}

function ensureLinkedIn(h: VendorHost, partnerId: string) {
  const w = h.w;
  const ids = ((w._linkedin_data_partner_ids as string[]) = (w._linkedin_data_partner_ids as string[]) || []);
  if (ids.indexOf(partnerId) === -1) ids.push(partnerId);
  w._linkedin_partner_id = w._linkedin_partner_id || partnerId;
  if (typeof w.lintrk !== "function") {
    const l = function (a: unknown, b: unknown) {
      (l as unknown as { q: unknown[] }).q.push([a, b]);
    } as unknown as AnyFn & { q: unknown[] };
    l.q = [];
    w.lintrk = l;
    h.loadScript("https://snap.licdn.com/li.lms-analytics/insight.min.js");
  }
  return w.lintrk as AnyFn;
}

function ensureReddit(h: VendorHost, pixelId: string) {
  const rdt = ensureQueueFn(h, "rdt", "https://www.redditstatic.com/ads/pixel.js", (f) => {
    f.callQueue = f.queue;
  });
  const key = `reddit:${pixelId}`;
  if (!h.state.inited[key]) {
    h.state.inited[key] = true;
    rdt("init", pixelId, { optOut: false, useDecimalCurrencyValues: true });
  }
  return rdt;
}

/**
 * The analytics app's tracker (window.afsa). Same queue stub as its snippet:
 * window.afsa=window.afsa||function(){(afsa.q=afsa.q||[]).push(arguments)}
 */
function ensureAnalytics(h: VendorHost, siteId: string, base?: string) {
  const w = h.w;
  if (typeof w.afsa !== "function") {
    const f = function () {
      const self = f as unknown as { q: unknown[] };
      // eslint-disable-next-line prefer-rest-params
      (self.q = self.q || []).push(arguments);
    } as unknown as AnyFn & { q: unknown[] };
    w.afsa = f;
  }
  const b = (base || h.analyticsBase || "").replace(/\/$/, "");
  const key = `analytics:${siteId}`;
  if (!h.state.inited[key]) {
    h.state.inited[key] = true;
    // Preview traffic is analytics' test traffic (left out of reports): afsa('debug') before anything
    // is sent, and data-debug for the tracker's own first pageview.
    if (h.boot.preview) (w.afsa as AnyFn)("debug");
    if (b) h.loadScript(`${b}/s.js`, { "data-site": siteId, defer: "", ...(h.boot.preview ? { "data-debug": "true" } : {}) });
    else h.log("error", "analytics tag: no base_url and no ANALYTICS_BASE_URL configured");
  }
  return w.afsa as AnyFn;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** A tag's event params: its param_set (event_params_from) under its own event_params. */
function eventParams(h: VendorHost, p: { event_params?: unknown; event_params_from?: string }, ctx: EventCtx) {
  return { ...h.paramSet(p.event_params_from, ctx), ...obj(h.interpolate(p.event_params ?? {}, ctx)) };
}

/** gtag('config') params: config_params_from, then config_params. */
function configParams(h: VendorHost, p: { config_params?: unknown; config_params_from?: string }, ctx: EventCtx) {
  return { ...h.paramSet(p.config_params_from, ctx), ...obj(h.interpolate(p.config_params ?? {}, ctx)) };
}

function ensureSnap(h: VendorHost, pixelId: string): AnyFn {
  const w = h.w;
  if (typeof w.snaptr !== "function") {
    // Snap's snippet: calls queue until scevent.min.js sets handleRequest.
    const a = function () {
      const self = a as unknown as { handleRequest?: AnyFn; queue: unknown[] };
      // eslint-disable-next-line prefer-rest-params
      if (self.handleRequest) self.handleRequest.apply(self, arguments as unknown as unknown[]);
      // eslint-disable-next-line prefer-rest-params
      else self.queue.push(arguments);
    } as unknown as AnyFn & { queue: unknown[] };
    a.queue = [];
    w.snaptr = a;
    h.loadScript("https://sc-static.net/scevent.min.js");
  }
  const snaptr = w.snaptr as AnyFn;
  const key = `snap:${pixelId}`;
  if (!h.state.inited[key]) {
    h.state.inited[key] = true;
    const u = h.userHashes();
    snaptr("init", pixelId, u.em ? { user_hashed_email: u.em } : {});
  }
  return snaptr;
}

/** Fire a tag on a trigger (base tag / page view / standalone event). */
export function fireTag(h: VendorHost, tag: Tag, ctx: EventCtx) {
  switch (tag.type) {
    case "ga4": {
      const p = tag.params;
      const debug = h.debug ? { debug_mode: true } : {};
      const firstConfig = gtagConfig(h, p.measurement_id, {
        ...configParams(h, p, ctx),
        send_page_view: p.send_page_view !== false,
        ...debug,
      });
      if (p.event_name) h.gtag("event", p.event_name, { ...eventParams(h, p, ctx), send_to: p.measurement_id, ...debug });
      else if (!firstConfig && p.send_page_view !== false) {
        h.gtag("event", "page_view", { send_to: p.measurement_id, page_location: h.w.location.href, page_title: h.d.title, ...debug });
      }
      return;
    }
    case "google_ads": {
      const p = tag.params;
      gtagConfig(h, p.conversion_id, { ...configParams(h, p, ctx), allow_enhanced_conversions: true });
      if (p.conversion_label) {
        h.gtag("event", "conversion", {
          send_to: `${p.conversion_id}/${p.conversion_label}`,
          value: h.interpolate(p.value, ctx),
          currency: p.currency,
        });
      }
      return;
    }
    case "meta_pixel": {
      const p = tag.params;
      const fbq = metaInit(h, p.pixel_id, p.advanced_matching !== false);
      const name = p.event_name ?? "PageView";
      fbq(META_STANDARD.test(name) ? "trackSingle" : "trackSingleCustom", p.pixel_id, name, eventParams(h, p, ctx));
      return;
    }
    case "tiktok_pixel": {
      const p = tag.params;
      const inst = ensureTtq(h, p.pixel_id);
      if (p.event_name) inst.track!(p.event_name, eventParams(h, p, ctx));
      else inst.page!();
      return;
    }
    case "linkedin_insight": {
      const lintrk = ensureLinkedIn(h, tag.params.partner_id);
      if (tag.params.conversion_id) lintrk("track", { conversion_id: Number(tag.params.conversion_id) });
      return;
    }
    case "microsoft_uet": {
      const q = ensureUet(h, tag.params.tag_id);
      if (tag.params.event_action) q.push("event", tag.params.event_action, eventParams(h, tag.params, ctx));
      return;
    }
    case "reddit_pixel": {
      ensureReddit(h, tag.params.pixel_id)("track", tag.params.event_name ?? "PageVisit");
      return;
    }
    case "x_pixel": {
      const twq = ensureQueueFn(h, "twq", "https://static.ads-twitter.com/uwt.js", (f) => {
        f.version = "1.1";
      });
      const key = `x:${tag.params.pixel_id}`;
      if (!h.state.inited[key]) {
        h.state.inited[key] = true;
        twq("config", tag.params.pixel_id);
      }
      if (tag.params.event_id) twq("event", tag.params.event_id, {});
      return;
    }
    case "pinterest_tag": {
      const pintrk = ensureQueueFn(h, "pintrk", "https://s.pinimg.com/ct/core.js", (f) => {
        f.version = "3.0";
      });
      const key = `pinterest:${tag.params.tag_id}`;
      if (!h.state.inited[key]) {
        h.state.inited[key] = true;
        const u = h.userHashes();
        pintrk("load", tag.params.tag_id, u.em ? { em: u.em } : {});
      }
      const n = tag.params.event_name ?? "pagevisit";
      if (n === "pagevisit") pintrk("page");
      else pintrk("track", n, {});
      return;
    }
    case "snap_pixel":
      ensureSnap(h, tag.params.pixel_id)(
        "track",
        tag.params.event_name ?? "PAGE_VIEW",
        obj(h.interpolate(tag.params.event_params ?? {}, ctx)),
      );
      return;
    case "image_pixel": {
      // GTM's Custom Image tag: an image request; page data is URL-encoded into the owner's URL.
      let url = h.interpolateUrl(tag.params.url, ctx);
      if (tag.params.cache_bust !== false)
        url += `${url.indexOf("?") === -1 ? "?" : "&"}afst_cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const img = h.d.createElement("img");
      img.src = url;
      h.log("fire", `image pixel ${tag.id}`, { url });
      return;
    }
    case "analytics":
      ensureAnalytics(h, tag.params.site_id, tag.params.base_url);
      return;
    case "custom_html": {
      // The template is the owner's HTML (its scripts run, by design); {{var}} values are page data
      // (url_param, cookies, DOM...) and are HTML-encoded so they can't add markup or script.
      const html = h.interpolateHtml(tag.params.html, ctx);
      const holder = h.d.createElement("div");
      holder.setAttribute("data-afst-tag", tag.id);
      holder.style.display = "none";
      holder.innerHTML = html;
      const scripts = Array.prototype.slice.call(holder.querySelectorAll ? holder.querySelectorAll("script") : []) as HTMLScriptElement[];
      for (const old of scripts) {
        const s = h.d.createElement("script");
        for (const a of Array.prototype.slice.call(old.attributes) as Attr[]) s.setAttribute(a.name, a.value);
        s.text = old.text;
        old.parentNode?.replaceChild(s, old);
      }
      (h.d.body || h.d.documentElement).appendChild(holder);
      return;
    }
    case "custom_js": {
      // No templating here: the code is the owner's, and page data arrives only as the `event`
      // argument (never spliced into the source).
      // eslint-disable-next-line no-new-func
      const fn = new Function("afst", "event", tag.params.code) as AnyFn;
      fn(h.w.afst, { type: ctx.type, name: ctx.name, data: ctx.data, model: ctx.model });
      return;
    }
  }
}

/** Fire a conversion through one platform's client tag. Returns false if it couldn't run. */
export function fireConversionOn(h: VendorHost, platform: string, tag: Tag, conv: Conversion, c: ConversionData): boolean {
  const common = { value: c.value, currency: c.currency };
  switch (platform) {
    case "ga4": {
      if (tag.type !== "ga4" || !conv.send_to.ga4) return false;
      gtagConfig(h, tag.params.measurement_id, { send_page_view: false });
      const ud = googleUserData(c.user);
      if (Object.keys(ud).length) h.gtag("set", "user_data", ud);
      h.gtag("event", conv.send_to.ga4.event_name, {
        ...c.params,
        ...obj(conv.send_to.ga4.params),
        ...common,
        transaction_id: c.transaction_id ?? c.event_id,
        items: c.items,
        event_id: c.event_id,
        send_to: tag.params.measurement_id,
        ...(h.debug ? { debug_mode: true } : {}),
      });
      return h.scriptStatus(GTAG_SRC + encodeURIComponent(firstGtagId(h, tag.params.measurement_id))) !== "error";
    }
    case "google_ads": {
      const ga = conv.send_to.google_ads;
      if (tag.type !== "google_ads" || !ga || !(ga.send_to || ga.remarketing)) return false;
      gtagConfig(h, tag.params.conversion_id, { allow_enhanced_conversions: true });
      if (ga.send_to) {
        const ud = googleUserData(c.user);
        if (Object.keys(ud).length) h.gtag("set", "user_data", ud);
        h.gtag("event", "conversion", { send_to: ga.send_to, ...common, transaction_id: c.transaction_id ?? c.event_id });
      }
      if (ga.remarketing) {
        // Dynamic remarketing: the event with value and items carrying the business vertical.
        const vertical = ga.vertical ?? "retail";
        h.gtag("event", conv.send_to.ga4?.event_name ?? conv.name, {
          send_to: tag.params.conversion_id,
          value: c.value,
          items: (c.items ?? []).map((i) => ({ id: i.item_id, google_business_vertical: vertical })),
        });
      }
      return true;
    }
    case "meta": {
      if (tag.type !== "meta_pixel" || !conv.send_to.meta) return false;
      const fbq = metaInit(h, tag.params.pixel_id, tag.params.advanced_matching !== false, c.user);
      const name = conv.send_to.meta.event_name;
      const items = c.items ?? [];
      const data: Record<string, unknown> = { ...c.params, ...common, ...obj(conv.send_to.meta.custom_data) };
      if (c.transaction_id) data.order_id = c.transaction_id;
      if (items.length) {
        data.content_ids = items.map((i) => i.item_id).filter(Boolean);
        data.contents = items.map((i) => ({ id: i.item_id, quantity: i.quantity, item_price: i.price }));
        data.content_type = "product";
      }
      fbq(META_STANDARD.test(name) ? "trackSingle" : "trackSingleCustom", tag.params.pixel_id, name, data, { eventID: c.event_id });
      return true;
    }
    case "tiktok": {
      if (tag.type !== "tiktok_pixel" || !conv.send_to.tiktok) return false;
      const inst = ensureTtq(h, tag.params.pixel_id);
      const u = c.user;
      const ident: Record<string, string> = {};
      if (u.em) ident.email = u.em;
      if (u.ph_e164) ident.phone_number = u.ph_e164;
      const uid = h.userId();
      if (uid) ident.external_id = sha256HexSync(uid);
      if (Object.keys(ident).length) inst.identify!(ident);
      const items = c.items ?? [];
      inst.track!(
        conv.send_to.tiktok.event_name,
        {
          ...c.params,
          ...common,
          ...(c.transaction_id ? { order_id: c.transaction_id } : {}),
          ...(items.length
            ? {
                content_type: "product",
                contents: items.map((i) => ({ content_id: i.item_id, content_name: i.item_name, price: i.price, quantity: i.quantity })),
              }
            : {}),
        },
        { event_id: c.event_id },
      );
      return true;
    }
    case "linkedin": {
      if (tag.type !== "linkedin_insight" || !conv.send_to.linkedin) return false;
      ensureLinkedIn(h, tag.params.partner_id)("track", {
        conversion_id: Number(conv.send_to.linkedin.conversion_id),
        event_id: c.event_id,
      });
      return true;
    }
    case "microsoft_uet": {
      if (tag.type !== "microsoft_uet" || !conv.send_to.microsoft_uet) return false;
      ensureUet(h, tag.params.tag_id).push("event", conv.send_to.microsoft_uet.event_action, {
        revenue_value: c.value,
        currency: c.currency,
      });
      return true;
    }
    case "reddit": {
      if (tag.type !== "reddit_pixel" || !conv.send_to.reddit) return false;
      const rdt = ensureReddit(h, tag.params.pixel_id);
      const n = conv.send_to.reddit.event_name;
      const std = /^(PageVisit|ViewContent|Search|AddToCart|AddToWishlist|Purchase|Lead|SignUp)$/.test(n);
      rdt("track", std ? n : "Custom", {
        ...(std ? {} : { customEventName: n }),
        ...common,
        conversionId: c.event_id,
        transactionId: c.transaction_id,
      });
      return true;
    }
    case "x": {
      if (tag.type !== "x_pixel" || !conv.send_to.x) return false;
      const twq = ensureQueueFn(h, "twq", "https://static.ads-twitter.com/uwt.js", (f) => {
        f.version = "1.1";
      });
      twq("event", conv.send_to.x.event_id, { ...common, conversion_id: c.event_id });
      return true;
    }
    case "pinterest": {
      if (tag.type !== "pinterest_tag" || !conv.send_to.pinterest) return false;
      const pintrk = ensureQueueFn(h, "pintrk", "https://s.pinimg.com/ct/core.js", (f) => {
        f.version = "3.0";
      });
      pintrk("track", conv.send_to.pinterest.event_name, { ...common, order_id: c.transaction_id, event_id: c.event_id });
      return true;
    }
    case "snap": {
      if (tag.type !== "snap_pixel" || !conv.send_to.snap) return false;
      const items = c.items ?? [];
      ensureSnap(h, tag.params.pixel_id)("track", conv.send_to.snap.event_name, {
        price: c.value,
        currency: c.currency,
        transaction_id: c.transaction_id,
        client_dedup_id: c.event_id,
        ...(items.length ? { item_ids: items.map((i) => i.item_id).filter(Boolean), number_items: items.length } : {}),
      });
      return true;
    }
    case "analytics": {
      if (tag.type !== "analytics") return false;
      const afsa = ensureAnalytics(h, tag.params.site_id, tag.params.base_url);
      const name = conv.send_to.analytics?.event_name ?? conv.name;
      const props = { ...c.params, event_id: c.event_id, ...(c.transaction_id ? { transaction_id: c.transaction_id } : {}) };
      if (c.value !== undefined && c.currency) afsa("revenue", name, c.value, c.currency, props);
      else afsa("event", name, props);
      return true;
    }
  }
  return false;
}

/** gtag.js is loaded once, with the first Google id configured. */
function firstGtagId(h: VendorHost, fallback: string): string {
  const ids = Object.keys(h.state.gtagConfigured);
  return ids[0] ?? fallback;
}

/** Push a consent update to vendor libraries that have their own consent APIs. */
export function vendorConsent(h: VendorHost, update: Record<string, string>, full: Record<string, string>, initial: boolean) {
  const w = h.w;
  if (initial) return;
  if (typeof w.fbq === "function" && update.ad_storage) (w.fbq as AnyFn)("consent", full.ad_storage === "granted" ? "grant" : "revoke");
  const ttq = w.ttq as Record<string, AnyFn> | undefined;
  if (ttq && update.ad_storage) {
    if (full.ad_storage === "granted") ttq.grantConsent?.();
    else ttq.revokeConsent?.();
  }
  const uet = w.uetq as { push?: AnyFn } | undefined;
  if (uet?.push && update.ad_storage) uet.push("consent", "update", { ad_storage: full.ad_storage });
}
