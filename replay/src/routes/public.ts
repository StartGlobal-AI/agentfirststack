import { clientIp, networkKey, publicBaseUrl } from "@afs/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { type AppEnv, isDev } from "../env";
import { expiredPage, PLAYER_HEADERS, playerHeaders, playerPage } from "../player-page";
import { geo, ingestChunk } from "../service/ingest";
import { playerChunk, playerData, recordView, resolveToken, siteHostsForCsp } from "../service/links";
import { playerHash, servePlayerAsset, serveLoader, serveRecorder } from "../service/scripts";
import { serveSurveyScript, submitSurvey } from "../service/survey-ingest";
import { waitUntilOf } from "./api";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * Browser-facing, unauthenticated: GET /r/<site>.js (loader), GET /recorder.<hash>.js, POST /i
 * (chunks). Also answered under any path prefix (/_r/r/<site>.js, /_r/i, ...), so a first-party
 * proxy can forward its path unchanged; the loader derives the base it uses from its own src.
 */
export const browserRoutes: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (/^\/(v1|mcp|play|assets|\.well-known)(\/|$)/.test(path)) return next();
  const method = c.req.method;
  const loader = /\/r\/([^/]+)\.js$/.exec(path);
  if (loader && (method === "GET" || method === "HEAD")) {
    // Per network before the site lookup: random site ids can't make D1 reads cheaply.
    const limiter = c.env.INGEST_IP_LIMITER;
    if (
      limiter &&
      !(await limiter.limit({ key: `l:${networkKey(clientIp(c.req.raw))}` }).then(
        (r) => r.success,
        () => true,
      ))
    )
      return new Response("/* afs-replay: too many requests */\n", {
        status: 429,
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
      });
    const res = await serveLoader(
      c.env,
      loader[1]!,
      publicBaseUrl(c),
      c.req.header("if-none-match") ?? null,
      geo(c.req.raw, isDev(c.env)).country,
    );
    return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  }
  const rec = /\/(?:recorder\.|rec\/)([0-9a-f]{6,64})\.js$/.exec(path);
  if (rec && (method === "GET" || method === "HEAD")) return serveRecorder(rec[1]!);
  const sv = /\/sv\/([^/.]+)\.[0-9a-z]{1,20}\.js$/.exec(path);
  if (sv && (method === "GET" || method === "HEAD")) {
    // the widget derives its base from its own src, like the loader: /<prefix>/sv/... works behind a proxy
    const res = await serveSurveyScript(c.env, c.req.raw, sv[1]!, publicBaseUrl(c));
    return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
  }
  if (path === "/f" || path.endsWith("/f")) {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (method === "POST") {
      const r = await submitSurvey(c.env, c.req.raw, waitUntilOf(c));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
  }
  if (path === "/i" || path.endsWith("/i")) {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (method === "POST") {
      const r = await ingestChunk(c.env, c.req.raw, waitUntilOf(c));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
    }
  }
  return next();
};

/** The human player behind share links, and its assets. */
export const playerRoutes = new Hono<AppEnv>();

playerRoutes.get("/assets/:name", async (c) => (await servePlayerAsset(c.req.param("name"))) ?? c.notFound());

playerRoutes.get("/play/:token", async (c) => {
  const r = await resolveToken(c.env, c.req.param("token"));
  if (!r) return c.html(expiredPage(), 404, PLAYER_HEADERS);
  waitUntilOf(c)(recordView(c.env, r.link.id).catch(() => {}));
  const h = await playerHash();
  return c.html(
    playerPage({ js: `/assets/player-${h}.js`, css: `/assets/player-${h}.css` }),
    200,
    playerHeaders(siteHostsForCsp(c.env, r.site)),
  );
});

playerRoutes.get("/play/:token/data", async (c) => {
  const r = await resolveToken(c.env, c.req.param("token"));
  const headers = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
  if (!r) return c.json({ error: { code: "not_found", message: "This replay link has expired or was revoked." } }, 404, headers);
  const d = await playerData(c.env, r);
  if (!d) return c.json({ error: { code: "not_found", message: "The session is no longer stored." } }, 404, headers);
  return c.json(d, 200, headers);
});

playerRoutes.get("/play/:token/chunks/:seq", async (c) => {
  const seq = c.req.param("seq");
  const r = /^\d{1,6}$/.test(seq) ? await resolveToken(c.env, c.req.param("token")) : null;
  if (!r) return c.json({ error: { code: "not_found", message: "This replay link has expired or was revoked." } }, 404);
  const body = await playerChunk(c.env, r, Number(seq));
  if (body === "budget")
    return c.json(
      { error: { code: "rate_limited", message: "This link served its daily share of recording data; it works again tomorrow (UTC)." } },
      429,
    );
  if (!body) return c.json({ error: { code: "not_found", message: "Chunk not stored." } }, 404);
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
});
