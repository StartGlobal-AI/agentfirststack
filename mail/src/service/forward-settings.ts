import { identityDb, isSchemaError } from "@afs/shared";
import { type AppEnv, type Standing, cap, isDevMode, standingOf } from "../env";
import { DEFAULT_DIGEST_HOUR, DEFAULT_TIMEZONE, type ForwardMode, type ForwardSetting } from "../lib/forwarding";
import { type ForwardContext, type InboxRow, utcDay } from "./format";

/**
 * The forward setting's storage and the account-wide numbers inbox JSON shows. Kept apart from
 * src/service/forward.ts (which sends, through send.ts) so inboxes.ts can use it without an import
 * cycle.
 */

/** MAX_FORWARDS_PER_ACCOUNT_PER_DAY default: recipients of forwards and digests per account per UTC day. */
export const DEFAULT_MAX_FORWARDS_PER_DAY = 100;
/** Members a forward goes to at most (one email each). */
export const MAX_FORWARD_RECIPIENTS = 20;

/** "0" = forwarding off (none allowed), as for every cap; unset = the default. */
export const maxForwardsPerDay = (env: AppEnv, standing: Standing) =>
  cap(env, standing, "MAX_FORWARDS_PER_ACCOUNT_PER_DAY", DEFAULT_MAX_FORWARDS_PER_DAY);

export function settingOf(row: InboxRow): ForwardSetting {
  const m = row.forward_mode;
  return {
    mode: m === "each" || m === "digest" ? (m as ForwardMode) : "off",
    digest_hour: row.forward_digest_hour ?? DEFAULT_DIGEST_HOUR,
    timezone: row.forward_timezone || DEFAULT_TIMEZONE,
  };
}

export interface Members {
  /** Verified emails, lowercased, at most MAX_FORWARD_RECIPIENTS. */
  emails: string[];
  /** When the first of them joined (claimed the project), unix ms; null = nobody. */
  claimedAt: number | null;
}

const NO_MEMBERS: Members = { emails: [], claimedAt: null };
const plainEmail = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/**
 * The people who claimed these accounts (identity DB memberships + users), as memberEmails in
 * send.ts reads them: Google-verified emails only (DEV_MODE sign-ins count only on a DEV_MODE
 * deployment). One query for many accounts (the cron). A deployment without the people tables has
 * no members.
 */
export async function forwardRecipientsMany(env: AppEnv, accountIds: string[]): Promise<Map<string, Members>> {
  const out = new Map<string, Members>();
  const ids = [...new Set(accountIds)];
  if (!ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { results } = await identityDb(env)
        .prepare(
          `SELECT m.account_id AS account_id, lower(u.email) AS email, u.google_sub AS sub, m.created_at AS at
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.account_id IN (SELECT value FROM json_each(?)) ORDER BY m.created_at`,
        )
        .bind(JSON.stringify(ids.slice(i, i + 200)))
        .all<{ account_id: string; email: string; sub: string; at: number }>();
      for (const r of results) {
        if (!r.email || !plainEmail.test(r.email) || (!isDevMode(env) && String(r.sub).startsWith("dev:"))) continue;
        const m = out.get(r.account_id) ?? { emails: [], claimedAt: null };
        if (!m.emails.includes(r.email) && m.emails.length < MAX_FORWARD_RECIPIENTS) m.emails.push(r.email);
        m.claimedAt = m.claimedAt === null ? r.at : Math.min(m.claimedAt, r.at);
        out.set(r.account_id, m);
      }
    }
  } catch (e) {
    if (isSchemaError(e)) return out;
    throw e;
  }
  return out;
}

export async function forwardRecipients(env: AppEnv, accountId: string): Promise<Members> {
  return (await forwardRecipientsMany(env, [accountId])).get(accountId) ?? NO_MEMBERS;
}

/** Recipients forwarded to today (UTC), across the account. */
export async function forwardsUsedToday(env: AppEnv, accountId: string, now = Date.now()): Promise<number> {
  const row = await env.DB.prepare("SELECT count FROM account_daily WHERE account_id = ? AND kind = 'forward' AND day = ?")
    .bind(accountId, utcDay(now))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** The account-wide part of every inbox's `forward` JSON (one identity read, one D1 read). */
export async function forwardContext(env: AppEnv, accountId: string, now = Date.now()): Promise<ForwardContext> {
  const [members, standing, used] = await Promise.all([
    forwardRecipients(env, accountId),
    standingOf(env, accountId),
    forwardsUsedToday(env, accountId, now),
  ]);
  const limit = maxForwardsPerDay(env, standing);
  return { recipients: members.emails.length, forwarded_today: used, daily_limit: Number.isFinite(limit) ? limit : null };
}

/** next_steps that go with a forward setting: who it reaches, and what is still missing. */
export function forwardNextSteps(setting: ForwardSetting, ctx: ForwardContext, inboxId: string): string[] {
  if (setting.mode === "off") return [];
  const steps: string[] = [];
  if (ctx.recipients === 0)
    steps.push(
      "Nobody has claimed this project yet, so there is nobody to forward to (forward.waiting_for_owner: true). POST /v1/claim-link on the platform site gives your person a link to claim it; mail that arrives until then is sent to them as one catch-up digest once they have.",
    );
  else
    steps.push(
      setting.mode === "each"
        ? `Each email that may be forwarded goes to the project's ${ctx.recipients} member(s) as it arrives.`
        : `A digest goes to the project's ${ctx.recipients} member(s) at ${String(setting.digest_hour).padStart(2, "0")}:00 ${setting.timezone} on days with new mail.`,
    );
  if (ctx.daily_limit === 0)
    steps.push("Forwarding is turned off on this deployment (MAX_FORWARDS_PER_ACCOUNT_PER_DAY is 0), so nothing is sent.");
  steps.push(
    `GET /v1/inboxes/${inboxId} shows forward.last_forwarded_at / last_digest_at; PATCH it with {"forward":{"mode":"off"}} to stop.`,
  );
  return steps;
}
