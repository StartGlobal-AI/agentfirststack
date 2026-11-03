import { ApiError, badRequest, notFound, randomString, sha256Hex } from "@afs/shared";
import type { ContainerConfig } from "../config/schema";
import { parseConfig } from "../config/validate";
import type { Bindings } from "../env";
import { mergePatch } from "../lib/merge-patch";
import { assertConfigObject, type ContainerRow, draftConfig, draftValidation, getContainerRow, syncToDO } from "./containers";
import { limits, shownCap } from "./limits";
import { purgeScriptCache } from "./script";

function invalidDraft(errors: { path: string; message: string; hint: string }[]) {
  return new ApiError(
    400,
    "invalid_config",
    "The config doesn't match the schema.",
    "Fix the fields in details (GET /v1/schema has an example for every type) and retry.",
    errors,
  );
}

/** Every publish copies the draft into an immutable version, so its size is capped (MAX_DRAFT_BYTES). */
export function assertDraftSize(env: Bindings, json: string) {
  const max = limits(env).maxDraftBytes;
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

async function writeDraft(env: Bindings, row: ContainerRow, config: ContainerConfig, expectedRevision?: number) {
  if (expectedRevision !== undefined && expectedRevision !== row.draft_revision) {
    throw new ApiError(
      409,
      "revision_conflict",
      `The draft is at revision ${row.draft_revision}, not ${expectedRevision}.`,
      "GET the draft again, re-apply your change, and retry with the new revision.",
    );
  }
  const json = JSON.stringify(config);
  assertDraftSize(env, json);
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

export async function publish(env: Bindings, accountId: string, id: string, opts: { note?: string; keyId?: string; origins: string[] }) {
  const row = await getContainerRow(env, accountId, id);
  const validation = await draftValidation(env, row);
  if (!validation.valid) {
    throw new ApiError(
      422,
      "validation_failed",
      `The draft has ${validation.errors.length} error(s); nothing was published.`,
      "Fix the errors in details (POST /draft/validate shows them with hints), then publish again.",
      validation.errors,
    );
  }
  // A draft saved before MAX_DRAFT_BYTES existed (or was lowered) can't be copied into a version.
  assertDraftSize(env, row.draft);
  const now = Date.now();
  const last = await env.DB.prepare("SELECT MAX(version) AS v FROM container_versions WHERE container_id = ?")
    .bind(id)
    .first<{ v: number | null }>();
  const version = (last?.v ?? 0) + 1;
  const keep = limits(env).maxVersions;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO container_versions (container_id, version, config, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, version, row.draft, opts.note ?? null, opts.keyId ?? null, now),
    env.DB.prepare("UPDATE containers SET live_version = ?, published_at = ?, updated_at = ? WHERE id = ?").bind(version, now, now, id),
    // Keep the newest MAX_VERSIONS_PER_CONTAINER versions; never the live one (it's the new one here).
    ...(Number.isFinite(keep)
      ? [
          env.DB.prepare(
            `DELETE FROM container_versions WHERE container_id = ?1 AND version != ?2
               AND version NOT IN (SELECT version FROM container_versions WHERE container_id = ?1 ORDER BY version DESC LIMIT ?3)`,
          ).bind(id, version, keep),
        ]
      : []),
  ]);
  const next = { ...row, live_version: version, published_at: now };
  await syncToDO(env, next, { config: true, destinations: true });
  await purgeScriptCache(id, opts.origins);
  return { version, published_at: now, validation, row: next };
}

export async function listVersions(env: Bindings, accountId: string, id: string) {
  const row = await getContainerRow(env, accountId, id);
  const { results } = await env.DB.prepare(
    "SELECT version, config, note, created_by, created_at FROM container_versions WHERE container_id = ? ORDER BY version DESC",
  )
    .bind(id)
    .all<{ version: number; config: string; note: string | null; created_by: string | null; created_at: number }>();
  return {
    live_version: row.live_version,
    max_versions: shownCap(limits(env).maxVersions),
    versions: results.map((v) => {
      const c = JSON.parse(v.config) as ContainerConfig;
      return {
        version: v.version,
        live: v.version === row.live_version,
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
  const v = await env.DB.prepare("SELECT version FROM container_versions WHERE container_id = ? AND version = ?").bind(id, version).first();
  if (!v)
    throw notFound(
      `Version ${version}`,
      `GET /v1/containers/${id}/versions lists published versions (only the newest max_versions are kept).`,
    );
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

export async function createPreview(env: Bindings, accountId: string, id: string, opts: { ttl_minutes?: number; path?: string }) {
  const row = await getContainerRow(env, accountId, id);
  const ttl = Math.min(Math.max(opts.ttl_minutes ?? 60, 5), PREVIEW_TTL_MAX_MIN);
  const token = `prv_${randomString(24)}`;
  const now = Date.now();
  const expires = now + ttl * 60_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM preview_tokens WHERE container_id = ? AND expires_at < ?").bind(id, now),
    env.DB.prepare("INSERT INTO preview_tokens (token_hash, container_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(
      await sha256Hex(token),
      id,
      expires,
      now,
    ),
  ]);
  const path = opts.path ? (opts.path.startsWith("/") ? opts.path : `/${opts.path}`) : "/";
  if (/[\s<>"]/.test(path)) throw badRequest("path must be a URL path like /pricing.");
  return { row, token, expires_at: expires, path };
}

/** Container id for a valid, unexpired preview token, else null. */
export async function previewContainer(env: Bindings, token: string): Promise<string | null> {
  if (!/^prv_[a-z0-9]{24}$/.test(token)) return null;
  const r = await env.DB.prepare("SELECT container_id FROM preview_tokens WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(token), Date.now())
    .first<{ container_id: string }>();
  return r?.container_id ?? null;
}
