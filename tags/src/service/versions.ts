import { ApiError, accountStanding, badRequest, notFound, randomString, sha256Hex, type Standing } from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import { parseConfig, validateConfig } from "../config/validate";
import type { Bindings } from "../env";
import { mergePatch } from "../lib/merge-patch";
import { assertConfigObject, type ContainerRow, draftConfig, draftValidation, getContainerRow, syncToDO } from "./containers";
import { limits, shownCap } from "./limits";
import { purgeScriptCache } from "./script";
import { assertCustomCodeSize, customCodeProblem } from "./verify";

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

/** Bytes of all drafts + kept versions + lookup tables of an account's containers (what MAX_TAGS_BYTES_PER_ACCOUNT caps). */
export async function accountTagsBytes(env: Bindings, accountId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(LENGTH(CAST(draft AS BLOB))), 0) FROM containers WHERE account_id = ?1)
          + (SELECT COALESCE(SUM(LENGTH(CAST(v.config AS BLOB))), 0) FROM container_versions v
               JOIN containers c ON c.id = v.container_id WHERE c.account_id = ?1)
          + (SELECT COALESCE(SUM(l.bytes), 0) FROM lookups l JOIN containers c ON c.id = l.container_id WHERE c.account_id = ?1) AS bytes`,
  )
    .bind(accountId)
    .first<{ bytes: number }>();
  return r?.bytes ?? 0;
}

function accountBytesExceeded(used: number, max: number) {
  return new ApiError(
    413,
    "storage_quota_exceeded",
    `This account's drafts and versions would use ${used} bytes; the most allowed here is ${max}.`,
    "Shrink drafts (load large custom code from your own URL), or delete containers you no longer need (DELETE /v1/containers/:id); publish keeps only the newest versions.",
  );
}

/** A draft write may not grow the account past MAX_TAGS_BYTES_PER_ACCOUNT (shrinking is always allowed). */
async function assertAccountBytes(env: Bindings, row: ContainerRow, standing: Standing, newBytes: number) {
  const max = limits(env, standing).maxAccountBytes;
  if (!Number.isFinite(max)) return;
  const oldBytes = byteLength(row.draft);
  if (newBytes <= oldBytes) return;
  const projected = (await accountTagsBytes(env, row.account_id)) - oldBytes + newBytes;
  if (projected > max) throw accountBytesExceeded(projected, max);
}

export function invalidDraft(errors: { path: string; message: string; hint: string }[]) {
  return new ApiError(
    400,
    "invalid_config",
    "The config doesn't match the schema.",
    "Fix the fields in details (GET /v1/schema has an example for every type) and retry.",
    errors,
  );
}

/** Every publish copies the draft into an immutable version, so its size is capped (MAX_DRAFT_BYTES). */
export function assertDraftSize(env: Bindings, json: string, standing?: Standing) {
  const max = limits(env, standing).maxDraftBytes;
  if (!Number.isFinite(max)) return;
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > max) {
    throw new ApiError(
      413,
      "draft_too_large",
      `The draft is ${bytes} bytes; the most allowed here is ${max}.`,
      "Shrink it: load large custom_html/custom_js code from your own URL (<script src=...>) instead of inlining it, and drop unused tags, triggers and variables.",
    );
  }
}

export async function writeDraft(env: Bindings, row: ContainerRow, config: ContainerConfig, expectedRevision?: number) {
  if (expectedRevision !== undefined && expectedRevision !== row.draft_revision) {
    throw new ApiError(
      409,
      "revision_conflict",
      `The draft is at revision ${row.draft_revision}, not ${expectedRevision}.`,
      "GET the draft again, re-apply your change, and retry with the new revision.",
    );
  }
  const json = JSON.stringify(config);
  const standing = await accountStanding(env, row.account_id);
  assertDraftSize(env, json, standing);
  assertCustomCodeSize(env, config, standing);
  await assertAccountBytes(env, row, standing, byteLength(json));
  const now = Date.now();
  const res = await env.DB.prepare(
    "UPDATE containers SET draft = ?, draft_revision = draft_revision + 1, draft_updated_at = ?, updated_at = ? WHERE id = ? AND draft_revision = ?",
  )
    .bind(json, now, now, row.id, row.draft_revision)
    .run();
  if (!res.meta.changes)
    throw new ApiError(409, "revision_conflict", "The draft changed while this update was being applied.", "GET the draft and retry.");
  return { ...row, draft: json, draft_revision: row.draft_revision + 1, draft_updated_at: now };
}

export async function getDraft(env: Bindings, accountId: string, id: string) {
  const row = await getContainerRow(env, accountId, id);
  return { row, config: draftConfig(row), validation: await draftValidation(env, row) };
}

/** PUT: full replace. Structurally invalid configs are rejected; semantic problems are reported. */
export async function putDraft(env: Bindings, accountId: string, id: string, body: unknown, expectedRevision?: number) {
  assertConfigObject(body);
  const parsed = parseConfig(body);
  if (!parsed.ok) throw invalidDraft(parsed.errors);
  const row = await writeDraft(env, await getContainerRow(env, accountId, id), parsed.config, expectedRevision);
  return { row, config: parsed.config, validation: await draftValidation(env, row) };
}

/** PATCH: RFC 7396 JSON merge patch (objects merge, null deletes, arrays replace). */
export async function patchDraft(env: Bindings, accountId: string, id: string, patch: unknown, expectedRevision?: number) {
  assertConfigObject(patch);
  const row = await getContainerRow(env, accountId, id);
  const merged = mergePatch(draftConfig(row), patch);
  const parsed = parseConfig(merged);
  if (!parsed.ok) throw invalidDraft(parsed.errors);
  const next = await writeDraft(env, row, parsed.config, expectedRevision);
  return { row: next, config: parsed.config, validation: await draftValidation(env, next) };
}

export async function validateDraft(env: Bindings, accountId: string, id: string, config?: unknown) {
  const row = await getContainerRow(env, accountId, id);
  return draftValidation(env, row, config);
}

/** Versions an environment is pinned to (publish never prunes them). */
const PINNED = "SELECT version FROM environments WHERE container_id = ?1 AND version IS NOT NULL";

function invalidForVersion(validation: { errors: unknown[] }, what: string) {
  return new ApiError(
    422,
    "validation_failed",
    `The draft has ${validation.errors.length} error(s); ${what}.`,
    "Fix the errors in details (POST /draft/validate shows them with hints), then try again.",
    validation.errors,
  );
}

/**
 * Copy the draft into a new immutable version (optionally making it live), keeping the newest
 * MAX_VERSIONS_PER_CONTAINER; the live version and versions pinned by an environment are never pruned.
 */
async function saveVersion(env: Bindings, row: ContainerRow, opts: { note?: string; keyId?: string; live: boolean }) {
  const id = row.id;
  const standing = await accountStanding(env, row.account_id);
  // A draft saved before MAX_DRAFT_BYTES existed (or was lowered) can't be copied into a version.
  assertDraftSize(env, row.draft, standing);
  const caps = limits(env, standing);
  const keep = caps.maxVersions;
  const { results: kept } = await env.DB.prepare(
    "SELECT version, LENGTH(CAST(config AS BLOB)) AS bytes FROM container_versions WHERE container_id = ? ORDER BY version DESC",
  )
    .bind(id)
    .all<{ version: number; bytes: number }>();
  if (Number.isFinite(caps.maxAccountBytes)) {
    // The new version adds the draft's bytes; versions past the newest `keep` are pruned below.
    const pruned = Number.isFinite(keep) ? kept.slice(Math.max(keep - 1, 0)).reduce((n, v) => n + v.bytes, 0) : 0;
    const projected = (await accountTagsBytes(env, row.account_id)) + byteLength(row.draft) - pruned;
    if (projected > caps.maxAccountBytes) throw accountBytesExceeded(projected, caps.maxAccountBytes);
  }
  const now = Date.now();
  const version = (kept[0]?.version ?? 0) + 1;
  const live = opts.live ? version : row.live_version;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO container_versions (container_id, version, config, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, version, row.draft, opts.note ?? null, opts.keyId ?? null, now),
    ...(opts.live
      ? [
          env.DB.prepare("UPDATE containers SET live_version = ?, published_at = ?, updated_at = ? WHERE id = ?").bind(
            version,
            now,
            now,
            id,
          ),
        ]
      : []),
    // Keep the newest MAX_VERSIONS_PER_CONTAINER versions; never the live one or an environment's.
    ...(Number.isFinite(keep)
      ? [
          env.DB.prepare(
            `DELETE FROM container_versions WHERE container_id = ?1 AND version != ?2 AND version != ?4
               AND version NOT IN (${PINNED})
               AND version NOT IN (SELECT version FROM container_versions WHERE container_id = ?1 ORDER BY version DESC LIMIT ?3)`,
          ).bind(id, version, keep, live ?? version),
        ]
      : []),
  ]);
  return { version, now };
}

export async function publish(
  env: Bindings,
  accountId: string,
  id: string,
  opts: { note?: string; keyId?: string; origins: string[]; version?: number },
) {
  const row = await getContainerRow(env, accountId, id);
  // Publishing a saved version: the same as rollback (its custom code is checked again).
  if (opts.version !== undefined) {
    const r = await rollback(env, accountId, id, opts.version, opts.origins);
    const validation = validateConfig((await getVersion(env, accountId, id, opts.version)).config, { domain: row.domain });
    return { version: r.live_version, published_at: r.rolled_back_at, validation, row: { ...row, live_version: r.live_version } };
  }
  const validation = await draftValidation(env, row);
  if (!validation.valid) throw invalidForVersion(validation, "nothing was published");
  const { version, now } = await saveVersion(env, row, { note: opts.note, keyId: opts.keyId, live: true });
  const next = { ...row, live_version: version, published_at: now };
  await syncToDO(env, next, { config: true, destinations: true });
  await purgeScriptCache(id, opts.origins);
  return { version, published_at: now, validation, row: next };
}

/**
 * Save the draft as a version without publishing it (GTM's "create version"), e.g. to pin an
 * environment to it or publish it later. A draft identical to the newest version returns that
 * version (existing: true), so retries don't pile up copies.
 */
export async function createVersion(env: Bindings, accountId: string, id: string, opts: { note?: string; keyId?: string }) {
  const row = await getContainerRow(env, accountId, id);
  const newest = await env.DB.prepare("SELECT version, config FROM container_versions WHERE container_id = ? ORDER BY version DESC LIMIT 1")
    .bind(id)
    .first<{ version: number; config: string }>();
  const validation = await draftValidation(env, row);
  if (newest && newest.config === row.draft) return { version: newest.version, existing: true, validation, row };
  if (!validation.valid) throw invalidForVersion(validation, "no version was saved");
  const { version } = await saveVersion(env, row, { note: opts.note, keyId: opts.keyId, live: false });
  return { version, existing: false, validation, row };
}

export async function listVersions(env: Bindings, accountId: string, id: string) {
  const row = await getContainerRow(env, accountId, id);
  const { results } = await env.DB.prepare(
    "SELECT version, config, note, created_by, created_at FROM container_versions WHERE container_id = ? ORDER BY version DESC",
  )
    .bind(id)
    .all<{ version: number; config: string; note: string | null; created_by: string | null; created_at: number }>();
  const { results: envs } = await env.DB.prepare("SELECT name, version FROM environments WHERE container_id = ? AND version IS NOT NULL")
    .bind(id)
    .all<{ name: string; version: number }>()
    .catch(() => ({ results: [] as { name: string; version: number }[] }));
  return {
    live_version: row.live_version,
    max_versions: shownCap(limits(env, await accountStanding(env, row.account_id)).maxVersions),
    versions: results.map((v) => {
      const c = JSON.parse(v.config) as ContainerConfig;
      return {
        version: v.version,
        live: v.version === row.live_version,
        environments: envs.filter((e) => e.version === v.version).map((e) => e.name),
        note: v.note,
        created_at: v.created_at,
        created_by: v.created_by,
        summary: {
          tags: c.tags?.length ?? 0,
          triggers: c.triggers?.length ?? 0,
          conversions: c.conversions?.length ?? 0,
          variables: c.variables?.length ?? 0,
        },
      };
    }),
  };
}

export async function getVersion(env: Bindings, accountId: string, id: string, version: number) {
  const row = await getContainerRow(env, accountId, id);
  const v = await env.DB.prepare(
    "SELECT version, config, note, created_by, created_at FROM container_versions WHERE container_id = ? AND version = ?",
  )
    .bind(id, version)
    .first<{ version: number; config: string; note: string | null; created_by: string | null; created_at: number }>();
  if (!v)
    throw notFound(
      `Version ${version}`,
      `GET /v1/containers/${id}/versions lists published versions (only the newest max_versions are kept).`,
    );
  return {
    version: v.version,
    live: v.version === row.live_version,
    note: v.note,
    created_at: v.created_at,
    created_by: v.created_by,
    config: JSON.parse(v.config) as ContainerConfig,
  };
}

/** Point the live pointer at an earlier immutable version. The draft is left unchanged. */
export async function rollback(env: Bindings, accountId: string, id: string, version: number, origins: string[]) {
  const row = await getContainerRow(env, accountId, id);
  const v = await env.DB.prepare("SELECT version, config FROM container_versions WHERE container_id = ? AND version = ?")
    .bind(id, version)
    .first<{ version: number; config: string }>();
  if (!v)
    throw notFound(
      `Version ${version}`,
      `GET /v1/containers/${id}/versions lists published versions (only the newest max_versions are kept).`,
    );
  // Rolling back republishes that version, so the same custom-code rules as publish apply.
  const custom = customCodeProblem(env, row, JSON.parse(v.config) as ContainerConfig, await accountStanding(env, row.account_id));
  if (custom) throw new ApiError(422, "validation_failed", `Version ${version} can't go live: ${custom.message}`, custom.hint, [custom]);
  const now = Date.now();
  await env.DB.prepare("UPDATE containers SET live_version = ?, published_at = ?, updated_at = ? WHERE id = ?")
    .bind(version, now, now, id)
    .run();
  const next = { ...row, live_version: version, published_at: now };
  await syncToDO(env, next, { config: true });
  await purgeScriptCache(id, origins);
  return { live_version: version, previous_version: row.live_version, rolled_back_at: now };
}

export const PREVIEW_TTL_MAX_MIN = 24 * 60;

export async function createPreview(
  env: Bindings,
  accountId: string,
  id: string,
  opts: { ttl_minutes?: number; path?: string; version?: number },
) {
  const row = await getContainerRow(env, accountId, id);
  if (opts.version !== undefined) await getVersion(env, accountId, id, opts.version); // 404 if it isn't kept
  const ttl = Math.min(Math.max(opts.ttl_minutes ?? 60, 5), PREVIEW_TTL_MAX_MIN);
  const token = `prv_${randomString(24)}`;
  const now = Date.now();
  const expires = now + ttl * 60_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM preview_tokens WHERE container_id = ? AND expires_at < ?").bind(id, now),
    env.DB.prepare("INSERT INTO preview_tokens (token_hash, container_id, expires_at, created_at, version) VALUES (?, ?, ?, ?, ?)").bind(
      await sha256Hex(token),
      id,
      expires,
      now,
      opts.version ?? null,
    ),
  ]);
  const path = opts.path ? (opts.path.startsWith("/") ? opts.path : `/${opts.path}`) : "/";
  if (/[\s<>"]/.test(path)) throw badRequest("path must be a URL path like /pricing.");
  return { row, token, expires_at: expires, path, version: opts.version ?? null };
}

/** Container id for a valid, unexpired preview token, else null. */
export async function previewContainer(env: Bindings, token: string): Promise<string | null> {
  return (await previewToken(env, token))?.container_id ?? null;
}

/** A valid, unexpired preview token: its container and the version it shows (null = the draft). */
export async function previewToken(env: Bindings, token: string): Promise<{ container_id: string; version: number | null } | null> {
  if (!/^prv_[a-z0-9]{24}$/.test(token)) return null;
  const r = await env.DB.prepare("SELECT container_id, version FROM preview_tokens WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(token), Date.now())
    .first<{ container_id: string; version: number | null }>();
  return r ? { container_id: r.container_id, version: r.version ?? null } : null;
}

/** The config a preview token shows: the draft, or the version it was created for. */
export async function previewConfig(env: Bindings, containerId: string, version: number | null): Promise<ContainerConfig | null> {
  const r = version
    ? await env.DB.prepare("SELECT config FROM container_versions WHERE container_id = ? AND version = ?")
        .bind(containerId, version)
        .first<{ config: string }>()
    : await env.DB.prepare("SELECT draft AS config FROM containers WHERE id = ?").bind(containerId).first<{ config: string }>();
  return r ? (JSON.parse(r.config) as ContainerConfig) : null;
}
