import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetHost } from "../src/first-party-domains";
import { E, call, fixtures, signup, testEnv } from "./helpers";

/** Cloudflare's API for one SaaS zone, in memory: custom hostnames and Worker routes. */
function mockCloudflare() {
  const hostnames = new Map<string, { id: string; hostname: string; status: string; ssl: Record<string, unknown> }>();
  const routes = new Map<string, { id: string; pattern: string; script: string }>();
  const calls: { method: string; path: string; body: any; auth: string | null }[] = [];
  const state = { status: "pending", ssl: "initializing", failRoutes: false };
  let seq = 0;
  const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], messages: [], result }, { status });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.hostname !== "api.cloudflare.com") throw new Error(`unexpected fetch ${req.url}`);
    const path = u.pathname.replace("/client/v4/zones/zone_test", "");
    const body = req.method === "POST" ? await req.json() : null;
    calls.push({ method: req.method, path: `${path}${u.search}`, body, auth: req.headers.get("authorization") });
    if (path === "/custom_hostnames" && req.method === "POST") {
      const b = body as { hostname: string; ssl: Record<string, unknown> };
      if ([...hostnames.values()].some((h) => h.hostname === b.hostname)) return fail(409, 1406, "Duplicate custom hostname found.");
      const h = {
        id: `ch_${++seq}`,
        hostname: b.hostname,
        status: state.status,
        ssl: {
          ...b.ssl,
          status: state.ssl,
          validation_records: [{ http_url: "http://x/.well-known/pki-validation/a.txt", http_body: "b" }],
        },
        ownership_verification: { type: "txt", name: `_cf-custom-hostname.${b.hostname}`, value: "uuid-1" },
      };
      hostnames.set(h.id, h);
      return ok(h, 201);
    }
    if (path === "/custom_hostnames" && req.method === "GET")
      return ok([...hostnames.values()].filter((h) => h.hostname === u.searchParams.get("hostname")));
    const one = /^\/custom_hostnames\/([^/]+)$/.exec(path);
    if (one) {
      const h = hostnames.get(one[1]!);
      if (!h) return fail(404, 1436, "Custom hostname not found.");
      if (req.method === "DELETE") {
        hostnames.delete(h.id);
        return ok({ id: h.id });
      }
      return ok({ ...h, status: state.status, ssl: { ...h.ssl, status: state.ssl } });
    }
    if (path === "/workers/routes" && req.method === "POST") {
      if (state.failRoutes) return fail(500, 10013, "Internal error.");
      const b = body as { pattern: string; script: string };
      const r = { id: `rt_${++seq}`, pattern: b.pattern, script: b.script };
      routes.set(r.id, r);
      return ok(r);
    }
    if (path === "/workers/routes" && req.method === "GET") return ok([...routes.values()]);
    const route = /^\/workers\/routes\/([^/]+)$/.exec(path);
    if (route && req.method === "DELETE") {
      if (!routes.delete(route[1]!)) return fail(404, 10007, "Route not found.");
      return ok({ id: route[1] });
    }
    return fail(400, 7003, `No route for ${req.method} ${path}`);
  });
  return { hostnames, routes, calls, state };
}

const SAAS = {
  CF_SAAS_API_TOKEN: "cf-token",
  CF_SAAS_ZONE_ID: "zone_test",
  CF_SAAS_FALLBACK_HOST: "fp.afs.test",
  CF_SAAS_WORKER: "afs-site",
};

/** A service that answers with what it was sent. */
const echo = (name: string) =>
  ({
    fetch: async (input: RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      return Response.json({
        service: name,
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body: req.method === "POST" ? await req.text() : null,
      });
    },
  }) as unknown as Fetcher;

let n = 0;
/** A project with an analytics site, a tag container and a replay site on its own domain. */
async function project() {
  const agent = await signup("fp");
  const domain = `shop${++n}-${Date.now().toString(36)}.example`;
  fixtures.set(agent.accountId, {
    sites: [{ id: `site_fp${n}`, domain, name: null, created_at: 1 }],
    containers: [{ id: `ctr_fp${n}abcdefgh`, domain, name: null, live_version: null, created_at: 1 }],
    replaySites: [{ id: `rsite_fp${n}`, domain: `www.${domain}`, name: null, enabled: true, created_at: 1 }],
  });
  return { ...agent, domain };
}

describe("first-party domains (POST/GET/DELETE /v1/first-party-domains)", () => {
  let cf: ReturnType<typeof mockCloudflare>;
  beforeEach(() => {
    cf = mockCloudflare();
  });
  afterEach(() => vi.restoreAllMocks());
  const env = testEnv(SAAS);

  it("answers 503 not_configured without Cloudflare for SaaS, pointing at the path proxy", async () => {
    const p = await project();
    const r = await call("POST", "/v1/first-party-domains", { key: p.key, json: { hostname: `edge.${p.domain}` } });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("not_configured");
    expect(r.json.error.hint).toContain("first_party_proxy");
    expect(cf.calls).toHaveLength(0);
    const list = await call("GET", "/v1/first-party-domains", { key: p.key });
    expect(list.json).toMatchObject({ first_party_domains: [], available: false });
  });

  it("creates the custom hostname and the Worker route, and answers with the CNAME, the snippets and next_steps", async () => {
    const p = await project();
    const hostname = `edge.${p.domain}`;
    const r = await call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname: `https://Edge.${p.domain}/` } });
    expect(r.status).toBe(201);
    expect(r.json.existing).toBe(false);
    expect(r.json.warning).toBeUndefined();
    const d = r.json.first_party_domain;
    expect(d).toMatchObject({ hostname, status: "pending", hostname_status: "pending", ssl_status: "initializing" });
    expect(d.dns_records[0]).toMatchObject({ type: "CNAME", name: hostname, value: "fp.afs.test", required: true });
    expect(d.dns_records).toContainEqual(
      expect.objectContaining({ type: "TXT", name: `_cf-custom-hostname.${hostname}`, required: false }),
    );
    expect(d.serves.analytics).toBe(`https://${hostname}/_a/*`);
    expect(r.json.snippets.analytics[0].snippet).toBe(`<script defer src="https://${hostname}/_a/s.js" data-site="site_fp${n}"></script>`);
    expect(r.json.snippets.tags[0].snippet).toBe(`<script async src="https://${hostname}/_t/c/ctr_fp${n}abcdefgh.js"></script>`);
    expect(r.json.snippets.replay.sites[0].snippet).toContain(`https://${hostname}/_r/r/rsite_fp${n}.js`);
    expect(r.json.next_steps[0]).toContain(`CNAME ${hostname} -> fp.afs.test`);
    expect(r.json.next_steps.join(" ")).toContain("/v1/setup");
    const create = cf.calls.find((x) => x.method === "POST" && x.path === "/custom_hostnames");
    expect(create).toMatchObject({ auth: "Bearer cf-token", body: { hostname, ssl: { method: "http", type: "dv" } } });
    expect(cf.calls.find((x) => x.method === "POST" && x.path === "/workers/routes")?.body).toEqual({
      pattern: `${hostname}/*`,
      script: "afs-site",
    });
    const row = await E.DB.prepare("SELECT * FROM first_party_domains WHERE hostname = ?").bind(hostname).first<Record<string, unknown>>();
    expect(row).toMatchObject({ account_id: p.accountId, status: "pending", cf_hostname_id: "ch_1", route_id: "rt_2" });
  });

  it("is idempotent for the same project and refuses another project's hostname (409)", async () => {
    const p = await project();
    const hostname = `go.${p.domain}`;
    expect((await call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname } })).status).toBe(201);
    const creates = cf.calls.length;
    const again = await call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, first_party_domain: { hostname } });
    expect(cf.calls.slice(creates).filter((x) => x.method === "POST")).toHaveLength(0);

    const other = await signup("fp-other");
    fixtures.set(other.accountId, { sites: [{ id: "site_other", domain: p.domain, name: null, created_at: 1 }] });
    const taken = await call("POST", "/v1/first-party-domains", { env, key: other.key, json: { hostname } });
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe("conflict");
    expect((await call("GET", `/v1/first-party-domains/${hostname}`, { env, key: other.key })).status).toBe(404);
    expect((await call("DELETE", `/v1/first-party-domains/${hostname}`, { env, key: other.key })).status).toBe(404);
  });

  it("adopts a custom hostname Cloudflare already has (a retry after a partial failure), and rolls back when the route fails", async () => {
    const p = await project();
    cf.state.failRoutes = true;
    const failed = await call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname: `cdn2.${p.domain}` } });
    expect(failed.status).toBe(502);
    expect(failed.json.error.hint).toContain("Retry");
    expect(cf.hostnames.size).toBe(0); // the custom hostname was removed again
    expect(await E.DB.prepare("SELECT 1 FROM first_party_domains WHERE hostname = ?").bind(`cdn2.${p.domain}`).first()).toBeNull();

    cf.state.failRoutes = false;
    cf.hostnames.set("ch_left", { id: "ch_left", hostname: `cdn3.${p.domain}`, status: "pending", ssl: { status: "pending_validation" } });
    const adopted = await call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname: `cdn3.${p.domain}` } });
    expect(adopted.status).toBe(201);
    expect(
      await E.DB.prepare("SELECT cf_hostname_id FROM first_party_domains WHERE hostname = ?")
        .bind(`cdn3.${p.domain}`)
        .first("cf_hostname_id"),
    ).toBe("ch_left");
  });

  it("validates: a subdomain of one of the project's sites, never the site itself, our own zone or junk", async () => {
    const p = await project();
    const post = (hostname: unknown) => call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname } });
    for (const [hostname, says] of [
      [p.domain, "the website itself"],
      [`www.${p.domain}`, "the website itself"],
      ["edge.unrelated.example", "isn't a subdomain of this project's websites"],
      ["edge.afs.test", "this platform's own domain"],
      ["fp.afs.test", "this platform's own domain"],
      ["edge.example.com/path", "bare hostname"],
      ["not a host", "bare hostname"],
      [42, "bare hostname"],
    ] as const) {
      const r = await post(hostname);
      expect(r.status, String(hostname)).toBe(400);
      expect(r.json.error.message).toContain(says);
      expect(r.json.error.hint).toMatch(/neutral name|edge\./);
    }
    expect(cf.calls).toHaveLength(0);
    // A label filter lists target is allowed, with a warning.
    const named = await post(`analytics.${p.domain}`);
    expect(named.status).toBe(201);
    expect(named.json.warning).toContain("filter lists");
  });

  it("caps first-party domains per project (MAX_FIRST_PARTY_DOMAINS_PER_ACCOUNT, UNCLAIMED_ for unclaimed projects)", async () => {
    const p = await project();
    const capped = testEnv({ ...SAAS, MAX_FIRST_PARTY_DOMAINS_PER_ACCOUNT: "5", UNCLAIMED_MAX_FIRST_PARTY_DOMAINS_PER_ACCOUNT: "1" });
    expect((await call("POST", "/v1/first-party-domains", { env: capped, key: p.key, json: { hostname: `a1.${p.domain}` } })).status).toBe(
      201,
    );
    const over = await call("POST", "/v1/first-party-domains", { env: capped, key: p.key, json: { hostname: `a2.${p.domain}` } });
    expect(over.status).toBe(403);
    expect(over.json.error.code).toBe("quota_exceeded");
  });

  it("refreshes the status from Cloudflare on GET, at most every 30 seconds per hostname", async () => {
    const p = await project();
    const hostname = `www2.${p.domain}`;
    await call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname } });
    cf.state.status = "active";
    cf.state.ssl = "active";
    const reads = () => cf.calls.filter((x) => x.method === "GET" && x.path.startsWith("/custom_hostnames/")).length;
    const fresh = await call("GET", `/v1/first-party-domains/${hostname}`, { env, key: p.key });
    expect(fresh.json.first_party_domain.status).toBe("pending"); // read 0 s ago at creation
    expect(reads()).toBe(0);
    await E.DB.prepare("UPDATE first_party_domains SET last_checked_at = ? WHERE hostname = ?")
      .bind(Date.now() - 31_000, hostname)
      .run();
    const list = await call("GET", "/v1/first-party-domains", { env, key: p.key });
    expect(list.json.first_party_domains[0]).toMatchObject({
      hostname,
      status: "active",
      ssl_status: "active",
      dns_records: [{ type: "CNAME" }],
    });
    expect(reads()).toBe(1);
    const one = await call("GET", `/v1/first-party-domains/${hostname}`, { env, key: p.key });
    expect(one.json.first_party_domain.status).toBe("active");
    expect(one.json.next_steps[0]).toBe(`${hostname} is active.`);
    expect(reads()).toBe(1);
  });

  it("deletes the route and the custom hostname in Cloudflare, then the row", async () => {
    const p = await project();
    const hostname = `edge.${p.domain}`;
    await call("POST", "/v1/first-party-domains", { env, key: p.key, json: { hostname } });
    const read = (await call("POST", "/v1/keys", { key: p.key, json: { scope: "read" } })).json.api_key as string;
    expect((await call("DELETE", `/v1/first-party-domains/${hostname}`, { env, key: read })).status).toBe(403);
    const del = await call("DELETE", `/v1/first-party-domains/${hostname}`, { env, key: p.key });
    expect(del.status).toBe(200);
    expect(del.json.deleted).toBe(hostname);
    expect(del.json.next_steps.join(" ")).toContain(`CNAME ${hostname}`);
    expect(cf.calls.filter((x) => x.method === "DELETE").map((x) => x.path)).toEqual([
      expect.stringMatching(/^\/workers\/routes\//),
      expect.stringMatching(/^\/custom_hostnames\//),
    ]);
    expect(cf.hostnames.size).toBe(0);
    expect(cf.routes.size).toBe(0);
    expect((await call("GET", `/v1/first-party-domains/${hostname}`, { env, key: p.key })).status).toBe(404);
  });

  it("has the same operations as MCP tools on the gateway (afs_add / list / remove_first_party_domain)", async () => {
    const p = await project();
    const mcp = (key: string, method: string, params: unknown = {}) =>
      call("POST", "/mcp", {
        env,
        key,
        headers: { accept: "application/json, text/event-stream" },
        json: { jsonrpc: "2.0", id: 1, method, params },
      });
    const names = ((await mcp(p.key, "tools/list")).json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["afs_add_first_party_domain", "afs_list_first_party_domains", "afs_remove_first_party_domain"]),
    );
    const hostname = `edge.${p.domain}`;
    const add = await mcp(p.key, "tools/call", { name: "afs_add_first_party_domain", arguments: { hostname } });
    expect(JSON.parse(add.json.result.content[0].text).first_party_domain.hostname).toBe(hostname);
    const one = await mcp(p.key, "tools/call", { name: "afs_list_first_party_domains", arguments: { hostname } });
    expect(JSON.parse(one.json.result.content[0].text).snippets.analytics).toHaveLength(1);
    const read = (await call("POST", "/v1/keys", { key: p.key, json: { scope: "read" } })).json.api_key as string;
    const readNames = ((await mcp(read, "tools/list")).json.result.tools as { name: string }[]).map((t) => t.name);
    expect(readNames).toContain("afs_list_first_party_domains");
    expect(readNames).not.toContain("afs_add_first_party_domain");
    expect((await mcp(read, "tools/call", { name: "afs_remove_first_party_domain", arguments: { hostname } })).json.result.isError).toBe(
      true,
    );
    const rm = await mcp(p.key, "tools/call", { name: "afs_remove_first_party_domain", arguments: { hostname } });
    expect(JSON.parse(rm.json.result.content[0].text).deleted).toBe(hostname);
  });
});

describe("the edge on a first-party domain", () => {
  afterEach(() => vi.restoreAllMocks());

  it("dispatches /_a/*, /_t/* and /_r/* to the services with the visitor's IP and geo and the edge's proof, stripping forged headers", async () => {
    mockCloudflare();
    const p = await project();
    const hostname = `edge.${p.domain}`;
    const env = testEnv({ ...SAAS, ANALYTICS: echo("analytics"), TAGS: echo("tags"), REPLAY: echo("replay") });
    // Creating needs the stub services (the project's sites); serving uses the echo ones.
    expect((await call("POST", "/v1/first-party-domains", { env: testEnv(SAAS), key: p.key, json: { hostname } })).status).toBe(201);
    forgetHost(hostname);

    const e = await call("POST", `https://${hostname}/_a/e`, {
      env,
      ip: "203.0.113.9",
      cf: { country: "DE", city: "Berlin", regionCode: "BE", asn: 3320 },
      body: '{"s":"site_x","u":"https://shop.example/"}',
      headers: {
        "x-afs-proxy-key": "forged",
        "x-afs-internal": "forged",
        "x-afs-edge-host": "evil.example",
        "x-afs-account": "acct_evil",
        "x-afs-geo-country": "US",
        cookie: "session=secret",
      },
    });
    expect(e.json).toMatchObject({ service: "analytics", url: "https://analytics.internal/_a/e", method: "POST" });
    expect(e.json.headers).toMatchObject({
      "x-afs-internal": E.INTERNAL_TOKEN,
      "x-afs-edge-host": hostname,
      "x-forwarded-for": "203.0.113.9",
      "x-afs-geo-country": "DE",
      "x-afs-geo-city": "Berlin",
      "x-afs-geo-region-code": "BE",
      "x-afs-geo-asn": "3320",
    });
    expect(e.json.headers["x-afs-proxy-key"]).toBeUndefined();
    expect(e.json.headers["x-afs-account"]).toBeUndefined();
    expect(e.json.headers.cookie).toBeUndefined();
    expect(e.json.body).toContain("site_x");

    const t = await call("GET", `https://${hostname}/_t/c/ctr_x.js?v=1`, { env });
    expect(t.json).toMatchObject({ service: "tags", url: "https://tags.internal/_t/c/ctr_x.js?v=1" });
    const r = await call("POST", `https://${hostname}/_r/i?z=1`, { env, body: "x" });
    expect(r.json).toMatchObject({ service: "replay", url: "https://replay.internal/_r/i?z=1" });

    // Nothing else of the platform is served on a customer's hostname.
    for (const path of ["/", "/v1/me", "/llms.txt", "/dashboard", "/_x/y"]) {
      const res = await call("GET", `https://${hostname}${path}`, { env, key: p.key });
      expect(res.status, path).toBe(404);
      expect(res.text).toBe("Not found.\n");
    }
    expect((await call("GET", `https://${hostname}/robots.txt`, { env })).text).toContain("Disallow: /");
    // A host that isn't a first-party domain is the platform as usual.
    expect((await call("GET", "https://other-host.example/v1/me", { env, key: p.key })).status).toBe(200);
  });
});
