import { authenticate, createApiKey } from "@afs/shared";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/cleanup";
import { E, call, signup } from "./helpers";

const mcp = (key: string, method: string, params: unknown = {}) =>
  call("POST", "/mcp", {
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 7, method, params },
  });

describe("MCP gateway", () => {
  it("lists afs_create_claim_link for full-access keys and creates a link with it", async () => {
    const agent = await signup("gw");
    const list = await mcp(agent.key, "tools/list");
    const tools = list.json.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools[0]?.name).toBe("afs_create_claim_link");
    expect(tools[0]?.annotations?.readOnlyHint).toBe(false);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["analytics_whoami", "tags_whoami", "mail_whoami", "replay_whoami"]));

    const res = await mcp(agent.key, "tools/call", { name: "afs_create_claim_link", arguments: {} });
    expect(res.json.id).toBe(7);
    expect(res.json.result.isError).toBeUndefined();
    const body = JSON.parse(res.json.result.content[0].text);
    expect(body.url).toMatch(/^https:\/\/afs\.test\/claim\/[0-9a-z]{40}$/);
    expect(body.account_id).toBe(agent.accountId);
    expect(body.next_steps.length).toBeGreaterThan(0);
    // It's a real link.
    expect((await call("GET", new URL(body.url).pathname)).status).toBe(200);

    const init = await mcp(agent.key, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.json.result.instructions).toContain("afs_create_claim_link");
  });

  it("hides and refuses the claim tool for read-only keys", async () => {
    const agent = await signup();
    const read = (await call("POST", "/v1/keys", { key: agent.key, json: { scope: "read" } })).json.api_key as string;
    const names = ((await mcp(read, "tools/list")).json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("afs_create_claim_link");
    expect(names).not.toContain("analytics_create_thing");
    const res = await mcp(read, "tools/call", { name: "afs_create_claim_link", arguments: {} });
    expect(res.json.result.isError).toBe(true);
    expect(JSON.parse(res.json.result.content[0].text).error.code).toBe("forbidden");
    const unknown = await mcp(agent.key, "tools/call", { name: "afs_nope", arguments: {} });
    expect(unknown.json.error.code).toBe(-32602);
  });
});

describe("key expiry", () => {
  it("is enforced by authenticate(), the REST API and the gateway", async () => {
    const agent = await signup();
    const soon = await createApiKey(E.DB, agent.accountId, { keyPrefix: "afs", expiresAt: Date.now() + 60_000 });
    const past = await createApiKey(E.DB, agent.accountId, { keyPrefix: "afs", expiresAt: Date.now() - 1 });
    expect(await authenticate(E.DB, soon.key)).toMatchObject({ accountId: agent.accountId });
    expect(await authenticate(E.DB, past.key)).toBeNull();
    expect((await call("GET", "/v1/me", { key: soon.key })).status).toBe(200);
    const rest = await call("GET", "/v1/me", { key: past.key });
    expect(rest.status).toBe(401);
    expect(rest.json.error.hint).toMatch(/expired/);
    const gw = await mcp(past.key, "tools/list");
    expect(gw.status).toBe(401);
    expect(gw.headers.get("www-authenticate")).toContain("resource_metadata=");
    // Keys without an expiry are unaffected.
    expect((await call("GET", "/v1/me", { key: agent.key })).status).toBe(200);
    const keys = (await call("GET", "/v1/keys", { key: agent.key })).json.keys as { id: string; expires_at: number | null }[];
    expect(keys.find((k) => k.id === agent.keyId)?.expires_at).toBeNull();
    expect(keys.find((k) => k.id === soon.id)?.expires_at).toBeGreaterThan(Date.now());
  });
});

describe("daily cron", () => {
  it("deletes expired keys, codes, refresh tokens, sessions and claim links, and nothing live", async () => {
    const agent = await signup();
    const now = Date.now();
    const db = E.DB;
    const expiredKey = await createApiKey(db, agent.accountId, { keyPrefix: "afs", expiresAt: now - 1000 });
    const liveKey = await createApiKey(db, agent.accountId, { keyPrefix: "afs", expiresAt: now + 3_600_000 });
    await db.batch([
      db
        .prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES ('usr_crontest00000000', 'cron-sub', 'cron@example.com', ?)")
        .bind(now),
      db
        .prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES ('cron-s-old', 'usr_crontest00000000', ?, ?)")
        .bind(now - 9e9, now - 1),
      db
        .prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES ('cron-s-live', 'usr_crontest00000000', ?, ?)")
        .bind(now, now + 9e9),
      db
        .prepare("INSERT INTO claim_links (hash, account_id, created_at, expires_at) VALUES ('cron-c-old', ?, ?, ?)")
        .bind(agent.accountId, now - 9e9, now - 1),
      db
        .prepare(
          "INSERT INTO oauth_clients (id, name, redirect_uris, metadata_hash, created_at) VALUES ('client_crontest000000000000', 'C', '[]', 'cron-hash', ?)",
        )
        .bind(now),
      db
        .prepare(
          "INSERT INTO oauth_grants (id, client_id, user_id, account_id, scope, created_at) VALUES ('grant_crontest0000000', 'client_crontest000000000000', 'usr_crontest00000000', ?, '*', ?)",
        )
        .bind(agent.accountId, now),
      db
        .prepare(
          "INSERT INTO oauth_codes (hash, grant_id, client_id, redirect_uri, code_challenge, created_at, expires_at) VALUES ('cron-code', 'grant_crontest0000000', 'client_crontest000000000000', 'https://x/cb', 'c', ?, ?)",
        )
        .bind(now - 9e5, now - 1),
      db
        .prepare(
          "INSERT INTO oauth_refresh_tokens (hash, grant_id, created_at, expires_at) VALUES ('cron-rt-old', 'grant_crontest0000000', ?, ?)",
        )
        .bind(now - 9e9, now - 1),
      db
        .prepare(
          "INSERT INTO oauth_refresh_tokens (hash, grant_id, created_at, expires_at) VALUES ('cron-rt-live', 'grant_crontest0000000', ?, ?)",
        )
        .bind(now, now + 9e9),
    ]);
    const n = await purgeExpired(db, now);
    expect(n.keys).toBeGreaterThanOrEqual(1);
    const exists = async (sql: string, ...binds: unknown[]) =>
      !!(await db
        .prepare(sql)
        .bind(...binds)
        .first());
    expect(await exists("SELECT 1 FROM api_keys WHERE id = ?", expiredKey.id)).toBe(false);
    expect(await exists("SELECT 1 FROM api_keys WHERE id = ?", liveKey.id)).toBe(true);
    expect(await exists("SELECT 1 FROM api_keys WHERE id = ?", agent.keyId)).toBe(true);
    expect(await exists("SELECT 1 FROM sessions WHERE hash = 'cron-s-old'")).toBe(false);
    expect(await exists("SELECT 1 FROM sessions WHERE hash = 'cron-s-live'")).toBe(true);
    expect(await exists("SELECT 1 FROM claim_links WHERE hash = 'cron-c-old'")).toBe(false);
    expect(await exists("SELECT 1 FROM oauth_codes WHERE hash = 'cron-code'")).toBe(false);
    expect(await exists("SELECT 1 FROM oauth_refresh_tokens WHERE hash = 'cron-rt-old'")).toBe(false);
    expect(await exists("SELECT 1 FROM oauth_refresh_tokens WHERE hash = 'cron-rt-live'")).toBe(true);
    expect(await exists("SELECT 1 FROM oauth_grants WHERE id = 'grant_crontest0000000'")).toBe(true);
  });
});

describe("unchanged for agents", () => {
  it("signup, keys and the existing discovery routes behave as before", async () => {
    const s = await call("POST", "/v1/signup", { json: {}, ip: "198.18.0.9" });
    expect(s.status).toBe(201);
    expect(s.json).toMatchObject({ api_key: expect.stringMatching(/^afs_/), account_id: expect.stringMatching(/^acct_/) });
    expect(s.json.mcp.all.url).toBe("https://afs.test/mcp");
    const created = await call("POST", "/v1/keys", { key: s.json.api_key, json: { name: "ci" } });
    expect(created.status).toBe(201);
    expect((await call("DELETE", `/v1/keys/${created.json.id}`, { key: s.json.api_key })).status).toBe(200);
    expect((await call("GET", "/v1/nope")).json.error.code).toBe("no_route");
  });
});

describe("GET /mcp", () => {
  it("is a page for browsers and the MCP endpoint for clients", async () => {
    const page = await call("GET", "/mcp", { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.text).toContain("<h1>");
    expect(page.headers.get("vary")).toContain("Accept");
    const stream = await call("GET", "/mcp", { headers: { accept: "text/event-stream" } });
    expect(stream.headers.get("content-type") ?? "").not.toContain("text/html");
    const plain = await call("GET", "/mcp");
    expect(plain.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});
