import { ApiError, INTERNAL_KEY_ID, accountStanding, forbidden } from "@afs/shared";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { purgeAccount } from "../service/purge";

/**
 * DELETE /v1/account: erase the account's analytics data. Platform plumbing, not an agent
 * capability (so no MCP tool): the site's cron calls it over a service binding with internal auth,
 * 7 days after the project was deleted, and again while it answers done: false.
 */
export const accountPurgeRoutes = new Hono<AppEnv>();

accountPurgeRoutes.delete("/", async (c) => {
  if (c.var.auth.keyId !== INTERNAL_KEY_ID)
    throw forbidden(
      "This app's data is erased by the platform when a project is deleted, not with an API key.",
      "Projects are deleted on the platform: the owner deletes it from the dashboard, or an agent of an unclaimed project calls DELETE https://agentfirststack.com/v1/me. This app's data is erased 7 days later.",
    );
  // Only a deleted project's data is erased, whoever asks.
  if (!(await accountStanding(c.env, c.var.auth.accountId)).deleted)
    throw new ApiError(
      409,
      "not_deleted",
      "This project isn't deleted, so its data isn't erased.",
      "Projects are deleted on the platform first (dashboard, or DELETE https://agentfirststack.com/v1/me); the site erases them 7 days later.",
    );
  return c.json(await purgeAccount(c.env, c.var.auth.accountId));
});
