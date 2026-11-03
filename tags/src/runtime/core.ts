import type { ContainerConfig, Conversion, Tag, Trigger, Variable } from "../config/schema";
import { CLICK_ID_DAYS, CLICK_IDS, CONSENT_COOKIE, clickCookieName, FIRST_TOUCH_COOKIE, UTM_KEYS, VISITOR_COOKIE } from "../lib/clickids";
import { matchCondition } from "../lib/conditions";
import {
  applyConsentUpdate,
  CONSENT_TYPES,
  type ConsentState,
  type ConsentType,
  type ConsentValue,
  DEFAULT_TAG_CONSENT,
  initialConsent,
  isGranted,
} from "../lib/consent";
import { type HashedUserData, hashUserData, type RawUserData } from "../lib/pii";
import type { BootConfig, EventCtx } from "./types";
import { interpolateHtml } from "../lib/html";
import {
  closest,
  deepMerge,
  getPath,
  interpolate,
  isArgs,
  isObj,
  matches,
  readCookie,
  rnd,
  snapshot,
  textOf,
  toNumber,
  writeCookie,
} from "./util";
import { type ConversionData, fireConversionOn, fireTag, uetOnLoad, type VendorHost, vendorConsent } from "./vendors";

type W = Window & Record<string, unknown>;

const PLATFORM_TAG: Record<string, Tag["type"]> = {
  ga4: "ga4",
  google_ads: "google_ads",
  meta: "meta_pixel",
  tiktok: "tiktok_pixel",
  linkedin: "linkedin_insight",
  microsoft_uet: "microsoft_uet",
  reddit: "reddit_pixel",
  x: "x_pixel",
  pinterest: "pinterest_tag",
  analytics: "analytics",
};
const GOOGLE_TAGS = { ga4: true, google_ads: true } as Record<string, boolean>;
const SESSION_KEY = "_afst_s_";

interface Pending {
  required: ConsentType[];
  run: () => void;
  label: string;
}

export class Runtime implements VendorHost {
  readonly w: W;
  readonly d: Document;
  readonly boot: BootConfig;
  readonly cfg: Required<Pick<ContainerConfig, "variables" | "triggers" | "tags" | "conversions">> & ContainerConfig;
  base = "";
  analyticsBase?: string;
  debug = false;
  firstParty = false;
  state = {
    gtagLoaded: false,
    gtagConfigured: {} as Record<string, boolean>,
    inited: {} as Record<string, boolean>,
    matching: {} as Record<string, string>,
  };
  consent: Record<ConsentType, ConsentValue>;
  model: Record<string, unknown> = {};
  visitorId = "";
  newVisitor = false;
  clickIds: Record<string, string> = {};
  fbc?: string;
  fbp?: string;
  firstTouch?: Record<string, unknown>;
  identity: { userId?: string; raw: RawUserData } = { raw: {} };
  pending: Pending[] = [];
  once: Record<string, boolean> = {};
  scripts: Record<string, "pending" | "loaded" | "error"> = {};
  vars: Record<string, Variable> = {};
  started = false;
  private scrollFired: Record<string, boolean> = {};
  private lastUrl = "";

  constructor(w: Window, d: Document, boot: BootConfig) {
    this.w = w as W;
    this.d = d;
    this.boot = boot;
    const c = boot.cfg || {};
    this.cfg = {
      ...c,
      variables: c.variables ?? [],
      triggers: c.triggers ?? [],
      tags: (c.tags ?? []).filter((t) => t.enabled !== false),
      conversions: c.conversions ?? [],
    };
    for (const v of this.cfg.variables) this.vars[v.name] = v;
    this.consent = initialConsent(c.consent, boot.geo?.country, boot.geo?.region);
    this.analyticsBase = boot.ab;
  }

  // ------------------------------------------------------------------ boot

  start() {
    const w = this.w;
    const id = this.boot.id;
    this.base = this.resolveBase();
    if (!this.boot.preview && this.previewHandoff()) return;
    const loaded = ((w.__afst_loaded as Record<string, boolean>) = (w.__afst_loaded as Record<string, boolean>) || {});
    const guard = id + (this.boot.preview ? ":preview" : "");
    if (loaded[guard]) return;
    loaded[guard] = true;
    this.started = true;
    let q: URLSearchParams | null = null;
    try {
      q = new URLSearchParams(w.location.search);
    } catch {
      q = null;
    }
    this.debug = !!this.boot.preview || !!this.cfg.settings?.debug || q?.get("afst_debug") === "1";
    try {
      this.firstParty = new URL(this.base).host === w.location.host;
    } catch {
      this.firstParty = false;
    }
    if (this.boot.preview)
      this.log("info", `PREVIEW of container ${id} (draft config). Add ?afst_preview=off to the URL to leave preview.`);
    this.log("info", `container ${id} v${this.boot.v} loaded`, { consent: this.consent, geo: this.boot.geo });

    // Stored consent choice beats defaults.
    const stored = readCookie(this.d, CONSENT_COOKIE);
    if (stored) {
      try {
        const s = JSON.parse(stored) as ConsentState;
        this.consent = applyConsentUpdate(this.consent, s);
      } catch {
        /* ignore */
      }
    }
    if (this.cfg.tags.some((t) => GOOGLE_TAGS[t.type])) {
      const def: Record<string, unknown> = {};
      for (const k of CONSENT_TYPES) def[k] = this.consent[k];
      if (this.cfg.consent?.wait_for_update_ms) def.wait_for_update = this.cfg.consent.wait_for_update_ms;
      this.gtag("consent", "default", def);
    }
    this.captureIdentity();
    this.installApi();
    this.installDataLayer();
    this.installListeners();
  }

  private resolveBase(): string {
    const id = this.boot.id;
    let src = "";
    const cs = this.d.currentScript as HTMLScriptElement | null;
    if (cs && cs.src && cs.src.indexOf(`/c/${id}.js`) !== -1) src = cs.src;
    if (!src && this.d.querySelectorAll) {
      const all = this.d.querySelectorAll("script[src]");
      for (let i = 0; i < all.length; i++) {
        const s = (all[i] as HTMLScriptElement).src;
        if (s && s.indexOf(`/c/${id}.js`) !== -1) src = s;
      }
    }
    if (src) return src.replace(/\/c\/[^/?#]+\.js([?#].*)?$/, "");
    return this.boot.base ?? "";
  }

  /** ?afst_preview=<token> on the page URL: reload this container as the draft build. */
  private previewHandoff(): boolean {
    const w = this.w;
    const key = `_afst_preview_${this.boot.id}`;
    let token: string | null = null;
    try {
      const qp = new URLSearchParams(w.location.search).get("afst_preview");
      const ss = w.sessionStorage;
      if (qp === "off" || qp === "0") ss.removeItem(key);
      else if (qp) ss.setItem(key, qp);
      token = ss.getItem(key);
    } catch {
      token = null;
    }
    if (!token) return false;
    this.loadScript(`${this.base}/c/${this.boot.id}.js?preview=${encodeURIComponent(token)}`);
    return true;
  }

  // ------------------------------------------------------------------ host helpers

  log(kind: string, msg: string, data?: unknown) {
    const w = this.w;
    const entry = { t: Date.now(), container: this.boot.id, kind, msg, data };
    const buf = ((w.__afst_debug as unknown[]) = (w.__afst_debug as unknown[]) || []);
    buf.push(entry);
    if (buf.length > 500) buf.shift();
    if (this.debug && typeof console !== "undefined") {
      try {
        console.log(
          `%c[afst]%c ${kind}: ${msg}`,
          "color:#fff;background:#4b3fc7;padding:1px 4px;border-radius:3px",
          "color:inherit",
          data === undefined ? "" : data,
        );
      } catch {
        /* ignore */
      }
    }
  }

  loadScript(src: string, attrs?: Record<string, string>) {
    if (this.scripts[src]) return;
    this.scripts[src] = "pending";
    const s = this.d.createElement("script");
    s.async = true;
    s.src = src;
    for (const k of Object.keys(attrs ?? {})) s.setAttribute(k, attrs![k]!);
    s.onload = () => {
      this.scripts[src] = "loaded";
      const uet = attrs?.["data-afst-uet"];
      if (uet) uetOnLoad(this, uet);
    };
    s.onerror = () => {
      this.scripts[src] = "error";
      this.log("warn", `failed to load ${src} (ad blocker?)`);
    };
    const first = this.d.getElementsByTagName("script")[0];
    if (first && first.parentNode) first.parentNode.insertBefore(s, first);
    else (this.d.head || this.d.documentElement).appendChild(s);
  }

  scriptStatus(src: string) {
    return this.scripts[src];
  }

  /** gtag(), marked as our own so our dataLayer listener doesn't re-process it. */
  gtag(...args: unknown[]) {
    const w = this.w;
    w.dataLayer = (w.dataLayer as unknown[]) || [];
    if (typeof w.gtag !== "function") {
      w.gtag = function gtag() {
        // eslint-disable-next-line prefer-rest-params
        (w.dataLayer as unknown[]).push(arguments);
      };
    }
    w.__afst_own = ((w.__afst_own as number) || 0) + 1;
    try {
      (w.gtag as (...a: unknown[]) => void).apply(w, args);
    } finally {
      w.__afst_own = (w.__afst_own as number) - 1;
    }
  }

  interpolate(v: unknown, ctx: EventCtx) {
    return interpolate(v, (n) => this.getVar(n, ctx));
  }

  interpolateHtml(template: string, ctx: EventCtx) {
    return interpolateHtml(template, (n) => this.getVar(n, ctx));
  }

  userHashes(): HashedUserData {
    return hashUserData(this.identity.raw, { phoneCountryCode: this.cfg.settings?.phone_country_code });
  }

  userId() {
    return this.identity.userId;
  }

  // ------------------------------------------------------------------ identity

  private canStore() {
    return this.consent.analytics_storage === "granted" || this.consent.ad_storage === "granted";
  }

  private cookieDomain(): string | undefined {
    const host = this.w.location.hostname;
    const set = this.cfg.settings?.cookie_domain;
    if (set) return set;
    const d = this.boot.d;
    if (d && d !== "localhost" && (host === d || host.slice(-(d.length + 1)) === `.${d}`)) return d;
    return undefined;
  }

  private secure() {
    return this.w.location.protocol === "https:";
  }

  private captureIdentity() {
    const d = this.d;
    const w = this.w;
    let q: URLSearchParams;
    try {
      q = new URLSearchParams(w.location.search);
    } catch {
      q = new URLSearchParams("");
    }
    const existing = readCookie(d, VISITOR_COOKIE);
    this.newVisitor = !existing;
    this.visitorId = existing && /^[A-Za-z0-9_.-]{6,64}$/.test(existing) ? existing : `${rnd(16)}.${Math.floor(Date.now() / 1000)}`;
    for (const name of CLICK_IDS) {
      const v = q.get(name) ?? q.get(name.toLowerCase());
      if (v) this.clickIds[name] = v.slice(0, 500);
      else {
        const c = readCookie(d, clickCookieName(name));
        if (c) this.clickIds[name] = c;
      }
    }
    const fbclid = q.get("fbclid");
    const fbcCookie = readCookie(d, "_fbc");
    this.fbc = fbclid ? (fbcCookie && fbcCookie.slice(-fbclid.length) === fbclid ? fbcCookie : `fb.1.${Date.now()}.${fbclid}`) : fbcCookie;
    this.fbp = readCookie(d, "_fbp");
    const usesMeta = this.cfg.tags.some((t) => t.type === "meta_pixel") || this.cfg.conversions.some((c) => c.send_to.meta);
    if (!this.fbp && usesMeta) this.fbp = `fb.1.${Date.now()}.${Math.floor(1e9 + Math.random() * 9e9)}`;
    const ftRaw = readCookie(d, FIRST_TOUCH_COOKIE);
    if (ftRaw) {
      try {
        this.firstTouch = JSON.parse(ftRaw) as Record<string, unknown>;
      } catch {
        this.firstTouch = undefined;
      }
    }
    const utm = this.utm();
    if (!this.firstTouch && (Object.keys(utm).length || Object.keys(this.clickIds).length || this.externalReferrer())) {
      this.firstTouch = { ...utm, landing_page: w.location.href.slice(0, 500), referrer: d.referrer.slice(0, 300), ts: Date.now() };
      const ck = CLICK_IDS.filter((c) => q.get(c));
      if (ck.length) this.firstTouch.click_ids = ck.join(",");
    }
    this.persistIdentity();
  }

  private persistIdentity() {
    const d = this.d;
    const dom = this.cookieDomain();
    const sec = this.secure();
    if (this.canStore()) {
      writeCookie(d, VISITOR_COOKIE, this.visitorId, 395, dom, sec);
      if (this.firstTouch) writeCookie(d, FIRST_TOUCH_COOKIE, JSON.stringify(this.firstTouch), CLICK_ID_DAYS, dom, sec);
    }
    if (this.consent.ad_storage === "granted") {
      for (const k of Object.keys(this.clickIds)) writeCookie(d, clickCookieName(k), this.clickIds[k]!, CLICK_ID_DAYS, dom, sec);
      if (this.fbc) writeCookie(d, "_fbc", this.fbc, CLICK_ID_DAYS, dom, sec);
      if (this.fbp) writeCookie(d, "_fbp", this.fbp, CLICK_ID_DAYS, dom, sec);
    }
  }

  private utm(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      const q = new URLSearchParams(this.w.location.search);
      for (const k of UTM_KEYS) {
        const v = q.get(k);
        if (v) out[k] = v.slice(0, 300);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  private externalReferrer(): boolean {
    const r = this.d.referrer;
    if (!r) return false;
    try {
      return new URL(r).hostname !== this.w.location.hostname;
    } catch {
      return false;
    }
  }

  private gaIds(): { client?: string; session?: string } {
    const ga = readCookie(this.d, "_ga");
    const client = ga ? ga.split(".").slice(-2).join(".") : undefined;
    let session: string | undefined;
    for (const t of this.cfg.tags) {
      if (t.type !== "ga4") continue;
      const c = readCookie(this.d, `_ga_${t.params.measurement_id.replace(/^G-/, "")}`);
      if (!c) continue;
      const m = /^GS\d\.\d\.s?(\d+)/.exec(c);
      if (m) session = m[1];
      break;
    }
    return { client: client && /^\d+\.\d+$/.test(client) ? client : undefined, session };
  }

  // ------------------------------------------------------------------ public API

  private installApi() {
    const w = this.w;
    const runtimes = ((w.__afst_runtimes as Runtime[]) = (w.__afst_runtimes as Runtime[]) || []);
    runtimes.push(this);
    const prev = w.afst as (((...a: unknown[]) => unknown) & { q?: unknown[][] }) | undefined;
    if (prev && (prev as unknown as Record<string, unknown>).__afst) return; // another container installed it
    const api = function (cmd: unknown, a?: unknown, b?: unknown): unknown {
      const all = (w.__afst_runtimes as Runtime[]) || [];
      if (cmd === "event") {
        const dl = w.dataLayer as unknown[];
        dl.push({ ...(isObj(b) ? b : {}), event: String(a) });
        return undefined;
      }
      if (cmd === "get") return all[0]?.get(String(a));
      for (const r of all) r.command(String(cmd), a, b);
      return undefined;
    } as ((...a: unknown[]) => unknown) & Record<string, unknown>;
    api.__afst = true;
    api.visitorId = () => (w.__afst_runtimes as Runtime[])[0]?.visitorId;
    w.afst = api;
    const queued = prev?.q ?? [];
    for (const args of queued) api(...(Array.prototype.slice.call(args) as [unknown, unknown, unknown]));
  }

  command(cmd: string, a: unknown, b: unknown) {
    if (cmd === "consent" && isObj(b)) this.updateConsent(b as ConsentState, `afst('consent','${String(a)}')`);
    else if (cmd === "consent" && isObj(a)) this.updateConsent(a as ConsentState, "afst('consent')");
    else if (cmd === "identify") {
      if (a != null && a !== "") this.identity.userId = String(a).slice(0, 200);
      if (isObj(b)) Object.assign(this.identity.raw, b);
      this.log("info", "identify", { user_id: this.identity.userId, fields: Object.keys(this.identity.raw) });
    } else if (cmd === "debug") this.debug = a !== false;
  }

  get(what: string): unknown {
    if (what === "visitor_id") return this.visitorId;
    if (what === "consent") return { ...this.consent };
    if (what === "click_ids") return { ...this.clickIds };
    if (what === "event_id") return this.lastEventId;
    if (what === "log") return (this.w.__afst_debug as unknown[]) ?? [];
    return undefined;
  }

  lastEventId?: string;

  // ------------------------------------------------------------------ consent

  updateConsent(update: ConsentState, source: string) {
    const before = { ...this.consent };
    this.consent = applyConsentUpdate(this.consent, update);
    const changed: Record<string, string> = {};
    for (const k of CONSENT_TYPES) if (before[k] !== this.consent[k]) changed[k] = this.consent[k];
    try {
      const store: Record<string, string> = {};
      for (const k of CONSENT_TYPES) store[k] = this.consent[k];
      writeCookie(this.d, CONSENT_COOKIE, JSON.stringify(store), 180, this.cookieDomain(), this.secure());
    } catch {
      /* ignore */
    }
    this.log("consent", `update from ${source}`, { changed, state: this.consent });
    if (this.cfg.tags.some((t) => GOOGLE_TAGS[t.type]) && Object.keys(changed).length) this.gtag("consent", "update", changed);
    vendorConsent(this, changed, this.consent, false);
    if (Object.keys(changed).length) this.persistIdentity();
    const still: Pending[] = [];
    for (const p of this.pending) {
      if (isGranted(this.consent, p.required)) {
        this.log("fire", `${p.label} (released by consent)`);
        try {
          p.run();
        } catch (e) {
          this.log("error", `${p.label} failed`, String(e));
        }
      } else still.push(p);
    }
    this.pending = still;
  }

  private gate(required: ConsentType[], label: string, run: () => void, bypass = false) {
    if (bypass || isGranted(this.consent, required)) {
      run();
      return true;
    }
    if (this.pending.length < 100) this.pending.push({ required, run, label });
    this.log("blocked", `${label} waits for consent: ${required.filter((r) => this.consent[r] !== "granted").join(", ")}`);
    return false;
  }

  // ------------------------------------------------------------------ dataLayer

  private installDataLayer() {
    const w = this.w;
    const dl = ((w.dataLayer as unknown[]) = (w.dataLayer as unknown[]) || []);
    const queued: EventCtx[] = [];
    // Existing entries: merge into the model in order; replay their events after page_view so
    // base tags (gtag config, fbq init) run first.
    for (const entry of dl.slice()) {
      const ctx = this.processEntry(entry, true);
      if (ctx) queued.push(ctx);
    }
    const orig = dl.push;
    const self = this;
    dl.push = function (...items: unknown[]) {
      const r = orig.apply(dl, items);
      for (const it of items) {
        try {
          const ctx = self.processEntry(it, false);
          if (ctx) self.emit(ctx);
        } catch (e) {
          self.log("error", "dataLayer entry failed", String(e));
        }
      }
      return r;
    };
    this.lastUrl = w.location.href;
    this.emit(this.ctx("page_view", "page_view"));
    for (const c of queued) this.emit(c);
    const rs = this.d.readyState;
    if (rs === "loading") this.d.addEventListener("DOMContentLoaded", () => this.domReady());
    else this.domReady();
  }

  /** Returns an event context when the entry is an event; merges data into the model. */
  processEntry(entry: unknown, initial: boolean): EventCtx | null {
    const w = this.w;
    if (isArgs(entry)) {
      if ((w.__afst_own as number) > 0) return null;
      const cmd = entry[0];
      if (cmd === "consent" && (entry[1] === "default" || entry[1] === "update") && isObj(entry[2])) {
        this.updateConsent(entry[2] as ConsentState, `gtag('consent','${entry[1]}')`);
        return null;
      }
      if (cmd === "event" && typeof entry[1] === "string" && this.cfg.settings?.listen_to_gtag_events) {
        const data = isObj(entry[2]) ? (entry[2] as Record<string, unknown>) : {};
        deepMerge(this.model, data);
        return { ...this.ctx("custom_event", entry[1]), data };
      }
      return null;
    }
    if (!isObj(entry)) return null;
    deepMerge(this.model, entry);
    const ev = entry.event;
    if (typeof ev !== "string" || ev.indexOf("gtm.") === 0) return null;
    const ctx = { ...this.ctx("custom_event", ev), data: entry };
    const cb = entry.eventCallback;
    if (typeof cb === "function" && !w.google_tag_manager) {
      // Sites wait on eventCallback before navigating; GTM isn't here to call it, so we do.
      w.setTimeout(
        () => {
          try {
            (cb as (id?: string) => void)(this.boot.id);
          } catch {
            /* ignore */
          }
        },
        initial ? 0 : 50,
      );
    }
    return ctx;
  }

  private ctx(type: string, name: string, extra?: Partial<EventCtx>): EventCtx {
    return { type, name, model: snapshot(this.model), ts: Date.now(), ...extra };
  }

  // ------------------------------------------------------------------ listeners

  private has(type: Trigger["type"]) {
    return this.cfg.triggers.some((t) => t.type === type);
  }

  private installListeners() {
    const d = this.d;
    const w = this.w;
    if (this.has("click")) {
      d.addEventListener(
        "click",
        (e) => {
          const target = e.target as Element | null;
          if (!target || !(target as Element).nodeType) return;
          const el = closest(target, "a,button,[role=button],input[type=submit],input[type=button]") || target;
          this.emit(this.ctx("click", "click", { el }));
        },
        true,
      );
    }
    if (this.has("form_submit")) {
      d.addEventListener(
        "submit",
        (e) => {
          const form = e.target as Element | null;
          if (!form) return;
          this.emit(this.ctx("form_submit", "form_submit", { form, el: form }));
        },
        true,
      );
    }
    if (this.has("history_change") || this.cfg.tags.some((t) => t.type === "microsoft_uet")) {
      const h = w.history;
      const self = this;
      for (const m of ["pushState", "replaceState"] as const) {
        const orig = h?.[m];
        if (typeof orig !== "function") continue;
        h[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
          const r = orig.apply(this, args);
          self.onHistory(m);
          return r;
        } as History["pushState"];
      }
      w.addEventListener("popstate", () => this.onHistory("popstate"));
      w.addEventListener("hashchange", () => this.onHistory("hashchange"));
    }
    if (this.has("scroll_depth")) {
      let t: number | undefined;
      w.addEventListener(
        "scroll",
        () => {
          if (t) return;
          t = w.setTimeout(() => {
            t = undefined;
            this.checkScroll();
          }, 200);
        },
        { passive: true } as AddEventListenerOptions,
      );
    }
    for (const trig of this.cfg.triggers) {
      if (trig.type !== "timer") continue;
      let n = 0;
      const limit = trig.limit ?? 1;
      const h = w.setInterval(() => {
        n++;
        this.emit(this.ctx("timer", "timer", { triggerId: trig.id }));
        if (n >= limit) w.clearInterval(h);
      }, trig.interval_ms);
    }
  }

  private domReady() {
    this.emit(this.ctx("dom_ready", "dom_ready"));
    const IO = (this.w as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    for (const trig of this.cfg.triggers) {
      if (trig.type !== "element_visible" || !IO) continue;
      const seen = new WeakSet<Element>();
      const io = new IO(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            if (trig.once !== false) {
              if (seen.has(en.target)) continue;
              seen.add(en.target);
              io.unobserve(en.target);
            }
            this.emit(this.ctx("element_visible", "element_visible", { triggerId: trig.id, el: en.target }));
          }
        },
        { threshold: trig.threshold ?? 0.5 },
      );
      const observe = () => {
        try {
          const els = this.d.querySelectorAll(trig.selector);
          for (let i = 0; i < els.length; i++) if (!seen.has(els[i]!)) io.observe(els[i]!);
        } catch {
          /* bad selector */
        }
      };
      observe();
      const MO = (this.w as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
      if (trig.observe_dom && MO && this.d.body) {
        let pending = false;
        new MO(() => {
          if (pending) return;
          pending = true;
          this.w.setTimeout(() => {
            pending = false;
            observe();
          }, 300);
        }).observe(this.d.body, { childList: true, subtree: true });
      }
    }
  }

  private onHistory(source: string) {
    const href = this.w.location.href;
    if (href === this.lastUrl) return;
    this.lastUrl = href;
    this.once = {};
    this.scrollFired = {};
    this.log("info", `history change (${source}) -> ${href}`);
    this.emit(this.ctx("history_change", "history_change"));
  }

  private checkScroll() {
    const d = this.d.documentElement;
    const w = this.w;
    const h = Math.max(d.scrollHeight - w.innerHeight, 1);
    const pct = Math.min(100, Math.round(((w.scrollY || d.scrollTop) / h) * 100));
    for (const trig of this.cfg.triggers) {
      if (trig.type !== "scroll_depth") continue;
      for (const p of trig.percentages) {
        const key = `${trig.id}:${p}`;
        if (pct >= p && !this.scrollFired[key]) {
          this.scrollFired[key] = true;
          this.emit(this.ctx("scroll_depth", "scroll_depth", { triggerId: trig.id, scroll: p }));
        }
      }
    }
  }

  // ------------------------------------------------------------------ variables

  getVar(name: string, ctx: EventCtx): unknown {
    const v = this.vars[name];
    if (v) {
      const val = this.resolveVar(v, ctx);
      return val === undefined || val === null || val === "" ? v.default : val;
    }
    return this.builtin(name, ctx);
  }

  private scopeQuery(sel: string, ctx: EventCtx): Element | null {
    try {
      const inForm = ctx.form && (ctx.form as Element).querySelector ? (ctx.form as Element).querySelector(sel) : null;
      return inForm || this.d.querySelector(sel);
    } catch {
      return null;
    }
  }

  private resolveVar(v: Variable, ctx: EventCtx): unknown {
    switch (v.type) {
      case "data_layer":
        return getPath(ctx.model ?? this.model, v.key);
      case "url_param":
        try {
          return new URLSearchParams(this.w.location.search).get(v.param) ?? undefined;
        } catch {
          return undefined;
        }
      case "cookie":
        return readCookie(this.d, v.cookie);
      case "dom_text":
        return textOf(this.scopeQuery(v.selector, ctx)) || undefined;
      case "dom_value": {
        const el = this.scopeQuery(v.selector, ctx) as HTMLInputElement | null;
        return el && typeof el.value === "string" ? el.value : undefined;
      }
      case "dom_attr":
        return this.scopeQuery(v.selector, ctx)?.getAttribute(v.attr) ?? undefined;
      case "js":
        return getPath(this.w, v.path);
      case "constant":
        return v.value;
      default:
        return this.builtin(v.type, ctx);
    }
  }

  private builtin(name: string, ctx: EventCtx): unknown {
    const loc = this.w.location;
    const el = ctx.el as (Element & { href?: string }) | null | undefined;
    const form = ctx.form as Element | null | undefined;
    switch (name) {
      case "page_url":
        return loc.href;
      case "page_path":
        return loc.pathname;
      case "page_hostname":
        return loc.hostname;
      case "page_title":
        return this.d.title;
      case "referrer":
        return this.d.referrer;
      case "event":
        return ctx.name;
      case "click_text":
        return ctx.type === "click" ? textOf(el) : undefined;
      case "click_url": {
        if (ctx.type !== "click") return undefined;
        const a = closest(el, "a[href]") as HTMLAnchorElement | null;
        return a ? a.href || a.getAttribute("href") || "" : "";
      }
      case "click_id":
        return el?.getAttribute?.("id") ?? "";
      case "click_classes":
        return el?.getAttribute?.("class") ?? "";
      case "form_id":
        return form?.getAttribute?.("id") ?? "";
      case "form_action":
        return form?.getAttribute?.("action") ?? "";
      case "form_classes":
        return form?.getAttribute?.("class") ?? "";
      case "scroll_depth":
        return ctx.scroll;
      default:
        return undefined;
    }
  }

  // ------------------------------------------------------------------ triggers + firing

  private matchTrigger(t: Trigger, ctx: EventCtx): EventCtx | null {
    if (t.type !== ctx.type) return null;
    let c = ctx;
    switch (t.type) {
      case "custom_event":
        if (t.event !== ctx.name) return null;
        break;
      case "click": {
        let el: Element | null | undefined = ctx.el;
        if (t.selector) el = closest(el, t.selector);
        if (t.links_only) el = closest(el, "a[href]");
        if (!el) return null;
        c = { ...ctx, el };
        break;
      }
      case "form_submit":
        if (t.selector && !matches(ctx.form, t.selector)) return null;
        break;
      case "element_visible":
      case "scroll_depth":
      case "timer":
        if (ctx.triggerId !== t.id) return null;
        break;
    }
    for (const cond of t.conditions ?? []) {
      if (!matchCondition(this.getVar(cond.var, c), cond.op, cond.value, cond.ignore_case)) return null;
    }
    return c;
  }

  emit(ctx: EventCtx) {
    const fired: Record<string, EventCtx> = {};
    for (const t of this.cfg.triggers) {
      const m = this.matchTrigger(t, ctx);
      if (m) fired[t.id] = m;
    }
    const ids = Object.keys(fired);
    if (!ids.length) {
      if (ctx.type === "custom_event") this.log("event", `${ctx.name} (no trigger)`);
      if (ctx.type === "page_view") this.maybeVisit();
      return;
    }
    this.log("trigger", `${ctx.type}${ctx.type === "custom_event" ? ` "${ctx.name}"` : ""} -> ${ids.join(", ")}`);
    for (const tag of this.cfg.tags) {
      const hit = tag.triggers.find((id) => fired[id]);
      if (!hit) continue;
      if ((tag.exclude_triggers ?? []).some((id) => fired[id])) {
        this.log("skip", `tag ${tag.id}: excluded by trigger`);
        continue;
      }
      this.runTag(tag, fired[hit]!);
    }
    for (const conv of this.cfg.conversions) {
      const c = fired[conv.trigger];
      if (c) this.runConversion(conv, c);
    }
    if (ctx.type === "page_view") this.maybeVisit();
  }

  private requiredConsent(tag: Tag): ConsentType[] {
    return (tag.consent ?? DEFAULT_TAG_CONSENT[tag.type] ?? []) as ConsentType[];
  }

  private googleAdvanced(tag: Tag) {
    return this.cfg.consent?.google_consent_mode === "advanced" && !!GOOGLE_TAGS[tag.type];
  }

  private runTag(tag: Tag, ctx: EventCtx) {
    if (tag.once_per_page) {
      if (this.once[`tag:${tag.id}`]) return;
      this.once[`tag:${tag.id}`] = true;
    }
    this.gate(
      this.requiredConsent(tag),
      `tag ${tag.id} (${tag.type})`,
      () => {
        this.log("fire", `tag ${tag.id} (${tag.type})`);
        try {
          fireTag(this, tag, ctx);
        } catch (e) {
          this.log("error", `tag ${tag.id} failed`, String(e));
        }
      },
      this.googleAdvanced(tag),
    );
  }

  private conversionData(conv: Conversion, ctx: EventCtx): ConversionData {
    const get = (n: string) => this.getVar(n, ctx);
    const value = typeof conv.value === "number" ? conv.value : conv.value ? toNumber(get(conv.value)) : undefined;
    const cur = typeof conv.currency === "string" ? conv.currency : conv.currency ? get(conv.currency.var) : undefined;
    const currency = typeof cur === "string" && /^[A-Za-z]{3}$/.test(cur.trim()) ? cur.trim().toUpperCase() : undefined;
    const txn = conv.transaction_id ? get(conv.transaction_id) : undefined;
    const items = conv.items ? get(conv.items) : undefined;
    const raw: RawUserData = { ...this.identity.raw };
    for (const [k, vname] of Object.entries(conv.user_data ?? {})) {
      const v = get(vname as string);
      if (v != null && v !== "") (raw as Record<string, unknown>)[k] = v;
    }
    if (this.identity.userId && raw.external_id == null) raw.external_id = this.identity.userId;
    const user =
      this.consent.ad_user_data === "granted" ? hashUserData(raw, { phoneCountryCode: this.cfg.settings?.phone_country_code }) : {};
    return {
      event_id: `${Date.now().toString(36)}.${rnd(14)}`,
      name: conv.name,
      value,
      currency,
      transaction_id: txn == null || txn === "" ? undefined : String(txn).slice(0, 200),
      items: Array.isArray(items) ? (items.slice(0, 100) as Record<string, unknown>[]) : undefined,
      params: (this.interpolate(conv.params ?? {}, ctx) as Record<string, unknown>) ?? {},
      user,
    };
  }

  private runConversion(conv: Conversion, ctx: EventCtx) {
    if (conv.once_per_page) {
      if (this.once[`conv:${conv.name}`]) return;
      this.once[`conv:${conv.name}`] = true;
    }
    const data = this.conversionData(conv, ctx);
    this.lastEventId = data.event_id;
    const fired: string[] = [];
    for (const platform of Object.keys(conv.send_to)) {
      const tagType = PLATFORM_TAG[platform];
      const tags = this.cfg.tags.filter((t) => t.type === tagType);
      if (!tags.length) {
        this.log("skip", `conversion ${conv.name}: no ${tagType} tag for ${platform}${conv.server ? " (server-side only)" : ""}`);
        continue;
      }
      for (const tag of tags) {
        const ok = this.gate(
          this.requiredConsent(tag),
          `conversion ${conv.name} -> ${platform} (${tag.id})`,
          () => {
            const ran = fireConversionOn(this, platform, tag, conv, data);
            this.log("fire", `conversion ${conv.name} -> ${platform} via ${tag.id}`, {
              event_id: data.event_id,
              value: data.value,
              currency: data.currency,
            });
            if (ran && fired.indexOf(tag.type) === -1) fired.push(tag.type);
          },
          this.googleAdvanced(tag),
        );
        if (!ok) this.log("blocked", `conversion ${conv.name} -> ${platform} waits for consent`);
      }
    }
    this.send({
      type: "conversion",
      event_id: data.event_id,
      name: conv.name,
      value: data.value,
      currency: data.currency,
      transaction_id: data.transaction_id,
      items: data.items,
      params: data.params,
      user_data: data.user,
      user_id: this.identity.userId,
      fired,
    });
    this.log(
      "collect",
      `conversion ${conv.name} sent to ${this.base}/collect${conv.server ? " (server delivery on)" : " (log only; server: false)"}`,
      { event_id: data.event_id, fired },
    );
  }

  private maybeVisit() {
    if (this.cfg.settings?.send_page_views === false || !this.canStore()) return;
    let sessionStart = true;
    try {
      const k = SESSION_KEY + this.boot.id;
      sessionStart = !this.w.sessionStorage.getItem(k);
      this.w.sessionStorage.setItem(k, "1");
    } catch {
      sessionStart = true;
    }
    const hasTouch =
      Object.keys(this.utm()).length > 0 ||
      CLICK_IDS.some((c) => {
        try {
          return new URLSearchParams(this.w.location.search).get(c);
        } catch {
          return false;
        }
      });
    if (!(this.newVisitor || hasTouch || sessionStart || this.boot.preview)) return;
    this.send({ type: "visit", event_id: `v${Date.now().toString(36)}.${rnd(10)}`, new_visitor: this.newVisitor });
  }

  send(body: Record<string, unknown>) {
    const w = this.w;
    const store = this.canStore();
    const ads = this.consent.ad_storage === "granted";
    const ga = this.gaIds();
    // The analytics app's own visitor id (afsa.visitorId()), so its destination can join it.
    const afsa = w.afsa as { visitorId?: () => string } | undefined;
    let avid: string | undefined;
    try {
      avid = afsa && typeof afsa.visitorId === "function" ? afsa.visitorId() : undefined;
    } catch {
      avid = undefined;
    }
    const consent: Record<string, string> = {};
    for (const k of ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"] as const) consent[k] = this.consent[k];
    const payload: Record<string, unknown> = {
      container_id: this.boot.id,
      version: this.boot.v,
      ts: Date.now(),
      page_url: w.location.href.slice(0, 2048),
      page_title: (this.d.title || "").slice(0, 300),
      referrer: (this.d.referrer || "").slice(0, 2048),
      consent,
      first_party: this.firstParty,
      ...body,
    };
    if (store) {
      payload.visitor_id = this.visitorId;
      if (this.firstTouch) payload.first_touch = this.firstTouch;
      const utm = this.utm();
      if (Object.keys(utm).length) payload.utm = utm;
      if (ga.client) payload.ga_client_id = ga.client;
      if (ga.session) payload.ga_session_id = ga.session;
      if (avid) payload.analytics_visitor_id = avid;
    }
    if (ads) {
      if (Object.keys(this.clickIds).length) payload.click_ids = this.clickIds;
      if (this.fbc) payload.fbc = this.fbc;
      if (this.fbp) payload.fbp = this.fbp;
      const ttp = readCookie(this.d, "_ttp");
      if (ttp) payload.ttp = ttp;
    }
    const dom = this.cookieDomain();
    if (this.firstParty && dom) payload.cookie_domain = dom;
    if (this.boot.preview) payload.preview = this.boot.preview;
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    const json = JSON.stringify(payload);
    const url = `${this.base}/collect`;
    const sent = (w.__afst_sent as unknown[]) || ((w.__afst_sent = []) as unknown[]);
    sent.push(payload);
    try {
      if (typeof w.fetch === "function") {
        (w.fetch as typeof fetch)(url, {
          method: "POST",
          body: json,
          keepalive: json.length < 60_000,
          credentials: this.firstParty ? "include" : "omit",
          headers: { "content-type": "text/plain" },
        }).catch(() => undefined);
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      (w.navigator as Navigator).sendBeacon?.(url, json);
    } catch {
      /* give up */
    }
  }
}
