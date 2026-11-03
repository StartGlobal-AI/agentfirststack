import { PROXY_KEY_HEADER } from "../lib/geo";
import { STRIPE_EVENTS } from "../lib/stripe";

/**
 * Install + first-party proxy instructions. Pure: (site, base URL, framework, proxy key) -> JSON an
 * agent can apply directly (file paths and exact code).
 */

export const FRAMEWORKS = ["html", "nextjs", "astro", "react", "wordpress", "gtm", "tags"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const PROXY_PATH = "/_a";

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

function frameworkCode(fw: Framework, baseUrl: string, siteId: string): { file?: string; language: string; code: string; notes: string[] } {
  const src = `${baseUrl}/s.js`;
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
      return {
        file: "app/layout.tsx",
        language: "tsx",
        code: `import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script src="${src}" data-site="${siteId}" strategy="afterInteractive" />
      </head>
      <body>{children}</body>
    </html>
  );
}`,
        notes: [
          "Pages Router: put the same <Script> in pages/_app.tsx.",
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

export function proxyInstructions(baseUrl: string, siteId: string, proxyKey: string | null) {
  const host = new URL(baseUrl).host;
  const proxied = `<script defer src="${PROXY_PATH}/s.js" data-site="${siteId}"></script>`;
  const key = proxyKey ?? "<unavailable: SALT_SECRET is not set on this deployment>";
  return {
    why: "Serving the script and collection endpoint from your own domain makes them first-party: no third-party request for ad blockers to block, and no extra DNS/TLS handshake. The tracker posts to the origin and path prefix it was loaded from, so only the snippet's src changes.",
    path_prefix: PROXY_PATH,
    snippet: proxied,
    proxy_key: proxyKey,
    proxy_key_header: PROXY_KEY_HEADER,
    visitor_ip_and_geo: `The collector trusts the visitor IP (first X-Forwarded-For hop) and geo (x-afs-geo-* headers, or Vercel's x-vercel-ip-*) only from a request carrying ${PROXY_KEY_HEADER}: ${key}. Every example sends it; keep it server-side (it is this site's secret, not for browser code). Without it the IP and geo are the proxy's own, so every visitor looks like one and verify reports proxy_key. Geo: the Cloudflare Worker sends exact country/region/city; Next.js on Vercel maps Vercel's geo headers; nginx behind Cloudflare sends the country; otherwise geo is Cloudflare's view of the proxy. Prefer the Cloudflare Worker route.`,
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
      code: `import { NextResponse, type NextRequest } from "next/server";

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

export const config = { matcher: "${PROXY_PATH}/:path*" };`,
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
      file: "netlify.toml (the _redirects file can't add request headers)",
      code: `[[redirects]]
  from = "${PROXY_PATH}/*"
  to = "${baseUrl}${PROXY_PATH}/:splat"
  status = 200
  force = true
  headers = { X-Afs-Proxy-Key = "${key}" }`,
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

/** `proxyKey`: the site's x-afs-proxy-key (proxyKeyFor), null when the deployment has no SALT_SECRET. */
export function installInstructions(site: SiteLike, baseUrl: string, framework: Framework = "html", proxyKey: string | null = null) {
  const fw = frameworkCode(framework, baseUrl, site.id);
  return {
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
        'opt-in: data-forms="true" sends "form_submit" with props.form = the form\'s id, name or action path (never field values) on every submit',
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
