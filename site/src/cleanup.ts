import { pruneSignupLog } from "@afs/shared";
import { DAY } from "./env";

/**
 * Daily cron: delete what has expired in the identity DB. Expired rows already fail every check
 * (authenticate() rejects expired keys, sessions and codes are looked up with their expiry), so
 * this only keeps the tables small. signup_log (the shared signup counters) is pruned here too, so
 * the signup path never scans it.
 */
export async function purgeExpired(db: D1Database, now = Date.now()) {
  const stale = now - 31 * DAY;
  const results = await db.batch([
    db.prepare("DELETE FROM api_keys WHERE expires_at IS NOT NULL AND expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM claim_links WHERE expires_at < ?").bind(now),
    // Grants that can no longer be used (no refresh token or code left) and are a month old.
    db
      .prepare(
        `DELETE FROM oauth_grants WHERE COALESCE(last_used_at, created_at) < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.grant_id = oauth_grants.id)
           AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.grant_id = oauth_grants.id)`,
      )
      .bind(stale),
    // Registered clients nobody ever authorized.
    db
      .prepare(
        "DELETE FROM oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)",
      )
      .bind(stale),
  ]);
  const n = (i: number) => results[i]?.meta.changes ?? 0;
  const signupLog = await pruneSignupLog(db, now);
  return {
    keys: n(0),
    codes: n(1),
    refresh_tokens: n(2),
    sessions: n(3),
    claim_links: n(4),
    grants: n(5),
    clients: n(6),
    signup_log: signupLog,
  };
}
