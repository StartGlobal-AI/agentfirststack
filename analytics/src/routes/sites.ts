import { parse } from "@afs/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { createGoal, deleteGoal, listGoals } from "../service/goals";
import { ingestServer } from "../service/ingest";
import { FRAMEWORKS } from "../service/install";
import { createShareLink, revokeShareLinks } from "../service/share";
import { createSite, deleteSite, getInstall, getSite, listSites, updateSite } from "../service/sites";
import { getBreakdown, getFunnel, getRealtime, getStats, getTimeseries, querySql } from "../service/stats";
import { verifyInstall } from "../service/verify";
import { body, ctxOf } from "./util";

/** /v1/sites/* — thin: parse, call the service, return JSON. Auth is applied by the parent app. */
export const siteRoutes = new Hono<AppEnv>();
const r = siteRoutes;

r.post("/", async (c) => {
  const res = await createSite(ctxOf(c), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/", async (c) => c.json(await listSites(ctxOf(c))));
r.get("/:id", async (c) => c.json(await getSite(ctxOf(c), c.req.param("id"))));
r.patch("/:id", async (c) => c.json(await updateSite(ctxOf(c), c.req.param("id"), await body(c))));
r.delete("/:id", async (c) => c.json(await deleteSite(ctxOf(c), c.req.param("id"))));

r.get("/:id/install", async (c) => {
  const { framework } = parse(z.object({ framework: z.enum(FRAMEWORKS).optional() }), c.req.query());
  return c.json(await getInstall(ctxOf(c), c.req.param("id"), framework));
});
r.post("/:id/verify", async (c) => c.json(await verifyInstall(ctxOf(c), c.req.param("id"), await body(c))));
r.post("/:id/events", async (c) => c.json(await ingestServer(ctxOf(c), c.req.param("id"), await body(c)), 202));

r.get("/:id/stats", async (c) => c.json(await getStats(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/breakdown", async (c) => c.json(await getBreakdown(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/timeseries", async (c) => c.json(await getTimeseries(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/realtime", async (c) => c.json(await getRealtime(ctxOf(c), c.req.param("id"))));
r.get("/:id/funnel", async (c) => c.json(await getFunnel(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/:id/sql", async (c) => c.json(await querySql(ctxOf(c), c.req.param("id"), c.req.query())));

r.post("/:id/goals", async (c) => {
  const res = await createGoal(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/:id/goals", async (c) => c.json(await listGoals(ctxOf(c), c.req.param("id"))));
r.delete("/:id/goals/:goal_id", async (c) => c.json(await deleteGoal(ctxOf(c), c.req.param("id"), c.req.param("goal_id"))));

r.post("/:id/share", async (c) => {
  const res = await createShareLink(ctxOf(c), c.req.param("id"), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.delete("/:id/share", async (c) => c.json(await revokeShareLinks(ctxOf(c), c.req.param("id"))));
