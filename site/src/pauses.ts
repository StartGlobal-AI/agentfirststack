import {
  ApiError,
  CAPABILITIES,
  type Capability,
  type CapabilityPause,
  DEFAULT_LIFT_GRACE_HOURS,
  forgetPauses,
  isCapability,
  type PauseResult,
  readJson,
  recordCapabilityPause,
  timingSafeEqual,
  viaServiceBinding,
} from "@afs/shared";
import { Hono } from "hono";
import { z } from "zod";
import { waitUntilOf } from "./email";
import { emailCapabilityLifted, emailCapabilityPaused } from "./email-messages";
import type { Bindings, SiteEnv } from "./env";
import { noticeBase } from "./notices";

/**
 * Capability pauses, the site's side (the table and the check are in @afs/shared pauses.ts):
 *
 *   POST /v1/internal/pauses   a service pauses one capability of an account after a strong signal
 *                              (over a service binding, x-afs-internal = INTERNAL_TOKEN). Records it,
 *                              emails the project's people and the operator at once.
 *   the admin API              the operator lists, pauses and lifts (src/admin.ts, pnpm afs unpause).
 *   hourly cron                emails pauses a service wrote directly (no SITE binding, or the site
 *                              was unreachable): rows with notified_at NULL.
 *
 * Suspending a whole account stays the operator's manual call (pnpm afs suspend).
 */

export const pausesApi = new Hono<SiteEnv>();

const ACCOUNT_ID = /^acct_[0-9a-z]{1,64}$/;

export const liftGraceMs = (env: Bindings) => {
  const h = Number(env.PAUSE_LIFT_GRACE_HOURS);
  return (env.PAUSE_LIFT_GRACE_HOURS && Number.isFinite(h) && h >= 0 ? h : DEFAULT_LIFT_GRACE_HOURS) * 3_600_000;
};

const pauseBody = z.object({
  account_id: z.string().max(80).optional(),
  capability: z.string().max(40),
  reason: z.string().min(1).max(500),
  paused_by: z.string().max(40).optional(),
  until: z.number().int().positive().nullable().optional(),
  details: z.unknown().optional(),
});

export const capabilityOf = (raw: unknown): Capability => {
  if (!isCapability(raw))
    throw new ApiError(400, "bad_request", "Unknown capability.", `One of: ${CAPABILITIES.join(", ")}.`, { capabilities: CAPABILITIES });
  return raw;
};

async function accountName(db: D1Database, accountId: string): Promise<{ name: string | null } | null> {
  return db.prepare("SELECT name FROM accounts WHERE id = ? AND purged_at IS NULL").bind(accountId).first<{ name: string | null }>();
}

/** Email a pause to the project's people (and the operator), then mark it notified. */
export async function notifyPause(
  env: Bindings,
  base: string,
  accountId: string,
  capability: Capability,
  wu?: (p: Promise<unknown>) => void,
) {
  const row = await env.DB.prepare(
    `SELECT p.capability, p.reason, p.paused_at, p.paused_by, p.until, p.details, p.notified_at, a.name
       FROM capability_pauses p LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.account_id = ? AND p.capability = ? AND p.lifted_at IS NULL`,
  )
    .bind(accountId, capability)
    .first<CapabilityPause & { details: string | null; notified_at: number | null; name: string | null }>();
  if (!row || row.notified_at !== null) return 0;
  // Claim the row first, so two runs never email the same pause twice (the outbox dedupes too).
  const claimed = await env.DB.prepare(
    "UPDATE capability_pauses SET notified_at = ? WHERE account_id = ? AND capability = ? AND notified_at IS NULL AND paused_at = ?",
  )
    .bind(Date.now(), accountId, capability, row.paused_at)
    .run();
  if (!claimed.meta.changes) return 0;
  const { details, notified_at: _, name, ...pause } = row;
  return emailCapabilityPaused(env, base, wu, { accountId, name, pause, details });
}

/** Pause a capability and email about it (the internal route and the operator's admin route). */
export async function pauseCapability(
  env: Bindings,
  base: string,
  input: { accountId: string; capability: Capability; reason: string; by: string; until?: number | null; details?: unknown },
  wu?: (p: Promise<unknown>) => void,
): Promise<PauseResult> {
  if (!(await accountName(env.DB, input.accountId)))
    throw new ApiError(404, "not_found", "Account not found.", "Pass the id of an existing account (acct_...).");
  const r = await recordCapabilityPause(env.DB, input, { graceMs: liftGraceMs(env) });
  console.log(
    JSON.stringify({
      event: "capability.pause",
      account: input.accountId,
      capability: input.capability,
      by: input.by,
      ...r,
      pause: undefined,
    }),
  );
  if (r.notify) {
    const work = notifyPause(env, base, input.accountId, input.capability, wu).catch((e) => console.error("pause email failed", e));
    if (wu) wu(work);
    else await work;
  }
  const { notify: _, ...out } = r;
  return out;
}

/** Lift a pause (the operator). Returns whether there was an active one. */
export async function liftCapability(
  env: Bindings,
  base: string,
  accountId: string,
  capability: Capability,
  wu?: (p: Promise<unknown>) => void,
) {
  const now = Date.now();
  const r = await env.DB.prepare(
    "UPDATE capability_pauses SET lifted_at = ?, lifted_by = 'operator' WHERE account_id = ? AND capability = ? AND lifted_at IS NULL",
  )
    .bind(now, accountId, capability)
    .run();
  forgetPauses(accountId);
  const lifted = (r.meta.changes ?? 0) > 0;
  if (lifted) {
    const name = (await accountName(env.DB, accountId))?.name ?? null;
    await emailCapabilityLifted(env, base, wu, { accountId, name, capability, at: now });
  }
  return lifted;
}

export interface PauseRow extends CapabilityPause {
  account_id: string;
  name?: string | null;
  details: string | null;
  notified_at: number | null;
  lifted_at: number | null;
  lifted_by: string | null;
}

/** Every pause of an account, lifted ones included (newest first). */
export async function accountPauses(db: D1Database, accountId: string): Promise<PauseRow[]> {
  const { results } = await db
    .prepare(
      "SELECT account_id, capability, reason, paused_at, paused_by, until, details, notified_at, lifted_at, lifted_by FROM capability_pauses WHERE account_id = ? ORDER BY paused_at DESC",
    )
    .bind(accountId)
    .all<PauseRow>();
  return results;
}

/** Pauses in force on the deployment (newest first, at most 200). */
export async function activePauses(db: D1Database, now = Date.now()): Promise<PauseRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.account_id, a.name, p.capability, p.reason, p.paused_at, p.paused_by, p.until, p.details, p.notified_at, p.lifted_at, p.lifted_by
         FROM capability_pauses p LEFT JOIN accounts a ON a.id = p.account_id
        WHERE p.lifted_at IS NULL AND (p.until IS NULL OR p.until > ?) ORDER BY p.paused_at DESC LIMIT 200`,
    )
    .bind(now)
    .all<PauseRow>();
  return results;
}

/** Hourly cron: email pauses nobody was told about yet (a service wrote them directly). */
export async function notifyPendingPauses(env: Bindings, base: string) {
  const { results } = await env.DB.prepare(
    "SELECT account_id, capability FROM capability_pauses WHERE notified_at IS NULL AND lifted_at IS NULL ORDER BY paused_at LIMIT 50",
  ).all<{ account_id: string; capability: string }>();
  let pauses = 0;
  for (const r of results) {
    if (!isCapability(r.capability)) continue;
    await notifyPause(env, base, r.account_id, r.capability);
    pauses++;
  }
  return { pauses };
}

// ---------- the internal route ----------

pausesApi.post("/v1/internal/pauses", async (c) => {
  const secret = c.env.INTERNAL_TOKEN;
  const presented = c.req.header("x-afs-internal");
  // Only the deployment's own Workers, over a service binding, with the shared secret.
  if (!secret || !presented || !viaServiceBinding(c.req.raw) || !timingSafeEqual(presented, secret))
    throw new ApiError(401, "unauthorized", "Internal route.", "Only the deployment's own services call this, over a service binding.");
  const body = await readJson(c, pauseBody);
  const accountId = body.account_id ?? c.req.header("x-afs-account") ?? "";
  if (!ACCOUNT_ID.test(accountId)) throw new ApiError(400, "bad_request", "Pass account_id (acct_...).", "In the body or x-afs-account.");
  const capability = capabilityOf(body.capability);
  const r = await pauseCapability(
    c.env,
    noticeBase(c.env) || new URL(c.req.url).origin,
    { accountId, capability, reason: body.reason, by: body.paused_by || "service", until: body.until ?? null, details: body.details },
    waitUntilOf(c),
  );
  return c.json(r);
});
