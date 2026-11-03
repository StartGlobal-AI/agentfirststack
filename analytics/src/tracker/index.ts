/**
 * afs-analytics browser tracker, served at /s.js. Bundled + minified by scripts/build-tracker.mjs.
 *
 *   <script defer src="https://HOST/s.js" data-site="site_xxx"></script>
 *
 * Posts text/plain JSON (no CORS preflight) to the same origin + path prefix it was loaded from
 * (/_a/s.js -> /_a/e), so a first-party proxy needs no extra config. data-api overrides it.
 * Global: window.afsa (afsa('event', ...), afsa.visitorId()). No cookies. localStorage holds
 * afsa_vid only when the server says the site is in persistent mode; afsa_ignore opts out.
 */

type Fn = ((cmd: string, ...args: unknown[]) => void) & { q?: IArguments[]; visitorId?: () => string | null };
type Payload = Record<string, unknown>;

(() => {
  const w = window as unknown as { afsa?: Fn };
  const d = document;
  const nav = navigator;
  const loc = location;
  const script = (d.currentScript || d.querySelector('script[data-site][src*="s.js"]')) as HTMLScriptElement | null;
  const site = script && script.getAttribute("data-site");
  if (!script || !site || (w.afsa && w.afsa.visitorId)) return;
  const attr = (k: string) => script.getAttribute("data-" + k);
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
      .then((j: { v?: string; p?: number }) => {
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
    if (lastHref && engaged >= 1000) send("engagement", { e: engaged, u: lastHref }, true);
    engaged = 0;
  };

  const pageview = () => {
    const key = loc.pathname + loc.search;
    if (key === lastKey) return; // replaceState to the same URL, duplicate popstate
    flush();
    lastKey = key;
    lastHref = loc.href;
    send("pageview");
  };

  const afsa: Fn = (cmd, ...a) => {
    if (cmd === "event") send(String(a[0]), a[1] ? { p: a[1] } : undefined);
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
  for (const q of queued) if (q[0] !== "identify") afsa(...q);
})();
