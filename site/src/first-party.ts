import { Hono } from "hono";
import type { SiteEnv } from "./env";

/**
 * Our own pages' first-party paths, the way we tell every site to serve AgentFirstStack: the
 * analytics tracker at /_a/* and the tags runtime at /_t/* on agentfirststack.com itself, so ad
 * blockers (which block analytics.* hosts) don't drop our visitors. Each request goes to its
 * service over the service binding with that site's proxy key and the visitor's IP and geo, the
 * same headers as the Cloudflare Worker in GET /v1/sites/:id/install (first_party_proxy). Without
 * the key (OWN_ANALYTICS_PROXY_KEY, OWN_TAGS_PROXY_KEY) the paths answer 404 and the pages fall back
 * to nothing: they only use these paths once the keys are set.
 */

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
    const req = c.req.raw;
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    // Never pass on values a visitor could send to look like a trusted proxy.
    for (const k of [...headers.keys()]) if (k.startsWith("x-afs-")) headers.delete(k);
    headers.delete("cookie");
    headers.set("x-afs-proxy-key", key);
    headers.set("x-forwarded-for", req.headers.get("cf-connecting-ip") ?? "");
    const cf = (req as Request & { cf?: Record<string, unknown> }).cf ?? {};
    const geo: Record<string, unknown> = {
      country: cf.country,
      region: cf.region,
      "region-code": cf.regionCode,
      city: cf.city,
      continent: cf.continent,
      timezone: cf.timezone,
      lat: cf.latitude,
      lon: cf.longitude,
    };
    for (const [k, v] of Object.entries(geo)) if (v != null && v !== "") headers.set(`x-afs-geo-${k}`, encodeURIComponent(String(v)));
    return binding.fetch(`https://${r.service}.internal${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
  });
}
