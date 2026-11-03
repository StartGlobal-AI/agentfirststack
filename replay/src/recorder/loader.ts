/**
 * afs-replay loader, served at /r/<site_id>.js with the site's config inlined as __AFSR__.
 * Bundled + minified by scripts/build-recorder.mjs (dist/loader.txt).
 *
 *   <script defer src="https://HOST/r/rsite_xxx.js"></script>
 *
 * Small on purpose: it decides whether this tab is recorded (enabled, GPC/DNT, opt-out, sampling,
 * consent, max duration) and only then lazy-loads the recorder (rrweb, ~25 KB gzip) after the
 * page's load event, from the same base it was loaded from (so a first-party proxy just works).
 * No cookies: the per-tab session (id, chunk counter, sampling decision) lives in sessionStorage,
 * which the browser clears when the tab closes.
 *
 * Global: window.afsr
 *   afsr.sessionId()  the replay_session_id of this tab, or null when it isn't recorded
 *   afsr.status()     loading | recording | not_sampled | dnt | ignored | disabled |
 *                     consent_pending | excluded | idle | stopped:<reason>
 *   afsr('identify', userId)   afsr('event', name, props)   afsr('consent', true|false)   afsr('stop')
 */

import type { LoaderConfig } from "../lib/protocol";
import type { Boot, Cmd, SessionState } from "./types";

declare const __AFSR__: LoaderConfig & { base: string };

type Afsr = ((cmd: string, ...a: unknown[]) => void) & { q?: IArguments[]; sessionId?: () => string | null; status?: () => string };

(() => {
  const w = window as unknown as { afsr?: Afsr; __afsrBoot?: Boot; doNotTrack?: string; requestIdleCallback?: (f: () => void) => void };
  const C = __AFSR__;
  if (w.afsr && w.afsr.sessionId) return; // included twice
  const d = document;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  const src = ((d.currentScript as HTMLScriptElement | null) || { src: "" }).src;
  const base = src ? src.replace(/\/r\/[^/?#]+\.js([?#].*)?$/, "") : C.base;
  const KEY = `afsr_${C.site}`;
  const store = (k: "sessionStorage" | "localStorage") => {
    try {
      return w[k as keyof typeof w] as unknown as Storage;
    } catch {
      return null;
    }
  };
  const ss = store("sessionStorage");
  const ls = store("localStorage");
  let S: SessionState | null = null;

  const boot: Boot = {
    C,
    S: null as unknown as SessionState,
    base,
    queue: [...((w.afsr && w.afsr.q) || [])].map((x) => [...x] as Cmd),
    state: "loading",
    save: () => {
      try {
        if (ss && S) ss.setItem(KEY, JSON.stringify(S));
      } catch {
        /* storage full or blocked: the session just won't continue on the next page */
      }
    },
  };
  let consented = !C.consent;
  let started = false;

  const start = () => {
    if (started || !S) return;
    started = true;
    boot.state = "loading";
    w.__afsrBoot = boot;
    const s = d.createElement("script");
    s.src = base + C.rec;
    s.async = true;
    (d.head || d.documentElement).appendChild(s);
  };
  const schedule = () => {
    const go = () => (w.requestIdleCallback ? w.requestIdleCallback(start) : setTimeout(start, 1));
    if (d.readyState === "complete") go();
    else addEventListener("load", go);
  };

  const api: Afsr = (cmd, ...a) => {
    if (cmd === "consent") {
      consented = !!a[0];
      if (consented && boot.state === "consent_pending") schedule();
      if (!consented && boot.cmd) boot.cmd(["stop", "consent"]);
      if (!consented && !boot.cmd) boot.state = "stopped:consent";
      return;
    }
    if (boot.cmd) boot.cmd([cmd, ...a]);
    else boot.queue.push([cmd, ...a]);
  };
  api.sessionId = () => (S && S.on && !S.stop && /^(loading|recording|idle|excluded)$/.test(boot.state) ? S.id : null);
  api.status = () => boot.state;
  w.afsr = api;
  // Calls queued before load: consent first (it gates starting), the rest go to the recorder.
  for (const q of boot.queue.filter((x) => x[0] === "consent")) api(...q);
  boot.queue = boot.queue.filter((x) => x[0] !== "consent");

  if (!C.on) return void (boot.state = "disabled");
  if (nav.globalPrivacyControl || nav.doNotTrack === "1" || w.doNotTrack === "1") return void (boot.state = "dnt");
  if (ls && ls.getItem("afsr_ignore")) return void (boot.state = "ignored");

  const force = /[?&]afsr=1(&|$)/.test(location.search) || !!(ls && ls.getItem("afsr_force"));
  const now = Date.now();
  try {
    S = ss ? (JSON.parse(ss.getItem(KEY) || "null") as SessionState | null) : null;
  } catch {
    S = null;
  }
  if (!S || typeof S.id !== "string" || now - S.last > 30 * 60_000) {
    const r = crypto.getRandomValues(new Uint8Array(16));
    let id = "rs_";
    for (const b of r) id += "0123456789abcdefghjkmnpqrstvwxyz"[b & 31];
    S = { id, t0: now, last: now, seq: 0, pv: 0, on: force || Math.random() < C.sr ? 1 : 0 };
    if (force) S.f = 1;
  } else if (force && !S.on) {
    S.on = 1;
    S.f = 1;
  }
  boot.S = S;
  if (S.on && !S.stop && now - S.t0 > C.maxMs) S.stop = "max_duration";
  boot.save();
  if (!S.on) return void (boot.state = "not_sampled");
  if (S.stop) return void (boot.state = `stopped:${S.stop}`);
  if (boot.state === "stopped:consent") return;
  // Errors before the recorder runs (page load is when most happen) are queued for it, with their time.
  addEventListener(
    "error",
    (e) => {
      if (boot.cmd || !(e instanceof ErrorEvent) || boot.queue.length > 40) return;
      const err = e.error as Error | undefined;
      boot.queue.push([
        "__err",
        err instanceof Error ? `${err.name}: ${err.message}` : e.message,
        err && err.stack,
        e.filename,
        e.lineno,
        e.colno,
        Date.now(),
      ]);
    },
    true,
  );
  if (!consented) return void (boot.state = "consent_pending");
  schedule();
})();
