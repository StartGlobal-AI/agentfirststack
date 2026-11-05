import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { createDestination } from "../../src/service/destinations";
import { recipeInput } from "../../src/service/recipe";
import { applyRecipe } from "../../src/service/setup";
import { listVersions, publish, putDraft } from "../../src/service/versions";

const B = "https://tags.test";
const granted = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" };
const UA = "Mozilla/5.0 Chrome/130";

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** Outbound deliveries (webhook + analytics app) happen in this isolate: capture them. */
type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://hooks.test/") || url.startsWith("https://analytics.test/")) {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

/** One account for the whole file: signup is rate limited (SIGNUP_LIMITER, 5/min) even in tests. */
let shared: Promise<{
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  accountId: string;
  key: string;
}> | null = null;
function account() {
  shared ??= signup();
  return shared;
}

async function signup() {
  const signup = await json(await SELF.fetch(`${B}/v1/signup`, { method: "POST" }));
  expect(signup.api_key).toBeTruthy();
  const H = { authorization: `Bearer ${signup.api_key}`, "content-type": "application/json" };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await SELF.fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await json(res) };
  };
  return { api, accountId: signup.account_id as string, key: signup.api_key as string };
}

const purchaseDraft = {
  triggers: [{ id: "p", type: "custom_event", event: "purchase" }],
  conversions: [{ name: "purchase", trigger: "p", currency: "USD", send_to: { analytics: { event_name: "purchase" } }, server: true }],
};

/** Container on `domain` with a webhook + analytics destination and a published purchase conversion. */
async function liveContainer(domain: string) {
  const a = await account();
  const C = (await a.api("POST", "/v1/containers", { domain })).body.container.id as string;
  expect(
    (
      await a.api("POST", `/v1/containers/${C}/destinations`, {
        type: "webhook",
        credentials: { url: `https://hooks.test/${domain}`, secret: "integration-secret-123" },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await a.api("POST", `/v1/containers/${C}/destinations`, {
        type: "analytics",
        credentials: { site_id: "site_abc123", api_key: "afs_xxxxxxxx", base_url: "https://analytics.test" },
      })
    ).status,
  ).toBe(201);
  expect((await a.api("PUT", `/v1/containers/${C}/draft`, purchaseDraft)).body.validation.valid).toBe(true);
  expect((await a.api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);
  const hit = (body: object, headers: Record<string, string> = {}) =>
    SELF.fetch(`${B}/collect`, {
      method: "POST",
      headers: { origin: `https://${domain}`, "user-agent": UA, ...headers },
      body: JSON.stringify({ container_id: C, consent: granted, ...body }),
    });
  return { ...a, C, hit };
}

async function settled(api: Awaited<ReturnType<typeof signup>>["api"], C: string, n: number) {
  let events: { event_id: string; source: string; value: number; status: string; destinations: { type: string; status: string }[] }[] = [];
  for (let i = 0; i < 60; i++) {
    events = (await api("GET", `/v1/containers/${C}/events?limit=200`)).body.events;
    if (events.length >= n && events.every((e) => e.destinations.every((d) => d.status !== "queued" && d.status !== "retrying"))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return events;
}

describe("finding 1: browser hits can't suppress, replace or re-attribute server events", () => {
  it("a forged /collect conversion with a guessed order id doesn't drop, hijack or re-attribute the backend's", async () => {
    const t = await liveContainer("forge.test");
    // The real buyer landed from an ad; the attacker has their own click id.
    expect((await t.hit({ type: "visit", visitor_id: "real_visitor_1", click_ids: { gclid: "REAL-GCLID-1" } })).status).toBe(200);
    // Forged purchase: guessable order id, inflated value, claims every browser tag fired.
    const forged = await json(
      await t.hit({
        type: "conversion",
        event_id: "forged_evt_1",
        name: "purchase",
        transaction_id: "ORDER-1001",
        value: 99999,
        currency: "USD",
        visitor_id: "attacker_vis_1",
        click_ids: { gclid: "ATTACKER-GCLID" },
        fired: ["analytics", "ga4"],
      }),
    );
    expect(forged.destinations).toEqual([
      { type: "webhook", status: "queued" },
      { type: "analytics", status: "skipped", reason: expect.stringContaining("already sent") }, // its own copy only
    ]);
    const forged2 = await json(
      await t.hit({
        type: "conversion",
        event_id: "forged_evt_2",
        name: "purchase",
        transaction_id: "ORDER-1002",
        value: 77777,
        currency: "USD",
        visitor_id: "attacker_vis_1",
      }),
    );
    expect(forged2.ok).toBe(true);

    // The backend reports both orders.
    const srv = (
      await t.api("POST", `/v1/containers/${t.C}/events`, {
        events: [
          { name: "purchase", order_id: "ORDER-1001", value: 49, currency: "USD", visitor_id: "real_visitor_1" },
          { name: "purchase", order_id: "ORDER-1002", value: 10, currency: "USD" }, // no identity: must NOT join the forged hit's visitor
        ],
      })
    ).body;
    expect(srv.accepted).toBe(2);
    expect(srv.results[0]).toMatchObject({
      status: "accepted",
      event_id: "purchase.ORDER-1001",
      joined: { by: "visitor_id", visitor_id: "real_visitor_1", click_ids: ["gclid"] },
    });
    expect(srv.results[0].destinations.map((d: { type: string; status: string }) => `${d.type}:${d.status}`)).toEqual([
      "webhook:queued",
      "analytics:queued",
    ]);
    expect(srv.results[1]).toMatchObject({
      status: "accepted",
      event_id: "purchase.ORDER-1002",
      joined: { by: null, visitor_id: null, click_ids: [] },
    });

    // A retry of the backend event is the only thing that dedupes it.
    const retry = (
      await t.api("POST", `/v1/containers/${t.C}/events`, {
        events: [{ name: "purchase", order_id: "ORDER-1001", value: 49, currency: "USD" }],
      })
    ).body;
    expect(retry.results[0]).toMatchObject({ status: "duplicate", event_id: "purchase.ORDER-1001" });

    const events = await settled(t.api, t.C, 4);
    const row = (id: string, source: string) => events.find((e) => e.event_id === id && e.source === source)!;
    expect(row("forged_evt_1", "browser")).toMatchObject({ value: 99999 }); // logged as it came, untouched
    expect(row("purchase.ORDER-1001", "server")).toMatchObject({ value: 49, status: "delivered" });
    expect(row("purchase.ORDER-1002", "server")).toMatchObject({ value: 10, status: "delivered" });

    // What the destinations received for the real orders: the backend's values and identity only.
    const serverHooks = sent.filter(
      (s) => s.url.startsWith("https://hooks.test/") && (s.body.event as { source: string }).source === "server",
    );
    const byOrder = Object.fromEntries(
      serverHooks.map((s) => [
        (s.body.event as { transaction_id: string }).transaction_id,
        s.body.event as { value: number; click_ids: Record<string, string>; event_id: string },
      ]),
    );
    expect(byOrder["ORDER-1001"]).toMatchObject({ value: 49, event_id: "purchase.ORDER-1001", click_ids: { gclid: "REAL-GCLID-1" } });
    expect(byOrder["ORDER-1002"]).toMatchObject({ value: 10 });
    expect(byOrder["ORDER-1002"]!.click_ids).toEqual({}); // not the attacker's ATTACKER-GCLID
    const analytics = sent.filter((s) => s.url.startsWith("https://analytics.test/"));
    expect(analytics.map((s) => (s.body.events as { revenue?: { amount: number } }[])[0]!.revenue?.amount).sort()).toEqual(
      [10, 49, 77777].sort(),
    );
  });

  it("server events are the source of truth: a later browser hit for the same order isn't sent server-side again", async () => {
    const t = await liveContainer("truth.test");
    expect(
      (
        await t.api("POST", `/v1/containers/${t.C}/events`, {
          events: [{ name: "purchase", order_id: "ORDER-7", value: 30, currency: "USD" }],
        })
      ).body.accepted,
    ).toBe(1);
    const late = await json(
      await t.hit({
        type: "conversion",
        event_id: "browser_evt_7",
        name: "purchase",
        transaction_id: "ORDER-7",
        value: 30,
        currency: "USD",
      }),
    );
    expect(late.destinations).toEqual([]);
    expect(late.note).toMatch(/already sent this conversion server-side/);
    // Same event_id from browser and backend: two rows, the backend one still delivered (platforms pair them by event_id).
    const b = await json(await t.hit({ type: "conversion", event_id: "shared_evt_8", name: "purchase", value: 5, currency: "USD" }));
    expect(b.destinations.length).toBe(2);
    const s = (
      await t.api("POST", `/v1/containers/${t.C}/events`, {
        events: [{ name: "purchase", event_id: "shared_evt_8", value: 5, currency: "USD" }],
      })
    ).body;
    expect(s.results[0]).toMatchObject({ status: "accepted", event_id: "shared_evt_8" });
    const events = await settled(t.api, t.C, 4);
    expect(
      events
        .filter((e) => e.event_id === "shared_evt_8")
        .map((e) => e.source)
        .sort(),
    ).toEqual(["browser", "server"]);
  });
});

describe("event log schema upgrade (objects created by older code)", () => {
  it("re-keys v1 rows by (source, event_id); merged browser+server rows become server rows", async () => {
    const stub = (env as unknown as Bindings).CONTAINER.getByName("ctr_schemaupgrade0001");
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
          ts INTEGER NOT NULL, received_at INTEGER NOT NULL, visitor_id TEXT, transaction_id TEXT, value REAL, currency TEXT,
          preview INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, data TEXT NOT NULL, results TEXT NOT NULL DEFAULT '{}', note TEXT);
        CREATE INDEX events_txn ON events(transaction_id);`);
      sql.exec(
        "INSERT INTO meta (k, v) VALUES ('container', ?)",
        JSON.stringify({ id: "ctr_schemaupgrade0001", account_id: "acc_x", domain: "up.test", allowed_hostnames: [], live_version: null }),
      );
      const now = Date.now();
      for (const [id, source] of [
        ["e1", "browser"],
        ["e2", "server"],
        ["e3", "browser+server"],
      ]) {
        sql.exec(
          "INSERT INTO events (event_id, type, name, source, ts, received_at, status, data) VALUES (?, 'conversion', 'purchase', ?, ?, ?, 'logged', '{}')",
          id,
          source,
          now,
          now,
        );
      }
      // What the constructor does for an object that already has tables.
      const i = instance as unknown as { ready: boolean; migrate(): void };
      i.ready = true;
      i.migrate();
      i.migrate(); // idempotent
      expect(sql.exec("SELECT event_id, source FROM events ORDER BY event_id").toArray()).toEqual([
        { event_id: "e1", source: "browser" },
        { event_id: "e2", source: "server" },
        { event_id: "e3", source: "server" },
      ]);
      const pk = sql.exec("SELECT name, pk FROM pragma_table_info('events') WHERE pk > 0 ORDER BY pk").toArray();
      expect(pk).toEqual([
        { name: "source", pk: 1 },
        { name: "event_id", pk: 2 },
      ]);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'events_v1'").toArray()).toEqual([]);
      expect(
        sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name LIKE 'events_%' ORDER BY name")
          .toArray()
          .map((r) => r.name),
      ).toEqual(["events_name", "events_received", "events_txn"]);
      // Same id from both origins now coexists.
      sql.exec(
        "INSERT INTO events (event_id, type, name, source, ts, received_at, status, data) VALUES ('e1', 'conversion', 'purchase', 'server', 1, 1, 'logged', '{}')",
      );
    });
  });
});

describe("finding 6: concurrent copies of one event are delivered once", () => {
  it("identical /collect beacons and backend retries race; exactly one is accepted and queued", async () => {
    const t = await liveContainer("race.test");
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.hit({ type: "conversion", event_id: "race_evt_1", name: "purchase", value: 1, currency: "USD" }).then(json),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(5);
    const srv = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.api("POST", `/v1/containers/${t.C}/events`, { events: [{ name: "purchase", order_id: "RACE-1", value: 2, currency: "USD" }] }),
      ),
    );
    expect(srv.map((r) => r.body.results[0].status).sort()).toEqual(["accepted", "duplicate", "duplicate", "duplicate"]);
    await settled(t.api, t.C, 2);
    const hooks = sent.filter((s) => s.url.startsWith("https://hooks.test/"));
    expect(hooks.filter((h) => (h.body.event as { event_id: string }).event_id === "race_evt_1")).toHaveLength(1);
    expect(hooks.filter((h) => (h.body.event as { event_id: string }).event_id === "purchase.RACE-1")).toHaveLength(1);
  });
});

describe("finding 4: /collect can't create Durable Objects", () => {
  const tables = (id: string) =>
    runInDurableObject((env as unknown as Bindings).CONTAINER.getByName(id), async (_i, state) => ({
      tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().length,
      alarm: await state.storage.getAlarm(),
    }));

  it("an unknown well-formed container id answers 404 and writes no storage", async () => {
    const id = "ctr_neverexisted0001";
    const res = await SELF.fetch(`${B}/collect`, {
      method: "POST",
      headers: { origin: "https://x.test", "user-agent": UA },
      body: JSON.stringify({ container_id: id, type: "conversion", name: "purchase", event_id: "evt_orphan_1", value: 5 }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
    expect(await tables(id)).toEqual({ tables: 0, alarm: null });
  });

  it("storage left by older code for an unknown id is deleted on the next hit", async () => {
    const id = "ctr_legacyorphan0001";
    await runInDurableObject((env as unknown as Bindings).CONTAINER.getByName(id), async (_i, state) => {
      state.storage.sql.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE events (event_id TEXT PRIMARY KEY)");
    });
    expect((await tables(id)).tables).toBe(2);
    const res = await SELF.fetch(`${B}/collect`, {
      method: "POST",
      headers: { origin: "https://x.test", "user-agent": UA },
      body: JSON.stringify({ container_id: id, type: "visit" }),
    });
    expect(res.status).toBe(404);
    expect((await tables(id)).tables).toBe(0);
  });

  it("a container created through the API is initialised and accepts hits", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "init.test" })).body.container.id as string;
    expect((await tables(C)).tables).toBeGreaterThan(0);
    const res = await SELF.fetch(`${B}/collect`, {
      method: "POST",
      headers: { origin: "https://init.test", "user-agent": UA },
      body: JSON.stringify({ container_id: C, type: "visit", visitor_id: "vis_init_1", consent: granted }),
    });
    expect(res.status).toBe(200);
  });
});

describe("the proxy key is only printed when the proxy setup is asked for", () => {
  it("create and plain install leave it out and say how to get it; install?proxy=1 (REST and MCP) returns it to full keys only", async () => {
    const a = await account();
    const created = await a.api("POST", "/v1/containers", { domain: "proxy-quiet.test" });
    expect(created.status).toBe(201);
    const C = created.body.container.id as string;
    const key = (await a.api("GET", `/v1/containers/${C}/install?proxy=1`)).body.first_party_proxy.proxy_key as string;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    // Not in the create answer (nor its retry), nor the plain install guide.
    const again = await a.api("POST", "/v1/containers", { domain: "proxy-quiet.test" });
    for (const body of [created.body, again.body, (await a.api("GET", `/v1/containers/${C}/install`)).body]) {
      expect(JSON.stringify(body)).not.toContain(key);
      expect(body.install?.first_party_proxy ?? body.first_party_proxy).toMatchObject({
        how_to_get: expect.stringContaining(`/v1/containers/${C}/install?proxy=1`),
      });
    }
    expect(created.body.next_steps.join(" ")).toContain("install?proxy=1");
    const mcp = async (k: string, name: string, args: Record<string, unknown>) =>
      JSON.stringify(
        await json(
          await SELF.fetch(`${B}/mcp`, {
            method: "POST",
            headers: { authorization: `Bearer ${k}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
          }),
        ),
      );
    expect(await mcp(a.key, "get_install_instructions", { container_id: C })).not.toContain(key);
    expect(await mcp(a.key, "create_container", { domain: "proxy-quiet.test" })).not.toContain(key);
    expect(await mcp(a.key, "get_install_instructions", { container_id: C, proxy: true })).toContain(key);
    // A read-only key gets the guide, not the key.
    const readKey = (await a.api("POST", "/v1/keys", { scope: "read" })).body.api_key as string;
    const asRead = await SELF.fetch(`${B}/v1/containers/${C}/install?proxy=1`, { headers: { authorization: `Bearer ${readKey}` } });
    expect(asRead.status).toBe(403);
    expect(JSON.stringify(await json(asRead))).not.toContain(key);
    expect((await SELF.fetch(`${B}/v1/containers/${C}/install`, { headers: { authorization: `Bearer ${readKey}` } })).status).toBe(200);
    const readMcp = await mcp(readKey, "get_install_instructions", { container_id: C, proxy: true });
    expect(readMcp).not.toContain(key);
    expect(readMcp).toMatch(/read-only keys can't see/);
  });
});

describe("finding 7: only the container's own proxy may set the visitor IP", () => {
  it("X-Forwarded-For is ignored unless the request carries the container's x-afs-proxy-key", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "proxy.test" })).body.container.id as string;
    const install = (await a.api("GET", `/v1/containers/${C}/install?proxy=1`)).body;
    const key = install.first_party_proxy.proxy_key as string;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(install.first_party_proxy.cloudflare_worker).toContain(`h.set("x-afs-proxy-key", "${key}")`);
    expect(install.snippet).not.toContain(key);
    const otherId = (await a.api("POST", "/v1/containers", { domain: "other-proxy.test" })).body.container.id as string;
    const otherKey = (await a.api("GET", `/v1/containers/${otherId}/install?proxy=1`)).body.first_party_proxy.proxy_key as string;
    expect(otherKey).toMatch(/^[a-f0-9]{64}$/);
    expect(otherKey).not.toBe(key);

    const visit = (vid: string, headers: Record<string, string>) =>
      SELF.fetch(`${B}/_t/collect`, {
        method: "POST",
        headers: {
          origin: "https://proxy.test",
          "user-agent": UA,
          "cf-connecting-ip": "203.0.113.5",
          "x-forwarded-for": "198.51.100.77",
          ...headers,
        },
        body: JSON.stringify({ container_id: C, type: "visit", visitor_id: vid, consent: granted, first_party: true }),
      });
    const ipOf = async (vid: string) => (await a.api("GET", `/v1/containers/${C}/visitors/${vid}`)).body.visitor.ip;
    expect((await visit("vis_spoof_1", {})).status).toBe(200); // client-set first_party: true is not enough
    expect(await ipOf("vis_spoof_1")).toBe("203.0.113.5");
    expect((await visit("vis_spoof_2", { "x-afs-proxy-key": otherKey })).status).toBe(200); // another container's key
    expect(await ipOf("vis_spoof_2")).toBe("203.0.113.5");
    expect((await visit("vis_proxy_1", { "x-afs-proxy-key": key })).status).toBe(200);
    expect(await ipOf("vis_proxy_1")).toBe("198.51.100.77");
  });
});

describe("finding 2: storage and fan-out caps", () => {
  it("destinations per container are capped (default 10); an existing one is still returned", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "fanout.test" })).body.container.id as string;
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await a.api("POST", `/v1/containers/${C}/destinations`, {
            type: "webhook",
            credentials: { url: `https://hooks.test/fan/${i}`, secret: "integration-secret-123" },
          })
        ).status,
      ).toBe(201);
    }
    const over = await a.api("POST", `/v1/containers/${C}/destinations`, {
      type: "webhook",
      credentials: { url: "https://hooks.test/fan/10", secret: "integration-secret-123" },
    });
    expect(over.status).toBe(403);
    expect(over.body.error).toMatchObject({ code: "quota_exceeded", hint: expect.stringContaining("DELETE") });
    const again = await a.api("POST", `/v1/containers/${C}/destinations`, {
      type: "webhook",
      credentials: { url: "https://hooks.test/fan/3", secret: "integration-secret-123" },
    });
    expect(again).toMatchObject({ status: 200, body: { existing: true } });
  });

  it("webhooks can't target this deployment", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "loop.test" })).body.container.id as string;
    const r = await a.api("POST", `/v1/containers/${C}/destinations`, {
      type: "webhook",
      credentials: { url: `${B}/collect`, secret: "integration-secret-123" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/this deployment/);
  });

  it("drafts over 512 KB are rejected with 413 and a hint (REST and setup share the check)", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "big.test" })).body.container.id as string;
    const tags = Array.from({ length: 12 }, (_, i) => ({
      id: `h${i}`,
      type: "custom_html",
      params: { html: "x".repeat(49_000) },
      triggers: ["all"],
    }));
    const r = await a.api("PUT", `/v1/containers/${C}/draft`, { triggers: [{ id: "all", type: "page_view" }], tags });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatchObject({ code: "draft_too_large", hint: expect.stringContaining("custom_html") });
    expect(
      (await a.api("PUT", `/v1/containers/${C}/draft`, { triggers: [{ id: "all", type: "page_view" }], tags: tags.slice(0, 2) })).status,
    ).toBe(200);
  });

  it("publish keeps only the newest MAX_VERSIONS_PER_CONTAINER versions", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "versions.test" })).body.container.id as string;
    const small = { ...(env as unknown as Bindings), MAX_VERSIONS_PER_CONTAINER: "2" } as Bindings;
    for (let i = 1; i <= 4; i++) {
      await putDraft(small, a.accountId, C, { ...purchaseDraft, settings: { debug: i % 2 === 0 } });
      expect((await publish(small, a.accountId, C, { origins: [] })).version).toBe(i);
    }
    const v = await listVersions(small, a.accountId, C);
    expect(v.max_versions).toBe(2);
    expect(v.versions.map((x) => [x.version, x.live])).toEqual([
      [4, true],
      [3, false],
    ]);
    expect((await a.api("GET", `/v1/containers/${C}/versions/1`)).status).toBe(404);
    // Rollback still works within what's kept; the default (50) applies over REST.
    expect((await a.api("POST", `/v1/containers/${C}/rollback`, { version: 3 })).status).toBe(200);
    expect((await a.api("GET", `/v1/containers/${C}/versions`)).body).toMatchObject({ live_version: 3, max_versions: 50 });
  });
});

describe("renames and scopes", () => {
  it("serves __AFST__ with an x-afs-version header; read keys don't get scan_site", async () => {
    const t = await liveContainer("rename.test");
    const js = await SELF.fetch(`${B}/c/${t.C}.js`);
    expect(js.headers.get("x-afs-version")).toBe("1");
    expect(js.headers.get("x-sgt-version")).toBeNull();
    const text = await js.text();
    expect(text).toContain("var __AFST__=");
    expect(text).not.toContain("__SGT__");
    const prv = (await t.api("POST", `/v1/containers/${t.C}/preview`, {})).body;
    expect(prv.preview_url).toContain("?afst_preview=prv_");

    const readKey = (await t.api("POST", "/v1/keys", { scope: "read" })).body.api_key as string;
    const tools = async (k: string) =>
      (
        await json(
          await SELF.fetch(`${B}/mcp`, {
            method: "POST",
            headers: { authorization: `Bearer ${k}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          }),
        )
      ).result.tools.map((x: { name: string }) => x.name) as string[];
    expect(await tools(t.key)).toContain("scan_site");
    expect(await tools(readKey)).not.toContain("scan_site");
    // REST agrees: a read key can't scan.
    const scan = await SELF.fetch(`${B}/v1/containers/${t.C}/scan`, {
      method: "POST",
      headers: { authorization: `Bearer ${readKey}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(scan.status).toBe(403);
  });
});

// ---------------------------------------------------------------- analytics over the ANALYTICS binding

/** The analytics stand-in behind env.ANALYTICS (vitest.config.ts): register a site for an account, read what reached it. */
const analyticsApi = (env as unknown as { ANALYTICS: Fetcher }).ANALYTICS;
const ownSite = (site: string, account: string) =>
  analyticsApi.fetch(`https://analytics.internal/__test/sites/${site}`, { method: "PUT", headers: { "x-afs-account": account } });
const analyticsRequests = async () =>
  (
    (await (await analyticsApi.fetch("https://analytics.internal/__test/requests")).json()) as {
      requests: {
        method: string;
        url: string;
        account: string | null;
        auth: boolean;
        body: { events?: Record<string, unknown>[] } | null;
      }[];
    }
  ).requests;
const GAPS = ["no_route", "no_platforms", "no_destinations", "server_without_destination"];

describe("setup delivers to analytics without an API key over the ANALYTICS binding", () => {
  it("site_id alone: a service-binding destination, server: true, ready; events reach analytics as the container's account", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "binding.test" })).body.container.id as string;
    await ownSite("site_bindingown001", a.accountId);
    const setup = await a.api("POST", `/v1/containers/${C}/setup`, {
      platforms: { analytics: { site_id: "site_bindingown001" } },
      conversions: [
        { name: "purchase", when: { data_layer_event: "purchase" }, value: 10, currency: "USD" },
        { name: "sign_up", when: { data_layer_event: "sign_up" } },
      ],
      consent: "none",
    });
    expect(setup.status).toBe(200);
    expect(setup.body.destination_errors).toEqual([]);
    expect(setup.body.destinations).toEqual([
      expect.objectContaining({
        type: "analytics",
        credentials: { configured: true, site_id: "site_bindingown001", delivery: "service_binding" },
      }),
    ]);
    expect(setup.body.draft.conversions.map((c: { server: boolean }) => c.server)).toEqual([true, true]);
    expect(setup.body.validation.warnings.filter((w: { code: string }) => GAPS.includes(w.code))).toEqual([]);
    expect(setup.body.missing).toEqual([]);
    expect(setup.body.ready_to_publish).toBe(true);
    expect((await a.api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);

    const hit = await SELF.fetch(`${B}/collect`, {
      method: "POST",
      headers: { origin: "https://binding.test", "user-agent": UA },
      body: JSON.stringify({
        container_id: C,
        type: "conversion",
        event_id: "bind_evt_1",
        name: "purchase",
        value: 10,
        currency: "USD",
        consent: granted,
      }),
    });
    expect((await json(hit)).destinations).toEqual([{ type: "analytics", status: "queued" }]);
    const [ev] = await settled(a.api, C, 1);
    expect(ev!.destinations[0]).toMatchObject({ type: "analytics", status: "delivered" });
    const posted = (await analyticsRequests()).filter((r) => r.method === "POST" && r.url.endsWith("/v1/sites/site_bindingown001/events"));
    expect(posted).toHaveLength(1);
    // Internal auth as the container's own account; no API key anywhere.
    expect(posted[0]).toMatchObject({
      url: "https://analytics.internal/v1/sites/site_bindingown001/events",
      account: a.accountId,
      auth: false,
    });
    expect(posted[0]!.body!.events![0]).toMatchObject({ name: "purchase", props: expect.objectContaining({ event_id: "bind_evt_1" }) });
  });

  it("another account's site_id is refused: at creation (REST and setup), and at delivery if it changes hands", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "binding-other.test" })).body.container.id as string;
    await ownSite("site_someoneelse01", "acct_someoneelse01");
    const add = await a.api("POST", `/v1/containers/${C}/destinations`, {
      type: "analytics",
      credentials: { site_id: "site_someoneelse01" },
    });
    expect(add.status).toBe(400);
    expect(add.body.error).toMatchObject({ code: "analytics_site_not_found", hint: expect.stringMatching(/same account/) });
    const setup = await a.api("POST", `/v1/containers/${C}/setup`, {
      platforms: { analytics: { site_id: "site_someoneelse01" } },
      conversions: [{ name: "purchase", when: { data_layer_event: "purchase" } }],
      consent: "none",
    });
    expect(setup.body.destinations).toEqual([]);
    expect(setup.body.destination_errors).toEqual([
      { type: "analytics", error: expect.objectContaining({ code: "analytics_site_not_found" }) },
    ]);
    // Nothing would receive it server-side, so setup leaves it browser-only and says why.
    expect(setup.body.draft.conversions[0].server).toBe(false);
    expect(setup.body.notes.join(" ")).toMatch(/server: false on "purchase".*analytics destination couldn't be created/);
    expect(setup.body.validation.warnings.filter((w: { code: string }) => GAPS.includes(w.code))).toEqual([]);
    expect((await a.api("GET", `/v1/containers/${C}/destinations`)).body.destinations).toEqual([]);

    // A site of this account is accepted; if analytics later says it isn't (another account), delivery fails, not retried.
    await ownSite("site_changeshands1", a.accountId);
    const ok = await a.api("POST", `/v1/containers/${C}/destinations`, {
      type: "analytics",
      credentials: { site_id: "site_changeshands1" },
    });
    expect(ok.status).toBe(201);
    await ownSite("site_changeshands1", "acct_someoneelse01");
    const srv = await a.api("POST", `/v1/containers/${C}/events`, {
      events: [{ name: "purchase", order_id: "HANDS-1", value: 1, currency: "USD" }],
    });
    expect(srv.body.results[0].destinations).toEqual([{ destination_id: ok.body.destination.id, type: "analytics", status: "queued" }]);
    const [ev] = await settled(a.api, C, 1);
    expect(ev!.destinations[0]).toMatchObject({ status: "failed", http_status: 404, attempts: 1 });
  });

  it("no binding and no api_key: no server: true, the reason in notes, api_key in missing, and no delivery warnings", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "nobinding.test" })).body.container.id as string;
    const noBinding = { ...(env as unknown as Bindings), ANALYTICS: undefined } as unknown as Bindings;
    const r = await applyRecipe(
      noBinding,
      { accountId: a.accountId, keyId: "test", scopes: ["*"] },
      C,
      recipeInput.parse({
        platforms: { analytics: { site_id: "site_nobinding0001" } },
        conversions: Array.from({ length: 20 }, (_, i) => ({ name: `conv_${i}`, when: { data_layer_event: `conv_${i}` } })),
        consent: "none",
      }),
    );
    expect(r.destinations).toEqual([]);
    expect(r.draft.conversions!.every((c) => c.server === false)).toBe(true);
    expect(r.notes.join(" ")).toMatch(/no ANALYTICS service binding/);
    expect(r.missing).toEqual([expect.objectContaining({ platform: "analytics", field: "api_key" })]);
    expect(r.validation.warnings.filter((w) => GAPS.includes(w.code))).toEqual([]);
    expect(r.ready_to_publish).toBe(true);
    // Creating such a destination directly says what's needed.
    const add = await (async () => {
      try {
        await createDestination(noBinding, a.accountId, C, { type: "analytics", credentials: { site_id: "site_nobinding0001" } });
      } catch (e) {
        return (e as { toJSON(): { error: { message: string } } }).toJSON().error;
      }
    })();
    expect(add?.message).toMatch(/api_key is required here: this deployment has no ANALYTICS service binding/);
  });

  it("an explicit server: true that nothing receives isn't ready: the gap is listed in missing", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "gap.test" })).body.container.id as string;
    const setup = await a.api("POST", `/v1/containers/${C}/setup`, {
      platforms: { ga4: { measurement_id: "G-ABC123XYZ" } },
      conversions: [{ name: "purchase", when: { data_layer_event: "purchase" }, value: 5, currency: "USD", server: true }],
      consent: "none",
    });
    expect(setup.body.validation.valid).toBe(true);
    expect(setup.body.draft.conversions[0].server).toBe(true);
    expect(setup.body.ready_to_publish).toBe(false);
    // The ga4 gap is said once, by the missing api_secret; the container-wide gap is listed too.
    const missing = setup.body.missing as { platform: string; field: string; impact: string }[];
    expect(missing.map((m) => `${m.platform}.${m.field}`).sort()).toEqual(["ga4.api_secret", "server.destination"]);
    expect(missing.find((m) => m.platform === "server")!.impact).toMatch(
      /"purchase" has server: true, but the container has no destinations/,
    );
    expect(setup.body.next_steps.join(" ")).toMatch(/Not ready: some conversions won't reach a platform/);
  });
});

// ---------------------------------------------------------------- what the event log keeps

describe("the event log keeps no raw IP, user agent, city or postal code", () => {
  const LONG_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const denied = { ad_storage: "denied", analytics_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };
  const cf = { country: "DE", region: "Brandenburg", regionCode: "BB", city: "Potsdam", postalCode: "14467" };
  const raw = ["198.51.100.23", LONG_UA, "Potsdam", "14467"];

  it("consent denied, server: false, no destinations: only the /24, country and region are logged", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "pii-log.test" })).body.container.id as string;
    const draft = {
      triggers: [{ id: "p", type: "custom_event", event: "lead" }],
      tags: [{ id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["p"] }],
      conversions: [{ name: "lead", trigger: "p", send_to: { ga4: { event_name: "generate_lead" } }, server: false }],
    };
    expect((await a.api("PUT", `/v1/containers/${C}/draft`, draft)).body.validation.valid).toBe(true);
    expect((await a.api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);
    const res = await SELF.fetch(`${B}/collect`, {
      method: "POST",
      headers: { origin: "https://pii-log.test", "user-agent": LONG_UA, "cf-connecting-ip": "198.51.100.23" },
      body: JSON.stringify({ container_id: C, type: "conversion", event_id: "pii_evt_1", name: "lead", consent: denied }),
      cf,
    } as RequestInit);
    expect(res.status).toBe(200);
    const [ev] = (await a.api("GET", `/v1/containers/${C}/events?verbose=true`)).body.events;
    const text = JSON.stringify(ev);
    for (const v of raw) expect(text).not.toContain(v);
    expect(ev.untrusted.data).toMatchObject({
      ip_network: "198.51.100.0/24",
      geo: { country: "DE", region: "Brandenburg", region_code: "BB" },
    });
    expect(ev.untrusted.data.ip).toBeUndefined();
    expect(ev.untrusted.data.user_agent).toBeUndefined();
    // The identity summary still says what the event carried.
    expect(ev.identity).toMatchObject({ ip: true, user_agent: true, country: "DE" });
    // Dedupe is unaffected.
    const again = await SELF.fetch(`${B}/collect`, {
      method: "POST",
      headers: { origin: "https://pii-log.test", "user-agent": LONG_UA, "cf-connecting-ip": "198.51.100.23" },
      body: JSON.stringify({ container_id: C, type: "conversion", event_id: "pii_evt_1", name: "lead", consent: denied }),
    });
    expect((await json(again)).duplicate).toBe(true);
  });

  it("a destination still gets the raw IP and user agent (also through a visitor join); the logged request doesn't", async () => {
    const t = await liveContainer("pii-deliver.test");
    const ip = { "cf-connecting-ip": "203.0.113.77", "user-agent": LONG_UA };
    expect((await t.hit({ type: "visit", visitor_id: "vis_pii_1" }, ip)).status).toBe(200);
    expect((await t.hit({ type: "conversion", event_id: "pii_evt_2", name: "purchase", visitor_id: "vis_pii_1" }, ip)).status).toBe(200);
    // A backend event joined by visitor_id inherits the visitor's IP and user agent for delivery.
    const srv = await t.api("POST", `/v1/containers/${t.C}/events`, {
      events: [{ name: "purchase", order_id: "PII-1", value: 3, currency: "USD", visitor_id: "vis_pii_1" }],
    });
    expect(srv.body.results[0]).toMatchObject({ status: "accepted", joined: { by: "visitor_id" } });
    const events = await settled(t.api, t.C, 2);
    const hooks = sent.filter((s) => s.url === "https://hooks.test/pii-deliver.test").map((h) => h.body.event as Record<string, unknown>);
    expect(hooks.map((e) => [e.event_id, e.ip, e.user_agent])).toEqual(
      expect.arrayContaining([
        ["pii_evt_2", "203.0.113.77", LONG_UA],
        ["purchase.PII-1", "203.0.113.77", LONG_UA],
      ]),
    );
    const log = (await t.api("GET", `/v1/containers/${t.C}/events?verbose=true`)).body.events as { destinations: unknown[] }[];
    expect(events.every((e) => e.destinations.every((d) => d.status === "delivered"))).toBe(true);
    const text = JSON.stringify(log);
    expect(text).not.toContain("203.0.113.77");
    expect(text).not.toContain(LONG_UA);
    expect(text).toContain("203.0.113.0/24");
    expect(text).toContain("(user agent not kept)");
  });

  it("rows written by older code lose their raw fields and logged requests on upgrade", async () => {
    const stub = (env as unknown as Bindings).CONTAINER.getByName("ctr_piiupgrade000001");
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      const i = instance as unknown as { ready: boolean; migrate(): void; scrubLegacyEvents(): void };
      i.ready = true;
      i.migrate();
      const data = {
        event_id: "old1",
        ip: "192.0.2.10",
        user_agent: LONG_UA,
        geo: { country: "DE", city: "Potsdam", postal_code: "14467" },
        device: { category: "desktop", model: "Mac" },
        user: {},
        click_ids: {},
      };
      const results = {
        dst_1: { type: "meta", status: "delivered", attempts: 1, request: { body: { client_ip_address: "192.0.2.10" } }, updated_at: 1 },
      };
      sql.exec(
        "INSERT INTO events (event_id, type, name, source, ts, received_at, status, data, results) VALUES ('old1', 'conversion', 'purchase', 'browser', 1, ?, 'delivered', ?, ?)",
        Date.now(),
        JSON.stringify(data),
        JSON.stringify(results),
      );
      i.scrubLegacyEvents();
      const row = sql.exec<{ data: string; results: string }>("SELECT data, results FROM events WHERE event_id = 'old1'").toArray()[0]!;
      expect(JSON.parse(row.data)).toEqual({
        event_id: "old1",
        geo: { country: "DE" },
        device: { category: "desktop" },
        user: {},
        click_ids: {},
      });
      expect(JSON.parse(row.results)).toEqual({ dst_1: { type: "meta", status: "delivered", attempts: 1, updated_at: 1 } });
    });
  });
});

// ---------------------------------------------------------------- test traffic stays test traffic

describe("test and preview traffic never reaches a platform as a real conversion", () => {
  it("Meta without a test_event_code and LinkedIn are skipped; Meta with one gets it; analytics gets debug: true", async () => {
    const platform: { url: string; body: Record<string, unknown> }[] = [];
    const prior = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (/graph\.facebook\.com|api\.linkedin\.com/.test(url)) {
        platform.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response('{"events_received":1}', { status: 200, headers: { "content-type": "application/json" } });
      }
      return prior(input, init);
    });
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "testmode.test" })).body.container.id as string;
    await ownSite("site_testmode00001", a.accountId);
    const add = async (type: string, credentials: Record<string, unknown>) => {
      const r = await a.api("POST", `/v1/containers/${C}/destinations`, { type, credentials });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.destination.id as string;
    };
    const metaCoded = await add("meta", { pixel_id: "1111111111111111", access_token: "meta-test-token-0000", test_event_code: "TEST123" });
    const metaBare = await add("meta", { pixel_id: "2222222222222222", access_token: "meta-test-token-0000" });
    const linkedin = await add("linkedin", { ad_account_id: "512345678", access_token: "linkedin-test-token-0000" });
    const analytics = await add("analytics", { site_id: "site_testmode00001" });

    // Destination tests send nothing that would be recorded as real.
    const t1 = await a.api("POST", `/v1/containers/${C}/destinations/${linkedin}/test`, {
      send_to: { linkedin: { conversion_id: "1234567" } },
    });
    expect(t1.status).toBe(400);
    expect(t1.body.error).toMatchObject({ code: "no_test_mode", hint: expect.stringMatching(/no test mode/) });
    const t2 = await a.api("POST", `/v1/containers/${C}/destinations/${metaBare}/test`, {});
    expect(t2.status).toBe(400);
    expect(t2.body.error).toMatchObject({ code: "test_event_code_required", hint: expect.stringMatching(/test_event_code/) });
    expect(platform).toEqual([]);

    // Backend events marked test: true (replay's test batches arrive the same way).
    const srv = await a.api("POST", `/v1/containers/${C}/events`, {
      test: true,
      events: [
        {
          name: "purchase",
          order_id: "TESTMODE-1",
          value: 9,
          currency: "USD",
          email: "test-buyer@example.com",
          consent: granted,
          send_to: { meta: { event_name: "Purchase" }, linkedin: { conversion_id: "1234567" } },
        },
      ],
    });
    expect(srv.status).toBe(202);
    const [ev] = await settled(a.api, C, 1);
    const by = Object.fromEntries(ev!.destinations.map((d) => [(d as unknown as { destination_id: string }).destination_id, d])) as Record<
      string,
      { status: string; reason?: string }
    >;
    expect(by[metaCoded]!.status).toBe("delivered");
    expect(by[metaBare]).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/^test event, no test mode configured: .*test_event_code/),
    });
    expect(by[linkedin]).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/^test event, no test mode configured: .*no test mode/),
    });
    expect(by[analytics]!.status).toBe("delivered");
    // Only the coded pixel was called, with its test_event_code; nothing reached LinkedIn.
    expect(platform.map((p) => new URL(p.url).pathname)).toEqual([expect.stringContaining("/1111111111111111/events")]);
    expect(platform[0]!.body.test_event_code).toBe("TEST123");
    const toAnalytics = (await analyticsRequests()).filter((r) => r.url.endsWith("/v1/sites/site_testmode00001/events"));
    expect(toAnalytics).toHaveLength(1);
    expect(toAnalytics[0]!.body!.events![0]).toMatchObject({ name: "purchase", debug: true });
    expect(toAnalytics[0]!.body!.events![0]!.props).not.toHaveProperty("test");
  });
});

describe("browser test traffic (?afsa_debug=1, afst('test', true)) is delivered like preview", () => {
  it("a /collect conversion with test: 1 uses each platform's test mode or is skipped; analytics gets debug, webhooks test: true; no visitor is stored", async () => {
    const platform: { url: string; body: Record<string, unknown> }[] = [];
    const prior = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (/graph\.facebook\.com|api\.linkedin\.com/.test(url)) {
        platform.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response('{"events_received":1}', { status: 200, headers: { "content-type": "application/json" } });
      }
      return prior(input, init);
    });
    const t = await liveContainer("testtraffic.test");
    const add = async (type: string, credentials: Record<string, unknown>) => {
      const r = await t.api("POST", `/v1/containers/${t.C}/destinations`, { type, credentials });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.destination.id as string;
    };
    const metaCoded = await add("meta", { pixel_id: "3333333333333333", access_token: "meta-test-token-0000", test_event_code: "TEST456" });
    const metaBare = await add("meta", { pixel_id: "4444444444444444", access_token: "meta-test-token-0000" });
    const linkedin = await add("linkedin", { ad_account_id: "512345679", access_token: "linkedin-test-token-0000" });
    const send_to = { analytics: { event_name: "purchase" }, meta: { event_name: "Lead" }, linkedin: { conversion_id: "1234567" } };
    const draft = { triggers: purchaseDraft.triggers, conversions: [{ ...purchaseDraft.conversions[0], send_to }] };
    expect((await t.api("PUT", `/v1/containers/${t.C}/draft`, draft)).status).toBe(200);
    expect((await t.api("POST", `/v1/containers/${t.C}/publish`, {})).status).toBe(201);
    const ip = { "cf-connecting-ip": "203.0.113.7" };

    // A real visit stores its visitor; a test visit (or conversion) never does.
    expect((await t.hit({ type: "visit", visitor_id: "vis_real_tt1", page_url: "https://testtraffic.test/" }, ip)).status).toBe(200);
    expect((await t.api("GET", `/v1/containers/${t.C}/visitors/vis_real_tt1`)).status).toBe(200);
    const visit = await json(
      await t.hit(
        {
          type: "visit",
          test: 1,
          visitor_id: "vis_test_tt1",
          click_ids: { gclid: "TEST-GCLID-1" },
          page_url: "https://testtraffic.test/?afsa_debug=1",
        },
        ip,
      ),
    );
    expect(visit).toMatchObject({ ok: true, test: true });
    const conv = await json(
      await t.hit(
        {
          type: "conversion",
          test: 1,
          event_id: "tt_evt_1",
          name: "purchase",
          value: 12,
          currency: "USD",
          visitor_id: "vis_test_tt1",
          click_ids: { gclid: "TEST-GCLID-1" },
          page_url: "https://testtraffic.test/thanks",
        },
        ip,
      ),
    );
    expect(conv).toMatchObject({ ok: true, test: true, event_id: "tt_evt_1" });
    expect((await t.api("GET", `/v1/containers/${t.C}/visitors/vis_test_tt1`)).status).toBe(404);

    const [ev] = (await settled(t.api, t.C, 1)) as unknown as {
      event_id: string;
      test: boolean;
      preview: boolean;
      identity: { visitor_id: string; click_ids: string[] };
      destinations: { destination_id: string; type: string; status: string; reason?: string }[];
    }[];
    expect(ev).toMatchObject({ event_id: "tt_evt_1", source: "browser", test: true, preview: true });
    // What the hit itself carried (no stored visitor was joined).
    expect(ev!.identity).toMatchObject({ visitor_id: "vis_test_tt1", click_ids: ["gclid"] });
    const by = Object.fromEntries(ev!.destinations.map((d) => [d.destination_id, d]));
    expect(by[metaCoded]!.status).toBe("delivered");
    expect(by[metaBare]).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/^test event, no test mode configured: .*test_event_code/),
    });
    expect(by[linkedin]).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/^test event, no test mode configured: .*no test mode/),
    });
    expect(
      ev!.destinations
        .filter((d) => d.type === "analytics" || d.type === "webhook")
        .map((d) => d.status)
        .sort(),
    ).toEqual(["delivered", "delivered"]);
    // Only the coded pixel was called, with its test_event_code; nothing reached LinkedIn.
    expect(platform.map((p) => new URL(p.url).pathname)).toEqual([expect.stringContaining("/3333333333333333/events")]);
    expect(platform[0]!.body.test_event_code).toBe("TEST456");
    const hook = sent.find((s) => s.url === "https://hooks.test/testtraffic.test")!;
    expect(hook.body).toMatchObject({ type: "conversion", test: true, event: { event_id: "tt_evt_1", test: true } });
    const an = sent.find((s) => s.url.startsWith("https://analytics.test/"))!;
    expect((an.body.events as Record<string, unknown>[])[0]).toMatchObject({ name: "purchase", debug: true });

    // The event log flags the test visit too; the real one isn't.
    const all = (await t.api("GET", `/v1/containers/${t.C}/events?include_visits=true&limit=200`)).body.events as {
      type: string;
      visitor_id: string;
      test: boolean;
      preview: boolean;
    }[];
    expect(all.find((e) => e.type === "visit" && e.visitor_id === "vis_test_tt1")).toMatchObject({ test: true, preview: true });
    expect(all.find((e) => e.type === "visit" && e.visitor_id === "vis_real_tt1")).toMatchObject({ test: false, preview: false });

    // A test backend event naming that visitor is told why it didn't join.
    const srv = await t.api("POST", `/v1/containers/${t.C}/events`, {
      test: true,
      events: [{ name: "purchase", order_id: "TT-1", value: 1, currency: "USD", visitor_id: "vis_test_tt1", consent: granted }],
    });
    expect(srv.body.results[0]).toMatchObject({ joined: { by: null }, note: expect.stringContaining("No stored visitor vis_test_tt1") });
    await settled(t.api, t.C, 2); // let its deliveries finish while the platforms are still mocked
  });

  it("a headless browser is kept when its hit is test traffic; without the flag, and for crawlers, it's dropped", async () => {
    const t = await liveContainer("headless.test");
    const HEADLESS = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36";
    const post = async (body: object, ua: string) =>
      json(await t.hit({ type: "visit", page_url: "https://headless.test/", ...body }, { "user-agent": ua }));

    const kept = await post({ test: 1, event_id: "hl_kept_1" }, HEADLESS);
    expect(kept).toMatchObject({ ok: true, test: true, event_id: "hl_kept_1" });
    expect(kept.ignored).toBeUndefined();
    // ?afsa_debug=1 in the page URL marks the hit too (e.g. a runtime cached from before the flag).
    expect(await post({ event_id: "hl_kept_2", page_url: "https://headless.test/?afsa_debug=1" }, HEADLESS)).toMatchObject({
      ok: true,
      test: true,
      event_id: "hl_kept_2",
    });

    expect(await post({ event_id: "hl_drop_1" }, HEADLESS)).toMatchObject({
      ok: true,
      ignored: "bot",
      hint: expect.stringContaining("?afsa_debug=1"),
    });
    const googlebot = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    expect(await post({ test: 1, event_id: "hl_drop_2" }, googlebot)).toMatchObject({ ignored: "bot" });
    expect(await post({ test: 1, event_id: "hl_drop_3" }, "Mozilla/5.0 (compatible; Googlebot/2.1) HeadlessChrome/130.0")).toMatchObject({
      ignored: "bot",
    });

    const visits = (await t.api("GET", `/v1/containers/${t.C}/events?include_visits=true&limit=200`)).body.events as {
      event_id: string;
      test: boolean;
    }[];
    expect(visits.map((e) => e.event_id).sort()).toEqual(["hl_kept_1", "hl_kept_2"]);
    expect(visits.every((e) => e.test)).toBe(true);
  });
});
