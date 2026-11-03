import { publicBaseUrl, readJson } from "@afs/shared";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Ctx } from "../service/context";

/** Service context for an authenticated request. */
export const ctxOf = (c: Context<AppEnv>): Ctx => ({ env: c.env, accountId: c.var.auth.accountId, baseUrl: publicBaseUrl(c) });

/** JSON body as-is (empty = {}); services validate it with their own schema. */
export const body = (c: Context<AppEnv>) => readJson(c, z.unknown());

export function waitUntilOf(c: Context<AppEnv>): (p: Promise<unknown>) => void {
  try {
    const ec = c.executionCtx;
    return (p) => ec.waitUntil(p);
  } catch {
    return (p) => void p.catch(() => {});
  }
}
