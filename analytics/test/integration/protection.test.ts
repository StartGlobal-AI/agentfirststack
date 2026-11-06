import { ATTACK_COOLDOWN_MS } from "@afs/shared";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { siteStub } from "../../src/service/context";
import { forgetOverShare } from "../../src/service/ingest";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";
/** A network that carries people's own browsing, and a data centre (Amazon AWS). */
const RESIDENTIAL = { country: "US", asn: "7922", "as-org": "Comcast" };
const AWS = { country: "US", asn: "16509", "as-org": "Amazon.com" };

type Init = RequestInit & { key?: string; json?: unknown };
type Over = Record<string, unknown>;

async function callWith(over: Over, path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const req = new Request(`${B}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...over } as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const NO_SIGNUP_LIMIT = { SIGNUP_LIMITER: undefined };
async function newSite(domain: string, json: Record<string, unknown> = {}) {
  const key = (await callWith(NO_SIGNUP_LIMIT, "/v1/signup", { method: "POST" })).body.api_key as string;
  const created = await callWith({}, "/v1/sites", { method: "POST", key, json: { domain, ...json } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { key, site: created.body.site.id as string, pk: created.body.install.first_party_proxy.proxy_key as string, body: created.body };
}

/** A browser beacon through the first-party proxy: each test visitor has its own IP (and network operator). */
const beacon = (over: Over, pk: string, site: string, ip: string, geo: Record<string, string> = RESIDENTIAL, path = "/") =>
  callWith(over, "/_a/e", {
    method: "POST",
    body: JSON.stringify({ s: site, u: `https://${domainOf.get(site)}${path}` }),
    headers: {
      "user-agent": UA,
      "content-type": "text/plain",
      "x-forwarded-for": ip,
      "x-afs-proxy-key": pk,
      ...Object.fromEntries(Object.entries(geo).map(([k, v]) => [`x-dev-geo-${k}`, v])),
    },
  });
const domainOf = new Map<string, string>();
async function site(domain: string, json: Record<string, unknown> = {}) {
  const s = await newSite(domain, json);
  domainOf.set(s.site, domain);
  return s;
}

const pageviews = async (over: Over, key: string, id: string, debug = "") =>
  (await callWith(over, `/v1/sites/${id}/stats?period=today&metrics=pageviews${debug ? `&debug=${debug}` : ""}`, { key })).body.metrics
    .pageviews as number;

async function tool(over: Over, key: string, name: string, args: Record<string, unknown>) {
  const r = await callWith(over, "/mcp", {
    method: "POST",
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return { isError: !!r.body.result.isError, data: JSON.parse(r.body.result.content[0].text) };
}

describe("attack protection: a network's daily share", () => {
  it("quarantines a network past its share (out of stats and the daily budget), reports it in get_site and usage attacks, and releases or purges on request", async () => {
    const V = { MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY: "3", MAX_EVENTS_PER_SITE_PER_DAY: "6" };
    const { key, site: id, pk } = await site("share.test");
    const flood = [];
    for (let i = 0; i < 5; i++) flood.push((await beacon(V, pk, id, "203.0.113.7", RESIDENTIAL, `/f${i}`)).body);
    // The 4th is quarantined, and the Worker learns the network is past its share: the 5th is shed
    // before the site's rate limiter (counted as a drop), so it can't crowd out other visitors.
    expect(flood.map((b) => b.quarantined ?? b.dropped ?? null)).toEqual([null, null, null, "network_share", "network_over_share"]);
    expect(flood.slice(0, 4).every((b) => b.ok === true && typeof b.v === "string")).toBe(true);
    expect(flood[4]).toEqual({ ok: false, dropped: "network_over_share" });
    // Another network still has the site's budget: the quarantined events didn't use it.
    for (let i = 0; i < 3; i++) expect((await beacon(V, pk, id, `198.51.100.${i + 1}`)).body).toMatchObject({ ok: true });
    expect((await beacon(V, pk, id, "198.51.100.9")).status).toBe(429);

    expect(await pageviews(V, key, id)).toBe(6);
    expect(await pageviews(V, key, id, "include")).toBe(6);
    expect(await pageviews(V, key, id, "quarantined")).toBe(1);
    const rt = (await callWith(V, `/v1/sites/${id}/realtime?debug=quarantined`, { key })).body;
    expect(rt.recent_events.map((e: any) => e.pathname).sort()).toEqual(["/f3"]);
    expect(rt.recent_events.every((e: any) => e.quarantined === true)).toBe(true);

    const got = (await callWith(V, `/v1/sites/${id}`, { key })).body;
    expect(got.site.protection).toBe("auto");
    expect(got.protection).toMatchObject({
      mode: "auto",
      state: "contained",
      quarantined: 1,
      quarantined_today: 1,
      busiest_network_today: 4,
      networks_over_share_today: 1,
    });
    expect(got.data.dropped_last_7d.network_over_share.count).toBe(1);
    expect(got.protection.reasons[0].kind).toBe("network_share");
    expect(got.protection.next_steps[0]).toContain(`GET ${B}/v1/sites/${id}/quarantine`);
    expect(got.limits).toMatchObject({ events_per_network_per_site_per_day: 3, quarantined_events_per_site_per_day: null });
    expect(got.data.protection).toBeUndefined();

    const usage = (await callWith(V, "/v1/usage", { key })).body;
    expect(usage.attacks).toEqual([
      expect.objectContaining({
        service: "analytics",
        resource_id: id,
        resource_label: "share.test",
        state: "contained",
        mode: "auto",
        ended_at: null,
        quarantined: 1,
        reasons: [expect.objectContaining({ kind: "network_share" })],
      }),
    ]);
    const steps = usage.attacks[0].next_steps.join("\n");
    expect(steps).toContain(`GET ${B}/v1/sites/${id}/quarantine`);
    expect(steps).toContain(`POST ${B}/v1/sites/${id}/quarantine/release`);
    expect(steps).toContain('{"protection":"strict"}');
    expect(usage.limits.events_per_network_per_site_per_day).toMatchObject({
      used: 4,
      limit: 3,
      var: "MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY",
    });
    expect(usage.limits.quarantined_events_per_site_per_day).toMatchObject({ used: 1, limit: null });
    expect(usage.limits.quarantined_events_per_site_per_day.drops_data).toBeUndefined();
    expect(usage.limits.events_per_network_per_site_per_day.drops_data).toBeUndefined();
    // MCP get_usage carries the same attacks.
    expect((await tool(V, key, "get_usage", {})).data.attacks[0].resource_id).toBe(id);

    const q = (await callWith(V, `/v1/sites/${id}/quarantine`, { key })).body;
    expect(q).toMatchObject({ site_id: id, quarantined: 1, by_reason: { network_share: 1 }, period: { name: "7d" } });
    expect(q.networks[0]).toMatchObject({ asn: 7922, as_org: "Comcast", events: 1, datacenter: false });
    expect(q.untrusted.pages.map((p: any) => p.pathname).sort()).toEqual(["/f3"]);
    expect(q.protection.state).toBe("contained");

    // Real traffic after all: release it. It counts from now on, over the day's budget (the owner's call).
    const rel = (await callWith(V, `/v1/sites/${id}/quarantine/release`, { method: "POST", key, json: { reason: "network_share" } })).body;
    expect(rel).toMatchObject({ released: 1, more: false });
    expect(rel.next_steps.join(" ")).toContain('{"protection":"off"}');
    expect(await pageviews(V, key, id)).toBe(7);
    expect((await callWith(V, `/v1/sites/${id}`, { key })).body.status.events_today).toBe(7);

    // More of it (another isolate, which hasn't learned the network yet), then deleted at once.
    forgetOverShare();
    const V2 = { ...V, MAX_EVENTS_PER_SITE_PER_DAY: "100" };
    expect((await beacon(V2, pk, id, "203.0.113.7")).body.quarantined).toBe("network_share");
    const pur = (await callWith(V2, `/v1/sites/${id}/quarantine/purge`, { method: "POST", key, json: { period: "today" } })).body;
    expect(pur).toMatchObject({ deleted: { events: 1 }, more: false });
    expect(await pageviews(V2, key, id, "quarantined")).toBe(0);
  });

  it("the site's rate limiter: networks past their share are shed before it (counted), and data-centre traffic has its own share of it", async () => {
    const keys: string[] = [];
    let dcFull = false;
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: !(dcFull && key.startsWith("dc:")) };
      },
    };
    const V = { MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY: "2", INGEST_SITE_LIMITER: limiter };
    const { key, site: id, pk } = await site("shed.test");
    for (let i = 0; i < 3; i++) await beacon(V, pk, id, "203.0.113.20"); // the 3rd is past the share
    keys.length = 0;
    for (let i = 0; i < 5; i++) expect((await beacon(V, pk, id, "203.0.113.20")).body.dropped).toBe("network_over_share");
    expect(keys).toEqual([]); // never reached the site's limiter
    expect((await beacon(V, pk, id, "198.51.100.20")).body.ok).toBe(true);
    expect(keys).toEqual([`site:${id}`]);
    // A data-centre flood uses up its own share: visitors on residential networks still get in.
    dcFull = true;
    expect((await beacon(V, pk, id, "192.0.2.50", AWS)).status).toBe(429);
    expect((await beacon(V, pk, id, "198.51.100.21")).body.ok).toBe(true);
    expect(keys.slice(-2)).toEqual([`dc:${id}`, `site:${id}`]);
    const got = (await callWith(V, `/v1/sites/${id}`, { key })).body;
    expect(got.data.dropped_last_7d.network_over_share.count).toBeGreaterThanOrEqual(1);
  });

  it("past the quarantine's own daily cap events are dropped, and server events are never quarantined", async () => {
    const V = { MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY: "1", MAX_QUARANTINED_EVENTS_PER_SITE_PER_DAY: "1" };
    const { key, site: id, pk } = await site("qcap.test");
    const out = [];
    for (let i = 0; i < 2; i++) out.push((await beacon(V, pk, id, "203.0.113.8")).body);
    forgetOverShare(); // as if the next one reached another isolate, which hasn't learned the network
    for (let i = 0; i < 2; i++) out.push((await beacon(V, pk, id, "203.0.113.8")).body);
    expect(out.map((b) => b.quarantined ?? b.dropped ?? "ok")).toEqual(["ok", "network_share", "quarantine_full", "network_over_share"]);
    const got = (await callWith(V, `/v1/sites/${id}`, { key })).body;
    expect(got.data.dropped_last_7d.quarantine_full.count).toBe(1);
    // A backend's events (API key) are never quarantined, whatever its IP sent from the browser.
    const srv = await callWith(V, `/v1/sites/${id}/events`, {
      method: "POST",
      key,
      json: { events: [1, 2, 3].map(() => ({ name: "signup", ip: "203.0.113.8", user_agent: UA })) },
    });
    expect(srv.body.accepted).toBe(3);
    expect((await callWith(V, `/v1/sites/${id}/quarantine`, { key })).body.quarantined).toBe(1);
  });
});

describe("attack protection: spikes and data-centre traffic", () => {
  it("a spike marks the site under attack: data-centre traffic is quarantined, people's networks aren't, and the cooldown ends it", async () => {
    const V = { SPIKE_MIN_EVENTS: "4" };
    const { key, site: id, pk } = await site("spike.test");
    // Before any spike a data centre is counted like anyone.
    expect((await beacon(V, pk, id, "192.0.2.50", AWS)).body.quarantined).toBeUndefined();
    for (let i = 0; i < 3; i++) await beacon(V, pk, id, `192.0.2.${i + 1}`);
    let got = (await callWith(V, `/v1/sites/${id}`, { key })).body.protection;
    expect(got).toMatchObject({ state: "under_attack", mode: "auto" });
    expect(got.reasons[0]).toMatchObject({ kind: "spike" });

    expect((await beacon(V, pk, id, "192.0.2.51", AWS)).body.quarantined).toBe("datacenter");
    expect((await beacon(V, pk, id, "192.0.2.9", RESIDENTIAL)).body.quarantined).toBeUndefined();
    const m = await tool(V, key, "get_site", { site_id: id });
    expect(m.data.protection.reasons.map((r: any) => r.kind)).toEqual(["spike", "datacenter"]);
    expect(m.data.protection.quarantined).toBe(1);
    const q = await tool(V, key, "get_quarantine", { site_id: id, reason: "datacenter" });
    expect(q.data).toMatchObject({ quarantined: 1, by_reason: { datacenter: 1 } });
    expect(q.data.networks[0]).toMatchObject({ asn: 16509, datacenter: true });
    const usage = (await callWith(V, "/v1/usage", { key })).body;
    expect(usage.attacks[0]).toMatchObject({ resource_id: id, state: "under_attack", quarantined: 1 });

    // An hour after the last trigger (and a quiet window), the episode ends; data centres count again.
    await runInDurableObject(siteStub(env, id) as unknown as DurableObjectStub, (instance) => {
      const g = (instance as any).guard;
      g.p.episode.since -= ATTACK_COOLDOWN_MS + 2000;
      g.p.episode.last_seen_at = Date.now() - ATTACK_COOLDOWN_MS - 1000;
      g.window = { start: 0, count: 0 };
    });
    expect((await beacon(V, pk, id, "192.0.2.52", AWS)).body.quarantined).toBeUndefined();
    got = (await callWith(V, `/v1/sites/${id}`, { key })).body.protection;
    expect(got.state).toBe("ended");
    expect(got.ended_at).toBeGreaterThan(got.since);
    const after = (await callWith(V, "/v1/usage", { key })).body.attacks;
    expect(after[0]).toMatchObject({ state: "ended", ended_at: got.ended_at });
  });

  it("protection strict always quarantines data-centre traffic; off quarantines nothing; bad values get a hint", async () => {
    const { key, site: id, pk, body } = await site("strict.test", { protection: "strict" });
    expect(body.site.protection).toBe("strict");
    expect((await beacon({}, pk, id, "192.0.2.60", AWS)).body.quarantined).toBe("datacenter");
    expect((await beacon({}, pk, id, "192.0.2.61", RESIDENTIAL)).body.quarantined).toBeUndefined();
    const rel = await tool({}, key, "release_quarantine", { site_id: id });
    expect(rel.data.released).toBe(1);

    const V = { MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY: "1" };
    const off = await callWith({}, `/v1/sites/${id}`, { method: "PATCH", key, json: { protection: "off" } });
    expect(off.body.site.protection).toBe("off");
    for (let i = 0; i < 3; i++) expect((await beacon(V, pk, id, "192.0.2.62", AWS)).body.quarantined).toBeUndefined();
    const p = (await callWith(V, `/v1/sites/${id}`, { key })).body.protection;
    expect(p).toMatchObject({ mode: "off", state: "contained", quarantined: 0 });
    expect(p.reasons[0].detail).toContain("protection is off");
    expect(p.next_steps.join(" ")).toContain('{"protection":"auto"}');

    const bad = await callWith({}, `/v1/sites/${id}`, { method: "PATCH", key, json: { protection: "max" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.error)).toContain('protection must be \\"auto\\", \\"strict\\" or \\"off\\"');
    expect(bad.body.error.hint).toBeTruthy();
    const badReason = await callWith({}, `/v1/sites/${id}/quarantine?reason=bots`, { key });
    expect(badReason.status).toBe(400);

    // Read keys can look at the quarantine, not change it.
    const ro = (await callWith({}, "/v1/keys", { method: "POST", key, json: { name: "ro", scope: "read" } })).body.api_key as string;
    expect((await callWith({}, `/v1/sites/${id}/quarantine`, { key: ro })).status).toBe(200);
    expect((await callWith({}, `/v1/sites/${id}/quarantine/purge`, { method: "POST", key: ro, json: {} })).status).toBe(403);
    const list = await callWith({}, "/mcp", {
      method: "POST",
      key: ro,
      headers: { accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("get_quarantine");
    expect(names).not.toContain("release_quarantine");
    expect(names).not.toContain("purge_quarantine");
  });

  it("llms.txt documents attack protection, its routes, tools and vars", async () => {
    const llms = (await callWith({}, "/llms.txt")).body as string;
    for (const s of [
      "### Attack protection",
      "| GET | /v1/sites/:id/quarantine",
      "/quarantine/release",
      "/quarantine/purge",
      "get_quarantine",
      "release_quarantine",
      "purge_quarantine",
      "MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY",
      "MAX_QUARANTINED_EVENTS_PER_SITE_PER_DAY",
      "SPIKE_MIN_EVENTS",
      "debug=quarantined",
      "attacks",
    ])
      expect(llms).toContain(s);
  });
});
