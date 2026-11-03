import { ApiError, badRequest, newId } from "@afs/shared";
import { type AppEnv, type Standing, cap, standingOf } from "../env";
import { normalizeDomain, splitAddress } from "../lib/address";
import { parkOnInbox } from "../lib/park";
import { assertActive, rateLimit } from "./budgets";
import { type InboxRow, type MessageRow, messageSummary, utcDay } from "./format";
import { getInboxRow } from "./inboxes";
import { maxInboundPerDay } from "./ingest";

/**
 * wait_for_email: return the newest inbound message that matches, received after `after`.
 *
 *   after    default: request time minus WAIT_GRACE_MS, so mail that landed in the seconds
 *            between submitting a signup form and calling wait still counts. Pass an explicit
 *            unix-ms timestamp (e.g. the received_at of the last message you handled, or the
 *            moment you clicked "send code") to exclude anything older; after=0 accepts any.
 *   timeout  seconds to block, default 30, max 120. On timeout: 408 { error: { code: "timeout" } }.
 *
 * Flow: check D1; if nothing matches, take a concurrency slot (MAX_CONCURRENT_WAITS per account,
 * MAX_CONCURRENT_WAITS_PER_INBOX per inbox; 429 too_many_waits beyond), read the inbox Durable
 * Object's notification version, check D1 once more, then park on the DO with that version until
 * email() notifies it or the timeout passes; re-check D1; repeat. Reading the version before the
 * last check means a message that lands in between always wakes the waiter (see src/inbox-do.ts).
 * Parking is a hibernatable WebSocket to the DO, so a waiting inbox costs no DO duration.
 */

export const WAIT_GRACE_MS = 60_000;
export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 120;
export const DEFAULT_MAX_CONCURRENT_WAITS = 3;
export const DEFAULT_MAX_CONCURRENT_WAITS_PER_INBOX = 2;
/** A slot outlives its wait's deadline by this much, in case the Worker never released it. */
const SLOT_MARGIN_MS = 15_000;
/** Bound for "no cap" in SQL (Infinity cannot be bound). */
const NO_CAP = 1_000_000_000;

export interface WaitFilters {
  /** Loose filter (wait): case-insensitive substring of the sender address, name or envelope sender. */
  from?: string;
  subject?: string;
  contains?: string;
  /** unix ms, unix seconds, or an ISO date; default now - WAIT_GRACE_MS */
  after?: string | number;
  /** Only messages with an extracted code or verify/magic/reset link (latest-code). */
  requireCodeOrLink?: boolean;
  /** Strict sender (latest-code): the From address equals it, or the From domain is it or a subdomain. */
  sender?: SenderFilter;
  /** Only mail whose From domain is authenticated (auth.verdict "pass"). */
  requireAuth?: boolean;
}

export type SenderFilter = { address: string } | { domain: string };

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

/**
 * latest-code's `from`: a domain (mail from it or its subdomains) or a full address. Pure.
 * A display name or a bare word is refused: "github" would match "github.com.evil.example".
 */
export function parseSenderFilter(from: string): SenderFilter {
  const s = from.trim().toLowerCase().replace(/^@/, "");
  if (s.includes("@")) {
    const parts = splitAddress(s);
    if (parts) return { address: `${parts.local}@${parts.domain}` };
  } else {
    const d = normalizeDomain(s);
    if (d) return { domain: d };
  }
  throw badRequest(
    `latest-code matches the sender exactly, and "${from}" is neither a domain nor an address.`,
    "Pass from=<domain> (e.g. from=github.com; its subdomains match too) or a full address (from=noreply@github.com). For a loose substring match on the sender's name or address, use GET /v1/inboxes/:id/wait?from=...",
  );
}

/** The SQL condition and binds for a strict sender filter (pure). */
export function senderCondition(f: SenderFilter): { sql: string; binds: unknown[] } {
  if ("address" in f) return { sql: "from_address = ?", binds: [f.address] };
  const dotted = `.${f.domain}`;
  // ".<From domain>" ends with ".<domain>": equal or a subdomain, never "github.com.evil" or "evilgithub.com".
  return { sql: "substr('.' || substr(from_address, instr(from_address, '@') + 1), -?) = ?", binds: [dotted.length, dotted] };
}

async function findMatch(env: AppEnv, inboxId: string, after: number, f: WaitFilters): Promise<MessageRow | null> {
  const where = ["inbox_id = ?", "direction = 'in'", "received_at > ?"];
  const binds: unknown[] = [inboxId, after];
  // instr(), not LIKE: D1 refuses LIKE patterns over 50 bytes, and filters may be up to 500 characters.
  if (f.from) {
    where.push("(instr(lower(from_address), ?) > 0 OR instr(lower(from_name), ?) > 0 OR instr(lower(envelope_from), ?) > 0)");
    const p = f.from.toLowerCase();
    binds.push(p, p, p);
  }
  if (f.subject) {
    where.push("instr(lower(subject), ?) > 0");
    binds.push(f.subject.toLowerCase());
  }
  if (f.contains) {
    where.push("(instr(lower(subject), ?) > 0 OR instr(lower(text_body), ?) > 0)");
    const p = f.contains.toLowerCase();
    binds.push(p, p);
  }
  if (f.sender) {
    const c = senderCondition(f.sender);
    where.push(c.sql);
    binds.push(...c.binds);
  }
  if (f.requireAuth) where.push("json_extract(auth_json, '$.verdict') = 'pass'");
  if (f.requireCodeOrLink) where.push("(code IS NOT NULL OR verify_link IS NOT NULL)");
  return env.DB.prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY received_at DESC, seq DESC LIMIT 1`)
    .bind(...binds)
    .first<MessageRow>();
}

/** Take a concurrent-wait slot, or throw 429 too_many_waits. null = no caps apply. */
async function acquireWaitSlot(env: AppEnv, standing: Standing, inbox: InboxRow, deadline: number): Promise<string | null> {
  const perAccount = cap(env, standing, "MAX_CONCURRENT_WAITS", DEFAULT_MAX_CONCURRENT_WAITS);
  const perInbox = cap(env, standing, "MAX_CONCURRENT_WAITS_PER_INBOX", DEFAULT_MAX_CONCURRENT_WAITS_PER_INBOX);
  if (!Number.isFinite(perAccount) && !Number.isFinite(perInbox)) return null;
  const bound = (n: number) => (Number.isFinite(n) ? n : NO_CAP);
  const id = newId("wait");
  const now = Date.now();
  const r = await env.DB.prepare(
    `INSERT INTO active_waits (id, account_id, inbox_id, expires_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM active_waits WHERE account_id = ?2 AND expires_at > ?5) < ?6
       AND (SELECT COUNT(*) FROM active_waits WHERE inbox_id = ?3 AND expires_at > ?5) < ?7`,
  )
    .bind(id, inbox.account_id, inbox.id, deadline + SLOT_MARGIN_MS, now, bound(perAccount), bound(perInbox))
    .run();
  if (r.meta.changes) return id;
  const c = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM active_waits WHERE account_id = ?1 AND expires_at > ?3) AS account, (SELECT COUNT(*) FROM active_waits WHERE inbox_id = ?2 AND expires_at > ?3) AS inbox",
  )
    .bind(inbox.account_id, inbox.id, now)
    .first<{ account: number; inbox: number }>();
  const inboxFull = (c?.inbox ?? 0) >= perInbox;
  throw new ApiError(
    429,
    "too_many_waits",
    inboxFull
      ? `${inbox.address} already has ${c?.inbox ?? perInbox} waits in progress, the most allowed per inbox (${perInbox}).`
      : `This account already has ${c?.account ?? perAccount} waits in progress, the most allowed at once (${perAccount}).`,
    "Let a wait return before starting another, or wait on fewer inboxes: one wait (with from/subject filters) returns the newest match, and a webhook (POST /v1/webhooks) reports every message without holding a request open. timeout=0 checks without waiting and never counts.",
    {
      limit_per_account: perAccount,
      limit_per_inbox: perInbox,
      in_progress_account: c?.account ?? null,
      in_progress_inbox: c?.inbox ?? null,
    },
  );
}

async function releaseWaitSlot(env: AppEnv, id: string) {
  try {
    await env.DB.prepare("DELETE FROM active_waits WHERE id = ?").bind(id).run();
  } catch (e) {
    console.error("wait slot release failed (it expires on its own)", e);
  }
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
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  await rateLimit(
    env.WAIT_LIMITER,
    `wait:${accountId}`,
    "wait",
    "Waits are limited per account per minute. Use one wait with a longer timeout (up to 120 s) instead of many short ones, or a webhook (POST /v1/webhooks) to be told when mail lands. Retry in a minute.",
  );
  const inbox = await getInboxRow(env, accountId, inboxId);
  const after = parseAfter(filters.after, started);
  const timeout = clampTimeout(timeoutS);
  const deadline = started + timeout * 1000;
  const stub = env.INBOX.get(env.INBOX.idFromName(inbox.id));
  const found = (m: MessageRow) => ({ message: messageSummary(m), row: m, waited_ms: Date.now() - started, after });

  const first = await findMatch(env, inbox.id, after, filters);
  if (first) return found(first);
  if (deadline > Date.now()) {
    const slot = await acquireWaitSlot(env, standing, inbox, deadline);
    try {
      // Version first, then the final check: mail committed after this read bumps the version.
      let version = await stub.version();
      for (;;) {
        const match = await findMatch(env, inbox.id, after, filters);
        if (match) return found(match);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await hooks.beforePark?.();
        const r = await parkOnInbox(stub, version, remaining);
        if (!r.woken) {
          const last = await findMatch(env, inbox.id, after, filters);
          if (last) return found(last);
          break;
        }
        // Closed without news (object restarted): re-check, but never spin.
        if (r.version === version) await new Promise((res) => setTimeout(res, Math.min(250, Math.max(0, deadline - Date.now()))));
        version = r.version;
      }
    } finally {
      if (slot) await releaseWaitSlot(env, slot);
    }
  }

  const limits = await limitNote(env, standing, inbox);
  const unauth = filters.requireAuth ? await unauthenticatedNote(env, inbox, after, filters) : "";
  const desc = [
    filters.from && `from~"${filters.from}"`,
    filters.sender && ("address" in filters.sender ? `from=${filters.sender.address}` : `from domain ${filters.sender.domain}`),
    filters.subject && `subject~"${filters.subject}"`,
    filters.contains && `contains~"${filters.contains}"`,
    filters.requireAuth && "authenticated sender",
  ]
    .filter(Boolean)
    .join(", ");
  throw new ApiError(
    408,
    "timeout",
    `No ${filters.requireCodeOrLink ? "message with a code or verification link" : "matching message"} arrived at ${inbox.address} within ${timeout}s.`,
    `Nothing ${desc ? `matching ${desc} ` : ""}received after ${new Date(after).toISOString()}. Check the site was given exactly ${inbox.address}, loosen the filters, or call again (pass after=${after} so nothing that lands in between is missed). GET /v1/inboxes/${inbox.id}/messages shows what did arrive.${unauth}${limits}`,
    {
      inbox_id: inbox.id,
      address: inbox.address,
      after,
      timeout_s: timeout,
      filters: { from: filters.from ?? null, subject: filters.subject ?? null, contains: filters.contains ?? null },
      ...(filters.sender ? { sender: filters.sender } : {}),
      ...(filters.requireAuth !== undefined ? { require_auth: filters.requireAuth } : {}),
    },
  );
}

/** On timeout: say so if new mail is being refused because the account's daily limit is reached. */
async function limitNote(env: AppEnv, standing: Standing, inbox: InboxRow): Promise<string> {
  const perDay = maxInboundPerDay(env, standing);
  if (Number.isFinite(perDay)) {
    const r = await env.DB.prepare("SELECT count FROM inbound_counters WHERE account_id = ? AND day = ?")
      .bind(inbox.account_id, utcDay(Date.now()))
      .first<{ count: number }>();
    if ((r?.count ?? 0) >= perDay)
      return ` NOTE: this account has received its maximum of ${perDay} messages today (UTC), so new mail is rejected until 00:00 UTC.`;
  }
  return "";
}

/** latest-code timeout: a match that only failed the authentication requirement is worth naming. */
async function unauthenticatedNote(env: AppEnv, inbox: InboxRow, after: number, filters: WaitFilters): Promise<string> {
  const m = await findMatch(env, inbox.id, after, { ...filters, requireAuth: false });
  if (!m) return "";
  const verdict = messageSummary(m).auth_verdict ?? "unknown";
  return ` NOTE: ${m.id} from ${m.from_address} does match, but its sender is not authenticated (auth_verdict "${verdict}"), so latest-code skipped it: its code could be forged. Check it with GET /v1/messages/${m.id} (auth) and pass allow_unauthenticated=true only if you trust it.`;
}

export interface LatestCodeFilters {
  from?: string;
  subject?: string;
  contains?: string;
  after?: string | number;
  /** Opt out of the default: accept mail whose sender is not authenticated (auth_verdict != "pass"). */
  allow_unauthenticated?: boolean;
}

export async function latestCode(env: AppEnv, accountId: string, inboxId: string, filters: LatestCodeFilters, timeoutS?: number) {
  const { from, allow_unauthenticated, ...rest } = filters;
  const sender = from ? parseSenderFilter(from) : undefined;
  const requireAuth = !allow_unauthenticated;
  const r = await waitForEmail(env, accountId, inboxId, { ...rest, sender, requireAuth, requireCodeOrLink: true }, timeoutS);
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
    auth_required: requireAuth,
    waited_ms: r.waited_ms,
  };
}
