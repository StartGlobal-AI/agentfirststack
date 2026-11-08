import { buildDigest, emailOperatorDigest } from "./operator-digest";
import { ApiError, cleanName, forgetStanding, readJson, timingSafeEqual } from "@afs/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { SiteEnv } from "./env";
import { noticeBase, refreshNotices } from "./notices";
import { emailEnabled, waitUntilOf } from "./email";
import { emailSuspension, emailWelcome } from "./email-messages";
import { siteBase } from "./google";
import { restoreProject } from "./project-deletion";
import { repairFirstPartyRoutes } from "./first-party-domains";
import { accountPauses, activePauses, capabilityOf, liftCapability, pauseCapability } from "./pauses";
import { listAbuseReports, reviewAbuseReport } from "./abuse-reports";

/**
 * Operator tools for abuse of the free platform, on the site (it owns the identity database):
 *
 *   GET  /v1/admin/accounts/:id              an account's standing
 *   POST /v1/admin/accounts/:id/suspend      { "reason": "..." }  every key stops on every service
 *   POST /v1/admin/accounts/:id/unsuspend    keys work again
 *   POST /v1/admin/accounts/:id/restore      undo a project deletion before its purge (src/project-deletion.ts)
 *   POST /v1/admin/emails/test               { "email": "..." }  the welcome email to a signed-in person, now
 *   POST /v1/admin/digest                    the operator's daily summary, now (also returns it as JSON)
 *   GET  /v1/admin/pauses                    capability pauses in force (src/pauses.ts)
 *   POST /v1/admin/accounts/:id/pauses       { "capability", "reason", "until"? }  pause one capability by hand
 *   DELETE /v1/admin/accounts/:id/pauses/:capability   lift a pause (pnpm afs unpause)
 *   GET  /v1/admin/abuse-reports?status=new&limit=50   abuse reports (src/abuse-reports.ts)
 *   PATCH /v1/admin/abuse-reports/:id        { "status": "reviewed" | "dismissed" | "new", "note"? }
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

adminApi.get("/v1/admin/accounts/:id", async (c) => {
  const id = accountId(c);
  return c.json({ account: await accountState(c.env.DB, id), pauses: await accountPauses(c.env.DB, id) });
});

// ---------- capability pauses (src/pauses.ts) ----------

adminApi.get("/v1/admin/pauses", async (c) => c.json({ pauses: await activePauses(c.env.DB) }));

const operatorPauseBody = z.object({
  capability: z.string().max(40),
  reason: z.string().min(1).max(500),
  until: z.number().int().positive().nullable().optional(),
});

adminApi.post("/v1/admin/accounts/:id/pauses", async (c) => {
  const id = accountId(c);
  const body = await readJson(c, operatorPauseBody);
  const capability = capabilityOf(body.capability);
  const r = await pauseCapability(
    c.env,
    siteBase(c),
    { accountId: id, capability, reason: body.reason, by: "operator", until: body.until ?? null },
    waitUntilOf(c),
  );
  return c.json({
    ...r,
    next_steps: [
      `The services refuse ${capability} with 403 capability_paused within a minute (each Worker caches pauses for 60 s).`,
      r.existing ? "It was already paused; nothing was emailed again." : "The project's people were emailed.",
      `Lift it: DELETE /v1/admin/accounts/${id}/pauses/${capability} (pnpm afs unpause <profile> ${id} ${capability}).`,
    ],
  });
});

adminApi.delete("/v1/admin/accounts/:id/pauses/:capability", async (c) => {
  const id = accountId(c);
  await accountState(c.env.DB, id);
  const capability = capabilityOf(c.req.param("capability"));
  const lifted = await liftCapability(c.env, siteBase(c), id, capability, waitUntilOf(c));
  return c.json({
    account_id: id,
    capability,
    lifted,
    existing: !lifted,
    pauses: await accountPauses(c.env.DB, id),
    next_steps: [
      lifted
        ? `${capability} works again within a minute; the project's people were emailed. Automatic re-pauses of it are ignored for PAUSE_LIFT_GRACE_HOURS (default 24).`
        : `${capability} wasn't paused; nothing changed.`,
    ],
  });
});

// ---------- abuse reports (src/abuse-reports.ts) ----------

adminApi.get("/v1/admin/abuse-reports", async (c) => {
  const status = c.req.query("status");
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ reports: await listAbuseReports(c.env.DB, { status: status || undefined, limit: Number.isFinite(limit) ? limit : 50 }) });
});

adminApi.patch("/v1/admin/abuse-reports/:id", async (c) => {
  const body = await readJson(c, z.object({ status: z.enum(["new", "reviewed", "dismissed"]), note: z.string().max(1000).optional() }));
  return c.json({ report: await reviewAbuseReport(c.env.DB, c.req.param("id"), body.status, body.note) });
});

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
  const after = await accountState(c.env.DB, id);
  if (before.suspended_at === null && after.suspended_at !== null)
    await emailSuspension(c.env, siteBase(c), waitUntilOf(c), { accountId: id, name: after.name, suspended: true, at: after.suspended_at });
  return c.json({
    account: after,
    suspended: true,
    existing: before.suspended_at !== null,
    next_steps: [
      "Every key of this account (OAuth tokens included) now gets 403 account_suspended on every service.",
      "Public ingest for its sites and containers stops within a minute (each Worker caches standing for 60 s).",
      `Undo with POST /v1/admin/accounts/${id}/unsuspend.`,
    ],
  });
});

// Send the welcome email to someone who has signed in, now: checks sending end to end (the
// sender, the binding, the domain's SPF, DKIM and DMARC, and where it lands).
adminApi.post("/v1/admin/emails/test", async (c) => {
  const { email } = await readJson(c, z.object({ email: z.string().min(3).max(320) }));
  if (!emailEnabled(c.env))
    throw new ApiError(
      503,
      "not_configured",
      "Email isn't configured on this deployment.",
      "Set the NOTIFY_EMAIL_FROM var and the EMAIL binding on the site.",
    );
  const user = await c.env.DB.prepare("SELECT id, email FROM users WHERE lower(email) = lower(?)")
    .bind(email.trim())
    .first<{ id: string; email: string }>();
  if (!user)
    throw new ApiError(
      404,
      "not_found",
      "Nobody with that email has signed in.",
      "Test emails go only to people who signed in with Google.",
    );
  const key = `welcome-test:${user.id}:${Date.now()}`;
  const result = await emailWelcome(c.env, siteBase(c), undefined, { userId: user.id, email: user.email, dedupeKey: key });
  const row = await c.env.DB.prepare("SELECT id, status, error, message_id FROM email_outbox WHERE dedupe_key = ?").bind(key).first();
  return c.json({ result, email: row });
});

// The operator's summary (src/operator-digest.ts), now: to OPERATOR_EMAIL if set, and in the answer.
adminApi.post("/v1/admin/digest", async (c) => {
  const now = Date.now();
  const digest = await buildDigest(c.env, now);
  const email = await emailOperatorDigest(c.env, siteBase(c), now, { manual: true });
  return c.json({ digest, email });
});

// First-party domains' Worker routes, put back where missing: `wrangler deploy` of the site replaces
// its routes with the config's, which removes them (pnpm afs deploy calls this right after).
adminApi.post("/v1/admin/first-party-domains/repair", async (c) => {
  const r = await repairFirstPartyRoutes(c.env);
  return c.json(r ? { configured: true, ...r } : { configured: false, domains: 0, restored: [], failed: [] });
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
  if (before.suspended_at !== null)
    await emailSuspension(c.env, siteBase(c), waitUntilOf(c), { accountId: id, name: before.name, suspended: false, at: Date.now() });
  return c.json({
    account: await accountState(c.env.DB, id),
    suspended: false,
    existing: before.suspended_at === null,
    next_steps: ["Its keys work again at once; public ingest resumes within a minute."],
  });
});
