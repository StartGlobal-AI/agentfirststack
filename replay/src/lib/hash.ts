import { sha256Hex } from "@afs/shared";

/**
 * hash_user_ids: afsr('identify', id) ids are hashed in the visitor's browser before they leave it,
 * as "h:" + the first 32 hex characters of SHA-256("afsr:<site_id>:<id>"). The site id salts the
 * hash, so the same user id gives different values on different sites. The server hashes a raw id
 * the same way for the user_id filter, get_visitor and delete_visitor_data.
 */
export const HASH_PREFIX = "h:";
export const hashInput = (siteId: string, userId: string) => `afsr:${siteId}:${userId}`;

export async function hashUserId(siteId: string, userId: string): Promise<string> {
  if (userId.startsWith(HASH_PREFIX)) return userId;
  return HASH_PREFIX + (await sha256Hex(hashInput(siteId, userId))).slice(0, 32);
}

/** The stored forms a raw user id can have on a site: as sent, and hashed when the site hashes ids. */
export async function userIdForms(siteId: string, userId: string, hashed: boolean): Promise<string[]> {
  if (!hashed || userId.startsWith(HASH_PREFIX)) return [userId];
  return [userId, await hashUserId(siteId, userId)];
}
