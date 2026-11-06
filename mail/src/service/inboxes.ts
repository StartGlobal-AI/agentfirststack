import { ApiError, badRequest, conflict, newId, notFound } from "@afs/shared";
import { type AppEnv, type Standing, cap, standingOf } from "../env";
import { checkUsername, normalizeDomain, randomUsername } from "../lib/address";
import { DEFAULT_FORWARD, type ForwardInput, mergeForward } from "../lib/forwarding";
import { headerSafe } from "../lib/headers";
import { assertActive, dailyLimitError, maxBlobBytes, refundDaily, reserveDaily, storedBlobBytes } from "./budgets";
import { type InboxRow, inboxJson, utcDay } from "./format";
import { forwardContext, forwardNextSteps, settingOf } from "./forward-settings";
import { inboxCreateAttempt } from "./pauses";

export const MAX_TTL_DAYS = 3650;
const DAY = 86_400_000;
/** Wall time one cron run may spend on each purge before handing the rest to the next run. */
export const PURGE_BUDGET_MS = 20_000;
const PURGE_BATCH = 200;
const DELETE_CHUNK = 500;
/** Mail waiting to be forwarded (nobody claimed the project yet) is dropped from the queue after this many days. */
export const FORWARD_QUEUE_MAX_DAYS = 30;

/** Display names go into the From header: no CR/LF or other control characters. */
function cleanDisplayName(v: string | null | undefined): string | null {
  return headerSafe(v) || null;
}

export function sharedDomain(env: AppEnv): string {
  return (env.MAIL_DOMAIN || "mail.example.com").toLowerCase();
}

/** The domain an account may create an inbox on: the shared MAIL_DOMAIN or one of its own. */
export async function resolveInboxDomain(
  env: AppEnv,
  accountId: string,
  domain?: string | null,
): Promise<{ domain: string; shared: boolean; verified: boolean; sendOnly?: boolean }> {
  const shared = sharedDomain(env);
  if (!domain) return { domain: shared, shared: true, verified: true };
  const d = normalizeDomain(domain);
  if (!d) throw badRequest(`"${domain}" is not a valid domain.`, "Pass a hostname like example.com, or omit domain to use " + shared + ".");
  if (d === shared) return { domain: shared, shared: true, verified: true };
  const row = await env.DB.prepare(
    "SELECT receiving_verified, owner_verified_at, receiving_enabled FROM domains WHERE domain = ? AND account_id = ?",
  )
    .bind(d, accountId)
    .first<{ receiving_verified: number; owner_verified_at: number | null; receiving_enabled: number }>();
  if (!row) {
    throw new ApiError(
      404,
      "domain_not_found",
      `Domain ${d} is not set up on this account.`,
      `Add it first: POST /v1/domains {"domain":"${d}"} (returns the DNS records), or omit domain to use ${shared}.`,
    );
  }
  if (!row.owner_verified_at) throw ownershipNotVerified(d);
  return { domain: d, shared: false, verified: !!row.receiving_verified, sendOnly: row.receiving_enabled === 0 };
}

export const ownershipNotVerified = (d: string) =>
  new ApiError(
    403,
    "ownership_not_verified",
    `This account has not proven it controls ${d} yet.`,
    `Add the TXT record _afs-verify.${d} listed first in GET /v1/domains/${d} (records[0]), then POST /v1/domains/${d}/verify until ownership is "pass".`,
  );

export interface CreateInboxInput {
  username?: string | null;
  domain?: string | null;
  display_name?: string | null;
  ttl_days?: number | null;
  /** Forward to the project's members (src/service/forward.ts). Applied to a new inbox only. */
  forward?: ForwardInput | null;
}

/** MAX_INBOXES_PER_ACCOUNT (hosted fair use; UNCLAIMED_ variant). Unset = no cap. */
async function assertInboxQuota(env: AppEnv, standing: Standing, accountId: string) {
  const max = cap(env, standing, "MAX_INBOXES_PER_ACCOUNT");
  if (!Number.isFinite(max)) return;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM inboxes WHERE account_id = ?").bind(accountId).first<{ n: number }>();
  if ((row?.n ?? 0) >= max) {
    throw new ApiError(
      403,
      "quota_exceeded",
      `This account already has ${max} inboxes, the most allowed here.`,
      "Delete an inbox you no longer need (DELETE /v1/inboxes/:id), or reuse one: an inbox can receive mail from any number of services.",
      { limit: max },
    );
  }
}

export async function createInbox(env: AppEnv, accountId: string, input: CreateInboxInput, now = Date.now()) {
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const fwd = mergeForward(DEFAULT_FORWARD, input.forward); // 400 on a bad value, before anything is created
  const dom = await resolveInboxDomain(env, accountId, input.domain);
  const expiresAt = input.ttl_days ? now + Math.round(input.ttl_days * DAY) : null;
  const display = cleanDisplayName(input.display_name);
  // mail.inbox_create pause and burst detection (src/service/pauses.ts): once per call, on the first
  // address that would be new (taken ones too, so they answer alike); never for one the account owns.
  let attempt: Promise<void> | null = null;
  const noteAttempt = () => (attempt ??= inboxCreateAttempt(env, accountId, standing, now));

  /** null = the address is someone else's: taken by another account, or (shared domain) once theirs. */
  const insert = async (username: string): Promise<{ row: InboxRow; existing: boolean } | null> => {
    const address = `${username}@${dom.domain}`;
    // One query for both, so a live address and a retired one cost the same and answer the same.
    // Retired shared-domain addresses (address_tombstones) never lapse: see deleteInbox.
    const found = await env.DB.prepare(
      "SELECT i.*, t.account_id AS tomb_account FROM (SELECT ? AS address) a LEFT JOIN inboxes i ON i.address = a.address LEFT JOIN address_tombstones t ON t.address = a.address",
    )
      .bind(address)
      .first<InboxRow & { id: string | null; tomb_account: string | null }>();
    if (found?.id && found.account_id === accountId) {
      const { tomb_account: _t, ...row } = found;
      return { row: row as InboxRow, existing: true };
    }
    await noteAttempt();
    if (found?.id) return null;
    if (found?.tomb_account && found.tomb_account !== accountId) return null;
    await assertInboxQuota(env, standing, accountId);
    // MAX_INBOX_CREATES_PER_DAY: only real creations count (not "existing": true).
    const limit = cap(env, standing, "MAX_INBOX_CREATES_PER_DAY");
    const budget = await reserveDaily(env, accountId, "inbox_create", limit, now);
    if (!budget.ok)
      throw dailyLimitError(
        `this account created ${limit} inboxes today`,
        limit,
        "Reuse an inbox you already have (one inbox can receive mail from any number of services, and wait/latest-code take from/subject filters), or create more tomorrow.",
      );
    const row: InboxRow = {
      id: newId("inb"),
      account_id: accountId,
      address,
      username,
      domain: dom.domain,
      display_name: display,
      expires_at: expiresAt,
      last_message_at: null,
      created_at: now,
      forward_mode: fwd.mode,
      forward_digest_hour: fwd.digest_hour,
      forward_timezone: fwd.timezone,
      forward_since: fwd.mode === "off" ? null : now,
      forward_last_forwarded_at: null,
      forward_last_digest_at: null,
    };
    try {
      await env.DB.prepare(
        `INSERT INTO inboxes (id, account_id, address, username, domain, display_name, expires_at, last_message_at, created_at,
           forward_mode, forward_digest_hour, forward_timezone, forward_since) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
        .bind(
          row.id,
          row.account_id,
          row.address,
          row.username,
          row.domain,
          row.display_name,
          row.expires_at,
          row.created_at,
          fwd.mode,
          fwd.digest_hour,
          fwd.timezone,
          row.forward_since,
        )
        .run();
    } catch (e) {
      await refundDaily(env, accountId, "inbox_create", budget.day);
      if (/UNIQUE/i.test(String(e))) {
        // Lost a race with a concurrent create of the same address.
        const again = await env.DB.prepare("SELECT * FROM inboxes WHERE address = ?").bind(address).first<InboxRow>();
        if (again && again.account_id === accountId) return { row: again, existing: true };
        return null;
      }
      throw e;
    }
    return { row, existing: false };
  };

  let result: { row: InboxRow; existing: boolean } | null = null;
  if (input.username) {
    const chk = checkUsername(input.username, { sharedDomain: dom.shared, extraReserved: env.EXTRA_RESERVED_USERNAMES });
    if (!chk.ok) {
      // A name reserved after this account created it: its inbox keeps working, and a retried
      // create still returns it (rule 7). Nobody else gets it.
      const mine =
        chk.reserved && chk.username
          ? await env.DB.prepare("SELECT * FROM inboxes WHERE address = ? AND account_id = ?")
              .bind(`${chk.username}@${dom.domain}`, accountId)
              .first<InboxRow>()
          : null;
      if (!mine) throw badRequest(`Invalid username: ${chk.reason}`, "Pick another username, or omit it for a random one.");
      result = { row: mine, existing: true };
    } else result = await insert(chk.username);
    if (!result) {
      // The same answer whether another account holds the address now or held it once: polling
      // this tells nobody when (or whether) an address was deleted.
      throw conflict(
        `${input.username.trim().toLowerCase()}@${dom.domain} is taken: it belongs to another account, now or before. Addresses are never passed from one account to another.`,
        "Pick another username, or omit username for a random one.",
      );
    }
  } else {
    for (let i = 0; i < 5 && !result; i++) result = await insert(randomUsername());
    if (!result) throw new ApiError(503, "unavailable", "Could not allocate a random address.", "Retry the request.");
  }

  const ctx = await forwardContext(env, accountId, now);
  const inbox = inboxJson(result.row, ctx);
  const kept = settingOf(result.row);
  const next_steps = [
    `Use ${inbox.address} in the signup form, then GET /v1/inboxes/${inbox.id}/latest-code?from=<the site's domain, e.g. github.com>&timeout=60 to block until its code or link arrives (or /wait?from=... for the whole message). Always pass from: anyone can email this address.`,
    ...(dom.sendOnly
      ? [`${dom.domain} is send-only: this inbox sends, but receives no mail here (its mail goes to your existing MX).`]
      : dom.shared || dom.verified
        ? []
        : [`Domain ${dom.domain} has not passed the receiving DNS check yet: POST /v1/domains/${dom.domain}/verify.`]),
    ...(result.existing && input.forward && JSON.stringify(kept) !== JSON.stringify(fwd)
      ? [
          `This inbox already existed, so its forward setting was not changed (it is "${kept.mode}"). PATCH /v1/inboxes/${inbox.id} {"forward":{...}} changes it.`,
        ]
      : []),
    ...(input.forward ? forwardNextSteps(kept, ctx, inbox.id) : []),
  ];
  return { inbox, existing: result.existing, next_steps };
}

/** Default inbox for a brand-new account (signup hook). Random username on the shared domain. */
export async function createDefaultInbox(env: AppEnv, accountId: string) {
  const r = await createInbox(env, accountId, {});
  return r.inbox;
}

export async function getInboxRow(env: AppEnv, accountId: string, id: string): Promise<InboxRow> {
  const row = await env.DB.prepare("SELECT * FROM inboxes WHERE id = ? AND account_id = ?").bind(id, accountId).first<InboxRow>();
  if (!row) throw notFound("Inbox", "GET /v1/inboxes lists your inboxes.");
  return row;
}

export async function getInbox(env: AppEnv, accountId: string, id: string) {
  const row = await getInboxRow(env, accountId, id);
  const [stats, ctx] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN read = 0 AND direction = 'in' THEN 1 ELSE 0 END), 0) AS unread FROM messages WHERE inbox_id = ?",
    )
      .bind(id)
      .first<{ total: number; unread: number }>(),
    forwardContext(env, accountId),
  ]);
  return { inbox: { ...inboxJson(row, ctx), message_count: stats?.total ?? 0, unread_count: stats?.unread ?? 0 } };
}

export async function listInboxes(env: AppEnv, accountId: string, opts: { limit?: number; domain?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = opts.domain
    ? await env.DB.prepare("SELECT * FROM inboxes WHERE account_id = ? AND domain = ? ORDER BY created_at DESC LIMIT ?")
        .bind(accountId, opts.domain.toLowerCase(), limit)
        .all<InboxRow>()
    : await env.DB.prepare("SELECT * FROM inboxes WHERE account_id = ? ORDER BY created_at DESC LIMIT ?")
        .bind(accountId, limit)
        .all<InboxRow>();
  const [standing, used, ctx] = await Promise.all([
    standingOf(env, accountId),
    storedBlobBytes(env, accountId),
    forwardContext(env, accountId),
  ]);
  const limit_bytes = maxBlobBytes(env, standing);
  return {
    inboxes: results.map((r) => inboxJson(r, ctx)),
    shared_domain: sharedDomain(env),
    // Mail kept for the account (raw messages, HTML bodies, sent attachments). At the limit, new
    // mail is rejected ("Mailbox full") until old mail is deleted.
    storage: { used_bytes: used, limit_bytes: Number.isFinite(limit_bytes) ? limit_bytes : null },
  };
}

export async function updateInbox(
  env: AppEnv,
  accountId: string,
  id: string,
  input: { display_name?: string | null; ttl_days?: number | null; forward?: ForwardInput | null },
  now = Date.now(),
) {
  const row = await getInboxRow(env, accountId, id);
  const display = input.display_name === undefined ? row.display_name : cleanDisplayName(input.display_name);
  const expires = input.ttl_days === undefined ? row.expires_at : input.ttl_days === null ? null : now + Math.round(input.ttl_days * DAY);
  // forward merges: {"mode":"digest"} keeps digest_hour and timezone.
  const prev = settingOf(row);
  const fwd = mergeForward(prev, input.forward);
  // Turned on: the catch-up starts now. Turned off: what was waiting is dropped (and not sent later).
  const since = fwd.mode === "off" ? null : prev.mode === "off" ? now : (row.forward_since ?? now);
  const paused = fwd.mode === "off" ? null : (row.forward_paused_at ?? null);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE inboxes SET display_name = ?, expires_at = ?, forward_mode = ?, forward_digest_hour = ?, forward_timezone = ?, forward_since = ?, forward_paused_at = ? WHERE id = ?",
    ).bind(display, expires, fwd.mode, fwd.digest_hour, fwd.timezone, since, paused, id),
    ...(fwd.mode === "off" && prev.mode !== "off" ? [env.DB.prepare("DELETE FROM forward_queue WHERE inbox_id = ?").bind(id)] : []),
  ]);
  const ctx = await forwardContext(env, accountId, now);
  const updated: InboxRow = {
    ...row,
    display_name: display,
    expires_at: expires,
    forward_mode: fwd.mode,
    forward_digest_hour: fwd.digest_hour,
    forward_timezone: fwd.timezone,
    forward_since: since,
    forward_paused_at: paused,
  };
  return {
    inbox: inboxJson(updated, ctx),
    ...(input.forward ? { next_steps: forwardNextSteps(fwd, ctx, id) } : {}),
  };
}

/** Delete every R2 object under a prefix (paginated). */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let n = 0;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    if (list.objects.length) {
      await bucket.delete(list.objects.map((o) => o.key));
      n += list.objects.length;
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return n;
}

/**
 * Delete an inbox's messages (with their attachments; deliveries and forward_queue rows cascade) in
 * chunks, so a huge inbox never needs one giant statement. Stops after the chunk during which
 * `deadline` (a Date.now() value) passed: `more: true` then. R2 blobs are not touched.
 */
export async function deleteInboxMessages(env: AppEnv, inboxId: string, deadline = Number.POSITIVE_INFINITY) {
  const chunk = "SELECT id FROM messages WHERE inbox_id = ?1 ORDER BY seq LIMIT ?2";
  let deleted = 0;
  for (;;) {
    const [, msgs] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${chunk})`).bind(inboxId, DELETE_CHUNK),
      // RETURNING, not meta.changes: D1 counts the rows the delete triggers touch (FTS, usage) too.
      env.DB.prepare(`DELETE FROM messages WHERE id IN (${chunk}) RETURNING id`).bind(inboxId, DELETE_CHUNK),
    ]);
    const n = msgs?.results.length ?? 0;
    deleted += n;
    if (n < DELETE_CHUNK) return { deleted, more: false };
    if (Date.now() >= deadline) return { deleted, more: true };
  }
}

export async function deleteInbox(env: AppEnv, accountId: string, id: string, now = Date.now()) {
  const row = await getInboxRow(env, accountId, id);
  await deleteInboxMessages(env, id);
  // A shared-domain address is retired for good when its inbox goes (by API, ttl expiry or the
  // project's erasure): it may be the recovery email of accounts elsewhere, whether or not mail has
  // arrived yet, so it is never given to another account (migrations/0016). Its old account may
  // create it again. Addresses on an account's own domain are that domain owner's business.
  const tombstone = row.domain === sharedDomain(env);
  await env.DB.batch([
    env.DB.prepare("UPDATE domains SET catch_all_inbox_id = NULL WHERE catch_all_inbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM threads WHERE inbox_id = ?").bind(id),
    env.DB.prepare("UPDATE webhooks SET enabled = 0 WHERE inbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM list_entries WHERE inbox_id = ?").bind(id),
    env.DB.prepare("DELETE FROM inboxes WHERE id = ?").bind(id),
    ...(tombstone
      ? [
          // The account that held it last is the one that may create it again (only an address that
          // was free under the old 90-day rule can have had an earlier owner).
          env.DB.prepare(
            "INSERT INTO address_tombstones (address, account_id, deleted_at, permanent) VALUES (?, ?, ?, 1) ON CONFLICT(address) DO UPDATE SET account_id = excluded.account_id, deleted_at = excluded.deleted_at, permanent = 1",
          ).bind(row.address, row.account_id, now),
        ]
      : []),
  ]);
  const blobs = await deletePrefix(env.BLOBS, `inbox/${id}/`);
  return {
    deleted: id,
    address: row.address,
    blobs_deleted: blobs,
    // true: no other account will ever get this address; this account can create it again.
    address_reserved: tombstone,
  };
}

/** DELETE /v1/inboxes/:id and the delete_inbox tool: deleteInbox under MAX_INBOX_DELETES_PER_DAY. */
export async function deleteInboxForUser(env: AppEnv, accountId: string, id: string, now = Date.now()) {
  await getInboxRow(env, accountId, id); // 404 before spending budget
  const standing = await standingOf(env, accountId);
  const limit = cap(env, standing, "MAX_INBOX_DELETES_PER_DAY");
  const budget = await reserveDaily(env, accountId, "inbox_delete", limit, now);
  if (!budget.ok)
    throw dailyLimitError(
      `this account deleted ${limit} inboxes today`,
      limit,
      'Let it expire instead: PATCH /v1/inboxes/:id {"ttl_days": 1} deletes it (and its mail) within a day.',
    );
  try {
    return await deleteInbox(env, accountId, id, now);
  } catch (e) {
    await refundDaily(env, accountId, "inbox_delete", budget.day);
    throw e;
  }
}

/**
 * Cron: drop inboxes whose ttl has passed. Loops until none are left or `budgetMs` of wall time is
 * spent (`more: true` then; the next hourly run continues).
 */
export async function purgeExpiredInboxes(env: AppEnv, now = Date.now(), budgetMs = PURGE_BUDGET_MS) {
  const stop = Date.now() + budgetMs;
  let purged = 0;
  for (;;) {
    if (Date.now() >= stop) return { purged, more: true };
    const { results } = await env.DB.prepare("SELECT id, account_id FROM inboxes WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 50")
      .bind(now)
      .all<{ id: string; account_id: string }>();
    for (const r of results) {
      if (Date.now() >= stop) return { purged, more: true };
      await deleteInbox(env, r.account_id, r.id, now);
      purged++;
    }
    if (results.length < 50) return { purged, more: false };
  }
}

/**
 * SHARED_RETENTION_DAYS: delete shared-domain messages (and their R2 blobs) older than the cutoff.
 * Runs from the hourly cron in batches of PURGE_BATCH until none are left or `budgetMs` of wall
 * time is spent (`more: true` then).
 */
export async function purgeOldSharedMessages(env: AppEnv, now = Date.now(), budgetMs = PURGE_BUDGET_MS) {
  const days = Number(env.SHARED_RETENTION_DAYS || 0);
  if (!(days > 0)) return { purged_messages: 0, more: false };
  const cutoff = now - days * DAY;
  const { deleteMessageRows } = await import("./messages");
  const stop = Date.now() + budgetMs;
  let purged = 0;
  for (;;) {
    if (Date.now() >= stop) return { purged_messages: purged, more: true };
    const { results } = await env.DB.prepare(
      "SELECT m.id, m.thread_id, m.raw_key, m.html_key FROM messages m JOIN inboxes i ON i.id = m.inbox_id WHERE i.domain = ? AND m.received_at < ? LIMIT ?",
    )
      .bind(sharedDomain(env), cutoff, PURGE_BATCH)
      .all<{ id: string; thread_id: string; raw_key: string | null; html_key: string | null }>();
    purged += await deleteMessageRows(env, results);
    if (results.length < PURGE_BATCH) return { purged_messages: purged, more: false };
  }
}

/**
 * Cron: housekeeping rows that are no longer needed: daily counters older than a week (inbound,
 * per sender, per-account budgets), wait slots past their expiry (a Worker that died), and mail
 * that waited FORWARD_QUEUE_MAX_DAYS to be forwarded (nobody claimed the project: nothing waits
 * forever). Address tombstones are never pruned: a retired address stays retired.
 */
export async function pruneCounters(env: AppEnv, now = Date.now()) {
  const weekAgo = utcDay(now - 7 * DAY);
  const r = await env.DB.batch([
    env.DB.prepare("DELETE FROM inbound_counters WHERE day < ?").bind(weekAgo),
    env.DB.prepare("DELETE FROM sender_counters WHERE day < ?").bind(weekAgo),
    env.DB.prepare("DELETE FROM account_daily WHERE day < ?").bind(weekAgo),
    env.DB.prepare("DELETE FROM active_waits WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM forward_queue WHERE received_at < ?").bind(now - FORWARD_QUEUE_MAX_DAYS * DAY),
  ]);
  const n = (i: number) => r[i]?.meta.changes ?? 0;
  return { counters_pruned: n(0) + n(1) + n(2), wait_slots_pruned: n(3), forward_queue_pruned: n(4) };
}

/**
 * Recipient resolution for the email() handler. Expired inboxes do not exist, and a custom
 * domain only receives (by address or catch-all) once its account passed the ownership challenge.
 */
export async function findInboxForRecipient(
  env: AppEnv,
  address: string,
  now = Date.now(),
): Promise<{ inbox: InboxRow; via: "address" | "catch_all" } | null> {
  const shared = sharedDomain(env);
  const direct = await env.DB.prepare(
    `SELECT i.* FROM inboxes i WHERE i.address = ? AND (i.expires_at IS NULL OR i.expires_at > ?)
       AND (i.domain = ? OR EXISTS (SELECT 1 FROM domains d WHERE d.domain = i.domain AND d.account_id = i.account_id AND d.owner_verified_at IS NOT NULL
            AND d.receiving_enabled = 1))`,
  )
    .bind(address, now, shared)
    .first<InboxRow>();
  if (direct) return { inbox: direct, via: "address" };
  const domain = address.split("@")[1];
  if (!domain || domain === shared) return null;
  const ca = await env.DB.prepare(
    `SELECT i.* FROM domains d JOIN inboxes i ON i.id = d.catch_all_inbox_id
     WHERE d.domain = ? AND d.owner_verified_at IS NOT NULL AND d.receiving_enabled = 1 AND i.account_id = d.account_id AND (i.expires_at IS NULL OR i.expires_at > ?)`,
  )
    .bind(domain, now)
    .first<InboxRow>();
  return ca ? { inbox: ca, via: "catch_all" } : null;
}
