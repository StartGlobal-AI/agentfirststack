import { badRequest, parse } from "@afs/shared";
import { z } from "zod";
import { VISITOR_SORTS } from "../do/people";
import { SESSION_ID_RE } from "../lib/visitor";
import { type Ctx, callSite, loadSite } from "./context";
import { filtersField, filtersOf, periodShape } from "./stats";

export const visitorsInput = z.object({
  ...periodShape,
  filters: filtersField,
  type: z
    .enum(["all", "identified", "customers"])
    .optional()
    .describe("identified: with a user_id; customers: spent money in the period. Default all."),
  search: z.string().max(200).optional().describe("Part of a user_id or visitor id."),
  sort: z.enum(VISITOR_SORTS).optional().describe("last_seen (default), first_seen, revenue, visits, pageviews (all descending)."),
  limit: z.coerce.number().int().min(1).max(200).optional().describe("Default 50."),
  offset: z.coerce.number().int().min(0).max(100_000).optional().describe("From next_offset of the previous page."),
});

export const visitorInput = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().describe("Timeline events, most recent (default 200)."),
});

export const journeysInput = z.object({
  ...periodShape,
  filters: filtersField,
  goal: z
    .string()
    .max(120)
    .optional()
    .describe("Goal name. Omit for the first purchase (a payment or revenue event that is not a renewal or refund)."),
  limit: z.coerce.number().int().min(1).max(100).optional().describe("Default 20."),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

/** Visitor keys: a visitor id, or user:<user_id>. */
const VISITOR_KEY_RE = /^(user:.{1,200}|[A-Za-z0-9_-]{1,64})$/s;

export async function listVisitors(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(visitorsInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = {
    period: q.period,
    from: q.from,
    to: q.to,
    filters: filtersOf(q.filters),
    type: q.type ?? "all",
    search: q.search,
    sort: q.sort ?? "last_seen",
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.visitors(req))) };
}

export async function getVisitor(ctx: Ctx, siteId: string, key: string, raw: unknown) {
  const q = parse(visitorInput, raw);
  if (!VISITOR_KEY_RE.test(key))
    throw badRequest("That is not a visitor id.", "Use an id from GET /v1/sites/:id/visitors: a visitor id, or user:<user_id>.");
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.visitor(key, q.limit))) };
}

export async function getSession(ctx: Ctx, siteId: string, sessionId: string) {
  if (!SESSION_ID_RE.test(sessionId))
    throw badRequest(
      "Session ids look like s + 15 characters.",
      "Take one from a visitor's sessions, journeys touchpoints or realtime recent_events.",
    );
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.session(sessionId))) };
}

export async function getJourneys(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(journeysInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = {
    period: q.period,
    from: q.from,
    to: q.to,
    filters: filtersOf(q.filters),
    goal: q.goal,
    limit: q.limit ?? 20,
    offset: q.offset ?? 0,
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.journeys(req))) };
}
