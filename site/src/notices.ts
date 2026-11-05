import { forgetNotice } from "@afs/shared";
import { emailSetupNotices } from "./email-messages";
import type { Bindings } from "./env";
import { CATALOG_VERSION, itemsAfter } from "./setup-catalog";

/**
 * Telling projects that are already set up what's new (src/setup-catalog.ts).
 *
 * The setup check records what the project's agent saw (setup_state). The daily cron writes a
 * notice (project_notices) for every active project whose agent last checked at an older catalog
 * version, or never checked. Every service then adds that notice to the agent's next API or MCP
 * answer at most once a day (@afs/shared notices); the analytics weekly report shows owner_notice.
 * Running the setup check deletes it.
 */

export interface SetupState {
  checked_at: number;
  catalog_version: number;
  seen: string[];
}

export async function readSetupState(db: D1Database, accountId: string): Promise<SetupState | null> {
  try {
    const row = await db
      .prepare("SELECT checked_at, catalog_version, seen FROM setup_state WHERE account_id = ?")
      .bind(accountId)
      .first<{ checked_at: number; catalog_version: number; seen: string }>();
    if (!row) return null;
    let seen: string[] = [];
    try {
      const parsed = JSON.parse(row.seen) as unknown;
      if (Array.isArray(parsed)) seen = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      /* treat as nothing seen */
    }
    return { checked_at: row.checked_at, catalog_version: row.catalog_version, seen };
  } catch (e) {
    console.error("setup_state read failed", e);
    return null;
  }
}

/** The project's agent ran the setup check: remember what it saw, and drop its notice. */
export async function recordSetupCheck(db: D1Database, accountId: string, checkIds: string[], now = Date.now()) {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO setup_state (account_id, checked_at, catalog_version, seen) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET checked_at = excluded.checked_at, catalog_version = excluded.catalog_version,
             seen = excluded.seen`,
        )
        .bind(accountId, now, CATALOG_VERSION, JSON.stringify([...new Set(checkIds)].slice(0, 200))),
      db.prepare("DELETE FROM project_notices WHERE account_id = ?").bind(accountId),
    ]);
    // This isolate's cache: the site's own answers stop carrying the notice now, not in 10 minutes.
    forgetNotice(accountId);
  } catch (e) {
    console.error("setup_state write failed", e);
  }
}

/** The notice for a project whose agent last checked at catalog version `seen` (null = never). */
export function noticeTexts(base: string, seen: number | null): { notice: string; owner_notice: string } | null {
  const fresh = itemsAfter(seen ?? 0).map((i) => i.label);
  if (seen !== null && !fresh.length) return null;
  const call = `GET ${base}/v1/setup (MCP afs_check_setup)`;
  const list = fresh.join("; ");
  if (seen === null)
    return {
      notice: `This project hasn't run the AgentFirstStack setup check yet. Run ${call}: it lists what's set up, what's missing and the fix for each${
        list ? `. New: ${list}` : ""
      }.`,
      owner_notice: `Your agent hasn't checked this project's setup yet${list ? `. New in AgentFirstStack: ${list}` : ""}.`,
    };
  return {
    notice: `New AgentFirstStack setup items for this project since its last setup check: ${list}. Run ${call} and apply what it lists.`,
    owner_notice: `New in AgentFirstStack for this project: ${list}.`,
  };
}

const DAY = 86_400_000;

/**
 * Daily cron: a notice for every active project (an unrevoked key used in the last 30 days) whose
 * agent hasn't seen the current catalog. A notice whose text changed is shown again.
 */
export async function refreshNotices(env: Bindings, base: string, now = Date.now(), limit = 2000) {
  const rows = await env.DB.prepare(
    `SELECT a.id AS account_id, s.catalog_version AS seen
       FROM accounts a
       LEFT JOIN setup_state s ON s.account_id = a.id
      WHERE a.suspended_at IS NULL AND a.deleted_at IS NULL
        AND (s.catalog_version IS NULL OR s.catalog_version < ?)
        AND EXISTS (SELECT 1 FROM api_keys k WHERE k.account_id = a.id AND k.revoked_at IS NULL AND k.last_used_at > ?)
      LIMIT ?`,
  )
    .bind(CATALOG_VERSION, now - 30 * DAY, limit)
    .all<{ account_id: string; seen: number | null }>();
  const statements: D1PreparedStatement[] = [];
  const noticed: { account_id: string; seen: number | null }[] = [];
  for (const r of rows.results ?? []) {
    const t = noticeTexts(base, r.seen);
    if (!t) continue;
    noticed.push(r);
    statements.push(
      env.DB.prepare(
        `INSERT INTO project_notices (account_id, notice, owner_notice, created_at, shown_at) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(account_id) DO UPDATE SET notice = excluded.notice, owner_notice = excluded.owner_notice,
           created_at = CASE WHEN project_notices.notice = excluded.notice THEN project_notices.created_at ELSE excluded.created_at END,
           shown_at = CASE WHEN project_notices.notice = excluded.notice THEN project_notices.shown_at ELSE NULL END`,
      ).bind(r.account_id, t.notice, t.owner_notice, now),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  // Their owners hear about it by email too, once per catalog version (queued; the hourly run sends).
  const emails = await emailSetupNotices(env, base, noticed, CATALOG_VERSION);
  return { projects: statements.length, emails };
}

/** The base URL the notices name (the deployment's site). */
export const noticeBase = (env: Bindings) => (env.PUBLIC_BASE_URL || env.AUTH_ISSUER || "").replace(/\/+$/, "");
