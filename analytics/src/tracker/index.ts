/**
 * afs-analytics browser tracker, served at /s.js. Bundled + minified by scripts/build-tracker.mjs.
 *
 *   <script defer src="https://HOST/s.js" data-site="site_xxx"></script>
 *
 * Posts text/plain JSON (no CORS preflight) to the same origin + path prefix it was loaded from
 * (/_a/s.js -> /_a/e), so a first-party proxy needs no extra config. data-api overrides it.
 * Global: window.afsa (afsa('event', ...), afsa.visitorId()). No cookies. localStorage holds
 * afsa_vid only when the server says the site is in persistent mode; afsa_ignore opts out.
 *
 * The engagement beacon also carries the page's max scroll depth (sd) and, for the page that was
 * loaded (not SPA navigations), Core Web Vitals v = [LCP ms, INP ms, CLS x 1000]. Opt-in:
 * data-404="true" sends a "404" event on pages served with status 404 (or with
 * <meta name="afsa-404">), and data-forms="true" sends "form_submit" {form} on every form submit.
 *
 * Test traffic: afsa('debug') (or data-debug="true") marks every following event dbg: 1; the
 * server stores it but leaves it out of reports unless asked for (realtime?debug=only).
 *
 * Collection extras (all opt-in through attributes on the script tag or on page elements):
 *   data-hash="true"            hash routing: #/route changes are pageviews (h: 1)
 *   data-title="true"           send document.title with pageviews (t)
 *   data-props='{"ab":"b"}'     props on every event; afsa('props', {...}) adds more
 *   data-before-send="fn"       window.fn(name, payload) returns the payload to send, or null to drop
 *   data-downloads="pdf,zip"    the file extensions that count as downloads
 *   data-link-paths="/go/*"     same-host redirect paths that count as outbound clicks
 *   <el data-afsa-event="x" data-afsa-prop-plan="pro">   a click sends event x {plan}
 *   <el data-afsa-view="x" data-afsa-view-threshold="0.5"> element_view {name: x} once per pageview
 *   afsa('event', n, props, {interactive: false})       ni: 1 (doesn't un-bounce the session)
 *   afsa('pageview', {url, props})                      a manual pageview with its own URL / props
 * Pageviews carry w (viewport width; stored as a class). data-forms="true" also sends form_start.
 *
 * Session replay: when the site is linked to a replay site, the /e answer carries r (that site's
 * replay loader URL) and the tracker adds <script async src=r> once per page load (not on SPA
 * navigations). Only https URLs (http://localhost and 127.0.0.1 for local dev), and not when
 * window.afsr already has sessionId (the replay snippet is installed directly). The loader makes
 * its own sampling, bot, DNT and consent decisions.
 */

/** Compile-time: the cross-domain linker is in the /s.js?linker=1 build only (scripts/build-tracker.mjs). */
declare const __LINKER__: boolean;

type Fn = ((cmd: string, ...args: unknown[]) => void) & { q?: IArguments[]; visitorId?: () => string | null };
type Entry = PerformanceEntry & { value: number; duration: number; interactionId?: number; hadRecentInput?: boolean };
type Payload = Record<string, unknown>;
type IO = typeof IntersectionObserver;

(() => {
  const w = window as unknown as { afsa?: Fn; afsr?: { sessionId?: unknown } };
  const d = document;
  const nav = navigator;
  const loc = location;
  const script = (d.currentScript || d.querySelector('script[data-site][src*="s.js"]')) as HTMLScriptElement | null;
  const site = script && script.getAttribute("data-site");
  if (!script || !site || (w.afsa && w.afsa.visitorId)) return;
  const get = (el: Element, k: string) => el.getAttribute(k);
  const attr = (k: string) => get(script, "data-" + k);
  // addEventListener on window (t omitted) or on a target, capture phase when c
  const on2 = (e: string, f: (ev: Event) => void, t: EventTarget = w as unknown as EventTarget, c?: boolean | object) =>
    t.addEventListener(e, f, c);
  const on = (k: string) => attr(k) === "true";
  const bare = (u: string) => u.split(/[?#]/)[0];
  const api = attr("api") || script.src.replace(/s\.js([?#].*)?$/, "e");
  const KEY = "afsa_vid";
  const store = (() => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  })();
  if (store && store.getItem("afsa_ignore")) return; // localStorage.afsa_ignore = 1 excludes your own visits

  let vid = store ? store.getItem(KEY) : null; // persistent mode only
  // data-require-consent="true": nothing is sent (or stored) until afsa('consent', true)
  let ok = !on("require-consent");
  // Cross-domain (the linker build): _afsa=<visitor id>.<minute>.<check> from a linked domain.
  // check = FNV-1a (base 36) of "<user agent>|<id>|<minute>": a copied link stops working in another
  // browser, and after 2 minutes. The parameter is then taken out of the address bar.
  if (__LINKER__) {
    // FNV-1a 32-bit, base 36 (not a secret: it ties a link to a browser and a minute)
    const linkCheck = (s: string) => {
      let x = 2166136261;
      for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
      return (x >>> 0).toString(36);
    };
    const lk = /[?&]_afsa=([\w-]{8,64})\.(\d+)\.([0-9a-z]+)/.exec(loc.search);
    if (lk) {
      const m = (Date.now() / 6e4) | 0;
      if (m - +lk[2]! <= 2 && m >= +lk[2]! && linkCheck(`${nav.userAgent}|${lk[1]}|${lk[2]}`) === lk[3]) vid = lk[1]!;
      const clean = new URL(loc.href);
      clean.searchParams.delete("_afsa");
      history.replaceState(history.state, "", clean.href);
    }
  }

  let lastV: string | null = null; // id echoed by the server (cookieless: today's hash)
  let uid: string | null = null;
  let up: unknown; // user properties from identify, sent once with the next event
  let lastKey: string | null = null;
  let lastHref = "";
  let engaged = 0;
  let since = 0;
  let depth = 0; // max scroll depth (%) of the current page
  // Web Vitals of the loaded page; emptied for good once an SPA navigation happens (they describe the first page only)
  let vt: number[] = [];
  let hard = 1;
  let rl = 0; // replay loader added (once per page load)
  let dbg = on("debug"); // test traffic: stored, left out of reports (afsa('debug'), data-debug="true")
  const hashed = on("hash");
  let pu: string | null = null; // the current page's URL from afsa('pageview', {url})
  let gp: Payload = {}; // props sent with every event
  try {
    gp = JSON.parse(attr("props") || "{}");
  } catch {
    /* not JSON: none */
  }
  const hook = attr("before-send");
  let seen: Record<string, number> = {}; // element_view names sent on this page
  let forms: unknown[] = []; // forms started on this page
  let obs: IntersectionObserver[] = [];

  const send = (n: string, extra?: Payload, beacon?: boolean) => {
    if (!ok) return;
    let body: Payload | null = { s: site, n, u: pu || loc.href, r: d.referrer || undefined, ...extra };
    if (n !== "engagement") {
      const p = { ...gp, ...((body.p as Payload) || {}) };
      body.p = Object.keys(p).length ? p : undefined;
    }
    if (hashed) body.h = 1;
    if (uid) body.i = uid;
    if (up) (body.up = up), (up = 0);
    if (vid) body.id = vid;
    if (nav.webdriver) body.b = 1;
    if (dbg) body.dbg = 1;
    if ((nav as { globalPrivacyControl?: boolean }).globalPrivacyControl || nav.doNotTrack === "1") body.d = 1;
    const f = hook && (w as unknown as Record<string, (n: string, b: Payload) => Payload | null>)[hook];
    if (f && !(body = f(n, body))) return;
    const data = JSON.stringify(body);
    if (beacon && nav.sendBeacon && nav.sendBeacon(api, data)) return;
    fetch(api, { method: "POST", body: data, keepalive: true })
      .then((r) => r.json())
      .then((j: { v?: string; p?: number; r?: string }) => {
        const r = j && j.r;
        if (r && !rl && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(r) && !(w.afsr && w.afsr.sessionId)) {
          rl = 1;
          const s = d.createElement("script");
          s.async = true;
          s.src = r;
          d.head.appendChild(s);
        }
        if (!j || !j.v) return;
        lastV = j.v;
        if (!store) return;
        if (j.p) store.setItem(KEY, (vid = vid || j.v));
        else if (vid) {
          store.removeItem(KEY); // site switched back to cookieless
          vid = null;
        }
      })
      .catch(() => {});
  };

  // Visible time on the current page, flushed with sendBeacon when hidden or left.
  const visible = () => d.visibilityState === "visible";
  const tick = () => {
    if (since) engaged += Date.now() - since;
    since = visible() ? Date.now() : 0;
  };
  const flush = () => {
    tick();
    if (lastHref && engaged >= 1000)
      send("engagement", { e: engaged, u: lastHref, sd: depth, v: hard ? vt.map(Math.round) : undefined }, true);
    engaged = 0;
  };

  const measure = () => {
    const el = d.documentElement;
    depth = Math.max(depth, Math.min(100, Math.round(((scrollY + innerHeight) / Math.max(el.scrollHeight, 1)) * 100)));
  };

  // element_view: each [data-afsa-view] element once per pageview, when enough of it is visible
  const scan = () => {
    const I = (w as unknown as { IntersectionObserver?: IO }).IntersectionObserver;
    obs.forEach((o) => o.disconnect());
    obs = [];
    if (I)
      d.querySelectorAll("[data-afsa-view]").forEach((el) => {
        const o = new I(
          (es) =>
            es.forEach((e) => {
              const name = get(el, "data-afsa-view")!;
              if (e.isIntersecting && !seen[name]) {
                seen[name] = 1;
                o.disconnect();
                send("element_view", { p: { name } }, true);
              }
            }),
          { threshold: +(get(el, "data-afsa-view-threshold") || 0.5) },
        );
        o.observe(el);
        obs.push(o);
      });
  };

  const pageview = (o?: { url?: string; props?: Payload }) => {
    const key = (o && o.url) || loc.pathname + loc.search + (hashed ? loc.hash : "");
    if (key === lastKey) return; // replaceState to the same URL, duplicate popstate
    flush();
    if (lastKey !== null) hard = 0;
    lastKey = key;
    pu = o && o.url ? new URL(o.url, loc.href).href : null;
    lastHref = pu || loc.href;
    depth = 0;
    seen = {};
    forms = [];
    measure();
    send("pageview", { p: o && o.props, w: innerWidth, t: on("title") ? d.title : undefined });
    setTimeout(scan, 500); // after an SPA navigation the new page renders a moment later
  };

  const notFound = () => send("404", { p: { from: bare(d.referrer) || undefined } });

  const afsa: Fn = (cmd, ...a) => {
    if (cmd === "event") send(String(a[0]), { p: a[1], ni: (a[2] as { interactive?: boolean })?.interactive === false ? 1 : undefined });
    else if (cmd === "404") notFound();
    else if (cmd === "revenue") send(String(a[0]), { $: [a[1], a[2]], p: a[3] });
    else if (cmd === "identify") (uid = a[0] == null ? null : String(a[0])), (up = a[1]);
    else if (cmd === "debug") dbg = a[0] !== false;
    else if (cmd === "props") gp = { ...gp, ...(a[0] as Payload) };
    else if (cmd === "consent")
      // old < new only on the change to granted: then the page's pageview goes (once); withdrawn:
      // nothing more is sent, and the stored id goes
      (ok as unknown as number) < ((ok = a[0] !== false) as unknown as number)
        ? ((lastKey = null), pageview())
        : ok || store?.removeItem(KEY);
    else if (cmd === "pageview") {
      lastKey = null;
      pageview(a[0] as { url?: string; props?: Payload });
    }
  };
  afsa.visitorId = () => vid || lastV;

  const queued = [...((w.afsa && w.afsa.q) || [])].map((x) => [...x] as [string, ...unknown[]]);
  w.afsa = afsa;

  // SPA navigations
  const h = history;
  (["pushState", "replaceState"] as const).forEach((m) => {
    const orig = h[m];
    h[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
      orig.apply(this, args);
      pageview();
    };
  });
  on2("popstate", () => pageview());
  if (hashed) on2("hashchange", () => pageview());
  on2("visibilitychange", () => (visible() ? (since = Date.now()) : flush()), d);
  on2("pagehide", flush);
  on2("scroll", measure, w as unknown as EventTarget, { passive: true });

  // Core Web Vitals: LCP (last candidate), INP (slowest interaction), CLS (largest 5 s session window).
  let nf: unknown = 0; // this page is a 404 (opt-in)
  try {
    const PO = PerformanceObserver;
    const po = (type: string, cb: (e: Entry) => void, o?: object) =>
      new PO((l) => l.getEntries().forEach((e) => hard && cb(e as Entry))).observe({ type, buffered: true, ...o });
    po("largest-contentful-paint", (e) => (vt[0] = e.startTime));
    po("event", (e) => e.interactionId && (vt[1] = Math.max(vt[1] || 0, e.duration)), { durationThreshold: 40 });
    if (PO.supportedEntryTypes.includes("layout-shift")) {
      let sum = 0;
      let first = 0;
      let last = 0;
      vt[2] = 0;
      po("layout-shift", (e) => {
        const t = e.startTime;
        if (e.hadRecentInput) return;
        if (t - last > 1000 || t - first > 5000) sum = first = 0;
        if (!first) first = t;
        last = t;
        vt[2] = Math.max(vt[2]!, (sum += e.value * 1000));
      });
    }
    nf =
      on("404") &&
      ((performance.getEntriesByType("navigation")[0] as { responseStatus?: number }).responseStatus === 404 ||
        d.querySelector('meta[name="afsa-404"]'));
  } catch {
    /* no PerformanceObserver: no vitals */
  }

  // Opt-in: form starts (first input) and submits (the form's id, name or action path; never field values)
  const formName = (f: HTMLFormElement) => f.id || get(f, "name") || bare(get(f, "action") || loc.pathname);
  if (on("forms")) {
    on2("submit", (ev) => send("form_submit", { p: { form: formName(ev.target as HTMLFormElement) } }, true), d, true);
    on2(
      "input",
      (ev) => {
        const f = (ev.target as HTMLInputElement).form;
        if (f && forms.indexOf(f) < 0) {
          forms.push(f);
          send("form_start", { p: { form: formName(f) } });
        }
      },
      d,
      true,
    );
  }

  // Click events from data attributes; outbound links (and same-host redirect paths) and downloads
  const auto = attr("auto") !== "false";
  const ext = (
    attr("downloads") || "pdf,zip,docx?,xlsx?,pptx?,csv,txt,rtf,epub,dmg,exe,msi,pkg,deb,apk,iso,mp3,mp4,mov,avi,wav,7z,rar,gz,tgz"
  )
    .replace(/[^\w,?]/g, "")
    .replace(/,/g, "|");
  const links = (attr("link-paths") || "")
    .split(",")
    .filter(Boolean)
    .map(
      (g) =>
        new RegExp(
          `^${g
            .trim()
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")}$`,
        ),
    );
  const onClick = (ev: Event) => {
    const t = ev.target as Element | null;
    const el = t && t.closest && t.closest("[data-afsa-event]");
    if (el && ev.type === "click") {
      const p: Payload = {};
      for (const x of [...el.attributes]) if (x.name.startsWith("data-afsa-prop-")) p[x.name.slice(15).replace(/-/g, "_")] = x.value;
      send(get(el, "data-afsa-event")!, { p }, true);
    }
    const a = auto && t && t.closest && t.closest("a");
    if (!a || !a.href) return;
    let u: URL;
    try {
      u = new URL(a.href, loc.href);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    // a link to a linked domain (data-cross-domain) carries the visitor id across (persistent mode)
    if (__LINKER__) {
      const i = vid || lastV;
      const linkCheck = (s: string) => {
        let x = 2166136261;
        for (let j = 0; j < s.length; j++) x = Math.imul(x ^ s.charCodeAt(j), 16777619);
        return (x >>> 0).toString(36);
      };
      if (i && (attr("cross-domain") || "").split(",").includes(u.hostname)) {
        const m = (Date.now() / 6e4) | 0;
        u.searchParams.set("_afsa", `${i}.${m}.${linkCheck(`${nav.userAgent}|${i}|${m}`)}`);
        a.href = u.href;
      }
    }

    const url = u.origin + u.pathname;
    if (new RegExp(`\\.(${ext})$`, "i").test(u.pathname)) send("file_download", { p: { url } }, true);
    else if (u.host !== loc.host || links.some((r) => r.test(u.pathname))) send("outbound_click", { p: { url } }, true);
  };
  on2("click", onClick, d, true);
  on2("auxclick", onClick, d, true);

  since = visible() ? Date.now() : 0;
  const early = (c: string) => c === "identify" || c === "debug" || c === "props";
  for (const q of queued) if (early(q[0])) afsa(...q);
  pageview();
  // Opt-in 404 pages: status from Navigation Timing, or a <meta name="afsa-404"> hint
  if (nf) notFound();
  for (const q of queued) if (!early(q[0])) afsa(...q);
})();
