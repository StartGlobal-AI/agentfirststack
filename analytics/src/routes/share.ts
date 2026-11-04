import { Hono } from "hono";
import type { AppEnv } from "../env";
import { shareData, shareSiteDomain } from "../service/share";
import { sharePage } from "../share-page";

/** Public, token-scoped, aggregate-only dashboard. */
export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get("/share/:token", async (c) => {
  const token = c.req.param("token");
  const domain = await shareSiteDomain(c.env, token);
  return c.html(sharePage(token, domain), 200, {
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  });
});

shareRoutes.get("/share/:token/data", async (c) => {
  const data = await shareData(c.env, c.req.param("token"), c.req.query());
  return c.json(data, 200, { "cache-control": "private, max-age=60", "x-robots-tag": "noindex, nofollow" });
});
