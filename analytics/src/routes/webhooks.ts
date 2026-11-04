import { Hono } from "hono";
import type { AppEnv } from "../env";
import { billingWebhook } from "../service/billing-webhooks";
import { stripeWebhook } from "../service/payments";
import { waitUntilOf } from "./util";

/** Payment provider webhooks. No API key: each request is verified by the provider's signature. */
export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.post("/webhooks/stripe/:site_id", async (c) => {
  const res = await stripeWebhook(c.env, c.req.param("site_id"), c.req.raw, waitUntilOf(c));
  return c.json(res.body, res.status);
});

// Polar, Paddle, LemonSqueezy (anything else gets the same 400 webhook_rejected as a bad signature).
webhookRoutes.post("/webhooks/:provider/:site_id", async (c) => {
  const res = await billingWebhook(c.env, c.req.param("provider"), c.req.param("site_id"), c.req.raw, waitUntilOf(c));
  return c.json(res.body, res.status);
});
