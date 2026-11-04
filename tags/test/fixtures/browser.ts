/**
 * A small fake window/document for running the real bundled runtime (neither jsdom nor happy-dom
 * is installed), served exactly as /c/:id.js serves it (compileScript + needsExt).
 */
import { bundleRuntime } from "../../scripts/build-runtime.mjs";
import type { ContainerConfig } from "../../src/config/schema";
import { compileScript, needsExt } from "../../src/service/script";
import type { BootConfig } from "../../src/runtime/types";

let runtimes: { core: string; ext: string } | null = null;
export async function loadRuntimes() {
  runtimes ??= { core: await bundleRuntime(), ext: await bundleRuntime({ ext: true }) };
  return runtimes;
}

export const CID = "ctr_abcdefgh12345678";
export const BASE = "https://tags.example.net";

export interface FakeEl {
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

export function el(tagName: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
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

export function browser(
  url: string,
  opts: {
    cookies?: Record<string, string>;
    scriptSrc?: string;
    scriptAttrs?: Record<string, string>;
    dataLayer?: unknown[];
    body?: FakeEl[];
    /** Queue timers (run with flushTimers) instead of running them at once. */
    manualTimers?: boolean;
  } = {},
) {
  const u = new URL(url);
  const jar: Record<string, string> = { ...(opts.cookies ?? {}) };
  const fetches: { url: string; body: Record<string, unknown>; init: Record<string, unknown> }[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const winListeners: Record<string, ((e: unknown) => void)[]> = {};
  const timers: (() => void)[] = [];
  const submitted: unknown[] = [];
  const observers: { cb: (entries: unknown[]) => void; els: unknown[] }[] = [];
  const session: Record<string, string> = {};
  const body = el("body", {}, opts.body ?? []);
  const head = el("head");
  const html = el("html", {}, [head, body]);
  const self = el("script", { src: opts.scriptSrc ?? `${BASE}/c/${CID}.js`, ...(opts.scriptAttrs ?? {}) });
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
      if (opts.manualTimers) timers.push(f);
      else f();
      return 1;
    },
    clearTimeout: () => undefined,
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
    HTMLFormElement: {
      prototype: {
        submit(this: unknown) {
          submitted.push(this);
        },
      },
    },
    IntersectionObserver: class {
      els: unknown[] = [];
      constructor(cb: (entries: unknown[]) => void) {
        observers.push({ cb, els: this.els });
      }
      observe(e: unknown) {
        this.els.push(e);
      }
      unobserve() {}
      disconnect() {}
    },
  };
  win.window = win;
  if (opts.dataLayer) win.dataLayer = opts.dataLayer;
  const run = (script: string) => {
    // `with` makes the fake window the global scope for the served script.
    // eslint-disable-next-line no-new-func
    new Function("__w", `with (__w) { ${script} }`)(win);
  };
  /** A DOM event: document listeners (capture phase), then window listeners (bubble phase). */
  const dispatch = (type: string, target: FakeEl, init: Record<string, unknown> = {}) => {
    const e = {
      type,
      target,
      button: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (const f of listeners[type] ?? []) f(e);
    for (const f of winListeners[type] ?? []) f(e);
    return e;
  };
  /** A window event (load, error, pagehide...). */
  const winFire = (type: string, e: Record<string, unknown> = {}) => {
    for (const f of winListeners[type] ?? []) f({ type, ...e });
  };
  const flushTimers = () => {
    for (let i = 0; i < 1000 && timers.length; i++) timers.shift()!();
  };
  /** Report every observed element as intersecting (or not) to the IntersectionObservers. */
  const intersect = (isIntersecting: boolean, ratio = 1) => {
    for (const o of observers) o.cb(o.els.map((target) => ({ target, isIntersecting, intersectionRatio: ratio })));
  };
  const scripts = () => html.querySelectorAll("script").map((s) => s.src ?? s.attrs.src);
  return { win, doc, jar, fetches, run, dispatch, winFire, scripts, session, timers, flushTimers, submitted, intersect };
}

export function serve(
  cfg: ContainerConfig,
  opts: { geo?: { country?: string; region?: string }; preview?: string; env?: BootConfig["env"] } = {},
) {
  if (!runtimes) throw new Error("call loadRuntimes() in beforeAll");
  return compileScript(
    needsExt(cfg) ? runtimes.ext : runtimes.core,
    {
      id: CID,
      v: opts.preview ? "draft" : 3,
      d: "shop.test",
      cfg,
      base: BASE,
      ...(opts.preview ? { preview: opts.preview } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    },
    opts.geo ?? { country: "US", region: "CA" },
  );
}
