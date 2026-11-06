/**
 * The path-proxy key: a customer's own proxy (/_r/* forwarded unchanged) sends x-afs-proxy-key with
 * the site's key (HMAC of the site id with ENCRYPTION_KEY), and only then are X-Forwarded-For and
 * x-afs-geo-* the visitor's. Shown in install answers to full-access keys only.
 */
import { hmacSha256Hex } from "@afs/shared";
import { describe, expect, it } from "vitest";
import { geo, visitorIp } from "../../src/service/ingest";
import { PROXY_KEY_HEADER, proxyKey, proxyTrust } from "../../src/service/proxy";
import { page } from "../fixtures/rrweb";
import { call, E, hosted, newSid, newSite, sendChunk, tool } from "./helpers";

const PROXY_IP = "198.18.5.5"; // the customer's proxy, as replay sees it (cf-connecting-ip)

/** A new session's first chunk through the site's path proxy, for one visitor. */
const viaProxy = (site: string, domain: string, visitorIp: string, opts: { key?: string; country?: string; env?: typeof E } = {}) =>
  sendChunk(site, newSid(), 0, [page(Date.now() - 5_000, 1, "/", { h: domain })], {
    origin: `https://${domain}`,
    path: "/_r/i",
    ip: PROXY_IP,
    env: opts.env,
    headers: {
      "x-forwarded-for": visitorIp,
      ...(opts.country ? { "x-afs-geo-country": opts.country } : {}),
      ...(opts.key ? { [PROXY_KEY_HEADER]: opts.key } : {}),
    },
  });

describe("the site's proxy key in the install answer", () => {
  it("is an HMAC of the site id (stable, never stored), filled into every config for full-access keys only", async () => {
    const { key, site } = await newSite("pk-install.test");
    const want = await hmacSha256Hex(E.ENCRYPTION_KEY!, `afs-replay-proxy:${site}`);
    expect(await proxyKey(E, site)).toBe(want);
    const full = (await call("GET", `/v1/sites/${site}/install`, { key })).json;
    expect(full.first_party.path_proxy).toMatchObject({
      configs: "first_party_proxy",
      snippet: `<script defer src="/_r/r/${site}.js"></script>`,
    });
    const p = full.first_party_proxy;
    expect(p).toMatchObject({ proxy_key: want, proxy_key_header: "x-afs-proxy-key", path_prefix: "/_r" });
    for (const c of ["cloudflare_worker", "nextjs", "vercel", "netlify", "nginx"]) expect(p[c].code, c).toContain(want);
    // one proxy for all three: the table-driven configs name analytics' and tags' prefixes
    expect(p.cloudflare_worker.code).toContain('"/_a/"');
    expect(p.cloudflare_worker.code).toContain('"/_t/"');
    expect(JSON.stringify(await call("GET", `/v1/sites/${site}/install`, { key }))).toContain(want); // stable
    // read-only keys see the configs, not the key
    const ro = (await call("POST", "/v1/keys", { key, body: { scope: "read" } })).json.api_key;
    const hidden = (await call("GET", `/v1/sites/${site}/install`, { key: ro })).json;
    expect(hidden.first_party_proxy.proxy_key).toBeNull();
    expect(hidden.first_party_proxy.proxy_key_note).toContain("full-access");
    expect(JSON.stringify(hidden)).not.toContain(want);
    expect(hidden.first_party_proxy.nginx.code).toContain("<hidden");
    // MCP, with the project's key
    expect(JSON.stringify((await tool(key, "get_install_snippet", { site_id: site })).data)).toContain(want);
  });
});

describe("visitor IP and geo through a path proxy", () => {
  it("with the key: the visitor's IP and geo are used, and the per-network caps count each visitor", async () => {
    const domain = "pk-trusted.test";
    const { key, site } = await newSite(domain);
    const pk = (await proxyKey(E, site))!;
    const env = hosted({ MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY: "1" });
    expect((await viaProxy(site, domain, "203.0.113.70", { key: pk, country: "FR", env })).status).toBe(202);
    expect((await viaProxy(site, domain, "203.0.113.71", { key: pk, country: "DE", env })).status).toBe(202);
    // the same visitor again is over its network's share
    expect((await viaProxy(site, domain, "203.0.113.70", { key: pk, env })).json.error).toBe("ip_daily_limit");
    const sessions = (await call("GET", `/v1/sites/${site}/sessions?sort=recent`, { key })).json.sessions;
    expect(sessions.map((s: { country: string }) => s.country).sort()).toEqual(["DE", "FR"]);
    const data = (await call("GET", `/v1/sites/${site}`, { key })).json.data;
    expect(data.warnings_last_7d).toEqual({});
  });

  it("without a key or with a wrong one: the proxy's IP (one network for every visitor), no geo, and verify says the key is missing", async () => {
    const domain = "pk-missing.test";
    const { key, site } = await newSite(domain);
    const env = hosted({ MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY: "1" });
    expect((await viaProxy(site, domain, "203.0.113.80", { country: "FR", env })).status).toBe(202);
    const second = await viaProxy(site, domain, "203.0.113.81", { env });
    expect(second.status).toBe(429);
    expect(second.json.error).toBe("ip_daily_limit"); // both visitors are the proxy's network
    const wrong = await viaProxy(site, domain, "203.0.113.82", { key: "0".repeat(64), country: "FR" });
    expect(wrong.status).toBe(202);
    const sessions = (await call("GET", `/v1/sites/${site}/sessions`, { key })).json.sessions;
    expect(sessions.map((s: { country: string | null }) => s.country)).toEqual([null, null]); // the forwarded FR is ignored
    const data = (await call("GET", `/v1/sites/${site}`, { key })).json.data;
    expect(data.warnings_last_7d.proxy_key_missing.count).toBeGreaterThan(0);
    expect(data.warnings_last_7d.proxy_key_invalid.count).toBeGreaterThan(0);
    expect(data.dropped_last_7d.proxy_key_missing).toBeUndefined(); // kept, not refused
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    try {
      const v = (await call("POST", `/v1/sites/${site}/verify`, { key })).json;
      const check = v.checks.find((c: { id: string }) => c.id === "proxy_key");
      expect(check).toMatchObject({ ok: false });
      expect(check.detail).toContain("x-afs-proxy-key");
      expect(check.fix).toContain(`/v1/sites/${site}/install`);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('the loader through a proxy: forwarded country only with the key (else unknown, so "eea" consent applies)', async () => {
    const { site } = await newSite("pk-loader.test", { require_consent: "eea" });
    const pk = (await proxyKey(E, site))!;
    const cfg = async (headers: Record<string, string>) =>
      JSON.parse(/var __AFSR__=(\{.*?\});\n/.exec((await call("GET", `/_r/r/${site}.js`, { ip: PROXY_IP, headers })).text)![1]!);
    expect((await cfg({ "x-afs-geo-country": "US", [PROXY_KEY_HEADER]: pk })).consent).toBe(false);
    expect((await cfg({ "x-afs-geo-country": "FR", [PROXY_KEY_HEADER]: pk })).consent).toBe(true);
    expect((await cfg({ "x-afs-geo-country": "US" })).consent).toBe(true); // keyless: unknown country
  });

  it("who is trusted: the key (constant-time), the platform's edge as before; direct requests use request.cf", async () => {
    const site = "rsite_0000000000000001";
    const pk = (await proxyKey(E, site))!;
    const env = { ENCRYPTION_KEY: E.ENCRYPTION_KEY, INTERNAL_TOKEN: "edge-token" };
    const req = (path: string, h: Record<string, string> = {}, host = "replay.example.com") =>
      new Request(`https://${host}${path}`, { headers: { "cf-connecting-ip": PROXY_IP, "x-forwarded-for": "203.0.113.9", ...h } });
    expect(await proxyTrust(env, req("/_r/i", { [PROXY_KEY_HEADER]: pk }), site)).toBe("proxy");
    expect(await proxyTrust(env, req("/_r/i", { [PROXY_KEY_HEADER]: pk }), "rsite_0000000000000002")).toBe("invalid"); // another site's key
    expect(await proxyTrust(env, req("/_r/i"), site)).toBe("missing");
    expect(await proxyTrust(env, req("/i"), site)).toBeNull();
    expect(await proxyTrust(env, req(`/r/${site}.js`), site)).toBeNull();
    expect(await proxyTrust(env, req(`/_r/r/${site}.js`), site)).toBe("missing");
    const edge = req(
      "/_r/i",
      { "x-afs-internal": "edge-token", "x-afs-edge-host": "edge.shop.test", "x-afs-geo-country": "fr" },
      "replay.internal",
    );
    expect(await proxyTrust(env, edge, site)).toBe("edge");
    expect(visitorIp(edge, env, "edge")).toBe("203.0.113.9");
    expect(visitorIp(edge, env)).toBe("203.0.113.9"); // callers without a trust value: the edge only
    expect(geo(edge, false, env).country).toBe("FR");
    const keyed = req("/_r/i", { [PROXY_KEY_HEADER]: pk, "x-vercel-ip-country": "nl", "x-vercel-ip-city": "Amsterdam" });
    expect(visitorIp(keyed, env, "proxy")).toBe("203.0.113.9");
    expect(geo(keyed, false, env, "proxy")).toEqual({ country: "NL", region: null, city: "Amsterdam" });
    expect(visitorIp(keyed, env, "missing")).toBe(PROXY_IP);
    expect(visitorIp(keyed, env)).toBe(PROXY_IP);
    expect(await proxyTrust({ INTERNAL_TOKEN: "edge-token" }, req("/_r/i", { [PROXY_KEY_HEADER]: pk }), site)).toBe("invalid"); // no ENCRYPTION_KEY: no keys
  });
});
