import { ApiError, accountStanding, badRequest, notFound } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { getContainerRow } from "./containers";
import { limits, shownCap } from "./limits";
import { accountTagsBytes } from "./versions";

/**
 * Lookup tables for server-side enrichment: a destination's settings.params.set can read one
 * ({ lookup, key }), e.g. SKU -> margin to send profit instead of revenue. Stored in D1 as one row
 * per table, read by the queue consumer, never sent to browsers. Capped per container
 * (MAX_LOOKUPS_PER_CONTAINER), in rows (MAX_LOOKUP_ROWS) and bytes (MAX_LOOKUP_BYTES), and counted
 * in the account's MAX_TAGS_BYTES_PER_ACCOUNT. PUT replaces the table (idempotent).
 */

export const lookupName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/, "Letters, digits, _ . - (start with a letter or _), max 64.");
export const lookupInput = z.strictObject({
  rows: z
    .record(z.string().min(1).max(200), z.union([z.string().max(500), z.number(), z.boolean()]))
    .describe('{ "<key>": <value> }, e.g. { "SKU-1": 12.5, "SKU-2": 4 }.'),
  description: z.string().max(500).optional(),
});

const bytesOf = (s: string) => new TextEncoder().encode(s).byteLength;

export async function putLookup(env: Bindings, accountId: string, containerId: string, name: string, input: z.infer<typeof lookupInput>) {
  await getContainerRow(env, accountId, containerId);
  if (!lookupName.safeParse(name).success)
    throw badRequest(
      `"${name}" isn't a valid lookup name.`,
      "Use letters, digits, _ . - (start with a letter or _), max 64, e.g. sku_margin.",
    );
  const caps = limits(env, await accountStanding(env, accountId));
  const count = Object.keys(input.rows).length;
  if (count > caps.maxLookupRows)
    throw new ApiError(
      413,
      "lookup_too_large",
      `The table has ${count} rows; the most allowed here is ${caps.maxLookupRows}.`,
      "Split it, or keep only the keys your events carry.",
    );
  const json = JSON.stringify(input.rows);
  const bytes = bytesOf(json);
  if (bytes > caps.maxLookupBytes)
    throw new ApiError(
      413,
      "lookup_too_large",
      `The table is ${bytes} bytes; the most allowed here is ${caps.maxLookupBytes}.`,
      "Shorten keys and values, or split the table.",
    );
  const prev = await env.DB.prepare("SELECT rows, bytes FROM lookups WHERE container_id = ? AND name = ?")
    .bind(containerId, name)
    .first<{ rows: string; bytes: number }>();
  if (prev && prev.rows === json) return { name, rows: count, bytes, existing: true, updated: false };
  if (!prev && Number.isFinite(caps.maxLookups)) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM lookups WHERE container_id = ?").bind(containerId).first<{ n: number }>();
    if ((n?.n ?? 0) >= caps.maxLookups)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This container already has ${caps.maxLookups} lookup tables, the most allowed here.`,
        `Delete one (DELETE /v1/containers/${containerId}/lookups/:name) or merge tables.`,
      );
  }
  if (Number.isFinite(caps.maxAccountBytes) && bytes > (prev?.bytes ?? 0)) {
    const projected = (await accountTagsBytes(env, accountId)) - (prev?.bytes ?? 0) + bytes;
    if (projected > caps.maxAccountBytes)
      throw new ApiError(
        413,
        "storage_quota_exceeded",
        `This account's drafts, versions and lookups would use ${projected} bytes; the most allowed here is ${caps.maxAccountBytes}.`,
        "Shrink or delete lookup tables or drafts.",
      );
  }
  await env.DB.prepare(
    `INSERT INTO lookups (container_id, name, rows, row_count, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(container_id, name) DO UPDATE SET rows = excluded.rows, row_count = excluded.row_count, bytes = excluded.bytes, updated_at = excluded.updated_at`,
  )
    .bind(containerId, name, json, count, bytes, Date.now())
    .run();
  return { name, rows: count, bytes, existing: !!prev, updated: true };
}

export async function listLookups(env: Bindings, accountId: string, containerId: string) {
  await getContainerRow(env, accountId, containerId);
  const { results } = await env.DB.prepare("SELECT name, row_count, bytes, updated_at FROM lookups WHERE container_id = ? ORDER BY name")
    .bind(containerId)
    .all<{ name: string; row_count: number; bytes: number; updated_at: number }>();
  const caps = limits(env, await accountStanding(env, accountId));
  return {
    lookups: results.map((r) => ({ name: r.name, rows: r.row_count, bytes: r.bytes, updated_at: r.updated_at })),
    limits: { tables: shownCap(caps.maxLookups), rows: shownCap(caps.maxLookupRows), bytes: shownCap(caps.maxLookupBytes) },
  };
}

export async function getLookup(env: Bindings, accountId: string, containerId: string, name: string) {
  await getContainerRow(env, accountId, containerId);
  const r = await env.DB.prepare("SELECT rows, row_count, bytes, updated_at FROM lookups WHERE container_id = ? AND name = ?")
    .bind(containerId, name)
    .first<{ rows: string; row_count: number; bytes: number; updated_at: number }>();
  if (!r)
    throw notFound(
      `Lookup "${name}"`,
      `GET /v1/containers/${containerId}/lookups lists them; PUT /v1/containers/${containerId}/lookups/${name} { rows } creates it.`,
    );
  return { name, rows: JSON.parse(r.rows) as Record<string, unknown>, row_count: r.row_count, bytes: r.bytes, updated_at: r.updated_at };
}

export async function deleteLookup(env: Bindings, accountId: string, containerId: string, name: string) {
  await getContainerRow(env, accountId, containerId);
  const r = await env.DB.prepare("DELETE FROM lookups WHERE container_id = ? AND name = ?").bind(containerId, name).run();
  return { deleted: name, existed: (r.meta.changes ?? 0) > 0 };
}
