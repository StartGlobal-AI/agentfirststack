import { ApiError, badRequest, newId } from "@afs/shared";
import { type AppEnv, type Standing, cap, standingOf } from "../env";
import { normalizeDomain, splitAddress } from "../lib/address";
import { parkOnInbox } from "../lib/park";
import { registrableDomain } from "../lib/sender";
import { assertActive, maxBlobBytes, rateLimit } from "./budgets";
import { type InboxRow, type MessageRow, messageSummary, replyTextOf, utcDay } from "./format";
import { getInboxRow } from "./inboxes";
import { NEAR_FULL, SMALL_MESSAGE_BYTES, formatBytes, maxInboundPerDay } from "./ingest";

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
  /** Only mail to this plus-address tag (`me+github@` -> "github"), exact. */
  tag?: string;
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

/** The WHERE clause (and binds) of a wait's filters. */
function matchWhere(inboxId: string, after: number, f: WaitFilters): { where: string[]; binds: unknown[] } {
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
  if (f.tag) {
    where.push("tag = ?");
    binds.push(f.tag.toLowerCase());
  }
  if (f.requireAuth) where.push("json_extract(auth_json, '$.verdict') = 'pass'");
  if (f.requireCodeOrLink) where.push("(code IS NOT NULL OR verify_link IS NOT NULL)");
  return { where, binds };
}

async function findMatch(env: AppEnv, inboxId: string, after: number, f: WaitFilters): Promise<MessageRow | null> {
  const { where, binds } = matchWhere(inboxId, after, f);
  return env.DB.prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY received_at DESC, seq DESC LIMIT 1`)
    .bind(...binds)
    .first<MessageRow>();
}

/** The domain latest-code reports and groups senders by: the registrable domain of the From address ("github.com" for noreply@mail.github.com). Pure. */
export function senderDomainOf(address: string | null | undefined): string | null {
  const a = (address ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at > 0 && at < a.length - 1 ? registrableDomain(a.slice(at + 1)) : null;
}

/** One sender domain that sent matching code mail in a latest-code window (its newest message). */
export interface CodeSender {
  sender_domain: string | null;
  from: string | null;
  message_id: string;
  received_at: number;
  auth_verdict: string | null;
  messages: number;
}

/** How many recent matches the ambiguity check reads, and how many sender domains it reports. */
const SENDER_SCAN = 50;
const SENDER_REPORT = 10;

/** Group matches (newest first) by sender domain, keeping each domain's newest. Pure. */
export function groupBySenderDomain(
  rows: { id: string; from_address: string | null; received_at: number; auth_json: string | null }[],
): CodeSender[] {
  const out = new Map<string, CodeSender>();
  for (const r of rows) {
    const d = senderDomainOf(r.from_address);
    const k = d ?? `?${r.from_address ?? ""}`;
    const seen = out.get(k);
    if (seen) {
      seen.messages++;
      continue;
    }
    let verdict: string | null = null;
    try {
      verdict = r.auth_json ? ((JSON.parse(r.auth_json) as { verdict?: string }).verdict ?? null) : null;
    } catch {
      verdict = null;
    }
    out.set(k, {
      sender_domain: d,
      from: r.from_address,
      message_id: r.id,
      received_at: r.received_at,
      auth_verdict: verdict,
      messages: 1,
    });
  }
  return [...out.values()];
}

/** Every sender domain with matching mail in the window (newest first): latest-code's guard when no `from` is given. */
async function codeSenders(env: AppEnv, inboxId: string, after: number, f: WaitFilters): Promise<CodeSender[]> {
  const { where, binds } = matchWhere(inboxId, after, f);
  const { results } = await env.DB.prepare(
    `SELECT id, from_address, received_at, auth_json FROM messages WHERE ${where.join(" AND ")} ORDER BY received_at DESC, seq DESC LIMIT ${SENDER_SCAN}`,
  )
    .bind(...binds)
    .all<{ id: string; from_address: string | null; received_at: number; auth_json: string | null }>();
  return groupBySenderDomain(results);
}

/** What a wait parks on: an inbox, or a pseudo-inbox for account-wide waits (events, delivery). */
export type WaitTarget = Pick<InboxRow, "id" | "account_id" | "address">;

/**
 * Take a concurrent-wait slot, or throw 429 too_many_waits. null = no caps apply. Every blocking
 * call shares these slots: inbox waits, latest-code, the event feed and delivery waits.
 */
export async function acquireWaitSlot(env: AppEnv, standing: Standing, inbox: WaitTarget, deadline: number): Promise<string | null> {
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
    `SELECT (SELECT COUNT(*) FROM active_waits WHERE account_id = ?1 AND expires_at > ?3) AS account,
            (SELECT COUNT(*) FROM active_waits WHERE inbox_id = ?2 AND expires_at > ?3) AS inbox,
            (SELECT MIN(expires_at) FROM active_waits WHERE account_id = ?1 AND expires_at > ?3) AS first_end`,
  )
    .bind(inbox.account_id, inbox.id, now)
    .first<{ account: number; inbox: number; first_end: number | null }>();
  // The earliest wait in progress ends by its deadline (its slot outlives it by SLOT_MARGIN_MS).
  const retryAfter = c?.first_end ? Math.min(MAX_TIMEOUT_S, Math.max(1, Math.ceil((c.first_end - SLOT_MARGIN_MS - now) / 1000))) : 5;
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
      retry_after_s: retryAfter,
    },
  );
}

export async function releaseWaitSlot(env: AppEnv, id: string) {
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
  const found = (m: MessageRow) => ({
    message: { ...messageSummary(m), reply_text: replyTextOf(m) },
    row: m,
    waited_ms: Date.now() - started,
    after,
  });

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
    filters.tag && `tag=${filters.tag}`,
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
      filters: {
        from: filters.from ?? null,
        subject: filters.subject ?? null,
        contains: filters.contains ?? null,
        tag: filters.tag ?? null,
      },
      ...(filters.sender ? { sender: filters.sender } : {}),
      ...(filters.requireAuth !== undefined ? { require_auth: filters.requireAuth } : {}),
    },
  );
}

/** On timeout: say so if new mail is being refused because the account's daily limit is reached or its storage is (nearly) full. */
async function limitNote(env: AppEnv, standing: Standing, inbox: InboxRow): Promise<string> {
  const perDay = maxInboundPerDay(env, standing);
  const blobCap = maxBlobBytes(env, standing);
  if (!Number.isFinite(perDay) && !Number.isFinite(blobCap)) return "";
  const r = await env.DB.prepare(
    `SELECT (SELECT count FROM inbound_counters WHERE account_id = ?1 AND day = ?2) AS today,
            (SELECT blob_bytes FROM account_usage WHERE account_id = ?1) AS stored`,
  )
    .bind(inbox.account_id, utcDay(Date.now()))
    .first<{ today: number | null; stored: number | null }>();
  if ((r?.today ?? 0) >= perDay)
    return ` NOTE: this account has received its maximum of ${perDay} messages today (UTC), so new mail is rejected until 00:00 UTC.`;
  const stored = r?.stored ?? 0;
  if (Number.isFinite(blobCap) && stored >= blobCap * NEAR_FULL)
    return ` NOTE: this account keeps ${formatBytes(stored)} of its ${formatBytes(blobCap)} of mail storage, so larger mail (over ${formatBytes(SMALL_MESSAGE_BYTES)}) may be refused; delete old mail (DELETE /v1/messages/:id, DELETE /v1/inboxes/:id/messages) to make room.`;
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
  /** Only mail to this plus-address tag. */
  tag?: string;
}

/**
 * latest-code. With `from` only that sender's mail counts. Without it, any sender's does, and since
 * anyone who can send authenticated mail (from a domain of their own) can email a predictable
 * address, the answer is guarded: it names the sender's domain first (`sender_domain`) with a
 * `warning`, and when code mail from more than one sender domain arrived in the window (after ..
 * now) it refuses to pick (409 ambiguous_sender, with the candidates and the fix).
 */
export async function latestCode(env: AppEnv, accountId: string, inboxId: string, filters: LatestCodeFilters, timeoutS?: number) {
  const { from, allow_unauthenticated, ...rest } = filters;
  const sender = from ? parseSenderFilter(from) : undefined;
  const requireAuth = !allow_unauthenticated;
  const wf: WaitFilters = { ...rest, sender, requireAuth, requireCodeOrLink: true };
  const r = await waitForEmail(env, accountId, inboxId, wf, timeoutS);
  const m = r.message;
  const senderDomain = senderDomainOf(m.from.address);
  let guard: { warning: string; hint: string } | null = null;
  if (!sender) {
    const senders = await codeSenders(env, r.row.inbox_id, r.after, wf);
    if (senders.length > 1) {
      const names = senders.map((s) => s.sender_domain ?? s.from ?? "?");
      throw new ApiError(
        409,
        "ambiguous_sender",
        `Mail with a code or link from ${senders.length} different senders (${names.slice(0, 5).join(", ")}${senders.length > 5 ? ", ..." : ""}) arrived since ${new Date(r.after).toISOString()}, and no \`from\` says which one you are waiting for, so latest-code will not pick one.`,
        `Call again with from=<the domain of the site you are signing up to> (e.g. from=github.com; pick it from what you signed up for, not from the candidates): only its mail counts then. Anyone can send mail to this address, and a code or link from a site you did not sign up to may be an attempt to take over your signup. To skip older mail, also pass after=<unix ms>.`,
        { after: r.after, candidates: senders.slice(0, SENDER_REPORT) },
      );
    }
    guard = {
      warning: `No \`from\` was given, so this is the newest code from any sender: it came from ${senderDomain ?? m.from.address}. Use it only if that is the site you are signing up to; anyone can email this address.`,
      hint: `Pass from=${senderDomain ?? "<the site's domain>"} (its subdomains match too) so mail from other senders is ignored; without it, latest-code answers 409 ambiguous_sender when more than one sender's code mail is in the window.`,
    };
  }
  return {
    sender_domain: senderDomain,
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
    tag: m.tag,
    waited_ms: r.waited_ms,
    ...(guard ?? {}),
  };
}
