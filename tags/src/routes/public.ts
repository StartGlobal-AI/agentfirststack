import { publicBaseUrl } from "@afs/shared";
import type { Context, Next } from "hono";
import RUNTIME from "../runtime-bundle";
import type { AppEnv } from "../env";
import { handleCollect } from "../service/collect";
import { serveScript } from "../service/script";

const SCRIPT = /^(?:\/.*)?\/c\/(ctr_[a-z0-9]{8,32})\.js$/;
const COLLECT = /^(?:\/.*)?\/collect$/;

/**
 * The data plane, served at the root AND under any path prefix so sites can proxy it
 * first-party (example.com/_t/c/ctr_x.js, example.com/_t/collect).
 */
export async function dataPlane(c: Context<AppEnv>, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/v1/") || path === "/mcp") return next();
  const m = SCRIPT.exec(path);
  if (m && (c.req.method === "GET" || c.req.method === "HEAD")) {
    const cf = (c.req.raw as unknown as { cf?: { country?: string; regionCode?: string } }).cf;
    const base = publicBaseUrl(c);
    return serveScript(
      c.env,
      RUNTIME,
      {
        id: m[1]!,
        preview: c.req.query("preview") ?? null,
        origin: base,
        cacheOrigin: base,
        geo: { country: cf?.country, region: cf?.regionCode },
        ifNoneMatch: c.req.header("if-none-match"),
      },
      c.executionCtx,
    );
  }
  if (COLLECT.test(path) && (c.req.method === "POST" || c.req.method === "OPTIONS")) return handleCollect(c.env, c.req.raw);
  return next();
}
