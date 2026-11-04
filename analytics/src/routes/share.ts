import { ApiError, randomString } from "@afs/shared";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { readTextCapped } from "../lib/body";
import { linkForToken, shareData, shareUnlocked, unlockShare } from "../service/share";
import { isVerified } from "../service/context";
import { sharePage, sharePageCsp, sharePasswordPage } from "../share-page";

/** Public, token-scoped, aggregate-only dashboard. */
export const shareRoutes = new Hono<AppEnv>();

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

shareRoutes.get("/share/:token", async (c) => {
  const token = c.req.param("token");
  const { site, link } = await linkForToken(c.env, token);
  const domain = isVerified(site) ? site.domain : null;
  const nonce = randomString(24);
  if (!(await shareUnlocked(c.env, link, getCookie(c, COOKIE), undefined)))
    return c.html(sharePasswordPage(token, domain, nonce, false), 200, pageHeaders(nonce, true));
  return c.html(sharePage(token, domain, nonce), 200, pageHeaders(nonce));
});

/** The password form is a few hundred bytes: read at most this much of the body. */
const MAX_UNLOCK_BODY = 4096;

// The password form posts here; a right password sets a 12-hour cookie scoped to this link's path.
shareRoutes.post("/share/:token/unlock", async (c) => {
  const token = c.req.param("token");
  if (Number(c.req.header("content-length")) > MAX_UNLOCK_BODY)
    return c.json({ error: { code: "payload_too_large", message: "The form is too large.", hint: "Send only the password field." } }, 413);
  const { text, truncated } = await readTextCapped(c.req.raw.body, MAX_UNLOCK_BODY);
  if (truncated)
    return c.json({ error: { code: "payload_too_large", message: "The form is too large.", hint: "Send only the password field." } }, 413);
  const password = (new URLSearchParams(text).get("password") ?? "").slice(0, 200);
  const nonce = randomString(24);
  let cookie: string | null = null;
  try {
    cookie = password ? await unlockShare(c.env, token, password, c.req.header("cf-connecting-ip") ?? null) : null;
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "too_many_attempts") throw e;
    const retry = (e.details as { retry_after?: number } | undefined)?.retry_after ?? 60;
    const { site } = await linkForToken(c.env, token);
    return c.html(sharePasswordPage(token, isVerified(site) ? site.domain : null, nonce, true, retry), 429, {
      ...pageHeaders(nonce, true),
      "retry-after": String(retry),
    });
  }
  if (!cookie) {
    const { site } = await linkForToken(c.env, token);
    return c.html(sharePasswordPage(token, isVerified(site) ? site.domain : null, nonce, true), 401, pageHeaders(nonce, true));
  }
  // Lax: a link opened from Slack or email (a top-level GET from another site) keeps the unlock;
  // the cookie only unlocks read-only GETs of this link.
  setCookie(c, COOKIE, cookie, {
    path: `/share/${token}`,
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: 12 * 3600,
  });
  return c.redirect(`/share/${token}`, 303);
});

shareRoutes.get("/share/:token/data", async (c) => {
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
