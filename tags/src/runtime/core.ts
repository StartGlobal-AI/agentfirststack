import type { ContainerConfig, Conversion, Tag, Trigger, Variable } from "../config/schema";
import { CLICK_ID_DAYS, CLICK_IDS, CONSENT_COOKIE, clickCookieName, FIRST_TOUCH_COOKIE, UTM_KEYS, VISITOR_COOKIE } from "../lib/clickids";
import { compileRegex, matchCondition, toComparable } from "../lib/conditions";
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
import { interpolateHtml } from "../lib/html";
import { type HashedUserData, hashUserData, type RawUserData } from "../lib/pii";
import type { BootConfig, EventCtx, TraceEntry } from "./types";
import {
  closest,
  deepMerge,
  formatValue,
  getPath,
  interpolate,
  interpolateUrl,
  isArgs,
  isObj,
  matches,
  readCookie,
  rnd,
  snapshot,
  textOf,
  toMs,
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
  snap: "snap_pixel",
  analytics: "analytics",
};
const GOOGLE_TAGS = { ga4: true, google_ads: true } as Record<string, boolean>;
const SESSION_KEY = "_afst_s_";
/** Tag types that run in test traffic (the platform's analytics, the owner's code); every other type is an ad or vendor pixel. */
const TEST_RUNS = { analytics: 1, custom_html: 1, custom_js: 1 } as Record<string, number>;
const TEST_SKIP = "test traffic: ad pixels don't fire in the browser; the server-side conversion is sent in test mode";

interface Pending {
  required: ConsentType[];
  run: () => void;
  label: string;
}

/**
 * Optional features in the extension bundle (src/runtime/ext.ts): the Worker serves it only to
 * containers whose config uses them (service/script.ts needsExt), so most sites load less code.
 */
export interface Ext {
  identity?(rt: Runtime): void;
  listeners?(rt: Runtime): void;
  emitted?(rt: Runtime, ctx: EventCtx, fired: Record<string, EventCtx>): void;
  /** conversions[].user_data "auto": email/phone fields found in the form (or page). */
  autoUserData?(root: ParentNode): RawUserData;
}
export const EXT: { x?: Ext } = {};

type Trace = Pick<TraceEntry, "triggers" | "tags" | "conversions">;

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
  /** IAB TCF v2 signals (consent.tcf, set by the extension bundle). */
  tcf?: { gdpr_applies: boolean; tc_string?: string };
  identity: { userId?: string; raw: RawUserData } = { raw: {} };
  pending: Pending[] = [];
  /** Per-page flags (once_per_page, trigger groups, visibility): reset by a history change. */
  once: Record<string, boolean> = {};
  scripts: Record<string, "pending" | "loaded" | "error"> = {};
  vars: Record<string, Variable> = {};
  started = false;
  /** Tag types the page disallows (`data-afst-block` on the snippet's <script>). */
  blocked: Record<string, boolean> = {};
  private scriptEl: Element | null = null;
  private scrollFired: Record<string, boolean> = {};
  private lastUrl = "";
  /** Scripts each tag requested when it fired, and whether it threw (tag sequencing). */
  private seq: Record<string, { srcs: string[]; ok: boolean }> = {};
  /** Tags fired for the event being processed (a setup tag fires once per event). */
  private emitFired: Record<string, boolean> = {};
  /** Preview log entries waiting to be posted, and tag-fire counts for settings.report_tag_fires. */
  private traceBuf: TraceEntry[] = [];
  private traceTimer = false;
  private fires: Record<string, Record<string, number>> = {};
  private firesTimer = false;
  /** The test flag when sessionStorage is unavailable (it then lasts for this page only). */
  private testMem = false;

  constructor(w: Window, d: Document, boot: BootConfig) {
    this.w = w as W;
    this.d = d;
    this.boot = boot;
    const c = boot.cfg || {};
    // Higher priority first; ties keep array order (stable).
    const tags = (c.tags ?? [])
      .filter((t) => t.enabled !== false)
      .map((t, i) => [t, i] as const)
      .sort((a, b) => (b[0].priority ?? 0) - (a[0].priority ?? 0) || a[1] - b[1])
      .map((x) => x[0]);
    this.cfg = { ...c, variables: c.variables ?? [], triggers: c.triggers ?? [], tags, conversions: c.conversions ?? [] };
    for (const v of this.cfg.variables) this.vars[v.name] = v;
    this.consent = initialConsent(c.consent, boot.geo?.country, boot.geo?.region);
    this.analyticsBase = boot.ab;
  }

  // ------------------------------------------------------------------ boot

  start() {
    const w = this.w;
    const id = this.boot.id;
    // settings.respect_dnt (default on): Global Privacy Control or Do Not Track = do nothing at
    // all (no tags, no /collect, no cookies, no storage); afst() stays callable as a no-op.
    const nav = w.navigator as { globalPrivacyControl?: boolean; doNotTrack?: string } | undefined;
    if (
      this.cfg.settings?.respect_dnt !== false &&
      (nav?.globalPrivacyControl === true || nav?.doNotTrack === "1" || w.doNotTrack === "1")
    ) {
      if (typeof w.afst !== "function") w.afst = () => undefined;
      this.debug = !!this.boot.preview || !!this.cfg.settings?.debug;
      this.log("info", "GPC/DNT on: nothing runs (settings.respect_dnt)");
      return;
    }
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
    // ?afsa_debug=1 (=0) turns the tab's test flag on (off), as the analytics tracker does.
    if (this.tab((/\bafsa_debug=([01])/.exec(w.location.search) || [])[1]) && !this.boot.preview)
      this.log("info", `${TEST_SKIP}. ?afsa_debug=0 or afst('test', false) ends it.`);
    try {
      this.firstParty = new URL(this.base).host === w.location.host;
    } catch {
      this.firstParty = false;
    }
    for (const t of (this.scriptEl?.getAttribute?.("data-afst-block") ?? "").split(/[\s,]+/)) {
      if (t === "custom") this.blocked.custom_html = this.blocked.custom_js = true;
      else if (t) this.blocked[t] = true;
    }
    if (this.boot.preview)
      this.log("info", `PREVIEW of container ${id} (v${this.boot.v}). Add ?afst_preview=off to the URL to leave preview.`);
    this.log("info", `container ${id} v${this.boot.v} loaded`, {
      consent: this.consent,
      geo: this.boot.geo,
      blocked: Object.keys(this.blocked),
    });

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
    if (cs && cs.src && cs.src.indexOf(`/c/${id}.js`) !== -1) {
      src = cs.src;
      this.scriptEl = cs;
    }
    if (!src && this.d.querySelectorAll) {
      const all = this.d.querySelectorAll("script[src]");
      for (let i = 0; i < all.length; i++) {
        const s = (all[i] as HTMLScriptElement).src;
        if (s && s.indexOf(`/c/${id}.js`) !== -1) {
          src = s;
          this.scriptEl = all[i]!;
        }
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

  /**
   * The tab's test-traffic flag, shared with the analytics tracker and replay: sessionStorage
   * afsa_debug "1" (?afsa_debug=1, afsa('debug'), afst('test', true)) or "0". Sets it when v is given.
   */
  private tab(v?: string): boolean {
    if (v) this.testMem = v === "1";
    try {
      const ss = this.w.sessionStorage;
      if (v) ss.setItem("afsa_debug", v);
      return ss.getItem("afsa_debug") === "1";
    } catch {
      return this.testMem;
    }
  }

  /** Test traffic (a preview build, or the tab flag): ad pixels don't run, hits go to /collect with test: 1. */
  get test(): boolean {
    return !!this.boot.preview || this.tab();
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

  interpolateUrl(template: string, ctx: EventCtx) {
    return interpolateUrl(template, (n) => this.getVar(n, ctx));
  }

  /** A param_set variable's params (templates resolved), for event_params_from / config_params_from. */
  paramSet(name: string | undefined, ctx: EventCtx): Record<string, unknown> {
    const v = name ? this.getVar(name, ctx) : undefined;
    return isObj(v) ? v : {};
  }

  userHashes(): HashedUserData {
    return hashUserData(this.identity.raw, { phoneCountryCode: this.cfg.settings?.phone_country_code });
  }

  userId() {
    return this.identity.userId;
  }

  // ------------------------------------------------------------------ identity

  canStore() {
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
    // Cross-domain linking (extension): a visitor/click ids carried over from a linked site.
    EXT.x?.identity?.(this);
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
    else if (cmd === "test") {
      // afst('test', true | false): the tab's flag, shared with the analytics tracker (told at once).
      this.tab(a === false ? "0" : "1");
      if (typeof this.w.afsa === "function") (this.w.afsa as (...x: unknown[]) => void)("debug", this.test);
    }
  }

  get(what: string): unknown {
    if (what === "test") return this.test;
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
    this.log("blocked", `${label} waits for consent: ${this.missing(required)}`);
    return false;
  }

  private missing(required: ConsentType[]) {
    return required.filter((r) => this.consent[r] !== "granted").join(", ");
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
    // Consent initialization (CMP loaders), then initialization, then the page view.
    this.emit(this.ctx("consent_init", "consent_init"));
    this.emit(this.ctx("init", "init"));
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

  ctx(type: string, name: string, extra?: Partial<EventCtx>): EventCtx {
    return { type, name, model: snapshot(this.model), ts: Date.now(), ...extra };
  }

  // ------------------------------------------------------------------ listeners

  has(type: Trigger["type"]) {
    return this.cfg.triggers.some((t) => t.type === type);
  }

  /** Click/submit listeners: capture phase, plus window bubble phase for check_validation / wait_for_tags. */
  private domListener(type: "click" | "submit", trig: "click" | "form_submit") {
    const ts = this.cfg.triggers.filter((t) => t.type === trig);
    if (!ts.length) return;
    const make = (e: Event, phase?: "b") => {
      const target = e.target as Element | null;
      if (!target || !target.nodeType) return;
      if (trig === "form_submit") this.emit(this.ctx("form_submit", "form_submit", { form: target, el: target, ev: e, phase }));
      else {
        const el = closest(target, "a,button,[role=button],input[type=submit],input[type=button]") || target;
        this.emit(this.ctx("click", "click", { el, ev: e, phase }));
      }
    };
    if (ts.some((t) => !bubbles(t))) this.d.addEventListener(type, (e) => make(e), true);
    if (ts.some(bubbles)) this.w.addEventListener(type, (e) => !e.defaultPrevented && make(e, "b"));
  }

  private installListeners() {
    const w = this.w;
    this.domListener("click", "click");
    this.domListener("submit", "form_submit");
    if (this.has("history_change") || this.cfg.tags.some((t) => t.type === "microsoft_uet") || this.cfg.settings?.report_tag_fires) {
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
    if (this.boot.preview || this.cfg.settings?.report_tag_fires) {
      const flush = () => {
        this.flushTrace();
        this.flushFires();
      };
      this.d.addEventListener("visibilitychange", () => this.d.visibilityState === "hidden" && flush());
      w.addEventListener("pagehide", flush);
    }
    EXT.x?.listeners?.(this);
  }

  private domReady() {
    const w = this.w;
    this.emit(this.ctx("dom_ready", "dom_ready"));
    const IO = (w as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    for (const trig of this.cfg.triggers) {
      if (trig.type !== "element_visible" || !IO) continue;
      const mode = trig.once === undefined || trig.once === true ? "element" : trig.once;
      const seen = new WeakSet<Element>();
      const timers = new Map<Element, number>();
      const fire = (el: Element, ratio: number, ms: number) => {
        const key = `vis:${trig.id}`;
        if (mode === "page") {
          if (this.once[key]) return;
          this.once[key] = true;
        } else if (mode === "element") {
          if (seen.has(el)) return;
          seen.add(el);
          io.unobserve(el);
        }
        this.emit(
          this.ctx("element_visible", "element_visible", {
            triggerId: trig.id,
            el,
            vars: { percent_visible: Math.round(ratio * 100), visible_ms: ms },
          }),
        );
      };
      const io = new IO(
        (entries) => {
          for (const en of entries) {
            const el = en.target;
            if (!en.isIntersecting) {
              w.clearTimeout(timers.get(el));
              timers.delete(el);
              continue;
            }
            const min = trig.min_duration_ms ?? 0;
            if (!min) fire(el, en.intersectionRatio, 0);
            else if (!timers.has(el))
              timers.set(
                el,
                w.setTimeout(() => {
                  timers.delete(el);
                  fire(el, en.intersectionRatio, min);
                }, min),
              );
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
      const MO = (w as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
      if (trig.observe_dom && MO && this.d.body) {
        let pending = false;
        new MO(() => {
          if (pending) return;
          pending = true;
          w.setTimeout(() => {
            pending = false;
            observe();
          }, 300);
        }).observe(this.d.body, { childList: true, subtree: true });
      }
    }
    if (this.has("window_loaded")) {
      const loaded = () => this.emit(this.ctx("window_loaded", "window_loaded"));
      if (this.d.readyState === "complete") loaded();
      else w.addEventListener("load", loaded);
    }
  }

  private onHistory(source: string) {
    const href = this.w.location.href;
    if (href === this.lastUrl) return;
    const old = this.lastUrl;
    this.flushFires();
    this.lastUrl = href;
    this.once = {};
    this.scrollFired = {};
    this.log("info", `history change (${source}) -> ${href}`);
    this.emit(
      this.ctx("history_change", "history_change", { vars: { history_source: source, history_old_url: old, history_new_url: href } }),
    );
  }

  private checkScroll() {
    const de = this.d.documentElement;
    const w = this.w;
    for (const trig of this.cfg.triggers) {
      if (trig.type !== "scroll_depth") continue;
      const hz = trig.direction === "horizontal";
      const pos = (hz ? w.scrollX || de.scrollLeft : w.scrollY || de.scrollTop) || 0;
      const pct = Math.min(
        100,
        Math.round((pos / Math.max(hz ? de.scrollWidth - w.innerWidth : de.scrollHeight - w.innerHeight, 1)) * 100),
      );
      const dir = hz ? "horizontal" : "vertical";
      const hit = (n: number, units: string, reached: boolean) => {
        const key = `${trig.id}:${units}${n}`;
        if (!reached || this.scrollFired[key]) return;
        this.scrollFired[key] = true;
        this.emit(
          this.ctx("scroll_depth", "scroll_depth", { triggerId: trig.id, scroll: n, vars: { scroll_units: units, scroll_direction: dir } }),
        );
      };
      for (const p of trig.percentages ?? []) hit(p, "percent", pct >= p);
      for (const px of trig.pixels ?? []) hit(px, "pixels", pos >= px);
    }
  }

  // ------------------------------------------------------------------ variables

  getVar(name: string, ctx: EventCtx, depth = 0): unknown {
    const v = this.vars[name];
    if (!v) return this.builtin(name, ctx);
    let val = depth > 8 ? undefined : this.resolveVar(v, ctx, depth);
    if (v.format) val = formatValue(val, v.format);
    return val === undefined || val === null || val === "" ? v.default : val;
  }

  private scopeQuery(sel: string, ctx: EventCtx): Element | null {
    try {
      const inForm = ctx.form && (ctx.form as Element).querySelector ? (ctx.form as Element).querySelector(sel) : null;
      return inForm || this.d.querySelector(sel);
    } catch {
      return null;
    }
  }

  private resolveVar(v: Variable, ctx: EventCtx, depth: number): unknown {
    const input = (n: string) => this.getVar(n, ctx, depth + 1);
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
      case "lookup": {
        const k = toComparable(input(v.input));
        if (Object.prototype.hasOwnProperty.call(v.map, k)) return v.map[k];
        if (v.ignore_case) for (const m of Object.keys(v.map)) if (m.toLowerCase() === k.toLowerCase()) return v.map[m];
        return undefined;
      }
      case "regex_table": {
        const s = toComparable(input(v.input));
        for (const row of v.rows) {
          const m = compileRegex(v.full_match === false ? row.pattern : `^(?:${row.pattern})$`, v.ignore_case)?.exec(s);
          if (!m) continue;
          return typeof row.output === "string" && v.extract !== false
            ? row.output.replace(/\$(\d)/g, (_, n: string) => m[+n] ?? "")
            : row.output;
        }
        return undefined;
      }
      case "url": {
        const src = v.source ? input(v.source) : this.w.location.href;
        if (src == null || src === "") return undefined;
        let u: URL;
        try {
          u = new URL(String(src), this.w.location.href);
        } catch {
          return undefined;
        }
        switch (v.component) {
          case "href":
            return u.href;
          case "protocol":
            return u.protocol.replace(":", "");
          case "host":
            return v.strip_www ? u.hostname.replace(/^www\./, "") : u.hostname;
          case "port":
            return u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
          case "path":
            return u.pathname;
          case "query":
            return u.search.slice(1);
          case "fragment":
            return u.hash.slice(1);
          default:
            return v.param ? (u.searchParams.get(v.param) ?? undefined) : undefined;
        }
      }
      case "event_attr":
        return (ctx.el ?? ctx.form)?.getAttribute?.(v.attr) ?? undefined;
      case "param_set":
        // Templates resolve with the depth carried along, so a cycle (refused by validation, but
        // possible in a previewed draft) ends instead of overflowing the stack.
        return interpolate(v.params, (n) => this.getVar(n, ctx, depth + 1));
      case "custom_js":
        if (this.blocked.custom_js) return undefined;
        try {
          // eslint-disable-next-line no-new-func
          return new Function("event", v.code)({ type: ctx.type, name: ctx.name, data: ctx.data, model: ctx.model });
        } catch (e) {
          this.log("error", `variable ${v.name} failed`, String(e));
          return undefined;
        }
      default:
        return this.builtin(v.type, ctx);
    }
  }

  private builtin(name: string, ctx: EventCtx): unknown {
    const loc = this.w.location;
    const el = ctx.el as (Element & { href?: string }) | null | undefined;
    const form = ctx.form as Element | null | undefined;
    const click = ctx.type === "click";
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
        return click ? textOf(el) : undefined;
      case "click_url": {
        if (!click) return undefined;
        const a = closest(el, "a[href]") as HTMLAnchorElement | null;
        return a ? a.href || a.getAttribute("href") || "" : "";
      }
      case "click_target":
        return click ? (closest(el, "a[href]")?.getAttribute("target") ?? "") : undefined;
      case "click_element":
        return click ? el : undefined;
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
      case "form_target":
        return form?.getAttribute?.("target") ?? "";
      case "form_text":
        return form ? textOf(form) : undefined;
      case "form_element":
        return form ?? undefined;
      case "event_element":
        return el ?? form ?? undefined;
      case "scroll_depth":
        return ctx.scroll;
      case "container_id":
        return this.boot.id;
      case "container_version":
        return this.boot.v;
      case "environment":
        return this.boot.env?.name ?? (this.boot.preview ? "preview" : "live");
      case "debug_mode":
        return this.debug;
      case "visitor_id":
        return this.visitorId;
      case "ga_client_id":
        return this.gaIds().client;
      case "ga_session_id":
        return this.gaIds().session;
      default:
        return ctx.vars?.[name];
    }
  }

  // ------------------------------------------------------------------ triggers + firing

  /** Why a trigger's conditions fail (null: they all pass). */
  private conds(t: Trigger, c: EventCtx): string | null {
    for (const cond of t.conditions ?? []) {
      const v = this.getVar(cond.var, c);
      if (!matchCondition(v, cond.op, cond.value, cond.ignore_case)) {
        const shown = typeof v === "object" && v ? "(element)" : JSON.stringify(typeof v === "string" ? v.slice(0, 100) : v);
        return `${cond.var} ${shown} fails ${cond.op} ${JSON.stringify(cond.value)}`;
      }
    }
    return null;
  }

  /** The matched context, or why not ("" = this event isn't the trigger's kind). */
  private matchTrigger(t: Trigger, ctx: EventCtx): EventCtx | string {
    if (t.type !== ctx.type) return "";
    let c = ctx;
    switch (t.type) {
      case "custom_event":
        if (t.event_regex ? !compileRegex(t.event_regex, t.ignore_case)?.test(ctx.name) : t.event !== ctx.name) return "";
        break;
      case "click": {
        if ((bubbles(t) ? "b" : undefined) !== ctx.phase) return "";
        let el: Element | null | undefined = ctx.el;
        if (t.selector) el = closest(el, t.selector);
        if (t.links_only) el = closest(el, "a[href]");
        if (!el) return t.links_only ? "not a link click" : `click not on ${t.selector}`;
        c = { ...ctx, el };
        break;
      }
      case "form_submit":
        if ((bubbles(t) ? "b" : undefined) !== ctx.phase) return "";
        if (t.selector && !matches(ctx.form, t.selector)) return `form doesn't match ${t.selector}`;
        break;
      case "element_visible":
      case "scroll_depth":
      case "timer":
      case "video":
        if (ctx.triggerId !== t.id) return "";
        break;
    }
    return this.conds(t, c) ?? c;
  }

  emit(ctx: EventCtx) {
    const fired: Record<string, EventCtx> = {};
    const tr: Trace | null = this.boot.preview ? { triggers: [], tags: [], conversions: [] } : null;
    const why: Record<string, string> = {};
    for (const t of this.cfg.triggers) {
      const m = this.matchTrigger(t, ctx);
      if (typeof m !== "string") fired[t.id] = m;
      else if (m) why[t.id] = m;
    }
    // Trigger groups: once per page, after every member has fired (on this page).
    for (const g of this.cfg.triggers) {
      if (g.type !== "trigger_group" || this.once[`grp:${g.id}`]) continue;
      for (const id of g.triggers) if (fired[id]) this.once[`grp:${g.id}:${id}`] = true;
      if (!g.triggers.every((id) => this.once[`grp:${g.id}:${id}`])) continue;
      const no = this.conds(g, ctx);
      if (no) why[g.id] = no;
      else {
        this.once[`grp:${g.id}`] = true;
        fired[g.id] = ctx;
      }
    }
    const ids = Object.keys(fired);
    if (tr) {
      for (const id of ids) tr.triggers.push({ id, matched: true });
      for (const id of Object.keys(why)) tr.triggers.push({ id, matched: false, reason: why[id] });
    }
    if (!ids.length) {
      if (ctx.type === "custom_event") this.log("event", `${ctx.name} (no trigger)`);
    } else {
      this.log("trigger", `${ctx.type}${ctx.type === "custom_event" ? ` "${ctx.name}"` : ""} -> ${ids.join(", ")}`);
      this.emitFired = {};
      for (const tag of this.cfg.tags) {
        const hit = tag.triggers.find((id) => fired[id]);
        if (!hit) {
          const miss = tr && tag.triggers.find((id) => why[id]);
          if (miss) this.note(tr, tag, "not_fired", `trigger ${miss}: ${why[miss]}`);
          continue;
        }
        const ex = (tag.exclude_triggers ?? []).find((id) => fired[id]);
        if (ex) {
          this.log("skip", `tag ${tag.id}: excluded by trigger`);
          this.note(tr, tag, "excluded", `exclude_triggers: ${ex} fired`, hit);
          continue;
        }
        this.runTag(tag, fired[hit]!, tr, hit);
      }
      for (const conv of this.cfg.conversions) {
        const c = fired[conv.trigger];
        if (c) this.runConversion(conv, c, tr);
        else if (tr && why[conv.trigger])
          tr.conversions.push({ name: conv.name, status: "not_fired", reason: `trigger ${conv.trigger}: ${why[conv.trigger]}` });
      }
      EXT.x?.emitted?.(this, ctx, fired);
    }
    if (tr && (tr.triggers.length || tr.tags.length))
      this.trace({ ts: ctx.ts, event: ctx.type === "custom_event" ? ctx.name : ctx.type, page: this.w.location.pathname, ...tr });
    if (ctx.type === "page_view") this.maybeVisit();
  }

  private requiredConsent(tag: Tag): ConsentType[] {
    return (tag.consent ?? DEFAULT_TAG_CONSENT[tag.type] ?? []) as ConsentType[];
  }

  private googleAdvanced(tag: Tag) {
    return this.cfg.consent?.google_consent_mode === "advanced" && !!GOOGLE_TAGS[tag.type];
  }

  /** Record a tag's outcome: the preview trace and the report_tag_fires counts. */
  private note(tr: Trace | null, tag: Tag, status: string, reason?: string, trigger?: string) {
    if (tr) tr.tags.push({ id: tag.id, type: tag.type, status, ...(reason ? { reason } : {}), ...(trigger ? { trigger } : {}) });
    // fired, error and test_skipped are counted where they happen (fireNow), also for tags released later by consent.
    if (status === "skipped" || status === "blocked" || status === "excluded") this.count(tag.id, status);
  }

  /** An ad or vendor pixel in test traffic: it would fire, but doesn't. */
  private held(tag: Tag) {
    return !TEST_RUNS[tag.type] && this.test;
  }

  /**
   * Fire a tag now: "fired", "error", or "test_skipped" (a pixel in test traffic). Remembers the
   * scripts it requested (for tags sequenced after it).
   */
  private fireNow(tag: Tag, ctx: EventCtx): string {
    const n = Object.keys(this.scripts).length;
    let status = "fired";
    this.emitFired[tag.id] = true;
    if (this.held(tag)) {
      status = "test_skipped";
      this.log("skip", `tag ${tag.id} (${tag.type}): ${TEST_SKIP}`);
    } else {
      this.log("fire", `tag ${tag.id} (${tag.type})`);
      try {
        fireTag(this, tag, ctx);
      } catch (e) {
        status = "error";
        this.log("error", `tag ${tag.id} failed`, String(e));
      }
    }
    this.count(tag.id, status);
    this.seq[tag.id] = { srcs: Object.keys(this.scripts).slice(n), ok: status !== "error" };
    return status;
  }

  private runTag(tag: Tag, ctx: EventCtx, tr: Trace | null, trigger?: string) {
    const skip = (reason: string) => {
      this.log("skip", `tag ${tag.id}: ${reason}`);
      this.note(tr, tag, "skipped", reason, trigger);
    };
    if (this.emitFired[tag.id]) return skip("already fired for this event (as a setup tag)");
    if (this.blocked[tag.type]) return skip(`${tag.type} is blocked on this page (data-afst-block)`);
    if (tag.live_only && this.test) return skip("live_only: not fired in test traffic (preview, ?afsa_debug=1)");
    if (tag.schedule) {
      const now = Date.now();
      const s = toMs(tag.schedule.start);
      const e = toMs(tag.schedule.end);
      if ((s && now < s) || (e && now > e)) return skip("outside its schedule");
    }
    if (tag.once_per_page) {
      if (this.once[`tag:${tag.id}`]) return skip("once_per_page: already fired on this page");
      this.once[`tag:${tag.id}`] = true;
    }
    let status = "blocked";
    const required = this.requiredConsent(tag);
    this.gate(
      required,
      `tag ${tag.id} (${tag.type})`,
      () => {
        if (tag.after) {
          status = this.held(tag) ? "test_skipped" : "fired";
          this.sequence(tag, ctx);
        } else status = this.fireNow(tag, ctx);
      },
      this.googleAdvanced(tag),
    );
    this.note(
      tr,
      tag,
      status,
      status === "blocked"
        ? `waits for consent: ${this.missing(required)}`
        : status === "test_skipped"
          ? TEST_SKIP
          : tag.after
            ? `after setup tag ${tag.after.tag}`
            : undefined,
      trigger,
    );
  }

  /** Tag sequencing: fire the setup tag first (once per page), wait for its scripts, then this tag. */
  private sequence(tag: Tag, ctx: EventCtx) {
    const after = tag.after!;
    const setup = this.cfg.tags.find((t) => t.id === after.tag);
    if (setup && !this.seq[setup.id]) {
      const ok = this.gate(
        this.requiredConsent(setup),
        `setup tag ${setup.id}`,
        () => this.fireNow(setup, ctx),
        this.googleAdvanced(setup),
      );
      if (!ok) return this.log("skip", `tag ${tag.id}: setup tag ${setup.id} waits for consent`);
    }
    const st = setup ? this.seq[setup.id] : undefined;
    const wait = (n: number) => {
      if (st && n < 50 && st.srcs.some((s) => this.scripts[s] === "pending")) {
        this.w.setTimeout(() => wait(n + 1), 100);
        return;
      }
      if (after.require_success && (!st || !st.ok || st.srcs.some((s) => this.scripts[s] === "error"))) {
        this.log("skip", `tag ${tag.id}: setup tag ${after.tag} failed`);
        this.count(tag.id, "skipped");
        return;
      }
      this.fireNow(tag, ctx);
    };
    wait(0);
  }

  private conversionData(conv: Conversion, ctx: EventCtx): ConversionData {
    const get = (n: string) => this.getVar(n, ctx);
    const value = typeof conv.value === "number" ? conv.value : conv.value ? toNumber(get(conv.value)) : undefined;
    const cur = typeof conv.currency === "string" ? conv.currency : conv.currency ? get(conv.currency.var) : undefined;
    const currency = typeof cur === "string" && /^[A-Za-z]{3}$/.test(cur.trim()) ? cur.trim().toUpperCase() : undefined;
    const txn = conv.transaction_id ? get(conv.transaction_id) : undefined;
    const items = conv.items ? get(conv.items) : undefined;
    const raw: RawUserData = { ...this.identity.raw };
    const map = conv.user_data;
    if (map === "auto") Object.assign(raw, EXT.x?.autoUserData?.((ctx.form as Element | null) ?? this.d));
    else
      for (const [k, vname] of Object.entries(map ?? {})) {
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

  private runConversion(conv: Conversion, ctx: EventCtx, tr: Trace | null) {
    if (conv.once_per_page) {
      if (this.once[`conv:${conv.name}`]) {
        tr?.conversions.push({ name: conv.name, status: "skipped", reason: "once_per_page: already fired on this page" });
        return;
      }
      this.once[`conv:${conv.name}`] = true;
    }
    const data = this.conversionData(conv, ctx);
    this.lastEventId = data.event_id;
    const fired: string[] = [];
    const waiting: string[] = [];
    const held: string[] = [];
    for (const platform of Object.keys(conv.send_to)) {
      const tagType = PLATFORM_TAG[platform];
      const tags = this.cfg.tags.filter((t) => t.type === tagType && !this.blocked[t.type]);
      if (!tags.length) {
        this.log("skip", `conversion ${conv.name}: no ${tagType} tag for ${platform}${conv.server ? " (server-side only)" : ""}`);
        continue;
      }
      for (const tag of tags) {
        const ok = this.gate(
          this.requiredConsent(tag),
          `conversion ${conv.name} -> ${platform} (${tag.id})`,
          () => {
            if (this.held(tag)) {
              held.push(platform);
              return this.log("skip", `conversion ${conv.name} -> ${platform}: ${TEST_SKIP}`);
            }
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
        if (!ok) {
          waiting.push(platform);
          this.log("blocked", `conversion ${conv.name} -> ${platform} waits for consent`);
        }
      }
    }
    const why = [waiting.length ? `waits for consent: ${waiting.join(", ")}` : "", held.length ? `${held.join(", ")}: ${TEST_SKIP}` : ""]
      .filter(Boolean)
      .join("; ");
    tr?.conversions.push({ name: conv.name, status: "fired", platforms: fired, ...(why ? { reason: why } : {}) });
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

  // ------------------------------------------------------------------ preview log + tag telemetry

  private trace(e: TraceEntry) {
    if (this.traceBuf.length >= 200) return;
    this.traceBuf.push(e);
    if (this.traceBuf.length >= 20) this.flushTrace();
    else if (!this.traceTimer) {
      this.traceTimer = true;
      this.w.setTimeout(() => this.flushTrace(), 1000);
    }
  }

  private flushTrace() {
    this.traceTimer = false;
    if (!this.traceBuf.length) return;
    const entries = this.traceBuf.splice(0, 50);
    this.send({ type: "debug", entries });
  }

  private count(tagId: string, status: string) {
    if (!this.cfg.settings?.report_tag_fires || this.boot.preview) return;
    const c = (this.fires[tagId] ??= {});
    c[status] = (c[status] ?? 0) + 1;
    if (!this.firesTimer) {
      this.firesTimer = true;
      this.w.setTimeout(() => this.flushFires(), 15_000);
    }
  }

  private flushFires() {
    this.firesTimer = false;
    const fires: { tag_id: string; status: string; n: number }[] = [];
    for (const id of Object.keys(this.fires))
      for (const s of Object.keys(this.fires[id]!)) fires.push({ tag_id: id, status: s, n: this.fires[id]![s]! });
    this.fires = {};
    if (fires.length) this.send({ type: "tags", fires: fires.slice(0, 200) });
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
    const d = this.d;
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
      page_title: (d.title || "").slice(0, 300),
      referrer: (d.referrer || "").slice(0, 2048),
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
      payload.ttp = readCookie(d, "_ttp");
      payload.scid = readCookie(d, "_scid");
      payload.rdt_uuid = readCookie(d, "_rdt_uuid");
    }
    if (this.tcf) payload.tcf = this.tcf;
    const dom = this.cookieDomain();
    if (this.firstParty && dom) payload.cookie_domain = dom;
    if (this.boot.preview) payload.preview = this.boot.preview;
    if (this.test) payload.test = 1;
    if (this.boot.env) payload.env = this.boot.env.token;
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

/** click/form_submit triggers that listen in the bubble phase (after the site's own handlers). */
const bubbles = (t: Trigger) => (t.type === "click" || t.type === "form_submit") && !!(t.check_validation || t.wait_for_tags_ms);
