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
 * Session replay: when the site is linked to a replay site, the /e answer carries r (that site's
 * replay loader URL) and the tracker adds <script async src=r> once per page load (not on SPA
 * navigations). Only https URLs (http://localhost and 127.0.0.1 for local dev), and not when
 * window.afsr already has sessionId (the replay snippet is installed directly). The loader makes
 * its own sampling, bot, DNT and consent decisions.
 */

type Fn = ((cmd: string, ...args: unknown[]) => void) & { q?: IArguments[]; visitorId?: () => string | null };
type Entry = PerformanceEntry & { value: number; duration: number; interactionId?: number; hadRecentInput?: boolean };
type Payload = Record<string, unknown>;

(() => {
  const w = window as unknown as { afsa?: Fn; afsr?: { sessionId?: unknown } };
  const d = document;
  const nav = navigator;
  const loc = location;
  const script = (d.currentScript || d.querySelector('script[data-site][src*="s.js"]')) as HTMLScriptElement | null;
  const site = script && script.getAttribute("data-site");
  if (!script || !site || (w.afsa && w.afsa.visitorId)) return;
  const attr = (k: string) => script.getAttribute("data-" + k);
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
  let lastV: string | null = null; // id echoed by the server (cookieless: today's hash)
  let uid: string | null = null;
  let lastKey: string | null = null;
  let lastHref = "";
  let engaged = 0;
  let since = 0;
  let depth = 0; // max scroll depth (%) of the current page
  // Web Vitals of the loaded page; emptied for good once an SPA navigation happens (they describe the first page only)
  let vt: number[] = [];
  let hard = 1;
  let rl = 0; // replay loader added (once per page load)

  const send = (n: string, extra?: Payload, beacon?: boolean) => {
    const body: Payload = { s: site, n, u: loc.href, r: d.referrer || undefined, ...extra };
    if (uid) body.i = uid;
    if (vid) body.id = vid;
    if (nav.webdriver) body.b = 1;
    if ((nav as { globalPrivacyControl?: boolean }).globalPrivacyControl || nav.doNotTrack === "1") body.d = 1;
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

  const pageview = () => {
    const key = loc.pathname + loc.search;
    if (key === lastKey) return; // replaceState to the same URL, duplicate popstate
    flush();
    if (lastKey !== null) hard = 0;
    lastKey = key;
    lastHref = loc.href;
    depth = 0;
    measure();
    send("pageview");
  };

  const notFound = () => send("404", { p: { from: bare(d.referrer) || undefined } });

  const afsa: Fn = (cmd, ...a) => {
    if (cmd === "event") send(String(a[0]), a[1] ? { p: a[1] } : undefined);
    else if (cmd === "404") notFound();
    else if (cmd === "revenue") send(String(a[0]), { $: [a[1], a[2]], p: a[3] });
    else if (cmd === "identify") uid = a[0] == null ? null : String(a[0]);
    else if (cmd === "pageview") {
      lastKey = null;
      pageview();
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
  addEventListener("popstate", pageview);
  d.addEventListener("visibilitychange", () => (visible() ? (since = Date.now()) : flush()));
  addEventListener("pagehide", flush);
  addEventListener("scroll", measure, { passive: true });

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

  // Opt-in: form submits (the form's id, name or action path; never field values)
  if (on("forms"))
    d.addEventListener(
      "submit",
      (ev) => {
        const f = ev.target as HTMLFormElement;
        send("form_submit", { p: { form: f.id || f.getAttribute("name") || bare(f.getAttribute("action") || loc.pathname) } }, true);
      },
      true,
    );

  // Outbound links and file downloads
  if (attr("auto") !== "false") {
    const onClick = (ev: Event) => {
      const a = (ev.target as Element | null)?.closest?.("a");
      if (!a || !a.href) return;
      let u: URL;
      try {
        u = new URL(a.href, loc.href);
      } catch {
        return;
      }
      if (!/^https?:$/.test(u.protocol)) return;
      const url = u.origin + u.pathname;
      if (/\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|rtf|epub|dmg|exe|msi|pkg|deb|apk|iso|mp3|mp4|mov|avi|wav|7z|rar|gz|tgz)$/i.test(u.pathname))
        send("file_download", { p: { url } }, true);
      else if (u.host !== loc.host) send("outbound_click", { p: { url } }, true);
    };
    d.addEventListener("click", onClick, true);
    d.addEventListener("auxclick", onClick, true);
  }

  since = visible() ? Date.now() : 0;
  for (const q of queued) if (q[0] === "identify") afsa(...q);
  pageview();
  // Opt-in 404 pages: status from Navigation Timing, or a <meta name="afsa-404"> hint
  if (nf) notFound();
  for (const q of queued) if (q[0] !== "identify") afsa(...q);
})();
