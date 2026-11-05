import {
  ApiError,
  type AuthContext,
  assertPermanentKey,
  assertWrite,
  badRequest,
  forgetStanding,
  readJson,
  requireAuth,
} from "@afs/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type Bindings, DAY, type SiteEnv } from "./env";
import { siteBase } from "./google";
import { type Service, callService } from "./services";

/**
 * Deleting a project (an account), in three steps:
 *
 *   1. delete:  deleted_at is set and the project stops at once, like a suspension. Every key and
 *               OAuth token gets 403 project_deleted, public ingest and inbound mail are refused
 *               (accountStanding() reads it as suspended), unused claim links are deleted, and
 *               the dashboard shows it only to its owner, under "Deleted projects".
 *   2. restore: until purge_after (7 days later) its owner can undo it from the dashboard (and
 *               the operator with POST /v1/admin/accounts/:id/restore). Nothing was erased yet.
 *   3. purge:   the daily cron erases it: every service's DELETE /v1/account (sites and their
 *               events, containers, inboxes and their mail, recordings), then its keys,
 *               memberships, grants, claim links, setup state and notices here. The accounts row
 *               keeps only the id and the dates. Shared-domain inbox addresses that ever received
 *               mail stay reserved for good (mail's address_tombstones), so nobody else can get
 *               the project's password resets.
 *
 * Who can delete: the owner, in the dashboard. An unclaimed project's own agent, with a full key
 * (DELETE /v1/me or the afs_delete_project tool). Agents of a claimed project can't: a project
 * with an owner is deleted by its owner.
 */

export const RESTORE_DAYS = 7;

/** The services that hold a project's data, purged in this order. */
const PURGED: Service[] = ["analytics", "tags", "mail", "replay"];
const BINDING = { analytics: "ANALYTICS", tags: "TAGS", mail: "MAIL", replay: "REPLAY" } as const;

export interface DeletionState {
  id: string;
  name: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
  purge_after: number | null;
  purged_at: number | null;
}

export async function deletionState(db: D1Database, accountId: string): Promise<DeletionState | null> {
  return db
    .prepare("SELECT id, name, deleted_at, deleted_by, purge_after, purged_at FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<DeletionState>();
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * What to take out of the website's code once the project is gone. The same list is in the API
 * answer, on the dashboard after deleting, and in the manual.
 */
export const CLEANUP_STEPS = [
  "Remove the analytics and tags snippets (the <script> tags loading analytics.agentfirststack.com and tags.agentfirststack.com) and any server-side calls to them.",
  "Remove AGENTFIRSTSTACK_API_KEY (and any other AgentFirstStack ids) from .env and from the hosting platform's environment variables.",
  "Delete AGENTFIRSTSTACK.md and the AgentFirstStack block in AGENTS.md.",
  "If a custom mail domain was set up, remove its MX, SPF and DKIM records from DNS.",
  "Point any account that used one of the project's inbox addresses (as its login or recovery email) at another address: those addresses stop receiving mail now.",
];

export const cleanupPrompt = (name: string) =>
  `Our AgentFirstStack project ${name} is deleted. Remove it from this codebase: ${CLEANUP_STEPS.map((s) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "")).join("; ")}. Show me what you removed.`;

/** Asked before deleting: everything worth keeping, out of the project first. */
export const exportPrompt = (name: string) =>
  `Before I delete our AgentFirstStack project ${name}, export everything worth keeping into this repo's exports/ folder: analytics (GET /v1/sites/:id/export for each site, CSV), the tags container config (GET /v1/containers/:id/draft for each container), every inbox's messages (as .eml files, from GET /v1/messages/:id/raw), and the events of any replay session I want to keep (GET /v1/sites/:id/sessions/:session/events). Tell me what you saved and its size.`;

/**
 * Mark the project deleted. Retries are safe: deleting a deleted project keeps the first dates.
 * `by` is the user id of the owner who deleted it, or "agent".
 */
export async function deleteProject(env: Bindings, accountId: string, by: string, now = Date.now()) {
  const purgeAfter = now + RESTORE_DAYS * DAY;
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND deleted_at IS NULL").bind(
      now,
      by,
      purgeAfter,
      accountId,
    ),
    // Nobody can join a deleted project. (Used links stay: they're the record of who claimed it.)
    env.DB.prepare("DELETE FROM claim_links WHERE account_id = ? AND used_at IS NULL").bind(accountId),
  ]);
  forgetStanding(accountId);
  const state = await deletionState(env.DB, accountId);
  if (!state?.deleted_at || !state.purge_after) throw new Error("project deletion did not stick");
  return { deleted_at: state.deleted_at, purge_after: state.purge_after, existing: state.deleted_at !== now };
}

/** Undo a deletion that hasn't been purged yet. */
export async function restoreProject(env: Bindings, accountId: string, now = Date.now()) {
  const state = await deletionState(env.DB, accountId);
  if (!state) throw new ApiError(404, "not_found", "Project not found.");
  if (state.deleted_at === null) return { restored: false, existing: true };
  if (state.purged_at !== null || (state.purge_after ?? 0) <= now)
    throw new ApiError(
      410,
      "project_purged",
      "This project's data has been erased; it can't be restored.",
      "Start a new project instead: ask your agent to set AgentFirstStack up again.",
    );
  await env.DB.prepare(
    "UPDATE accounts SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL WHERE id = ? AND purged_at IS NULL AND purge_after > ?",
  )
    .bind(accountId, now)
    .run();
  forgetStanding(accountId);
  return { restored: true, existing: false };
}

export interface PurgeReport {
  account_id: string;
  done: boolean;
  services: Partial<Record<Service, { done: boolean; status: number; deleted?: unknown }>>;
}

/**
 * Erase one project whose restore window has passed. Each service's DELETE /v1/account is called
 * until it reports done (it works within its own time budget). Only when every service is done
 * are the identity rows erased and purged_at set; otherwise the next run carries on.
 */
export async function purgeProject(env: Bindings, accountId: string, deadline: number, now = Date.now()): Promise<PurgeReport> {
  const report: PurgeReport = { account_id: accountId, done: false, services: {} };
  for (const svc of PURGED) {
    // A deployment without the service (self-hosting some apps) holds nothing there.
    if (!env[BINDING[svc]]) {
      report.services[svc] = { done: true, status: 0 };
      continue;
    }
    let r: Awaited<ReturnType<typeof callService<{ done?: boolean; deleted?: unknown }>>>;
    do {
      r = await callService<{ done?: boolean; deleted?: unknown }>(env, svc, accountId, "/v1/account", { method: "DELETE" });
    } while (r.ok && r.json?.done === false && Date.now() < deadline);
    report.services[svc] = { done: r.ok && r.json?.done === true, status: r.status, deleted: r.json?.deleted };
    if (!report.services[svc]?.done) {
      console.error(JSON.stringify({ event: "project.purge_incomplete", account_id: accountId, service: svc, status: r.status }));
      return report;
    }
  }
  await env.DB.batch([
    // Cascades: oauth_codes, oauth_refresh_tokens (and the grants' access tokens are api_keys).
    env.DB.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM oauth_grants WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM memberships WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM claim_links WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM setup_state WHERE account_id = ?").bind(accountId),
    env.DB.prepare("DELETE FROM project_notices WHERE account_id = ?").bind(accountId),
    // The row stays (ids are never reused, and it records when the project was deleted and erased).
    env.DB.prepare("UPDATE accounts SET name = NULL, email = NULL, purged_at = ? WHERE id = ?").bind(now, accountId),
  ]);
  forgetStanding(accountId);
  report.done = true;
  return report;
}

/** Daily cron: erase the projects whose restore window has passed, within `budgetMs`. */
export async function purgeDeletedProjects(env: Bindings, now = Date.now(), budgetMs = 5 * 60_000) {
  const deadline = Date.now() + budgetMs;
  const { results } = await env.DB.prepare(
    "SELECT id FROM accounts WHERE purge_after IS NOT NULL AND purge_after <= ? AND purged_at IS NULL AND deleted_at IS NOT NULL ORDER BY purge_after LIMIT 50",
  )
    .bind(now)
    .all<{ id: string }>();
  const purged: string[] = [];
  const pending: string[] = [];
  for (const { id } of results) {
    if (Date.now() >= deadline) {
      pending.push(id);
      continue;
    }
    const r = await purgeProject(env, id, deadline, now);
    (r.done ? purged : pending).push(id);
  }
  return { purged, pending };
}

/** The deletion answer for agents (DELETE /v1/me, afs_delete_project). */
export function deletionAnswer(accountId: string, d: { deleted_at: number; purge_after: number; existing: boolean }) {
  return {
    deleted: true,
    existing: d.existing,
    project_id: accountId,
    deleted_at: d.deleted_at,
    purge_after: d.purge_after,
    note: `The project is stopped: its keys (this one too) and its tracking, recording and inbound mail no longer work. Its data is erased on ${day(d.purge_after)}. Inbox addresses that received mail stay reserved for good, so nobody else can receive this project's email.`,
    restore: `This project was never claimed, so no one can restore it from the dashboard. Until ${day(d.purge_after)} the operator can (email privacy@agentfirststack.com with the project id).`,
    next_steps: CLEANUP_STEPS,
  };
}

/** Whether a person has claimed the project (then only its owner may delete it). */
export async function isClaimed(db: D1Database, accountId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM memberships WHERE account_id = ? LIMIT 1").bind(accountId).first("x"));
}

const confirmBody = z.object({ confirm: z.string().max(200).optional() });

/**
 * DELETE /v1/me: an unclaimed project's own agent deletes it. Full-access permanent keys only
 * (not a read key, not a connected app's OAuth token), and the body names the project's id, so a
 * stray or injected call can't do it by accident.
 */
export const deletionApi = new Hono<SiteEnv>();
deletionApi.delete("/v1/me", requireAuth<SiteEnv>(), async (c) => {
  const auth: AuthContext = c.var.auth;
  assertWrite(auth);
  assertPermanentKey(auth, "delete the project");
  const body = await readJson(c, confirmBody);
  if (body.confirm !== auth.accountId)
    throw badRequest(
      "To delete the project, confirm its id.",
      `Send {"confirm":"${auth.accountId}"}. Deleting stops every key and the project's tracking, recording and mail at once, and erases its data ${RESTORE_DAYS} days later. Ask the person first, and export what they want to keep.`,
    );
  if (await isClaimed(c.env.DB, auth.accountId))
    throw new ApiError(
      403,
      "owner_required",
      "This project has an owner, so only they can delete it.",
      `Ask them to delete it in the dashboard: ${siteBase(c)}/dashboard/projects/${auth.accountId}/settings (Settings, General, Delete project).`,
    );
  return c.json(deletionAnswer(auth.accountId, await deleteProject(c.env, auth.accountId, "agent")));
});
