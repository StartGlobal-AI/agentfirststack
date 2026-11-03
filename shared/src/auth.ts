import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { sha256Hex, timingSafeEqual } from "./crypto";
import { ApiError, forbidden, notFound, tooManyRequests, unauthorized } from "./errors";
import { clientNetwork, publicBaseUrl, readJson } from "./http";
import { newId, randomString } from "./ids";

/**
 * Accounts and API keys, shared by every app.
 *
 * The rule: an agent gets a working key from ONE unauthenticated request, with no email
 * verification, no captcha, no dashboard. `POST /v1/signup` -> `{ api_key }`.
 *
 * SIGNUP_MODE controls who may call it:
 *   open   anyone (default when unset; fine for local dev and private deployments)
 *   token  caller must present SIGNUP_TOKEN (body `signup_token` or header `x-signup-token`)
 *   closed only ADMIN_TOKEN (as Bearer) may create accounts
 * ADMIN_TOKEN always works, whatever the mode.
 *
 * Scopes: "*" (full access) or "read" (GET routes and read-only MCP tools only).
 *
 * Shared identity (one key for several apps): bind the same D1 database as AUTH_DB in every
 * app. Keys and accounts then live there, and each app mirrors a bare `accounts` row into its
 * own DB the first time an account shows up, so the apps' foreign keys keep working. Without
 * AUTH_DB everything lives in DB (a self-contained, single-app deployment).
 */

export interface AuthBindings {
  DB: D1Database;
  SIGNUP_MODE?: string;
  SIGNUP_TOKEN?: string;
  ADMIN_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  /** Optional Workers rate-limit binding, keyed by client IP, applied to /v1/signup. */
  SIGNUP_LIMITER?: RateLimit;
  /** Optional shared identity database (accounts + api_keys) used instead of DB. */
  AUTH_DB?: D1Database;
  /** Overrides the app's key prefix, e.g. "afs" so a multi-app deployment mints one style of key. */
  KEY_PREFIX?: string;
  /** Max signups per client network (IPv4 address or IPv6 /64) per rolling hour (needs signup_log). */
  SIGNUP_HOURLY_LIMIT?: string;
}

/** The database that holds accounts and api_keys. */
export const identityDb = (env: AuthBindings): D1Database => env.AUTH_DB ?? env.DB;

// Accounts already mirrored into this isolate's app DB. A miss costs one INSERT OR IGNORE.
const mirrored = new Set<string>();

/**
 * With a shared AUTH_DB, make sure the app's own DB has an `accounts` row for this account so
 * app tables that reference accounts(id) accept inserts. No-op without AUTH_DB.
 */
export async function ensureLocalAccount(env: AuthBindings, accountId: string): Promise<void> {
  if (!env.AUTH_DB || mirrored.has(accountId)) return;
  await env.DB.prepare("INSERT OR IGNORE INTO accounts (id, created_at) VALUES (?, ?)").bind(accountId, Date.now()).run();
  mirrored.add(accountId);
}

/** authenticate() against the identity DB, then mirror the account locally. */
export async function authenticateEnv(
  env: AuthBindings,
  token: string,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<AuthContext | null> {
  const auth = await authenticate(identityDb(env), token, waitUntil);
  if (auth) await ensureLocalAccount(env, auth.accountId);
  return auth;
}

export interface AuthContext {
  accountId: string;
  keyId: string;
  scopes: string[];
}

export type AuthEnv = { Bindings: AuthBindings; Variables: { auth: AuthContext } };

export type Scope = "*" | "read";

export const canWrite = (auth: AuthContext) => auth.scopes.includes("*");

export function assertWrite(auth: AuthContext): void {
  if (!canWrite(auth)) throw forbidden("This is a read-only key.", 'Use a key with scope "*" for changes.');
}

/** Bearer token from `Authorization: Bearer <key>` or `x-api-key: <key>`. */
export function extractKey(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    if (m?.[1]) return m[1];
  }
  return req.headers.get("x-api-key")?.trim() || null;
}

export async function authenticate(db: D1Database, token: string, waitUntil?: (p: Promise<unknown>) => void): Promise<AuthContext | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT id, account_id, scopes, last_used_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: string; account_id: string; scopes: string; last_used_at: number | null }>();
  if (!row) return null;
  const now = Date.now();
  // Touch last_used_at at most every 10 minutes to keep writes off the hot path.
  if (waitUntil && (!row.last_used_at || now - row.last_used_at > 600_000)) {
    waitUntil(db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run());
  }
  return { accountId: row.account_id, keyId: row.id, scopes: row.scopes.split(" ").filter(Boolean) };
}

function waitUntilOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined; // no ExecutionContext (e.g. some test harnesses)
  }
}

/**
 * Require a valid API key; sets `c.var.auth`. Non-GET requests need a write key, except
 * `/mcp`, where the MCP layer filters tools by scope instead.
 */
export function requireAuth<E extends AuthEnv>(): MiddlewareHandler<E> {
  return async (c, next) => {
    const token = extractKey(c.req.raw);
    if (!token) throw unauthorized();
    const auth = await authenticateEnv(c.env, token, waitUntilOf(c));
    if (!auth) throw unauthorized("That API key is unknown or revoked. POST /v1/signup for a new one.");
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    if (method !== "GET" && method !== "HEAD" && !path.startsWith("/mcp")) assertWrite(auth);
    c.set("auth", auth);
    await next();
  };
}

/** Optional auth: sets `c.var.auth` when a valid key is present, never rejects. */
export function optionalAuth<E extends AuthEnv>(): MiddlewareHandler<E> {
  return async (c, next) => {
    const token = extractKey(c.req.raw);
    if (token) {
      const auth = await authenticateEnv(c.env, token, waitUntilOf(c));
      if (auth) c.set("auth", auth);
    }
    await next();
  };
}

export async function createApiKey(
  db: D1Database,
  accountId: string,
  opts: { keyPrefix: string; name?: string | null; scope?: Scope },
): Promise<{ id: string; key: string; prefix: string; scopes: string }> {
  const key = `${opts.keyPrefix}_${randomString(40)}`;
  const id = newId("key");
  const prefix = key.slice(0, opts.keyPrefix.length + 7);
  const scopes = opts.scope ?? "*";
  await db
    .prepare("INSERT INTO api_keys (id, account_id, name, prefix, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, accountId, opts.name ?? null, prefix, await sha256Hex(key), scopes, Date.now())
    .run();
  return { id, key, prefix, scopes };
}

export async function createAccount(
  db: D1Database,
  opts: { keyPrefix: string; name?: string | null; email?: string | null },
): Promise<{ accountId: string; apiKey: { id: string; key: string; prefix: string; scopes: string } }> {
  const accountId = newId("acct");
  await db
    .prepare("INSERT INTO accounts (id, name, email, created_at) VALUES (?, ?, ?, ?)")
    .bind(accountId, opts.name ?? null, opts.email ?? null, Date.now())
    .run();
  const apiKey = await createApiKey(db, accountId, { keyPrefix: opts.keyPrefix, name: "default" });
  return { accountId, apiKey };
}

export interface AccountRoutesOptions<B extends AuthBindings> {
  /** Short key prefix, e.g. "sga" -> keys look like "sga_3k9x...". */
  keyPrefix: string;
  /** Human name of the app, used in responses. */
  appName: string;
  /** Name to use for the MCP server in the suggested `claude mcp add` command. */
  mcpName: string;
  /** Runs after the account exists; its return value is merged into the signup response. */
  onSignup?: (env: B, accountId: string) => Promise<Record<string, unknown> | void>;
  /** What an agent should do next, given the base URL. Included in the signup response. */
  nextSteps?: (baseUrl: string) => string[];
  /** Replaces the default `mcp` block of the signup response (e.g. to list several servers). */
  mcp?: (baseUrl: string, apiKey: string) => unknown;
}

const signupBody = z.object({
  name: z.string().max(200).optional(),
  email: z.string().max(320).optional(),
  signup_token: z.string().optional(),
});

const createKeyBody = z.object({
  name: z.string().max(200).optional(),
  scope: z.enum(["*", "read"]).default("*"),
});

/**
 * Mount with `app.route("/", accountRoutes({...}))`. Provides:
 *   POST   /v1/signup     -> new account + API key (no auth)
 *   GET    /v1/me         -> who am I
 *   GET    /v1/keys       -> list keys
 *   POST   /v1/keys       -> create key { name?, scope?: "*" | "read" }
 *   DELETE /v1/keys/:id   -> revoke key
 */
export function accountRoutes<B extends AuthBindings>(opts: AccountRoutesOptions<B>) {
  const app = new Hono<{ Bindings: B; Variables: { auth: AuthContext } }>();

  app.post("/v1/signup", async (c) => {
    const body = await readJson(c, signupBody);
    const env = c.env;
    const idb = identityDb(env);
    const keyPrefix = env.KEY_PREFIX || opts.keyPrefix;
    const bearer = extractKey(c.req.raw);
    let ipHash: string | null = null;
    const isAdmin = !!env.ADMIN_TOKEN && !!bearer && timingSafeEqual(bearer, env.ADMIN_TOKEN);

    if (!isAdmin) {
      const mode = (env.SIGNUP_MODE || "open").toLowerCase();
      if (mode === "closed") {
        throw forbidden("Signup is closed on this deployment.", "Ask the operator for a key, or call with the ADMIN_TOKEN as Bearer.");
      }
      if (mode === "token") {
        const presented = body.signup_token ?? c.req.header("x-signup-token") ?? "";
        if (!env.SIGNUP_TOKEN || !timingSafeEqual(presented, env.SIGNUP_TOKEN)) {
          throw forbidden("A valid signup token is required.", "Pass `signup_token` in the body or the `x-signup-token` header.");
        }
      }
      if (env.SIGNUP_LIMITER) {
        const { success } = await env.SIGNUP_LIMITER.limit({ key: clientNetwork(c.req.raw) });
        if (!success) throw tooManyRequests();
      }
      const hourly = Number(env.SIGNUP_HOURLY_LIMIT || 0);
      if (hourly > 0) {
        ipHash = (await sha256Hex(`signup|${clientNetwork(c.req.raw)}|${env.KEY_PREFIX ?? ""}`)).slice(0, 32);
        const row = await idb
          .prepare("SELECT count(*) AS n FROM signup_log WHERE ip_hash = ? AND created_at > ?")
          .bind(ipHash, Date.now() - 3_600_000)
          .first<{ n: number }>();
        if ((row?.n ?? 0) >= hourly) {
          throw tooManyRequests(`At most ${hourly} new accounts per hour from one network. Reuse your existing key, or try again later.`);
        }
      }
    }

    const { accountId, apiKey } = await createAccount(idb, {
      keyPrefix,
      name: body.name ?? null,
      email: body.email ?? null,
    });
    if (ipHash) {
      const now = Date.now();
      await idb.batch([
        idb.prepare("INSERT INTO signup_log (ip_hash, created_at) VALUES (?, ?)").bind(ipHash, now),
        idb.prepare("DELETE FROM signup_log WHERE created_at < ?").bind(now - 86_400_000),
      ]);
    }
    await ensureLocalAccount(env, accountId);
    const extra = (await opts.onSignup?.(env, accountId)) ?? {};
    const base = publicBaseUrl(c);
    return c.json(
      {
        account_id: accountId,
        api_key: apiKey.key,
        key_id: apiKey.id,
        note: "Store api_key now; it is not shown again. Send it as `Authorization: Bearer <api_key>`.",
        mcp: opts.mcp
          ? opts.mcp(base, apiKey.key)
          : {
              url: `${base}/mcp`,
              claude_code: `claude mcp add --transport http ${opts.mcpName} ${base}/mcp --header "Authorization: Bearer ${apiKey.key}"`,
            },
        docs: `${base}/llms.txt`,
        ...extra,
        next_steps: opts.nextSteps?.(base) ?? [],
      },
      201,
    );
  });

  app.use("/v1/me", requireAuth());
  app.use("/v1/keys", requireAuth());
  app.use("/v1/keys/*", requireAuth());

  app.get("/v1/me", async (c) => {
    const auth = c.var.auth;
    const account = await identityDb(c.env)
      .prepare("SELECT id, name, email, created_at FROM accounts WHERE id = ?")
      .bind(auth.accountId)
      .first();
    return c.json({ app: opts.appName, account, key: { id: auth.keyId, scopes: auth.scopes } });
  });

  app.get("/v1/keys", async (c) => {
    const { results } = await identityDb(c.env)
      .prepare(
        "SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE account_id = ? ORDER BY created_at",
      )
      .bind(c.var.auth.accountId)
      .all();
    return c.json({ keys: results });
  });

  app.post("/v1/keys", async (c) => {
    const body = await readJson(c, createKeyBody);
    const k = await createApiKey(identityDb(c.env), c.var.auth.accountId, {
      keyPrefix: c.env.KEY_PREFIX || opts.keyPrefix,
      name: body.name,
      scope: body.scope,
    });
    return c.json({ id: k.id, api_key: k.key, scopes: k.scopes, note: "Store api_key now; it is not shown again." }, 201);
  });

  app.delete("/v1/keys/:id", async (c) => {
    const res = await identityDb(c.env)
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
      .bind(Date.now(), c.req.param("id"), c.var.auth.accountId)
      .run();
    if (!res.meta.changes) throw notFound("Key", "GET /v1/keys lists your keys.");
    return c.json({ revoked: c.req.param("id") });
  });

  return app;
}

export { ApiError };
