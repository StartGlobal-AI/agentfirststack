import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getUsage } from "../service/usage";
import { ctxOf } from "./util";

/** GET /v1/usage: every fair-use cap for the account with what it uses now (MCP get_usage). Read keys work. */
export const usageRoutes = new Hono<AppEnv>();

usageRoutes.get("/", async (c) => c.json(await getUsage(ctxOf(c))));
