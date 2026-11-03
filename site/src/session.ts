import { ApiError, randomString, sha256Hex, timingSafeEqual } from "@afs/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { DAY, type Session, type SiteEnv, type User, isDev } from "./env";

/**
 * Browser sessions for people who sign in. The cookie holds 43 random characters; the database
 * only their SHA-256. The CSRF token is derived from the raw cookie value, so it's never stored
 * and can't be computed from a database copy.
 */

export const SESSION_COOKIE = "afs_session";
export const SESSION_TTL = 30 * DAY;
const SESSION_TOKEN = /^[0-9a-z]{43}$/;

export interface CookieOptions {
  maxAge: number; // seconds; 0 deletes
  path?: string;
  secure?: boolean;
}

/** HttpOnly, SameSite=Lax, host-only (no Domain: the apex only). */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

/** Secure everywhere except plain-http local dev (DEV_MODE), where browsers would drop it. */
export const secureCookies = (c: Context<SiteEnv>) => !isDev(c.env) || new URL(c.req.url).protocol === "https:";

export function redirect(location: string, opts: { status?: 302 | 303; cookies?: string[] } = {}): Response {
  const headers = new Headers({ location, "cache-control": "no-store", "referrer-policy": "same-origin" });
  for (const cookie of opts.cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(null, { status: opts.status ?? 303, headers });
}

/** Only a same-origin path survives (no scheme, no host, no `//` or backslash tricks). */
export function safeNext(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || raw.length > 4096) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const base = "https://same-origin.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}

const csrfFor = async (token: string) => sha256Hex(`csrf|${token}`);

/** Create a session row; returns the Set-Cookie value. */
export async function startSession(c: Context<SiteEnv>, userId: string): Promise<string> {
  const token = randomString(43);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL)
    .run();
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL / 1000, secure: secureCookies(c) });
}

export const clearSessionCookie = (c: Context<SiteEnv>) => serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure: secureCookies(c) });

/**
 * The signed-in user, if any. Extends the session (sliding 30 days) at most once a day and then
 * returns the refreshed Set-Cookie value to send.
 */
export async function loadSession(c: Context<SiteEnv>): Promise<{ session: Session | null; refresh?: string }> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !SESSION_TOKEN.test(token)) return { session: null };
  const hash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.expires_at, u.id, u.email, u.name, u.picture, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, now)
    .first<User & { expires_at: number }>();
  if (!row) return { session: null };
  const { expires_at, ...user } = row;
  const session: Session = { user, hash, csrf: await csrfFor(token) };
  if (expires_at - now < SESSION_TTL - DAY) {
    await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE hash = ?")
      .bind(now + SESSION_TTL, hash)
      .run();
    return { session, refresh: serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL / 1000, secure: secureCookies(c) }) };
  }
  return { session };
}

export async function endSession(c: Context<SiteEnv>, session: Session): Promise<void> {
  await c.env.DB.prepare("DELETE FROM sessions WHERE hash = ?").bind(session.hash).run();
}

export const signinUrl = (next: string) => `/signin?next=${encodeURIComponent(safeNext(next))}`;

const appendCookie = (res: Response, cookie: string) => {
  try {
    res.headers.append("set-cookie", cookie);
  } catch {
    // Immutable headers (a fetched response): skip the refresh; the session still slides in the DB.
  }
};

/** Pages for signed-in people: redirects to sign-in (coming back here) when there's no session. */
export const requireSession: MiddlewareHandler<SiteEnv> = async (c, next) => {
  const { session, refresh } = await loadSession(c);
  if (!session) {
    const u = new URL(c.req.url);
    return redirect(signinUrl(c.req.method === "GET" ? `${u.pathname}${u.search}` : "/dashboard"));
  }
  c.set("session", session);
  await next();
  if (refresh) appendCookie(c.res, refresh);
};

/** Loads the session when there is one, never redirects. */
export const optionalSession: MiddlewareHandler<SiteEnv> = async (c, next) => {
  const { session, refresh } = await loadSession(c);
  if (session) c.set("session", session);
  await next();
  if (refresh) appendCookie(c.res, refresh);
};

export const csrfFailed = () =>
  new ApiError(403, "csrf_failed", "This form expired or came from another site.", "Go back, reload the page and try again.");

/**
 * Parse a POSTed form and check its CSRF token (and, when the browser sends one, the Origin).
 * Returns the string fields.
 */
export async function readForm(c: Context<SiteEnv>): Promise<Record<string, string>> {
  const session = c.var.session;
  const origin = c.req.header("origin");
  if (origin && origin !== "null" && origin !== new URL(c.req.url).origin) throw csrfFailed();
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.parseBody();
  } catch {
    throw csrfFailed();
  }
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") form[k] = v;
  if (!session || !timingSafeEqual(form.csrf ?? "", session.csrf)) throw csrfFailed();
  return form;
}
