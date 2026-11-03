import type { Bindings } from "../env";
import { retentionDaysCap } from "../lib/limits";
import { type SiteRow, siteStub } from "./context";

const DAY = 86_400_000;
/** Wall-time budget of one hourly run; what's left continues next hour. */
export const PURGE_BUDGET_MS = 20_000;
const SITES_PER_RUN = 200;

/**
 * Hourly: for each site (least recently purged first) roll settled days up into heatmap
 * aggregates and delete sessions past retention_days (DO rows, then their R2 chunks); finish R2
 * cleanup of deleted sites; drop expired share links. Every step is bounded and idempotent.
 */
export async function runPurge(env: Bindings, now = Date.now(), budgetMs = PURGE_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  const out = { sites: 0, sessions_deleted: 0, chunks_deleted: 0, prefixes_cleaned: 0, links_deleted: 0, more: false };
  const { results: sites } = await env.DB.prepare(
    "SELECT * FROM sites WHERE purged_at IS NULL OR purged_at < ? ORDER BY COALESCE(purged_at, 0) LIMIT ?",
  )
    .bind(now - 50 * 60_000, SITES_PER_RUN)
    .all<SiteRow>();
  const cap = retentionDaysCap(env);
  for (const site of sites) {
    if (Date.now() > deadline) {
      out.more = true;
      break;
    }
    const stub = siteStub(env, site.id);
    let more = true;
    for (let round = 0; more && round < 5 && Date.now() < deadline; round++) {
      const r = await stub.purge({
        now,
        cutoff: now - Math.min(site.retention_days, cap) * DAY,
        heat_cutoff: now - site.heatmap_retention_days * DAY,
      });
      for (let i = 0; i < r.keys.length; i += 1000) await env.CHUNKS.delete(r.keys.slice(i, i + 1000).map((k) => `${site.id}/${k}`));
      out.sessions_deleted += r.deleted.length;
      out.chunks_deleted += r.keys.length;
      more = r.more;
    }
    if (more) out.more = true;
    else await env.DB.prepare("UPDATE sites SET purged_at = ? WHERE id = ?").bind(now, site.id).run();
    out.sites++;
  }

  // Deleted sites: their chunks, by prefix.
  const { results: prefixes } = await env.DB.prepare("SELECT prefix FROM r2_cleanup ORDER BY created_at LIMIT 20").all<{
    prefix: string;
  }>();
  for (const { prefix } of prefixes) {
    if (Date.now() > deadline) {
      out.more = true;
      break;
    }
    let done = false;
    for (let round = 0; round < 5 && Date.now() < deadline; round++) {
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
  }

  const links = await env.DB.prepare("DELETE FROM replay_links WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
    .bind(now - 7 * DAY, now - 7 * DAY)
    .run();
  out.links_deleted = links.meta.changes ?? 0;
  return out;
}
