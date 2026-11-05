import { forbidden, INTERNAL_KEY_ID } from "@afs/shared";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { purgeAccount } from "../service/purge";

/**
 * Internal plumbing, no MCP tool: the platform's purge erases a deleted project's data here, over
 * a service binding with internal auth (the account is in x-afs-account). API keys never may.
 */
export const account = new Hono<AppEnv>();

account.delete("/account", async (c) => {
  if (c.var.auth.keyId !== INTERNAL_KEY_ID)
    throw forbidden(
      "Only the platform erases a project's data here.",
      "Projects are deleted on the platform: the owner deletes it from the dashboard, or an agent of an unclaimed project calls DELETE https://agentfirststack.com/v1/me. This app's data is erased 7 days later.",
    );
  return c.json(await purgeAccount(c.env, c.var.auth.accountId));
});
