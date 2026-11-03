import { hmacSha256Hex, timingSafeEqual } from "@afs/shared";

/**
 * First-party proxies (the snippets from GET /v1/containers/:id/install) run on the customer's
 * own server and add this header. Only requests carrying the container's key may tell /collect
 * the visitor's IP through X-Forwarded-For; anything else uses cf-connecting-ip.
 */
export const PROXY_KEY_HEADER = "x-afs-proxy-key";

/** HMAC-SHA256(ENCRYPTION_KEY, "afs-tags-proxy:" + container id), hex. Null without ENCRYPTION_KEY. */
export async function proxyKey(env: { ENCRYPTION_KEY?: string }, containerId: string): Promise<string | null> {
  if (!env.ENCRYPTION_KEY) return null;
  return hmacSha256Hex(env.ENCRYPTION_KEY, `afs-tags-proxy:${containerId}`);
}

/** True when the request carries this container's proxy key. */
export async function fromTrustedProxy(env: { ENCRYPTION_KEY?: string }, req: Request, containerId: string): Promise<boolean> {
  const got = req.headers.get(PROXY_KEY_HEADER)?.trim();
  if (!got) return false;
  const want = await proxyKey(env, containerId);
  return !!want && timingSafeEqual(got, want);
}
