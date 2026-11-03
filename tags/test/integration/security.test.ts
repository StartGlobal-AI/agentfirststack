import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
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
        credentials: { site_id: "site_abc123", api_key: "ana_xxxxxxxx", base_url: "https://analytics.test" },
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

describe("finding 7: only the container's own proxy may set the visitor IP", () => {
  it("X-Forwarded-For is ignored unless the request carries the container's x-afs-proxy-key", async () => {
    const a = await account();
    const C = (await a.api("POST", "/v1/containers", { domain: "proxy.test" })).body.container.id as string;
    const install = (await a.api("GET", `/v1/containers/${C}/install`)).body;
    const key = install.first_party_proxy.proxy_key as string;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(install.first_party_proxy.cloudflare_worker).toContain(`h.set("x-afs-proxy-key", "${key}")`);
    expect(install.snippet).not.toContain(key);
    const other = (await a.api("POST", "/v1/containers", { domain: "other-proxy.test" })).body;
    const otherKey = other.install.first_party_proxy.proxy_key as string;
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
