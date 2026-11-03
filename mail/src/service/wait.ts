import { ApiError, badRequest } from "@afs/shared";
import type { AppEnv } from "../env";
import { type InboxRow, type MessageRow, messageSummary, utcDay } from "./format";
import { getInboxRow } from "./inboxes";
import { maxInboundPerDay, maxMessagesPerInbox } from "./ingest";
import { likePattern } from "./messages";

/**
 * wait_for_email: return the newest inbound message that matches, received after `after`.
 *
 *   after    default: request time minus WAIT_GRACE_MS, so mail that landed in the seconds
 *            between submitting a signup form and calling wait still counts. Pass an explicit
 *            unix-ms timestamp (e.g. the received_at of the last message you handled, or the
 *            moment you clicked "send code") to exclude anything older; after=0 accepts any.
 *   timeout  seconds to block, default 30, max 120. On timeout: 408 { error: { code: "timeout" } }.
 *
 * Flow: check D1; if nothing matches, read the inbox Durable Object's notification version, check
 * D1 once more, then park on the DO with that version until email() notifies it or the timeout
 * passes; re-check D1; repeat. Reading the version before the last check means a message that
 * lands in between always wakes the waiter (see src/inbox-do.ts). No client polling.
 */

export const WAIT_GRACE_MS = 60_000;
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 120;

export interface WaitFilters {
  from?: string;
  subject?: string;
  contains?: string;
  /** unix ms, unix seconds, or an ISO date; default now - WAIT_GRACE_MS */
  after?: string | number;
  /** Only messages with an extracted code or verify/magic/reset link (latest-code). */
  requireCodeOrLink?: boolean;
}

export function parseAfter(after: string | number | undefined | null, now: number): number {
  if (after === undefined || after === null || after === "") return now - WAIT_GRACE_MS;
  const s = String(after).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e11 ? n * 1000 : n; // seconds -> ms
  }
  const t = Date.parse(s);
  if (Number.isNaN(t))
    throw badRequest("Invalid `after`.", "Pass unix milliseconds (e.g. a message's received_at), unix seconds, or an ISO 8601 date.");
  return t;
}

export function clampTimeout(t: number | undefined | null): number {
  if (t === undefined || t === null || Number.isNaN(t)) return DEFAULT_TIMEOUT_S;
  return Math.min(Math.max(t, 0), MAX_TIMEOUT_S);
}

async function findMatch(env: AppEnv, inboxId: string, after: number, f: WaitFilters): Promise<MessageRow | null> {
  const where = ["inbox_id = ?", "direction = 'in'", "received_at > ?"];
  const binds: unknown[] = [inboxId, after];
  if (f.from) {
    where.push("(from_address LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR envelope_from LIKE ? ESCAPE '\\')");
    const p = likePattern(f.from);
    binds.push(p, p, p);
  }
  if (f.subject) {
    where.push("subject LIKE ? ESCAPE '\\'");
    binds.push(likePattern(f.subject));
  }
  if (f.contains) {
    where.push("(subject LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\')");
    const p = likePattern(f.contains);
    binds.push(p, p);
  }
  if (f.requireCodeOrLink) where.push("(code IS NOT NULL OR verify_link IS NOT NULL)");
  return env.DB.prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY received_at DESC, seq DESC LIMIT 1`)
    .bind(...binds)
    .first<MessageRow>();
}

export interface WaitHooks {
  /** Tests only: runs after the last D1 check, just before parking on the Durable Object. */
  beforePark?: () => Promise<void>;
}

export async function waitForEmail(
  env: AppEnv,
  accountId: string,
  inboxId: string,
  filters: WaitFilters,
  timeoutS?: number,
  hooks: WaitHooks = {},
) {
  const started = Date.now();
  const inbox = await getInboxRow(env, accountId, inboxId);
  const after = parseAfter(filters.after, started);
  const timeout = clampTimeout(timeoutS);
  const deadline = started + timeout * 1000;
  const stub = env.INBOX.get(env.INBOX.idFromName(inbox.id));
  const found = (m: MessageRow) => ({ message: messageSummary(m), row: m, waited_ms: Date.now() - started, after });

  const first = await findMatch(env, inbox.id, after, filters);
  if (first) return found(first);
  // Version first, then the final check: mail committed after this read bumps the version.
  let version = await stub.version();
  for (;;) {
    const match = await findMatch(env, inbox.id, after, filters);
    if (match) return found(match);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await hooks.beforePark?.();
    const r = await stub.wait(version, remaining);
    version = r.version;
    if (!r.woken) {
      const last = await findMatch(env, inbox.id, after, filters);
      if (last) return found(last);
      break;
    }
  }

  const limits = await limitNote(env, inbox);
  const desc = [
    filters.from && `from~"${filters.from}"`,
    filters.subject && `subject~"${filters.subject}"`,
    filters.contains && `contains~"${filters.contains}"`,
  ]
    .filter(Boolean)
    .join(", ");
  throw new ApiError(
    408,
    "timeout",
    `No ${filters.requireCodeOrLink ? "message with a code or verification link" : "matching message"} arrived at ${inbox.address} within ${timeout}s.`,
    `Nothing ${desc ? `matching ${desc} ` : ""}received after ${new Date(after).toISOString()}. Check the site was given exactly ${inbox.address}, loosen the filters, or call again (pass after=${after} so nothing that lands in between is missed). GET /v1/inboxes/${inbox.id}/messages shows what did arrive.${limits}`,
    {
      inbox_id: inbox.id,
      address: inbox.address,
      after,
      timeout_s: timeout,
      filters: { from: filters.from ?? null, subject: filters.subject ?? null, contains: filters.contains ?? null },
    },
  );
}

/** On timeout: say so if new mail is being refused because a storage limit is reached. */
async function limitNote(env: AppEnv, inbox: InboxRow): Promise<string> {
  const perInbox = maxMessagesPerInbox(env);
  if (perInbox && (inbox.inbound_count ?? 0) >= perInbox) {
    return ` NOTE: this inbox is full (${perInbox} messages, the most allowed here), so new mail to it is rejected. Delete messages you no longer need (DELETE /v1/messages/:id) or use another inbox.`;
  }
  const perDay = maxInboundPerDay(env);
  if (perDay) {
    const r = await env.DB.prepare("SELECT count FROM inbound_counters WHERE account_id = ? AND day = ?")
      .bind(inbox.account_id, utcDay(Date.now()))
      .first<{ count: number }>();
    if ((r?.count ?? 0) >= perDay)
      return ` NOTE: this account has received its maximum of ${perDay} messages today (UTC), so new mail is rejected until 00:00 UTC.`;
  }
  return "";
}

export async function latestCode(env: AppEnv, accountId: string, inboxId: string, filters: WaitFilters, timeoutS?: number) {
  const r = await waitForEmail(env, accountId, inboxId, { ...filters, requireCodeOrLink: true }, timeoutS);
  const m = r.message;
  return {
    code: m.code,
    codes: m.codes,
    link: m.verify_link,
    link_kind: m.verify_link_kind,
    message_id: m.id,
    from: m.from.address,
    subject: m.subject,
    received_at: m.received_at,
    auth_verdict: m.auth_verdict,
    waited_ms: r.waited_ms,
  };
}
