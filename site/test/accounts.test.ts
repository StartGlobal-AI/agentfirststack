import { createApiKey } from "@afs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateIdTokenClaims } from "../src/google";
import { safeNext } from "../src/session";
import { Browser, E, call, csrfOf, fixtures, paramsOf, serviceCalls, signup, testEnv, uniqueEmail } from "./helpers";

const claimToken = (url: string) => new URL(url).pathname.split("/").pop()!;

async function claimLink(key: string) {
  const r = await call("POST", "/v1/claim-link", { key });
  expect(r.status).toBe(201);
  return r.json as { url: string; expires_at: number; account_id: string };
}

describe("signup -> claim link -> sign in -> claim -> dashboard", () => {
  it("lets the owner claim what the agent created and see it in the dashboard", async () => {
    const agent = await signup("acme");
    fixtures.set(agent.accountId, {
      sites: [{ id: "site_acme0000000000", domain: "acme.test", name: null, created_at: Date.now() }],
      containers: [{ id: "ctr_acme000000000", domain: "acme.test", name: null, live_version: 2, created_at: Date.now() }],
      inboxes: [
        { id: "inb_acme000000000", address: "acme-signups@afs.test", display_name: null, last_message_at: null, created_at: Date.now() },
      ],
    });

    const link = await claimLink(agent.key);
    expect(link.url).toMatch(/^https:\/\/afs\.test\/claim\/[0-9a-z]{40}$/);
    expect(link.expires_at - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(link.account_id).toBe(agent.accountId);
    // Only the hash is stored.
    const stored = await E.DB.prepare("SELECT hash FROM claim_links WHERE account_id = ?").bind(agent.accountId).first<{ hash: string }>();
    expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.hash).not.toContain(claimToken(link.url));

    const owner = new Browser();
    const path = new URL(link.url).pathname;
    // Signed out: asks to sign in and comes back here, without showing the project.
    const anon = await owner.get(path);
    expect(anon.status).toBe(200);
    expect(anon.text).toContain("Sign in to claim");
    expect(anon.text).toContain(`/signin?next=${encodeURIComponent(path)}`);
    expect(anon.text).toContain(`/auth/google?next=${encodeURIComponent(path)}`);
    expect(anon.text).not.toContain("acme.test");

    const signin = await owner.signIn(uniqueEmail("owner"), path);
    expect(signin.location).toBe(path);
    const page = await owner.get(path);
    expect(page.text).toContain("Claim project");
    expect(page.text).toContain("acme.test");
    expect(page.text).toContain("acme-signups@afs.test");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Scripts: our own copy-button file only, never inline.
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(page.text).toContain('<script src="/dashboard.js" defer></script>');
    expect(page.headers.get("x-frame-options")).toBe("DENY");

    const claimed = await owner.post(path, { csrf: csrfOf(page.text) });
    expect(claimed.status).toBe(303);
    expect(claimed.location).toBe(`/dashboard/projects/${agent.accountId}`);

    // Single use: a second person can't reuse it.
    const other = new Browser();
    await other.signIn(uniqueEmail("other"));
    expect((await other.get(path)).status).toBe(404);

    // The dashboard lists the project, read from the services with internal auth.
    serviceCalls.length = 0;
    const dash = await owner.get("/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.text).toContain("acme");
    expect(dash.text).toContain(agent.accountId);
    // One count per service, each in its own cell of the project tile.
    expect(dash.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("1 site 1 container 1 inbox");
    expect(serviceCalls.map((s) => [s.service, s.path, s.account, s.internal])).toEqual(
      expect.arrayContaining([
        ["analytics", "/v1/sites", agent.accountId, E.INTERNAL_TOKEN],
        ["tags", "/v1/containers", agent.accountId, E.INTERNAL_TOKEN],
        ["mail", "/v1/inboxes", agent.accountId, E.INTERNAL_TOKEN],
      ]),
    );
    expect(serviceCalls.every((s) => s.authorization === null)).toBe(true);

    const project = await owner.get(`/dashboard/projects/${agent.accountId}`);
    expect(project.text).toContain("acme.test");
    expect(project.text).toContain("version 2 live");
    expect(project.text).toContain("Open analytics dashboard");
    expect(project.text).toContain("the owner");
    // Browsers apply form-action to redirects: the share button's 303 to analytics must be allowed.
    expect(project.headers.get("content-security-policy")).toContain("form-action 'self' https://analytics.afs.test;");

    // "Open analytics dashboard" creates a share link through analytics' API.
    const share = await owner.post(`/dashboard/projects/${agent.accountId}/sites/site_acme0000000000/share`, {
      csrf: csrfOf(project.text),
    });
    expect(share.status).toBe(303);
    expect(share.location).toMatch(/^https:\/\/analytics\.afs\.test\/share\/shr_/);

    // Without ANALYTICS_BASE_URL the redirect would be blocked, so the dashboard links to it instead.
    const noOrigin = testEnv({ ANALYTICS_BASE_URL: "" });
    const projectNoOrigin = await owner.get(`/dashboard/projects/${agent.accountId}`, { env: noOrigin });
    expect(projectNoOrigin.headers.get("content-security-policy")).toContain("form-action 'self';");
    const linked = await owner.post(
      `/dashboard/projects/${agent.accountId}/sites/site_acme0000000000/share`,
      { csrf: csrfOf(projectNoOrigin.text) },
      { env: noOrigin },
    );
    expect(linked.status).toBe(200);
    expect(linked.text).toMatch(/href="https:\/\/analytics\.afs\.test\/share\/shr_k+"/);

    // The agent's key keeps working after the claim.
    expect((await call("GET", "/v1/me", { key: agent.key })).status).toBe(200);
  });

  it("needs a full-access key for claim links, and shows bad links as invalid", async () => {
    const agent = await signup();
    expect((await call("POST", "/v1/claim-link")).status).toBe(401);
    const read = await call("POST", "/v1/keys", { key: agent.key, json: { scope: "read" } });
    const denied = await call("POST", "/v1/claim-link", { key: read.json.api_key });
    expect(denied.status).toBe(403);
    expect(denied.json.error.hint).toBeTruthy();
    expect((await call("GET", "/claim/notavalidtoken")).status).toBe(404);
    expect((await call("GET", `/claim/${"a".repeat(40)}`)).status).toBe(404);

    // Expired links don't work.
    const link = await claimLink(agent.key);
    await E.DB.prepare("UPDATE claim_links SET expires_at = ? WHERE account_id = ?")
      .bind(Date.now() - 1, agent.accountId)
      .run();
    const b = new Browser();
    await b.signIn(uniqueEmail("late"));
    expect((await b.get(new URL(link.url).pathname)).status).toBe(404);
  });

  it("makes the second claimer a member, and an owner can remove them (and their apps)", async () => {
    const agent = await signup("team");
    const owner = new Browser();
    await owner.signIn(uniqueEmail("owner"));
    const l1 = new URL((await claimLink(agent.key)).url).pathname;
    await owner.submit(l1, l1);

    const teammate = new Browser();
    await teammate.signIn(uniqueEmail("mate"));
    const invite = await owner.submit(
      `/dashboard/projects/${agent.accountId}/members`,
      `/dashboard/projects/${agent.accountId}/members/invite`,
    );
    expect(invite.status).toBe(201);
    const inviteUrl = /https:\/\/afs\.test\/claim\/[0-9a-z]{40}/.exec(invite.text)?.[0];
    expect(inviteUrl).toBeTruthy();
    const ip = new URL(inviteUrl!).pathname;
    expect((await teammate.get(ip)).text).toContain("already has an owner");
    expect((await teammate.submit(ip, ip)).status).toBe(303);

    const members = await owner.get(`/dashboard/projects/${agent.accountId}/members`);
    expect(members.text.match(/<td>owner<\/td>/g)).toHaveLength(1);
    expect(members.text.match(/<td>member<\/td>/g)).toHaveLength(1);

    // A member can't remove the owner.
    const ownerId = (await E.DB.prepare("SELECT user_id FROM memberships WHERE account_id = ? AND role = 'owner'")
      .bind(agent.accountId)
      .first<{
        user_id: string;
      }>())!.user_id;
    const mateId = (await E.DB.prepare("SELECT user_id FROM memberships WHERE account_id = ? AND role = 'member'")
      .bind(agent.accountId)
      .first<{
        user_id: string;
      }>())!.user_id;
    const nope = await teammate.submit(
      `/dashboard/projects/${agent.accountId}/members`,
      `/dashboard/projects/${agent.accountId}/members/${ownerId}/remove`,
    );
    expect(nope.status).toBe(403);

    // The owner removes the teammate; their OAuth grant for the project is revoked with them.
    await E.DB.prepare("INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, metadata_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("client_teamtest000000000000", "Test", '["https://app.test/cb"]', `hash-${mateId}`, Date.now())
      .run();
    await E.DB.prepare("INSERT INTO oauth_grants (id, client_id, user_id, account_id, scope, created_at) VALUES (?, ?, ?, ?, '*', ?)")
      .bind(`grant_${mateId.slice(4)}`, "client_teamtest000000000000", mateId, agent.accountId, Date.now())
      .run();
    const tok = await createApiKey(E.DB, agent.accountId, {
      keyPrefix: "afs",
      expiresAt: Date.now() + 3_600_000,
      oauthGrantId: `grant_${mateId.slice(4)}`,
    });
    expect((await call("GET", "/v1/me", { key: tok.key })).status).toBe(200);
    const removed = await owner.submit(
      `/dashboard/projects/${agent.accountId}/members`,
      `/dashboard/projects/${agent.accountId}/members/${mateId}/remove`,
    );
    expect(removed.status).toBe(303);
    expect((await teammate.get(`/dashboard/projects/${agent.accountId}`)).status).toBe(404);
    expect((await call("GET", "/v1/me", { key: tok.key })).status).toBe(401);
  });
});

describe("dashboard", () => {
  it("imports a project by its full-access key, and refuses read or unknown keys", async () => {
    const agent = await signup("imported");
    const b = new Browser();
    await b.signIn(uniqueEmail("importer"));
    const read = await call("POST", "/v1/keys", { key: agent.key, json: { scope: "read" } });

    const bad = await b.submit("/dashboard", "/dashboard/import", { key: "afs_notarealkey" });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("unknown, revoked or expired");
    const ro = await b.submit("/dashboard", "/dashboard/import", { key: read.json.api_key });
    expect(ro.status).toBe(400);
    expect(ro.text).toContain("read-only");

    const ok = await b.submit("/dashboard", "/dashboard/import", { key: agent.key });
    expect(ok.status).toBe(303);
    expect(ok.location).toBe(`/dashboard/projects/${agent.accountId}`);
    const dash = await b.get("/dashboard");
    expect(dash.text).toContain(agent.accountId);
    expect(dash.text).toContain("imported");
  });

  it("gives a non-member a 404 for someone else's project, on every route", async () => {
    const agent = await signup("private");
    const owner = new Browser();
    await owner.signIn(uniqueEmail("owner"));
    await owner.submit("/dashboard", "/dashboard/import", { key: agent.key });

    const stranger = new Browser();
    await stranger.signIn(uniqueEmail("stranger"));
    for (const path of ["", "/keys", "/members"]) {
      const r = await stranger.get(`/dashboard/projects/${agent.accountId}${path}`);
      expect(r.status).toBe(404);
      expect(r.text).not.toContain("private");
    }
    const dash = await stranger.get("/dashboard");
    const csrf = csrfOf(dash.text);
    for (const action of ["/rename", "/keys", "/members/invite", "/sites/site_x/share"]) {
      expect((await stranger.post(`/dashboard/projects/${agent.accountId}${action}`, { csrf, name: "pwned" })).status).toBe(404);
    }
    const name = await E.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(agent.accountId).first<{ name: string }>();
    expect(name?.name).toBe("private");
    expect(await E.DB.prepare("SELECT count(*) AS n FROM claim_links WHERE account_id = ?").bind(agent.accountId).first("n")).toBe(0);
  });

  it("creates (shown once), lists and revokes keys; renames; escapes what it shows", async () => {
    const b = new Browser();
    await b.signIn(uniqueEmail("keys"));
    const created = await b.submit("/dashboard", "/dashboard/projects", { name: '<script>alert("x")</script>' });
    expect(created.status).toBe(303);
    const id = created.location!.split("/").pop()!;
    const overview = await b.get(created.location!);
    expect(overview.text).not.toContain('<script>alert("x")</script>');
    expect(overview.text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");

    const made = await b.submit(`/dashboard/projects/${id}/keys`, `/dashboard/projects/${id}/keys`, { name: "ci", scope: "read" });
    expect(made.status).toBe(201);
    const key = /afs_[0-9a-z]{40}/.exec(made.text)?.[0];
    expect(key).toBeTruthy();
    expect((await call("GET", "/v1/me", { key })).json.key.scopes).toEqual(["read"]);
    const row = await E.DB.prepare("SELECT id, created_by_user_id FROM api_keys WHERE account_id = ?").bind(id).first<{
      id: string;
      created_by_user_id: string;
    }>();
    expect(row?.created_by_user_id).toMatch(/^usr_/);
    const list = await b.get(`/dashboard/projects/${id}/keys`);
    expect(list.text).not.toContain(key!);
    expect(list.text).toContain(`${key!.slice(0, 10)}…`);

    const revoked = await b.post(`/dashboard/projects/${id}/keys/${row!.id}/revoke`, { csrf: csrfOf(list.text) });
    expect(revoked.status).toBe(303);
    expect((await call("GET", "/v1/me", { key })).status).toBe(401);

    await b.submit(`/dashboard/projects/${id}`, `/dashboard/projects/${id}/rename`, { name: "renamed.test" });
    expect((await b.get(`/dashboard/projects/${id}`)).text).toContain("renamed.test");
  });

  it("redirects to sign-in when signed out", async () => {
    const r = await call("GET", "/dashboard/apps");
    expect(r.status).toBe(303);
    expect(r.location).toBe(`/signin?next=${encodeURIComponent("/dashboard/apps")}`);
    expect((await call("GET", "/dashboard")).location).toBe(`/signin?next=${encodeURIComponent("/dashboard")}`);
  });
});

describe("CSRF and redirects", () => {
  it("rejects state-changing posts without the right token or from another origin", async () => {
    const b = new Browser();
    await b.signIn(uniqueEmail("csrf"));
    expect((await b.post("/dashboard/projects", { name: "x" })).status).toBe(403);
    expect((await b.post("/dashboard/projects", { name: "x", csrf: "0".repeat(64) })).status).toBe(403);
    const dash = await b.get("/dashboard");
    const csrf = csrfOf(dash.text);
    const evil = await b.post("/dashboard/projects", { name: "x", csrf }, { headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    // Another session's token doesn't work either.
    const other = new Browser();
    await other.signIn(uniqueEmail("csrf2"));
    expect((await other.post("/dashboard/projects", { name: "x", csrf })).status).toBe(403);
    expect((await b.post("/auth/signout", {})).status).toBe(403);
    // The right token from the same origin works.
    expect((await b.post("/dashboard/projects", { name: "x", csrf }, { headers: { origin: "https://afs.test" } })).status).toBe(303);
  });

  it("only follows same-origin next paths", async () => {
    for (const next of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/%0d%0aSet-Cookie:x",
      "",
    ]) {
      const b = new Browser();
      const r = await b.get(`/auth/dev-login?email=${encodeURIComponent(uniqueEmail("next"))}&next=${encodeURIComponent(next)}`);
      expect(r.status).toBe(302);
      const loc = r.location!;
      expect(loc.startsWith("/") && !loc.startsWith("//")).toBe(true);
      expect(new URL(loc, "https://afs.test").origin).toBe("https://afs.test");
    }
    expect(safeNext("/dashboard/projects/x?y=1#z")).toBe("/dashboard/projects/x?y=1#z");
    expect(safeNext("https://evil.example")).toBe("/dashboard");
    expect(safeNext("//evil.example")).toBe("/dashboard");
    expect(safeNext("/\\evil.example")).toBe("/dashboard");
    expect(safeNext("/ok\u0000")).toBe("/dashboard");

    // Signed in, /signin?next= goes straight to the (safe) next.
    const b = new Browser();
    await b.signIn(uniqueEmail("signed"));
    expect((await b.get(`/signin?next=${encodeURIComponent("https://evil.example")}`)).location).toBe("/dashboard");
    expect((await b.get(`/signin?next=${encodeURIComponent("/dashboard/apps")}`)).location).toBe("/dashboard/apps");
  });

  it("can't reach the dev login unless DEV_MODE is true", async () => {
    for (const DEV_MODE of ["", "false", "1", "TRUE"]) {
      const r = await call("GET", "/auth/dev-login?email=a@b.test", { env: testEnv({ DEV_MODE }) });
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("no_route");
      expect(r.cookies).toHaveLength(0);
      const signin = await call("GET", "/signin", { env: testEnv({ DEV_MODE }) });
      expect(signin.text).not.toContain("dev-login");
    }
    expect(await E.DB.prepare("SELECT count(*) AS n FROM users WHERE email = 'a@b.test'").first("n")).toBe(0);
  });

  it("serves people-facing pages on the canonical host only", async () => {
    const env = testEnv({ PUBLIC_BASE_URL: "https://afs.test" });
    const r = await call("GET", "https://www.afs.test/dashboard?x=1", { env });
    expect(r.status).toBe(302);
    expect(r.location).toBe("https://afs.test/dashboard?x=1");
  });
});

describe("Google sign-in", () => {
  afterEach(() => vi.restoreAllMocks());
  const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;
  const good = (nonce: string) => ({
    iss: "https://accounts.google.com",
    aud: E.GOOGLE_CLIENT_ID,
    sub: "1234567890",
    email: "Person@Example.com",
    email_verified: true,
    name: "A Person",
    nonce,
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
  });

  it("runs the OIDC flow with state, nonce and PKCE, then signs the person in", async () => {
    const b = new Browser();
    const start = await b.get("/auth/google?next=/dashboard/apps");
    expect(start.status).toBe(302);
    const auth = new URL(start.location!);
    expect(auth.origin + auth.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = auth.searchParams;
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("redirect_uri")).toBe("https://afs.test/auth/google/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toMatch(/^[0-9a-z]{32}$/);
    expect(b.jar.has("afs_google")).toBe(true);

    let sent: URLSearchParams | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      sent = new URLSearchParams(String(init?.body));
      return Response.json({ id_token: idToken(good(q.get("nonce")!)), access_token: "x" });
    });
    const cb = await b.get(`/auth/google/callback?code=4%2Fabc&state=${q.get("state")}`);
    expect(cb.status).toBe(302);
    expect(cb.location).toBe("/dashboard/apps");
    expect(sent!.get("code_verifier")).toMatch(/^[0-9a-z]{64}$/);
    expect(sent!.get("client_secret")).toBe(E.GOOGLE_CLIENT_SECRET);
    expect(b.jar.has("afs_session")).toBe(true);
    expect(b.jar.has("afs_google")).toBe(false);
    const session = cb.cookies.find((c) => c.startsWith("afs_session="))!;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).not.toMatch(/domain=/i);
    expect((await b.get("/dashboard/account")).text).toContain("person@example.com");
  });

  it("rejects a wrong state and bad ID token claims", async () => {
    const b = new Browser();
    const start = await b.get("/auth/google");
    const q = new URL(start.location!).searchParams;
    expect((await b.get("/auth/google/callback?code=x&state=wrong")).status).toBe(400);
    expect(b.jar.has("afs_session")).toBe(false);

    const nonce = "n".repeat(32);
    const ok = { clientId: E.GOOGLE_CLIENT_ID!, nonce };
    expect(validateIdTokenClaims(idToken(good(nonce)), ok).email).toBe("person@example.com");
    for (const bad of [
      { iss: "https://evil.example" },
      { aud: "someone-else" },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { email_verified: false },
      { nonce: "other" },
      { sub: "" },
    ]) {
      expect(() => validateIdTokenClaims(idToken({ ...good(nonce), ...bad }), ok)).toThrow();
    }
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id_token: idToken({ ...good(q.get("nonce")!), aud: "other" }) }));
    const start2 = await b.get("/auth/google");
    const s2 = new URL(start2.location!).searchParams.get("state");
    const cb = await b.get(`/auth/google/callback?code=x&state=${s2}`);
    expect(cb.status).toBe(400);
    expect(b.jar.has("afs_session")).toBe(false);
  });

  it("says when Google sign-in isn't configured", async () => {
    const env = testEnv({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" });
    expect((await call("GET", "/signin", { env })).text).toContain("isn't configured");
    expect((await call("GET", "/auth/google", { env })).location).toBe("/signin?next=%2Fdashboard");
  });
});

describe("account", () => {
  it("signs out, and deletes the account but keeps the project and its agent keys", async () => {
    const agent = await signup("keepme");
    const b = new Browser();
    const email = uniqueEmail("leaver");
    await b.signIn(email);
    await b.submit("/dashboard", "/dashboard/import", { key: agent.key });
    const user = (await E.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!;
    // An OAuth grant with tokens, as if they'd connected a chat app.
    await E.DB.prepare("INSERT OR IGNORE INTO oauth_clients (id, name, redirect_uris, metadata_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("client_deletetest00000000000", "Test", '["https://app.test/cb"]', "hash-delete", Date.now())
      .run();
    await E.DB.prepare(
      "INSERT INTO oauth_grants (id, client_id, user_id, account_id, scope, created_at) VALUES ('grant_deletetest000000', ?, ?, ?, '*', ?)",
    )
      .bind("client_deletetest00000000000", user.id, agent.accountId, Date.now())
      .run();
    await E.DB.prepare(
      "INSERT INTO oauth_refresh_tokens (hash, grant_id, created_at, expires_at) VALUES ('rt-hash-delete', 'grant_deletetest000000', ?, ?)",
    )
      .bind(Date.now(), Date.now() + 86_400_000)
      .run();
    const tok = await createApiKey(E.DB, agent.accountId, {
      keyPrefix: "afs",
      expiresAt: Date.now() + 3_600_000,
      oauthGrantId: "grant_deletetest000000",
    });

    const notConfirmed = await b.submit("/dashboard/account", "/dashboard/account/delete", { confirm: "nope" });
    expect(notConfirmed.status).toBe(400);
    const gone = await b.submit("/dashboard/account", "/dashboard/account/delete", { confirm: "delete" });
    expect(gone.status).toBe(200);
    expect(gone.text).toContain("Account deleted");
    expect(b.jar.has("afs_session")).toBe(false);

    const count = async (sql: string) => E.DB.prepare(sql).bind(user.id).first<number>("n");
    expect(await count("SELECT count(*) AS n FROM users WHERE id = ?")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM memberships WHERE user_id = ?")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM sessions WHERE user_id = ?")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM oauth_grants WHERE user_id = ?")).toBe(0);
    expect(await E.DB.prepare("SELECT count(*) AS n FROM oauth_refresh_tokens WHERE grant_id = 'grant_deletetest000000'").first("n")).toBe(
      0,
    );
    expect((await call("GET", "/v1/me", { key: tok.key })).status).toBe(401);
    // The project and the agent's key are untouched.
    expect((await call("GET", "/v1/me", { key: agent.key })).json.account.id).toBe(agent.accountId);
    // Signed-out pages.
    expect((await b.get("/dashboard")).status).toBe(303);
  });

  it("signs out with a CSRF-checked post", async () => {
    const b = new Browser();
    await b.signIn(uniqueEmail("bye"));
    const out = await b.submit("/dashboard/account", "/auth/signout");
    expect(out.status).toBe(303);
    expect(out.location).toBe("/");
    expect(b.jar.has("afs_session")).toBe(false);
    expect(paramsOf(`https://afs.test${(await b.get("/dashboard")).location}`).get("next")).toBe("/dashboard");
  });
});
