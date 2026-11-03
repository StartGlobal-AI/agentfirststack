import { describe, expect, it } from "vitest";
import { Browser, E, call, csrfOf, nextIp, paramsOf, pkce, registerClient, signup, testEnv, uniqueEmail } from "./helpers";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function newClient(name = "Claude", redirect_uris = [REDIRECT]) {
  const r = await registerClient({ client_name: `${name}`, redirect_uris, token_endpoint_auth_method: "none" });
  expect(r.status).toBe(201);
  return r.json.client_id as string;
}

const authorizeQuery = (p: Record<string, string>) => `/oauth/authorize?${new URLSearchParams(p).toString()}`;

/** Sign in, open the consent page, approve. Returns the redirect's params and the browser. */
async function authorize(opts: {
  clientId: string;
  challenge: string;
  redirect?: string;
  state?: string;
  scope?: string;
  project?: string;
  access?: "*" | "read";
  browser?: Browser;
}) {
  const b = opts.browser ?? new Browser();
  if (!b.jar.has("afs_session")) await b.signIn(uniqueEmail("oauth"));
  const params = {
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirect ?? REDIRECT,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    state: opts.state ?? "st-123",
    resource: "https://afs.test/mcp",
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  };
  const consent = await b.get(authorizeQuery(params));
  expect(consent.status).toBe(200);
  const res = await b.post("/oauth/authorize", {
    ...params,
    csrf: csrfOf(consent.text),
    project: opts.project ?? "new",
    project_name: "oauth project",
    access: opts.access ?? "*",
    decision: "allow",
  });
  expect(res.status).toBe(303);
  return { b, consent, res, params: paramsOf(res.location) };
}

const token = (form: Record<string, string>) => call("POST", "/oauth/token", { form, ip: nextIp() });

const mcp = (key: string, method: string, params: unknown = {}) =>
  call("POST", "/mcp", {
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });

describe("discovery", () => {
  it("serves RFC 8414 metadata and RFC 9728 metadata naming it, with CORS", async () => {
    const as = await call("GET", "/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    expect(as.json).toMatchObject({
      issuer: "https://afs.test",
      authorization_endpoint: "https://afs.test/oauth/authorize",
      token_endpoint: "https://afs.test/oauth/token",
      registration_endpoint: "https://afs.test/oauth/register",
      revocation_endpoint: "https://afs.test/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["*", "read"],
      service_documentation: "https://afs.test/auth.md",
    });
    const prm = await call("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(prm.json).toMatchObject({ resource: "https://afs.test/mcp", authorization_servers: ["https://afs.test"] });
    expect((await call("GET", "/.well-known/oauth-protected-resource")).json.resource_documentation).toBe("https://afs.test/auth.md");
    // AUTH_ISSUER wins when set.
    const env = testEnv({ AUTH_ISSUER: "https://issuer.test" });
    expect((await call("GET", "/.well-known/oauth-authorization-server", { env })).json.issuer).toBe("https://issuer.test");

    for (const path of ["/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/oauth-authorization-server"]) {
      const pre = await call("OPTIONS", path, { headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
      expect(pre.headers.get("access-control-allow-headers")).toContain("content-type");
    }
  });

  it("points unauthenticated MCP calls at the metadata", async () => {
    const r = await call("POST", "/mcp", { json: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(
      'Bearer realm="mcp", resource_metadata="https://afs.test/.well-known/oauth-protected-resource/mcp"',
    );
    const bad = await call("POST", "/mcp", { key: "afs_nope", json: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("dynamic client registration", () => {
  it("accepts https and loopback http, rejects everything else", async () => {
    const ok = await registerClient({
      client_name: "Local",
      redirect_uris: ["http://localhost:3000/cb", "http://127.0.0.1:9999/callback", "https://app.example/cb?x=1"],
    });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok.json).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(ok.json.client_id).toMatch(/^client_[0-9a-z]{24}$/);
    for (const uri of [
      "http://evil.example/cb",
      "http://localhost.evil.example/cb",
      "javascript:alert(1)",
      "cursor://anysphere/cb",
      "https://app.example/cb#frag",
      "https://user:pass@app.example/cb",
      "not a url",
    ]) {
      const r = await registerClient({ client_name: "Bad", redirect_uris: [uri] });
      expect(r.status, uri).toBe(400);
      expect(r.json.error).toBe("invalid_redirect_uri");
    }
    expect((await registerClient({ redirect_uris: [] })).status).toBe(400);
    expect((await registerClient({ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).json.error).toBe(
      "invalid_client_metadata",
    );
    expect((await registerClient({ redirect_uris: [REDIRECT], response_types: ["token"] })).json.error).toBe("invalid_client_metadata");
  });

  it("returns the same client for an identical registration, and rate-limits new ones per network", async () => {
    const meta = { client_name: `Same ${Date.now()}`, redirect_uris: ["https://same.example/cb"] };
    const a = await registerClient(meta);
    const b = await registerClient(meta);
    expect(b.json.client_id).toBe(a.json.client_id);

    const env = testEnv({ OAUTH_REGISTER_HOURLY_LIMIT: "2" });
    const ip = "203.0.113.77";
    const reg = (n: number) =>
      call("POST", "/oauth/register", {
        env,
        ip,
        json: { client_name: `Spam ${n} ${Date.now()}`, redirect_uris: ["https://spam.example/cb"] },
      });
    expect((await reg(1)).status).toBe(201);
    expect((await reg(2)).status).toBe(201);
    const third = await reg(3);
    expect(third.status).toBe(429);
    expect(third.json.error).toBe("rate_limited");
  });
});

describe("authorization code flow", () => {
  it("register -> authorize (consent) -> token -> gateway tools/list -> refresh rotation -> reuse revokes -> revoke", async () => {
    const clientId = await newClient();
    const { verifier, challenge } = await pkce();
    const { consent, params, b } = await authorize({ clientId, challenge, state: "state-xyz" });

    // The consent page names the client and where it sends you, and can't be framed.
    expect(consent.text).toContain("Claude");
    expect(consent.text).toContain("wants to use AgentFirstStack");
    expect(consent.text).toContain("claude.ai");
    expect(consent.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(consent.text).not.toContain("Careful");

    // The redirect carries code, state and iss.
    expect(params.get("state")).toBe("state-xyz");
    expect(params.get("iss")).toBe("https://afs.test");
    const code = params.get("code")!;
    expect(code).toMatch(/^[0-9a-z]{43}$/);
    const stored = await E.DB.prepare("SELECT hash FROM oauth_codes WHERE client_id = ?").bind(clientId).first<{ hash: string }>();
    expect(stored?.hash).not.toBe(code);

    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: "https://afs.test/mcp",
    });
    expect(t.status).toBe(200);
    expect(t.headers.get("cache-control")).toBe("no-store");
    expect(t.headers.get("access-control-allow-origin")).toBe("*");
    expect(t.json).toMatchObject({ token_type: "Bearer", expires_in: 28800, scope: "*" });
    expect(t.json.access_token).toMatch(/^afs_[0-9a-z]{40}$/);
    expect(t.json.refresh_token).toMatch(/^afsr_[0-9a-z]{40}$/);

    // The access token is an API key with an 8-hour expiry for the chosen project, named after the client.
    const me = await call("GET", "/v1/me", { key: t.json.access_token });
    expect(me.status).toBe(200);
    const key = await E.DB.prepare("SELECT name, expires_at, oauth_grant_id, account_id FROM api_keys WHERE id = ?")
      .bind(me.json.key.id)
      .first<{
        name: string;
        expires_at: number;
        oauth_grant_id: string;
        account_id: string;
      }>();
    expect(key?.name).toBe("Claude");
    expect(key!.expires_at - Date.now()).toBeGreaterThan(7.9 * 3_600_000);
    expect(key?.oauth_grant_id).toMatch(/^grant_/);
    expect((await b.get("/dashboard")).text).toContain("oauth project");

    // It works on the gateway: tools/list goes through each service's own auth with the same token.
    const list = await mcp(t.json.access_token, "tools/list");
    expect(list.status).toBe(200);
    const names = (list.json.result.tools as { name: string }[]).map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining(["afs_create_claim_link", "analytics_whoami", "analytics_create_thing", "tags_whoami", "mail_whoami"]),
    );
    const who = await mcp(t.json.access_token, "tools/call", { name: "mail_whoami", arguments: {} });
    expect(JSON.parse(who.json.result.content[0].text)).toEqual({ service: "mail", account_id: key!.account_id });

    // Connected apps lists it.
    const apps = await b.get("/dashboard/apps");
    expect(apps.text).toContain("Claude");
    expect(apps.text).toContain("claude.ai");

    // Refresh rotates: a new pair, the old refresh token is spent.
    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.json.refresh_token);
    expect(r1.json.access_token).not.toBe(t.json.access_token);
    expect((await call("GET", "/v1/me", { key: r1.json.access_token })).status).toBe(200);

    // Reusing the rotated refresh token revokes the whole grant.
    const reuse = await token({ grant_type: "refresh_token", refresh_token: t.json.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe("invalid_grant");
    for (const k of [t.json.access_token, r1.json.access_token]) expect((await call("GET", "/v1/me", { key: k })).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: r1.json.refresh_token, client_id: clientId })).json.error).toBe(
      "invalid_grant",
    );
    expect((await b.get("/dashboard/apps")).text).not.toContain("claude.ai</code>");

    // Revocation (RFC 7009): a fresh grant, revoke its access token, then its refresh token.
    const second = await pkce();
    const again = await authorize({ clientId, challenge: second.challenge, browser: b, project: key!.account_id });
    const t2 = await token({
      grant_type: "authorization_code",
      code: again.params.get("code")!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: second.verifier,
    });
    expect(t2.status).toBe(200);
    const revokeAccess = await call("POST", "/oauth/revoke", {
      form: { token: t2.json.access_token, token_type_hint: "access_token", client_id: clientId },
    });
    expect(revokeAccess.status).toBe(200);
    expect((await call("GET", "/v1/me", { key: t2.json.access_token })).status).toBe(401);
    const r2 = await token({ grant_type: "refresh_token", refresh_token: t2.json.refresh_token, client_id: clientId });
    expect(r2.status).toBe(200);
    expect((await call("POST", "/oauth/revoke", { form: { token: r2.json.refresh_token } })).status).toBe(200);
    expect((await call("GET", "/v1/me", { key: r2.json.access_token })).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: r2.json.refresh_token, client_id: clientId })).json.error).toBe(
      "invalid_grant",
    );
    // Unknown tokens are fine too.
    expect((await call("POST", "/oauth/revoke", { form: { token: "nothing" } })).status).toBe(200);
    // Agent keys can't be revoked through the OAuth endpoint.
    const agent = await signup();
    await call("POST", "/oauth/revoke", { form: { token: agent.key } });
    expect((await call("GET", "/v1/me", { key: agent.key })).status).toBe(200);
  });

  it("issues read-only tokens that only see read tools", async () => {
    const clientId = await newClient("ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"]);
    const { verifier, challenge } = await pkce();
    const { params, consent } = await authorize({
      clientId,
      challenge,
      redirect: "https://chatgpt.com/connector_platform_oauth_redirect",
      scope: "read",
    });
    expect(consent.text).not.toContain('value="*"');
    const t = await token({
      grant_type: "authorization_code",
      code: params.get("code")!,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(t.json.scope).toBe("read");
    const names = ((await mcp(t.json.access_token, "tools/list")).json.result.tools as { name: string }[]).map((x) => x.name);
    expect(names).toContain("analytics_whoami");
    expect(names).not.toContain("analytics_create_thing");
    expect(names).not.toContain("afs_create_claim_link");
    expect((await call("POST", "/v1/claim-link", { key: t.json.access_token })).status).toBe(403);
  });

  it("fails PKCE, a wrong redirect_uri, a reused code and an expired code", async () => {
    const clientId = await newClient(`PKCE ${Date.now()}`, [REDIRECT, "https://claude.ai/other"]);
    const exchange = (code: string, verifier: string, redirect = REDIRECT) =>
      token({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });

    // Wrong verifier.
    const a = await pkce();
    const ca = (await authorize({ clientId, challenge: a.challenge })).params.get("code")!;
    const wrong = await exchange(ca, (await pkce()).verifier);
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");
    expect(wrong.json.error_description).toMatch(/PKCE/);
    // The code is burned even though the verifier was wrong.
    expect((await exchange(ca, a.verifier)).json.error).toBe("invalid_grant");

    // A redirect_uri that differs from the authorization request (even if registered).
    const b = await pkce();
    const cb = (await authorize({ clientId, challenge: b.challenge })).params.get("code")!;
    const mismatch = await exchange(cb, b.verifier, "https://claude.ai/other");
    expect(mismatch.json.error).toBe("invalid_grant");
    expect(mismatch.json.error_description).toMatch(/redirect_uri/);

    // A code used twice: the second use fails and revokes what the first issued.
    const c = await pkce();
    const cc = (await authorize({ clientId, challenge: c.challenge })).params.get("code")!;
    const first = await exchange(cc, c.verifier);
    expect(first.status).toBe(200);
    expect((await exchange(cc, c.verifier)).json.error).toBe("invalid_grant");
    expect((await call("GET", "/v1/me", { key: first.json.access_token })).status).toBe(401);

    // An expired code (older than 10 minutes).
    const d = await pkce();
    const cd = (await authorize({ clientId, challenge: d.challenge })).params.get("code")!;
    await E.DB.prepare("UPDATE oauth_codes SET expires_at = ? WHERE client_id = ? AND used_at IS NULL")
      .bind(Date.now() - 1, clientId)
      .run();
    const expired = await exchange(cd, d.verifier);
    expect(expired.json.error).toBe("invalid_grant");
    expect(expired.json.error_description).toMatch(/expired/);

    // Missing parameters and unknown grant types.
    expect((await token({ grant_type: "authorization_code", code: "x" })).json.error).toBe("invalid_request");
    expect((await token({ grant_type: "password" })).json.error).toBe("unsupported_grant_type");
    expect(
      (
        await token({
          grant_type: "authorization_code",
          code: "x",
          redirect_uri: REDIRECT,
          client_id: "client_nope",
          code_verifier: a.verifier,
        })
      ).status,
    ).toBe(401);
  });

  it("never redirects to an unregistered redirect_uri, and validates the rest by redirecting back", async () => {
    const clientId = await newClient(`Strict ${Date.now()}`);
    const { challenge } = await pkce();
    const b = new Browser();
    await b.signIn(uniqueEmail("strict"));
    const base = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
    };

    for (const redirect_uri of ["https://evil.example/cb", `${REDIRECT}/extra`, `${REDIRECT}?x=1`, ""]) {
      const r = await b.get(authorizeQuery({ ...base, redirect_uri }));
      expect(r.status).toBe(400);
      expect(r.location).toBeNull();
    }
    expect((await b.get(authorizeQuery({ ...base, client_id: "client_unknown" }))).status).toBe(400);

    const back = async (overrides: Record<string, string>) => {
      const r = await b.get(authorizeQuery({ ...base, ...overrides }));
      expect(r.status).toBe(302);
      expect(r.location!.startsWith(`${REDIRECT}?`)).toBe(true);
      return paramsOf(r.location);
    };
    expect((await back({ code_challenge_method: "plain" })).get("error")).toBe("invalid_request");
    expect((await back({ code_challenge: "short" })).get("error")).toBe("invalid_request");
    expect((await back({ response_type: "token" })).get("error")).toBe("unsupported_response_type");
    expect((await back({ scope: "admin" })).get("error")).toBe("invalid_scope");
    expect((await back({ resource: "https://evil.example/mcp" })).get("error")).toBe("invalid_target");
    const noState = await back({ state: "" });
    expect(noState.get("error")).toBe("invalid_request");
    expect(noState.get("iss")).toBe("https://afs.test");

    // Denying sends access_denied back with the state.
    const consent = await b.get(authorizeQuery(base));
    const denied = await b.post("/oauth/authorize", { ...base, csrf: csrfOf(consent.text), project: "new", access: "*", decision: "deny" });
    expect(paramsOf(denied.location).get("error")).toBe("access_denied");
    expect(paramsOf(denied.location).get("state")).toBe("s1");

    // The consent post needs the CSRF token, and a project the person belongs to.
    expect((await b.post("/oauth/authorize", { ...base, project: "new", access: "*", decision: "allow" })).status).toBe(403);
    const agent = await signup();
    const notMine = await b.post("/oauth/authorize", {
      ...base,
      csrf: csrfOf(consent.text),
      project: agent.accountId,
      access: "*",
      decision: "allow",
    });
    expect(notMine.status).toBe(404);
    expect(notMine.location).toBeNull();
  });

  it("sends signed-out people to sign in first, then back to the request", async () => {
    const clientId = await newClient(`Signin ${Date.now()}`);
    const { challenge } = await pkce();
    const q = authorizeQuery({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "z",
    });
    const r = await call("GET", q);
    expect(r.status).toBe(302);
    expect(r.location).toBe(`/signin?next=${encodeURIComponent(q)}`);
  });

  it("warns when a client borrows a known app's name", async () => {
    const clientId = await newClient("Claude", ["https://claude-ai.evil.example/cb"]);
    const { challenge } = await pkce();
    const b = new Browser();
    await b.signIn(uniqueEmail("phish"));
    const page = await b.get(
      authorizeQuery({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://claude-ai.evil.example/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "p",
      }),
    );
    expect(page.text).toContain("Careful");
    expect(page.text).toContain("claude-ai.evil.example");
    const escaped = await newClient('<img src=x onerror=alert(1)> "quote"', ["https://x.example/cb"]);
    const page2 = await b.get(
      authorizeQuery({
        response_type: "code",
        client_id: escaped,
        redirect_uri: "https://x.example/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "p",
      }),
    );
    expect(page2.text).not.toContain("<img src=x");
    expect(page2.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
