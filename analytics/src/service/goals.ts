import { ApiError, accountStanding, badRequest, newId, notFound, parse } from "@afs/shared";
import { DEFAULT_MAX_GOALS_PER_SITE, quotaExceeded, siteCap } from "../lib/limits";
import { z } from "zod";
import type { Goal } from "../lib/types";
import { PROP_KEY_RE } from "../lib/filters";
import { type Ctx, goalFromRow, loadGoals, loadSite, pushSettings } from "./context";

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
  value: z
    .number()
    .min(0)
    .nullable()
    .optional()
    .describe("What one conversion is worth: reported as the goal_value metric, never added to revenue (revenue is what was paid)."),
  threshold: z.number().int().min(1).max(100).optional().describe("scroll goals: max scroll depth % the pageview must reach (default 75)."),
  props: z
    .record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean()]))
    .nullable()
    .optional()
    .describe(
      'Prop conditions: the event must carry every one, e.g. {"plan":"pro"} (values compared as strings). Up to 10. null clears them.',
    ),
  counting: z
    .enum(["every", "once_per_visit"])
    .optional()
    .describe("every (default): each matching event is a conversion; once_per_visit: at most one per session (its value counts once)."),
});

export const updateGoalInput = createGoalInput.partial();

/** Prop conditions as stored: string values, valid keys, at most 10. */
function propsOf(input: Record<string, string | number | boolean> | null | undefined): Record<string, string> | null {
  if (!input) return null;
  const entries = Object.entries(input);
  if (entries.length > 10) throw badRequest("A goal takes at most 10 prop conditions.");
  for (const [k] of entries)
    if (!PROP_KEY_RE.test(k)) throw badRequest(`Bad prop key "${k}".`, "Keys are 1-64 characters of A-Z a-z 0-9 _ . -");
  return entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, String(v)])) : null;
}

export const goalJson = (g: Goal) => ({
  id: g.id,
  name: g.name,
  type: g.type,
  match: g.match,
  value: g.value,
  threshold: g.threshold ?? null,
  props: g.props ?? null,
  counting: g.counting ?? "every",
  created_at: g.created_at,
});

function checkShape(input: { type: Goal["type"]; match: string; threshold?: number | null }) {
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
}

export async function createGoal(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createGoalInput, raw);
  checkShape(input);
  const props = propsOf(input.props);
  const site = await loadSite(ctx, siteId);
  const existingRow = await ctx.env.DB.prepare(
    "SELECT id, name, type, match, value, threshold, props, counting, created_at FROM goals WHERE site_id = ? AND name = ?",
  )
    .bind(site.id, input.name)
    .first<Parameters<typeof goalFromRow>[0]>();
  const existing = existingRow ? goalFromRow(existingRow) : null;
  if (existing) {
    return {
      goal: goalJson(existing),
      existing: true,
      note:
        existing.type === input.type &&
        existing.match === input.match &&
        (existing.threshold ?? null) === (input.type === "scroll" ? (input.threshold ?? 75) : null)
          ? undefined
          : `A goal with this name exists with a different definition; returned unchanged. Change it with PATCH /v1/sites/${site.id}/goals/${existing.id}.`,
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
    props,
    counting: input.counting ?? "every",
    created_at: Date.now(),
  };
  await ctx.env.DB.prepare(
    "INSERT INTO goals (id, site_id, name, type, match, value, threshold, props, counting, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      goal.id,
      site.id,
      goal.name,
      goal.type,
      goal.match,
      goal.value,
      goal.threshold,
      props ? JSON.stringify(props) : null,
      goal.counting,
      goal.created_at,
    )
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

/**
 * Change a goal (any field). Applies retroactively like creating one. A rename leaves funnels,
 * segments, alerts and filters that name the old one pointing at nothing: they are listed in notes.
 */
export async function updateGoal(ctx: Ctx, siteId: string, goalId: string, raw: unknown) {
  const input = parse(updateGoalInput, raw);
  const site = await loadSite(ctx, siteId);
  const cur = (await loadGoals(ctx.env, site.id)).find((g) => g.id === goalId);
  if (!cur) throw notFound("Goal", `GET /v1/sites/${site.id}/goals lists this site's goals.`);
  const type = input.type ?? cur.type;
  const next: Goal = {
    ...cur,
    name: input.name ?? cur.name,
    type,
    match: input.match ?? cur.match,
    value: input.value !== undefined ? input.value : cur.value,
    threshold: type === "scroll" ? (input.threshold ?? cur.threshold ?? 75) : null,
    props: input.props !== undefined ? propsOf(input.props) : (cur.props ?? null),
    counting: input.counting ?? cur.counting ?? "every",
  };
  checkShape({ type: next.type, match: next.match, threshold: input.threshold });
  const notes: string[] = [];
  if (next.name !== cur.name) {
    const clash = await ctx.env.DB.prepare("SELECT id FROM goals WHERE site_id = ? AND name = ? AND id != ?")
      .bind(site.id, next.name, cur.id)
      .first();
    if (clash) throw new ApiError(409, "conflict", `Another goal on this site is called "${next.name}".`, "Pick another name.");
    const [funnels, alerts, segments] = await Promise.all([
      ctx.env.DB.prepare("SELECT name FROM funnels WHERE site_id = ? AND instr(steps, ?) > 0")
        .bind(site.id, `"goal:${cur.name}"`)
        .all<{ name: string }>(),
      ctx.env.DB.prepare("SELECT name FROM alerts WHERE site_id = ? AND goal = ?").bind(site.id, cur.name).all<{ name: string }>(),
      ctx.env.DB.prepare("SELECT name FROM segments WHERE site_id = ? AND (instr(filters, ?) > 0 OR instr(filters_json, ?) > 0)")
        .bind(site.id, `goal==${cur.name}`, `"${cur.name}"`)
        .all<{ name: string }>(),
    ]);
    const refs = [
      ...funnels.results.map((f) => `funnel "${f.name}"`),
      ...alerts.results.map((a) => `alert "${a.name}"`),
      ...segments.results.map((sg) => `segment "${sg.name}"`),
    ];
    if (refs.length) notes.push(`These still name the old goal "${cur.name}"; update them: ${refs.join(", ")}.`);
  }
  await ctx.env.DB.prepare(
    "UPDATE goals SET name = ?, type = ?, match = ?, value = ?, threshold = ?, props = ?, counting = ? WHERE id = ? AND site_id = ?",
  )
    .bind(
      next.name,
      next.type,
      next.match,
      next.value,
      next.threshold ?? null,
      next.props ? JSON.stringify(next.props) : null,
      next.counting ?? "every",
      cur.id,
      site.id,
    )
    .run();
  await pushSettings(ctx.env, site);
  return {
    goal: goalJson(next),
    ...(notes.length ? { notes } : {}),
    note: "Conversions are recomputed from stored events (goals apply retroactively).",
  };
}

export async function deleteGoal(ctx: Ctx, siteId: string, goalId: string) {
  const site = await loadSite(ctx, siteId);
  const res = await ctx.env.DB.prepare("DELETE FROM goals WHERE id = ? AND site_id = ?").bind(goalId, site.id).run();
  if (!res.meta.changes) throw notFound("Goal", `GET /v1/sites/${site.id}/goals lists this site's goals.`);
  await pushSettings(ctx.env, site);
  return { deleted: goalId };
}
