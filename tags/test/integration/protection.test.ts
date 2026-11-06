import { ATTACK_COOLDOWN_MS, createAccount } from "@afs/shared";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectResult, ContainerDO } from "../../src/do/container-do";
import type { Bindings } from "../../src/env";
import type { CollectHit } from "../../src/service/ingest";
import { cleanCollectPayload } from "../../src/service/ingest";
import { collectSchema } from "../../src/service/ingest-schema";

const B = "https://tags.test";
const E = env as unknown as Bindings;
const granted = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" };
const UA = "Mozilla/5.0 Chrome/130";
/** Amazon AWS (a data centre) and Comcast (people's homes). */
const AWS = 16509;
const HOME = 7922;

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
});
afterEach(() => vi.restoreAllMocks());

type Api = (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }>;
let shared: Promise<{ api: Api; accountId: string }> | null = null;
/** One account for the file, straight in the identity DB (signup is rate limited). */
function account() {
  shared ??= (async () => {
    const { accountId, apiKey } = await createAccount(E.AUTH_DB!, { keyPrefix: "afs" });
    const H = { authorization: `Bearer ${apiKey.key}`, "content-type": "application/json" };
    const api: Api = async (method, path, body) => {
      const res = await SELF.fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await json(res) };
    };
    return { api, accountId };
  })();
  return shared;
}

const purchaseDraft = {
  triggers: [{ id: "p", type: "custom_event", event: "purchase" }],
  conversions: [{ name: "purchase", trigger: "p", currency: "USD", send_to: { analytics: { event_name: "purchase" } }, server: true }],
};
const hook = (path: string) => ({ type: "webhook", credentials: { url: `https://hooks.test/${path}`, secret: "integration-secret-123" } });

/** A published container with one webhook destination (conversions with server: true fan out to it). */
async function container(domain: string, extra: Record<string, unknown> = {}) {
  const a = await account();
  const r = await a.api("POST", "/v1/containers", { domain, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const C = r.body.container.id as string;
  expect((await a.api("POST", `/v1/containers/${C}/destinations`, hook(domain))).status).toBe(201);
  expect((await a.api("PUT", `/v1/containers/${C}/draft`, purchaseDraft)).status).toBe(200);
  expect((await a.api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);
  return { ...a, C, domain };
}

/** Run ContainerDO methods with extra vars (it reads caps from env). */
function inDO<T>(C: string, vars: Record<string, string>, fn: (i: ContainerDO) => Promise<T>): Promise<T> {
  return runInDurableObject(E.CONTAINER.getByName(C), async (instance) => {
    const i = instance as unknown as { env: Bindings };
    const saved = i.env;
    i.env = { ...saved, ...vars } as Bindings;
    try {
      return await fn(instance as unknown as ContainerDO);
    } finally {
      i.env = saved;
    }
  });
}

/** A browser hit as the Worker hands it over: `net` stands in for the keyed network hash. */
function hit(
  C: string,
  domain: string,
  body: Record<string, unknown>,
  o: { net?: string; asn?: number; at?: number; page?: string } = {},
): CollectHit {
  return {
    payload: cleanCollectPayload(
      collectSchema.parse({ container_id: C, consent: granted, page_url: `https://${domain}${o.page ?? "/"}`, ...body }),
    ),
    enrich: {
      received_at: o.at ?? Date.now(),
      origin_host: domain,
      ip: "203.0.113.5",
      user_agent: UA,
      geo: { country: "NL" },
      device: { category: "desktop", browser: "Chrome", os: "Linux" },
      net_hash: o.net ?? "net-home-1",
      asn: o.asn ?? HOME,
      as_org: o.asn === AWS ? "Amazon.com, Inc." : "Comcast",
    },
  };
}

let seq = 0;
const visit = (C: string, domain: string, o: Parameters<typeof hit>[3] = {}) =>
  hit(C, domain, { type: "visit", event_id: `v_prot_${++seq}` }, o);
const purchase = (C: string, domain: string, o: Parameters<typeof hit>[3] = {}) =>
  hit(C, domain, { type: "conversion", name: "purchase", event_id: `e_prot_${++seq}`, value: 9, currency: "USD" }, o);
const statuses = (r: CollectResult) =>
  r.ok ? (r.destinations ?? []).map((d) => `${d.status}${d.reason ? `:${d.reason.split(":")[0]}` : ""}`) : [r.error];
const today = () => new Date().toISOString().slice(0, 10);

describe("a network's daily share", () => {
  it("past N a network's hits are quarantined: logged, never delivered, not counted against the daily budget", async () => {
    const t = await container("share.test");
    const vars = { MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "3", MAX_EVENTS_PER_CONTAINER_PER_DAY: "4" };
    const out = await inDO(t.C, vars, async (i) => {
      const r: CollectResult[] = [];
      for (let n = 0; n < 5; n++) r.push(await i.collect(visit(t.C, t.domain, { net: "net-flood" })));
      r.push(await i.collect(purchase(t.C, t.domain, { net: "net-flood", page: "/checkout" })));
      // Another network still gets in: the flood didn't use up the container's budget of 4.
      r.push(await i.collect(visit(t.C, t.domain, { net: "net-real" })));
      return { r, usage: await i.usageToday(today()) };
    });
    expect(out.r.every((x) => x.ok)).toBe(true);
    // The quarantined conversion was never planned for delivery.
    expect(out.r[5]).toEqual({ ok: true, event_id: expect.any(String) });
    expect(out.usage).toMatchObject({ browser_events: 4, quarantined: 3, network_max: 6 });
    expect(out.usage.protection).toMatchObject({
      mode: "auto",
      state: "contained",
      quarantined: 3,
      quarantined_today: 3,
      reasons: [{ kind: "network_share", detail: expect.stringMatching(/^1 network passed 3 browser hits today/) }],
    });

    // The log leaves them out unless asked; stats count them apart.
    const log = (await t.api("GET", `/v1/containers/${t.C}/events?include_visits=true&limit=50`)).body.events;
    expect(log).toHaveLength(4);
    const q = (await t.api("GET", `/v1/containers/${t.C}/events?status=quarantined&include_visits=true`)).body.events;
    expect(q).toHaveLength(3);
    expect(q[0]).toMatchObject({ status: "quarantined", quarantine: "network_share", network: { asn: HOME }, destinations: [] });
    expect(q.find((e: { type: string }) => e.type === "conversion")).toMatchObject({ name: "purchase", value: 9 });

    const got = (await t.api("GET", `/v1/containers/${t.C}`)).body;
    expect(got.stats.last_24h).toMatchObject({ visits: 4, conversions: 0, quarantined: 3 });
    expect(got.stats.today.browser_events).toBe(4);
    expect(got.protection).toMatchObject({ mode: "auto", state: "contained", quarantined_today: 3 });
    expect(got.protection.next_steps[0]).toContain(`GET ${B}/v1/containers/${t.C}/quarantine`);
    expect(got.warnings.join(" ")).toMatch(/passed its daily share/);
    expect(got.container.protection).toBe("auto");
  });

  it("quarantined hits past MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY are counted but not logged", async () => {
    const t = await container("qcap.test");
    const vars = { MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "1", MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY: "2" };
    await inDO(t.C, vars, async (i) => {
      for (let n = 0; n < 5; n++) await i.collect(visit(t.C, t.domain, { net: "net-q" }));
    });
    const s = (await t.api("GET", `/v1/containers/${t.C}/quarantine?since=24h`)).body;
    expect(s).toMatchObject({
      logged: 2,
      by_reason: { network_share: 2, datacenter: 0 },
      by_type: { visits: 2, conversions: 0 },
      today: { network_share: 4, datacenter: 0, total: 4, dropped: 2, networks_over_share: 1 },
      networks: [{ asn: HOME, as_org: "Comcast", hits: 2 }],
      countries: [{ country: "NL", hits: 2 }],
      untrusted: { pages: [{ page: "qcap.test/", hits: 2 }], browsers: [{ browser: "Chrome", os: "Linux", hits: 2 }] },
    });
    expect(s.by_day).toEqual([{ day: today(), network_share: 2, datacenter: 0, total: 2 }]);
    expect(s.protection.state).toBe("contained");
  });

  it("off when unset, and with protection off the share is counted (reported) but nothing is set aside", async () => {
    const t = await container("share-off.test", { protection: "off" });
    expect((await t.api("GET", `/v1/containers/${t.C}`)).body.container.protection).toBe("off");
    const unset = await inDO(t.C, {}, async (i) => {
      for (let n = 0; n < 3; n++) await i.collect(visit(t.C, t.domain, { net: "net-u" }));
      return i.usageToday(today());
    });
    expect(unset).toMatchObject({ browser_events: 3, quarantined: 0, network_max: 0, protection: { state: "none" } });
    const off = await inDO(t.C, { MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "1" }, async (i) => {
      for (let n = 0; n < 3; n++) await i.collect(visit(t.C, t.domain, { net: "net-o" }));
      return i.usageToday(today());
    });
    expect(off).toMatchObject({ browser_events: 6, quarantined: 0, protection: { mode: "off", state: "contained" } });
    expect(off.protection.measures.network_share_limit).toBeNull();
  });
});

describe("attack mode", () => {
  const spike = { SPIKE_MIN_EVENTS: "5" };

  it("spike -> under_attack: data-centre traffic quarantined, browser conversions held, backend conversions delivered; cooldown ends it", async () => {
    const t = await container("spike.test");
    const now = Date.now();
    const r = await inDO(t.C, spike, async (i) => {
      const before = await i.collect(purchase(t.C, t.domain, { net: "net-0" }));
      // Many residential networks: a spike, but none of it is quarantined.
      const crowd: CollectResult[] = [];
      for (let n = 1; n <= 5; n++) crowd.push(await i.collect(visit(t.C, t.domain, { net: `net-${n}`, at: now })));
      const dc = await i.collect(visit(t.C, t.domain, { net: "net-dc", asn: AWS, at: now }));
      const home = await i.collect(visit(t.C, t.domain, { net: "net-6", at: now }));
      const conv = await i.collect(purchase(t.C, t.domain, { net: "net-7", at: now }));
      const backend = await i.ingestServer([{ name: "purchase", order_id: "BACKEND-1", value: 9, currency: "USD" }], {
        test: false,
        now,
      });
      const during = await i.protection(now);
      const usage = await i.usageToday(today(), undefined, now);
      return { before, crowd, dc, home, conv, backend, during, usage };
    });
    expect(statuses(r.before)).toEqual(["queued"]);
    expect(r.crowd.every((x) => x.ok && !("duplicate" in x))).toBe(true);
    expect(r.during).toMatchObject({
      mode: "auto",
      state: "under_attack",
      quarantined: 1,
      conversions_held_today: 1,
      measures: { datacenter_quarantine: true, browser_conversions_held: true },
    });
    expect(r.during.reasons.map((x) => x.kind)).toEqual(["spike", "datacenter"]);
    expect(r.usage).toMatchObject({ quarantined: 1, browser_events: 8 });
    // The browser conversion is logged with the hold as each destination's skip reason.
    expect(statuses(r.conv)).toEqual(["skipped:held"]);
    expect(r.conv.ok && r.conv.note).toMatch(/^Held: the container is under attack/);
    // Backend conversions (API key) keep flowing.
    expect(Array.isArray(r.backend) && r.backend[0]!.destinations.map((d) => d.status)).toEqual(["queued"]);

    const log = (await t.api("GET", `/v1/containers/${t.C}/events?status=skipped`)).body.events;
    expect(log[0].destinations[0].reason).toMatch(/^held: the container is under attack/);
    const dcRow = (await t.api("GET", `/v1/containers/${t.C}/events?status=quarantined&include_visits=true`)).body.events;
    expect(dcRow).toEqual([expect.objectContaining({ quarantine: "datacenter", network: { asn: AWS, as_org: "Amazon.com, Inc." } })]);

    // GET /v1/usage: the contract with the platform site.
    const usage = (await t.api("GET", "/v1/usage")).body;
    const item = usage.attacks.find((x: { resource_id: string }) => x.resource_id === t.C);
    expect(item).toMatchObject({
      service: "tags",
      resource_label: "spike.test",
      state: "under_attack",
      mode: "auto",
      since: now,
      ended_at: null,
      quarantined: 1,
    });
    expect(item.next_steps.join("\n")).toContain(`GET ${B}/v1/containers/${t.C}/quarantine`);
    expect(item.next_steps.join("\n")).toMatch(/still delivered|always delivered/);

    // An hour after the last trigger it's over: data-centre traffic is accepted again.
    const later = now + ATTACK_COOLDOWN_MS + 60_000;
    const after = await inDO(t.C, spike, async (i) => ({
      view: await i.protection(later),
      dc: await i.collect(visit(t.C, t.domain, { net: "net-dc2", asn: AWS, at: later })),
      conv: await i.collect(purchase(t.C, t.domain, { net: "net-8", at: later })),
      usage: await i.usageToday(today(), undefined, later),
    }));
    expect(after.view).toMatchObject({ state: "ended", ended_at: now + ATTACK_COOLDOWN_MS, quarantined: 1 });
    expect(after.view.measures.datacenter_quarantine).toBe(false);
    expect(statuses(after.conv)).toEqual(["queued"]);
    expect(after.usage.quarantined).toBe(1);
    // Ended episodes stay in attacks for 24 hours, then drop out.
    const gone = await inDO(t.C, {}, (i) => i.protection(now + ATTACK_COOLDOWN_MS + 25 * 3_600_000));
    expect(gone.state).toBe("none");
  });

  it("a network past its share during an attack keeps it under attack; contained becomes under_attack on a spike", async () => {
    const t = await container("upgrade.test");
    const v = await inDO(t.C, { ...spike, MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "2" }, async (i) => {
      for (let n = 0; n < 3; n++) await i.collect(visit(t.C, t.domain, { net: "net-big" }));
      const contained = await i.protection();
      for (let n = 0; n < 5; n++) await i.collect(visit(t.C, t.domain, { net: `net-many-${n}` }));
      return { contained, attack: await i.protection() };
    });
    expect(v.contained.state).toBe("contained");
    expect(v.attack).toMatchObject({ state: "under_attack", since: v.contained.since });
    expect(v.attack.reasons.map((x) => x.kind)).toEqual(["network_share", "spike"]);
  });

  it("protection off: detection and reporting run, nothing is quarantined or held", async () => {
    const t = await container("attack-off.test", { protection: "off" });
    const r = await inDO(t.C, spike, async (i) => {
      for (let n = 0; n < 5; n++) await i.collect(visit(t.C, t.domain, { net: `n-${n}` }));
      return {
        dc: await i.collect(visit(t.C, t.domain, { net: "n-dc", asn: AWS })),
        conv: await i.collect(purchase(t.C, t.domain, { net: "n-c" })),
        view: await i.protection(),
      };
    });
    expect(r.view).toMatchObject({ mode: "off", state: "under_attack", quarantined_today: 0 });
    expect(statuses(r.conv)).toEqual(["queued"]);
    const got = (await t.api("GET", `/v1/containers/${t.C}`)).body;
    expect(got.stats.last_24h.quarantined).toBe(0);
    expect(got.warnings.join(" ")).toMatch(/protection is off, so nothing is set aside/);
  });

  it("protection strict: data-centre traffic always quarantined and browser conversions always held, with no attack", async () => {
    const t = await container("strict.test");
    const p = await t.api("PATCH", `/v1/containers/${t.C}`, { protection: "strict" });
    expect(p.status).toBe(200);
    expect(p.body.container.protection).toBe("strict");
    const r = await inDO(t.C, {}, async (i) => ({
      dc: await i.collect(visit(t.C, t.domain, { net: "s-dc", asn: AWS })),
      home: await i.collect(visit(t.C, t.domain, { net: "s-home" })),
      conv: await i.collect(purchase(t.C, t.domain, { net: "s-c" })),
      backend: await i.ingestServer([{ name: "purchase", order_id: "STRICT-1" }], { test: false, now: Date.now() }),
      view: await i.protection(),
    }));
    expect(statuses(r.conv)).toEqual(["skipped:held"]);
    expect(r.conv.ok && r.conv.note).toMatch(/protection is strict/);
    expect(Array.isArray(r.backend) && r.backend[0]!.destinations.map((d) => d.status)).toEqual(["queued"]);
    // No episode: strict is the owner's choice, not an attack, so nothing goes into attacks.
    expect(r.view).toMatchObject({ mode: "strict", state: "none", quarantined_today: 1 });
    const usage = (await t.api("GET", "/v1/usage")).body;
    expect(usage.attacks.map((x: { resource_id: string }) => x.resource_id)).not.toContain(t.C);
    expect(usage.limits.quarantined_events_per_container_per_day.per).toContainEqual(expect.objectContaining({ id: t.C, used: 1 }));
  });

  it("preview traffic is exempt (its link carries a valid token)", async () => {
    const t = await container("preview-exempt.test", { protection: "strict" });
    const r = await inDO(t.C, {}, (i) =>
      i.collect({ ...visit(t.C, t.domain, { net: "p-dc", asn: AWS }), preview_config: { tags: [] } as never }),
    );
    expect(r.ok).toBe(true);
    const q = (await t.api("GET", `/v1/containers/${t.C}/quarantine`)).body;
    expect(q.today.total).toBe(0);
  });
});

describe("the protection setting and the Worker path", () => {
  it("protection is validated on create and update, with a hint", async () => {
    const a = await account();
    const bad = await a.api("POST", "/v1/containers", { domain: "bad-protection.test", protection: "max" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0]).toMatchObject({ path: "protection", message: 'protection must be "auto", "strict" or "off".' });
    const t = await container("setting.test");
    expect((await t.api("PATCH", `/v1/containers/${t.C}`, { protection: "nope" })).status).toBe(400);
    expect((await t.api("PATCH", `/v1/containers/${t.C}`, { protection: "off" })).body.container.protection).toBe("off");
    expect((await t.api("PATCH", `/v1/containers/${t.C}`, { name: "Shop" })).body.container.protection).toBe("off");
    expect((await t.api("PATCH", `/v1/containers/${t.C}`, { protection: "auto" })).body.container.protection).toBe("auto");
    expect(
      (await E.DB.prepare("SELECT protection FROM containers WHERE id = ?").bind(t.C).first<{ protection: string | null }>())!.protection,
    ).toBeNull();
  });

  it("/collect passes the network operator (x-afs-dev-asn in dev) and a keyed network hash to the container", async () => {
    const t = await container("worker-path.test", { protection: "strict" });
    const send = (asn: number, ip: string) =>
      SELF.fetch(`${B}/collect`, {
        method: "POST",
        headers: { origin: `https://${t.domain}`, "user-agent": UA, "x-afs-dev-asn": String(asn), "cf-connecting-ip": ip },
        body: JSON.stringify({ container_id: t.C, consent: granted, type: "visit", page_url: `https://${t.domain}/pricing` }),
      });
    expect((await send(AWS, "198.51.100.7")).status).toBe(200);
    expect((await send(HOME, "198.51.100.8")).status).toBe(200);
    const q = (await t.api("GET", `/v1/containers/${t.C}/quarantine`)).body;
    expect(q).toMatchObject({ logged: 1, by_reason: { datacenter: 1 }, networks: [{ asn: AWS, hits: 1 }] });
    expect(q.untrusted.pages).toEqual([{ page: "worker-path.test/pricing", hits: 1 }]);
    // MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY is off in tests: nothing is counted at all.
    const netRows = () =>
      runInDurableObject(E.CONTAINER.getByName(t.C), async (_i, state) =>
        state.storage.sql.exec<{ net: string; n: number }>("SELECT net, n FROM net_daily").toArray(),
      );
    expect(await netRows()).toEqual([]);
    // With a share set, two hits from one address are one row, counted by a keyed hash: neither the
    // address nor its network is stored. (The container's object keeps the var until it's restored.)
    const saved = await runInDurableObject(E.CONTAINER.getByName(t.C), async (i) => {
      const o = i as unknown as { env: Bindings };
      const before = o.env;
      o.env = { ...before, MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "100" } as Bindings;
      return before;
    });
    try {
      expect((await send(HOME, "198.51.100.9")).status).toBe(200);
      expect((await send(HOME, "198.51.100.9")).status).toBe(200);
      const rows = await netRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ net: expect.stringMatching(/^[0-9a-f]{24}$/), n: 2 });
      expect(rows[0]!.net).not.toContain("198.51");
    } finally {
      await runInDurableObject(E.CONTAINER.getByName(t.C), async (i) => {
        (i as unknown as { env: Bindings }).env = saved;
      });
    }
  });

  it("GET /v1/containers/:id/quarantine and MCP get_quarantine answer the same, read keys included", async () => {
    const t = await container("quarantine-read.test");
    const read = await t.api("POST", "/v1/keys", { scope: "read" });
    const res = await SELF.fetch(`${B}/v1/containers/${t.C}/quarantine?period=24h`, {
      headers: { authorization: `Bearer ${read.body.api_key}` },
    });
    expect(res.status).toBe(200);
    const rest = await json(res);
    expect(rest).toMatchObject({ container_id: t.C, logged: 0, protection: { state: "none", mode: "auto" } });
    const mcp = await json(
      await SELF.fetch(`${B}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${read.body.api_key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_quarantine", arguments: { container_id: t.C } },
        }),
      }),
    );
    expect(JSON.parse(mcp.result.content[0].text)).toMatchObject({
      container_id: t.C,
      logged: 0,
      by_reason: { network_share: 0, datacenter: 0 },
    });
  });
});

describe("event log schema v5 (objects created by older code)", () => {
  it("adds the quarantine, asn and as_org columns and the partial index to a v4 event log, keeping its rows", async () => {
    const stub = E.CONTAINER.getByName("ctr_schemav4upgrade01");
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE events (
          event_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
          ts INTEGER NOT NULL, received_at INTEGER NOT NULL, visitor_id TEXT, transaction_id TEXT,
          value REAL, currency TEXT, preview INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
          data TEXT NOT NULL, results TEXT NOT NULL DEFAULT '{}', note TEXT,
          PRIMARY KEY (source, event_id));`);
      sql.exec("INSERT INTO meta (k, v) VALUES ('schema', '4')");
      sql.exec(
        "INSERT INTO meta (k, v) VALUES ('container', ?)",
        JSON.stringify({ id: "ctr_schemav4upgrade01", account_id: "acc_x", domain: "v4.test", allowed_hostnames: [], live_version: null }),
      );
      sql.exec(
        "INSERT INTO events (event_id, type, name, source, ts, received_at, status, data) VALUES ('old', 'visit', 'page_view', 'browser', 1, ?, 'logged', '{}')",
        Date.now(),
      );
      const i = instance as unknown as { ready: boolean; migrate(): void };
      i.ready = true;
      i.migrate();
      i.migrate(); // idempotent
      const cols = sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('events')")
        .toArray()
        .map((r) => r.name);
      expect(cols).toEqual(expect.arrayContaining(["quarantine", "asn", "as_org"]));
      expect(sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray()).toEqual([{ v: "5" }]);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('events_quarantine', 'net_daily') ORDER BY name").toArray()).toEqual([
        { name: "events_quarantine" },
        { name: "net_daily" },
      ]);
      expect(sql.exec("SELECT event_id, quarantine FROM events").toArray()).toEqual([{ event_id: "old", quarantine: null }]);
    });
  });
});
