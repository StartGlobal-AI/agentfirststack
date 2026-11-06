import type { AppEnv } from "../env";
import { reservedKeys } from "../lib/address";
import { sharedDomain } from "./inboxes";

/**
 * Inboxes whose username became reserved after they were created (src/lib/address.ts: a new
 * built-in role name, or a name the operator added to EXTRA_RESERVED_USERNAMES). Creating such an
 * address is refused, but inboxes that already have it keep working: nothing here deletes or
 * changes anything. The operator decides (contact the owner, suspend the account).
 *
 *   - The hourly cron runs the scan only when the reserved list changed (its fingerprint is kept
 *     in cron_state), and logs what it finds as `mail.reserved_conflicts`.
 *   - GET /v1/admin/reserved-inboxes (x-admin-token) runs it on demand.
 */

const STATE_KEY = "reserved_names";
export const RESERVED_SCAN_MAX = 1000;

export interface ReservedInbox {
  inbox_id: string;
  account_id: string;
  address: string;
  created_at: number;
  last_message_at: number | null;
}

/** A short fingerprint of the reserved list and the shared domain, to notice when either changes. */
async function fingerprint(env: AppEnv, keys: string[]): Promise<string> {
  const data = new TextEncoder().encode(`${sharedDomain(env)}\n${keys.join(",")}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Shared-domain inboxes whose username is reserved now, oldest first. One statement that reads every
 * inbox row, which is why the cron runs it only when the list changed.
 */
export async function findReservedInboxes(env: AppEnv, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), RESERVED_SCAN_MAX);
  const keys = reservedKeys(env.EXTRA_RESERVED_USERNAMES);
  // The SQL twin of reservedKey(): ".", "_" and "-" do not count (usernames are stored lowercase).
  const { results } = await env.DB.prepare(
    `SELECT id, account_id, address, created_at, last_message_at FROM inboxes
     WHERE domain = ?1 AND replace(replace(replace(username, '.', ''), '_', ''), '-', '') IN (SELECT value FROM json_each(?2))
     ORDER BY created_at, id LIMIT ?3`,
  )
    .bind(sharedDomain(env), JSON.stringify(keys), limit + 1)
    .all<{ id: string; account_id: string; address: string; created_at: number; last_message_at: number | null }>();
  const inboxes: ReservedInbox[] = results.slice(0, limit).map((r) => ({
    inbox_id: r.id,
    account_id: r.account_id,
    address: r.address,
    created_at: r.created_at,
    last_message_at: r.last_message_at,
  }));
  return { inboxes, truncated: results.length > limit, reserved_names: keys.length, shared_domain: sharedDomain(env) };
}

/** Cron: when the reserved list changed since the last run, list the inboxes that now hold a reserved name (log only). */
export async function checkReservedNames(env: AppEnv, now = Date.now()) {
  const keys = reservedKeys(env.EXTRA_RESERVED_USERNAMES);
  const fp = await fingerprint(env, keys);
  const state = await env.DB.prepare("SELECT value FROM cron_state WHERE name = ?").bind(STATE_KEY).first<{ value: string | null }>();
  if (state?.value === fp) return { reserved_check: "unchanged" as const };
  const r = await findReservedInboxes(env, { limit: 100 });
  if (r.inboxes.length) {
    console.warn(
      JSON.stringify({
        event: "mail.reserved_conflicts",
        count: r.inboxes.length,
        truncated: r.truncated,
        inboxes: r.inboxes.map((i) => ({ inbox_id: i.inbox_id, account_id: i.account_id, address: i.address })),
        next_step: "GET /v1/admin/reserved-inboxes (x-admin-token) lists them all. Nothing was changed.",
      }),
    );
  }
  await env.DB.prepare(
    "INSERT INTO cron_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(STATE_KEY, fp, now)
    .run();
  return { reserved_check: "scanned" as const, reserved_conflicts: r.inboxes.length, reserved_conflicts_truncated: r.truncated };
}
