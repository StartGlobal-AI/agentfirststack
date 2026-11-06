import { ApiError } from "@afs/shared";
import { type AppEnv, standingOf } from "../env";
import { deleteDomain } from "./domains";
import { PURGE_BUDGET_MS, deleteInbox, deleteInboxMessages } from "./inboxes";

/**
 * Erasing a deleted project's mail (DELETE /v1/account; the platform's site calls it over a
 * service binding 7 days after the project was deleted, until it answers `done: true`).
 *
 * Erased: every inbox (messages, attachments, threads, R2 blobs, scheduled sends), custom domains,
 * webhooks and their delivery logs, and the account's other rows (allow/block lists, Idempotency-Key
 * replays, delivery status, the event feed, mail waiting to be forwarded, wait slots).
 *
 * Kept: the bare `accounts` mirror row; the fair-use counters (send_counters, inbound_counters,
 * sender_counters, account_daily, account_usage), which must never go down and age out by
 * themselves; and address_tombstones. Like every deleted shared-domain address, the project's are
 * never given to another account (migrations/0015, 0016): they are often the recovery email of
 * accounts elsewhere. `addresses_reserved` counts the ones retired by this call.
 *
 * Works within `budgetMs` of wall time and answers `done: false` when work is left; the caller calls
 * again. Idempotent: on an emptied account it answers `done: true` with zero counts. A live account
 * (its identity row has no deleted_at) is never erased: 409 not_deleted, before anything changes.
 */

const INBOX_PAGE = 50;
const ROW_CHUNK = 1000;

/** Rows keyed by account_id that go with the project (each table has a rowid and an account index, except forward_queue). */
const ACCOUNT_TABLES = ["list_entries", "send_keys", "deliveries", "events", "forward_queue", "active_waits"] as const;

export interface PurgeCounts {
  inboxes: number;
  messages: number;
  blobs: number;
  domains: number;
  webhooks: number;
  webhook_deliveries: number;
  list_entries: number;
  send_keys: number;
  deliveries: number;
  events: number;
  forward_queue: number;
  active_waits: number;
}

export interface PurgeResult {
  account_id: string;
  done: boolean;
  deleted: PurgeCounts;
  addresses_reserved: number;
}

export async function purgeAccount(env: AppEnv, accountId: string, opts: { budgetMs?: number; now?: number } = {}): Promise<PurgeResult> {
  if ((await standingOf(env, accountId)).deleted !== true) {
    throw new ApiError(
      409,
      "not_deleted",
      "This project isn't deleted, so its data isn't erased.",
      "Projects are deleted on the platform first (dashboard, or DELETE https://agentfirststack.com/v1/me); the site erases them 7 days later.",
    );
  }
  const now = opts.now ?? Date.now();
  const deadline = Date.now() + (opts.budgetMs ?? PURGE_BUDGET_MS);
  // The time is checked before each next piece of work, never before the first: every call makes
  // progress, and `done: false` always means something is left.
  let worked = false;
  const stop = () => worked && Date.now() >= deadline;
  const deleted: PurgeCounts = {
    inboxes: 0,
    messages: 0,
    blobs: 0,
    domains: 0,
    webhooks: 0,
    webhook_deliveries: 0,
    list_entries: 0,
    send_keys: 0,
    deliveries: 0,
    events: 0,
    forward_queue: 0,
    active_waits: 0,
  };
  let reserved = 0;
  const result = (done: boolean): PurgeResult => ({ account_id: accountId, done, deleted, addresses_reserved: reserved });

  // Delete in chunks until none are left (true) or time runs out with more to delete (false).
  const chunked = async (sql: string, count: keyof PurgeCounts) => {
    for (;;) {
      const n = (await env.DB.prepare(sql).bind(accountId, ROW_CHUNK).run()).meta.changes ?? 0;
      deleted[count] += n;
      if (n < ROW_CHUNK) return true;
      worked = true;
      if (stop()) return false;
    }
  };

  // 1. Inboxes, on every domain. Messages first, under the budget (an inbox can be large), then
  //    deleteInbox: threads, list entries, R2 blobs and (shared domain) the address's tombstone.
  for (;;) {
    const { results } = await env.DB.prepare("SELECT id FROM inboxes WHERE account_id = ? ORDER BY created_at LIMIT ?")
      .bind(accountId, INBOX_PAGE)
      .all<{ id: string }>();
    for (const { id } of results) {
      if (stop()) return result(false);
      worked = true;
      const msgs = await deleteInboxMessages(env, id, deadline);
      deleted.messages += msgs.deleted;
      if (msgs.more) return result(false);
      const r = await deleteInbox(env, accountId, id, now).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null; // gone meanwhile (a concurrent call)
        throw e;
      });
      if (!r) continue;
      deleted.inboxes++;
      deleted.blobs += r.blobs_deleted;
      if (r.address_reserved) reserved++;
    }
    if (results.length < INBOX_PAGE) break;
  }

  // 2. Custom domains. deleteDomain only removes the row: it changes nothing in Cloudflare (the
  //    zone's Email Routing and Email Sending stay as its owner set them, and mail to the domain is
  //    rejected once no account owns it). Another account can take the domain only by passing the
  //    ownership challenge, which needs control of its DNS.
  for (;;) {
    const { results } = await env.DB.prepare("SELECT domain FROM domains WHERE account_id = ? LIMIT ?")
      .bind(accountId, INBOX_PAGE)
      .all<{ domain: string }>();
    for (const { domain } of results) {
      if (stop()) return result(false);
      worked = true;
      await deleteDomain(env, accountId, domain, { delete_inboxes: true });
      deleted.domains++;
    }
    if (results.length < INBOX_PAGE) break;
  }

  // 3. Webhooks: delivery logs in chunks, then the webhooks (a handful per account, one statement).
  //    Queued jobs of a deleted webhook are dropped by the consumer.
  if (
    !(await chunked(
      "DELETE FROM webhook_deliveries WHERE id IN (SELECT d.id FROM webhooks w JOIN webhook_deliveries d ON d.webhook_id = w.id WHERE w.account_id = ?1 LIMIT ?2)",
      "webhook_deliveries",
    ))
  )
    return result(false);
  deleted.webhooks += (await env.DB.prepare("DELETE FROM webhooks WHERE account_id = ?").bind(accountId).run()).meta.changes ?? 0;

  // 4. Everything else keyed by the account. Most went with the messages already (deliveries and
  //    forward_queue cascade); this catches the rest.
  for (const table of ACCOUNT_TABLES) {
    if (!(await chunked(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE account_id = ?1 LIMIT ?2)`, table)))
      return result(false);
  }

  return result(true);
}
