import { hmacSha256Hex, sha256Hex } from "@afs/shared";

/**
 * Cookieless visitor identity:
 *   daily_salt = HMAC-SHA256(SALT_SECRET, "YYYY-MM-DD")   (UTC date of the event)
 *   visitor_id = sha256(daily_salt | site_id | ip | user_agent), first 16 hex chars
 * No cookies, nothing stored on the device, no linking across days. The same function serves the
 * browser path (/e) and server ingest (ip + user_agent given), so both land on the same visitor.
 */

const saltCache = new Map<string, string>();

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export async function dailySalt(secret: string, day: string): Promise<string> {
  const key = `${secret.length}:${secret.slice(0, 8)}:${day}`;
  const hit = saltCache.get(key);
  if (hit) return hit;
  const salt = await hmacSha256Hex(secret, day);
  if (saltCache.size > 8) saltCache.clear();
  saltCache.set(key, salt);
  return salt;
}

export async function visitorHash(secret: string, siteId: string, ip: string, ua: string, ts: number): Promise<string> {
  const salt = await dailySalt(secret, utcDay(ts));
  return (await sha256Hex(`${salt}|${siteId}|${ip}|${ua}`)).slice(0, 16);
}

const proxyKeyCache = new Map<string, string>();

/**
 * Per-site first-party proxy secret: hex HMAC-SHA256(SALT_SECRET, site_id). A proxy sends it as
 * x-afs-proxy-key so /e trusts the visitor IP and geo it forwards. Rotating SALT_SECRET changes it.
 */
export async function proxyKey(secret: string, siteId: string): Promise<string> {
  const key = `${secret.length}:${secret.slice(0, 8)}:${siteId}`;
  const hit = proxyKeyCache.get(key);
  if (hit) return hit;
  const k = await hmacSha256Hex(secret, siteId);
  if (proxyKeyCache.size > 1000) proxyKeyCache.clear();
  proxyKeyCache.set(key, k);
  return k;
}

/** Stable id for server events that only carry a user_id (no ip/ua, no visitor_id). */
export async function userVisitorId(siteId: string, userId: string): Promise<string> {
  return `u${(await sha256Hex(`${siteId}|user|${userId}`)).slice(0, 15)}`;
}

/** Client-supplied persistent ids (localStorage in persistent mode) and server visitor_ids. */
export const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
