/**
 * Public dashboards on a user-content host (USER_CONTENT_BASE_URL, routes/share.ts): new links point
 * there, the host serves the dashboards and nothing else, the unlock cookie is that host's, and the
 * old /share/ URLs answer 301 while the link is valid.
 */
import { forgetPauses } from "@afs/shared";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const B = "http://analytics.test";
const UC = "https://usercontent.test";
const over = { USER_CONTENT_BASE_URL: UC, ABUSE_REPORT_URL: "https://platform.test/report-abuse" };

async function fetchAt(url: string, init: RequestInit & { key?: string; json?: unknown; vars?: Record<string, unknown> } = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url, { ...init, headers, redirect: "manual", body: init.json !== undefined ? JSON.stringify(init.json) : init.body }),
    { ...env, ...(init.vars ?? over) } as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, headers: res.headers, body, text };
}

const api = (path: string, init: Parameters<typeof fetchAt>[1] = {}) => fetchAt(`${B}${path}`, init);

async function verifiedSite(domain: string) {
  const key = (await api("/v1/signup", { method: "POST", vars: { ...over, SIGNUP_LIMITER: undefined } })).body.api_key as string;
  const site = (await api("/v1/sites", { method: "POST", key, json: { domain } })).body.site.id as string;
  await env.DB.prepare("UPDATE sites SET verified_at = ?, verify_method = 'dns_txt' WHERE id = ?").bind(Date.now(), site).run();
  return { key, site };
}

describe("public dashboards on the user-content host", () => {
  it("new links point there; the page, its data and Report abuse work there with the same headers", async () => {
    const { key, site } = await verifiedSite("uc-dash.test");
    const made = await api(`/v1/sites/${site}/share`, { method: "POST", key, json: {} });
    expect(made.status).toBe(201);
    const url = made.body.url as string;
    expect(url).toMatch(/^https:\/\/usercontent\.test\/a\/shr_[0-9a-z]{32}$/);
    expect((await api(`/v1/sites/${site}/share`, { key })).body.share_links[0].url).toBe(url);

    const page = await fetchAt(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(page.text).toContain(`data-share="${new URL(url).pathname}"`);
    expect(page.text).toContain(`https://platform.test/report-abuse?url=${encodeURIComponent(url)}`);
    expect(page.text).toContain(">Report abuse</a>");
    const data = await fetchAt(`${url}/data?period=7d`);
    expect(data.status).toBe(200);
    expect(data.body.site).toMatchObject({ domain: "uc-dash.test", verified: true });
    expect((await api("/llms.txt", {})).text).toContain(`${UC}/a/:token`);
  });

  it("a password unlock sets a host-only cookie for that link's /a/ path, and only on the user-content host", async () => {
    const { key, site } = await verifiedSite("uc-pw.test");
    const made = (await api(`/v1/sites/${site}/share`, { method: "POST", key, json: { password: "correct horse", label: "pw" } })).body;
    const url = made.url as string;
    const path = new URL(url).pathname;
    const form = await fetchAt(url);
    expect(form.text).toContain(`action="${path}/unlock"`);
    expect(form.headers.get("content-security-policy")).toContain("form-action 'self'");
    const unlock = await fetchAt(`${url}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=correct+horse",
    });
    expect(unlock.status).toBe(303);
    expect(unlock.headers.get("location")).toBe(path);
    const cookie = unlock.headers.get("set-cookie")!;
    expect(cookie).toContain(`Path=${path}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie.toLowerCase()).not.toContain("domain=");
    const value = cookie.split(";")[0]!;
    const data = await fetchAt(`${url}/data`, { headers: { cookie: value } });
    expect(data.status).toBe(200);
    expect((await fetchAt(`${url}/data`)).status).toBe(401);
  });

  it("serves nothing else: no API, MCP, signup, tracker or collection on that host", async () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/llms.txt"],
      ["GET", "/v1/sites"],
      ["POST", "/v1/signup"],
      ["POST", "/mcp"],
      ["GET", "/s.js"],
      ["GET", "/a/s.js"],
      ["POST", "/e"],
      ["POST", "/a/e"],
      ["GET", "/share/shr_x"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
    ] as const) {
      const r = await fetchAt(`${UC}${path}`, { method });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // The service host still serves them.
    expect((await api("/s.js")).status).toBe(200);
  });

  it("an old /share/ URL answers 301 to the new one while valid; the old data URL keeps answering; revoked and paused links as before", async () => {
    const { key, site } = await verifiedSite("uc-old.test");
    // Made before the move: on the service host.
    const old = (await api(`/v1/sites/${site}/share`, { method: "POST", key, json: {}, vars: {} })).body;
    expect(old.url).toBe(`${B}/share/${old.token}`);

    const moved = await api(`/share/${old.token}?period=7d`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe(`${UC}/a/${old.token}?period=7d`);
    expect(moved.headers.get("cache-control")).toBe("no-store");
    expect(moved.headers.get("x-robots-tag")).toContain("noindex");
    expect((await api(`/share/${old.token}/data`)).status).toBe(200);
    // Without the var nothing moves.
    expect((await api(`/share/${old.token}`, { vars: {} })).status).toBe(200);

    // A password form loaded before the move: a link to the new host (its CSP would block a redirect).
    const pw = (await api(`/v1/sites/${site}/share`, { method: "POST", key, json: { password: "correct horse", label: "pw" }, vars: {} }))
      .body;
    const posted = await api(`/share/${pw.token}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=correct+horse",
    });
    expect(posted.status).toBe(200);
    expect(posted.text).toContain(`href="${UC}/a/${pw.token}"`);
    expect(posted.headers.get("set-cookie")).toBeNull();

    const accountId = (await api("/v1/me", { key })).body.account.id as string;
    await (env.AUTH_DB ?? env.DB)
      .prepare(
        "INSERT INTO capability_pauses (account_id, capability, reason, paused_at, paused_by) VALUES (?, 'analytics.share_links', 'a phishing report', ?, 'operator')",
      )
      .bind(accountId, Date.now())
      .run();
    forgetPauses(accountId);
    for (const url of [`${B}/share/${old.token}`, `${UC}/a/${old.token}`, `${UC}/a/${old.token}/data`]) {
      const r = await fetchAt(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code, url).toBe("capability_paused");
    }
    await (env.AUTH_DB ?? env.DB).prepare("DELETE FROM capability_pauses WHERE account_id = ?").bind(accountId).run();
    forgetPauses(accountId);

    await api(`/v1/sites/${site}/share?token=${old.token}`, { method: "DELETE", key });
    expect((await api(`/share/${old.token}`)).status).toBe(404);
    expect((await fetchAt(`${UC}/a/${old.token}`)).status).toBe(404);
  });
});
