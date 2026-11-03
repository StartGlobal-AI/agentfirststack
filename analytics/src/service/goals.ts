import { accountStanding, badRequest, newId, notFound, parse } from "@afs/shared";
import { DEFAULT_MAX_GOALS_PER_SITE, quotaExceeded, siteCap } from "../lib/limits";
import { z } from "zod";
import type { Goal } from "../lib/types";
import { type Ctx, loadGoals, loadSite, pushSettings } from "./context";

export const createGoalInput = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .describe('Display name, unique per site, e.g. "Signup". Used in goal==Signup filters and goal:Signup funnel steps.'),
  type: z
    .enum(["event", "pageview", "scroll"])
    .describe(
      "event: matches a custom event name. pageview: matches a page path. scroll: a pageview of the path that scrolled to `threshold` %.",
    ),
  match: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'event: the exact event name (e.g. "signup"). pageview / scroll: a path, * matches anything (e.g. "/thank-you" or "/blog/*").',
    ),
  value: z.number().min(0).nullable().optional().describe("Revenue counted per conversion when the event carries no revenue of its own."),
  threshold: z.number().int().min(1).max(100).optional().describe("scroll goals: max scroll depth % the pageview must reach (default 75)."),
});

const goalJson = (g: Goal) => ({
  id: g.id,
  name: g.name,
  type: g.type,
  match: g.match,
  value: g.value,
  threshold: g.threshold ?? null,
  created_at: g.created_at,
});

export async function createGoal(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createGoalInput, raw);
  if ((input.type === "pageview" || input.type === "scroll") && !input.match.startsWith("/")) {
    throw badRequest(
      `${input.type === "scroll" ? "Scroll" : "Pageview"} goals match a path, so \`match\` must start with '/'.`,
      'Example: {"type":"pageview","match":"/thank-you"}.',
    );
  }
  if (input.threshold != null && input.type !== "scroll") {
    throw badRequest(
      "`threshold` is only for scroll goals.",
      'Example: {"name":"Read pricing","type":"scroll","match":"/pricing","threshold":75}.',
    );
  }
  const site = await loadSite(ctx, siteId);
  const existing = await ctx.env.DB.prepare(
    "SELECT id, name, type, match, value, threshold, created_at FROM goals WHERE site_id = ? AND name = ?",
  )
    .bind(site.id, input.name)
    .first<Goal>();
  if (existing) {
    return {
      goal: goalJson(existing),
      existing: true,
      note:
        existing.type === input.type &&
        existing.match === input.match &&
        (existing.threshold ?? null) === (input.type === "scroll" ? (input.threshold ?? 75) : null)
          ? undefined
          : "A goal with this name exists with a different definition; returned unchanged. Delete it first to redefine.",
    };
  }
  // Goals ride in the site's Durable Object settings copy (one SQLite value, < 2 MB): keep the list bounded.
  const max = siteCap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_GOALS_PER_SITE", DEFAULT_MAX_GOALS_PER_SITE);
  if (Number.isFinite(max)) {
    const n = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM goals WHERE site_id = ?").bind(site.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw quotaExceeded(
        `This site already has ${max} goals, the most allowed here.`,
        "Delete goals you no longer need (DELETE /v1/sites/:id/goals/:goal_id); a pageview goal with * can cover many paths.",
      );
  }
  const goal: Goal = {
    id: newId("goal"),
    name: input.name,
    type: input.type,
    match: input.match,
    value: input.value ?? null,
    threshold: input.type === "scroll" ? (input.threshold ?? 75) : null,
    created_at: Date.now(),
  };
  await ctx.env.DB.prepare(
    "INSERT INTO goals (id, site_id, name, type, match, value, threshold, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(goal.id, site.id, goal.name, goal.type, goal.match, goal.value, goal.threshold, goal.created_at)
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
