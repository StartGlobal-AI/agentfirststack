import { badRequest, notFound } from "@afs/shared";
import { z } from "zod";
import { type Filter, FilterError, type FilterExpr, parseFilterJson, parseFilters } from "../lib/filters";
import type { Ctx } from "./context";

/**
 * Filters, the same everywhere a query takes them: the grammar (`filters`), nested and / or / not
 * groups (`filters_json`), and a saved segment (`segment`, by id or name), all ANDed together.
 */

export const filtersField = z
  .string()
  .max(4000)
  .optional()
  .describe(
    "e.g. country==US;page==/blog/*;channel!=Direct;goal==Signup;prop:plan==pro. Ops == != ~ (contains) !~; * in == / != = wildcard; | = OR; ; = AND; (none) = missing.",
  );

export const filterShape = {
  filters: filtersField,
  filters_json: z
    .union([z.string().max(8000), z.array(z.unknown()).max(3)])
    .optional()
    .describe(
      'Nested groups, ANDed with filters: ["or", [["==","country",["US"]], ["and", [["~","page",["/blog"]], ["!=","device",["mobile"]]]]]]; ["not", node] negates. Same keys and ops.',
    ),
  segment: z.string().max(120).optional().describe("A saved segment (seg_... or its name), ANDed with filters."),
};

export function filtersOf(v: string | undefined) {
  try {
    return parseFilters(v);
  } catch (e) {
    if (e instanceof FilterError)
      throw badRequest(e.message, "Filter syntax: key==value;key2~text (ops == != ~ !~, * wildcard in ==, | for OR, (none) for missing).");
    throw e;
  }
}

export function filterJsonOf(v: unknown): FilterExpr | null {
  try {
    return parseFilterJson(v);
  } catch (e) {
    if (e instanceof FilterError)
      throw badRequest(e.message, 'Example: filters_json=["or",[["==","country",["US"]],["==","country",["CA"]]]]');
    throw e;
  }
}

export interface SegmentRow {
  id: string;
  site_id: string;
  name: string;
  description: string | null;
  filters: string | null;
  filters_json: string | null;
  created_at: number;
  updated_at: number;
}

export async function loadSegment(ctx: Ctx, siteId: string, ref: string): Promise<SegmentRow> {
  const row = await ctx.env.DB.prepare("SELECT * FROM segments WHERE site_id = ? AND (id = ? OR name = ?) ORDER BY id = ? DESC LIMIT 1")
    .bind(siteId, ref, ref, ref)
    .first<SegmentRow>();
  if (!row) throw notFound("Segment", `GET /v1/sites/${siteId}/segments lists this site's segments (pass the seg_ id or the name).`);
  return row;
}

const andOf = (a: FilterExpr | null, b: FilterExpr | null): FilterExpr | null => (a && b ? { and: [a, b] } : (a ?? b));

export interface ResolvedFilters {
  filters: Filter[];
  where: FilterExpr | null;
}

/** filters + filters_json + segment, resolved and validated, ready for the site's Durable Object. */
export async function resolveFilters(
  ctx: Ctx,
  siteId: string,
  q: { filters?: string; filters_json?: unknown; segment?: string },
): Promise<ResolvedFilters & { segment?: { id: string; name: string } }> {
  let filters = filtersOf(q.filters);
  let where = filterJsonOf(q.filters_json);
  let segment: { id: string; name: string } | undefined;
  if (q.segment) {
    const s = await loadSegment(ctx, siteId, q.segment);
    filters = [...filtersOf(s.filters ?? undefined), ...filters];
    where = andOf(s.filters_json ? filterJsonOf(s.filters_json) : null, where);
    segment = { id: s.id, name: s.name };
  }
  return { filters, where, ...(segment ? { segment } : {}) };
}
