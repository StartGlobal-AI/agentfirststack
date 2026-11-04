import { authIssuer, cleanName, clientNetwork, createApiKey, newId, randomString, sha256Hex, timingSafeEqual } from "@afs/shared";
import { type Context, Hono } from "hono";
import { DAY, type Session, type SiteEnv } from "./env";
import { pkceChallenge, siteBase } from "./google";
import { type SafeHtml, csrfField, html, htmlErrorHandler, messagePage, page } from "./html";
import { assertRoomForGrant, createProject, getProject, listProjects, revokeGrant } from "./identity";
import { loadSession, readForm, redirect, signinUrl } from "./session";

/**
 * OAuth 2.1 authorization server for MCP connectors (claude.ai, ChatGPT and other clients that
 * follow the MCP authorization spec). Public clients only, PKCE S256 only, exact redirect_uri
 * match, single-use 10-minute codes, `iss` on the redirect (RFC 9207), rotating refresh tokens
 * where reusing a rotated one revokes the whole grant, and each refresh revokes the access tokens
 * issued before it.
 *
 * Access tokens are ordinary API keys with `expires_at` (8 hours) for the chosen project and
 * scope, so every service and the MCP gateway accept them without knowing about OAuth.
 */

export const ACCESS_TTL_MS = 8 * 3_600_000;
export const REFRESH_TTL_MS = 30 * DAY;
export const CODE_TTL_MS = 10 * 60_000;
const DEFAULT_REGISTER_HOURLY = 30;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export const issuerOf = (c: Context<SiteEnv>) => authIssuer(c.env, siteBase(c))!;

// ---------- clients ----------

export interface OAuthClient {
  id: string;
  name: string;
  redirect_uris: string[];
  created_at: number;
}

async function loadClient(db: D1Database, clientId: string | undefined): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 100) return null;
  const row = await db
    .prepare("SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?")
    .bind(clientId)
    .first<{ id: string; name: string; redirect_uris: string; created_at: number }>();
  if (!row) return null;
  return { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
}

/** https anywhere, or plain http on this machine only; no fragments, no credentials. */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2000 || raw.includes("#")) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  return false;
}

const cleanClientName = (raw: unknown) => {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim() : "";
  return name.slice(0, 80) || "Unnamed app";
};

const oauthError = (c: Context<SiteEnv>, status: 400 | 401 | 429, error: string, description: string) =>
  c.json({ error, error_description: description }, status, { ...CORS, ...NO_STORE });

// ---------- routes: metadata, registration, token, revocation (JSON, CORS) ----------

export const oauthApi = new Hono<SiteEnv>();

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["*", "read"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/auth.md`,
    op_policy_uri: `${issuer}/privacy`,
    op_tos_uri: `${issuer}/terms`,
    // auth.md agent registration: agents register anonymously with one request and get an API key;
    // a person claims the project later through a claim link (see /auth.md).
    agent_auth: {
      skill: `${issuer}/auth.md`,
      register_uri: `${issuer}/v1/signup`,
      identity_types_supported: ["anonymous"],
      anonymous: { credential_types_supported: ["api_key"] },
      claim_uri: `${issuer}/v1/claim-link`,
      revocation_uri: `${issuer}/v1/keys/{key_id}`,
    },
  };
}

oauthApi.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(authorizationServerMetadata(issuerOf(c)), 200, { ...CORS, "cache-control": "public, max-age=300" }),
);
for (const path of ["/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
  oauthApi.options(path, () => new Response(null, { status: 204, headers: CORS }));
}

/** RFC 7591 dynamic client registration. Identical registrations return the same client. */
oauthApi.post("/oauth/register", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return oauthError(c, 400, "invalid_client_metadata", "Send a JSON object with redirect_uris.");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10) {
    return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs.");
  }
  if (!uris.every(validRedirectUri)) {
    return oauthError(
      c,
      400,
      "invalid_redirect_uri",
      "Each redirect URI must be https, or http on localhost or 127.0.0.1, without a fragment.",
    );
  }
  const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return oauthError(c, 400, "invalid_client_metadata", "grant_types may only contain authorization_code and refresh_token.");
  }
  const responseTypes = body.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === "code")) {
    return oauthError(c, 400, "invalid_client_metadata", 'response_types may only contain "code".');
  }
  const name = cleanClientName(body.client_name);
  const redirectUris = [...new Set(uris as string[])];
  const clientUri = typeof body.client_uri === "string" && body.client_uri.startsWith("https://") ? body.client_uri.slice(0, 500) : null;
  const metadataHash = await sha256Hex(JSON.stringify({ name, redirectUris }));
  const db = c.env.DB;

  const respond = (id: string, createdAt: number) =>
    c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(createdAt / 1000),
        client_name: name,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Public clients: no secret is issued whatever was asked for (RFC 7591 3.2.1 allows replacing values).
        token_endpoint_auth_method: "none",
      },
      201,
      { ...CORS, ...NO_STORE },
    );

  const existing = await db.prepare("SELECT id, created_at FROM oauth_clients WHERE metadata_hash = ?").bind(metadataHash).first<{
    id: string;
    created_at: number;
  }>();
  if (existing) return respond(existing.id, existing.created_at);

  // New registrations are limited per network: a burst limit and an hourly count.
  const network = clientNetwork(c.req.raw);
  if (c.env.SIGNUP_LIMITER) {
    const { success } = await c.env.SIGNUP_LIMITER.limit({ key: `oauth-register|${network}` });
    if (!success) return oauthError(c, 429, "rate_limited", "Too many registrations. Retry in a minute.");
  }
  const ipHash = (await sha256Hex(`oauth-register|${network}`)).slice(0, 32);
  const hourly = Number(c.env.OAUTH_REGISTER_HOURLY_LIMIT || DEFAULT_REGISTER_HOURLY);
  if (hourly > 0) {
    const row = await db
      .prepare("SELECT count(*) AS n FROM oauth_clients WHERE ip_hash = ? AND created_at > ?")
      .bind(ipHash, Date.now() - 3_600_000)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= hourly) return oauthError(c, 429, "rate_limited", `At most ${hourly} new clients per hour from one network.`);
  }
  const id = newId("client", 24);
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO oauth_clients (id, name, redirect_uris, client_uri, metadata_hash, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(metadata_hash) DO NOTHING",
    )
    .bind(id, name, JSON.stringify(redirectUris), clientUri, metadataHash, ipHash, now)
    .run();
  const row = await db.prepare("SELECT id, created_at FROM oauth_clients WHERE metadata_hash = ?").bind(metadataHash).first<{
    id: string;
    created_at: number;
  }>();
  return respond(row?.id ?? id, row?.created_at ?? now);
});

async function readParams(c: Context<SiteEnv>): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  const out: Record<string, string> = {};
  try {
    if (type.includes("application/json")) {
      const j = (await c.req.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j ?? {})) if (typeof v === "string") out[k] = v;
    } else {
      const body = await c.req.parseBody();
      for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    }
  } catch {
    /* empty or malformed body: the missing parameters are reported below */
  }
  return out;
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

interface GrantRow {
  id: string;
  client_id: string;
  user_id: string;
  account_id: string;
  scope: string;
  revoked_at: number | null;
  client_name: string;
}

async function loadGrant(db: D1Database, grantId: string): Promise<GrantRow | null> {
  return db
    .prepare(
      `SELECT g.id, g.client_id, g.user_id, g.account_id, g.scope, g.revoked_at, oc.name AS client_name
         FROM oauth_grants g JOIN oauth_clients oc ON oc.id = g.client_id WHERE g.id = ?`,
    )
    .bind(grantId)
    .first<GrantRow>();
}

const stillMember = async (db: D1Database, g: GrantRow) =>
  !!(await db.prepare("SELECT 1 AS x FROM memberships WHERE user_id = ? AND account_id = ?").bind(g.user_id, g.account_id).first());

async function issueTokens(c: Context<SiteEnv>, grant: GrantRow, scope: string) {
  const db = c.env.DB;
  const now = Date.now();
  const access = await createApiKey(db, grant.account_id, {
    keyPrefix: c.env.KEY_PREFIX || "afs",
    name: grant.client_name,
    scope: scope === "read" ? "read" : "*",
    expiresAt: now + ACCESS_TTL_MS,
    oauthGrantId: grant.id,
  });
  const refresh = `${c.env.KEY_PREFIX || "afs"}r_${randomString(40)}`;
  await db.batch([
    db
      .prepare("INSERT INTO oauth_refresh_tokens (hash, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(refresh), grant.id, now, now + REFRESH_TTL_MS),
    db.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now, grant.id),
  ]);
  return c.json(
    {
      access_token: access.key,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      scope: access.scopes,
    },
    200,
    { ...CORS, ...NO_STORE },
  );
}

oauthApi.post("/oauth/token", async (c) => {
  const p = await readParams(c);
  const db = c.env.DB;
  const client = await loadClient(db, p.client_id);

  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.redirect_uri || !p.code_verifier || !p.client_id) {
      return oauthError(c, 400, "invalid_request", "code, redirect_uri, client_id and code_verifier are required.");
    }
    if (!client) return oauthError(c, 401, "invalid_client", "Unknown client_id. Register again at /oauth/register.");
    const hash = await sha256Hex(p.code);
    const code = await db
      .prepare("SELECT grant_id, client_id, redirect_uri, code_challenge, resource, expires_at, used_at FROM oauth_codes WHERE hash = ?")
      .bind(hash)
      .first<{
        grant_id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string | null;
        expires_at: number;
        used_at: number | null;
      }>();
    if (!code) return oauthError(c, 400, "invalid_grant", "Unknown authorization code.");
    // Validate before spending the code: someone who saw the code but lacks the PKCE verifier (or
    // is another client) must not be able to burn it, or revoke what it issued.
    if (code.client_id !== client.id) return oauthError(c, 400, "invalid_grant", "The code was issued to another client.");
    if (code.redirect_uri !== p.redirect_uri)
      return oauthError(c, 400, "invalid_grant", "redirect_uri doesn't match the authorization request.");
    if (!VERIFIER.test(p.code_verifier) || !timingSafeEqual(await pkceChallenge(p.code_verifier), code.code_challenge)) {
      return oauthError(c, 400, "invalid_grant", "PKCE verification failed: code_verifier doesn't match code_challenge.");
    }
    if (p.resource && code.resource && p.resource !== code.resource) {
      return oauthError(c, 400, "invalid_target", "resource doesn't match the authorization request.");
    }
    // A valid second exchange of a code that was already exchanged means the code and verifier
    // leaked: revoke what the first exchange issued.
    const reused = async () => {
      await revokeGrant(db, code.grant_id);
      return oauthError(c, 400, "invalid_grant", "This authorization code was already used; the tokens it issued are revoked.");
    };
    if (code.used_at) return reused();
    const now = Date.now();
    if (code.expires_at <= now)
      return oauthError(c, 400, "invalid_grant", "The authorization code expired. Start the authorization again.");
    // Single use: of two valid exchanges racing, only the one that flips used_at gets tokens.
    const used = await db.prepare("UPDATE oauth_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL").bind(now, hash).run();
    if (!used.meta.changes) return reused();
    const grant = await loadGrant(db, code.grant_id);
    if (!grant || grant.revoked_at || !(await stillMember(db, grant))) {
      return oauthError(c, 400, "invalid_grant", "This authorization was revoked.");
    }
    return issueTokens(c, grant, grant.scope);
  }

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token || !p.client_id) return oauthError(c, 400, "invalid_request", "refresh_token and client_id are required.");
    if (!client) return oauthError(c, 401, "invalid_client", "Unknown client_id.");
    const hash = await sha256Hex(p.refresh_token);
    const rt = await db
      .prepare("SELECT grant_id, expires_at, rotated_at FROM oauth_refresh_tokens WHERE hash = ?")
      .bind(hash)
      .first<{ grant_id: string; expires_at: number; rotated_at: number | null }>();
    if (!rt) return oauthError(c, 400, "invalid_grant", "Unknown or revoked refresh token. Authorize again.");
    const grant = await loadGrant(db, rt.grant_id);
    if (!grant || grant.revoked_at) return oauthError(c, 400, "invalid_grant", "This authorization was revoked. Authorize again.");
    if (grant.client_id !== client.id) return oauthError(c, 400, "invalid_grant", "The refresh token was issued to another client.");
    const now = Date.now();
    // Rotation: each refresh token works once. Seeing a rotated one again means it leaked, so
    // the whole grant (every refresh and access token) is revoked.
    const rotated = rt.rotated_at
      ? null
      : await db.prepare("UPDATE oauth_refresh_tokens SET rotated_at = ? WHERE hash = ? AND rotated_at IS NULL").bind(now, hash).run();
    if (!rotated?.meta.changes) {
      await revokeGrant(db, grant.id);
      return oauthError(c, 400, "invalid_grant", "This refresh token was already used, so the authorization was revoked. Authorize again.");
    }
    if (rt.expires_at <= now) return oauthError(c, 400, "invalid_grant", "The refresh token expired. Authorize again.");
    if (!(await stillMember(db, grant))) {
      await revokeGrant(db, grant.id);
      return oauthError(c, 400, "invalid_grant", "You're no longer a member of this project.");
    }
    const asked = (p.scope ?? "").split(" ").filter(Boolean);
    if (asked.some((s) => s !== "*" && s !== "read") || (grant.scope === "read" && asked.includes("*"))) {
      return oauthError(c, 400, "invalid_scope", "A refresh can't widen the granted scope.");
    }
    // A grant has one refresh chain, so the access tokens issued before this refresh are done:
    // revoke them, so a leaked old access token stops working now instead of when it expires.
    await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE oauth_grant_id = ? AND revoked_at IS NULL").bind(now, grant.id).run();
    return issueTokens(c, grant, asked.length === 1 && asked[0] === "read" ? "read" : grant.scope);
  }

  return oauthError(c, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
});

/**
 * RFC 7009. Always 200 (unknown tokens included). A refresh token ends its whole grant; an access
 * token just itself. token_type_hint is only a hint, so both kinds are looked up.
 */
oauthApi.post("/oauth/revoke", async (c) => {
  const p = await readParams(c);
  if (!p.token) return oauthError(c, 400, "invalid_request", "token is required.");
  const db = c.env.DB;
  const hash = await sha256Hex(p.token);
  const ok = () => c.body(null, 200, { ...CORS, ...NO_STORE });
  // A client may only revoke tokens issued to it (when it says who it is).
  const clientMatches = (grant: GrantRow | null) => !!grant && (!p.client_id || p.client_id === grant.client_id);

  const rt = await db.prepare("SELECT grant_id FROM oauth_refresh_tokens WHERE hash = ?").bind(hash).first<{ grant_id: string }>();
  if (rt) {
    if (clientMatches(await loadGrant(db, rt.grant_id))) await revokeGrant(db, rt.grant_id);
    return ok();
  }
  const key = await db
    .prepare("SELECT id, oauth_grant_id FROM api_keys WHERE hash = ? AND oauth_grant_id IS NOT NULL")
    .bind(hash)
    .first<{ id: string; oauth_grant_id: string }>();
  if (key && clientMatches(await loadGrant(db, key.oauth_grant_id))) {
    await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), key.id).run();
  }
  return ok();
});

// ---------- authorize: sign-in, consent, code (HTML) ----------

export const oauthPages = new Hono<SiteEnv>();
oauthPages.onError(htmlErrorHandler);

interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: "*" | "read" | "";
  resource: string | null;
}

/**
 * A failed check: `response` is what to show now. For errors the client should hear about,
 * `redirect` sends them back to it, which only the consent form (POST) uses: before a signed-in
 * person has seen the consent page, nothing redirects to a client's redirect_uri, so a freshly
 * registered client can't turn /oauth/authorize into an open redirector (RFC 9700 section 4.11.2).
 */
type Checked = { ok: true; req: AuthorizeRequest } | { ok: false; response: Response; redirect?: Response };

/** Append params to a registered redirect URI (keeping any query it already has). */
function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  return u.toString();
}

const badRequestPage = (message: string) =>
  messagePage({ title: "This connection can't continue", message, status: 400, action: { href: "/", label: "Home" } });

/** Resource indicators (RFC 8707) must name this platform: the issuer's host or a subdomain. */
function validResource(resource: string, issuer: string): boolean {
  try {
    const r = new URL(resource);
    const host = new URL(issuer).hostname;
    return !r.hash && (r.protocol === "https:" || r.protocol === "http:") && (r.hostname === host || r.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

/**
 * Validate an authorization request. Problems with the client or redirect_uri are shown here and
 * never redirected (that would be an open redirect); everything else goes back to the client.
 */
async function checkAuthorize(c: Context<SiteEnv>, p: Record<string, string | undefined>): Promise<Checked> {
  const client = await loadClient(c.env.DB, p.client_id);
  if (!client)
    return {
      ok: false,
      response: badRequestPage("The app asking for access isn't registered here (unknown client_id). Start again from the app."),
    };
  const redirectUri = p.redirect_uri ?? "";
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return {
      ok: false,
      response: badRequestPage("The app's return address doesn't match the one it registered, so we won't send you there."),
    };
  }
  const issuer = issuerOf(c);
  const fail = (error: string, description: string): Checked => ({
    ok: false,
    response: badRequestPage(`The app sent a request we can't accept (${error}: ${description}) Go back to the app and connect again.`),
    redirect: redirect(withParams(redirectUri, { error, error_description: description, state: p.state, iss: issuer }), { status: 303 }),
  });
  if (p.response_type !== "code") return fail("unsupported_response_type", 'response_type must be "code".');
  if (!p.state || p.state.length > 2048) return fail("invalid_request", "state is required.");
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? "")) {
    return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  }
  const scopes = (p.scope ?? "").split(" ").filter(Boolean);
  if (scopes.some((s) => s !== "*" && s !== "read")) return fail("invalid_scope", 'Supported scopes are "*" (full access) and "read".');
  const resource = p.resource || null;
  if (resource && !validResource(resource, issuer)) return fail("invalid_target", "resource must be an AgentFirstStack URL.");
  return {
    ok: true,
    req: {
      client,
      redirectUri,
      state: p.state,
      codeChallenge: p.code_challenge!,
      scope: scopes.includes("*") ? "*" : scopes.includes("read") ? "read" : "",
      resource,
    },
  };
}

/**
 * Lookalike folding for app names: "Сlaude" (Cyrillic С), "Ｃｌａｕｄｅ", "𝐂𝐥𝐚𝐮𝐝𝐞", "C l a u d e",
 * "Cl4ude", "ClaudeAI" and "CIaude" (capital i) all fold to the same skeleton as "Claude".
 * NFKC first (full-width, mathematical and other compatibility forms), then accents off, then
 * the common cross-script and digit confusables, then everything that isn't a letter, then the
 * pairs that read alike (rn/m, vv/w, l/i).
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: "a",
  в: "b",
  с: "c",
  ԁ: "d",
  е: "e",
  һ: "h",
  і: "i",
  ј: "j",
  к: "k",
  ӏ: "l",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  ԛ: "q",
  г: "r",
  ѕ: "s",
  т: "t",
  ѵ: "v",
  ԝ: "w",
  х: "x",
  у: "y",
  // Greek
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  μ: "u",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  γ: "y",
  ω: "w",
  // Latin lookalikes NFKC keeps
  ı: "i",
  ł: "l",
  ɡ: "g",
  ɑ: "a",
  ø: "o",
  đ: "d",
  ħ: "h",
  ŀ: "l",
  // Digits and symbols used as letters
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
};

export function nameSkeleton(name: string): string {
  return [...name.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .replace(/[^a-z]/g, "")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/l/g, "i");
}

// Names people trust, and where those apps really send you back to.
const KNOWN_APPS: { names: string[]; hosts: string[] }[] = [
  { names: ["claude", "anthropic"], hosts: ["claude.ai", "anthropic.com"] },
  { names: ["chatgpt", "openai"], hosts: ["chatgpt.com", "openai.com"] },
].map((k) => ({ ...k, names: k.names.map(nameSkeleton) }));
const hostMatches = (host: string, allowed: string[]) => allowed.some((h) => host === h || host.endsWith(`.${h}`));

/** The trusted app a client's name imitates while sending people somewhere else, if any. */
export function lookalikeOf(clientName: string, redirectHost: string) {
  const skeleton = nameSkeleton(clientName);
  return KNOWN_APPS.find((k) => k.names.some((n) => skeleton.includes(n)) && !hostMatches(redirectHost, k.hosts));
}

function consentPage(c: Context<SiteEnv>, s: Session, r: AuthorizeRequest, projects: { id: string; name: string | null }[]): Response {
  const target = new URL(r.redirectUri);
  const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  const lookalike = lookalikeOf(r.client.name, target.hostname);
  const readOnly = r.scope === "read";
  const hidden = (name: string, value: string | null) => html`<input type="hidden" name="${name}" value="${value ?? ""}">`;
  const warning: SafeHtml | string = lookalike
    ? html`<p class="notice notice-error notice-strong" role="alert"><b>Careful:</b> this app calls itself “${r.client.name}”, but it would send you to <b>${target.host}</b>, which isn't where that app lives. Deny unless you're sure.</p>`
    : local
      ? html`<p class="notice">This app runs on your own computer (it sends you back to <b>${target.host}</b>).</p>`
      : "";
  return page({
    title: `Connect ${r.client.name}`,
    session: s,
    allowExternalFormRedirect: true,
    body: html`<section class="consent">
  <div class="tile consent-card">
    <p class="consent-kind">Connection request <span class="tag">Unverified app</span></p>
    <h1><span class="client-name">${r.client.name}</span> wants to use AgentFirstStack</h1>
    <dl class="facts consent-facts">
      <div><dt>You'll be sent back to</dt><dd><b class="host">${target.host}</b><code class="redirect">${r.redirectUri}</code></dd></div>
      <div><dt>Signed in as</dt><dd>${s.user.email}</dd></div>
    </dl>
    <p class="muted small"><b>Unverified:</b> AgentFirstStack hasn't checked who made this app. It registered itself and chose the name “${r.client.name}” on its own. Only continue if you started this from <b>${target.host}</b>.</p>
    ${warning}
    <form method="post" action="/oauth/authorize" class="stack consent-form">
      ${csrfField(s)}
      ${hidden("client_id", r.client.id)}${hidden("redirect_uri", r.redirectUri)}${hidden("state", r.state)}
      ${hidden("code_challenge", r.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("response_type", "code")}
      ${hidden("scope", r.scope)}${hidden("resource", r.resource)}
      <label class="field"><span>Project</span>
        <select name="project">
          ${projects.map((p) => html`<option value="${p.id}">${p.name || "Untitled project"} (${p.id})</option>`)}
          <option value="new"${projects.length ? "" : html` selected`}>Create a new project</option>
        </select>
      </label>
      <label class="field"><span>New project name (if creating one)</span><input type="text" name="project_name" maxlength="200" placeholder="acme.com"></label>
      <fieldset class="field"><legend>Access</legend>
        ${
          readOnly
            ? html`<label class="choice"><input type="radio" name="access" value="read" checked><span><b>Read only</b> See sites, stats, containers and mail</span></label>`
            : html`<label class="choice"><input type="radio" name="access" value="*" checked><span><b>Full access</b> Create, change and delete sites, tag containers and inboxes, and send mail</span></label>
        <label class="choice"><input type="radio" name="access" value="read"><span><b>Read only</b> See sites, stats, containers and mail</span></label>`
        }
      </fieldset>
      <div class="row consent-actions">
        <button class="btn btn-primary" type="submit" name="decision" value="allow">Allow</button>
        <button class="btn btn-quiet" type="submit" name="decision" value="deny">Deny</button>
      </div>
      <p class="fine">You can disconnect it any time under <a href="/dashboard/apps">Connected apps</a>. Access tokens last 8 hours and are renewed while the app is in use.</p>
    </form>
  </div>
</section>`,
  });
}

oauthPages.get("/oauth/authorize", async (c) => {
  const checked = await checkAuthorize(c, c.req.query());
  if (!checked.ok) return checked.response;
  const { session, refresh } = await loadSession(c);
  if (!session) {
    const u = new URL(c.req.url);
    return redirect(signinUrl(`${u.pathname}${u.search}`), { status: 302 });
  }
  const projects = await listProjects(c.env.DB, session.user.id);
  const res = consentPage(c, session, checked.req, projects);
  if (refresh) res.headers.append("set-cookie", refresh);
  return res;
});

oauthPages.post("/oauth/authorize", async (c) => {
  const { session } = await loadSession(c);
  if (!session)
    return messagePage({ title: "Signed out", message: "Your session ended. Start the connection again from the app.", status: 401 });
  c.set("session", session);
  const form = await readForm(c);
  const checked = await checkAuthorize(c, form);
  // The person has seen the consent page for this client by now: client errors go back to it.
  if (!checked.ok) return checked.redirect ?? checked.response;
  const r = checked.req;
  const issuer = issuerOf(c);
  const back = (params: Record<string, string>) =>
    redirect(withParams(r.redirectUri, { ...params, state: r.state, iss: issuer }), { status: 303 });
  if (form.decision !== "allow") return back({ error: "access_denied", error_description: "The person denied access." });

  const db = c.env.DB;
  // Each connected app can mint access tokens: one person holds a bounded number of them.
  await assertRoomForGrant(db, session.user.id);
  let accountId = form.project ?? "";
  if (accountId === "new") {
    const name = cleanName(form.project_name, 200) ?? cleanName(`${r.client.name} project`, 200);
    accountId = await createProject(db, session.user.id, name);
  } else if (!(await getProject(db, session.user.id, accountId))) {
    return messagePage({ title: "Not found", message: "Project not found.", status: 404, session });
  }
  const scope = r.scope === "read" || form.access === "read" ? "read" : "*";
  const grantId = newId("grant");
  const code = randomString(43);
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO oauth_grants (id, client_id, user_id, account_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(grantId, r.client.id, session.user.id, accountId, scope, now),
    db
      .prepare(
        "INSERT INTO oauth_codes (hash, grant_id, client_id, redirect_uri, code_challenge, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(await sha256Hex(code), grantId, r.client.id, r.redirectUri, r.codeChallenge, r.resource, now, now + CODE_TTL_MS),
  ]);
  return back({ code });
});
