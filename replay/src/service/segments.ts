import { accountStanding, ApiError, badRequest, newId, notFound, parse } from "@afs/shared";
import type { z } from "zod";
import { cap, DEFAULTS } from "../lib/limits";
import { type Ctx, loadSite, type SiteRow, siteStub } from "./context";
import { createSegmentInput, segmentFilters, updateSegmentInput } from "./schemas";
import { resolveFilters } from "./sessions";

/**
 * Saved segments: a named set of session filters per site. Every read that filters sessions takes
 * segment_id= (search, summary, heatmap, errors, funnel, metrics, exports); filters passed with it
 * override the segment's own. Segments also drive segment.session webhooks.
 */

export type SegmentFilters = z.infer<typeof segmentFilters>;

interface SegmentRow {
  id: string;
  site_id: string;
  account_id: string;
  name: string;
  filters: string;
  created_at: number;
  updated_at: number;
}

export interface Segment {
  id: string;
  name: string;
  filters: SegmentFilters;
}

const SEG_ID_RE = /^seg_[0-9a-z]{16}$/;

const toSegment = (r: SegmentRow): Segment & { created_at: number; updated_at: number } => ({
  id: r.id,
  name: r.name,
  filters: JSON.parse(r.filters) as SegmentFilters,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** The segment, or 404 (also for another site's or account's segment). */
export async function segmentById(ctx: Ctx, site: SiteRow, id: string): Promise<Segment> {
  const row = SEG_ID_RE.test(id)
    ? await ctx.env.DB.prepare("SELECT * FROM segments WHERE id = ? AND site_id = ? AND account_id = ?")
        .bind(id, site.id, ctx.accountId)
        .first<SegmentRow>()
    : null;
  if (!row) throw notFound("Segment", `GET /v1/sites/${site.id}/segments lists this site's segments (seg_...).`);
  return toSegment(row);
}

/** Every segment of a site (internal: webhooks). */
export async function siteSegments(db: D1Database, siteId: string): Promise<Segment[]> {
  const { results } = await db
    .prepare("SELECT * FROM segments WHERE site_id = ? ORDER BY created_at LIMIT 200")
    .bind(siteId)
    .all<SegmentRow>();
  return results.map(toSegment);
}

/** Sessions matching the segment's filters now (rule 6: the agent sees it worked). */
async function matching(ctx: Ctx, site: SiteRow, filters: SegmentFilters) {
  const f = await resolveFilters(ctx, site, filters);
  const r = await siteStub(ctx.env, site.id).search({ ...f, sort: "recent", limit: 3, cursor: null });
  return { sessions: r.total, example_session_ids: r.sessions.map((s) => s.id) };
}

function checkFilters(filters: SegmentFilters) {
  if (filters.from !== undefined || filters.to !== undefined)
    throw badRequest(
      "A segment can't hold from/to: it would stop matching new sessions.",
      'Use a relative period ("7d") or none, and pass from/to with each read instead.',
    );
}

export async function createSegment(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(createSegmentInput, raw);
  const site = await loadSite(ctx, siteId);
  checkFilters(q.filters);
  const db = ctx.env.DB;
  const existing = await db.prepare("SELECT * FROM segments WHERE site_id = ? AND name = ?").bind(site.id, q.name).first<SegmentRow>();
  const respond = async (row: SegmentRow, isExisting: boolean) => {
    const seg = toSegment(row);
    return {
      segment: seg,
      existing: isExisting,
      ...(isExisting
        ? {
            note: `A segment named ${JSON.stringify(q.name)} already exists; returned unchanged. PATCH /v1/sites/${site.id}/segments/${seg.id} changes it.`,
          }
        : {}),
      matching_now: await matching(ctx, site, seg.filters),
      next_steps: [
        `Sessions in it: GET /v1/sites/${site.id}/sessions?segment_id=${seg.id} (MCP search_sessions {segment_id}).`,
        `segment_id also works on summary, heatmap, errors, funnel, metrics and exports; a webhook with events ["segment.session"] and this segment_id is told about each session that enters it.`,
      ],
    };
  };
  if (existing) return respond(existing, true);
  // Validates the filters as a read would (globs, tags, ...) before anything is stored.
  await resolveFilters(ctx, site, q.filters);
  const max = cap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_SEGMENTS_PER_SITE", DEFAULTS.SEGMENTS_PER_SITE);
  if (max !== null) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM segments WHERE site_id = ?").bind(site.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This site already has ${max} segments, the most allowed here (MAX_SEGMENTS_PER_SITE).`,
        `Delete one you no longer need: DELETE /v1/sites/${site.id}/segments/<seg_id>.`,
      );
  }
  const now = Date.now();
  const row: SegmentRow = {
    id: newId("seg"),
    site_id: site.id,
    account_id: ctx.accountId,
    name: q.name,
    filters: JSON.stringify(q.filters),
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare("INSERT INTO segments (id, site_id, account_id, name, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.site_id, row.account_id, row.name, row.filters, row.created_at, row.updated_at)
      .run();
  } catch (e) {
    const other = await db.prepare("SELECT * FROM segments WHERE site_id = ? AND name = ?").bind(site.id, q.name).first<SegmentRow>();
    if (other) return respond(other, true);
    throw e;
  }
  return respond(row, false);
}

export async function listSegments(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const { results } = await ctx.env.DB.prepare("SELECT * FROM segments WHERE site_id = ? AND account_id = ? ORDER BY created_at LIMIT 500")
    .bind(site.id, ctx.accountId)
    .all<SegmentRow>();
  return { segments: results.map(toSegment) };
}

export async function updateSegment(ctx: Ctx, siteId: string, segId: string, raw: unknown) {
  const q = parse(updateSegmentInput, raw);
  const site = await loadSite(ctx, siteId);
  const seg = await segmentById(ctx, site, segId);
  const next = { name: q.name ?? seg.name, filters: q.filters ?? seg.filters };
  checkFilters(next.filters);
  await resolveFilters(ctx, site, next.filters);
  if (next.name !== seg.name) {
    const clash = await ctx.env.DB.prepare("SELECT id FROM segments WHERE site_id = ? AND name = ? AND id != ?")
      .bind(site.id, next.name, seg.id)
      .first();
    if (clash) throw badRequest(`Another segment of this site is named ${JSON.stringify(next.name)}.`, "Pick another name.");
  }
  await ctx.env.DB.prepare("UPDATE segments SET name = ?, filters = ?, updated_at = ? WHERE id = ?")
    .bind(next.name, JSON.stringify(next.filters), Date.now(), seg.id)
    .run();
  return { segment: { id: seg.id, ...next }, matching_now: await matching(ctx, site, next.filters) };
}

export async function deleteSegment(ctx: Ctx, siteId: string, segId: string) {
  const site = await loadSite(ctx, siteId);
  const seg = await segmentById(ctx, site, segId);
  // segment.session webhooks of this segment would never fire again
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM segments WHERE id = ?").bind(seg.id),
    ctx.env.DB.prepare("DELETE FROM webhooks WHERE segment_id = ? AND account_id = ?").bind(seg.id, ctx.accountId),
  ]);
  return { deleted: seg.id };
}
