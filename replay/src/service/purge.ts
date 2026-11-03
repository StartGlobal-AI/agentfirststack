import type { Bindings } from "../env";
import { type SiteRow, siteStub } from "./context";

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
    env.DB.prepare("DELETE FROM verify_log WHERE created_at < ?").bind(now - 3_600_000),
  ]);
  return out;
}
