/**
 * afs-replay recorder, served content-hashed at /recorder.<hash>.js and loaded by the loader
 * (src/recorder/loader.ts) only for tabs that are recorded. Bundled + minified with rrweb's
 * record (MIT) by scripts/build-recorder.mjs (dist/recorder.txt).
 *
 * What leaves the browser:
 * - rrweb events (one DOM snapshot, then mutations, pointer, scroll, input, viewport), with all
 *   text and every input value masked before they are emitted (site mask_mode and selectors; a
 *   value is shown only inside [data-afsr-unmask] on the page itself, never because of a setting),
 *   attributes reduced to an allowlist (layout and state as they are, text-like ones such as
 *   title, alt, placeholder, aria-label and data-* masked the same way, everything else dropped),
 *   query strings removed from every URL (links, forms, images, srcset, iframes, CSS url()),
 *   id-like path segments of links and the page URL as ":id", mailto:/tel: reduced to the scheme,
 *   blocked elements replaced by a placeholder of the same size;
 * - custom events (protocol.ts TAGS) describing each pageview, click (stable selector, masked
 *   label, interactive or not, position), the first input into each field, scroll position,
 *   errors (scrubbed message and stack), afsr('event') calls, tab hidden / page left / idle.
 * Batches are gzip-compressed with CompressionStream and sent with fetch (keepalive when small);
 * the last batch on pagehide goes uncompressed with sendBeacon.
 */

import { record } from "@rrweb/record";
import { scrubAttributes } from "../lib/attrs";
import { type El, clickTarget, rawLabel, stableId, stableSelector, tagDescriptor } from "../lib/describe";
import {
  BUILTIN_BLOCK,
  BUILTIN_IGNORE,
  BUILTIN_MASK,
  BUILTIN_UNMASK,
  dropPointerOver,
  SURVEY_HOST_ATTR,
  type TextRule,
  applyRule,
  inputValueVisible,
  maskAll,
  pathExcluded,
  requestUrl,
  scrubCss,
  scrubLink,
  scrubPath,
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
  isSVG?: boolean;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
}
type RREvent = { type: number; timestamp: number; data: Record<string, unknown> };

(() => {
  const w = window as unknown as {
    __afsrBoot?: Boot;
    afsa?: { visitorId?: () => string | null };
    afst?: { visitorId?: () => string | null };
  };
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
  /** The nearest element matching `s` at or above `el`, crossing shadow roots up to their hosts. */
  const closestAcross = (el: Element | null, s: string): Element | null => {
    let cur = el;
    for (let hops = 0; cur && s && hops < 20; hops++) {
      try {
        const hit = cur.closest(s);
        if (hit) return hit;
      } catch {
        return null;
      }
      const root = cur.getRootNode ? cur.getRootNode() : null;
      cur = root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null;
    }
    return null;
  };
  const within = (el: Element | null, s: string) => !!closestAcross(el, s);
  const ruleFor = (el: Element | null): TextRule => textRule(C.mask, within(el, UNMASK), within(el, MASK));
  // A typed value is shown only when the page itself marks the field [data-afsr-unmask] (never
  // through unmask_selectors, a setting anyone with the site's API key could change), and never
  // for passwords, card, one-time-code and secret-named fields.
  const inputVisible = (el: HTMLElement) =>
    inputValueVisible(
      (el as HTMLInputElement).type || el.getAttribute("type"),
      el.getAttribute("autocomplete"),
      el.getAttribute("name") || el.id,
      within(el, BUILTIN_UNMASK),
      within(el, MASK),
    );

  // Heatmap zones: the site's zone selectors in order, else the nearest landmark.
  const ZONES = (C.zn || []).filter((z) => valid(z) === z);
  const zoneOf = (el: Element): string | undefined => {
    for (const z of ZONES) if (closestAcross(el, z)) return z;
    const l = closestAcross(el, "header,nav,main,footer,aside,form,dialog,section[id],[role=dialog]");
    if (!l) return undefined;
    const tag = l.tagName.toLowerCase();
    return l.id && stableId(l.id) ? `${tag}#${l.id}` : tag;
  };

  let buffer: RREvent[] = [];
  let stopRec: (() => void) | null = null;
  let paused: false | "idle" | "excluded" = false;
  let ended = false;
  let lastActivity = Date.now();
  let curPath: string | null = null;
  let errorsThisPage = 0;
  let netThisPage = 0;
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
  // Attributes are an allowlist (lib/attrs.ts): layout and state kept, text-like values masked by
  // the element's rule, URLs scrubbed, everything else dropped.
  const scrubAttrs = (tag: string, attrs: Record<string, unknown> | undefined, el: Element | null, svg: boolean) => {
    if (!attrs) return;
    let r: TextRule | undefined;
    scrubAttributes(tag, attrs, { rule: () => (r ??= ruleFor(el)), svg, metaName: el ? el.getAttribute("name") : null });
  };
  const walk = (n: SNode | undefined) => {
    if (!n) return;
    if (n.type === 2 && n.tagName) scrubAttrs(n.tagName, n.attributes, record.mirror.getNode(n.id) as Element | null, !!n.isSVG);
    if (n.childNodes) for (const c of n.childNodes) walk(c);
  };
  // The survey widget's host (closed shadow root): pointer data over it is never recorded.
  const overSurvey = (id: number) => {
    const n = record.mirror.getNode(id) as Element | null;
    return !!n && n.nodeType === 1 && n.hasAttribute(SURVEY_HOST_ATTR);
  };
  /** Mask, scrub, drop: false = don't send this event at all. */
  const scrub = (e: RREvent): boolean => {
    const data = e.data;
    // MouseMove 1, MouseInteraction 2, TouchMove 6, Drag 12
    if (e.type === 3 && (data.source === 1 || data.source === 2 || data.source === 6 || data.source === 12))
      return dropPointerOver(data as never, overSurvey);
    if (e.type === 4 && typeof data.href === "string") data.href = scrubLink(data.href);
    else if (e.type === 2) walk(data.node as SNode);
    else if (e.type === 3 && data.source === 0) {
      for (const a of (data.adds as { node: SNode }[]) || []) walk(a.node);
      for (const a of (data.attributes as { id: number; attributes: Record<string, unknown> }[]) || []) {
        const el = record.mirror.getNode(a.id) as Element | null;
        if (el && el.tagName)
          scrubAttrs(el.tagName.toLowerCase(), a.attributes, el, typeof SVGElement !== "undefined" && el instanceof SVGElement);
        else a.attributes = {};
      }
    } else if (e.type === 3 && (data.source === 8 || data.source === 13)) {
      // stylesheet rule and style declaration changes: url() references inside them
      const sc = (v: unknown) => (typeof v === "string" ? scrubCss(v) : v);
      for (const a of (data.adds as { rule: string }[]) || []) a.rule = sc(a.rule) as string;
      const set = data.set as { value?: string } | undefined;
      if (set) set.value = sc(set.value) as string;
    }
    return true;
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
  // keepalive fetch is a CORS request, so it always carries the page's real Origin (a beacon can
  // send "Origin: null" under a no-referrer policy, and ingest refuses that).
  const KEEPALIVE = typeof Request !== "undefined" && "keepalive" in Request.prototype;
  const post = (url: string, body: BodyInit, keepalive: boolean) =>
    fetch(url, { method: "POST", body, keepalive, credentials: "omit", headers: { "content-type": "text/plain" } })
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
    // A tags container is linked: its visitor id lets tags apply this visitor's own consent to forwarded signals.
    if (C.tg) {
      try {
        const tv = w.afst && w.afst.visitorId ? w.afst.visitorId() : null;
        if (tv) env.tvid = String(tv).slice(0, 64);
      } catch {
        /* no tags runtime */
      }
    }
    if (S.f) env.f = 1;
    if (S.up) env.up = S.up;
    if (nav.webdriver) env.wd = 1;
    S.last = Date.now();
    boot.save();
    const json = JSON.stringify(env);
    const url = (z: 0 | 1) => `${api}?s=${C.site}&sid=${S.id}&q=${env.seq}&z=${z}`;
    if (unloading || typeof CompressionStream === "undefined") {
      if (json.length < BEACON_MAX && !KEEPALIVE && nav.sendBeacon && nav.sendBeacon(url(0), json)) return;
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
      if (!scrub(e)) return;
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
      return u.host === loc.host ? scrubPath(u.pathname) : u.hostname;
    } catch {
      return undefined;
    }
  };
  const excluded = (p: string) => pathExcluded(p, C.site, C.ex, C.exh);
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
    netThisPage = 0;
    if (excluded(p)) {
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
      p: scrubPath(p),
      h: loc.hostname,
      t: title(),
      r: fresh ? referrer() : prev ? scrubPath(prev) : undefined,
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
      return u.host === loc.host ? scrubPath(u.pathname) : `${u.origin}${scrubPath(u.pathname)}`;
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
      const blockEl = BLOCK ? closestAcross(t, BLOCK) : null;
      const ct = clickTarget((blockEl || t) as unknown as El);
      const el = ct.el as unknown as Element;
      let pointer = false;
      try {
        pointer = getComputedStyle(t).cursor === "pointer";
      } catch {
        /* detached */
      }
      // The label is built from the element's own text with each part masked by its own rule, and
      // blocked or masked descendants never named (a [data-afsr-mask] price inside a button).
      let partMasked = false;
      const textOf = (root: El) => {
        let out = "";
        let n = 0;
        const visit = (node: Node) => {
          if (out.length > 200 || n++ > 400) return;
          if (node.nodeType === 3) {
            const v = node.textContent || "";
            if (!v.trim()) return void (out += v);
            const r = ruleFor(node.parentElement);
            if (r !== "show") partMasked = true;
            out += applyRule(r, v);
          } else if (node.nodeType === 1) {
            const x = node as Element;
            if ((BLOCK && within(x, BLOCK)) || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(x.tagName)) return void (partMasked = true);
            for (const c of Array.from(x.childNodes)) visit(c);
          }
        };
        visit(root as unknown as Node);
        return out;
      };
      const raw = blockEl ? "" : rawLabel(ct.el, textOf);
      const rule = ruleFor(el);
      const rect = el.getBoundingClientRect();
      const dh = docH();
      const a = el.closest("a[href]") as HTMLAnchorElement | null;
      const ev = e as MouseEvent;
      custom(TAGS.click, {
        pv: S.pv,
        s: stableSelector(ct.el),
        l: raw ? applyRule(rule, raw) : "",
        lm: raw && (rule !== "show" || partMasked) ? 1 : 0,
        tg: tagDescriptor(ct.el),
        i: ct.interactive || pointer ? 1 : 0,
        x: Math.round(ev.pageX),
        y: Math.round(ev.pageY),
        w: docW(),
        dh,
        top: dh ? Math.max(0, Math.min(100, Math.round(((rect.top + scrollY) / dh) * 100))) : 0,
        h: a ? linkTarget(a.getAttribute("href") || "") : undefined,
        b: blockEl ? 1 : undefined,
        z: zoneOf(el),
      });
    },
    true,
  );

  // auto_events: a submitted form, named by its stable selector (never its fields' values)
  if (C.ae)
    d.addEventListener(
      "submit",
      (e) => {
        const f = e.target as Element | null;
        if (f && f.tagName && !within(f, BUILTIN_IGNORE))
          custom(TAGS.event, { pv: S.pv, n: "form_submit", p: { form: stableSelector(f as unknown as El), auto: true } });
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
    k: "error" | "rejection" | "console" | "warn",
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
  const wrapConsole = (m: "error" | "warn", k: "console" | "warn") => {
    const ce = console[m];
    console[m] = function (this: Console, ...a: unknown[]) {
      try {
        const err = a.find((x) => x instanceof Error) as Error | undefined;
        report(
          k,
          a.map((x) => (x instanceof Error ? describeErr(x) : typeof x === "string" ? x : safeJson(x))).join(" "),
          err && err.stack,
        );
      } catch {
        /* never break the page's logging */
      }
      return ce.apply(this, a);
    };
  };
  if (C.errors) wrapConsole("error", "console");
  if (C.cw) wrapConsole("warn", "warn");

  // ---------------------------------------------------------------- failed requests (capture_network_errors)
  // Only method, URL path (query stripped, id-like segments as :id) and status leave the browser:
  // never headers or bodies. Our own requests (ingest, surveys) are skipped.
  let lastNet = "";
  let lastNetAt = 0;
  const netFail = (m: unknown, u: unknown, st: number, t0: number) => {
    if (!stopRec || netThisPage >= 30) return;
    const url = requestUrl(String(u), loc.href, boot.base);
    if (!url) return;
    const method = String(m || "GET")
      .toUpperCase()
      .slice(0, 10);
    const now = Date.now();
    if (method + url + st === lastNet && now - lastNetAt < 1000) return;
    lastNet = method + url + st;
    lastNetAt = now;
    netThisPage++;
    custom(TAGS.net, { pv: S.pv, m: method, u: url.slice(0, 300), st, ms: now - t0 });
  };
  if (C.net) {
    const wf = window as unknown as { fetch?: typeof fetch };
    const of = wf.fetch;
    if (of)
      wf.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
        const t0 = Date.now();
        const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
        const m = (init && init.method) || (req ? req.method : "GET");
        const u = req ? req.url : input;
        const p = of.call(this, input, init);
        p.then(
          (r) => {
            if (r.status >= 400) netFail(m, u, r.status, t0);
          },
          (e) => {
            if (!e || (e as Error).name !== "AbortError") netFail(m, u, 0, t0);
          },
        );
        return p;
      };
    const XP = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype : null;
    if (XP) {
      const open = XP.open;
      const send = XP.send;
      XP.open = function (this: XMLHttpRequest & { _afsr?: [unknown, unknown] }, m: string, u: string | URL) {
        this._afsr = [m, u];
        // biome-ignore lint: forwards the page's own arguments
        return (open as any).apply(this, arguments);
      } as typeof XP.open;
      XP.send = function (this: XMLHttpRequest & { _afsr?: [unknown, unknown] }, b?: Document | XMLHttpRequestBodyInit | null) {
        const a = this._afsr;
        const t0 = Date.now();
        if (a) {
          this.addEventListener("load", () => {
            if (this.status >= 400) netFail(a[0], a[1], this.status, t0);
          });
          this.addEventListener("error", () => netFail(a[0], a[1], 0, t0));
          this.addEventListener("timeout", () => netFail(a[0], a[1], 0, t0));
        }
        return send.call(this, b);
      };
    }
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
  // Custom tags: at most 20 keys per tab session, 5 values each, 100 characters, scrubbed like errors.
  const tags = (S.tg = S.tg || {});
  const sendTag = (k: string) => custom(TAGS.tag, { pv: S.pv, k, v: tags[k] });
  const setTag = (k: unknown, v: unknown) => {
    const key = String(k);
    if (!/^(?!__)[A-Za-z0-9_.-]{1,50}$/.test(key) || (!tags[key] && Object.keys(tags).length >= 20)) return;
    const vals = (Array.isArray(v) ? v : [v])
      .filter((x) => x != null && typeof x !== "object")
      .slice(0, 5)
      .map((x) => scrubText(String(x), 100));
    if (!vals.length) return;
    tags[key] = vals;
    boot.save();
    sendTag(key);
  };
  const identify = (id: unknown, attrs: unknown) => {
    const raw = id == null ? "" : String(id).slice(0, 200);
    if (!raw) S.uid = undefined;
    else if (!C.hu) S.uid = raw;
    else
      crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(`afsr:${C.site}:${raw}`))
        .then((b) => {
          S.uid = `h:${Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 32)}`;
          boot.save();
        })
        .catch(() => {});
    boot.save();
    if (attrs && typeof attrs === "object") for (const [k, v] of Object.entries(attrs)) setTag(k, v);
  };
  const run = ([c, ...a]: Cmd) => {
    if (c === "identify") identify(a[0], a[1]);
    else if (c === "set") setTag(a[0], a[1]);
    else if (c === "event") custom(TAGS.event, { pv: S.pv, n: String(a[0]).slice(0, 100), p: cleanProps(a[1]) });
    else if (c === "stop") finish(typeof a[0] === "string" ? a[0] : "stop");
    else if (c === "start" && ended && /^(stop|consent)$/.test(S.stop || "")) {
      // afsr('start') after afsr('stop'), or consent given again: a new snapshot, same session
      ended = false;
      delete S.stop;
      boot.save();
      if (!excluded(loc.pathname)) start();
    } else if (c === "upgrade" && !S.up) {
      S.up = String(a[0] || "upgrade").slice(0, 60);
      boot.save();
    } else if (c === "__err") report("error", a[0], a[1], a[2] as string, a[3] as number, a[4] as number, a[5] as number);
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

  if (!excluded(loc.pathname)) start();
  pageview(loadType());
  for (const k in tags) sendTag(k);
  boot.cmd = run;
  for (const q of boot.queue.splice(0)) run(q);
})();
