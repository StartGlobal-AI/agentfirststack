import { ApiError, badRequest, newId, notFound } from "@afs/shared";
import { type AppEnv, type Standing, cap, standingOf } from "../env";
import type { AuthResults } from "../extract/auth";
import { normalizeDomain, splitAddress } from "../lib/address";
import { senderIdentity } from "../lib/sender";
import { assertActive } from "./budgets";
import type { InboxRow } from "./format";
import { getInboxRow } from "./inboxes";

/**
 * Allow and block lists, per account or per inbox.
 *
 *   receive allow  once an inbox (or the account) has any, only mail whose AUTHENTICATED sender
 *                  matches one gets in ("only github.com may write here"). The sender is what
 *                  authentication vouches for (src/lib/sender.ts senderIdentity): the From address
 *                  with auth.verdict "pass", else the SPF-passing envelope sender, else the
 *                  DKIM-passing domain. Unauthenticated mail never matches an allow entry.
 *   receive block  mail whose authenticated sender matches is refused; unauthenticated mail is
 *                  also refused when its From or envelope sender matches (it only claims to be
 *                  them, and blocking a claim costs the blocked party nothing).
 *   send block     sends, replies and forwards to a matching recipient are refused (403
 *                  recipient_blocked). There is no send allow list: reply_only already limits the
 *                  shared domain, and your own domain may write to anyone.
 *
 * Both receive lists are checked in the email() handler right after the headers are parsed, so a
 * refused message is rejected at SMTP time (the sender gets "Mailbox unavailable") before its body
 * is read or any per-sender allowance is spent. An entry is an address (exact) or a domain (it and
 * its subdomains). MAX_LIST_ENTRIES_PER_ACCOUNT caps the entries (default 100).
 */

export const DEFAULT_MAX_LIST_ENTRIES = 100;
export type ListDirection = "receive" | "send";
export type ListKind = "allow" | "block";

interface ListRow {
  id: string;
  account_id: string;
  inbox_id: string | null;
  direction: ListDirection;
  kind: ListKind;
  entry: string;
  entry_type: "address" | "domain";
  reason: string | null;
  created_at: number;
}

export const maxListEntries = (env: AppEnv, standing: Standing) =>
  cap(env, standing, "MAX_LIST_ENTRIES_PER_ACCOUNT", DEFAULT_MAX_LIST_ENTRIES);

/** "a@b.com" -> address; "b.com", "@b.com" or "*.b.com" -> domain. Pure; null if neither. */
export function parseListEntry(raw: string): { entry: string; entry_type: "address" | "domain" } | null {
  const s = raw.trim().toLowerCase();
  if (s.includes("@") && !s.startsWith("@")) {
    const a = splitAddress(s);
    return a ? { entry: `${a.local}@${a.domain}`, entry_type: "address" } : null;
  }
  const d = normalizeDomain(s.replace(/^@/, "").replace(/^\*\./, ""));
  return d ? { entry: d, entry_type: "domain" } : null;
}

/** Does an address (or "dkim@domain" identity) match an entry? Pure. */
export function entryMatches(e: Pick<ListRow, "entry" | "entry_type">, address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 0) return false;
  const domain = a.slice(at + 1);
  if (e.entry_type === "domain") return domain === e.entry || domain.endsWith(`.${e.entry}`);
  if (a.startsWith("dkim@")) return false; // a DKIM signature vouches for a domain, not an address
  const plus = a.indexOf("+");
  const base = plus > 0 && plus < at ? `${a.slice(0, plus)}${a.slice(at)}` : a;
  return a === e.entry || base === e.entry;
}

function listJson(r: ListRow) {
  return {
    id: r.id,
    direction: r.direction,
    kind: r.kind,
    entry: r.entry,
    entry_type: r.entry_type,
    inbox_id: r.inbox_id,
    reason: r.reason,
    created_at: r.created_at,
  };
}

function assertListKind(direction: string, kind: string): asserts direction is ListDirection {
  if (direction !== "receive" && direction !== "send")
    throw badRequest(
      `Unknown list "${direction}".`,
      "Lists are /v1/lists/receive/allow, /v1/lists/receive/block and /v1/lists/send/block.",
    );
  if (kind !== "allow" && kind !== "block") throw badRequest(`Unknown list kind "${kind}".`, "Use allow or block.");
  if (direction === "send" && kind === "allow")
    throw badRequest(
      "There is no send allow list.",
      "On the shared domain reply_only already limits who you can write to; your own domains may write to anyone. Use /v1/lists/send/block to stop sends to someone.",
    );
}

export async function addListEntry(
  env: AppEnv,
  accountId: string,
  direction: string,
  kind: string,
  input: { entry: string; inbox_id?: string | null; reason?: string | null },
  now = Date.now(),
) {
  assertListKind(direction, kind);
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const parsed = parseListEntry(input.entry);
  if (!parsed)
    throw badRequest(
      `"${input.entry}" is neither an address nor a domain.`,
      'Pass an address ("noreply@github.com") or a domain ("github.com"; its subdomains match too).',
    );
  if (input.inbox_id) await getInboxRow(env, accountId, input.inbox_id);
  const reason =
    input.reason
      ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 200) || null;
  const scope = input.inbox_id ?? "";
  const existing = await env.DB.prepare(
    "SELECT * FROM list_entries WHERE account_id = ? AND direction = ? AND kind = ? AND entry = ? AND COALESCE(inbox_id, '') = ?",
  )
    .bind(accountId, direction, kind, parsed.entry, scope)
    .first<ListRow>();
  if (existing) return { entry: listJson(existing), existing: true, next_steps: [] as string[] };
  const max = maxListEntries(env, standing);
  const id = newId("lst");
  // Insert only under the cap, in one statement (concurrent adds cannot pass it).
  const r = await env.DB.prepare(
    `INSERT INTO list_entries (id, account_id, inbox_id, direction, kind, entry, entry_type, reason, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE (SELECT COUNT(*) FROM list_entries WHERE account_id = ?2) < ?10
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      id,
      accountId,
      input.inbox_id ?? null,
      direction,
      kind,
      parsed.entry,
      parsed.entry_type,
      reason,
      now,
      Number.isFinite(max) ? max : 1e9,
    )
    .run();
  if (!r.meta.changes) {
    const again = await env.DB.prepare(
      "SELECT * FROM list_entries WHERE account_id = ? AND direction = ? AND kind = ? AND entry = ? AND COALESCE(inbox_id, '') = ?",
    )
      .bind(accountId, direction, kind, parsed.entry, scope)
      .first<ListRow>();
    if (again) return { entry: listJson(again), existing: true, next_steps: [] as string[] };
    throw new ApiError(
      403,
      "quota_exceeded",
      `This account already has ${max} list entries, the most allowed here.`,
      "Delete entries you no longer need (DELETE /v1/lists/:direction/:kind/:entry), or use a domain entry instead of many addresses.",
      { limit: max },
    );
  }
  const row: ListRow = {
    id,
    account_id: accountId,
    inbox_id: input.inbox_id ?? null,
    direction,
    kind: kind as ListKind,
    ...parsed,
    reason,
    created_at: now,
  };
  const where = input.inbox_id ? `inbox ${input.inbox_id}` : "every inbox of this account";
  return {
    entry: listJson(row),
    existing: false,
    next_steps: [
      direction === "receive" && kind === "allow"
        ? `From now on ${where} accepts mail only from authenticated senders on its receive allow list (others are refused at SMTP time). Unauthenticated mail never matches.`
        : direction === "receive"
          ? `Mail from ${parsed.entry} to ${where} is refused at SMTP time.`
          : `Sends to ${parsed.entry} from ${where} are refused (403 recipient_blocked).`,
      `GET /v1/lists/${direction}/${kind} lists the entries; DELETE /v1/lists/${direction}/${kind}/${encodeURIComponent(parsed.entry)} removes this one.`,
    ],
  };
}

export async function listListEntries(env: AppEnv, accountId: string, opts: { direction?: string; kind?: string; inbox_id?: string } = {}) {
  if (opts.direction && opts.kind) assertListKind(opts.direction, opts.kind);
  const where = ["account_id = ?"];
  const binds: unknown[] = [accountId];
  if (opts.direction) {
    where.push("direction = ?");
    binds.push(opts.direction);
  }
  if (opts.kind) {
    where.push("kind = ?");
    binds.push(opts.kind);
  }
  if (opts.inbox_id) {
    where.push("(inbox_id IS NULL OR inbox_id = ?)");
    binds.push(opts.inbox_id);
  }
  const { results } = await env.DB.prepare(`SELECT * FROM list_entries WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`)
    .bind(...binds)
    .all<ListRow>();
  const standing = await standingOf(env, accountId);
  const max = maxListEntries(env, standing);
  return { entries: results.map(listJson), limit: Number.isFinite(max) ? max : null };
}

export async function deleteListEntry(
  env: AppEnv,
  accountId: string,
  direction: string,
  kind: string,
  entry: string,
  opts: { inbox_id?: string | null } = {},
) {
  assertListKind(direction, kind);
  const parsed = parseListEntry(entry);
  const r = parsed
    ? await env.DB.prepare(
        "DELETE FROM list_entries WHERE account_id = ? AND direction = ? AND kind = ? AND entry = ? AND COALESCE(inbox_id, '') = ?",
      )
        .bind(accountId, direction, kind, parsed.entry, opts.inbox_id ?? "")
        .run()
    : null;
  if (!r?.meta.changes)
    throw notFound(
      "List entry",
      `GET /v1/lists/${direction}/${kind} lists the entries (an inbox-scoped entry needs ?inbox_id= to delete).`,
    );
  return { deleted: parsed!.entry, direction, kind, inbox_id: opts.inbox_id ?? null };
}

/**
 * The receive lists' verdict on one inbound message (after its headers are parsed): a rejection
 * reason for SMTP, or null to accept. One indexed query.
 */
export async function receiveRefusal(
  env: AppEnv,
  inbox: InboxRow,
  sender: { fromAddress: string | null; envelopeFrom: string | null; auth: AuthResults },
): Promise<string | null> {
  const { results } = await env.DB.prepare(
    "SELECT kind, entry, entry_type FROM list_entries WHERE account_id = ? AND direction = 'receive' AND (inbox_id IS NULL OR inbox_id = ?) LIMIT 500",
  )
    .bind(inbox.account_id, inbox.id)
    .all<Pick<ListRow, "kind" | "entry" | "entry_type">>();
  if (!results.length) return null;
  const identity = senderIdentity(sender);
  const blocks = results.filter((r) => r.kind === "block");
  const claimed = identity ? [] : [sender.fromAddress, sender.envelopeFrom];
  if (blocks.some((b) => entryMatches(b, identity) || claimed.some((c) => entryMatches(b, c))))
    return `Mailbox unavailable: ${inbox.address} does not accept mail from this sender`;
  const allows = results.filter((r) => r.kind === "allow");
  if (allows.length && !allows.some((a) => entryMatches(a, identity)))
    return `Mailbox unavailable: ${inbox.address} only accepts mail from approved, authenticated senders`;
  return null;
}

/** Sends: refuse recipients on the send block list (403 recipient_blocked). */
export async function assertSendAllowed(env: AppEnv, inbox: InboxRow, recipients: string[]) {
  const { results } = await env.DB.prepare(
    "SELECT entry, entry_type FROM list_entries WHERE account_id = ? AND direction = 'send' AND kind = 'block' AND (inbox_id IS NULL OR inbox_id = ?) LIMIT 500",
  )
    .bind(inbox.account_id, inbox.id)
    .all<Pick<ListRow, "entry" | "entry_type">>();
  if (!results.length) return;
  const blocked = [...new Set(recipients.map((r) => r.toLowerCase()))].filter((r) => results.some((e) => entryMatches(e, r)));
  if (blocked.length)
    throw new ApiError(
      403,
      "recipient_blocked",
      `This account's send block list refuses: ${blocked.join(", ")}.`,
      "Remove them from the recipients, or delete the entry (GET /v1/lists/send/block lists them).",
      { recipients_blocked: blocked },
    );
}
