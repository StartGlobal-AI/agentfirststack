import { parse, publicBaseUrl, readJson } from "@afs/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Ctx } from "../service/context";
import { FRAMEWORKS } from "../service/install";
import { getFunnelDropoffs, getHeatmap, listErrors } from "../service/insights";
import { createLink, listLinks, revokeLink } from "../service/links";
import { deleteSession, deleteVisitorData, getSession, getTranscript, searchSessions, summarize } from "../service/sessions";
import { createSite, deleteSite, getInstall, getSite, listSites, updateSite } from "../service/sites";
import { verifyInstall } from "../service/verify";

export function waitUntilOf(c: Context<AppEnv>): (p: Promise<unknown>) => void {
  try {
    const ec = c.executionCtx;
    return (p) => ec.waitUntil(p);
  } catch {
    return (p) => void p.catch(() => {});
  }
}

/** Service context for an authenticated request. */
export const ctxOf = (c: Context<AppEnv>): Ctx => ({
  env: c.env,
  accountId: c.var.auth.accountId,
  baseUrl: publicBaseUrl(c),
  waitUntil: waitUntilOf(c),
});

/** JSON body as-is (empty = {}); services validate it with their own schema. */
const body = (c: Context<AppEnv>) => readJson(c, z.unknown());

/** /v1/sites/* — thin: parse, call the service, return JSON. Auth is applied by the parent app. */
export const api = new Hono<AppEnv>();
const r = api;

r.post("/sites", async (c) => {
  const res = await createSite(ctxOf(c), await body(c));
  return c.json(res, res.existing ? 200 : 201);
});
r.get("/sites", async (c) => c.json(await listSites(ctxOf(c))));
r.get("/sites/:id", async (c) => c.json(await getSite(ctxOf(c), c.req.param("id"))));
r.patch("/sites/:id", async (c) => c.json(await updateSite(ctxOf(c), c.req.param("id"), await body(c))));
r.delete("/sites/:id", async (c) => c.json(await deleteSite(ctxOf(c), c.req.param("id"))));

r.get("/sites/:id/install", async (c) => {
  const { framework } = parse(z.object({ framework: z.enum(FRAMEWORKS).optional() }), c.req.query());
  return c.json(await getInstall(ctxOf(c), c.req.param("id"), framework));
});
r.post("/sites/:id/verify", async (c) => c.json(await verifyInstall(ctxOf(c), c.req.param("id"), await body(c))));

r.get("/sites/:id/sessions", async (c) => c.json(await searchSessions(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/sites/:id/sessions/:sid", async (c) => c.json(await getSession(ctxOf(c), c.req.param("id"), c.req.param("sid"))));
r.get("/sites/:id/sessions/:sid/transcript", async (c) =>
  c.json(await getTranscript(ctxOf(c), c.req.param("id"), c.req.param("sid"), c.req.query())),
);
r.delete("/sites/:id/sessions/:sid", async (c) => c.json(await deleteSession(ctxOf(c), c.req.param("id"), c.req.param("sid"))));
r.get("/sites/:id/summary", async (c) => c.json(await summarize(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/sites/:id/heatmap", async (c) => c.json(await getHeatmap(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/sites/:id/errors", async (c) => c.json(await listErrors(ctxOf(c), c.req.param("id"), c.req.query())));
r.get("/sites/:id/funnel", async (c) => c.json(await getFunnelDropoffs(ctxOf(c), c.req.param("id"), c.req.query())));
r.post("/sites/:id/delete-visitor-data", async (c) => c.json(await deleteVisitorData(ctxOf(c), c.req.param("id"), await body(c))));

r.post("/sites/:id/links", async (c) => c.json(await createLink(ctxOf(c), c.req.param("id"), await body(c)), 201));
r.get("/sites/:id/links", async (c) => c.json(await listLinks(ctxOf(c), c.req.param("id"), c.req.query("session_id"))));
r.delete("/sites/:id/links/:link_id", async (c) => c.json(await revokeLink(ctxOf(c), c.req.param("id"), c.req.param("link_id"))));
