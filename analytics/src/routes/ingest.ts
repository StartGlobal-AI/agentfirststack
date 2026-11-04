import type { MiddlewareHandler } from "hono";
import tracker from "../../dist/tracker.txt";
import trackerLinker from "../../dist/tracker-linker.txt";
import type { AppEnv } from "../env";
import { readCapped } from "../lib/body";
import { MAX_BODY_BYTES, TOO_LARGE, ingestBrowser } from "../service/ingest";
import { isReservedPath, isTrackerPath } from "../service/install";
import { waitUntilOf } from "./util";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const etags = new Map<string, string>();
async function trackerEtag(text: string): Promise<string> {
  let etag = etags.get(text.length + text.slice(-40));
  if (!etag) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    etag = `"${[...new Uint8Array(d)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}"`;
    etags.set(text.length + text.slice(-40), etag);
  }
  return etag;
}

/**
 * Public ingest: GET /s.js and POST /e, also under any path prefix (/_a/s.js, /stats/e ...) so a
 * first-party proxy can forward its path unchanged. Runs before auth and before the router.
 */
export const ingestRoutes: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (isReservedPath(path)) return next();
  const method = c.req.method;

  if (isTrackerPath(path) && (method === "GET" || method === "HEAD")) {
    // ?linker=1: the build with cross-domain linking (data-cross-domain); otherwise the default one
    const text = new URL(c.req.url).searchParams.get("linker") === "1" ? trackerLinker : tracker;
    const tag = await trackerEtag(text);
    const headers = {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      etag: tag,
    };
    if (c.req.header("if-none-match") === tag) return new Response(null, { status: 304, headers });
    return new Response(method === "HEAD" ? null : text, { headers });
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
