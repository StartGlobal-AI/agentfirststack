import { badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { PERIODS, parseYmd, zonedToUtc } from "../lib/time";
import { type Ctx, type SiteRow, callSite, loadSite } from "./context";

/**
 * Annotations: dated notes on the site's timeline, returned with every timeseries. An agent that
 * deploys a change or starts a campaign writes one; the daily alarm adds "Traffic spike from X".
 */

const when = {
  date: z.string().optional().describe("YYYY-MM-DD in the site timezone (the note sits at local midnight)."),
  timestamp: z.union([z.number().int(), z.string()]).optional().describe("Exact time: unix ms or ISO 8601 (instead of date)."),
  end_date: z.string().optional().describe("Optional last day (YYYY-MM-DD, inclusive) for a span such as a campaign."),
};

export const createAnnotationInput = z.object({
  ...when,
  title: z.string().min(1).max(200).describe('Short label, e.g. "Launched pricing v2".'),
  description: z.string().max(2000).nullable().optional(),
});
export const updateAnnotationInput = z.object({
  ...when,
  end_date: z.string().nullable().optional().describe("Last day (YYYY-MM-DD), or null to make it a point in time."),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});
export const listAnnotationsInput = z.object({
  period: z.enum(PERIODS).optional().describe("Only annotations in this period (default: all)."),
  from: z.string().optional(),
  to: z.string().optional(),
  kind: z.enum(["note", "traffic_spike"]).optional(),
});

function dayStart(site: SiteRow, s: string, field: string): number {
  const d = parseYmd(s);
  if (!d) throw badRequest(`\`${field}\` must be YYYY-MM-DD.`, 'Example: {"date": "2026-11-03"}');
  return zonedToUtc(d.y, d.m, d.d, 0, site.timezone);
}

function tsOf(site: SiteRow, a: { date?: string; timestamp?: number | string }): number | undefined {
  if (a.timestamp != null) {
    const ms = typeof a.timestamp === "number" ? a.timestamp : Date.parse(a.timestamp);
    if (!Number.isFinite(ms) || ms < 0)
      throw badRequest("`timestamp` must be unix ms or ISO 8601.", 'Example: {"timestamp": "2026-11-03T14:00:00Z"}');
    return ms;
  }
  return a.date ? dayStart(site, a.date, "date") : undefined;
}

function endOf(site: SiteRow, endDate: string | null | undefined, ts: number): number | null | undefined {
  if (endDate === undefined) return undefined;
  if (endDate === null) return null;
  const d = parseYmd(endDate);
  if (!d) throw badRequest("`end_date` must be YYYY-MM-DD.", 'Example: {"date":"2026-11-01","end_date":"2026-11-07"}');
  const end = zonedToUtc(d.y, d.m, d.d + 1, 0, site.timezone) - 1;
  if (end < ts) throw badRequest("`end_date` is before the start.", "end_date is the last day of the span, inclusive.");
  return end;
}

export async function createAnnotation(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createAnnotationInput, raw);
  const site = await loadSite(ctx, siteId);
  const ts = tsOf(site, input) ?? Date.now();
  const max = Number(ctx.env.MAX_ANNOTATIONS_PER_SITE || 0) || null;
  const res = (await callSite(ctx.env, site, (s) =>
    s.createAnnotation(
      { ts, end_ts: endOf(site, input.end_date, ts) ?? null, title: input.title, description: input.description ?? null },
      max,
    ),
  )) as { annotation: Record<string, unknown>; existing: boolean };
  return {
    site_id: site.id,
    ...res,
    next_steps: [`It appears in GET /v1/sites/${site.id}/timeseries (annotations) for any period that includes it.`],
  };
}

export async function listAnnotations(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(listAnnotationsInput, raw);
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.listAnnotations(q))) };
}

export async function updateAnnotation(ctx: Ctx, siteId: string, annotationId: string, raw: unknown) {
  const input = parse(updateAnnotationInput, raw);
  const site = await loadSite(ctx, siteId);
  const ts = tsOf(site, input);
  const patch: Record<string, unknown> = {};
  if (ts !== undefined) patch.ts = ts;
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.end_date !== undefined) patch.end_ts = endOf(site, input.end_date, ts ?? 0);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.updateAnnotation(annotationId, patch))) };
}

export async function deleteAnnotation(ctx: Ctx, siteId: string, annotationId: string) {
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.deleteAnnotation(annotationId))) };
}
