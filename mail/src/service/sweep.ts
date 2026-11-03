import type { AppEnv } from "../env";

/**
 * Cron: delete R2 objects whose message no longer exists in D1 (orphans).
 *
 * Every blob lives at inbox/<inbox_id>/<message_id>/..., and ingest/send delete a message's blobs
 * when its D1 row is not committed, so orphans only come from a crash between the R2 write and the
 * D1 commit, or a failed R2 delete after a D1 delete. The sweep walks the bucket incrementally: a
 * few list pages per run, resuming from a cursor kept in cron_state, and skips objects younger
 * than SWEEP_GRACE_MS (an ingest may still be about to commit them). One D1 query per page.
 */

export const SWEEP_GRACE_MS = 60 * 60_000;
export const SWEEP_PAGES_PER_RUN = 5;
const CURSOR_KEY = "blob_sweep_cursor";

export async function sweepOrphanBlobs(env: AppEnv, now = Date.now(), opts: { pages?: number; budgetMs?: number } = {}) {
  const stop = Date.now() + (opts.budgetMs ?? 20_000);
  const state = await env.DB.prepare("SELECT value FROM cron_state WHERE name = ?").bind(CURSOR_KEY).first<{ value: string | null }>();
  let cursor = state?.value || undefined;
  let scanned = 0;
  let deleted = 0;
  let wrapped = false;
  for (let page = 0; page < (opts.pages ?? SWEEP_PAGES_PER_RUN) && Date.now() < stop; page++) {
    const list = await env.BLOBS.list({ prefix: "inbox/", cursor, limit: 1000 });
    scanned += list.objects.length;
    const byMessage = new Map<string, string[]>();
    for (const o of list.objects) {
      const parts = o.key.split("/");
      if (parts.length < 4 || !parts[2]) continue;
      if (now - o.uploaded.getTime() < SWEEP_GRACE_MS) continue;
      const keys = byMessage.get(parts[2]) ?? [];
      keys.push(o.key);
      byMessage.set(parts[2], keys);
    }
    if (byMessage.size) {
      const { results } = await env.DB.prepare("SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify([...byMessage.keys()]))
        .all<{ id: string }>();
      const live = new Set(results.map((r) => r.id));
      const dead = [...byMessage].filter(([id]) => !live.has(id)).flatMap(([, keys]) => keys);
      for (let i = 0; i < dead.length; i += 1000) await env.BLOBS.delete(dead.slice(i, i + 1000));
      deleted += dead.length;
    }
    cursor = list.truncated ? list.cursor : undefined;
    if (!cursor) {
      wrapped = true; // a full pass is done; the next run starts over
      break;
    }
  }
  await env.DB.prepare(
    "INSERT INTO cron_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(CURSOR_KEY, cursor ?? null, now)
    .run();
  return { blobs_scanned: scanned, orphan_blobs_deleted: deleted, sweep_wrapped: wrapped };
}
