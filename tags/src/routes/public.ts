import { edgeHost, publicBaseUrl } from "@afs/shared";
import type { Context, Next } from "hono";
import RUNTIME, { CONSENT_UI, RUNTIME_EXT } from "../runtime-bundle";
import type { AppEnv } from "../env";
import { forwardedGeo, handleCollect, requestCountry } from "../service/collect";
import { serveBannerUi, serveScript } from "../service/script";

const SCRIPT = /^(?:\/.*)?\/c\/(ctr_[a-z0-9]{8,32})\.js$/;
const BANNER_UI = /^(?:\/.*)?\/cb\/([a-z0-9]{1,16})\.js$/;
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
      { core: RUNTIME, ext: RUNTIME_EXT, ui: CONSENT_UI },
      {
        id: m[1]!,
        preview: c.req.query("preview") ?? null,
        env: c.req.query("env") ?? null,
        origin: base,
        cacheOrigin: base,
        geo: edgeHost(c.env, c.req.raw)
          ? { country: requestCountry(c.env, c.req.raw, true), region: forwardedGeo(c.req.raw, "region-code", 10) ?? cf?.regionCode }
          : { country: requestCountry(c.env, c.req.raw), region: cf?.regionCode },
        ifNoneMatch: c.req.header("if-none-match"),
      },
      c.executionCtx,
    );
  }
  const ui = BANNER_UI.exec(path);
  if (ui && (c.req.method === "GET" || c.req.method === "HEAD")) return serveBannerUi(CONSENT_UI, ui[1]!);
  if (COLLECT.test(path) && (c.req.method === "POST" || c.req.method === "OPTIONS")) return handleCollect(c.env, c.req.raw);
  return next();
}
