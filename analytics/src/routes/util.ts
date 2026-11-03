import { ApiError, badRequest, publicBaseUrl } from "@afs/shared";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { readTextCapped } from "../lib/body";
import type { Ctx } from "../service/context";

/** Service context for an authenticated request. */
export const ctxOf = (c: Context<AppEnv>): Ctx => ({
  env: c.env,
  accountId: c.var.auth.accountId,
  baseUrl: publicBaseUrl(c),
  callerIp: c.req.header("cf-connecting-ip") ?? null,
});

/** Largest JSON body any /v1 route reads (a batch of 100 server events fits easily). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const tooLarge = () =>
  new ApiError(
    413,
    "payload_too_large",
    `Request bodies are limited to ${MAX_JSON_BODY_BYTES / 1024 / 1024} MB.`,
    "Send fewer events or payments per request (at most 100), with shorter props.",
  );

/** JSON body as-is (empty = {}), never buffering more than MAX_JSON_BODY_BYTES; services validate it. */
export async function body(c: Context<AppEnv>): Promise<unknown> {
  if (Number(c.req.header("content-length")) > MAX_JSON_BODY_BYTES) throw tooLarge();
  const { text, truncated } = await readTextCapped(c.req.raw.body, MAX_JSON_BODY_BYTES);
  if (truncated) throw tooLarge();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("Body is not valid JSON.", "Send Content-Type: application/json with a JSON object body.");
  }
}

export function waitUntilOf(c: Context<AppEnv>): (p: Promise<unknown>) => void {
  try {
    const ec = c.executionCtx;
    return (p) => ec.waitUntil(p);
  } catch {
    return (p) => void p.catch(() => {});
  }
}
