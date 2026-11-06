import { createAccount } from "@afs/shared";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { findTrackerScripts } from "../../src/service/verify";

/**
 * First-party by default: the platform's edge (a customer's first-party domain, forwarded by the
 * site Worker over a service binding with INTERNAL_TOKEN and x-afs-edge-host) is trusted like a
 * valid proxy key, the replay loader it hands out is first-party too, every browser event's path
 * is counted per day, and every install answer leads with `first_party`.
 */

const B = "http://analytics.test";
const INTERNAL = "first-party-internal";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RSITE = "rsite_0123456789abcdef";
const VARS = { INTERNAL_TOKEN: INTERNAL, REPLAY_BASE_URL: "https://replay.example.net", AUTH_ISSUER: "https://platform.test" };

type Init = RequestInit & { key?: string; json?: unknown };
async function send(url: string, init: Init = {}, over: Record<string, unknown> = VARS) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(url.startsWith("http") ? url : `${B}${url}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    }),
    { ...env, ...over } as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: test bodies
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** A project made in the identity DB (POST /v1/signup is rate limited per minute) with one site. */
async function siteFor(domain: string) {
  const { accountId, apiKey } = await createAccount(env.AUTH_DB ?? env.DB, { keyPrefix: "afs", name: "fp" });
  const created = await send("/v1/sites", { method: "POST", key: apiKey.key, json: { domain } });
  expect(created.status).toBe(201);
  return { key: apiKey.key, accountId, site: created.body.site.id as string, created: created.body };
}

/** What the site Worker's edge sends for edge.<domain>/_a/e (src/first-party.ts firstPartyEdge). */
const edgeBeacon = (site: string, domain: string, ip: string, headers: Record<string, string> = {}, host = `edge.${domain}`) =>
  send("https://analytics.internal/_a/e", {
    method: "POST",
    body: JSON.stringify({ s: site, u: `https://${domain}/pricing` }),
    headers: {
      "user-agent": UA,
      "content-type": "text/plain",
      "cf-connecting-ip": ip,
      "x-forwarded-for": ip,
      "x-afs-internal": INTERNAL,
      "x-afs-edge-host": host,
      "x-afs-geo-country": "FR",
      "x-afs-geo-city": "Lyon",
      "x-afs-geo-region-code": "ARA",
      ...headers,
    },
  });

const sql = async (key: string, site: string, q: string) =>
  (await send(`/v1/sites/${site}/sql?q=${encodeURIComponent(q)}`, { key })).body.rows as Record<string, unknown>[];

describe("the platform's edge (first-party domains)", () => {
  it("is trusted like a proxy key: the visitor's IP and geo are used, no proxy warning, and r is first-party", async () => {
    const domain = "edgefp.test";
    const { key, accountId, site } = await siteFor(domain);
    // Link a replay site as the replay service does (internal auth over a binding).
    const link = await send(`https://analytics.internal/v1/sites/${site}`, {
      method: "PATCH",
      headers: { "x-afs-internal": INTERNAL, "x-afs-account": accountId },
      json: { replay_site_id: RSITE },
    });
    expect(link.status).toBe(200);

    const a = await edgeBeacon(site, domain, "203.0.113.10");
    const b = await edgeBeacon(site, domain, "203.0.113.11");
    expect(a.status).toBe(202);
    expect(a.body).toMatchObject({ ok: true, r: `https://edge.${domain}/_r/r/${RSITE}.js` });
    expect(a.body.v).not.toBe(b.body.v); // two visitors, by their own IPs
    const rows = await sql(key, site, "SELECT country, city, region_code FROM events ORDER BY id");
    expect(rows).toEqual([
      { country: "FR", city: "Lyon", region_code: "ARA" },
      { country: "FR", city: "Lyon", region_code: "ARA" },
    ]);

    // The same headers from the internet (not over a binding), or with a wrong token: not the edge.
    const forged = await send("/_a/e", {
      method: "POST",
      body: JSON.stringify({ s: site, u: `https://${domain}/` }),
      headers: {
        "user-agent": UA,
        "x-forwarded-for": "198.51.100.1",
        "x-afs-internal": INTERNAL,
        "x-afs-edge-host": `edge.${domain}`,
        "x-afs-geo-country": "FR",
      },
    });
    expect(forged.body.ok).toBe(true);
    expect(forged.body.r).toBe(`https://replay.example.net/r/${RSITE}.js`);
    const wrong = await edgeBeacon(site, domain, "203.0.113.12", { "x-afs-internal": "not-the-token" });
    expect(wrong.body.r).toBe(`https://replay.example.net/r/${RSITE}.js`);
    const last = await sql(key, site, "SELECT country FROM events ORDER BY id DESC LIMIT 2");
    expect(last).toEqual([{ country: null }, { country: null }]);
    const info = await send(`/v1/sites/${site}`, { key });
    // Only the untrusted ones (under /_a without a key) are proxy warnings.
    expect(info.body.data.warnings_last_7d.proxy_key_missing.count).toBe(2);
  });

  it("counts how browser events reached the collector per day (direct / proxy / edge) in GET /v1/sites/:id", async () => {
    const domain = "paths.test";
    const { key, site, created } = await siteFor(domain);
    const proxyKey = created.install.first_party_proxy.proxy_key as string;
    const beacon = (path: string, headers: Record<string, string> = {}) =>
      send(path, { method: "POST", body: JSON.stringify({ s: site, u: `https://${domain}/` }), headers: { "user-agent": UA, ...headers } });
    await beacon("/e", { "cf-connecting-ip": "192.0.2.1" });
    await beacon("/e", { "cf-connecting-ip": "192.0.2.2" });
    await beacon("/_a/e", { "x-afs-proxy-key": proxyKey, "x-forwarded-for": "192.0.2.3" });
    await edgeBeacon(site, domain, "192.0.2.4", {}, `go.${domain}`);
    // engagement beacons count too (they arrive the same way)
    await send("/e", {
      method: "POST",
      body: JSON.stringify({ s: site, u: `https://${domain}/`, n: "engagement", e: 4000 }),
      headers: { "user-agent": UA, "cf-connecting-ip": "192.0.2.1" },
    });
    const got = await send(`/v1/sites/${site}`, { key });
    expect(got.body.data.collection_last_7d).toMatchObject({ direct: 3, proxy: 1, edge: 1, edge_hosts: [`go.${domain}`] });
    const c = got.body.data.collection_last_7d;
    expect(c.last_direct_at).toBeGreaterThanOrEqual(c.last_first_party_at); // the engagement beacon came last, directly
    expect(c.last_first_party_at).toBeGreaterThan(Date.now() - 60_000);
    // server events aren't browser collection
    await send(`/v1/sites/${site}/events`, { method: "POST", key, json: { events: [{ name: "signup", url: `https://${domain}/` }] } });
    expect((await send(`/v1/sites/${site}`, { key })).body.data.collection_last_7d.direct).toBe(3);
  });
});

describe("install answers lead with first_party", () => {
  afterEach(() => vi.restoreAllMocks());

  it("create and GET install: first_party first, in order, with the platform's first-party domain endpoint; old fields kept", async () => {
    const { key, site, created } = await siteFor("install-fp.test");
    expect(Object.keys(created.install)[0]).toBe("first_party");
    const fp = created.install.first_party;
    expect(fp.order).toEqual(["first_party_domain", "path_proxy", "direct"]);
    expect(fp.first_party_domain.create).toContain("POST https://platform.test/v1/first-party-domains");
    expect(fp.first_party_domain.snippet).toBe(`<script defer src="https://<hostname>/_a/s.js" data-site="${site}"></script>`);
    expect(fp.path_proxy.snippet).toBe(`<script defer src="/_a/s.js" data-site="${site}"></script>`);
    expect(fp.direct.snippet).toContain("/s.js");
    // agents mid-setup keep what they had
    expect(created.install.snippet).toBe(fp.direct.snippet);
    expect(created.install.first_party_proxy.proxy_key).toMatch(/^[0-9a-f]{64}$/);
    expect(created.next_steps[0]).toContain("first-party");
    expect(created.next_steps[0]).toContain("https://platform.test/v1/first-party-domains");
    // without the platform site (a single app self-hosted): the path proxy leads
    const alone = await send(`/v1/sites/${site}/install`, { key }, { AUTH_ISSUER: "" });
    expect(alone.body.first_party.first_party_domain.create).toContain("path proxy");
    expect(alone.body.first_party.first_party_domain.status).toBeNull();
    const html = await send(`/v1/sites/${site}/install?framework=html`, { key });
    expect(html.body.install.notes.join(" ")).toContain("First-party by default");
  });

  it("Next.js: a plain <script defer> in the root layout's <head> (server HTML, so verify finds it) plus proxy.ts, never next/script", async () => {
    const { key, site, created } = await siteFor("next-fp.test");
    const proxyKey = created.install.first_party_proxy.proxy_key as string;
    const next = (await send(`/v1/sites/${site}/install?framework=nextjs`, { key })).body;
    expect(next.install.file).toBe("app/layout.tsx");
    expect(next.install.code).toContain(`<script defer src="/_a/s.js" data-site="${site}" />`);
    expect(next.install.code).not.toContain("next/script");
    expect(next.install.code).not.toContain("afterInteractive");
    const files = Object.fromEntries((next.install.files as { file: string; code: string }[]).map((f) => [f.file, f.code]));
    expect(files["proxy.ts"]).toContain(proxyKey);
    expect(files["proxy.ts"]).toContain('matcher: "/_a/:path*"');
    expect(files["pages/_document.tsx"]).toContain(`<script defer src="/_a/s.js" data-site="${site}" />`);
    // What React renders for it in the server HTML is what verify looks for.
    const ssr = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><script defer="" src="/_a/s.js" data-site="${site}"></script></head><body></body></html>`;
    expect(findTrackerScripts(ssr)).toEqual([{ src: "/_a/s.js", site, defer: true, async: false }]);

    // verify on that page, served through the site's proxy.ts: the snippet, its loading and the domain.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://next-fp.test/") return new Response(ssr, { headers: { "content-type": "text/html" } });
      if (url === "https://next-fp.test/_a/s.js")
        return new Response("/* afs-analytics */", { headers: { "content-type": "text/javascript" } });
      return new Response("not found", { status: 404 });
    });
    const v = await send(`/v1/sites/${site}/verify`, { method: "POST", key, json: {} });
    const checks = Object.fromEntries((v.body.checks as { id: string; ok: boolean }[]).map((c) => [c.id, c.ok]));
    expect(checks).toMatchObject({ snippet_present: true, script_loads: true, domain_verified: true });
    expect(checks.snippet_defer).toBeUndefined();
  });

  it("verify: a tracker on a first-party domain the edge serves passes once events arrived through it", async () => {
    const domain = "edgeverify.test";
    const { key, site } = await siteFor(domain);
    const page = `<html><head><script defer src="https://edge.${domain}/_a/s.js" data-site="${site}"></script></head></html>`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `https://${domain}/`) return new Response(page, { headers: { "content-type": "text/html" } });
      return new Response("origin unreachable", { status: 522 }); // a Worker can't fetch its own zone
    });
    const before = await send(`/v1/sites/${site}/verify`, { method: "POST", key, json: {} });
    const loads = (before.body.checks as { id: string; ok: boolean; fix?: string }[]).find((c) => c.id === "script_loads")!;
    expect(loads.ok).toBe(false);
    expect(loads.fix).toContain(`/v1/first-party-domains/edge.${domain}`);
    await edgeBeacon(site, domain, "203.0.113.30");
    const after = await send(`/v1/sites/${site}/verify`, { method: "POST", key, json: {} });
    expect((after.body.checks as { id: string; ok: boolean }[]).find((c) => c.id === "script_loads")?.ok).toBe(true);
  });

  it("the proxy configs: a Netlify Edge Function with the visitor's IP and geo, and vercel.json's request-header transform", async () => {
    const { key, site, created } = await siteFor("proxies-fp.test");
    const proxyKey = created.install.first_party_proxy.proxy_key as string;
    const p = (await send(`/v1/sites/${site}/install`, { key })).body.first_party_proxy;
    expect(p.netlify.file).toContain("netlify/edge-functions/");
    expect(p.netlify.code).toContain('headers.set("x-forwarded-for", context.ip)');
    expect(p.netlify.code).toContain("context.geo");
    expect(p.netlify.code).toContain(proxyKey);
    expect(p.netlify.code).toContain('export const config: Config = { path: "/_a/*" }');
    expect(JSON.parse(p.vercel.code).routes[0].transforms[0]).toMatchObject({ type: "request.headers", op: "set", args: proxyKey });
  });
});
