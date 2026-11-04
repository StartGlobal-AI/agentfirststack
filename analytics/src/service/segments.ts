import { ApiError, accountStanding, badRequest, newId, parse } from "@afs/shared";
import { z } from "zod";
import { quotaExceeded, siteCap } from "../lib/limits";
import { filterLeaves } from "../lib/filters";
import { isWildcard } from "../lib/query";
import { type Ctx, loadGoals, loadSite } from "./context";
import { type SegmentRow, filterJsonOf, filterShape, filtersOf, loadSegment } from "./filters";

/**
 * Saved segments: a named filter set (the grammar and/or nested groups) that any query takes as
 * segment=<id or name>, ANDed with its own filters. Idempotent by name; capped per site.
 */

export const DEFAULT_MAX_SEGMENTS_PER_SITE = 50;

export const createSegmentInput = z.object({
  name: z.string().min(1).max(120).describe('Unique per site, e.g. "Paid traffic, US".'),
  description: z.string().max(500).optional(),
  filters: filterShape.filters,
  filters_json: filterShape.filters_json,
});
export const updateSegmentInput = createSegmentInput.partial();

export function segmentJson(s: SegmentRow) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    filters: s.filters,
    filters_json: s.filters_json ? (JSON.parse(s.filters_json) as unknown) : null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

/** Validate a segment's filters; returns them as stored (null when empty). */
function columns(input: { filters?: string; filters_json?: unknown }) {
  const filters = input.filters?.trim() || null;
  filtersOf(filters ?? undefined);
  const json = filterJsonOf(input.filters_json);
  return {
    filters,
    filters_json: json
      ? JSON.stringify(input.filters_json && typeof input.filters_json === "string" ? JSON.parse(input.filters_json) : input.filters_json)
      : null,
  };
}

/** Goals a segment names must exist (wildcard patterns aside). */
async function checkGoals(ctx: Ctx, siteId: string, cols: { filters: string | null; filters_json: string | null }) {
  const leaves = [...filtersOf(cols.filters ?? undefined), ...filterLeaves(filterJsonOf(cols.filters_json))];
  const named = leaves
    .filter((f) => f.key === "goal" && (f.op === "==" || f.op === "!="))
    .flatMap((f) => f.values)
    .filter((v) => !isWildcard(v));
  if (!named.length) return;
  const known = new Set((await loadGoals(ctx.env, siteId)).map((g) => g.name));
  const missing = named.filter((n) => !known.has(n));
  if (missing.length)
    throw badRequest(
      `Unknown goal(s) in the segment: ${missing.join(", ")}.`,
      known.size ? `Goals on this site: ${[...known].join(", ")}.` : `Create the goal first: POST /v1/sites/${siteId}/goals.`,
    );
}

export async function createSegment(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createSegmentInput, raw);
  const site = await loadSite(ctx, siteId);
  const cols = columns(input);
  if (!cols.filters && !cols.filters_json)
    throw badRequest(
      "A segment needs filters or filters_json.",
      'Example: {"name":"Paid US","filters":"country==US;channel==Paid Search|Paid Social"}.',
    );
  const db = ctx.env.DB;
  const existing = await db.prepare("SELECT * FROM segments WHERE site_id = ? AND name = ?").bind(site.id, input.name).first<SegmentRow>();
  if (existing) {
    const same = existing.filters === cols.filters && existing.filters_json === cols.filters_json;
    return {
      segment: segmentJson(existing),
      existing: true,
      ...(same
        ? {}
        : {
            note: `A segment with this name exists with other filters; returned unchanged. PATCH /v1/sites/${site.id}/segments/${existing.id} to change it.`,
          }),
    };
  }
  await checkGoals(ctx, site.id, cols);
  const max = siteCap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_SEGMENTS_PER_SITE", DEFAULT_MAX_SEGMENTS_PER_SITE);
  if (Number.isFinite(max)) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM segments WHERE site_id = ?").bind(site.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw quotaExceeded(
        `This site already has ${max} segments, the most allowed here.`,
        "Delete one you no longer use (DELETE /v1/sites/:id/segments/:segment_id).",
      );
  }
  const now = Date.now();
  const row: SegmentRow = {
    id: newId("seg"),
    site_id: site.id,
    name: input.name,
    description: input.description ?? null,
    ...cols,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO segments (id, site_id, name, description, filters, filters_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(row.id, row.site_id, row.name, row.description, row.filters, row.filters_json, now, now)
      .run();
  } catch (e) {
    const other = await db.prepare("SELECT * FROM segments WHERE site_id = ? AND name = ?").bind(site.id, input.name).first<SegmentRow>();
    if (other) return { segment: segmentJson(other), existing: true };
    throw e;
  }
  return {
    segment: segmentJson(row),
    existing: false,
    next_steps: [
      `Use it anywhere filters go: GET /v1/sites/${site.id}/stats?segment=${row.id} (or segment=${encodeURIComponent(row.name)}), breakdown, timeseries, funnel, visitors, realtime ...`,
    ],
  };
}

export async function listSegments(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const { results } = await ctx.env.DB.prepare("SELECT * FROM segments WHERE site_id = ? ORDER BY created_at")
    .bind(site.id)
    .all<SegmentRow>();
  return { segments: results.map(segmentJson) };
}

export async function updateSegment(ctx: Ctx, siteId: string, id: string, raw: unknown) {
  const input = parse(updateSegmentInput, raw);
  const site = await loadSite(ctx, siteId);
  const cur = await loadSegment(ctx, site.id, id);
  const name = input.name ?? cur.name;
  if (name !== cur.name) {
    const clash = await ctx.env.DB.prepare("SELECT id FROM segments WHERE site_id = ? AND name = ? AND id != ?")
      .bind(site.id, name, cur.id)
      .first();
    if (clash) throw new ApiError(409, "conflict", `Another segment on this site is called "${name}".`, "Pick another name.");
  }
  const cols = columns({
    filters: input.filters !== undefined ? input.filters : (cur.filters ?? undefined),
    filters_json: input.filters_json !== undefined ? input.filters_json : cur.filters_json ? JSON.parse(cur.filters_json) : undefined,
  });
  if (!cols.filters && !cols.filters_json) throw badRequest("A segment needs filters or filters_json.");
  await checkGoals(ctx, site.id, cols);
  const now = Date.now();
  await ctx.env.DB.prepare(
    "UPDATE segments SET name = ?, description = ?, filters = ?, filters_json = ?, updated_at = ? WHERE id = ? AND site_id = ?",
  )
    .bind(
      name,
      input.description !== undefined ? input.description : cur.description,
      cols.filters,
      cols.filters_json,
      now,
      cur.id,
      site.id,
    )
    .run();
  return { segment: segmentJson({ ...cur, name, description: input.description ?? cur.description, ...cols, updated_at: now }) };
}

export async function deleteSegment(ctx: Ctx, siteId: string, id: string) {
  const site = await loadSite(ctx, siteId);
  const cur = await loadSegment(ctx, site.id, id);
  await ctx.env.DB.prepare("DELETE FROM segments WHERE id = ? AND site_id = ?").bind(cur.id, site.id).run();
  return { deleted: cur.id };
}
