import { badRequest, newId, notFound, parse } from "@afs/shared";
import { z } from "zod";
import type { Goal } from "../lib/types";
import { type Ctx, loadGoals, loadSite, pushSettings } from "./context";

export const createGoalInput = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .describe('Display name, unique per site, e.g. "Signup". Used in goal==Signup filters and goal:Signup funnel steps.'),
  type: z.enum(["event", "pageview"]).describe("event: matches a custom event name. pageview: matches a page path."),
  match: z
    .string()
    .min(1)
    .max(500)
    .describe('event: the exact event name (e.g. "signup"). pageview: a path, * matches anything (e.g. "/thank-you" or "/order/*/done").'),
  value: z.number().min(0).nullable().optional().describe("Revenue counted per conversion when the event carries no revenue of its own."),
});

const goalJson = (g: Goal) => ({ id: g.id, name: g.name, type: g.type, match: g.match, value: g.value, created_at: g.created_at });

export async function createGoal(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createGoalInput, raw);
  if (input.type === "pageview" && !input.match.startsWith("/")) {
    throw badRequest("Pageview goals match a path, so `match` must start with '/'.", 'Example: {"type":"pageview","match":"/thank-you"}.');
  }
  const site = await loadSite(ctx, siteId);
  const existing = await ctx.env.DB.prepare("SELECT id, name, type, match, value, created_at FROM goals WHERE site_id = ? AND name = ?")
    .bind(site.id, input.name)
    .first<Goal>();
  if (existing) {
    return {
      goal: goalJson(existing),
      existing: true,
      note:
        existing.type === input.type && existing.match === input.match
          ? undefined
          : "A goal with this name exists with a different definition; returned unchanged. Delete it first to redefine.",
    };
  }
  const goal: Goal = {
    id: newId("goal"),
    name: input.name,
    type: input.type,
    match: input.match,
    value: input.value ?? null,
    created_at: Date.now(),
  };
  await ctx.env.DB.prepare("INSERT INTO goals (id, site_id, name, type, match, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(goal.id, site.id, goal.name, goal.type, goal.match, goal.value, goal.created_at)
    .run();
  await pushSettings(ctx.env, site);
  return {
    goal: goalJson(goal),
    existing: false,
    next_steps: [
      `Conversions now count retroactively over stored events: GET /v1/sites/${site.id}/stats?metrics=visitors,conversions,conversion_rate,revenue`,
      `Per goal: GET /v1/sites/${site.id}/stats?breakdown=goal. Sources of converters: GET /v1/sites/${site.id}/stats?breakdown=channel&filters=goal==${encodeURIComponent(goal.name)}`,
    ],
  };
}

export async function listGoals(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  return { goals: (await loadGoals(ctx.env, site.id)).map(goalJson) };
}

export async function deleteGoal(ctx: Ctx, siteId: string, goalId: string) {
  const site = await loadSite(ctx, siteId);
  const res = await ctx.env.DB.prepare("DELETE FROM goals WHERE id = ? AND site_id = ?").bind(goalId, site.id).run();
  if (!res.meta.changes) throw notFound("Goal", `GET /v1/sites/${site.id}/goals lists this site's goals.`);
  await pushSettings(ctx.env, site);
  return { deleted: goalId };
}
