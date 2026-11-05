import { ApiError, accountStanding } from "@afs/shared";
import type { Bindings } from "../env";
import { containerStub, deleteContainer } from "./containers";

/** Wall time one call may spend by default; containers left past it answer done: false. */
export const PURGE_BUDGET_MS = 20_000;

export interface PurgeResult {
  account_id: string;
  /** false: containers are left (out of time, or one failed); call again. */
  done: boolean;
  deleted: {
    containers: number;
    destinations: number;
    versions: number;
    preview_tokens: number;
    environments: number;
    lookups: number;
    api_keys: number;
  };
}

/**
 * Erase everything a deleted project (account) owns in tags: the platform's purge, 7 days after the
 * project was deleted (DELETE /v1/account, internal auth only). Each container goes through
 * deleteContainer(): its D1 rows (destinations with their sealed credentials, versions, preview
 * tokens, environments, lookups) and its Durable Object's storage (visitors, event log, preview
 * logs, tag stats, pages). Then the account-keyed rows no container holds any more.
 *
 * Kept on purpose: the bare `accounts` mirror row (other tables' foreign keys reference it; the
 * identity DB owns the account), and the fair-use counters (usage_daily, usage_global,
 * delivery_usage), which never go down, so deleting a project frees no budget. They hold counts
 * only and age out by day.
 *
 * Only a deleted project is erased (identity DB accounts.deleted_at set): a live one is refused
 * with 409 not_deleted before anything is touched, as is one whose standing can't be read.
 *
 * Bounded by `budgetMs` of wall time: with containers left when it runs out, it answers done: false
 * and the caller calls again. Safe to repeat: an account with nothing left answers done: true with
 * zero counts. Dispatch messages still queued for a purged container are dropped by the consumer
 * (destination gone: logged as skipped on a Durable Object that no longer stores anything).
 */
export async function purgeAccount(env: Bindings, accountId: string, opts: { budgetMs?: number } = {}): Promise<PurgeResult> {
  const deadline = Date.now() + (opts.budgetMs ?? PURGE_BUDGET_MS);
  if ((await accountStanding(env, accountId)).deleted !== true)
    throw new ApiError(
      409,
      "not_deleted",
      "This project isn't deleted, so its data isn't erased.",
      "Projects are deleted on the platform first (dashboard, or DELETE https://agentfirststack.com/v1/me); the site erases them 7 days later.",
    );
  const deleted = { containers: 0, destinations: 0, versions: 0, preview_tokens: 0, environments: 0, lookups: 0, api_keys: 0 };
  const { results } = await env.DB.prepare("SELECT id FROM containers WHERE account_id = ? ORDER BY created_at")
    .bind(accountId)
    .all<{ id: string }>();
  let done = true;
  for (const { id } of results) {
    if (Date.now() >= deadline) {
      done = false;
      break;
    }
    try {
      // Storage first: if the Durable Object fails, the D1 row is still there for the next call.
      // deleteContainer() destroys it again once the rows are gone (in case a hit re-synced it).
      await containerStub(env, id).destroy();
      const n = await deleteContainer(env, accountId, id);
      deleted.containers++;
      for (const k of Object.keys(n) as (keyof typeof n)[]) deleted[k] += n[k];
    } catch (e) {
      // One failing container must not hold up the others; it is retried on the next call.
      done = false;
      console.error(JSON.stringify({ event: "purge.container_failed", account_id: accountId, container_id: id, error: String(e) }));
    }
  }
  if (!done) return { account_id: accountId, done, deleted };

  // Account-keyed rows left without a container (normally none: deleteContainer removed them).
  const sweep = [
    env.DB.prepare("DELETE FROM destinations WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM environments WHERE account_id = ?").bind(accountId),
  ];
  // With a shared identity DB (AUTH_DB) nothing reads this app's own api_keys table, so rows there
  // are leftovers. Without one, DB is the identity DB: its keys are the platform's, not erased here.
  if (env.AUTH_DB) sweep.push(env.DB.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(accountId));
  const [destinations, environments, keys] = await env.DB.batch(sweep);
  deleted.destinations += destinations?.meta.changes ?? 0;
  deleted.environments += environments?.meta.changes ?? 0;
  deleted.api_keys += keys?.meta.changes ?? 0;
  return { account_id: accountId, done, deleted };
}
