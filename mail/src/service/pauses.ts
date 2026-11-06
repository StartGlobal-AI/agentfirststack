import {
  type CapabilityPause,
  type PauseResult,
  assertCapability,
  capFor,
  capabilityPaused,
  capabilityPausedError,
  requestCapabilityPause,
} from "@afs/shared";
import { type AppEnv, type Standing, cap, standingOf } from "../env";

/**
 * Automatic capability pauses (the contract is in @afs/shared pauses.ts): on a strong abuse signal
 * one capability of the account stops, the project's people and the operator are emailed (by the
 * site), and only the operator lifts it (`pnpm afs unpause`). Everything else keeps working.
 *
 *   mail.send          Sends that go out through Email Service (any recipient outside the account's
 *                      own inboxes) answer 403 capability_paused; sends to the account's own inboxes
 *                      still work (they never leave the Worker). Paused when the external recipients
 *                      the account sent to in the last hour bounced or complained above
 *                      SEND_PAUSE_BOUNCE_PERCENT / SEND_PAUSE_COMPLAINT_PERCENT, once there are at
 *                      least SEND_PAUSE_MIN_SENDS of them. Checked on each bounce/complaint event from
 *                      the Email Sending event subscription (src/service/delivery.ts). Forwards to the
 *                      project's members are not affected (they go to its own people).
 *   mail.inbox_create  New inboxes answer 403 capability_paused (creating an address the account
 *                      already owns still returns it, rule 7). Paused when the account tries to
 *                      create more than INBOX_CREATE_BURST_PER_HOUR new inboxes in one UTC hour,
 *                      counting the attempts the daily cap or the inbox cap refused and addresses that
 *                      are taken: far above what any project does (default 3 x MAX_INBOX_CREATES_PER_DAY).
 *
 * Every var also reads UNCLAIMED_<name>; unset or "0" = that signal is off.
 */

export const SEND_HEALTH_WINDOW_MS = 3_600_000;
export const DEFAULT_SEND_PAUSE_MIN_SENDS = 10;
/** Default burst limit: this many times the daily inbox-creation cap, within one hour. */
export const INBOX_BURST_FACTOR = 3;

const MAIL_CAPABILITIES = ["mail.send", "mail.inbox_create"] as const;

/** A percent threshold by standing; unset, "0" or not a number = off (Infinity). Fractions are kept ("0.5"). */
function percentVar(env: AppEnv, standing: Standing, name: "SEND_PAUSE_BOUNCE_PERCENT" | "SEND_PAUSE_COMPLAINT_PERCENT"): number {
  const n = capFor(env as unknown as Record<string, unknown>, standing, name, 0);
  return n > 0 ? n : Number.POSITIVE_INFINITY;
}

export interface SendPauseThresholds {
  bounce_percent: number;
  complaint_percent: number;
  min_sends: number;
}

export function sendPauseThresholds(env: AppEnv, standing: Standing): SendPauseThresholds {
  return {
    bounce_percent: percentVar(env, standing, "SEND_PAUSE_BOUNCE_PERCENT"),
    complaint_percent: percentVar(env, standing, "SEND_PAUSE_COMPLAINT_PERCENT"),
    min_sends: Math.max(1, cap(env, standing, "SEND_PAUSE_MIN_SENDS", DEFAULT_SEND_PAUSE_MIN_SENDS)),
  };
}

export interface SendHealth {
  /** External recipients of the account's sends in the window. */
  sent: number;
  bounced: number;
  complained: number;
}

/** External recipients the account sent to since `since`, and how many bounced or complained. */
export async function sendHealth(env: AppEnv, accountId: string, since: number): Promise<SendHealth> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS sent, COALESCE(SUM(d.status = 'bounced'), 0) AS bounced, COALESCE(SUM(d.status = 'complained'), 0) AS complained
     FROM messages m JOIN deliveries d ON d.message_id = m.id
     WHERE m.account_id = ? AND m.direction = 'out' AND m.received_at > ? AND d.internal = 0`,
  )
    .bind(accountId, since)
    .first<SendHealth>();
  return { sent: r?.sent ?? 0, bounced: r?.bounced ?? 0, complained: r?.complained ?? 0 };
}

const pct = (n: number, of: number) => Math.round((n * 1000) / Math.max(1, of)) / 10;

/** Why sending should be paused, in words a person reads; null = it should not. Pure. */
export function sendPauseReason(h: SendHealth, t: SendPauseThresholds): string | null {
  if (h.sent < t.min_sends) return null;
  const over = (n: number, limit: number) => n * 100 > limit * h.sent;
  if (over(h.complained, t.complaint_percent))
    return `${h.complained} of the ${h.sent} recipients this project emailed in the last hour reported it as spam (${pct(h.complained, h.sent)}%, above the ${t.complaint_percent}% limit)`;
  if (over(h.bounced, t.bounce_percent))
    return `${h.bounced} of the ${h.sent} recipients this project emailed in the last hour bounced (${pct(h.bounced, h.sent)}%, above the ${t.bounce_percent}% limit)`;
  return null;
}

const finite = (n: number) => (Number.isFinite(n) ? n : null);

/**
 * After a bounce or complaint event: pause mail.send when the last hour's rates are over the
 * thresholds. `at` is the event's time (the window is the hour before it, up to now). Never throws.
 */
export async function checkSendHealth(env: AppEnv, accountId: string, at = Date.now()): Promise<PauseResult | null> {
  try {
    const standing = await standingOf(env, accountId);
    const t = sendPauseThresholds(env, standing);
    if (!Number.isFinite(t.bounce_percent) && !Number.isFinite(t.complaint_percent)) return null;
    if (await capabilityPaused(env, accountId, "mail.send")) return null;
    const h = await sendHealth(env, accountId, Math.min(at, Date.now()) - SEND_HEALTH_WINDOW_MS);
    const reason = sendPauseReason(h, t);
    if (!reason) return null;
    const r = await requestCapabilityPause(env, {
      accountId,
      capability: "mail.send",
      reason,
      by: "mail",
      details: {
        window_s: SEND_HEALTH_WINDOW_MS / 1000,
        ...h,
        bounce_percent_limit: finite(t.bounce_percent),
        complaint_percent_limit: finite(t.complaint_percent),
        min_sends: t.min_sends,
      },
    });
    console.log(JSON.stringify({ event: "mail.send_pause", account_id: accountId, ...h, paused: r.paused, skipped: r.skipped ?? null }));
    return r;
  } catch (e) {
    console.error("send health check failed", e);
    return null;
  }
}

/** Throws 403 capability_paused while mail.send is paused for the account. */
export const assertSendNotPaused = (env: AppEnv, accountId: string) => assertCapability(env, accountId, "mail.send");

/** INBOX_CREATE_BURST_PER_HOUR for this standing; unset = 3 x MAX_INBOX_CREATES_PER_DAY when that is set; Infinity = off. */
export function inboxCreateBurstLimit(env: AppEnv, standing: Standing): number {
  const n = cap(env, standing, "INBOX_CREATE_BURST_PER_HOUR", -1);
  if (n === 0) return Number.POSITIVE_INFINITY;
  if (n > 0) return n;
  const daily = cap(env, standing, "MAX_INBOX_CREATES_PER_DAY");
  return Number.isFinite(daily) && daily > 0 ? INBOX_BURST_FACTOR * daily : Number.POSITIVE_INFINITY;
}

/** The UTC hour of `ms`, "2026-11-06T10": the key of the hourly attempt counter (account_daily.day). Pure. */
export const utcHour = (ms: number) => new Date(ms).toISOString().slice(0, 13);

/**
 * Before creating a new inbox (returning one the account already owns is not a creation): refuses
 * while mail.inbox_create is paused, counts the attempt in this UTC hour (attempts the caps refuse
 * count too), and pauses the capability the moment the count passes the burst limit.
 */
export async function inboxCreateAttempt(env: AppEnv, accountId: string, standing: Standing, now = Date.now()): Promise<void> {
  await assertCapability(env, accountId, "mail.inbox_create");
  const limit = inboxCreateBurstLimit(env, standing);
  if (!Number.isFinite(limit)) return;
  const hour = utcHour(now);
  const row = await env.DB.prepare(
    `INSERT INTO account_daily (account_id, kind, day, count) VALUES (?, 'inbox_create_try', ?, 1)
     ON CONFLICT(account_id, kind, day) DO UPDATE SET count = account_daily.count + 1 RETURNING count`,
  )
    .bind(accountId, hour)
    .first<{ count: number }>();
  const n = row?.count ?? 0;
  if (n !== limit + 1) return; // asked once per hour; a pause already in force was refused above
  const r = await requestCapabilityPause(env, {
    accountId,
    capability: "mail.inbox_create",
    reason: `it tried to create ${n} inboxes within one hour, more than the ${limit} an hour allowed here`,
    by: "mail",
    details: { attempts_this_hour: n, burst_limit: limit, hour, daily_limit: finite(cap(env, standing, "MAX_INBOX_CREATES_PER_DAY")) },
  });
  console.log(
    JSON.stringify({ event: "mail.inbox_create_pause", account_id: accountId, attempts: n, paused: r.paused, skipped: r.skipped ?? null }),
  );
  if (r.paused && r.pause) throw capabilityPausedError(r.pause);
}

/** GET /v1/usage: the account's mail capabilities that are paused now. */
export async function activePauses(env: AppEnv, accountId: string): Promise<CapabilityPause[]> {
  const found = await Promise.all(MAIL_CAPABILITIES.map((c) => capabilityPaused(env, accountId, c)));
  return found.filter((p): p is CapabilityPause => !!p);
}

/** GET /v1/usage: the last hour's outbound health next to the thresholds that pause sending. */
export async function sendHealthJson(env: AppEnv, accountId: string, standing: Standing, now = Date.now()) {
  const t = sendPauseThresholds(env, standing);
  const on = Number.isFinite(t.bounce_percent) || Number.isFinite(t.complaint_percent);
  const h = await sendHealth(env, accountId, now - SEND_HEALTH_WINDOW_MS);
  return {
    window_s: SEND_HEALTH_WINDOW_MS / 1000,
    ...h,
    bounce_percent: pct(h.bounced, h.sent),
    complaint_percent: pct(h.complained, h.sent),
    auto_pause: on
      ? { bounce_percent_above: finite(t.bounce_percent), complaint_percent_above: finite(t.complaint_percent), min_sends: t.min_sends }
      : null,
  };
}

/**
 * GET /v1/admin/delivery-health: outbound bounce and complaint rates across the deployment (the
 * operator digest reads it over the service binding). Recipients whose delivery row changed in the
 * window (a send, or its outcome); accounts with bounces or complaints listed, worst first.
 */
export async function deliveryHealth(env: AppEnv, hours: number, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT account_id, COUNT(*) AS sent, COALESCE(SUM(status = 'bounced'), 0) AS bounced, COALESCE(SUM(status = 'complained'), 0) AS complained
     FROM deliveries WHERE internal = 0 AND updated_at > ? GROUP BY account_id`,
  )
    .bind(now - hours * 3_600_000)
    .all<SendHealth & { account_id: string }>();
  const total = results.reduce(
    (a, r) => ({ sent: a.sent + r.sent, bounced: a.bounced + r.bounced, complained: a.complained + r.complained }),
    {
      sent: 0,
      bounced: 0,
      complained: 0,
    },
  );
  const accounts = results
    .filter((r) => r.bounced + r.complained > 0)
    .sort((a, b) => b.complained - a.complained || b.bounced / b.sent - a.bounced / a.sent)
    .slice(0, 50)
    .map((r) => ({ ...r, bounce_percent: pct(r.bounced, r.sent), complaint_percent: pct(r.complained, r.sent) }));
  return {
    hours,
    tracking: !!env.DELIVERY_EVENTS_QUEUE,
    ...total,
    bounce_percent: pct(total.bounced, total.sent),
    complaint_percent: pct(total.complained, total.sent),
    accounts,
  };
}
