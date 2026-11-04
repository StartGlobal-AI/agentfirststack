import { fromBase64, onNotFound, randomString, timingSafeEqual, toBase64 } from "@afs/shared";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { type SiteEnv, isDev } from "./env";
import { MARK, googleButton, html, htmlErrorHandler, messagePage, page } from "./html";
import { upsertUser } from "./identity";
import {
  clearSessionCookie,
  endSession,
  loadSession,
  optionalSession,
  readForm,
  redirect,
  safeNext,
  secureCookies,
  serializeCookie,
  startSession,
} from "./session";

/**
 * "Sign in with Google": OpenID Connect authorization code flow with PKCE, state and nonce.
 * The ID token is read from the direct, server-to-server token response (TLS authenticates
 * Google, OIDC Core 3.1.3.7), so its claims are checked but no JWKS fetch is needed.
 */

export const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
/**
 * The sign-in state (state, nonce, PKCE verifier) lives in a `__Host-` cookie like the session:
 * Secure, Path=/, no Domain, so no sibling subdomain can plant its own state and log a visitor in
 * as someone else (login CSRF). Plain-http local dev keeps the bare name.
 */
const stateCookie = (c: Parameters<typeof secureCookies>[0]) => (secureCookies(c) ? "__Host-afs_google" : "afs_google");
const STATE_TTL_S = 600;

export const googleConfigured = (env: SiteEnv["Bindings"]) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const b64url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const pkceChallenge = async (verifier: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/** Decode and check an ID token's claims. Throws with the reason when anything is off. */
export function validateIdTokenClaims(idToken: string, expected: { clientId: string; nonce: string; now?: number }): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) throw new Error("malformed id_token");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64(parts[1])));
  } catch {
    throw new Error("unreadable id_token payload");
  }
  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) throw new Error("wrong issuer");
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === expected.clientId : Array.isArray(aud) && aud.includes(expected.clientId);
  if (!audOk) throw new Error("wrong audience");
  if (Array.isArray(aud) && aud.length > 1 && claims.azp !== expected.clientId) throw new Error("wrong authorized party");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("expired id_token");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new Error("id_token issued in the future");
  if (typeof claims.nonce !== "string" || !timingSafeEqual(claims.nonce, expected.nonce)) throw new Error("wrong nonce");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new Error("missing subject");
  if (typeof claims.email !== "string" || !claims.email.includes("@") || claims.email.length > 320) throw new Error("missing email");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("email not verified");
  const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
  return { sub: claims.sub, email: claims.email.toLowerCase(), name: str(claims.name, 200), picture: str(claims.picture, 2000) };
}

const callbackUrl = (base: string) => `${base}/auth/google/callback`;

/** The public base for redirect URIs: PUBLIC_BASE_URL, else the request origin. */
export const siteBase = (c: { env: SiteEnv["Bindings"]; req: { url: string } }) =>
  (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, "");

export const authRoutes = new Hono<SiteEnv>();
authRoutes.onError(htmlErrorHandler);

authRoutes.get("/signin", async (c) => {
  const next = safeNext(c.req.query("next"));
  const { session } = await loadSession(c);
  if (session) return redirect(next, { status: 302 });
  const google = googleConfigured(c.env);
  return page({
    title: "Sign in",
    body: html`<section class="auth">
  <div class="tile auth-card">
    <span class="solo-mark">${MARK}</span>
    <h1>Sign in</h1>
    <p class="lead">For people: claim the projects your agents set up, then manage their keys, teammates and connected chat apps.</p>
    ${
      google
        ? html`<p class="row">${googleButton(`/auth/google?next=${encodeURIComponent(next)}`)}</p>`
        : html`<p class="notice">Google sign-in isn't configured on this deployment. The operator sets <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>.</p>`
    }
    <p class="fine">We only ask Google for your name, email address and profile picture. See the <a href="/privacy">privacy policy</a> and <a href="/terms">terms</a>.</p>
  </div>
  <aside class="tile auth-aside" aria-labelledby="agents-title">
    <h2 id="agents-title">Agents never sign in</h2>
    <p>An agent gets a working API key with one request, and keeps it after you claim the project.</p>
    <pre class="snippet"><code>curl -X POST ${siteBase(c)}/v1/signup</code></pre>
    <p><a href="/llms.txt">Read the manual for agents</a></p>
  </aside>
  ${
    isDev(c.env)
      ? html`<form class="tile stack auth-dev" method="get" action="/auth/dev-login">
    <h2>Dev sign-in</h2>
    <p class="muted small">DEV_MODE is on: sign in as anyone, no Google needed.</p>
    <input type="hidden" name="next" value="${next}">
    <div class="inline-fields">
      <label class="field"><span>Email</span><input type="email" name="email" required value="dev@example.com"></label>
      <button class="btn btn-quiet" type="submit">Dev sign-in</button>
    </div>
  </form>`
      : ""
  }
</section>`,
  });
});

authRoutes.get("/auth/google", async (c) => {
  const next = safeNext(c.req.query("next"));
  if (!googleConfigured(c.env)) return redirect(`/signin?next=${encodeURIComponent(next)}`, { status: 302 });
  const state = randomString(32);
  const nonce = randomString(32);
  const verifier = randomString(64);
  const cookie = b64url(new TextEncoder().encode(JSON.stringify({ s: state, n: nonce, v: verifier, next })));
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUrl(siteBase(c)),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return redirect(url.toString(), {
    status: 302,
    cookies: [serializeCookie(stateCookie(c), cookie, { maxAge: STATE_TTL_S, path: "/", secure: secureCookies(c) })],
  });
});

const signinFailed = (reason: string) =>
  messagePage({
    title: "Sign-in didn't finish",
    message: reason,
    status: 400,
    action: { href: "/signin", label: "Try again" },
  });

authRoutes.get("/auth/google/callback", async (c) => {
  const clear = serializeCookie(stateCookie(c), "", { maxAge: 0, path: "/", secure: secureCookies(c) });
  if (!googleConfigured(c.env)) return signinFailed("Google sign-in isn't configured on this deployment.");
  if (c.req.query("error")) return signinFailed("Google sign-in was cancelled or refused.");
  let saved: { s?: string; n?: string; v?: string; next?: string } = {};
  try {
    saved = JSON.parse(new TextDecoder().decode(fromBase64(getCookie(c, stateCookie(c)) ?? "")));
  } catch {
    /* missing or garbled */
  }
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  if (!saved.s || !saved.n || !saved.v || !state || !timingSafeEqual(state, saved.s)) {
    return signinFailed("This sign-in link expired or was started in another browser. Start again from the sign-in page.");
  }
  if (!code) return signinFailed("Google didn't return a code.");

  let identity: GoogleIdentity;
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID!,
        client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: callbackUrl(siteBase(c)),
        grant_type: "authorization_code",
        code_verifier: saved.v,
      }).toString(),
    });
    const token = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !token.id_token) throw new Error(`token endpoint: ${res.status} ${token.error ?? ""}`);
    identity = validateIdTokenClaims(token.id_token, { clientId: c.env.GOOGLE_CLIENT_ID!, nonce: saved.n });
  } catch (e) {
    console.error("google sign-in failed", e instanceof Error ? e.message : e);
    return signinFailed("Google didn't confirm your account. Use an account with a verified email address and try again.");
  }
  const user = await upsertUser(c.env.DB, identity);
  const session = await startSession(c, user.id);
  return redirect(safeNext(saved.next), { status: 302, cookies: [clear, session] });
});

/**
 * Local dev and tests only: sign in as any email without Google. Answers exactly like an unknown
 * route unless DEV_MODE is "true".
 */
authRoutes.get("/auth/dev-login", async (c) => {
  if (!isDev(c.env)) return onNotFound(c);
  const email = (c.req.query("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) {
    return messagePage({ title: "Dev sign-in", message: "Pass ?email=someone@example.com.", status: 400 });
  }
  const user = await upsertUser(c.env.DB, { sub: `dev:${email}`, email, name: email.split("@")[0] ?? null });
  const session = await startSession(c, user.id);
  return redirect(safeNext(c.req.query("next")), { status: 302, cookies: [session] });
});

authRoutes.post("/auth/signout", optionalSession, async (c) => {
  if (!c.var.session) return redirect("/", { cookies: [clearSessionCookie(c)] });
  await readForm(c);
  await endSession(c, c.var.session);
  return redirect("/", { cookies: [clearSessionCookie(c)] });
});
