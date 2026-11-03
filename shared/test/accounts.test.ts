import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { handleMcp } from "../src/mcp";
import {
  type AuthBindings,
  type AuthContext,
  authenticate,
  createAccount,
  createApiKey,
  internalAuth,
  mcpChallenge,
  onError,
  protectedResourceRoutes,
  requireAuth,
  resourceMetadataUrl,
} from "../src/index";
import { memoryD1 } from "./d1";

// The identity schema (site/migrations) and the standalone app template (shared/migrations).
const IDENTITY = new URL("../../site/migrations/", import.meta.url);
const TEMPLATE = new URL("../migrations/", import.meta.url);

async function account(db: D1Database) {
  return createAccount(db, { keyPrefix: "afs", name: "test" });
}

describe("authenticate", () => {
  it("accepts live keys and rejects revoked and expired ones", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId, apiKey } = await account(db);
    expect(await authenticate(db, apiKey.key)).toMatchObject({ accountId, keyId: apiKey.id, scopes: ["*"] });
    expect(await authenticate(db, "afs_nope")).toBeNull();

    const later = await createApiKey(db, accountId, { keyPrefix: "afs", scope: "read", expiresAt: Date.now() + 60_000 });
    expect(await authenticate(db, later.key)).toMatchObject({ scopes: ["read"] });

    const expired = await createApiKey(db, accountId, { keyPrefix: "afs", expiresAt: Date.now() - 1 });
    expect(await authenticate(db, expired.key)).toBeNull();

    await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(Date.now(), apiKey.id).run();
    expect(await authenticate(db, apiKey.key)).toBeNull();
  });

  it("works on a standalone app database (template migrations only)", async () => {
    const db = memoryD1(TEMPLATE);
    const { accountId, apiKey } = await account(db);
    expect((await authenticate(db, apiKey.key))?.accountId).toBe(accountId);
    const expired = await createApiKey(db, accountId, { keyPrefix: "afs", expiresAt: Date.now() - 1 });
    expect(await authenticate(db, expired.key)).toBeNull();
  });

  it("records OAuth and creator metadata only when given", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId, apiKey } = await account(db);
    const k = await createApiKey(db, accountId, {
      keyPrefix: "afs",
      name: "Claude",
      expiresAt: 123,
      oauthGrantId: "grant_x",
      createdByUserId: "usr_y",
    });
    const row = await db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(k.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ name: "Claude", expires_at: 123, oauth_grant_id: "grant_x", created_by_user_id: "usr_y" });
    const plain = await db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(apiKey.id).first<Record<string, unknown>>();
    expect(plain).toMatchObject({ expires_at: null, oauth_grant_id: null, created_by_user_id: null });
  });
});

describe("internal auth", () => {
  const app = new Hono<{ Bindings: AuthBindings; Variables: { auth: AuthContext } }>();
  app.onError(onError);
  app.use("/v1/*", requireAuth());
  app.get("/v1/who", (c) => c.json(c.var.auth));
  app.post("/v1/who", (c) => c.json(c.var.auth));

  const internal = (token: string, accountId: string) => ({ "x-afs-internal": token, "x-afs-account": accountId });

  it("is off without INTERNAL_TOKEN", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId } = await account(db);
    const res = await app.request("/v1/who", { headers: internal("", accountId) }, { DB: db });
    expect(res.status).toBe(401);
    expect((await app.request("/v1/who", { headers: internal("anything", accountId) }, { DB: db })).status).toBe(401);
    expect(await internalAuth({ DB: db }, new Request("http://x", { headers: internal("anything", accountId) }))).toBeNull();
  });

  it("accepts the right token for an existing account as a full-access caller", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId } = await account(db);
    const env = { DB: db, INTERNAL_TOKEN: "s3cret-internal" };
    const get = await app.request("/v1/who", { headers: internal("s3cret-internal", accountId) }, env);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ accountId, keyId: "internal", scopes: ["*"] });
    const post = await app.request("/v1/who", { method: "POST", headers: internal("s3cret-internal", accountId) }, env);
    expect(post.status).toBe(200);
  });

  it("rejects a wrong token, an unknown account and a malformed one", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId, apiKey } = await account(db);
    const env = { DB: db, INTERNAL_TOKEN: "s3cret-internal" };
    expect((await app.request("/v1/who", { headers: internal("s3cret-internaL", accountId) }, env)).status).toBe(401);
    expect((await app.request("/v1/who", { headers: internal("s3cret", accountId) }, env)).status).toBe(401);
    expect((await app.request("/v1/who", { headers: internal("s3cret-internal", "acct_doesnotexist0000") }, env)).status).toBe(401);
    expect((await app.request("/v1/who", { headers: internal("s3cret-internal", "' OR 1=1 --") }, env)).status).toBe(401);
    // A wrong internal header is not silently downgraded to the API key next to it.
    const both = { ...internal("wrong", accountId), authorization: `Bearer ${apiKey.key}` };
    expect((await app.request("/v1/who", { headers: both }, env)).status).toBe(401);
    // Keys keep working when internal auth is on.
    const keyed = await app.request("/v1/who", { headers: { authorization: `Bearer ${apiKey.key}` } }, env);
    expect(await keyed.json()).toMatchObject({ accountId, keyId: apiKey.id });
  });

  it("mirrors the account into the app DB with a shared AUTH_DB", async () => {
    const idb = memoryD1(IDENTITY);
    const appDb = memoryD1(TEMPLATE);
    const { accountId } = await account(idb);
    const env = { DB: appDb, AUTH_DB: idb, INTERNAL_TOKEN: "t0ken" };
    expect((await app.request("/v1/who", { headers: internal("t0ken", accountId) }, env)).status).toBe(200);
    expect(await appDb.prepare("SELECT id FROM accounts WHERE id = ?").bind(accountId).first()).toEqual({ id: accountId });
  });

  it("rejects expired keys in requireAuth", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId } = await account(db);
    const k = await createApiKey(db, accountId, { keyPrefix: "afs", expiresAt: Date.now() - 1000 });
    const res = await app.request("/v1/who", { headers: { authorization: `Bearer ${k.key}` } }, { DB: db });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { hint: string } }).error.hint).toMatch(/expired/);
  });
});

describe("protected resource metadata (RFC 9728)", () => {
  const app = new Hono<{ Bindings: AuthBindings }>();
  app.route("/", protectedResourceRoutes({ name: "Test service" }));
  const site = new Hono<{ Bindings: AuthBindings }>();
  site.route("/", protectedResourceRoutes({ name: "Site", defaultIssuer: (c) => new URL(c.req.url).origin }));

  it("lists the authorization server from AUTH_ISSUER", async () => {
    const env = { DB: memoryD1(), AUTH_ISSUER: "https://example.com/" };
    const res = await app.request("https://analytics.example.com/.well-known/oauth-protected-resource/mcp", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      resource: "https://analytics.example.com/mcp",
      resource_name: "Test service",
      authorization_servers: ["https://example.com"],
      resource_documentation: "https://analytics.example.com/llms.txt",
      bearer_methods_supported: ["header"],
      scopes_supported: ["*", "read"],
    });
    const root = await app.request("https://analytics.example.com/.well-known/oauth-protected-resource", {}, env);
    expect(((await root.json()) as { resource: string }).resource).toBe("https://analytics.example.com");
    const pre = await app.request("https://analytics.example.com/.well-known/oauth-protected-resource", { method: "OPTIONS" }, env);
    expect(pre.status).toBe(204);
  });

  it("leaves authorization_servers out for a standalone app, and uses the site's default", async () => {
    const plain = await app.request("https://a.example/.well-known/oauth-protected-resource", {}, { DB: memoryD1() });
    expect(await plain.json()).not.toHaveProperty("authorization_servers");
    const own = await site.request("https://example.org/.well-known/oauth-protected-resource", {}, { DB: memoryD1() });
    expect(((await own.json()) as { authorization_servers: string[] }).authorization_servers).toEqual(["https://example.org"]);
  });

  it("builds the metadata URL and challenge from the request", () => {
    expect(resourceMetadataUrl(new Request("https://tags.example.com/mcp"))).toBe(
      "https://tags.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(resourceMetadataUrl(new Request("https://example.com/"))).toBe("https://example.com/.well-known/oauth-protected-resource");
    expect(mcpChallenge(new Request("https://x.test/mcp"), true)).toBe(
      'Bearer realm="mcp", resource_metadata="https://x.test/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    );
  });
});

describe("handleMcp 401", () => {
  const opts = { name: "t", version: "0", register: () => {} };
  const post = (headers: Record<string, string> = {}) =>
    new Request("https://mail.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("points at the resource metadata, with and without a bad key", async () => {
    const db = memoryD1(IDENTITY);
    const none = await handleMcp(post(), { DB: db }, opts);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      'Bearer realm="mcp", resource_metadata="https://mail.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    const bad = await handleMcp(post({ authorization: "Bearer afs_wrong" }), { DB: db }, opts);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("rejects an expired key and accepts a live one", async () => {
    const db = memoryD1(IDENTITY);
    const { accountId, apiKey } = await account(db);
    const expired = await createApiKey(db, accountId, { keyPrefix: "afs", expiresAt: Date.now() - 1 });
    expect((await handleMcp(post({ authorization: `Bearer ${expired.key}` }), { DB: db }, opts)).status).toBe(401);
    const ok = await handleMcp(post({ authorization: `Bearer ${apiKey.key}` }), { DB: db }, opts);
    expect(ok.status).toBe(200);
  });
});
