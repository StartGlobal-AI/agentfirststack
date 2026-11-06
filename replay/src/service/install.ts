import type { SiteRow } from "./context";
import { PROXY_KEY_HEADER, PROXY_PATH } from "./proxy";

export const FRAMEWORKS = [
  "html",
  "nextjs",
  "react",
  "astro",
  "wordpress",
  "gtm",
  "shopify",
  "webflow",
  "wix",
  "squarespace",
  "framer",
] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const loaderUrl = (base: string, siteId: string) => `${base}/r/${siteId}.js`;

export function scriptSnippet(base: string, siteId: string): string {
  return `<script defer src="${loaderUrl(base, siteId)}"></script>`;
}

/** Keeps afsr('identify' | 'event' | 'consent') calls made before the loader runs. */
export const QUEUE_STUB = "<script>window.afsr=window.afsr||function(){(afsr.q=afsr.q||[]).push(arguments)}</script>";

const code = (base: string, id: string): Record<Framework, { file: string; code: string }> => ({
  html: { file: "every page, inside <head>", code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}` },
  nextjs: {
    file: "app/layout.tsx (App Router), inside <head>; Pages Router: inside <Head> of pages/_document.tsx",
    // A plain <script> is in the server HTML (verify finds it); next/script with afterInteractive isn't.
    code: `// inside <head> of the root layout (a plain <script>, not next/script: it must be in the server HTML)\n<script defer src="${loaderUrl(base, id)}" />`,
  },
  react: { file: "index.html (Vite, CRA), inside <head>", code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}` },
  astro: { file: "src/layouts/Layout.astro, inside <head>", code: `<script is:inline defer src="${loaderUrl(base, id)}"></script>` },
  wordpress: {
    file: "your theme's functions.php (or a header-scripts plugin)",
    code: `add_action('wp_head', function () {\n  echo '${scriptSnippet(base, id)}';\n});`,
  },
  gtm: {
    file: "Google Tag Manager: Custom HTML tag, trigger All Pages",
    code: `<script>(function(){var s=document.createElement('script');s.defer=true;s.src='${loaderUrl(base, id)}';document.head.appendChild(s);})();</script>`,
  },
  shopify: {
    file: "Shopify admin: Online Store > Themes > ... > Edit code > layout/theme.liquid, just before </head> (Shopify's own checkout pages can't take scripts, except on Plus via checkout extensibility)",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  webflow: {
    file: "Webflow: Site settings > Custom code > Head code (a paid site plan), then publish",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  wix: {
    file: "Wix: Settings > Custom code (Advanced) > + Add custom code: paste, Add code to pages: All pages, Place code in: Head (a premium plan with a connected domain)",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  squarespace: {
    file: "Squarespace: Settings > Advanced (Developer tools) > Code injection > Header (Core plan or above)",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
  framer: {
    file: "Framer: Site settings > General > Custom code > End of <head> tag, then publish",
    code: `${QUEUE_STUB}\n${scriptSnippet(base, id)}`,
  },
});

/**
 * Join replay to a product analytics tool: the replay session id as an event property (so an
 * analytics event links to its recording), and the tool's identify passed on to afsr('identify').
 */
export const WITH_TOOLS: Record<"segment" | "mixpanel" | "amplitude", { what: string; code: string }> = {
  segment: {
    what: "Analytics.js: every event gets replay_session_id; identify() is passed to replay (traits you list become tags).",
    code: `analytics.addSourceMiddleware(({ payload, next }) => {
  const id = window.afsr && afsr.sessionId && afsr.sessionId();
  if (id && payload.obj.properties) payload.obj.properties.replay_session_id = id;
  next(payload);
});
analytics.on("identify", (userId, traits) => userId && afsr("identify", userId, { plan: traits && traits.plan }));`,
  },
  mixpanel: {
    what: "Mixpanel: a super property on every event once the replay loader has run; identify alongside mixpanel.identify.",
    code: `window.addEventListener("load", () => {
  const id = window.afsr && afsr.sessionId && afsr.sessionId();
  if (id) mixpanel.register({ replay_session_id: id });
});
// where you call mixpanel.identify(userId):
afsr("identify", userId);`,
  },
  amplitude: {
    what: "Amplitude Browser SDK 2: an enrichment plugin adds replay_session_id to every event; identify alongside setUserId.",
    code: `amplitude.add({
  name: "afs-replay",
  type: "enrichment",
  execute: async (event) => {
    const id = window.afsr && afsr.sessionId && afsr.sessionId();
    if (id) event.event_properties = { ...event.event_properties, replay_session_id: id };
    return event;
  },
});
// where you call amplitude.setUserId(userId):
afsr("identify", userId);`,
  },
};

/** Linked, and the analytics site confirmed its tracker loads this site's recorder. */
export const loadsWithAnalytics = (s: SiteRow) => !!s.analytics_site_id && s.analytics_linked_at != null;

/** An analytics site of the account to link instead of pasting a second snippet (see suggestAnalyticsSite). */
export type AnalyticsSuggestion = { site: { id: string; domain: string } | null; count: number } | null;

const linkBody = (id: string) => `{"analytics_site_id": "${id}"}`;

/**
 * How the recorder gets onto pages, given the analytics link: one sentence for install, next_steps
 * and verify. `paste` = the snippet is still the way in (no confirmed link).
 */
export function analyticsInstallNote(site: SiteRow, suggestion: AnalyticsSuggestion): { text: string; paste: boolean } {
  const a = site.analytics_site_id;
  if (a && loadsWithAnalytics(site))
    return {
      paste: false,
      text: `Nothing to paste on pages that run the AgentFirstStack analytics tracker for ${a}: it loads this site's recorder by itself. The snippet is the alternative, for pages without that tracker, or for a strict Content-Security-Policy where you'd rather serve replay through your own first-party proxy (the tracker fetches the loader from the replay host directly).`,
    };
  if (a)
    return {
      paste: true,
      text: `Linked to analytics site ${a}, but it hasn't confirmed that its tracker loads this recorder (the call failed, or this deployment can't reach analytics). Retry with PATCH /v1/sites/${site.id} ${linkBody(a)} (the same id again re-asserts the link); until then add the snippet.`,
    };
  if (suggestion?.site)
    return {
      paste: true,
      text: `This account has analytics site ${suggestion.site.id} (${suggestion.site.domain}). Link it instead of pasting a second snippet: PATCH /v1/sites/${site.id} ${linkBody(suggestion.site.id)}. Pages that run its tracker then load the recorder by themselves, and frustration signals and JS errors appear in analytics as events.`,
    };
  if (suggestion?.count)
    return {
      paste: true,
      text: `This account has ${suggestion.count} analytics site(s), none for ${site.domain}. If one runs on these pages, link it instead of pasting a second snippet: PATCH /v1/sites/${site.id} ${linkBody("site_...")} (analytics GET /v1/sites lists them).`,
    };
  return {
    paste: true,
    text: `Pages that also run the AgentFirstStack analytics tracker (afsa) get the analytics visitor id attached to each recording automatically. Link the sites with PATCH /v1/sites/:id ${linkBody("site_...")} and the analytics tracker loads this recorder by itself (no second snippet); frustration signals and JS errors are then forwarded to analytics as events.`,
  };
}

/** Where first-party domains are created: the platform site (AUTH_ISSUER), or null when this service runs alone. */
export const platformBase = (env: { AUTH_ISSUER?: string }) => env.AUTH_ISSUER?.trim().replace(/\/+$/, "") || null;

/**
 * The three ways replay reaches pages from the site's own domain, best first. With the analytics
 * tracker loaded from a first-party domain, the recorder comes from that domain by itself.
 */
export function firstPartyBlock(base: string, site: SiteRow, siteBase: string | null) {
  const endpoint = siteBase ? `${siteBase}/v1/first-party-domains` : null;
  return {
    default: true,
    why: "Ad blockers block recorder scripts and uploads on third-party hosts. Serve replay from the site's own domain: use the first of these that works for the site.",
    order: ["first_party_domain", "path_proxy", "direct"],
    first_party_domain: {
      rank: 1,
      what: "A subdomain of the site (e.g. edge.example.com) with one CNAME to this platform, no server code; it serves replay (/_r), analytics (/_a) and tags (/_t) for the whole project. Pages that load the linked analytics tracker from it get the recorder from it too, with nothing to paste; pages without the tracker use the snippet here.",
      when: "You can add a DNS record. If you can't, it's one record to hand the owner.",
      create: endpoint
        ? `POST ${endpoint} {"hostname":"edge.<the site's domain>"} (MCP afs_add_first_party_domain): returns the CNAME to add and next_steps`
        : "Not on this deployment (this replay service runs without the platform site): use the path proxy.",
      status: endpoint ? `GET ${endpoint} until status is "active"` : null,
      snippet: `<script defer src="https://<hostname>/_r/r/${site.id}.js"></script>`,
      label:
        "Pick a neutral label (edge, go, www2), not analytics, stats, track, metrics, pixel, tag or collect: filter lists target those names too.",
    },
    path_proxy: {
      rank: 2,
      what: `Forward ${PROXY_PATH}/* on the site's own server, edge or framework to ${base}${PROXY_PATH}/* unchanged, with the site's proxy key (x-afs-proxy-key) and the visitor's IP and geo. Ready code for a Cloudflare Worker, Next.js, Vercel, a Netlify Edge Function and nginx: first_party_proxy. One proxy for all three: the same code forwards analytics' /_a/* and tags' /_t/* with their own keys.`,
      when: "DNS can't be changed, but the site's server or host can forward a path.",
      snippet: `<script defer src="${PROXY_PATH}/r/${site.id}.js"></script>`,
      configs: "first_party_proxy",
      with_analytics: `With the linked analytics tracker loading the recorder (nothing pasted), set replay_proxy_path: "${PROXY_PATH}" on the analytics site so the tracker loads it through this proxy instead of from ${base}.`,
    },
    direct: {
      rank: 3,
      what: "The plain snippet (or the analytics tracker loading the recorder from this service's host). Last resort: ad blockers block it.",
      snippet: scriptSnippet(base, site.id),
    },
  };
}

/** The proxy key to embed, or why it isn't there. */
export interface ProxyKeyView {
  /** the site's x-afs-proxy-key; null when hidden (read-only key) or unavailable (no ENCRYPTION_KEY) */
  key: string | null;
  /** "read_only": the caller's key can't see it; "unavailable": the deployment can't derive it */
  missing?: "read_only" | "unavailable";
}

const keyText = (p: ProxyKeyView) =>
  p.key ??
  (p.missing === "read_only"
    ? "<hidden: GET this install answer with a full-access key>"
    : "<unavailable: ENCRYPTION_KEY is not set on this deployment>");

/**
 * Path-proxy configs for /_r/* (first_party_proxy). Each forwards the path unchanged with the
 * site's proxy key, the visitor's IP (X-Forwarded-For, set, not appended to) and geo (x-afs-geo-*:
 * country, region, city and, from a Cloudflare Worker, the network operator), drops cookies and
 * any x-afs-* header the visitor sent. The Worker, Next.js and Netlify code take a table of
 * prefixes, so one proxy serves /_a (analytics) and /_t (tags) too with their own keys.
 */
export function proxyInstructions(base: string, site: Pick<SiteRow, "id">, proxy: ProxyKeyView) {
  const key = keyText(proxy);
  const host = new URL(base).host;
  const routes = `const ROUTES = {
  "${PROXY_PATH}/": ["${base}", "${key}"], // replay: this site's proxy key (a secret: keep it server-side)
  // One proxy for all three: add analytics and tags with their own proxy keys, from their install answers
  // (analytics GET /v1/sites/:id/install first_party_proxy, tags GET /v1/containers/:id/install?proxy=1):
  // "/_a/": ["https://<analytics host>", "<analytics proxy_key>"],
  // "/_t/": ["https://<tags host>", "<tags proxy_key>"],
};`;
  return {
    why: "Serving the loader, the recorder and the uploads from the site's own domain makes them first-party: ad blockers don't block them. The loader posts to the origin and path prefix it was loaded from, so only the snippet's src changes.",
    path_prefix: PROXY_PATH,
    snippet: `<script defer src="${PROXY_PATH}/r/${site.id}.js"></script>`,
    proxy_key: proxy.key,
    proxy_key_header: PROXY_KEY_HEADER,
    ...(proxy.missing === "read_only"
      ? {
          proxy_key_note:
            "Hidden from read-only keys: GET /v1/sites/:id/install with a full-access key returns the configs with the key filled in.",
        }
      : proxy.missing === "unavailable"
        ? {
            proxy_key_note:
              "This deployment has no ENCRYPTION_KEY, so it can't derive proxy keys: the operator sets it (wrangler secret put ENCRYPTION_KEY).",
          }
        : {}),
    warning:
      "proxy_key is a secret: it lets a request tell replay the visitor's IP and geo. Put it only in the proxy config or a server env var; don't print it, commit it or put it in page HTML.",
    visitor_ip_and_geo: `Replay trusts the visitor's IP (first X-Forwarded-For hop) and geo (x-afs-geo-* headers, or Vercel's x-vercel-ip-*) only from requests carrying ${PROXY_KEY_HEADER} with this site's key. Every config below sends it. Without it (or with a wrong one) the IP is the proxy's, so the per-network caps (sessions and bytes per network per site and day) count every visitor as one network, and the country is unknown ("eea" consent then applies to everyone); verify reports proxy_key. A first-party domain (first_party.first_party_domain) needs none of this: the platform's edge sends the visitor's IP and geo itself.`,
    cloudflare_worker: {
      route: `<your-domain>${PROXY_PATH}/* (and /_a/*, /_t/* for the other entries)`,
      file: "src/index.js",
      code: `// Worker on your zone: forwards each prefix unchanged with its proxy key and the visitor's IP and geo
${routes}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const prefix = Object.keys(ROUTES).find((p) => url.pathname.startsWith(p));
    if (!prefix) return new Response("Not found", { status: 404 });
    const [origin, key] = ROUTES[prefix];
    const headers = new Headers(request.headers);
    for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k); // never pass on visitor-sent values
    headers.delete("cookie");
    headers.set("${PROXY_KEY_HEADER}", key);
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "");
    const cf = request.cf || {};
    const geo = { country: cf.country, region: cf.region, "region-code": cf.regionCode, city: cf.city, asn: cf.asn };
    for (const [k, v] of Object.entries(geo)) if (v != null && v !== "") headers.set("x-afs-geo-" + k, encodeURIComponent(String(v)));
    return fetch(origin + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
    });
  },
};`,
    },
    nextjs: {
      file: "proxy.ts (Next.js 16+; on Next.js 13-15 name it middleware.ts and the function middleware)",
      code: `import { NextResponse, type NextRequest } from "next/server";

${routes.replace("const ROUTES = {", "const ROUTES: Record<string, [string, string]> = {")}

// Vercel's geo headers -> x-afs-geo-* (other hosts: leave out or map your host's own)
const GEO: Record<string, string> = { country: "x-vercel-ip-country", "region-code": "x-vercel-ip-country-region", city: "x-vercel-ip-city" };

export function proxy(request: NextRequest) {
  const prefix = Object.keys(ROUTES).find((p) => request.nextUrl.pathname.startsWith(p));
  if (!prefix) return NextResponse.next();
  const [origin, key] = ROUTES[prefix];
  const headers = new Headers(request.headers);
  for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k); // never pass on visitor-sent values
  headers.delete("cookie");
  headers.set("${PROXY_KEY_HEADER}", key);
  headers.set("x-forwarded-for", (request.headers.get("x-forwarded-for") || "").split(",")[0].trim());
  for (const [k, h] of Object.entries(GEO)) {
    const v = request.headers.get(h);
    if (v) headers.set("x-afs-geo-" + k, v);
  }
  return NextResponse.rewrite(new URL(request.nextUrl.pathname + request.nextUrl.search, origin), { request: { headers } });
}

export const config = { matcher: ["${PROXY_PATH}/:path*"] }; // add "/_a/:path*", "/_t/:path*" with their ROUTES entries`,
    },
    vercel: {
      file: "vercel.json (any framework): a route with a request-header transform adds the key; Vercel forwards the visitor's IP (x-forwarded-for) and geo (x-vercel-ip-*) to the destination. Analytics and tags are routes of their own next to it.",
      code: JSON.stringify(
        {
          routes: [
            {
              src: `${PROXY_PATH}/(.*)`,
              dest: `${base}${PROXY_PATH}/$1`,
              transforms: [{ type: "request.headers", op: "set", target: { key: PROXY_KEY_HEADER }, args: key }],
            },
          ],
        },
        null,
        2,
      ),
    },
    netlify: {
      file: "netlify/edge-functions/afs-proxy.ts (a Netlify Edge Function: it sends the visitor's IP and geo, which a netlify.toml proxy redirect doesn't)",
      code: `import type { Config, Context } from "@netlify/edge-functions";

${routes.replace("const ROUTES = {", "const ROUTES: Record<string, [string, string]> = {")}

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const prefix = Object.keys(ROUTES).find((p) => url.pathname.startsWith(p));
  if (!prefix) return;
  const [origin, key] = ROUTES[prefix];
  const headers = new Headers(request.headers);
  for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k); // never pass on visitor-sent values
  headers.delete("cookie");
  headers.set("${PROXY_KEY_HEADER}", key);
  headers.set("x-forwarded-for", context.ip);
  const g = context.geo;
  const geo = { country: g?.country?.code, "region-code": g?.subdivision?.code, region: g?.subdivision?.name, city: g?.city };
  for (const [k, v] of Object.entries(geo)) if (v != null && v !== "") headers.set("x-afs-geo-" + k, encodeURIComponent(String(v)));
  return fetch(origin + url.pathname + url.search, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
  });
};

export const config: Config = { path: ["${PROXY_PATH}/*"] }; // add "/_a/*", "/_t/*" with their ROUTES entries`,
    },
    nginx: {
      file: "nginx server block (a location per prefix: analytics' /_a/ and tags' /_t/ look the same with their own keys)",
      code: `location ${PROXY_PATH}/ {
    proxy_pass ${base}${PROXY_PATH}/;
    proxy_set_header Host ${host};
    proxy_ssl_server_name on;
    # this site's secret: replay trusts the IP and geo below only with it
    proxy_set_header X-Afs-Proxy-Key "${key}";
    # visitor IP (behind Cloudflare use $http_cf_connecting_ip instead of $remote_addr)
    proxy_set_header X-Forwarded-For $remote_addr;
    # behind Cloudflare, pass its country on (empty headers are not sent)
    proxy_set_header X-Afs-Geo-Country $http_cf_ipcountry;
    # don't pass on geo headers a visitor sent
    proxy_set_header X-Afs-Geo-Region "";
    proxy_set_header X-Afs-Geo-City "";
    proxy_set_header X-Afs-Geo-Asn "";
    proxy_set_header Cookie "";
}`,
    },
  };
}

export function installInstructions(
  site: SiteRow,
  base: string,
  framework: Framework = "html",
  suggestion: AnalyticsSuggestion = null,
  siteBase: string | null = null,
  proxy: ProxyKeyView = { key: null, missing: "read_only" },
) {
  const all = code(base, site.id);
  const note = analyticsInstallNote(site, suggestion);
  return {
    first_party: firstPartyBlock(base, site, siteBase),
    first_party_proxy: proxyInstructions(base, site, proxy),
    site_id: site.id,
    framework,
    loads_with_analytics: loadsWithAnalytics(site),
    ...(!note.paste ? { nothing_to_paste: note.text } : {}),
    ...(suggestion?.site && !site.analytics_site_id ? { suggested_analytics_site_id: suggestion.site.id } : {}),
    snippet: scriptSnippet(base, site.id),
    file: all[framework].file,
    code: all[framework].code,
    other_frameworks: FRAMEWORKS.filter((f) => f !== framework),
    page_api: {
      "afsr.sessionId()":
        "this tab's replay_session_id (null when the tab isn't recorded). Send it with your analytics events as a prop to link them to the recording.",
      "afsr.status()":
        "loading | recording | not_sampled | dnt | ignored | disabled | consent_pending | excluded | idle | stopped:<reason>",
      "afsr('identify', userId)": "attach your user id to the session (searchable, and deletable with delete_visitor_data).",
      "afsr('event', name, props)": "a named step in the transcript (and usable as a funnel step: event:<name>).",
      "afsr('consent', true | false)": "with require_consent, recording starts only after consent true; false stops it.",
      "afsr('stop')": "stop recording this tab.",
    },
    html_attributes: {
      "data-afsr-unmask": "show this element's text (and its inputs' values, except passwords, card and one-time-code fields) as is",
      "data-afsr-mask": "always mask this element's text",
      "data-afsr-block": "don't record this element at all (a same-size placeholder is recorded)",
      "data-afsr-ignore": "don't record input into this field or clicks on it",
    },
    testing: [
      `Open https://${site.domain}/?afsr=1 in any browser (headless is fine with ?afsr=1): it records regardless of sample_rate and bot filtering.`,
      "localStorage.afsr_ignore = 1 in your own browser stops your visits being recorded.",
      "Browsers sending Global Privacy Control or Do Not Track are never recorded.",
    ],
    with_analytics: note.text,
    with_tools: WITH_TOOLS,
  };
}
