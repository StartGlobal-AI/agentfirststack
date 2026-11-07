import { ApiError, onError, publicBaseUrl, randomString, userContentOrigin } from "@afs/shared";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { readTextCapped } from "../lib/body";
import { linkForToken, shareData, shareReport, shareUnlocked, shareUrl, unlockShare } from "../service/share";
import { isVerified } from "../service/context";
import {
  platformOrigin,
  reportAbuseUrl,
  shareAppCsp,
  shareAppPage,
  shareMovedPage,
  sharePage,
  sharePageCsp,
  sharePasswordPage,
} from "../share-page";

/**
 * Public, token-scoped, aggregate-only dashboard, mounted twice:
 *
 *   service host     /share/<token>, /share/<token>/data, POST /share/<token>/unlock
 *   user-content     /a/<token>, /a/<token>/data, POST /a/<token>/unlock, on USER_CONTENT_BASE_URL
 *                    (a domain of its own: the page shows visitor-sent paths and referrers, and its
 *                    unlock cookie is set there, so nothing is shared with the platform's domain).
 *                    Analytics serves nothing else there; the site Worker serves the rest of the
 *                    host, including the dashboard's static scripts, styles and fonts.
 *   both             <base>/<token>/data/<report> (and data/funnels/<fnl_...>): one dashboard report
 *                    (service/share.ts shareReport), what the dashboard page reads.
 *
 * On the user-content host the page is the dashboard itself (dashboard-app.js in shared mode,
 * share-page.ts shareAppPage), reading the reports above. The service host keeps the small
 * standalone page (sharePage): a deployment without a user-content host may not serve the
 * dashboard's files at all.
 *
 * With USER_CONTENT_BASE_URL set, new links point at the user-content host and a dashboard page on
 * the service host answers 301 to the same link there while the link is valid (revoked, expired,
 * suspended and paused links answer as before). /share/<token>/data keeps answering (scripts with
 * x-share-password, pages opened before).
 */
export const shareRoutes = new Hono<AppEnv>();

/** The user-content host (USER_CONTENT_BASE_URL): the dashboards under /a/ and nothing else. */
export const userContentRoutes = new Hono<AppEnv>();
userContentRoutes.onError(onError);
userContentRoutes.notFound((c) => c.text("Not found", 404, { "x-robots-tag": "noindex", "x-content-type-options": "nosniff" }));

const COOKIE = "afs_share";
const pageHeaders = (nonce: string, formAction = false) => ({
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  // Clickjacking: no site may frame the dashboard (CSP for current browsers, X-Frame-Options for old ones).
  "content-security-policy": sharePageCsp(nonce, formAction),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
});

/** The Workers cache (caches.default), when this runtime has one. */
function edgeCache(): Cache | null {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

/** The password form is a few hundred bytes: read at most this much of the body. */
const MAX_UNLOCK_BODY = 4096;

function mountShare(r: Hono<AppEnv>, base: "/share" | "/a") {
  /** The page's own URL: what its "Report abuse" link names. */
  const pageUrl = (c: Context<AppEnv>, token: string) =>
    base === "/a" ? shareUrl(c.env, publicBaseUrl(c), token) : `${publicBaseUrl(c)}/share/${token}`;
  const reportFor = (c: Context<AppEnv>, token: string) => reportAbuseUrl(c.env, pageUrl(c, token));
  /** The service host's pages moved to the user-content host (only for a link that is valid). */
  const movedTo = (c: Context<AppEnv>, token: string) =>
    base === "/share" && userContentOrigin(c.env) ? shareUrl(c.env, publicBaseUrl(c), token) : null;

  r.get(`${base}/:token`, async (c) => {
    const token = c.req.param("token");
    const { site, link } = await linkForToken(c.env, token);
    const moved = movedTo(c, token);
    if (moved) {
      // Not cached by browsers: the target follows the link (and the deployment's host) as it is now.
      c.header("cache-control", "no-store");
      c.header("x-robots-tag", "noindex, nofollow");
      c.header("referrer-policy", "no-referrer");
      return c.redirect(`${moved}${new URL(c.req.url).search}`, 301);
    }
    const domain = isVerified(site) ? site.domain : null;
    const nonce = randomString(24);
    if (!(await shareUnlocked(c.env, link, getCookie(c, COOKIE), undefined)))
      return c.html(sharePasswordPage(token, domain, nonce, false, undefined, reportFor(c, token), base), 200, pageHeaders(nonce, true));
    if (base === "/a") {
      const segment = link.segment_id
        ? await c.env.DB.prepare("SELECT name FROM segments WHERE id = ? AND site_id = ?")
            .bind(link.segment_id, site.id)
            .first<{ name: string }>()
        : null;
      const page = shareAppPage({
        token,
        domain,
        currency: (site as { currency?: string | null }).currency ?? null,
        timezone: site.timezone,
        segment: segment?.name ?? null,
        expiresAt: link.expires_at,
        reportUrl: reportFor(c, token),
        platform: platformOrigin(c.env),
        base,
      });
      return c.html(page, 200, { ...pageHeaders(nonce), "content-security-policy": shareAppCsp });
    }
    return c.html(sharePage(token, domain, nonce, reportFor(c, token), base), 200, pageHeaders(nonce));
  });

  // The password form posts here; a right password sets a 12-hour cookie scoped to this link's path
  // on this host (host-only: no Domain attribute).
  r.post(`${base}/:token/unlock`, async (c) => {
    const token = c.req.param("token");
    if (Number(c.req.header("content-length")) > MAX_UNLOCK_BODY)
      return c.json(
        { error: { code: "payload_too_large", message: "The form is too large.", hint: "Send only the password field." } },
        413,
      );
    // A form loaded on the service host before the move: its CSP (form-action 'self') would block
    // a redirect to the new host, so it gets a link to the dashboard there instead.
    const moved = movedTo(c, token);
    if (moved) {
      await linkForToken(c.env, token);
      const nonce = randomString(24);
      return c.html(shareMovedPage(moved, nonce), 200, pageHeaders(nonce));
    }
    const { text, truncated } = await readTextCapped(c.req.raw.body, MAX_UNLOCK_BODY);
    if (truncated)
      return c.json(
        { error: { code: "payload_too_large", message: "The form is too large.", hint: "Send only the password field." } },
        413,
      );
    const password = (new URLSearchParams(text).get("password") ?? "").slice(0, 200);
    const nonce = randomString(24);
    let cookie: string | null = null;
    try {
      cookie = password ? await unlockShare(c.env, token, password, c.req.header("cf-connecting-ip") ?? null) : null;
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "too_many_attempts") throw e;
      const retry = (e.details as { retry_after?: number } | undefined)?.retry_after ?? 60;
      const { site } = await linkForToken(c.env, token);
      return c.html(sharePasswordPage(token, isVerified(site) ? site.domain : null, nonce, true, retry, reportFor(c, token), base), 429, {
        ...pageHeaders(nonce, true),
        "retry-after": String(retry),
      });
    }
    if (!cookie) {
      const { site } = await linkForToken(c.env, token);
      return c.html(
        sharePasswordPage(token, isVerified(site) ? site.domain : null, nonce, true, undefined, reportFor(c, token), base),
        401,
        pageHeaders(nonce, true),
      );
    }
    // Lax: a link opened from Slack or email (a top-level GET from another site) keeps the unlock;
    // the cookie only unlocks read-only GETs of this link.
    setCookie(c, COOKIE, cookie, {
      path: `${base}/${token}`,
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      maxAge: 12 * 3600,
    });
    return c.redirect(`${base}/${token}`, 303);
  });

  /**
   * One dashboard report. A link without a password is public, so its answers are cached at the
   * edge for a minute (realtime counts for 15 s) by URL, whatever order the query is in: a busy
   * link reads the site's numbers once a minute per location, not once per viewer. A cached answer
   * can outlive a revoke by at most that long. Password links are never cached outside the browser.
   */
  const report = async (c: Context<AppEnv>, name: string, funnel: string | null) => {
    const token = c.req.param("token") ?? "";
    const key = new URL(c.req.url);
    key.searchParams.sort();
    const keyReq = new Request(key.toString());
    const cache = edgeCache();
    const hit = cache ? await cache.match(keyReq).catch(() => undefined) : undefined;
    if (hit) return hit;
    const { body, open } = await shareReport(c.env, token, name, funnel, c.req.query(), {
      cookie: getCookie(c, COOKIE),
      password: c.req.header("x-share-password"),
      ip: c.req.header("cf-connecting-ip") ?? null,
      baseUrl: publicBaseUrl(c),
    });
    const ttl = name === "realtime" ? 15 : 60;
    const res = c.json(body, 200, {
      "cache-control": `${open ? "public" : "private"}, max-age=${ttl}`,
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    if (open && cache) {
      const put = cache.put(keyReq, res.clone()).catch(() => {});
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put; // no execution context (tests)
      }
    }
    return res;
  };
  r.get(`${base}/:token/data/funnels/:funnel`, (c) => report(c, "funnels", c.req.param("funnel")));
  r.get(`${base}/:token/data/:report`, (c) => report(c, c.req.param("report"), null));

  r.get(`${base}/:token/data`, async (c) => {
    const data = await shareData(c.env, c.req.param("token"), c.req.query(), {
      cookie: getCookie(c, COOKIE),
      password: c.req.header("x-share-password"),
      ip: c.req.header("cf-connecting-ip") ?? null,
    });
    return c.json(data, 200, {
      "cache-control": "private, max-age=60",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });
}

mountShare(shareRoutes, "/share");
mountShare(userContentRoutes, "/a");
