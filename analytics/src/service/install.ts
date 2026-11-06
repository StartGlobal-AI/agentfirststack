import { PROXY_KEY_HEADER } from "../lib/geo";
import { STRIPE_EVENTS } from "../lib/stripe";

/**
 * Install + first-party proxy instructions. Pure: (site, base URL, framework, proxy key) -> JSON an
 * agent can apply directly (file paths and exact code).
 */

export const FRAMEWORKS = ["html", "nextjs", "astro", "react", "wordpress", "gtm", "tags"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const PROXY_PATH = "/_a";

/** Paths the API keeps for itself: /s.js and /e are not served under them. */
export const isReservedPath = (p: string) =>
  p.startsWith("/v1/") || p.startsWith("/mcp") || p.startsWith("/share/") || p.startsWith("/webhooks/");
/** Does this Worker serve the tracker at `pathname`? /s.js, also under any prefix (/_a/s.js) for first-party proxies. */
export const isTrackerPath = (p: string) => !isReservedPath(p) && (p === "/s.js" || p.endsWith("/s.js"));

interface SiteLike {
  id: string;
  domain: string;
  visitor_id_mode: string;
}

export function scriptSnippet(baseUrl: string, siteId: string): string {
  return `<script defer src="${baseUrl}/s.js" data-site="${siteId}"></script>`;
}

/** Queue stub so afsa() calls made before the script loads are kept. */
export const QUEUE_STUB = `<script>window.afsa=window.afsa||function(){(afsa.q=afsa.q||[]).push(arguments)}</script>`;

interface FrameworkCode {
  file?: string;
  language: string;
  code: string;
  notes: string[];
  /** more files the install needs (Next.js: the proxy that makes /_a/* first-party), or alternatives */
  files?: { file: string; language: string; code: string; note: string }[];
}

function frameworkCode(fw: Framework, baseUrl: string, siteId: string, proxyKey: string | null): FrameworkCode {
  const src = `${baseUrl}/s.js`;
  const proxied = `${PROXY_PATH}/s.js`;
  switch (fw) {
    case "html":
      return {
        language: "html",
        code: `${scriptSnippet(baseUrl, siteId)}\n${QUEUE_STUB}`,
        notes: [
          "Paste both tags inside <head> on every page (the second line is optional: it queues afsa() calls made before the script loads).",
        ],
      };
    case "nextjs":
      // A plain <script> in the root layout's <head> is in the server-rendered HTML, so verify finds
      // it on the homepage. next/script (afterInteractive) is injected after hydration, so it isn't.
      return {
        file: "app/layout.tsx",
        language: "tsx",
        code: `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* first-party: proxy.ts forwards ${PROXY_PATH}/* to the collector (ad blockers block analytics.* hosts) */}
        <script defer src="${proxied}" data-site="${siteId}" />
      </head>
      <body>{children}</body>
    </html>
  );
}`,
        files: [
          {
            file: "proxy.ts",
            language: "ts",
            code: nextProxyCode(baseUrl, proxyKey),
            note: "Next.js 16+; on Next.js 13-15 name it middleware.ts and the function middleware. It makes the src above first-party. If the project already has one, merge: run this for paths under /_a/.",
          },
          {
            file: "pages/_document.tsx",
            language: "tsx",
            code: `import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <script defer src="${proxied}" data-site="${siteId}" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}`,
            note: "Pages Router instead of app/layout.tsx: the same <script> inside <Head> of pages/_document.tsx (not pages/_app.tsx).",
          },
        ],
        notes: [
          "Use a plain <script defer>, not next/script: next/script with afterInteractive is added after hydration, so it isn't in the server HTML, and verify can't find it on the homepage (the domain then never verifies).",
          `src="${proxied}" is first-party through proxy.ts (files). With a first-party domain (first_party.first_party_domain) use src="https://<hostname>/_a/s.js" instead and skip proxy.ts; the direct src (${src}) is the last resort, ad blockers block it.`,
          "Client-side route changes are tracked automatically (history API), no router hook needed.",
          "Custom events from client components: (window as any).afsa?.('event', 'signup', { plan: 'pro' }).",
        ],
      };
    case "astro":
      return {
        file: "src/layouts/Layout.astro",
        language: "astro",
        code: `<head>
  <!-- is:inline stops Astro from bundling the script -->
  <script is:inline defer src="${src}" data-site="${siteId}"></script>
</head>`,
        notes: ["View Transitions navigations are tracked automatically (history API)."],
      };
    case "react":
      return {
        file: "index.html",
        language: "html",
        code: `<!-- in <head> of index.html (Vite / CRA single-page apps) -->
<script defer src="${src}" data-site="${siteId}"></script>
${QUEUE_STUB}`,
        notes: [
          "React Router / TanStack Router navigations are tracked automatically (history API).",
          "Custom events: window.afsa('event', 'signup', { plan: 'pro' }); add `declare global { interface Window { afsa: (...a: unknown[]) => void } }` for TypeScript.",
        ],
      };
    case "wordpress":
      return {
        file: "wp-content/themes/<your-child-theme>/functions.php",
        language: "php",
        code: `add_action('wp_head', function () {
    echo '<script defer src="${src}" data-site="${siteId}"></script>';
});`,
        notes: ["Or paste the HTML snippet into a header-injection plugin (e.g. WPCode > Header & Footer > Header)."],
      };
    case "gtm":
      return {
        language: "html",
        code: scriptSnippet(baseUrl, siteId),
        notes: [
          "Google Tag Manager > Tags > New > Custom HTML. Paste the snippet. Trigger: Initialization - All Pages. Submit + Publish.",
          "The snippet will not be in your static HTML; verify_install then relies on events arriving.",
          "Ad blockers that block GTM will also block this; the first-party proxy below avoids that only when installed directly.",
        ],
      };
    case "tags":
      return {
        language: "json",
        code: JSON.stringify(
          {
            client_tag: { id: "analytics", type: "analytics", params: { site_id: siteId, base_url: baseUrl }, triggers: ["all_pages"] },
            server_destination: { type: "analytics", base_url: baseUrl, site_id: siteId, api_key: "<an analytics API key with scope *>" },
          },
          null,
          2,
        ),
        notes: [
          "In the tags app: add the client tag to your container to load the tracker, and/or the server destination so conversions are forwarded to POST /v1/sites/:id/events.",
          "Server-forwarded events pass ip + user_agent (or visitor_id from afsa.visitorId()), so they join the browser visitor and session.",
        ],
      };
  }
}

const keyOrPlaceholder = (proxyKey: string | null) => proxyKey ?? "<unavailable: SALT_SECRET is not set on this deployment>";

/** Next.js proxy.ts (middleware.ts before Next.js 16): /_a/* to the collector with the site's proxy key and Vercel's geo. */
function nextProxyCode(baseUrl: string, proxyKey: string | null): string {
  const key = keyOrPlaceholder(proxyKey);
  return `import { NextResponse, type NextRequest } from "next/server";

// Vercel's geo headers -> the collector's (other hosts: leave out or map your host's own)
const GEO: Record<string, string> = { country: "x-vercel-ip-country", "region-code": "x-vercel-ip-country-region",
  city: "x-vercel-ip-city", timezone: "x-vercel-ip-timezone", lat: "x-vercel-ip-latitude", lon: "x-vercel-ip-longitude" };

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k); // never pass on visitor-sent values
  headers.set("${PROXY_KEY_HEADER}", "${key}"); // this site's secret: keep it server-side
  headers.set("x-forwarded-for", (request.headers.get("x-forwarded-for") || "").split(",")[0].trim());
  for (const [k, h] of Object.entries(GEO)) {
    const v = request.headers.get(h);
    if (v) headers.set("x-afs-geo-" + k, v);
  }
  headers.delete("cookie");
  const dest = new URL(request.nextUrl.pathname + request.nextUrl.search, "${baseUrl}");
  return NextResponse.rewrite(dest, { request: { headers } });
}

export const config = { matcher: "${PROXY_PATH}/:path*" };`;
}

export function proxyInstructions(baseUrl: string, siteId: string, proxyKey: string | null) {
  const host = new URL(baseUrl).host;
  const proxied = `<script defer src="${PROXY_PATH}/s.js" data-site="${siteId}"></script>`;
  const key = keyOrPlaceholder(proxyKey);
  return {
    why: "Serving the script and collection endpoint from your own domain makes them first-party: no third-party request for ad blockers to block, and no extra DNS/TLS handshake. The tracker posts to the origin and path prefix it was loaded from, so only the snippet's src changes.",
    path_prefix: PROXY_PATH,
    snippet: proxied,
    proxy_key: proxyKey,
    proxy_key_header: PROXY_KEY_HEADER,
    visitor_ip_and_geo: `The collector trusts the visitor IP (first X-Forwarded-For hop) and geo (x-afs-geo-* headers, or Vercel's x-vercel-ip-*) only from a request carrying ${PROXY_KEY_HEADER}: ${key}. Every example sends it; keep it server-side (it is this site's secret, not for browser code). Without it the IP and geo are the proxy's own, so every visitor looks like one and verify reports proxy_key. Geo: the Cloudflare Worker and the Netlify Edge Function send exact country/region/city; Next.js on Vercel maps Vercel's geo headers; nginx behind Cloudflare sends the country; otherwise geo is Cloudflare's view of the proxy. Prefer the Cloudflare Worker route. (A first-party domain, first_party.first_party_domain, needs none of this: the platform's edge sends the visitor's IP and geo itself.)`,
    cloudflare_worker: {
      route: `<your-domain>${PROXY_PATH}/*`,
      file: "src/index.js",
      code: `// Worker on your zone, route: example.com${PROXY_PATH}/*
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k); // never pass on visitor-sent values
    headers.set("${PROXY_KEY_HEADER}", "${key}"); // this site's secret: the collector trusts the IP and geo below only with it
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "");
    const cf = request.cf || {};
    const geo = { country: cf.country, region: cf.region, "region-code": cf.regionCode, city: cf.city,
      continent: cf.continent, timezone: cf.timezone, lat: cf.latitude, lon: cf.longitude };
    for (const [k, v] of Object.entries(geo)) if (v != null) headers.set("x-afs-geo-" + k, encodeURIComponent(String(v)));
    headers.delete("cookie");
    return fetch("${baseUrl}" + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
    });
  },
};`,
    },
    nextjs: {
      file: "proxy.ts (Next.js 16+; on Next.js 13-15 name it middleware.ts and the function middleware)",
      code: nextProxyCode(baseUrl, proxyKey),
    },
    vercel: {
      file: "vercel.json (any framework; a route with a request-header transform)",
      code: JSON.stringify(
        {
          routes: [
            {
              src: `${PROXY_PATH}/(.*)`,
              dest: `${baseUrl}${PROXY_PATH}/$1`,
              transforms: [{ type: "request.headers", op: "set", target: { key: PROXY_KEY_HEADER }, args: key }],
            },
          ],
        },
        null,
        2,
      ),
    },
    netlify: {
      file: "netlify/edge-functions/afs-analytics.ts (a Netlify Edge Function: it sends the visitor's IP and geo, which a netlify.toml proxy redirect doesn't)",
      code: `// Netlify Edge Function on ${PROXY_PATH}/*: forwards to the collector with the visitor's IP and geo
import type { Config, Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k); // never pass on visitor-sent values
  headers.delete("cookie");
  headers.set("${PROXY_KEY_HEADER}", "${key}"); // this site's secret: the collector trusts the IP and geo below only with it
  headers.set("x-forwarded-for", context.ip);
  const g = context.geo;
  const geo = { country: g?.country?.code, "region-code": g?.subdivision?.code, region: g?.subdivision?.name, city: g?.city,
    timezone: g?.timezone, lat: g?.latitude, lon: g?.longitude };
  for (const [k, v] of Object.entries(geo)) if (v != null && v !== "") headers.set("x-afs-geo-" + k, encodeURIComponent(String(v)));
  return fetch("${baseUrl}" + url.pathname + url.search, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
  });
};

export const config: Config = { path: "${PROXY_PATH}/*" };`,
    },
    nginx: {
      file: "nginx server block",
      code: `location ${PROXY_PATH}/ {
    proxy_pass ${baseUrl}${PROXY_PATH}/;
    proxy_set_header Host ${host};
    proxy_ssl_server_name on;
    # this site's secret: the collector trusts the IP and geo below only with it
    proxy_set_header X-Afs-Proxy-Key "${key}";
    # visitor IP (behind Cloudflare use $http_cf_connecting_ip instead of $remote_addr)
    proxy_set_header X-Forwarded-For $remote_addr;
    # behind Cloudflare, pass its country on (empty headers are not sent)
    proxy_set_header X-Afs-Geo-Country $http_cf_ipcountry;
    # don't pass on geo headers a visitor sent
    proxy_set_header X-Afs-Geo-Region "";
    proxy_set_header X-Afs-Geo-Region-Code "";
    proxy_set_header X-Afs-Geo-City "";
    proxy_set_header X-Afs-Geo-Continent "";
    proxy_set_header X-Afs-Geo-Timezone "";
    proxy_set_header X-Afs-Geo-Lat "";
    proxy_set_header X-Afs-Geo-Lon "";
    proxy_set_header Cookie "";
}`,
    },
  };
}

/** Where first-party domains are created: the platform site (AUTH_ISSUER), or null when this service runs alone. */
export const platformBase = (env: { AUTH_ISSUER?: string }) => env.AUTH_ISSUER?.trim().replace(/\/+$/, "") || null;

/**
 * The three ways to install, best first: a first-party domain (one CNAME, no server code; created
 * on the platform site), the path proxy (first_party_proxy), and the direct snippet, which ad
 * blockers block. Every install answer leads with it.
 */
export function firstPartyBlock(baseUrl: string, siteId: string, siteBase: string | null) {
  const endpoint = siteBase ? `${siteBase}/v1/first-party-domains` : null;
  return {
    default: true,
    why: "Ad blockers block requests to analytics.* hosts (their filter lists target them), so the direct snippet loses a share of visitors, most on technical audiences. Serve the tracker and its collection endpoint from the site's own domain: use the first of these that works for the site.",
    order: ["first_party_domain", "path_proxy", "direct"],
    first_party_domain: {
      rank: 1,
      what: "A subdomain of the site (e.g. edge.example.com) with one CNAME to this platform, no server code. It serves analytics (/_a), tags (/_t) and replay (/_r) for the whole project at once, with the visitor's IP and geo.",
      when: "You can add a DNS record. If you can't, it's one record to hand the owner; use the path proxy (or the direct snippet) until it's active.",
      create: endpoint
        ? `POST ${endpoint} {"hostname":"edge.<the site's domain>"} (MCP afs_add_first_party_domain): returns the CNAME to add, the filled-in snippets and next_steps`
        : "Not on this deployment (this analytics service runs without the platform site): use the path proxy.",
      status: endpoint ? `GET ${endpoint} until status is "active", then swap the snippet` : null,
      snippet: `<script defer src="https://<hostname>/_a/s.js" data-site="${siteId}"></script>`,
      label:
        "Pick a neutral label (edge, go, www2), not analytics, stats, track, metrics, pixel, tag or collect: filter lists target those names too.",
    },
    path_proxy: {
      rank: 2,
      what: `Forward ${PROXY_PATH}/* on the site's own server, edge or framework to this service with the site's proxy key. Ready code for a Cloudflare Worker, Next.js, Vercel, a Netlify Edge Function and nginx: first_party_proxy.`,
      when: "DNS can't be changed, but the site's server or host can forward a path.",
      snippet: `<script defer src="${PROXY_PATH}/s.js" data-site="${siteId}"></script>`,
      configs: "first_party_proxy",
    },
    direct: {
      rank: 3,
      what: "The plain snippet, straight to this service's host. Last resort: ad blockers block it, and the setup check flags it (analytics.first_party).",
      snippet: scriptSnippet(baseUrl, siteId),
    },
  };
}

const FIRST_PARTY_NOTE =
  "First-party by default: swap this src for the one in first_party (https://<first-party domain>/_a/s.js, or /_a/s.js through the path proxy); the direct src here is the last resort, ad blockers block it.";

/**
 * `proxyKey`: the site's x-afs-proxy-key (proxyKeyFor), null when the deployment has no SALT_SECRET.
 * `siteBase`: the platform site, where first-party domains are created (platformBase).
 */
export function installInstructions(
  site: SiteLike,
  baseUrl: string,
  framework: Framework = "html",
  proxyKey: string | null = null,
  siteBase: string | null = null,
) {
  const fw = frameworkCode(framework, baseUrl, site.id, proxyKey);
  if (framework !== "nextjs" && framework !== "tags") fw.notes = [...fw.notes, FIRST_PARTY_NOTE];
  return {
    first_party: firstPartyBlock(baseUrl, site.id, siteBase),
    site_id: site.id,
    framework,
    frameworks: FRAMEWORKS,
    script_url: `${baseUrl}/s.js`,
    collect_endpoint: `${baseUrl}/e`,
    snippet: scriptSnippet(baseUrl, site.id),
    install: fw,
    tracker: {
      pageviews: "automatic, including SPA navigations (pushState/replaceState/popstate)",
      custom_event: "afsa('event', 'signup', { plan: 'pro' })",
      revenue:
        "afsa('revenue', 'purchase', 49.00, 'USD', { order_id: 'A-1' })  // counted only with the site setting browser_revenue: true (anyone can send browser events); prefer server events, payments or Stripe",
      identify:
        "afsa('identify', 'user_123')  // attaches user_id to this page's following events; it links payments only with trust_browser_user_id: true (a user_id on a server event always does)",
      visitor_id: "afsa.visitorId()  // id to send as visitor_id on server events, after the first pageview",
      auto_events: 'outbound_click and file_download events are sent automatically; disable with data-auto="false"',
      engagement:
        "visible time, max scroll depth and Core Web Vitals (LCP, INP, CLS of the loaded page) are sent on pagehide (navigator.sendBeacon); they feed time_on_page, scroll_depth, lcp_p75, inp_p75, cls_p75 and scroll goals",
      not_found_pages:
        'opt-in: data-404="true" on the script tag sends a "404" event (props.from = the linking page) on pages served with HTTP 404 or carrying <meta name="afsa-404">; in a client-rendered 404 call afsa(\'404\'). Broken links: GET /v1/sites/:id/breakdown?breakdown=page&filters=event_name==404',
      form_submits:
        'opt-in: data-forms="true" sends "form_start" (first input) and "form_submit" with props.form = the form\'s id, name or action path (never field values)',
      click_events:
        '<button data-afsa-event="signup" data-afsa-prop-plan="pro">: a click sends event "signup" {plan: "pro"} (data-afsa-prop-* keys go kebab-case to snake_case)',
      element_views:
        '<section data-afsa-view="pricing_table" data-afsa-view-threshold="0.5">: "element_view" {name} once per pageview when that share of it is visible',
      props:
        "data-props='{\"variant\":\"b\"}' on the script tag, or afsa('props', {variant: 'b'}): props on every following event; afsa('pageview', {url: '/users/:id', props: {...}}) for a manual pageview with its own URL",
      other_options:
        'data-hash="true" (hash-routed SPAs), data-title="true" (page titles), data-before-send="fn" (window.fn(name, payload) returns the payload or null to drop it), data-downloads="pdf,zip" (download extensions), data-link-paths="/go/*" (same-host redirect links count as outbound), afsa(\'event\', name, props, {interactive: false}) (does not un-bounce), afsa(\'debug\') or data-debug="true" (test traffic, kept out of reports)',
      checkout_link:
        "revenue attribution: pass afsa.visitorId() to your server and put it in the Stripe Checkout Session's metadata.afs_visitor_id (subscriptions: also subscription_data.metadata.afs_visitor_id) or client_reference_id; Payment Links: append ?client_reference_id=<afsa.visitorId()>",
      visitor_id_mode:
        site.visitor_id_mode === "persistent"
          ? "persistent: a random id is kept in localStorage, so returning visitors are linked across days"
          : "cookieless: no cookies or storage; visitors are a daily-salted hash of IP + user agent",
    },
    first_party_proxy: proxyInstructions(baseUrl, site.id, proxyKey),
    revenue: {
      why: "Attribute payments to the visitor's source, page and country: revenue, revenue_per_visitor and purchase_rate per breakdown row, new vs renewal, refunds netted.",
      stripe: {
        webhook_url: `${baseUrl}/webhooks/stripe/${site.id}`,
        events: [...STRIPE_EVENTS],
        connect: `POST ${baseUrl}/v1/sites/${site.id}/integrations/stripe {"webhook_secret":"whsec_..."} (MCP: connect_stripe) after adding webhook_url as a Stripe webhook endpoint`,
        status: `GET ${baseUrl}/v1/sites/${site.id}/integrations/stripe`,
      },
      link_to_visitor: {
        browser: "const vid = afsa.visitorId();  // after the first pageview; send it to your server with the checkout request",
        stripe_checkout_session: {
          metadata: { afs_visitor_id: "<vid>" },
          subscription_data: { metadata: { afs_visitor_id: "<vid>" } },
          "or client_reference_id": "<vid>",
        },
        stripe_payment_link: "https://buy.stripe.com/...?client_reference_id=<vid>",
      },
      other_providers: `POST ${baseUrl}/v1/sites/${site.id}/payments {"id":"txn_1","provider":"paddle","amount":49,"currency":"USD","visitor_id":"<vid>"} (MCP: record_payments)`,
    },
    server_side: {
      endpoint: `POST ${baseUrl}/v1/sites/${site.id}/events`,
      curl: `curl -X POST ${baseUrl}/v1/sites/${site.id}/events -H "Authorization: Bearer $KEY" -H "content-type: application/json" \\
  -d '{"events":[{"name":"purchase","url":"https://${site.domain}/checkout","ip":"203.0.113.7","user_agent":"Mozilla/5.0 ...","revenue":{"amount":49,"currency":"USD"}}]}'`,
    },
    verify: {
      rest: `POST ${baseUrl}/v1/sites/${site.id}/verify`,
      mcp: "verify_install",
      tip: "Open the site in a normal browser once after installing (headless browsers and bots are filtered), then verify.",
    },
  };
}
