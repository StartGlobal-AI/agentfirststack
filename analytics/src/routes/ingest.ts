import type { MiddlewareHandler } from "hono";
import tracker from "../../dist/tracker.txt";
import type { AppEnv } from "../env";
import { readCapped } from "../lib/body";
import { MAX_BODY_BYTES, TOO_LARGE, ingestBrowser } from "../service/ingest";
import { waitUntilOf } from "./util";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

let etag: string | null = null;
async function trackerEtag(): Promise<string> {
  if (!etag) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tracker));
    etag = `"${[...new Uint8Array(d)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}"`;
  }
  return etag;
}

/**
 * Public ingest: GET /s.js and POST /e, also under any path prefix (/_a/s.js, /stats/e ...) so a
 * first-party proxy can forward its path unchanged. Runs before auth and before the router.
 */
export const ingestRoutes: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/v1/") || path.startsWith("/mcp") || path.startsWith("/share/") || path.startsWith("/webhooks/")) return next();
  const method = c.req.method;

  if ((path === "/s.js" || path.endsWith("/s.js")) && (method === "GET" || method === "HEAD")) {
    const tag = await trackerEtag();
    const headers = {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      etag: tag,
    };
    if (c.req.header("if-none-match") === tag) return new Response(null, { status: 304, headers });
    return new Response(method === "HEAD" ? null : tracker, { headers });
  }

  if (path === "/e" || path.endsWith("/e")) {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (method === "POST") {
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
      // Never buffer more than the limit: refuse a declared oversize body unread, and stop reading
      // a body without (or with a lying) content-length once it passes the limit.
      if (Number(c.req.header("content-length")) > MAX_BODY_BYTES) return json(413, TOO_LARGE);
      const { bytes, truncated } = await readCapped(c.req.raw.body, MAX_BODY_BYTES);
      if (truncated) return json(413, TOO_LARGE);
      const res = await ingestBrowser(c.env, c.req.raw, new TextDecoder().decode(bytes), waitUntilOf(c));
      return json(res.status, res.body);
    }
  }
  return next();
};
