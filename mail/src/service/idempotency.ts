import { ApiError, badRequest, sha256Hex } from "@afs/shared";
import type { AppEnv } from "../env";

/**
 * Idempotency-Key for send, reply and forward (rule 7: retries are safe). The first request with a
 * key claims it; once the message is sent its response is kept for 24 h, and a retry with the same
 * key and the same body gets that response again (200, `idempotent_replay: true`) instead of a
 * second email. The same key with another body is a 409 `idempotency_conflict`; a retry while the
 * first request is still sending is a 409 `idempotency_in_progress`.
 *
 * A send that fails before Email Service accepted it releases the key, so the retry really sends.
 * One that fails after (storing the copy) keeps the key with a minimal response: the mail went out.
 * A claim left by a Worker that died mid-send is taken over after PENDING_LEASE_MS.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
export const PENDING_LEASE_MS = 120_000;
const KEY_RE = /^[A-Za-z0-9._~-]{1,256}$/;

/** A valid key, null when absent; 400 when malformed. */
export function parseIdempotencyKey(v: string | null | undefined): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!KEY_RE.test(v))
    throw badRequest(
      "Invalid Idempotency-Key.",
      "Use 1-256 characters of A-Z a-z 0-9 . _ ~ - (a UUID works), the same value on every retry of one send.",
    );
  return v;
}

/** JSON with object keys sorted, so the same body always hashes the same. Pure. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Tells the idempotency layer that Email Service accepted the message (after this, never send again). */
export interface SendTracker {
  accepted(info: { provider_message_id: string | null; message_id: string }): void;
}

type Replayed<T> = T & { idempotent_replay?: true };

export async function withIdempotency<T extends { message?: { id?: string } | null }>(
  env: AppEnv,
  accountId: string,
  key: string | null,
  scope: string,
  body: unknown,
  run: (t: SendTracker) => Promise<T>,
  now = Date.now(),
  attempt = 0,
): Promise<Replayed<T>> {
  const noop: SendTracker = { accepted() {} };
  if (!key) return run(noop);
  const hash = await sha256Hex(`${scope}\n${canonicalJson(body)}`);
  // Claim: a fresh key, an expired one, or a stale claim of the same body (a Worker died mid-send).
  const claimed = await env.DB.prepare(
    `INSERT INTO send_keys (account_id, key, body_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(account_id, key) DO UPDATE SET body_hash = excluded.body_hash, created_at = excluded.created_at,
       expires_at = excluded.expires_at, response_json = NULL, message_id = NULL
     WHERE send_keys.expires_at <= ?4
        OR (send_keys.response_json IS NULL AND send_keys.created_at <= ?6 AND send_keys.body_hash = excluded.body_hash)
     RETURNING key`,
  )
    .bind(accountId, key, hash, now, now + IDEMPOTENCY_TTL_MS, now - PENDING_LEASE_MS)
    .first<{ key: string }>();
  if (!claimed) {
    const row = await env.DB.prepare("SELECT body_hash, response_json, created_at FROM send_keys WHERE account_id = ? AND key = ?")
      .bind(accountId, key)
      .first<{ body_hash: string; response_json: string | null; created_at: number }>();
    if (row && row.body_hash !== hash)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This Idempotency-Key was already used for a different request.",
        "Use a new key for a new message; reuse a key only to retry the exact same request (same route, target and body) within 24 h.",
      );
    if (row && row.response_json === null) {
      const wait = Math.max(1, Math.ceil((row.created_at + PENDING_LEASE_MS - now) / 1000));
      throw new ApiError(
        409,
        "idempotency_in_progress",
        "A request with this Idempotency-Key is still being sent.",
        "Retry the same request in a few seconds to get its result; do not send it with a new key, or it may go out twice.",
        { retry_after_s: Math.min(wait, 10) },
      );
    }
    if (row?.response_json) return { ...(JSON.parse(row.response_json) as T), idempotent_replay: true };
    // The row vanished between the claim and the read (a failed send released it): run normally.
    if (attempt < 2) return withIdempotency(env, accountId, key, scope, body, run, now, attempt + 1);
    throw new ApiError(503, "unavailable", "Could not claim the Idempotency-Key.", "Retry the same request in a moment.");
  }

  let accepted: { provider_message_id: string | null; message_id: string } | null = null;
  try {
    const res = await run({ accepted: (info) => void (accepted = info) });
    await env.DB.prepare("UPDATE send_keys SET response_json = ?, message_id = ? WHERE account_id = ? AND key = ?")
      .bind(JSON.stringify(res), res.message?.id ?? null, accountId, key)
      .run()
      .catch((e) => console.error("idempotency: storing the response failed", e));
    return res;
  } catch (e) {
    const sent = accepted as { provider_message_id: string | null; message_id: string } | null;
    if (sent) {
      // The mail went out; only keeping the copy failed. A retry must not send it again.
      const partial = {
        message: { id: sent.message_id },
        provider_message_id: sent.provider_message_id,
        stored: false,
        note: "The message was sent, but storing its copy here failed. Do not send it again.",
      };
      await env.DB.prepare("UPDATE send_keys SET response_json = ?, message_id = ? WHERE account_id = ? AND key = ?")
        .bind(JSON.stringify(partial), sent.message_id, accountId, key)
        .run()
        .catch(() => {});
    } else {
      await env.DB.prepare("DELETE FROM send_keys WHERE account_id = ? AND key = ? AND response_json IS NULL")
        .bind(accountId, key)
        .run()
        .catch(() => {});
    }
    throw e;
  }
}

/** Cron: idempotency keys past their 24 h. */
export async function purgeSendKeys(env: AppEnv, now = Date.now()) {
  const r = await env.DB.prepare("DELETE FROM send_keys WHERE rowid IN (SELECT rowid FROM send_keys WHERE expires_at < ? LIMIT 5000)")
    .bind(now)
    .run();
  return { send_keys_purged: r.meta.changes ?? 0 };
}
