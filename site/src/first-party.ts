import { EDGE_HOST_HEADER } from "@afs/shared";
import { Hono, type MiddlewareHandler } from "hono";
import type { Bindings, SiteEnv } from "./env";
import { type DomainRow, isPlatformHost, lookupHost, refreshDomain, REFRESH_MS } from "./first-party-domains";

/**
 * Collection served from a site's own domain, two ways:
 *
 *   - The edge (firstPartyEdge): a customer's first-party domain (edge.example.com, a CNAME on
 *     Cloudflare for SaaS, src/first-party-domains.ts) routes to this Worker. /_a/* goes to
 *     analytics, /_t/* to tags and /_r/* to replay, over the service bindings, with the visitor's IP
 *     and geo and proof that it's our edge: x-afs-internal (INTERNAL_TOKEN, only valid over a
 *     binding) and x-afs-edge-host (the hostname). The services trust that like a valid proxy key
 *     (@afs/shared edgeHost()). Anything else on such a host is a small 404.
 *
 *   - Our own pages (firstParty): the analytics tracker at /_a/* and the tags runtime at /_t/* on
 *     agentfirststack.com itself, the path proxy we tell every site about, with our own site's
 *     proxy keys (OWN_ANALYTICS_PROXY_KEY, OWN_TAGS_PROXY_KEY): the same headers as the Cloudflare
 *     Worker in GET /v1/sites/:id/install (first_party_proxy). Without a key the path answers 404.
 *
 * Both strip cookies and every x-afs-* header the visitor sent, so nobody can pose as a proxy.
 */

/** The visitor's request headers for a service: no cookies, no visitor-sent x-afs-*, plus their IP and geo. */
export function visitorHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k);
  headers.delete("cookie");
  headers.set("x-forwarded-for", req.headers.get("cf-connecting-ip") ?? "");
  const cf = (req as Request & { cf?: Record<string, unknown> }).cf ?? {};
  const geo: Record<string, unknown> = {
    country: cf.country,
    region: cf.region,
    "region-code": cf.regionCode,
    city: cf.city,
    "postal-code": cf.postalCode,
    continent: cf.continent,
    timezone: cf.timezone,
    lat: cf.latitude,
    lon: cf.longitude,
    asn: cf.asn,
    "as-org": cf.asOrganization,
  };
  for (const [k, v] of Object.entries(geo)) if (v != null && v !== "") headers.set(`x-afs-geo-${k}`, encodeURIComponent(String(v)));
  return headers;
}

const forward = (binding: Fetcher, service: string, req: Request, headers: Headers) => {
  const url = new URL(req.url);
  return binding.fetch(`https://${service}.internal${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
};

// ---------- the edge for customers' first-party domains ----------

const EDGE_ROUTES = [
  { prefix: "/_a/", service: "analytics", binding: "ANALYTICS" },
  { prefix: "/_t/", service: "tags", binding: "TAGS" },
  { prefix: "/_r/", service: "replay", binding: "REPLAY" },
] as const;

const edgeAnswer = (status: number, text: string, maxAge = 300) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, "x-robots-tag": "noindex" },
  });

/**
 * Runs before every other route. A Host that is a first-party domain is dispatched here and never
 * reaches the platform's pages or API. Cloudflare routes a hostname to this Worker only once its
 * custom hostname is live, so a registered hostname is served whatever status we last read; when
 * that wasn't active yet, the status is re-read from Cloudflare in the background.
 */
export const firstPartyEdge: MiddlewareHandler<SiteEnv> = async (c, next) => {
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (isPlatformHost(c.env, host)) return next();
  const domain = await lookupHost(c.env, host);
  if (!domain) return next();
  if (domain.status !== "active") refreshInBackground(c, host);
  const req = c.req.raw;
  const path = new URL(req.url).pathname;
  if (path === "/robots.txt") return edgeAnswer(200, "User-agent: *\nDisallow: /\n", 86_400);
  const route = EDGE_ROUTES.find((r) => path.startsWith(r.prefix));
  const binding = route ? (c.env[route.binding] as Fetcher | undefined) : undefined;
  if (!route || !binding || !c.env.INTERNAL_TOKEN) return edgeAnswer(404, "Not found.\n");
  const headers = visitorHeaders(req);
  headers.set("x-afs-internal", c.env.INTERNAL_TOKEN);
  headers.set(EDGE_HOST_HEADER, host);
  return forward(binding, route.service, req, headers);
};

const refreshing = new Map<string, number>();
function refreshInBackground(c: { env: Bindings; executionCtx: { waitUntil(p: Promise<unknown>): void } }, hostname: string) {
  const now = Date.now();
  if (now - (refreshing.get(hostname) ?? 0) < REFRESH_MS) return;
  refreshing.set(hostname, now);
  if (refreshing.size > 1_000) refreshing.delete(refreshing.keys().next().value as string);
  const work = c.env.DB.prepare("SELECT * FROM first_party_domains WHERE hostname = ?")
    .bind(hostname)
    .first<DomainRow>()
    .then((row) => (row ? refreshDomain(c.env, row) : null))
    .catch((e) => console.error("first-party status refresh failed", hostname, e));
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    /* no ExecutionContext (some test harnesses): the promise runs on its own */
  }
}

// ---------- our own pages ----------

const ROUTES = [
  { prefix: "/_a/", service: "analytics", binding: "ANALYTICS", key: "OWN_ANALYTICS_PROXY_KEY" },
  { prefix: "/_t/", service: "tags", binding: "TAGS", key: "OWN_TAGS_PROXY_KEY" },
] as const;

export const firstParty = new Hono<SiteEnv>();

for (const r of ROUTES) {
  firstParty.all(`${r.prefix}*`, async (c) => {
    const binding = c.env[r.binding] as Fetcher | undefined;
    const key = c.env[r.key] as string | undefined;
    if (!binding || !key) return c.notFound();
    const headers = visitorHeaders(c.req.raw);
    headers.set("x-afs-proxy-key", key);
    return forward(binding, r.service, c.req.raw, headers);
  });
}
