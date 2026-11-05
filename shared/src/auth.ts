import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { sha256Hex, timingSafeEqual } from "./crypto";
import { ApiError, accountSuspended, badRequest, forbidden, notFound, tooManyRequests, unauthorized } from "./errors";
import { clientAsn, clientNetwork, publicBaseUrl, readJson } from "./http";
import { newId, randomString } from "./ids";
import { noticeAttacher } from "./notices";
import { accountStanding, capFor } from "./standing";
import { cleanName } from "./text";

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
  /** Max signups per client network (IPv4 address or IPv6 /48) per rolling hour (needs signup_log). */
  SIGNUP_HOURLY_LIMIT?: string;
  /** Max signups per client network per rolling day (needs signup_log). */
  SIGNUP_DAILY_LIMIT?: string;
  /** Max signups per network operator (request.cf.asn) per rolling day (needs signup_log). */
  SIGNUP_ASN_DAILY_LIMIT?: string;
  /** Max signups on the whole deployment per rolling hour: a circuit breaker (needs signup_log). */
  SIGNUP_GLOBAL_HOURLY_LIMIT?: string;
  /** Active API keys per account (default 50). UNCLAIMED_MAX_KEYS_PER_ACCOUNT for agent-only accounts. */
  MAX_KEYS_PER_ACCOUNT?: string;
  UNCLAIMED_MAX_KEYS_PER_ACCOUNT?: string;
  /** New API keys per account per rolling hour, revoked ones included (off when unset). */
  KEYS_HOURLY_LIMIT?: string;
  /** Optional Workers rate-limit binding, keyed by account, applied to API key creation. */
  KEY_LIMITER?: RateLimit;
  /**
   * Secret shared by the Workers of one deployment. A request with `x-afs-internal: <token>` and
   * `x-afs-account: acct_...` is a full-access caller for that account (the site's dashboard
   * uses it over service bindings). Unset = internal auth is off.
   */
  INTERNAL_TOKEN?: string;
  /** The OAuth authorization server listed in RFC 9728 metadata (the site's public URL). */
  AUTH_ISSUER?: string;
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
  /** Set on OAuth access tokens: the grant (connected app) that issued the key. */
  oauthGrantId?: string;
  /** Set on keys that expire (OAuth access tokens): unix ms. */
  expiresAt?: number;
}

export type AuthEnv = { Bindings: AuthBindings; Variables: { auth: AuthContext } };

export type Scope = "*" | "read";

export const canWrite = (auth: AuthContext) => auth.scopes.includes("*");

export function assertWrite(auth: AuthContext): void {
  if (!canWrite(auth)) throw forbidden("This is a read-only key.", 'Use a key with scope "*" for changes.');
}

/**
 * An expiring credential: an OAuth access token a connected app holds for a few hours. It may use
 * the project, but must not mint anything that outlives it (API keys, claim links), or
 * disconnecting the app wouldn't end its access.
 */
export const isTemporaryCredential = (auth: AuthContext) => !!auth.oauthGrantId || auth.expiresAt !== undefined;

export function assertPermanentKey(auth: AuthContext, action: string): void {
  if (!isTemporaryCredential(auth)) return;
  throw new ApiError(
    403,
    "temporary_credential",
    `A connected app's access token can't ${action}.`,
    "Access tokens from OAuth expire, and nothing they create may outlive them. Use the project's own API key, or a person can do this in the dashboard.",
  );
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

/** "no such column/table": an older schema, the only error a fallback query may answer for. */
export const isSchemaError = (e: unknown) => /no such (column|table)/i.test(String((e as Error)?.message ?? e));

export async function authenticate(db: D1Database, token: string, waitUntil?: (p: Promise<unknown>) => void): Promise<AuthContext | null> {
  const hash = await sha256Hex(token);
  // k.*: the optional columns (expires_at, oauth_grant_id) exist in the identity DB, and only some
  // of them in a standalone app's DB; selecting them by name would fail there.
  type KeyRow = {
    id: string;
    account_id: string;
    scopes: string;
    last_used_at: number | null;
    expires_at?: number | null;
    oauth_grant_id?: string | null;
    suspended_at?: number | null;
  };
  let row: KeyRow | null;
  try {
    row = await db
      .prepare(
        "SELECT k.*, a.suspended_at AS suspended_at FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.hash = ? AND k.revoked_at IS NULL",
      )
      .bind(hash)
      .first<KeyRow>();
  } catch (e) {
    // A database that hasn't run the account_standing migration yet: no suspension to check.
    // Any other error (D1 unavailable) fails closed instead of skipping the suspension check.
    if (!isSchemaError(e)) throw e;
    row = await db.prepare("SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL").bind(hash).first<KeyRow>();
  }
  if (!row) return null;
  // A suspended account's keys all stop at once, with an error that says why.
  if (row.suspended_at != null) throw accountSuspended();
  const now = Date.now();
  // Keys with an expiry (OAuth access tokens) stop working the moment it passes.
  if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at <= now) return null;
  // Touch last_used_at at most every 10 minutes to keep writes off the hot path.
  if (waitUntil && (!row.last_used_at || now - row.last_used_at > 600_000)) {
    waitUntil(db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run());
  }
  const auth: AuthContext = { accountId: row.account_id, keyId: row.id, scopes: row.scopes.split(" ").filter(Boolean) };
  if (row.oauth_grant_id) auth.oauthGrantId = row.oauth_grant_id;
  if (row.expires_at !== null && row.expires_at !== undefined) auth.expiresAt = row.expires_at;
  return auth;
}

/** keyId of callers authenticated with INTERNAL_TOKEN instead of an API key. */
export const INTERNAL_KEY_ID = "internal";

const ACCOUNT_ID = /^acct_[0-9a-z]{1,64}$/;

/**
 * Requests between the Workers of a deployment go over service bindings to `https://<app>.internal`
 * (the caller of a binding picks the URL). A request from the internet can't carry that host:
 * Cloudflare routes public traffic by hostname, and `.internal` is not a routable domain, so it
 * only ever reaches a Worker through a binding.
 */
export const INTERNAL_HOST_SUFFIX = ".internal";

export function viaServiceBinding(req: Request): boolean {
  try {
    return new URL(req.url).hostname.endsWith(INTERNAL_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Internal auth between the Workers of one deployment: the request came over a service binding
 * (see viaServiceBinding), `x-afs-internal` equals INTERNAL_TOKEN (constant-time) and
 * `x-afs-account` names an existing account.
 * Returns null when the request doesn't use it (no header, or INTERNAL_TOKEN unset), false when
 * it does but arrived from the internet or the token or account is wrong, else a full-access
 * AuthContext for that account.
 */
export async function internalAuth(env: AuthBindings, req: Request): Promise<AuthContext | null | false> {
  const secret = env.INTERNAL_TOKEN;
  const presented = req.headers.get("x-afs-internal");
  if (!secret || presented === null) return null;
  if (!viaServiceBinding(req)) return false;
  if (!timingSafeEqual(presented, secret)) return false;
  const accountId = req.headers.get("x-afs-account") ?? "";
  if (!ACCOUNT_ID.test(accountId)) return false;
  const idb = identityDb(env);
  let row: { id: string; suspended_at?: number | null } | null;
  try {
    row = await idb.prepare("SELECT id, suspended_at FROM accounts WHERE id = ?").bind(accountId).first();
  } catch (e) {
    if (!isSchemaError(e)) throw e;
    row = await idb.prepare("SELECT id FROM accounts WHERE id = ?").bind(accountId).first();
  }
  if (!row) return false;
  // A suspended account stays readable to the deployment's own Workers (the dashboard's
  // inventory), but nothing may change it on its behalf.
  if (row.suspended_at != null && req.method !== "GET" && req.method !== "HEAD") throw accountSuspended();
  await ensureLocalAccount(env, accountId);
  return { accountId, keyId: INTERNAL_KEY_ID, scopes: ["*"] };
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
    const internal = await internalAuth(c.env, c.req.raw);
    if (internal === false) {
      throw unauthorized(
        "Internal credentials are wrong, or not accepted here (they only work between this deployment's Workers). Use an API key.",
      );
    }
    if (internal) {
      c.set("auth", internal);
      await next();
      return;
    }
    const token = extractKey(c.req.raw);
    if (!token) throw unauthorized();
    const auth = await authenticateEnv(c.env, token, waitUntilOf(c));
    if (!auth) throw unauthorized("That API key is unknown, revoked or expired. POST /v1/signup for a new one.");
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    if (method !== "GET" && method !== "HEAD" && !path.startsWith("/mcp")) assertWrite(auth);
    c.set("auth", auth);
    // The project's notice, if the platform has one (notices.ts): looked up (cached) while the
    // handler runs, then added to the answer. API-key and OAuth callers only, never internal ones.
    const attach = noticeAttacher(c.env, auth.accountId, c.req.raw);
    await next();
    if (attach) await attach(c);
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
  opts: {
    keyPrefix: string;
    name?: string | null;
    scope?: Scope;
    /** Unix ms after which the key stops working (OAuth access tokens). */
    expiresAt?: number;
    /** The OAuth grant an access token belongs to (identity DB only). */
    oauthGrantId?: string;
    /** The signed-in user who created the key in the dashboard (identity DB only). */
    createdByUserId?: string;
  },
): Promise<{ id: string; key: string; prefix: string; scopes: string }> {
  const key = `${opts.keyPrefix}_${randomString(40)}`;
  const id = newId("key");
  const prefix = key.slice(0, opts.keyPrefix.length + 7);
  const scopes = opts.scope ?? "*";
  const row: Record<string, unknown> = {
    id,
    account_id: accountId,
    name: opts.name ?? null,
    prefix,
    hash: await sha256Hex(key),
    scopes,
    created_at: Date.now(),
  };
  // Optional columns only when used, so plain signups write exactly what they always have.
  if (opts.expiresAt !== undefined) row.expires_at = opts.expiresAt;
  if (opts.oauthGrantId !== undefined) row.oauth_grant_id = opts.oauthGrantId;
  if (opts.createdByUserId !== undefined) row.created_by_user_id = opts.createdByUserId;
  const cols = Object.keys(row);
  await db
    .prepare(`INSERT INTO api_keys (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
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

// ---------- fair use: API keys per account ----------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Active API keys an account may hold when MAX_KEYS_PER_ACCOUNT is unset. */
export const DEFAULT_MAX_KEYS_PER_ACCOUNT = 50;

/** A positive whole number from a var, else 0 (off). */
const limitOf = (v: string | undefined) => {
  const n = Number(v || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * An account's API keys, not counting OAuth access tokens (those come and go with refreshes and
 * are bounded by their grants): how many are active now, and how many were created in the last
 * hour (revoked ones included, so create-and-revoke churn counts too).
 */
async function keyCounts(db: D1Database, accountId: string, now: number): Promise<{ active: number; lastHour: number }> {
  const sql = (activeExpr: string, where: string) =>
    `SELECT coalesce(sum(CASE WHEN ${activeExpr} THEN 1 ELSE 0 END), 0) AS active,
            coalesce(sum(CASE WHEN created_at > ?2 THEN 1 ELSE 0 END), 0) AS last_hour
       FROM api_keys WHERE account_id = ?3${where}`;
  // The identity DB has oauth_grant_id and expires_at; a standalone app's DB may have neither.
  const attempts = [
    sql("revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)", " AND oauth_grant_id IS NULL"),
    sql("revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)", ""),
    sql("revoked_at IS NULL AND ?1 = ?1", ""),
  ];
  let lastError: unknown;
  for (const q of attempts) {
    try {
      const row = await db
        .prepare(q)
        .bind(now, now - HOUR_MS, accountId)
        .first<{ active: number; last_hour: number }>();
      return { active: Number(row?.active ?? 0), lastHour: Number(row?.last_hour ?? 0) };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Refuse a new API key when the account already holds MAX_KEYS_PER_ACCOUNT active keys (default
 * 50; UNCLAIMED_MAX_KEYS_PER_ACCOUNT for accounts no person has claimed), has created
 * KEYS_HOURLY_LIMIT keys in the last hour, or trips the KEY_LIMITER burst limit. Counted in the
 * identity DB, so every app (and the site's dashboard) shares one count per account.
 */
export async function assertCanCreateKey(env: AuthBindings, accountId: string): Promise<void> {
  if (env.KEY_LIMITER) {
    const { success } = await env.KEY_LIMITER.limit({ key: `keys|${accountId}` });
    if (!success) throw tooManyRequests("Creating API keys too fast. Wait a minute, then retry.");
  }
  const standing = await accountStanding(env, accountId);
  const max = capFor(env as unknown as Record<string, unknown>, standing, "MAX_KEYS_PER_ACCOUNT", DEFAULT_MAX_KEYS_PER_ACCOUNT);
  const hourly = limitOf(env.KEYS_HOURLY_LIMIT);
  const { active, lastHour } = await keyCounts(identityDb(env), accountId, Date.now());
  if (active >= max) {
    throw new ApiError(
      409,
      "too_many_keys",
      `This account already has ${active} active API keys (at most ${max}).`,
      "Reuse a key you already have, or revoke ones you no longer use (GET /v1/keys lists them, DELETE /v1/keys/:id revokes one), then retry.",
    );
  }
  if (hourly && lastHour >= hourly) {
    throw tooManyRequests(`At most ${hourly} new API keys per hour for one account. Reuse an existing key, or retry later.`);
  }
}

// ---------- fair use: signups ----------

interface SignupLimit {
  key: string;
  windowMs: number;
  max: number;
  error: () => ApiError;
}

const signupKey = async (s: string) => (await sha256Hex(s)).slice(0, 32);

/** The signup limits that are on, each counted in signup_log under its own key. */
async function signupLimits(env: AuthBindings, req: Request): Promise<SignupLimit[]> {
  const prefix = env.KEY_PREFIX ?? "";
  const out: SignupLimit[] = [];
  const hourly = limitOf(env.SIGNUP_HOURLY_LIMIT);
  const daily = limitOf(env.SIGNUP_DAILY_LIMIT);
  if (hourly || daily) {
    // Same key as before the daily limit existed, so counts carry over a deploy.
    const key = await signupKey(`signup|${clientNetwork(req)}|${prefix}`);
    if (hourly) {
      out.push({
        key,
        windowMs: HOUR_MS,
        max: hourly,
        error: () =>
          tooManyRequests(`At most ${hourly} new accounts per hour from one network. Reuse your existing key, or try again later.`),
      });
    }
    if (daily) {
      out.push({
        key,
        windowMs: DAY_MS,
        max: daily,
        error: () =>
          tooManyRequests(`At most ${daily} new accounts per day from one network. Reuse your existing key, or try again tomorrow.`),
      });
    }
  }
  const asnDaily = limitOf(env.SIGNUP_ASN_DAILY_LIMIT);
  const asn = clientAsn(req);
  if (asnDaily && asn !== null) {
    out.push({
      key: await signupKey(`signup-asn|${asn}|${prefix}`),
      windowMs: DAY_MS,
      max: asnDaily,
      error: () =>
        tooManyRequests(
          `At most ${asnDaily} new accounts per day from one network provider (AS${asn}). Reuse your existing key, or try again tomorrow.`,
        ),
    });
  }
  const global = limitOf(env.SIGNUP_GLOBAL_HOURLY_LIMIT);
  if (global) {
    out.push({
      key: await signupKey(`signup-global|${prefix}`),
      windowMs: HOUR_MS,
      max: global,
      error: () =>
        new ApiError(
          429,
          "signups_paused",
          "New signups are paused for a while: this deployment is getting unusually many.",
          "Existing keys keep working. Reuse yours if you have one, or retry in 15 minutes.",
        ),
    });
  }
  return out;
}

/**
 * Take a signup slot: insert first, then count, so concurrent signups each see the others' rows
 * and can't overrun a limit by racing (two racers at the limit are both refused, never both let
 * in). A refused signup takes its rows back out, so refused attempts don't count: a blocked
 * network can't trip the deployment-wide breaker by hammering. Returns a release function for a
 * signup that fails after taking the slot. Rows are pruned by the site's daily cron
 * (pruneSignupLog), never on this path.
 */
async function takeSignupSlot(db: D1Database, limits: SignupLimit[]): Promise<() => Promise<void>> {
  if (!limits.length) return async () => {};
  const now = Date.now();
  const keys = [...new Set(limits.map((l) => l.key))];
  const inserted = await db.batch(keys.map((k) => db.prepare("INSERT INTO signup_log (ip_hash, created_at) VALUES (?, ?)").bind(k, now)));
  const rowids = inserted.map((r) => Number(r.meta.last_row_id));
  const release = async () => {
    await db
      .prepare(`DELETE FROM signup_log WHERE rowid IN (${rowids.map(() => "?").join(", ")})`)
      .bind(...rowids)
      .run();
  };
  // One query over the (ip_hash, created_at) index: a count per limit.
  const cols = limits.map((_, i) => `coalesce(sum(CASE WHEN ip_hash = ? AND created_at > ? THEN 1 ELSE 0 END), 0) AS n${i}`);
  const oldest = now - Math.max(...limits.map((l) => l.windowMs));
  const counts = await db
    .prepare(`SELECT ${cols.join(", ")} FROM signup_log WHERE ip_hash IN (${keys.map(() => "?").join(", ")}) AND created_at > ?`)
    .bind(...limits.flatMap((l) => [l.key, now - l.windowMs]), ...keys, oldest)
    .first<Record<string, number>>();
  // Our own row is in each count, so a limit of N allows N.
  const over = limits.find((l, i) => Number(counts?.[`n${i}`] ?? 0) > l.max);
  if (over) {
    await release();
    throw over.error();
  }
  return release;
}

/** New projects one signed-in person may create per day (OAuth consent "new project"). */
export const DEFAULT_PROJECTS_PER_USER_DAILY = 5;

/**
 * The signup gate for an account created some other way than POST /v1/signup (a person creating
 * a project while connecting an app over OAuth): the deployment's SIGNUP_MODE, the same
 * per-network, per-provider and deployment-wide counts, and a per-person daily count
 * (PROJECTS_PER_USER_DAILY_LIMIT, default 5; "0" = off). Returns a release function for an
 * account that then fails to be created.
 */
export async function reserveNewAccount(env: AuthBindings, req: Request, userId: string): Promise<() => Promise<void>> {
  const mode = (env.SIGNUP_MODE || "open").toLowerCase();
  if (mode !== "open")
    throw forbidden("New projects can't be created on this deployment.", "Connect an existing project, or ask the operator for one.");
  // No SIGNUP_LIMITER burst check here: a signed-in person is already capped per day below.
  const limits = await signupLimits(env, req);
  const raw = (env as unknown as Record<string, unknown>).PROJECTS_PER_USER_DAILY_LIMIT;
  const perUser = raw === undefined || raw === "" ? DEFAULT_PROJECTS_PER_USER_DAILY : limitOf(String(raw));
  if (perUser) {
    limits.push({
      key: await signupKey(`signup-user|${userId}|${env.KEY_PREFIX ?? ""}`),
      windowMs: DAY_MS,
      max: perUser,
      error: () =>
        tooManyRequests(`At most ${perUser} new projects a day for one person. Connect an existing project, or try again tomorrow.`),
    });
  }
  return takeSignupSlot(identityDb(env), limits);
}

/**
 * Delete signup_log rows older than the longest window (a day), with a margin. The site's daily
 * cron calls it for the identity DB; a standalone app can call it from its own scheduled handler.
 */
export async function pruneSignupLog(db: D1Database, now = Date.now()): Promise<number> {
  const r = await db
    .prepare("DELETE FROM signup_log WHERE created_at < ?")
    .bind(now - 2 * DAY_MS)
    .run();
  return r.meta.changes ?? 0;
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
 *   POST   /v1/keys       -> create key { name?, scope?: "*" | "read" } (not with an OAuth access token; capped per account)
 *   DELETE /v1/keys/:id   -> revoke key
 */
/**
 * Rename the project (the account). Shared by PATCH /v1/me on every app and the gateway's
 * afs_update_project tool; the name shows in the owner's dashboard and claim page.
 */
export async function renameProject(env: AuthBindings, accountId: string, raw: unknown) {
  const name = cleanName(raw, 100);
  if (!name)
    throw badRequest("Pass a name: 1-100 visible characters.", 'Use the site\'s domain or the product name, e.g. {"name":"acme.com"}.');
  const db = identityDb(env);
  await db.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(name, accountId).run();
  const account = await db.prepare("SELECT id, name, email, created_at FROM accounts WHERE id = ?").bind(accountId).first();
  return { account };
}

export function accountRoutes<B extends AuthBindings>(opts: AccountRoutesOptions<B>) {
  const app = new Hono<{ Bindings: B; Variables: { auth: AuthContext } }>();

  app.post("/v1/signup", async (c) => {
    // Agents sign up from a terminal or a server, which send neither header. A browser on some
    // other page does (a no-cors POST needs no preflight), and enough visitors to such a page
    // would use up the deployment-wide hourly signups for everyone.
    const fetchSite = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") || (origin && origin !== new URL(c.req.url).origin)) {
      throw forbidden(
        "Signup isn't available to scripts on other websites.",
        "Call POST /v1/signup from your agent, a terminal or a server (curl, fetch in Node), not from browser JavaScript.",
      );
    }
    const body = await readJson(c, signupBody);
    const env = c.env;
    const idb = identityDb(env);
    const keyPrefix = env.KEY_PREFIX || opts.keyPrefix;
    const bearer = extractKey(c.req.raw);
    let release = async () => {};
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
      // One shared count per network, provider and deployment, in the identity DB (every app's
      // signup counts against the same rows).
      release = await takeSignupSlot(idb, await signupLimits(env, c.req.raw));
    }

    let created: Awaited<ReturnType<typeof createAccount>>;
    try {
      // Names show up in the dashboard and in prompts people paste into their agent: one line of text.
      created = await createAccount(idb, {
        keyPrefix,
        name: cleanName(body.name, 200),
        email: cleanName(body.email, 320),
      });
    } catch (e) {
      await release().catch(() => {});
      throw e;
    }
    const { accountId, apiKey } = created;
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

  app.patch("/v1/me", async (c) => {
    const body = await readJson(c, z.object({ name: z.string().max(400) }));
    return c.json(await renameProject(c.env, c.var.auth.accountId, body.name));
  });

  app.get("/v1/keys", async (c) => {
    const { results } = await identityDb(c.env)
      .prepare(
        "SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at, expires_at FROM api_keys WHERE account_id = ? ORDER BY created_at",
      )
      .bind(c.var.auth.accountId)
      .all();
    return c.json({ keys: results });
  });

  app.post("/v1/keys", async (c) => {
    const auth = c.var.auth;
    // An 8-hour OAuth token minting a permanent key would survive disconnecting the app.
    assertPermanentKey(auth, "create API keys");
    const body = await readJson(c, createKeyBody);
    await assertCanCreateKey(c.env, auth.accountId);
    const idb = identityDb(c.env);
    // A key made with a person's dashboard key belongs to that person too: removing them from
    // the project revokes it with theirs.
    let createdByUserId: string | undefined;
    try {
      const parent = await idb
        .prepare("SELECT created_by_user_id FROM api_keys WHERE id = ?")
        .bind(auth.keyId)
        .first<{ created_by_user_id: string | null }>();
      createdByUserId = parent?.created_by_user_id ?? undefined;
    } catch (e) {
      if (!isSchemaError(e)) throw e; // a standalone app's DB has no people columns
    }
    const k = await createApiKey(idb, auth.accountId, {
      keyPrefix: c.env.KEY_PREFIX || opts.keyPrefix,
      name: cleanName(body.name, 200),
      scope: body.scope,
      createdByUserId,
    });
    return c.json({ id: k.id, api_key: k.key, scopes: k.scopes, note: "Store api_key now; it is not shown again." }, 201);
  });

  app.delete("/v1/keys/:id", async (c) => {
    const auth = c.var.auth;
    // A connected app (an OAuth access token, perhaps a member's) may end its own tokens, not
    // the project's keys: in the dashboard that is the owner's call.
    if (isTemporaryCredential(auth)) {
      const target = await identityDb(c.env)
        .prepare("SELECT oauth_grant_id FROM api_keys WHERE id = ? AND account_id = ?")
        .bind(c.req.param("id"), auth.accountId)
        .first<{ oauth_grant_id: string | null }>();
      if (target && target.oauth_grant_id !== auth.oauthGrantId) assertPermanentKey(auth, "revoke the project's API keys");
    }
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
