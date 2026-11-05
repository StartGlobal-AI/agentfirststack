import { ApiError, INTERNAL_KEY_ID } from "@afs/shared";
import type { Bindings } from "../env";
import type { Fetcher } from "../lib/stripe-api";
import { type Ctx, siteStub } from "./context";
import { deleteSite } from "./sites";

/** Wall time one purge call may spend before it stops with done: false (the caller calls again). */
export const DEFAULT_PURGE_BUDGET_MS = 20_000;

export interface PurgeResult {
  account_id: string;
  /** false: sites are left (out of time, or one failed); call again. */
  done: boolean;
  deleted: { sites: number; stripe_webhook_endpoints: number; api_keys: number };
  /** Sites that failed this time (they are retried on the next call). */
  errors?: { site_id: string; error: string }[];
}

/**
 * Erase everything an account owns in analytics: the platform's purge of a deleted project
 * (DELETE /v1/account, internal auth only), 7 days after its owner deleted it.
 *
 * Every site goes through deleteSite(): its D1 rows (goals, funnels, share links, integrations,
 * alerts, reports, destinations and their history, segments), the Stripe webhook endpoint it
 * created, and its Durable Object (events, payments, subscriptions, annotations, imports, costs).
 * Then the account's own rows: a local api_keys copy when keys live in the identity DB.
 *
 * Kept on purpose: the bare `accounts` mirror row (other tables' foreign keys reference it; the
 * identity DB keeps the id too), and the fair-use counters (usage_daily, crawl_usage_daily,
 * alert_usage, usage_global, crawl_usage_global), which never go down.
 *
 * Resumable and idempotent: at least one site per call, more while `budgetMs` lasts; an account
 * with nothing left returns done: true with zero counts.
 */
export async function purgeAccount(
  env: Bindings,
  accountId: string,
  opts: { budgetMs?: number; fetcher?: Fetcher } = {},
): Promise<PurgeResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_PURGE_BUDGET_MS;
  const ctx: Ctx = {
    env,
    accountId,
    auth: { accountId, keyId: INTERNAL_KEY_ID, scopes: ["*"] },
    baseUrl: env.PUBLIC_BASE_URL ?? "",
  };
  const deleted = { sites: 0, stripe_webhook_endpoints: 0, api_keys: 0 };
  const errors: { site_id: string; error: string }[] = [];

  const { results: sites } = await env.DB.prepare("SELECT id FROM sites WHERE account_id = ? ORDER BY created_at, id")
    .bind(accountId)
    .all<{ id: string }>();
  let left = 0;
  for (const [i, { id }] of sites.entries()) {
    if (i > 0 && Date.now() - started >= budgetMs) {
      left = sites.length - i;
      break;
    }
    try {
      // The stored data first, while the D1 row still names the site: deleteSite() removes the row
      // before it empties the object, so a failure there would leave events nothing can find again.
      // deleteSite() empties it once more, in case an event arrived in between.
      await siteStub(env, id).destroy();
      const r = await deleteSite(ctx, id, { fetcher: opts.fetcher });
      deleted.sites++;
      if (r.stripe_webhook_endpoint_deleted) deleted.stripe_webhook_endpoints++;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue; // a concurrent purge got there first
      console.error("purge: site failed", accountId, id, e);
      errors.push({ site_id: id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Keys live in the identity DB (AUTH_DB); any rows in this app's own api_keys are a stale copy.
  // Without AUTH_DB this DB is the identity DB, and its keys are the platform's to manage.
  if (env.AUTH_DB) {
    const r = await env.DB.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(accountId).run();
    deleted.api_keys = r.meta.changes ?? 0;
  }

  return {
    account_id: accountId,
    done: left === 0 && errors.length === 0,
    deleted,
    ...(errors.length ? { errors } : {}),
  };
}
