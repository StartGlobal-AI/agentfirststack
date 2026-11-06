import { ApiError, accountStanding, badRequest, hmacSha256Hex, newId, notFound, randomString, sha256Hex } from "@afs/shared";
import { z } from "zod";
import type { ContainerConfig } from "../config/schema";
import type { Bindings } from "../env";
import { getContainerRow } from "./containers";
import { limits } from "./limits";
import { assertCodeSafe, codeGate, customCodeProblem } from "./verify";

/**
 * Environments (GTM's): a named snippet `/c/:id.js?env=<token>` that serves a pinned version, or
 * the draft, to a staging site. Its hits are real traffic (not test mode), matched against that
 * environment's config. The token is HMAC(ENCRYPTION_KEY, id + nonce), so the snippet can be shown
 * again; reauthorize changes the nonce (the old snippet stops working). Pinned versions are never
 * pruned by publish. A draft-pinned environment leaves custom code out unless publish would allow it.
 */

export const environmentInput = z.strictObject({
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/, "Letters, digits, space, _ . - (max 40), e.g. staging.")
    .describe("Shown by the environment built-in variable, e.g. staging."),
  version: z
    .union([z.number().int().positive(), z.literal("draft")])
    .describe('A version number (GET /versions; POST /versions saves the draft as one without publishing) or "draft".'),
});
export const environmentPatch = z.strictObject({
  name: environmentInput.shape.name.optional(),
  version: environmentInput.shape.version.optional().describe('Publish to this environment: a version number or "draft".'),
});

export interface EnvironmentRow {
  id: string;
  container_id: string;
  account_id: string;
  name: string;
  version: number | null;
  nonce: string;
  token_hash: string;
  created_at: number;
  updated_at: number;
}

const RESERVED = new Set(["live", "preview"]);

function keyOf(env: Bindings): string {
  if (!env.ENCRYPTION_KEY)
    throw new ApiError(
      500,
      "not_configured",
      "ENCRYPTION_KEY is not set on this deployment.",
      "The operator must set the ENCRYPTION_KEY secret.",
    );
  return env.ENCRYPTION_KEY;
}

export async function environmentToken(env: Bindings, row: Pick<EnvironmentRow, "id" | "nonce">) {
  return `envt_${(await hmacSha256Hex(keyOf(env), `afs-tags-env:${row.id}:${row.nonce}`)).slice(0, 32)}`;
}

export async function presentEnvironment(env: Bindings, base: string, row: EnvironmentRow, domain: string) {
  const token = await environmentToken(env, row);
  return {
    id: row.id,
    container_id: row.container_id,
    name: row.name,
    version: row.version ?? "draft",
    script_url: `${base}/c/${row.container_id}.js?env=${token}`,
    snippet: `<script async src="${base}/c/${row.container_id}.js?env=${token}"></script>`,
    note: `Install this snippet instead of the live one on the ${row.name} site (its host must be ${domain}, a subdomain, or in allowed_hostnames).`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getRow(env: Bindings, accountId: string, containerId: string, id: string) {
  const row = await env.DB.prepare("SELECT * FROM environments WHERE id = ? AND container_id = ? AND account_id = ?")
    .bind(id, containerId, accountId)
    .first<EnvironmentRow>();
  if (!row) throw notFound("Environment", `GET /v1/containers/${containerId}/environments lists them.`);
  return row;
}

async function checkVersion(
  env: Bindings,
  container: { id: string; domain: string; account_id: string; verified_at?: number | null },
  v: number | "draft",
) {
  if (v === "draft") return null;
  const r = await env.DB.prepare("SELECT config FROM container_versions WHERE container_id = ? AND version = ?")
    .bind(container.id, v)
    .first<{ config: string }>();
  if (!r)
    throw notFound(
      `Version ${v}`,
      `GET /v1/containers/${container.id}/versions lists the versions kept (POST /versions saves the draft as one).`,
    );
  // Serving a version is publishing it to that environment: the same custom-code rules apply.
  const cfg = JSON.parse(r.config) as ContainerConfig;
  await assertCodeSafe(env, container, cfg, `version ${v} isn't served`);
  const { standing, pause } = await codeGate(env, container.account_id);
  const custom = customCodeProblem(env, container, cfg, standing, pause);
  if (custom) throw new ApiError(422, "validation_failed", `Version ${v} can't be served: ${custom.message}`, custom.hint, [custom]);
  return v;
}

export async function createEnvironment(env: Bindings, accountId: string, containerId: string, input: z.infer<typeof environmentInput>) {
  const container = await getContainerRow(env, accountId, containerId);
  if (RESERVED.has(input.name.toLowerCase()))
    throw badRequest(`"${input.name}" is reserved (the environment built-in uses it).`, 'Pick another name, e.g. "staging".');
  const found = await env.DB.prepare("SELECT * FROM environments WHERE container_id = ? AND name = ?")
    .bind(containerId, input.name)
    .first<EnvironmentRow>();
  if (found) return { row: found, container, existing: true };
  const max = limits(env, await accountStanding(env, accountId)).maxEnvironments;
  if (Number.isFinite(max)) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM environments WHERE container_id = ?")
      .bind(containerId)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This container already has ${max} environments, the most allowed here.`,
        `Delete one you no longer use (DELETE /v1/containers/${containerId}/environments/:eid), or re-point one with PATCH { version }.`,
      );
  }
  const version = await checkVersion(env, container, input.version);
  const now = Date.now();
  const row: EnvironmentRow = {
    id: newId("env"),
    container_id: containerId,
    account_id: accountId,
    name: input.name,
    version,
    nonce: randomString(16),
    token_hash: "",
    created_at: now,
    updated_at: now,
  };
  row.token_hash = await sha256Hex(await environmentToken(env, row));
  try {
    await env.DB.prepare(
      "INSERT INTO environments (id, container_id, account_id, name, version, nonce, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(row.id, containerId, accountId, row.name, row.version, row.nonce, row.token_hash, now, now)
      .run();
  } catch (e) {
    const again = await env.DB.prepare("SELECT * FROM environments WHERE container_id = ? AND name = ?")
      .bind(containerId, input.name)
      .first<EnvironmentRow>();
    if (again) return { row: again, container, existing: true };
    throw e;
  }
  return { row, container, existing: false };
}

export async function listEnvironments(env: Bindings, accountId: string, containerId: string) {
  const container = await getContainerRow(env, accountId, containerId);
  const { results } = await env.DB.prepare("SELECT * FROM environments WHERE container_id = ? ORDER BY created_at")
    .bind(containerId)
    .all<EnvironmentRow>();
  return { container, rows: results, max: limits(env, await accountStanding(env, accountId)).maxEnvironments };
}

export async function getEnvironment(env: Bindings, accountId: string, containerId: string, id: string) {
  return { container: await getContainerRow(env, accountId, containerId), row: await getRow(env, accountId, containerId, id) };
}

export async function updateEnvironment(
  env: Bindings,
  accountId: string,
  containerId: string,
  id: string,
  input: z.infer<typeof environmentPatch>,
) {
  const container = await getContainerRow(env, accountId, containerId);
  const row = await getRow(env, accountId, containerId, id);
  if (input.name && RESERVED.has(input.name.toLowerCase()))
    throw badRequest(`"${input.name}" is reserved.`, 'Pick another name, e.g. "staging".');
  const version = input.version === undefined ? row.version : await checkVersion(env, container, input.version);
  const next = { ...row, name: input.name ?? row.name, version, updated_at: Date.now() };
  try {
    await env.DB.prepare("UPDATE environments SET name = ?, version = ?, updated_at = ? WHERE id = ?")
      .bind(next.name, next.version, next.updated_at, id)
      .run();
  } catch {
    throw new ApiError(409, "conflict", `An environment named "${next.name}" already exists.`, "Pick another name.");
  }
  return { container, row: next };
}

export async function reauthorizeEnvironment(env: Bindings, accountId: string, containerId: string, id: string) {
  const container = await getContainerRow(env, accountId, containerId);
  const row = await getRow(env, accountId, containerId, id);
  const next = { ...row, nonce: randomString(16), updated_at: Date.now() };
  next.token_hash = await sha256Hex(await environmentToken(env, next));
  await env.DB.prepare("UPDATE environments SET nonce = ?, token_hash = ?, updated_at = ? WHERE id = ?")
    .bind(next.nonce, next.token_hash, next.updated_at, id)
    .run();
  return { container, row: next };
}

export async function deleteEnvironment(env: Bindings, accountId: string, containerId: string, id: string) {
  await getRow(env, accountId, containerId, id);
  await env.DB.prepare("DELETE FROM environments WHERE id = ?").bind(id).run();
}

/** The environment a snippet token belongs to, with its config (data plane; no account check). */
export async function environmentByToken(env: Bindings, containerId: string, token: string) {
  if (!/^envt_[a-f0-9]{32}$/.test(token)) return null;
  const r = await env.DB.prepare(
    `SELECT e.name, e.version, c.draft, v.config FROM environments e JOIN containers c ON c.id = e.container_id
       LEFT JOIN container_versions v ON v.container_id = e.container_id AND v.version = e.version
     WHERE e.token_hash = ? AND e.container_id = ?`,
  )
    .bind(await sha256Hex(token), containerId)
    .first<{ name: string; version: number | null; draft: string; config: string | null }>()
    .catch(() => null);
  if (!r) return null;
  if (r.version != null && !r.config) return null; // its version was deleted (it can't be: pinned versions are kept)
  return { name: r.name, version: r.version, config: JSON.parse(r.version == null ? r.draft : r.config!) as ContainerConfig };
}
