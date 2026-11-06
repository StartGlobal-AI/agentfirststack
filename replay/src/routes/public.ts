import { networkKey, onError, publicBaseUrl, userContentOrigin } from "@afs/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type AppEnv, isDev } from "../env";
import { expiredPage, PLAYER_HEADERS, pausedPage, playerHeaders, playerPage, reportAbuseUrl } from "../player-page";
import { platformBase } from "../service/install";
import { geo, ingestChunk, visitorIp } from "../service/ingest";
import { proxyTrust } from "../service/proxy";
import { playerChunk, playerData, playerUrl, recordView, resolveToken, siteHostsForCsp } from "../service/links";
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
    // Per network before the site lookup: random site ids can't make D1 reads cheaply. A keyed
    // path proxy's visitors count as their own networks (the key is derived, no D1 read).
    const trust = await proxyTrust(c.env, c.req.raw, loader[1]!);
    const limiter = c.env.INGEST_IP_LIMITER;
    if (
      limiter &&
      !(await limiter.limit({ key: `l:${networkKey(visitorIp(c.req.raw, c.env, trust))}` }).then(
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
      geo(c.req.raw, isDev(c.env), c.env, trust).country,
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

/**
 * The human player behind share links (page, its JSON, its chunks) and its assets, mounted twice:
 *
 *   service host     /play/<token>, /play/<token>/data, /play/<token>/chunks/<seq>, /assets/<name>
 *   user-content     /r/<token>, /r/<token>/data, /r/<token>/chunks/<seq>, /r/assets/<name>, on
 *                    USER_CONTENT_BASE_URL (a domain of its own, so the recorded pages it shows
 *                    share no cookie or origin with the platform). That host serves nothing else.
 *
 * With USER_CONTENT_BASE_URL set, new links point at the user-content host and a page on the
 * service host answers 301 to the same link there while the link is valid (expired, revoked and
 * paused links answer as before). Its /data and /chunks keep answering, for players opened before.
 */
function mountPlayer(r: Hono<AppEnv>, mount: { page: string; assets: string; pageUrl: (c: Context<AppEnv>, token: string) => string }) {
  r.get(`${mount.assets}/:name`, async (c) => (await servePlayerAsset(c.req.param("name"))) ?? c.notFound());

  r.get(`${mount.page}/:token`, async (c) => {
    const token = c.req.param("token");
    const res = await resolveToken(c.env, token);
    const abuse = reportAbuseUrl(platformBase(c.env), mount.pageUrl(c, token));
    if (res === "paused") return c.html(pausedPage(abuse), 403, PLAYER_HEADERS);
    if (!res) return c.html(expiredPage(), 404, PLAYER_HEADERS);
    const moved = mount.page === "/play" ? userContentOrigin(c.env) : null;
    if (moved) {
      // Not cached by browsers: the target follows the link (and the deployment's host) as it is now.
      c.header("cache-control", "no-store");
      c.header("x-robots-tag", "noindex, nofollow");
      c.header("referrer-policy", "no-referrer");
      return c.redirect(`${playerUrl(c.env, publicBaseUrl(c), token)}${new URL(c.req.url).search}`, 301);
    }
    waitUntilOf(c)(recordView(c.env, res.link.id).catch(() => {}));
    const h = await playerHash();
    return c.html(
      playerPage({ js: `${mount.assets}/player-${h}.js`, css: `${mount.assets}/player-${h}.css` }, abuse),
      200,
      playerHeaders(siteHostsForCsp(c.env, res.site)),
    );
  });

  r.get(`${mount.page}/:token/data`, async (c) => {
    const res = await resolveToken(c.env, c.req.param("token"));
    const headers = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
    if (res === "paused") return c.json(PAUSED, 403, headers);
    if (!res) return c.json({ error: { code: "not_found", message: "This replay link has expired or was revoked." } }, 404, headers);
    const d = await playerData(c.env, res);
    if (!d) return c.json({ error: { code: "not_found", message: "The session is no longer stored." } }, 404, headers);
    return c.json(d, 200, headers);
  });

  r.get(`${mount.page}/:token/chunks/:seq`, async (c) => {
    const seq = c.req.param("seq");
    const res = /^\d{1,6}$/.test(seq) ? await resolveToken(c.env, c.req.param("token")) : null;
    if (res === "paused") return c.json(PAUSED, 403, { "x-robots-tag": "noindex" });
    if (!res) return c.json({ error: { code: "not_found", message: "This replay link has expired or was revoked." } }, 404);
    const body = await playerChunk(c.env, res, Number(seq));
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
}

const PAUSED = {
  error: {
    code: "capability_paused",
    message: "Share links of this project are paused while it is reviewed.",
    hint: "Nothing to do here; the project's people were emailed.",
  },
};

/** The player on the service host (/play/..., /assets/...). */
export const playerRoutes = new Hono<AppEnv>();
mountPlayer(playerRoutes, { page: "/play", assets: "/assets", pageUrl: (c, token) => `${publicBaseUrl(c)}/play/${token}` });

/** The user-content host (USER_CONTENT_BASE_URL): the player under /r/ and nothing else. */
export const userContentRoutes = new Hono<AppEnv>();
userContentRoutes.onError(onError);
userContentRoutes.notFound((c) => c.text("Not found", 404, { "x-robots-tag": "noindex", "x-content-type-options": "nosniff" }));
mountPlayer(userContentRoutes, { page: "/r", assets: "/r/assets", pageUrl: (c, token) => playerUrl(c.env, publicBaseUrl(c), token) });
