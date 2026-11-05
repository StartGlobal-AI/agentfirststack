import { forbidden, INTERNAL_KEY_ID } from "@afs/shared";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { purgeAccount } from "../service/purge";

/**
 * DELETE /v1/account: erase this app's data of a deleted project. Internal plumbing, not an agent
 * capability (no MCP tool): only the platform's purge cron calls it, over a service binding with
 * internal auth, 7 days after the project was deleted. Auth is applied by the parent app.
 */
export const account = new Hono<AppEnv>();

account.delete("/account", async (c) => {
  if (c.var.auth.keyId !== INTERNAL_KEY_ID)
    throw forbidden(
      "API keys can't erase a project's replay data.",
      "Projects are deleted on the platform: the owner deletes it from the dashboard, or an agent of an unclaimed project calls DELETE https://agentfirststack.com/v1/me. This app's data is erased 7 days later.",
    );
  return c.json(await purgeAccount(c.env, c.var.auth.accountId));
});
