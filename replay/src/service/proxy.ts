import { edgeHost, hmacSha256Hex, timingSafeEqual } from "@afs/shared";

/**
 * A customer's own path proxy (/_r/* on the site's server, forwarded unchanged; the configs are in
 * the install answer's first_party_proxy) adds this header with the site's proxy key. Only a request
 * carrying the right key may tell replay the visitor's IP (first X-Forwarded-For hop) and geo
 * (x-afs-geo-*, or Vercel's x-vercel-ip-*); anything else gets cf-connecting-ip and request.cf.
 * The platform's edge (a first-party domain, @afs/shared edgeHost) is trusted on its own and needs
 * no key.
 */
export const PROXY_KEY_HEADER = "x-afs-proxy-key";
export const PROXY_PATH = "/_r";

const keys = new Map<string, { secret: string; key: string }>();

/**
 * The site's proxy key: hex HMAC-SHA256(ENCRYPTION_KEY, "afs-replay-proxy:" + site id). Stable,
 * derived on demand, never stored; rotating ENCRYPTION_KEY changes it. Null without ENCRYPTION_KEY.
 */
export async function proxyKey(env: { ENCRYPTION_KEY?: string }, siteId: string): Promise<string | null> {
  const secret = env.ENCRYPTION_KEY;
  if (!secret) return null;
  const hit = keys.get(siteId);
  if (hit && hit.secret === secret) return hit.key;
  const key = await hmacSha256Hex(secret, `afs-replay-proxy:${siteId}`);
  if (keys.size > 2_000) keys.clear();
  keys.set(siteId, { secret, key });
  return key;
}

/**
 * Who forwarded a public request, and so whether its X-Forwarded-For and geo headers are the
 * visitor's:
 *   - "edge": the platform's edge for a first-party domain (trusted);
 *   - "proxy": a customer's path proxy with this site's key (trusted);
 *   - "invalid": an x-afs-proxy-key that isn't this site's (not trusted);
 *   - "missing": a path under a prefix (/_r/i, not /i), so a customer's proxy, without a key (not
 *     trusted: its address and request.cf are the proxy's);
 *   - null: a direct request to this service.
 */
export type ProxyTrust = "edge" | "proxy" | "invalid" | "missing" | null;

/** The routes a direct request uses; anything else in front of them is a proxy's path prefix. */
const DIRECT = /^\/(?:i|f|r\/[^/]+\.js|rec\/[^/]+\.js|recorder\.[^/]+\.js|sv\/[^/]+\.js)$/;

export async function proxyTrust(
  env: { ENCRYPTION_KEY?: string; INTERNAL_TOKEN?: string },
  req: Request,
  siteId: string | null,
): Promise<ProxyTrust> {
  if (edgeHost(env, req)) return "edge";
  const got = req.headers.get(PROXY_KEY_HEADER)?.trim();
  if (got) {
    const want = siteId ? await proxyKey(env, siteId) : null;
    return want && timingSafeEqual(got, want) ? "proxy" : "invalid";
  }
  return DIRECT.test(new URL(req.url).pathname) ? null : "missing";
}

/** The forwarded IP and geo are the visitor's. */
export const isTrusted = (t: ProxyTrust | undefined) => t === "edge" || t === "proxy";
