import { accountStanding, ApiError } from "@afs/shared";
import type { Bindings } from "../env";
import { type SiteRow, siteStub } from "./context";
import { type ErasedRows, eraseSite, SITE_TABLES } from "./sites";
import { forgetHooks, purgeWebhookLogs } from "./webhooks";

const DAY = 86_400_000;
/** Wall-time budget of one hourly run; what's left continues next hour. */
export const PURGE_BUDGET_MS = 20_000;
/** Of it, at most this much for R2 cleanup of deleted sites (it runs first, so it can't starve). */
const PREFIX_BUDGET_MS = 6_000;
const SITES_PER_RUN = 200;
const PREFIXES_PER_RUN = 20;
/** Per-site time inside a kick (one maintenance pass). */
const SITE_BUDGET_MS = 3_000;

/**
 * Hourly. Retention itself runs on each site's Durable Object alarm (hourly while it holds data),
 * so this only:
 *   1. deletes R2 chunks of deleted sites by prefix (own time budget, first);
 *   2. kicks every site's DO about once a day (least recently first; never-kicked sites first,
 *      e.g. objects from before alarms existed): one bounded maintenance pass with the site's
 *      current retention settings, which also schedules its alarm;
 *   3. drops expired share links, old usage rows and verify logs.
 * Every site and prefix is isolated (one failing can't stop the run or stay first forever: it is
 * marked and retried a day later), and the deadline is checked inside every loop.
 */
export async function runPurge(env: Bindings, now = Date.now(), budgetMs = PURGE_BUDGET_MS) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const prefixDeadline = Math.min(deadline, started + Math.min(PREFIX_BUDGET_MS, budgetMs / 2));
  const out = {
    sites: 0,
    site_errors: 0,
    sessions_deleted: 0,
    chunks_deleted: 0,
    prefixes_cleaned: 0,
    links_deleted: 0,
    more: false,
  };

  // 1. Deleted sites: their chunks, by prefix.
  const { results: prefixes } = await env.DB.prepare("SELECT prefix FROM r2_cleanup ORDER BY created_at LIMIT ?")
    .bind(PREFIXES_PER_RUN)
    .all<{ prefix: string }>();
  for (const { prefix } of prefixes) {
    if (Date.now() > prefixDeadline) {
      out.more = true;
      break;
    }
    try {
      let done = false;
      for (let round = 0; round < 5 && Date.now() < prefixDeadline; round++) {
        const list = await env.CHUNKS.list({ prefix, limit: 1000 });
        if (list.objects.length) await env.CHUNKS.delete(list.objects.map((o) => o.key));
        out.chunks_deleted += list.objects.length;
        if (!list.truncated) {
          done = true;
          break;
        }
      }
      if (done) {
        await env.DB.prepare("DELETE FROM r2_cleanup WHERE prefix = ?").bind(prefix).run();
        out.prefixes_cleaned++;
      } else out.more = true;
    } catch (e) {
      console.error(JSON.stringify({ event: "cron.prefix_failed", prefix, error: String(e) }));
      // Behind the others next time.
      await env.DB.prepare("UPDATE r2_cleanup SET created_at = ? WHERE prefix = ?")
        .bind(now, prefix)
        .run()
        .catch(() => {});
      out.more = true;
    }
  }

  // 2. Daily kick of each site's Durable Object.
  const { results: sites } = await env.DB.prepare(
    "SELECT * FROM sites WHERE maintained_at IS NULL OR maintained_at < ? ORDER BY COALESCE(maintained_at, 0) LIMIT ?",
  )
    .bind(now - DAY + 10 * 60_000, SITES_PER_RUN)
    .all<SiteRow>();
  for (const site of sites) {
    if (Date.now() > deadline) {
      out.more = true;
      break;
    }
    try {
      const r = await siteStub(env, site.id).kick(
        { site_id: site.id, retention_days: site.retention_days, heatmap_retention_days: site.heatmap_retention_days },
        { now, budgetMs: Math.max(500, Math.min(SITE_BUDGET_MS, deadline - Date.now())) },
      );
      out.sessions_deleted += r.sessions_deleted;
      out.chunks_deleted += r.chunks_deleted;
      if (r.more) out.more = true;
    } catch (e) {
      out.site_errors++;
      console.error(JSON.stringify({ event: "cron.site_failed", site: site.id, error: String(e) }));
    }
    // Marked either way: a site that keeps failing is retried tomorrow, not first in every run.
    await env.DB.prepare("UPDATE sites SET maintained_at = ? WHERE id = ?")
      .bind(now, site.id)
      .run()
      .catch(() => {});
    out.sites++;
  }

  // 3. Expired links, old usage counters and verify logs.
  const links = await env.DB.prepare("DELETE FROM replay_links WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
    .bind(now - 7 * DAY, now - 7 * DAY)
    .run();
  out.links_deleted = links.meta.changes ?? 0;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_usage WHERE day < ?").bind(new Date(now - 7 * DAY).toISOString().slice(0, 10)),
    env.DB.prepare("DELETE FROM heatmap_image_usage WHERE day < ?").bind(new Date(now - 7 * DAY).toISOString().slice(0, 10)),
    env.DB.prepare("DELETE FROM verify_log WHERE created_at < ?").bind(now - 3_600_000),
  ]);
  await purgeWebhookLogs(env, now).catch((e) => console.error(JSON.stringify({ event: "cron.webhook_logs_failed", error: String(e) })));
  return out;
}

/** Wall-time budget of one account purge call; with work left it answers done: false and is called again. */
export const ACCOUNT_PURGE_BUDGET_MS = 20_000;
const ACCOUNT_SITES_PER_ROUND = 50;

/**
 * Erase everything a deleted account owns here (409 not_deleted for a live one): every site (its
 * Durable Object, D1 rows, and its R2 prefixes queued in r2_cleanup, which the hourly cron above
 * deletes), then the account-level rows (webhooks for every site and their deliveries, verify_log). Kept: the bare `accounts` mirror
 * row and the fair-use counters (account_usage, webhook_usage, heatmap_image_usage), which never go
 * down and age out with the cron. The linked analytics site isn't told to unlink: it is being erased
 * too (and would refuse the change for a deleted account).
 *
 * Bounded by a wall-time budget, at least one site per call; `done: false` = call again. Idempotent:
 * an emptied account answers `done: true` with zero counts. A site that fails is logged and left
 * for the next call (done stays false), so one bad site can't block the others.
 */
export async function purgeAccount(env: Bindings, accountId: string, opts: { budgetMs?: number } = {}) {
  // Never a live project: only one the identity DB marks deleted (an unreadable standing refuses too).
  if ((await accountStanding(env, accountId)).deleted !== true)
    throw new ApiError(
      409,
      "not_deleted",
      "This project isn't deleted, so its data isn't erased.",
      "Projects are deleted on the platform first (dashboard, or DELETE https://agentfirststack.com/v1/me); the site erases them 7 days later.",
    );
  const deadline = Date.now() + (opts.budgetMs ?? ACCOUNT_PURGE_BUDGET_MS);
  const deleted: ErasedRows & { verify_log: number } = {
    sites: 0,
    replay_links: 0,
    ...(Object.fromEntries(SITE_TABLES.map((t) => [t, 0])) as Record<(typeof SITE_TABLES)[number], number>),
    verify_log: 0,
  };
  let prefixesQueued = 0;
  const failed = new Set<string>();
  let more = false;
  let worked = false;
  sites: for (;;) {
    const { results } = await env.DB.prepare("SELECT * FROM sites WHERE account_id = ? ORDER BY created_at, id LIMIT ?")
      .bind(accountId, failed.size + ACCOUNT_SITES_PER_ROUND)
      .all<SiteRow>();
    const todo = results.filter((s) => !failed.has(s.id));
    if (!todo.length) break;
    for (const s of todo) {
      if (worked && Date.now() >= deadline) {
        more = true;
        break sites;
      }
      worked = true;
      try {
        const r = await eraseSite(env, s, { unlinkAnalytics: false });
        for (const [t, n] of Object.entries(r.rows)) deleted[t as keyof ErasedRows] += n;
        prefixesQueued += r.prefixesQueued;
      } catch (e) {
        failed.add(s.id);
        console.error(JSON.stringify({ event: "account_purge.site_failed", account: accountId, site: s.id, error: String(e) }));
      }
    }
  }
  if (!more && !failed.size) {
    // Account-level rows: webhooks without a site (and any left over), their deliveries, verify calls.
    const [deliveries, hooks, verify] = await env.DB.batch([
      env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE account_id = ?)").bind(accountId),
      env.DB.prepare("DELETE FROM webhooks WHERE account_id = ?").bind(accountId),
      env.DB.prepare("DELETE FROM verify_log WHERE account_id = ?").bind(accountId),
    ]);
    deleted.webhook_deliveries += deliveries?.meta.changes ?? 0;
    deleted.webhooks += hooks?.meta.changes ?? 0;
    deleted.verify_log += verify?.meta.changes ?? 0;
    forgetHooks(accountId);
  }
  return {
    account_id: accountId,
    done: !more && !failed.size,
    deleted,
    r2_prefixes_queued: prefixesQueued,
    ...(failed.size ? { site_errors: failed.size } : {}),
  };
}
