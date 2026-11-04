import { randomString } from "@afs/shared";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { shareData, shareSiteDomain } from "../service/share";
import { sharePage, sharePageCsp } from "../share-page";

/** Public, token-scoped, aggregate-only dashboard. */
export const shareRoutes = new Hono<AppEnv>();

shareRoutes.get("/share/:token", async (c) => {
  const token = c.req.param("token");
  const domain = await shareSiteDomain(c.env, token);
  const nonce = randomString(24);
  return c.html(sharePage(token, domain, nonce), 200, {
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    // Clickjacking: no site may frame the dashboard (CSP for current browsers, X-Frame-Options for old ones).
    "content-security-policy": sharePageCsp(nonce),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  });
});

shareRoutes.get("/share/:token/data", async (c) => {
  const data = await shareData(c.env, c.req.param("token"), c.req.query());
  return c.json(data, 200, {
    "cache-control": "private, max-age=60",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
});
