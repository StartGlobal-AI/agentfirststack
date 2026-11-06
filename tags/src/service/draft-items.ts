import { ApiError, badRequest, notFound } from "@afs/shared";
import type { z } from "zod";
import { type ConfigDiff, diffConfigs, ITEM_KINDS, type ItemKind, itemKey, KEY_FIELD, same } from "../config/diff";
import { type ContainerConfig, conversionSchema, tagSchema, triggerSchema, variableSchema } from "../config/schema";
import { parseConfig } from "../config/validate";
import type { Bindings } from "../env";
import { type ContainerRow, draftConfig, draftValidation, getContainerRow, liveConfig } from "./containers";
import { invalidDraft, writeDraft } from "./versions";

/**
 * Item-level draft edits: PUT/DELETE /draft/{tags,triggers,variables,conversions}/:key and
 * revert one item to the live version. Each edit re-reads the draft, changes one item and writes
 * it back guarded by the revision it read, so a concurrent edit is never overwritten: without an
 * explicit ?revision= the change is re-applied on the newer draft (up to 8 tries, with a short
 * random wait, so a handful of agents editing at once all land); with one, a
 * different revision is a 409 revision_conflict. An edit that changes nothing writes nothing.
 */

const ITEM_SCHEMA: Record<ItemKind, z.ZodType> = {
  tags: tagSchema,
  triggers: triggerSchema,
  variables: variableSchema,
  conversions: conversionSchema,
};

export function parseKind(kind: string): ItemKind {
  if ((ITEM_KINDS as readonly string[]).includes(kind)) return kind as ItemKind;
  throw badRequest(`Unknown draft item kind "${kind}".`, `Use one of: ${ITEM_KINDS.join(", ")} (plural), e.g. PUT /draft/tags/ga4.`);
}

type Item = Record<string, unknown>;

export interface DraftEditResult<T> {
  row: ContainerRow;
  config: ContainerConfig;
  /** false when the edit changed nothing (nothing was written, the revision didn't move). */
  written: boolean;
  result: T;
}

/** Apply `mutate` to the draft and save it, guarded by the revision (see the file comment). */
export async function editDraft<T>(
  env: Bindings,
  accountId: string,
  id: string,
  expectedRevision: number | undefined,
  mutate: (config: ContainerConfig) => { config: ContainerConfig; result: T },
): Promise<DraftEditResult<T>> {
  for (let attempt = 0; ; attempt++) {
    const row = await getContainerRow(env, accountId, id);
    if (expectedRevision !== undefined && expectedRevision !== row.draft_revision) {
      throw new ApiError(
        409,
        "revision_conflict",
        `The draft is at revision ${row.draft_revision}, not ${expectedRevision}.`,
        "GET the draft (or the item) again, re-apply your change, and retry with the new revision, or leave revision out to apply the change on top of the newer draft.",
      );
    }
    const before = draftConfig(row);
    const { config, result } = mutate(structuredClone(before));
    if (same(config, before)) return { row, config: before, written: false, result };
    const parsed = parseConfig(config);
    if (!parsed.ok) throw invalidDraft(parsed.errors);
    try {
      const next = await writeDraft(env, row, parsed.config, row.draft_revision);
      return { row: next, config: parsed.config, written: true, result };
    } catch (e) {
      // Someone else saved between our read and write: re-apply on their draft (no revision given).
      // With N editors at once the last may lose N-1 races, so retry a few times with jitter.
      if (expectedRevision === undefined && e instanceof ApiError && e.code === "revision_conflict" && attempt < 7) {
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 15 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

function list(config: ContainerConfig, kind: ItemKind): Item[] {
  return ((config[kind] as unknown as Item[] | undefined) ?? []).slice();
}

/** Validate one item with its kind's schema; errors carry paths like tags.ga4.params.measurement_id. */
export function parseItem(kind: ItemKind, key: string, raw: unknown): Item {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw badRequest(`The ${kind} item must be a JSON object.`, `GET /v1/schema -> catalog.${kind} has an example of every type.`);
  const field = KEY_FIELD[kind];
  const item = { ...(raw as Item) };
  if (item[field] === undefined) item[field] = key;
  if (item[field] !== key) {
    throw badRequest(
      `The item's ${field} "${String(item[field])}" doesn't match the key in the URL ("${key}").`,
      `Send ${field} "${key}" (or leave it out). To rename, PUT the item under its new ${field} and DELETE the old one.`,
    );
  }
  const r = ITEM_SCHEMA[kind].safeParse(item);
  if (!r.success) {
    throw invalidDraft(
      r.error.issues.map((i) => ({
        path: [kind, key, ...i.path].join("."),
        message: i.message,
        hint: `GET /v1/schema -> catalog.${kind} shows a valid example of each type.`,
      })),
    );
  }
  return r.data as Item;
}

export async function getDraftItem(env: Bindings, accountId: string, id: string, kind: ItemKind, key: string) {
  const row = await getContainerRow(env, accountId, id);
  const item = list(draftConfig(row), kind).find((i) => itemKey(kind, i) === key);
  const live = list((await liveConfig(env, row)) ?? {}, kind).find((i) => itemKey(kind, i) === key);
  if (!item)
    throw notFound(
      `Draft ${kind} item "${key}"`,
      live
        ? `It exists in the live version but not in the draft: POST /v1/containers/${id}/draft/${kind}/${key}/revert restores it.`
        : `GET /v1/containers/${id}/draft lists the draft's ${kind}.`,
    );
  return { row, item, in_live: !!live, differs_from_live: !!live && !same(live, item) };
}

/** Upsert by key: replace the item with that key in place, or append it. */
export function upsertDraftItem(
  env: Bindings,
  accountId: string,
  id: string,
  kind: ItemKind,
  key: string,
  raw: unknown,
  revision?: number,
) {
  const item = parseItem(kind, key, raw);
  return editDraft(env, accountId, id, revision, (config) => {
    const items = list(config, kind);
    const i = items.findIndex((x) => itemKey(kind, x) === key);
    const created = i === -1;
    if (created) items.push(item);
    else items[i] = item;
    (config as Record<string, unknown>)[kind] = items;
    return { config, result: { created } };
  });
}

export function removeDraftItem(env: Bindings, accountId: string, id: string, kind: ItemKind, key: string, revision?: number) {
  return editDraft(env, accountId, id, revision, (config) => {
    const items = list(config, kind);
    const kept = items.filter((x) => itemKey(kind, x) !== key);
    if (kept.length !== items.length) (config as Record<string, unknown>)[kind] = kept;
    return { config, result: { removed: kept.length !== items.length } };
  });
}

/** Copy the live version's item into the draft; an item the live version doesn't have is removed. */
export async function revertDraftItem(env: Bindings, accountId: string, id: string, kind: ItemKind, key: string, revision?: number) {
  const row = await getContainerRow(env, accountId, id);
  const live = list((await liveConfig(env, row)) ?? {}, kind).find((i) => itemKey(kind, i) === key);
  return editDraft(env, accountId, id, revision, (config) => {
    const items = list(config, kind);
    const i = items.findIndex((x) => itemKey(kind, x) === key);
    let reverted: "restored" | "removed" | "unchanged" = "unchanged";
    if (live) {
      if (i === -1) items.push(live);
      else items[i] = live;
      reverted = "restored";
    } else if (i !== -1) {
      items.splice(i, 1);
      reverted = "removed";
    }
    if (reverted !== "unchanged") (config as Record<string, unknown>)[kind] = items;
    return { config, result: { reverted, live_version: row.live_version } };
  });
}

// ------------------------------------------------------------------ diff

export type VersionRef = "live" | "draft" | number;

export function parseRef(raw: string | undefined, fallback: VersionRef): VersionRef {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "live" || raw === "draft") return raw;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  throw badRequest(`"${raw}" isn't a version.`, 'Use "live", "draft" or a version number from GET /versions.');
}

async function resolveRef(env: Bindings, row: ContainerRow, ref: VersionRef) {
  if (ref === "draft") return { ref, version: null, revision: row.draft_revision, config: draftConfig(row) };
  if (ref === "live") return { ref, version: row.live_version, config: (await liveConfig(env, row)) ?? {} };
  const v = await env.DB.prepare("SELECT config FROM container_versions WHERE container_id = ? AND version = ?")
    .bind(row.id, ref)
    .first<{ config: string }>();
  if (!v) throw notFound(`Version ${ref}`, `GET /v1/containers/${row.id}/versions lists the versions kept.`);
  return { ref, version: ref, config: JSON.parse(v.config) as ContainerConfig };
}

export async function diffVersions(env: Bindings, accountId: string, id: string, from: VersionRef, to: VersionRef) {
  const row = await getContainerRow(env, accountId, id);
  const a = await resolveRef(env, row, from);
  const b = await resolveRef(env, row, to);
  const { config: ac, ...afrom } = a;
  const { config: bc, ...bto } = b;
  return { row, from: afrom, to: bto, diff: diffConfigs(ac, bc), nothing_published: row.live_version == null };
}

/** The short form get_draft and the item endpoints return. */
export function changesSummary(d: ConfigDiff, liveVersion: number | null) {
  return { live_version: liveVersion, identical: d.identical, summary: d.summary, counts: d.counts };
}

export async function changesVsLive(env: Bindings, row: ContainerRow, draft?: ContainerConfig) {
  const live = (await liveConfig(env, row)) ?? {};
  return changesSummary(diffConfigs(live, draft ?? draftConfig(row)), row.live_version);
}

export { draftValidation };
