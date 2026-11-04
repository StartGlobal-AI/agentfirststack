import { describe, expect, it } from "vitest";
import { Browser, call, csrfOf, nextIp, paramsOf, pkce, registerClient, signup, testEnv, uniqueEmail } from "./helpers";

// Regression tests for the pre-launch security review (identity and control plane).

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Consent to a new client for `project` ("new" creates one); returns the consent POST response. */
async function consent(b: Browser, project: string, env = testEnv()) {
  const reg = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT] });
  const clientId = reg.json.client_id as string;
  const { verifier, challenge } = await pkce();
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    scope: "*",
  };
  const page = await b.get(`/oauth/authorize?${new URLSearchParams(params)}`);
  expect(page.status).toBe(200);
  const res = await b.post("/oauth/authorize", { ...params, csrf: csrfOf(page.text), project, access: "*", decision: "allow" });
  return { res, clientId, verifier };
}

async function connect(b: Browser, project: string, env = testEnv()) {
  const { res, clientId, verifier } = await consent(b, project, env);
  expect(res.status).toBe(303);
  const code = paramsOf(res.location).get("code")!;
  const tok = await call("POST", "/oauth/token", {
    env,
    form: { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier },
    ip: nextIp(),
  });
  expect(tok.status).toBe(200);
  return tok.json.access_token as string;
}

const newestProject = async (b: Browser, not: string[] = []) =>
  [...(await b.get("/dashboard")).text.matchAll(/href="\/dashboard\/projects\/(acct_[0-9a-z]+)"/g)]
    .map((m) => m[1]!)
    .find((p) => !not.includes(p))!;

async function claim(b: Browser, key: string) {
  const link = await call("POST", "/v1/claim-link", { key });
  const path = new URL(link.json.url).pathname;
  expect((await b.submit(path, path)).status).toBe(303);
}

describe("connected apps can't take over a project's keys", () => {
  it("a member's OAuth token can end its own tokens, not the project's API keys", async () => {
    const agent = await signup("keys project");
    const owner = new Browser();
    await owner.signIn(uniqueEmail("owner"));
    await claim(owner, agent.key);
    const inv = await owner.submit(
      `/dashboard/projects/${agent.accountId}/members`,
      `/dashboard/projects/${agent.accountId}/members/invite`,
    );
    const url = /<pre class="secret">([^<]+)<\/pre>/.exec(inv.text)![1]!;
    const member = new Browser();
    await member.signIn(uniqueEmail("member"));
    const path = new URL(url).pathname;
    expect((await member.submit(path, path)).status).toBe(303);

    const access = await connect(member, agent.accountId);
    const del = await call("DELETE", `/v1/keys/${agent.keyId}`, { key: access });
    expect(del.status).toBe(403);
    expect(del.json.error.code).toBe("temporary_credential");
    expect((await call("GET", "/v1/me", { key: agent.key })).status).toBe(200);
    // Its own token: fine.
    const me = await call("GET", "/v1/me", { key: access });
    expect((await call("DELETE", `/v1/keys/${me.json.key.id}`, { key: access })).status).toBe(200);
    expect((await call("GET", "/v1/me", { key: access })).status).toBe(401);
  });
});

describe("creating a project while connecting an app goes through the signup gate", () => {
  it("is refused when signup is closed", async () => {
    const env = testEnv({ SIGNUP_MODE: "closed" } as never);
    const b = new Browser(env);
    await b.signIn(uniqueEmail("stranger"));
    const { res } = await consent(b, "new", env);
    expect(res.status).toBe(403);
    expect(await newestProject(b)).toBeUndefined();
  });

  it("counts against the deployment-wide signup breaker and a per-person daily cap", async () => {
    const env = testEnv({ PROJECTS_PER_USER_DAILY_LIMIT: "2" } as never);
    const b = new Browser(env);
    await b.signIn(uniqueEmail("busy"));
    await connect(b, "new", env);
    await connect(b, "new", env);
    const third = await consent(b, "new", env);
    expect(third.res.status).toBe(429);
  });

  it("keys made with a person's dashboard key are revoked when that person leaves", async () => {
    const b = new Browser();
    await b.signIn(uniqueEmail("leaver"));
    await connect(b, "new");
    const acct = await newestProject(b);
    const made = await b.submit(`/dashboard/projects/${acct}/keys`, `/dashboard/projects/${acct}/keys`, { name: "k1", scope: "*" });
    const k1 = /<pre class="secret">([^<]+)<\/pre>/.exec(made.text)![1]!;
    const k2 = (await call("POST", "/v1/keys", { key: k1, json: { name: "k2" } })).json.api_key as string;
    expect((await call("GET", "/v1/me", { key: k2 })).status).toBe(200);
    const me = /members\/(usr_[0-9a-z]+)\/remove/.exec((await b.get(`/dashboard/projects/${acct}/members`)).text)![1]!;
    expect((await b.submit(`/dashboard/projects/${acct}/members`, `/dashboard/projects/${acct}/members/${me}/remove`)).status).toBe(303);
    expect((await call("GET", "/v1/me", { key: k1 })).status).toBe(401);
    expect((await call("GET", "/v1/me", { key: k2 })).status).toBe(401);
  });
});

describe("signup refuses scripts on other websites", () => {
  it("rejects cross-site browser requests, accepts agents and same-origin", async () => {
    const cross = await call("POST", "/v1/signup", {
      ip: nextIp(),
      headers: { origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8", "sec-fetch-site": "cross-site" },
      body: "",
    });
    expect(cross.status).toBe(403);
    expect(cross.json.error.hint).toContain("not from browser JavaScript");
    const otherOrigin = await call("POST", "/v1/signup", { ip: nextIp(), headers: { origin: "https://evil.example" }, json: {} });
    expect(otherOrigin.status).toBe(403);
    expect((await call("POST", "/v1/signup", { ip: nextIp(), json: {} })).status).toBe(201);
    expect(
      (
        await call("POST", "/v1/signup", {
          ip: nextIp(),
          headers: { origin: "https://afs.test", "sec-fetch-site": "same-origin" },
          json: {},
        })
      ).status,
    ).toBe(201);
  });
});

describe("claim links live only as long as the key that asked for them", () => {
  it("a revoked key's unused claim link stops working", async () => {
    const agent = await signup("rotated project");
    const leaked = await call("POST", "/v1/claim-link", { key: agent.key });
    expect(leaked.status).toBe(201);
    const fresh = await call("POST", "/v1/keys", { key: agent.key, json: { name: "rotated" } });
    expect((await call("DELETE", `/v1/keys/${agent.keyId}`, { key: fresh.json.api_key })).status).toBe(200);
    const attacker = new Browser();
    await attacker.signIn(uniqueEmail("attacker"));
    expect((await attacker.get(new URL(leaked.json.url).pathname)).status).toBe(404);
    // A link from the live key still works.
    const ok = await call("POST", "/v1/claim-link", { key: fresh.json.api_key });
    expect((await attacker.get(new URL(ok.json.url).pathname)).status).toBe(200);
  });
});

describe("OAuth clients can't redirect to the platform itself", () => {
  it("refuses redirect URIs on the issuer's host and its subdomains", async () => {
    for (const uri of ["https://afs.test/cb", "https://evil.afs.test/cb"]) {
      const r = await registerClient({ client_name: "X", redirect_uris: [uri] });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_redirect_uri");
    }
    expect((await registerClient({ client_name: "Y", redirect_uris: [REDIRECT] })).status).toBe(201);
  });
});
