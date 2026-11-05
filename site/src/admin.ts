import { ApiError, cleanName, forgetStanding, readJson, timingSafeEqual } from "@afs/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { SiteEnv } from "./env";
import { noticeBase, refreshNotices } from "./notices";
import { restoreProject } from "./project-deletion";

/**
 * Operator tools for abuse of the free platform, on the site (it owns the identity database):
 *
 *   GET  /v1/admin/accounts/:id              an account's standing
 *   POST /v1/admin/accounts/:id/suspend      { "reason": "..." }  every key stops on every service
 *   POST /v1/admin/accounts/:id/unsuspend    keys work again
 *   POST /v1/admin/accounts/:id/restore      undo a project deletion before its purge (src/project-deletion.ts)
 *
 * `Authorization: Bearer <ADMIN_TOKEN>` only (constant-time compare); without ADMIN_TOKEN the
 * routes refuse everyone. authenticate() reads suspended_at on every request, so keys stop at
 * once everywhere; the per-isolate standing cache (public ingest) catches up within a minute.
 * `pnpm afs suspend <profile> <acct_id> --reason "..."` calls these.
 */

export const adminApi = new Hono<SiteEnv>();

const ACCOUNT_ID = /^acct_[0-9a-z]{1,64}$/;

const requireAdmin: MiddlewareHandler<SiteEnv> = async (c, next) => {
  const secret = c.env.ADMIN_TOKEN;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
  if (!secret || !m?.[1] || !timingSafeEqual(m[1], secret)) {
    throw new ApiError(
      401,
      "unauthorized",
      "The admin API needs the operator's ADMIN_TOKEN.",
      "Send `Authorization: Bearer <ADMIN_TOKEN>` (pnpm afs suspend does). API keys don't work here.",
    );
  }
  await next();
};
adminApi.use("/v1/admin/*", requireAdmin);

interface AccountState {
  id: string;
  name: string | null;
  created_at: number;
  suspended_at: number | null;
  suspended_reason: string | null;
  deleted_at: number | null;
  purge_after: number | null;
  purged_at: number | null;
  active_keys: number;
  members: number;
}

async function accountState(db: D1Database, id: string): Promise<AccountState> {
  const row = await db
    .prepare(
      `SELECT a.id, a.name, a.created_at, a.suspended_at, a.suspended_reason, a.deleted_at, a.purge_after, a.purged_at,
              (SELECT count(*) FROM api_keys k WHERE k.account_id = a.id AND k.revoked_at IS NULL
                 AND (k.expires_at IS NULL OR k.expires_at > ?)) AS active_keys,
              (SELECT count(*) FROM memberships m WHERE m.account_id = a.id) AS members
         FROM accounts a WHERE a.id = ?`,
    )
    .bind(Date.now(), id)
    .first<AccountState>();
  if (!row) throw new ApiError(404, "not_found", "Account not found.", "Check the id (acct_...): GET /v1/me shows it for a key.");
  return row;
}

const accountId = (c: Context<SiteEnv>) => {
  const id = c.req.param("id") ?? "";
  if (!ACCOUNT_ID.test(id)) throw new ApiError(404, "not_found", "Account not found.", "Account ids look like acct_...");
  return id;
};

adminApi.get("/v1/admin/accounts/:id", async (c) => c.json({ account: await accountState(c.env.DB, accountId(c)) }));

// After shipping a new setup catalog version: write the notices now instead of at the daily cron.
adminApi.post("/v1/admin/notices/refresh", async (c) => c.json(await refreshNotices(c.env, noticeBase(c.env))));

const suspendBody = z.object({ reason: z.string().min(1).max(500) });

adminApi.post("/v1/admin/accounts/:id/suspend", async (c) => {
  const id = accountId(c);
  const { reason } = await readJson(c, suspendBody);
  const before = await accountState(c.env.DB, id);
  // Retries are safe: suspending a suspended account keeps the original time and reason.
  if (before.suspended_at === null) {
    await c.env.DB.prepare("UPDATE accounts SET suspended_at = ?, suspended_reason = ? WHERE id = ? AND suspended_at IS NULL")
      .bind(Date.now(), cleanName(reason, 500), id)
      .run();
  }
  forgetStanding(id);
  return c.json({
    account: await accountState(c.env.DB, id),
    suspended: true,
    existing: before.suspended_at !== null,
    next_steps: [
      "Every key of this account (OAuth tokens included) now gets 403 account_suspended on every service.",
      "Public ingest for its sites and containers stops within a minute (each Worker caches standing for 60 s).",
      `Undo with POST /v1/admin/accounts/${id}/unsuspend.`,
    ],
  });
});

// A deleted project's restore window: the operator can undo a deletion its agent made (an
// unclaimed project has no owner to do it), until the purge erases it.
adminApi.post("/v1/admin/accounts/:id/restore", async (c) => {
  const id = accountId(c);
  await accountState(c.env.DB, id);
  const r = await restoreProject(c.env, id);
  return c.json({
    account: await accountState(c.env.DB, id),
    restored: r.restored,
    existing: r.existing,
    next_steps: ["Its keys work again at once; public ingest and inbound mail resume within a minute."],
  });
});

adminApi.post("/v1/admin/accounts/:id/unsuspend", async (c) => {
  const id = accountId(c);
  const before = await accountState(c.env.DB, id);
  await c.env.DB.prepare("UPDATE accounts SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?").bind(id).run();
  forgetStanding(id);
  return c.json({
    account: await accountState(c.env.DB, id),
    suspended: false,
    existing: before.suspended_at === null,
    next_steps: ["Its keys work again at once; public ingest resumes within a minute."],
  });
});
