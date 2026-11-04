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
 *   afsr('identify', userId, attrs)   afsr('set', key, value)   afsr('event', name, props)
 *   afsr('consent', true|false)   afsr('stop')   afsr('start')   afsr('upgrade', reason)
 *   afsr('survey', id)   afsr('feedback')
 *
 * Surveys are separate from recording: with active surveys (C.sv) or a ?afsr_survey= preview the
 * survey widget is lazy-loaded after the page's load event whatever the recording decision; it
 * reads tags, identify and the recorded session id through window.__afsrSv.
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
  let up = "";
  // Shared with the survey widget: tags (targeting), identified, the session id, survey commands.
  const T: Record<string, unknown> = {};
  const sv: { T: typeof T; U: number; q: Cmd[]; sid: () => string | null; h?: (c: Cmd) => void } = {
    T,
    U: 0,
    q: [],
    sid: () => api.sessionId!(),
  };
  (w as unknown as { __afsrSv: typeof sv }).__afsrSv = sv;
  const onLoad = (f: () => void) => (d.readyState === "complete" ? setTimeout(f, 1) : addEventListener("load", f));

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
  const schedule = () => onLoad(() => (w.requestIdleCallback ? w.requestIdleCallback(start) : setTimeout(start, 1)));
  /** (Re)start a sampled-in tab once nothing stops it any more. */
  const resume = () => {
    if (!S || !S.on || S.stop || started || !C.on) return;
    if (!consented) return void (boot.state = "consent_pending");
    schedule();
  };

  const api: Afsr = (cmd, ...a) => {
    if (cmd === "survey" || cmd === "feedback") return void (sv.h ? sv.h([cmd, ...a]) : sv.q.push([cmd, ...a]));
    if (cmd === "set") T[String(a[0])] = a[1];
    if (cmd === "identify") {
      sv.U = a[0] == null ? 0 : 1;
      if (a[1] && typeof a[1] === "object") Object.assign(T, a[1]);
    }
    if (cmd === "consent") {
      const was = consented;
      consented = !!a[0];
      if (consented && !was && boot.cmd) boot.cmd(["start"]);
      if (consented && boot.state === "stopped:consent") boot.state = "consent_pending";
      if (consented && boot.state === "consent_pending") resume();
      if (!consented && boot.cmd) boot.cmd(["stop", "consent"]);
      // Consent Mode's "denied" (a[1]) means "not yet", not "stop".
      if (!consented && !boot.cmd && !a[1]) boot.state = "stopped:consent";
      return;
    }
    // A tab not sampled in records from now on (own daily cap); a recorded one is tagged with the reason.
    if (cmd === "upgrade" && !boot.cmd) {
      up = String(a[0] || "upgrade").slice(0, 60);
      if (S && !S.on && !S.stop) {
        S.on = 1;
        S.up = up;
        boot.save();
        resume();
      }
      return;
    }
    // afsr('start') after afsr('stop') (or consent false): recording resumes with a new snapshot.
    if (cmd === "start" && !boot.cmd) {
      if (S && /^(stop|consent)$/.test(S.stop || "")) delete S.stop;
      return resume();
    }
    if (boot.cmd) boot.cmd([cmd, ...a]);
    else boot.queue.push([cmd, ...a]);
  };
  api.sessionId = () => (S && S.on && !S.stop && /^(loading|recording|idle|excluded)$/.test(boot.state) ? S.id : null);
  api.status = () => boot.state;
  w.afsr = api;
  // consent_source gcm: Google Consent Mode's analytics_storage decides (dataLayer, as gtag writes it).
  if (C.gcm && C.consent) {
    const dl = ((w as unknown as { dataLayer?: unknown[] }).dataLayer ||= []);
    const scan = (x: unknown) => {
      const c = x as { 0?: unknown; 2?: { analytics_storage?: string } } | null;
      if (c && c[0] === "consent" && c[2] && c[2].analytics_storage) api("consent", c[2].analytics_storage === "granted", 1);
    };
    for (const x of dl) scan(x);
    const push = dl.push;
    dl.push = (...x: unknown[]) => {
      const r = push.apply(dl, x);
      for (const y of x) scan(y);
      return r;
    };
  }
  // Calls queued before load, in order: consent decides, survey commands wait for the widget, the rest for the recorder.
  for (const q of boot.queue.splice(0)) api(...(q as [string, ...unknown[]]));

  if (!C.on) return void (boot.state = "disabled");
  // ?afsr_survey=rsv_<id>.<token> (test_survey's preview URL) shows that survey now, as a test
  const pv = /[?&]afsr_survey=(rsv_[0-9a-z]{16})\.([0-9a-z]{24})/.exec(location.search);
  if (C.sv || pv)
    onLoad(() => {
      const s = d.createElement("script");
      s.src = `${base}/sv/${C.site}.${pv ? `p.js?preview=${pv[1]}&pt=${pv[2]}` : `${C.sv}.js`}`;
      s.async = true;
      (d.head || d.documentElement).appendChild(s);
    });
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
  if (up && !S.on) {
    S.on = 1;
    S.up = up;
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
