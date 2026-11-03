import { ApiError, badRequest, newId, notFound, parse } from "@afs/shared";
import { z } from "zod";
import { FunnelError, type FunnelStep, parseFunnelSteps } from "../lib/query";
import { type Ctx, loadGoals, loadSite } from "./context";

/**
 * Saved funnels: a name and 2-8 ordered steps, stored in D1 (control plane). Results come from
 * the same funnel query as GET /funnel?steps=, so a saved funnel and an ad hoc one always agree.
 */

const stepsField = z
  .union([z.string(), z.array(z.string())])
  .describe('2-8 ordered steps: "/pricing" (path, * wildcard), "page:/x", "event:signup", "goal:Purchase". Comma list or array.');

export const createFunnelInput = z.object({
  name: z.string().min(1).max(120).describe('Unique per site, e.g. "Signup flow".'),
  steps: stepsField,
});
export const updateFunnelInput = z.object({ name: z.string().min(1).max(120).optional(), steps: stepsField.optional() });

interface FunnelRow {
  id: string;
  site_id: string;
  name: string;
  steps: string;
  created_at: number;
  updated_at: number;
}

const stepText = (s: FunnelStep) => (s.type === "page" ? s.pattern : `${s.type}:${s.name}`);

export function funnelJson(r: FunnelRow) {
  return { id: r.id, name: r.name, steps: JSON.parse(r.steps) as string[], created_at: r.created_at, updated_at: r.updated_at };
}

async function validSteps(ctx: Ctx, siteId: string, input: string | string[]): Promise<string[]> {
  let steps: FunnelStep[];
  try {
    steps = parseFunnelSteps(input);
  } catch (e) {
    if (e instanceof FunnelError) throw badRequest(e.message, 'Example: {"steps": ["/pricing", "event:signup", "goal:Purchase"]}');
    throw e;
  }
  const goals = steps.filter((s) => s.type === "goal").map((s) => (s as { name: string }).name);
  if (goals.length) {
    const known = new Set((await loadGoals(ctx.env, siteId)).map((g) => g.name));
    const missing = goals.filter((g) => !known.has(g));
    if (missing.length)
      throw badRequest(
        `Unknown goal(s) in steps: ${missing.join(", ")}.`,
        known.size
          ? `Goals on this site: ${[...known].join(", ")}. Or create one first: POST /v1/sites/${siteId}/goals.`
          : `Create the goal first: POST /v1/sites/${siteId}/goals.`,
      );
  }
  return steps.map(stepText);
}

export async function loadFunnel(ctx: Ctx, siteId: string, funnelId: string) {
  const row = await ctx.env.DB.prepare("SELECT * FROM funnels WHERE id = ? AND site_id = ?").bind(funnelId, siteId).first<FunnelRow>();
  if (!row) throw notFound("Funnel", `GET /v1/sites/${siteId}/funnels lists this site's saved funnels.`);
  return funnelJson(row);
}

export async function createFunnel(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createFunnelInput, raw);
  const site = await loadSite(ctx, siteId);
  const db = ctx.env.DB;
  const existing = await db.prepare("SELECT * FROM funnels WHERE site_id = ? AND name = ?").bind(site.id, input.name).first<FunnelRow>();
  const steps = await validSteps(ctx, site.id, input.steps);
  const next = [`Drop-off per step: GET /v1/sites/${site.id}/funnels/{id}?period=30d (MCP: get_funnel with funnel_id).`];
  if (existing) {
    const same = JSON.stringify(steps) === existing.steps;
    return {
      funnel: funnelJson(existing),
      existing: true,
      ...(same ? {} : { note: "A funnel with this name exists with different steps; returned unchanged. PATCH it to change the steps." }),
      next_steps: next.map((s) => s.replace("{id}", existing.id)),
    };
  }
  const max = Number(ctx.env.MAX_FUNNELS_PER_SITE || 0);
  if (max > 0) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM funnels WHERE site_id = ?").bind(site.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This site already has ${max} saved funnels, the most allowed here.`,
        "Delete one you no longer need (DELETE /v1/sites/:id/funnels/:funnel_id), or self-host for more.",
      );
  }
  const now = Date.now();
  const row: FunnelRow = {
    id: newId("fnl"),
    site_id: site.id,
    name: input.name,
    steps: JSON.stringify(steps),
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare("INSERT INTO funnels (id, site_id, name, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.site_id, row.name, row.steps, now, now)
      .run();
  } catch (e) {
    // A concurrent create with the same name: the unique index wins; return that one.
    const other = await db.prepare("SELECT * FROM funnels WHERE site_id = ? AND name = ?").bind(site.id, input.name).first<FunnelRow>();
    if (other) return { funnel: funnelJson(other), existing: true, next_steps: next.map((s) => s.replace("{id}", other.id)) };
    throw e;
  }
  return { funnel: funnelJson(row), existing: false, next_steps: next.map((s) => s.replace("{id}", row.id)) };
}

export async function listFunnels(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const { results } = await ctx.env.DB.prepare("SELECT * FROM funnels WHERE site_id = ? ORDER BY created_at")
    .bind(site.id)
    .all<FunnelRow>();
  return { funnels: results.map(funnelJson) };
}

export async function updateFunnel(ctx: Ctx, siteId: string, funnelId: string, raw: unknown) {
  const input = parse(updateFunnelInput, raw);
  const site = await loadSite(ctx, siteId);
  const cur = await loadFunnel(ctx, site.id, funnelId);
  const name = input.name ?? cur.name;
  const steps = input.steps !== undefined ? await validSteps(ctx, site.id, input.steps) : cur.steps;
  if (name !== cur.name) {
    const clash = await ctx.env.DB.prepare("SELECT id FROM funnels WHERE site_id = ? AND name = ? AND id != ?")
      .bind(site.id, name, cur.id)
      .first();
    if (clash)
      throw new ApiError(
        409,
        "conflict",
        `Another funnel on this site is called "${name}".`,
        "Pick another name, or delete that funnel first.",
      );
  }
  const now = Date.now();
  await ctx.env.DB.prepare("UPDATE funnels SET name = ?, steps = ?, updated_at = ? WHERE id = ? AND site_id = ?")
    .bind(name, JSON.stringify(steps), now, cur.id, site.id)
    .run();
  return { funnel: { ...cur, name, steps, updated_at: now } };
}

export async function deleteFunnel(ctx: Ctx, siteId: string, funnelId: string) {
  const site = await loadSite(ctx, siteId);
  const res = await ctx.env.DB.prepare("DELETE FROM funnels WHERE id = ? AND site_id = ?").bind(funnelId, site.id).run();
  if (!res.meta.changes) throw notFound("Funnel", `GET /v1/sites/${site.id}/funnels lists this site's saved funnels.`);
  return { deleted: funnelId };
}
