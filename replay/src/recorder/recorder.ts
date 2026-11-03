/**
 * afs-replay recorder, served content-hashed at /recorder.<hash>.js and loaded by the loader
 * (src/recorder/loader.ts) only for tabs that are recorded. Bundled + minified with rrweb's
 * record (MIT) by scripts/build-recorder.mjs (dist/recorder.txt).
 *
 * What leaves the browser:
 * - rrweb events (one DOM snapshot, then mutations, pointer, scroll, input, viewport), with all
 *   text and every input value masked before they are emitted (site mask_mode and selectors),
 *   text attributes (title, alt, placeholder, aria-label, ...) masked the same way, query strings
 *   and fragments removed from the page URL and from links and form actions, hidden input values
 *   masked, blocked elements replaced by a placeholder of the same size;
 * - custom events (protocol.ts TAGS) describing each pageview, click (stable selector, masked
 *   label, interactive or not, position), the first input into each field, scroll position,
 *   errors (scrubbed message and stack), afsr('event') calls, tab hidden / page left / idle.
 * Batches are gzip-compressed with CompressionStream and sent with fetch (keepalive when small);
 * the last batch on pagehide goes uncompressed with sendBeacon.
 */

import { record } from "@rrweb/record";
import { type El, clickTarget, rawLabel, stableSelector, tagDescriptor } from "../lib/describe";
import {
  BUILTIN_BLOCK,
  BUILTIN_IGNORE,
  BUILTIN_MASK,
  BUILTIN_UNMASK,
  type TextRule,
  applyRule,
  inputAlwaysMasked,
  maskAll,
  pathMatches,
  scrubText,
  stripQuery,
  textRule,
} from "../lib/mask-rules";
import { type Envelope, type NavType, TAGS } from "../lib/protocol";
import type { Boot, Cmd } from "./types";

const FLUSH_MS = 5000;
const MAX_BUFFER = 800;
const BEACON_MAX = 63_000;
const MAX_ERRORS_PER_PAGE = 50;

interface SNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
}
type RREvent = { type: number; timestamp: number; data: Record<string, unknown> };

(() => {
  const w = window as unknown as { __afsrBoot?: Boot; afsa?: { visitorId?: () => string | null } };
  const boot = w.__afsrBoot;
  if (!boot || boot.cmd) return;
  delete w.__afsrBoot;
  const { C, S } = boot;
  const d = document;
  const loc = location;
  const nav = navigator;
  const api = `${boot.base}/i`;

  // Drop selectors the browser can't parse (one bad selector must not disable masking for the rest).
  const valid = (list: string) =>
    list
      .split(/,(?![^[(]*[\])])/)
      .map((s) => s.trim())
      .filter((s) => {
        try {
          d.querySelector(s);
          return !!s;
        } catch {
          return false;
        }
      })
      .join(",");
  const UNMASK = valid([BUILTIN_UNMASK, C.unmask].filter(Boolean).join(","));
  const MASK = valid([BUILTIN_MASK, C.maskSel].filter(Boolean).join(","));
  const BLOCK = valid([BUILTIN_BLOCK, C.block].filter(Boolean).join(","));
  const within = (el: Element | null, s: string) => {
    try {
      return !!(el && s && el.closest(s));
    } catch {
      return false;
    }
  };
  const ruleFor = (el: Element | null): TextRule => textRule(C.mask, within(el, UNMASK), within(el, MASK));
  const inputVisible = (el: HTMLElement) =>
    !inputAlwaysMasked(
      (el as HTMLInputElement).type || el.getAttribute("type"),
      el.getAttribute("autocomplete"),
      el.getAttribute("name") || el.id,
    ) &&
    within(el, UNMASK) &&
    !within(el, MASK);

  let buffer: RREvent[] = [];
  let stopRec: (() => void) | null = null;
  let paused: false | "idle" | "excluded" = false;
  let ended = false;
  let lastActivity = Date.now();
  let curPath: string | null = null;
  let errorsThisPage = 0;
  let lastErr = "";
  let lastErrAt = 0;
  let typed = new WeakSet<Element>();
  let sending: Promise<unknown> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | 0 = 0;

  const docH = () => Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
  const docW = () => Math.max(d.documentElement.scrollWidth, d.body ? d.body.scrollWidth : 0);
  const custom = (tag: string, payload: object) => {
    if (!stopRec) return;
    try {
      record.addCustomEvent(tag, payload);
    } catch {
      /* not recording */
    }
  };

  // ---------------------------------------------------------------- scrubbing rrweb events
  const TEXT_ATTRS = [
    "title",
    "alt",
    "placeholder",
    "aria-label",
    "aria-description",
    "aria-placeholder",
    "aria-valuetext",
    "aria-roledescription",
    "label",
    "data-tooltip",
    "data-title",
  ];
  const URL_ATTRS: Record<string, string[]> = {
    a: ["href"],
    area: ["href"],
    form: ["action"],
    button: ["formaction"],
    input: ["formaction"],
  };
  const scrubAttrs = (tag: string, attrs: Record<string, unknown> | undefined, el: Element | null) => {
    if (!attrs) return;
    for (const k of URL_ATTRS[tag] || []) if (typeof attrs[k] === "string") attrs[k] = stripQuery(attrs[k] as string);
    let rule: TextRule | undefined;
    for (const k of TEXT_ATTRS) {
      const v = attrs[k];
      if (typeof v === "string" && v) attrs[k] = applyRule((rule ??= ruleFor(el)), v);
    }
    if (tag === "input" && String(attrs.type).toLowerCase() === "hidden" && typeof attrs.value === "string")
      attrs.value = maskAll(attrs.value);
    if (tag === "iframe" && typeof attrs.srcdoc === "string") attrs.srcdoc = "";
  };
  const walk = (n: SNode | undefined) => {
    if (!n) return;
    if (n.type === 2 && n.tagName) scrubAttrs(n.tagName, n.attributes, record.mirror.getNode(n.id) as Element | null);
    if (n.childNodes) for (const c of n.childNodes) walk(c);
  };
  const scrub = (e: RREvent) => {
    const data = e.data;
    if (e.type === 4 && typeof data.href === "string") data.href = stripQuery(data.href);
    else if (e.type === 2) walk(data.node as SNode);
    else if (e.type === 3 && data.source === 0) {
      for (const a of (data.adds as { node: SNode }[]) || []) walk(a.node);
      for (const a of (data.attributes as { id: number; attributes: Record<string, unknown> }[]) || []) {
        const el = record.mirror.getNode(a.id) as Element | null;
        if (el && el.tagName) scrubAttrs(el.tagName.toLowerCase(), a.attributes, el);
      }
    }
  };

  // ---------------------------------------------------------------- sending
  const avid = () => {
    try {
      const v = w.afsa && w.afsa.visitorId ? w.afsa.visitorId() : null;
      return v ? String(v).slice(0, 64) : undefined;
    } catch {
      return undefined;
    }
  };
  const post = (url: string, body: BodyInit, keepalive: boolean) =>
    fetch(url, { method: "POST", body, keepalive, headers: { "content-type": "text/plain" } })
      .then((r) => r.json())
      .then((j: { stop?: boolean; reason?: string }) => {
        if (j && j.stop) finish(j.reason || "server", true);
      })
      .catch(() => {});
  const gzip = (s: string) => new Response(new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"))).blob();

  const flush = (end?: boolean, unloading?: boolean) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = 0;
    if (!buffer.length && !end) return;
    const env: Envelope = { v: 1, sid: S.id, seq: S.seq++, t: Date.now(), ev: buffer };
    buffer = [];
    if (end) env.end = 1;
    if (S.uid) env.uid = S.uid;
    const av = avid();
    if (av) env.avid = av;
    if (S.f) env.f = 1;
    if (nav.webdriver) env.wd = 1;
    S.last = Date.now();
    boot.save();
    const json = JSON.stringify(env);
    const url = (z: 0 | 1) => `${api}?s=${C.site}&sid=${S.id}&q=${env.seq}&z=${z}`;
    if (unloading || typeof CompressionStream === "undefined") {
      if (json.length < BEACON_MAX && nav.sendBeacon && nav.sendBeacon(url(0), json)) return;
      void post(url(0), json, json.length < BEACON_MAX);
      return;
    }
    sending = sending
      .then(() => gzip(json))
      .then((body) => post(url(1), body, body.size < BEACON_MAX))
      .catch(() => {});
  };
  const flushSoon = (ms: number) => {
    if (!flushTimer) flushTimer = setTimeout(() => flush(), ms);
  };

  // ---------------------------------------------------------------- recording
  const emit = (e: RREvent) => {
    try {
      scrub(e);
    } catch {
      return; // never ship an event we failed to scrub
    }
    buffer.push(e);
    if (e.type === 2) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = 0;
      flushSoon(50); // the snapshot travels in its own chunk
    } else if (buffer.length >= MAX_BUFFER) flush();
    else flushSoon(FLUSH_MS);
  };
  const ALL_INPUTS = {
    color: true,
    date: true,
    "datetime-local": true,
    email: true,
    month: true,
    number: true,
    range: true,
    search: true,
    tel: true,
    text: true,
    time: true,
    url: true,
    week: true,
    textarea: true,
    select: true,
    password: true,
    // rrweb looks the element's tag up too: every <input>, whatever its type (hidden included).
    input: true,
  };
  const start = () => {
    if (stopRec || ended) return;
    stopRec =
      record<RREvent>({
        emit,
        maskAllInputs: true,
        maskInputOptions: ALL_INPUTS,
        maskInputFn: (text, el) => (inputVisible(el) ? text : maskAll(text)),
        maskTextSelector: C.mask === "relaxed" ? MASK || undefined : "*",
        maskTextFn: (text, el) => applyRule(ruleFor(el), text),
        blockSelector: BLOCK || undefined,
        ignoreSelector: BUILTIN_IGNORE,
        slimDOMOptions: {
          script: true,
          comment: true,
          headFavicon: true,
          headWhitespace: true,
          headMetaSocial: true,
          headMetaRobots: true,
          headMetaHttpEquiv: true,
          headMetaAuthorship: true,
          headMetaVerification: true,
          headMetaDescKeywords: true,
        },
        inlineStylesheet: true,
        recordCanvas: false,
        collectFonts: false,
        inlineImages: false,
        sampling: { mousemove: 100, scroll: 150, input: "last", media: 800 },
        errorHandler: () => true,
      }) || null;
    boot.state = stopRec ? "recording" : "stopped:rrweb";
  };
  const pause = (why: "idle" | "excluded") => {
    if (stopRec) {
      stopRec();
      stopRec = null;
    }
    flush();
    paused = why;
    boot.state = why;
  };
  const finish = (reason: string, fromServer?: boolean) => {
    if (ended) return;
    if (!fromServer) custom(TAGS.hide, { pv: S.pv, k: reason === "max_duration" ? "max_duration" : "stop" });
    if (stopRec) {
      stopRec();
      stopRec = null;
    }
    if (!fromServer) flush(true);
    ended = true;
    S.stop = reason;
    boot.save();
    boot.state = `stopped:${reason}`;
  };

  const title = () => {
    const t = d.querySelector("title");
    return d.title ? applyRule(ruleFor(t), d.title.slice(0, 200)) : undefined;
  };
  const referrer = () => {
    try {
      const u = new URL(d.referrer);
      return u.host === loc.host ? u.pathname : u.hostname;
    } catch {
      return undefined;
    }
  };
  const loadType = (): NavType => {
    const entry = performance.getEntriesByType
      ? (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
      : undefined;
    const t = entry && entry.type;
    return t === "reload" ? "reload" : t === "back_forward" ? "back_forward" : "load";
  };

  const pageview = (nav: NavType) => {
    const p = loc.pathname;
    const fresh = curPath === null;
    if (!fresh && p === curPath) return; // query/hash-only change, or replaceState to the same path
    const prev = curPath;
    curPath = p;
    typed = new WeakSet();
    errorsThisPage = 0;
    if (pathMatches(p, C.ex)) {
      if (stopRec) custom(TAGS.hide, { pv: S.pv, k: "excluded" });
      pause("excluded");
      return;
    }
    if (paused === "excluded") {
      paused = false;
      start();
    }
    S.pv++;
    boot.save();
    custom(TAGS.page, {
      pv: S.pv,
      p,
      h: loc.hostname,
      t: title(),
      r: fresh ? referrer() : prev || undefined,
      nav,
      w: innerWidth,
      vh: innerHeight,
      dh: docH(),
    });
  };

  // ---------------------------------------------------------------- interactions
  let actAt = 0;
  const activity = () => {
    const now = Date.now();
    if (now - actAt < 500) return;
    actAt = lastActivity = now;
    S.last = now;
    if (paused === "idle" && !ended) {
      paused = false;
      if (now - S.t0 < C.maxMs) start();
    }
  };
  for (const t of ["mousemove", "keydown", "pointerdown", "touchstart", "wheel", "scroll"])
    addEventListener(t, activity, { passive: true, capture: true });

  const linkTarget = (href: string) => {
    try {
      const u = new URL(href, loc.href);
      if (!/^https?:$/.test(u.protocol)) return undefined;
      return u.host === loc.host ? u.pathname : `${u.origin}${u.pathname}`;
    } catch {
      return undefined;
    }
  };
  d.addEventListener(
    "click",
    (e) => {
      if (!stopRec) return;
      let t = e.target as Element | null;
      if (t && t.nodeType !== 1) t = (t as Node).parentElement;
      if (!t || within(t, BUILTIN_IGNORE)) return;
      const blockEl = BLOCK ? t.closest(BLOCK) : null;
      const ct = clickTarget((blockEl || t) as unknown as El);
      const el = ct.el as unknown as Element;
      let pointer = false;
      try {
        pointer = getComputedStyle(t).cursor === "pointer";
      } catch {
        /* detached */
      }
      const raw = blockEl ? "" : rawLabel(ct.el);
      const rule = ruleFor(el);
      const rect = el.getBoundingClientRect();
      const dh = docH();
      const a = el.closest("a[href]") as HTMLAnchorElement | null;
      const ev = e as MouseEvent;
      custom(TAGS.click, {
        pv: S.pv,
        s: stableSelector(ct.el),
        l: raw ? applyRule(rule, raw) : "",
        lm: raw && rule !== "show" ? 1 : 0,
        tg: tagDescriptor(ct.el),
        i: ct.interactive || pointer ? 1 : 0,
        x: Math.round(ev.pageX),
        y: Math.round(ev.pageY),
        w: docW(),
        dh,
        top: dh ? Math.max(0, Math.min(100, Math.round(((rect.top + scrollY) / dh) * 100))) : 0,
        h: a ? linkTarget(a.getAttribute("href") || "") : undefined,
        b: blockEl ? 1 : undefined,
      });
    },
    true,
  );

  const fieldLabel = (el: HTMLInputElement): { text: string; el: Element } | null => {
    const lab = el.labels && el.labels[0];
    if (lab && lab.textContent && lab.textContent.trim())
      return { text: lab.textContent.replace(/\s+/g, " ").trim().slice(0, 80), el: lab };
    const v = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title");
    return v ? { text: v.replace(/\s+/g, " ").trim().slice(0, 80), el } : null;
  };
  d.addEventListener(
    "input",
    (e) => {
      const el = e.target as HTMLInputElement;
      if (!stopRec || !el || !el.tagName || typed.has(el) || within(el, BUILTIN_IGNORE)) return;
      if (!/^(input|select|textarea)$/i.test(el.tagName)) return;
      typed.add(el);
      const lab = fieldLabel(el);
      custom(TAGS.input, {
        pv: S.pv,
        s: stableSelector(el as unknown as El),
        tg: tagDescriptor(el as unknown as El),
        n: (el.getAttribute("name") || el.id || "").slice(0, 60) || undefined,
        l: lab ? applyRule(ruleFor(lab.el), lab.text) : undefined,
        m: inputVisible(el) ? 0 : 1,
      });
    },
    true,
  );

  let lastY = -1;
  let scrollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const sendScroll = () => {
    scrollTimer = 0;
    const y = Math.round(scrollY);
    if (Math.abs(y - lastY) < 10) return;
    lastY = y;
    custom(TAGS.scroll, { pv: S.pv, y, dh: docH(), vh: innerHeight });
  };
  addEventListener(
    "scroll",
    () => {
      if (!scrollTimer && stopRec) scrollTimer = setTimeout(sendScroll, 250);
    },
    { passive: true },
  );

  // ---------------------------------------------------------------- errors
  const report = (
    k: "error" | "rejection" | "console",
    msg: unknown,
    stack?: unknown,
    file?: string,
    ln?: number,
    col?: number,
    at?: number,
  ) => {
    if (!stopRec || errorsThisPage >= MAX_ERRORS_PER_PAGE) return;
    const m = scrubText(String(msg || "Error"), 500);
    const now = Date.now();
    if (k + m === lastErr && now - lastErrAt < 1000) return;
    lastErr = k + m;
    lastErrAt = now;
    errorsThisPage++;
    custom(TAGS.error, {
      pv: S.pv,
      k,
      m,
      src: file ? stripQuery(String(file)).slice(0, 300) : undefined,
      ln: typeof ln === "number" ? ln : undefined,
      col: typeof col === "number" ? col : undefined,
      st: stack ? scrubText(String(stack), 1500) : undefined,
      at: at && at < now ? at : undefined,
    });
  };
  const describeErr = (r: unknown) => (r instanceof Error ? `${r.name}: ${r.message}` : typeof r === "string" ? r : safeJson(r));
  const safeJson = (v: unknown) => {
    try {
      return JSON.stringify(v).slice(0, 500);
    } catch {
      return String(v);
    }
  };
  addEventListener(
    "error",
    (e) => {
      if (!(e instanceof ErrorEvent)) return; // a resource (img, script) failed to load: not a JS error
      report(
        "error",
        e.error instanceof Error ? describeErr(e.error) : e.message,
        e.error && (e.error as Error).stack,
        e.filename,
        e.lineno,
        e.colno,
      );
    },
    true,
  );
  addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    report("rejection", describeErr(r), r instanceof Error ? r.stack : undefined);
  });
  if (C.errors) {
    const ce = console.error;
    console.error = function (this: Console, ...a: unknown[]) {
      try {
        const err = a.find((x) => x instanceof Error) as Error | undefined;
        report(
          "console",
          a.map((x) => (x instanceof Error ? describeErr(x) : typeof x === "string" ? x : safeJson(x))).join(" "),
          err && err.stack,
        );
      } catch {
        /* never break the page's logging */
      }
      return ce.apply(this, a);
    };
  }

  // ---------------------------------------------------------------- commands, lifecycle
  const cleanProps = (p: unknown) => {
    if (!p || typeof p !== "object") return undefined;
    const o: Record<string, string | number | boolean | null> = {};
    let n = 0;
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (n >= 20) break;
      if (v === null || typeof v === "number" || typeof v === "boolean") o[k.slice(0, 40)] = v;
      else if (typeof v === "string") o[k.slice(0, 40)] = v.slice(0, 200);
      else continue;
      n++;
    }
    return n ? o : undefined;
  };
  const run = ([c, ...a]: Cmd) => {
    if (c === "identify") {
      S.uid = a[0] == null ? undefined : String(a[0]).slice(0, 200);
      boot.save();
    } else if (c === "event") custom(TAGS.event, { pv: S.pv, n: String(a[0]).slice(0, 100), p: cleanProps(a[1]) });
    else if (c === "stop") finish(typeof a[0] === "string" ? a[0] : "stop");
    else if (c === "__err") report("error", a[0], a[1], a[2] as string, a[3] as number, a[4] as number, a[5] as number);
  };

  const h = history;
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = h[m];
    h[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      if (!ended) pageview(m === "pushState" ? "push" : "replace");
      return r;
    };
  }
  addEventListener("popstate", () => !ended && pageview("pop"));
  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState !== "hidden" || ended) return;
    custom(TAGS.hide, { pv: S.pv, k: "hidden" });
    flush(false, true);
  });
  addEventListener("pagehide", () => {
    if (ended) return;
    custom(TAGS.hide, { pv: S.pv, k: "pagehide" });
    flush(true, true);
  });
  setInterval(() => {
    if (ended) return;
    const now = Date.now();
    if (now - S.t0 > C.maxMs) return finish("max_duration");
    if (stopRec && now - lastActivity > C.idleMs) {
      custom(TAGS.idle, { pv: S.pv });
      pause("idle");
    }
    boot.save();
  }, 5000);

  if (!pathMatches(loc.pathname, C.ex)) start();
  pageview(loadType());
  boot.cmd = run;
  for (const q of boot.queue.splice(0)) run(q);
})();
