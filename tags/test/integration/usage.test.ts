import { createAccount } from "@afs/shared";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerDO } from "../../src/do/container-do";
import type { Bindings } from "../../src/env";
import type { CollectHit } from "../../src/service/ingest";
import { cleanCollectPayload } from "../../src/service/ingest";
import { collectSchema } from "../../src/service/ingest-schema";
import { getUsage, PER_MAX } from "../../src/service/usage";
import { accountTagsBytes } from "../../src/service/versions";

const B = "https://tags.test";
type Usage = Awaited<ReturnType<typeof getUsage>>;
const E = env as unknown as Bindings;
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

// Deliveries to the test webhooks are answered here.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
});
afterEach(() => vi.restoreAllMocks());

/** A fresh account straight in the identity DB (no signup rate limit), claimed by a person if asked. */
async function account(claimed = false) {
  const { accountId, apiKey } = await createAccount(E.AUTH_DB!, { keyPrefix: "afs" });
  if (claimed) {
    const now = Date.now();
    const userId = `usr_${accountId.slice(5)}`;
    await E.AUTH_DB!.batch([
      E.AUTH_DB!.prepare("INSERT INTO users (id, google_sub, email, created_at) VALUES (?, ?, ?, ?)").bind(
        userId,
        `dev:${userId}`,
        `${userId}@example.test`,
        now,
      ),
      E.AUTH_DB!.prepare("INSERT INTO memberships (user_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(
        userId,
        accountId,
        now,
      ),
    ]);
  }
  const call = (key: string) => async (method: string, path: string, body?: unknown) => {
    const res = await SELF.fetch(`${B}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await json(res) };
  };
  const api = call(apiKey.key);
  const newContainer = async (domain: string) => {
    const r = await api("POST", "/v1/containers", { domain });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.container.id as string;
  };
  const usage = async () => {
    const r = await api("GET", "/v1/usage");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Usage;
  };
  return { accountId, key: apiKey.key, api, call, newContainer, usage };
}

const collect = (domain: string, C: string, body: object) =>
  SELF.fetch(`${B}/collect`, {
    method: "POST",
    headers: { origin: `https://${domain}`, "user-agent": UA },
    body: JSON.stringify({ container_id: C, consent: granted, ...body }),
  });

function hit(C: string, domain: string, body: Record<string, unknown>): CollectHit {
  return {
    payload: cleanCollectPayload(collectSchema.parse({ container_id: C, consent: granted, ...body })),
    enrich: { received_at: Date.now(), origin_host: domain, ip: "203.0.113.5", user_agent: UA },
  };
}

/** Run a ContainerDO method with extra vars (the DO reads its caps from env). */
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

/** The account's container ids, oldest first (ties by id): the order per keeps among equal use. */
const oldestFirst = async (accountId: string) =>
  (
    await E.DB.prepare("SELECT id FROM containers WHERE account_id = ? ORDER BY created_at, id").bind(accountId).all<{ id: string }>()
  ).results.map((r) => r.id);

const hook = (path: string) => ({ type: "webhook", credentials: { url: `https://hooks.test/${path}`, secret: "integration-secret-123" } });
const purchaseDraft = {
  triggers: [{ id: "p", type: "custom_event", event: "purchase" }],
  conversions: [{ name: "purchase", trigger: "p", currency: "USD", send_to: { analytics: { event_name: "purchase" } }, server: true }],
};

const ACCOUNT_CAPS = [
  "containers",
  "storage_bytes",
  "browser_events_per_day",
  "server_events_per_day",
  "deliveries_per_day",
  "scans_per_day",
  "destination_tests_per_day",
];
const PER_CONTAINER = [
  "browser_events_per_container_per_day",
  "server_events_per_container_per_day",
  "deliveries_per_container_per_day",
  "visitors_per_container",
  "container_db_bytes",
  "events_per_network_per_container_per_day",
  "quarantined_events_per_container_per_day",
  "consent_records_per_container_per_day",
  "destinations_per_container",
  "versions_per_container",
  "draft_bytes",
  "custom_code_bytes",
  "environments_per_container",
  "lookups_per_container",
  "rows_per_lookup",
  "lookup_bytes",
];
const DROPS_DATA = [
  "browser_events_per_day",
  "server_events_per_day",
  "deliveries_per_day",
  "browser_events_per_container_per_day",
  "server_events_per_container_per_day",
  "deliveries_per_container_per_day",
  "visitors_per_container",
  "container_db_bytes",
  "consent_records_per_container_per_day",
];
// Attack protection's caps reset daily but lose nothing from real visitors (quarantine, not drops).
const DAILY = [
  ...DROPS_DATA.filter((n) => n.includes("_per_day")),
  "events_per_network_per_container_per_day",
  "quarantined_events_per_container_per_day",
  "scans_per_day",
  "destination_tests_per_day",
];

describe("GET /v1/usage and MCP get_usage", () => {
  it("lists every account and per-container cap with the shared item shape, and no deployment-wide budget", async () => {
    const a = await account();
    const u = await a.usage();
    const now = Date.now();
    const midnight = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
    expect(u).toMatchObject({
      day: new Date(now).toISOString().slice(0, 10),
      resets_at: midnight,
      resets_at_iso: new Date(midnight).toISOString(),
      claimed: false,
      policy: { custom_code_allowed: false, custom_code_paused: null },
    });
    expect(Object.keys(u.limits).sort()).toEqual([...ACCOUNT_CAPS, ...PER_CONTAINER].sort());
    for (const [name, it] of Object.entries(u.limits)) {
      expect(it.label, name).toMatch(/^[A-Z][a-z]/);
      expect(typeof it.unit, name).toBe("string");
      expect(it.var, name).toMatch(/^MAX_[A-Z_]+$/);
      expect(["MAX_EVENTS_PER_DAY", "MAX_DELIVERIES_PER_DAY"], name).not.toContain(it.var);
      expect(it.resets_at, name).toBe(DAILY.includes(name) ? midnight : null);
      expect("drops_data" in it, name).toBe(DROPS_DATA.includes(name));
      if (it.drops_data !== undefined) expect(it.drops_data, name).toBe(true);
      expect("per" in it, name).toBe(PER_CONTAINER.includes(name) && name !== "custom_code_bytes");
      expect(it.note, name).toEqual(expect.any(String));
    }
    // No containers yet: nothing used; unset caps are listed with limit null.
    expect(u.limits.containers).toMatchObject({ used: 0, limit: null, remaining: null, var: "MAX_CONTAINERS_PER_ACCOUNT" });
    expect(u.limits.browser_events_per_container_per_day).toMatchObject({ used: 0, limit: null, per: [] });
    // Defaults in code apply when the var is unset.
    expect(u.limits.destinations_per_container).toMatchObject({ used: 0, limit: 10, remaining: 10 });
    expect(u.limits.visitors_per_container).toMatchObject({ limit: 250_000 });
    // Counted only when MAX_CUSTOM_CODE_BYTES is set.
    expect(u.limits.custom_code_bytes).toMatchObject({ used: null, limit: null });
    expect(u.next_steps).toEqual(expect.arrayContaining([expect.stringMatching(/claim/)]));
  });

  it("used moves with containers, collected events, backend events and deliveries; per is highest first", async () => {
    const a = await account();
    const C1 = await a.newContainer("usage-one.test");
    const C2 = await a.newContainer("usage-two.test");
    let u = await a.usage();
    expect(u.limits.containers.used).toBe(2);
    // A tie keeps the older container first.
    expect(u.limits.destinations_per_container.per!.map((p) => p.id)).toEqual(await oldestFirst(a.accountId));

    // Three visitors on C1, one on C2 (browser hits through /collect).
    for (const n of [1, 2, 3])
      expect((await collect("usage-one.test", C1, { type: "visit", visitor_id: `vis_one_${n}` })).status).toBe(200);
    expect((await collect("usage-two.test", C2, { type: "visit", visitor_id: "vis_two_1" })).status).toBe(200);
    // Two webhooks on C2, a published conversion, and backend events there (each fans out to both).
    for (const p of ["usage-a", "usage-b"]) expect((await a.api("POST", `/v1/containers/${C2}/destinations`, hook(p))).status).toBe(201);
    expect((await a.api("PUT", `/v1/containers/${C2}/draft`, purchaseDraft)).status).toBe(200);
    expect((await a.api("POST", `/v1/containers/${C2}/publish`, {})).status).toBe(201);
    const sent = await a.api("POST", `/v1/containers/${C2}/events`, {
      events: [
        { name: "purchase", order_id: "U-1", value: 10, currency: "USD" },
        { name: "purchase", order_id: "U-2", value: 20, currency: "USD" },
      ],
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);

    u = await a.usage();
    const L = u.limits;
    expect(L.browser_events_per_container_per_day).toMatchObject({
      used: 3,
      per: [
        { id: C1, label: "usage-one.test", used: 3, remaining: null },
        { id: C2, label: "usage-two.test", used: 1, remaining: null },
      ],
    });
    expect(L.browser_events_per_day).toMatchObject({ used: 4, limit: null });
    expect(L.server_events_per_container_per_day.per!.map((p) => [p.id, p.used])).toEqual([
      [C2, 2],
      [C1, 0],
    ]);
    expect(L.server_events_per_day.used).toBe(2);
    expect(L.deliveries_per_container_per_day).toMatchObject({
      used: 4,
      per: [
        { id: C2, used: 4 },
        { id: C1, used: 0 },
      ],
    });
    expect(L.deliveries_per_day.used).toBe(4);
    expect(L.visitors_per_container).toMatchObject({ used: 3, remaining: 250_000 - 3 });
    expect(L.visitors_per_container.per!.map((p) => [p.label, p.used])).toEqual([
      ["usage-one.test", 3],
      ["usage-two.test", 1],
    ]);
    expect(L.destinations_per_container).toMatchObject({ used: 2, remaining: 8, per: [{ id: C2, used: 2, remaining: 8 }, { id: C1 }] });
    expect(L.versions_per_container).toMatchObject({
      used: 1,
      per: [
        { id: C2, used: 1 },
        { id: C1, used: 0 },
      ],
    });
    expect(L.container_db_bytes.used).toBeGreaterThan(0);
    expect(L.container_db_bytes.per![0]!.used).toBe(L.container_db_bytes.used);
    // Tag storage is what MAX_TAGS_BYTES_PER_ACCOUNT checks against.
    expect(L.storage_bytes.used).toBe(await accountTagsBytes(E, a.accountId));
    expect(L.draft_bytes.per![0]).toMatchObject({ id: C2 });

    // The visitor count stays in step with new visitors after it was read.
    await collect("usage-one.test", C1, { type: "visit", visitor_id: "vis_one_4" });
    expect((await a.usage()).limits.visitors_per_container.used).toBe(4);

    // Environments and lookup tables are counted per container too.
    expect((await a.api("POST", `/v1/containers/${C1}/environments`, { name: "staging", version: "draft" })).status).toBe(201);
    expect((await a.api("PUT", `/v1/containers/${C1}/lookups/sku_margin`, { rows: { A: 1, B: 2, C: 3 } })).status).toBe(201);
    const L2 = (await a.usage()).limits;
    expect(L2.environments_per_container).toMatchObject({ used: 1, limit: 5, per: [{ id: C1, used: 1, remaining: 4 }, { id: C2 }] });
    expect(L2.lookups_per_container).toMatchObject({
      used: 1,
      per: [
        { id: C1, used: 1 },
        { id: C2, used: 0 },
      ],
    });
    expect(L2.rows_per_lookup).toMatchObject({
      used: 3,
      limit: 10_000,
      per: [
        { id: C1, used: 3 },
        { id: C2, used: 0 },
      ],
    });
    expect(L2.lookup_bytes.used).toBe(JSON.stringify({ A: 1, B: 2, C: 3 }).length);
    expect(L2.storage_bytes.used).toBe(await accountTagsBytes(E, a.accountId));

    // Deleting a container lowers the container count, not the day's events once they were reported.
    await inDO(C1, { MAX_EVENTS_PER_ACCOUNT_PER_DAY: "1000" }, (i) =>
      i.collect(hit(C1, "usage-one.test", { type: "visit", event_id: "usage_reported_1" })),
    );
    expect((await a.api("DELETE", `/v1/containers/${C1}`)).status).toBe(200);
    const after = (await a.usage()).limits;
    expect(after.containers.used).toBe(1);
    expect(after.browser_events_per_day.used).toBe(6); // 5 on the deleted container + 1 on C2
    expect(after.browser_events_per_container_per_day.per!.map((p) => p.id)).toEqual([C2]);
  });

  it("applies the account's standing: UNCLAIMED_ values until a person claims it, limit and remaining from the vars", async () => {
    const vars = {
      MAX_EVENTS_PER_CONTAINER_PER_DAY: "100",
      UNCLAIMED_MAX_EVENTS_PER_CONTAINER_PER_DAY: "10",
      MAX_CONTAINERS_PER_ACCOUNT: "10",
      UNCLAIMED_MAX_CONTAINERS_PER_ACCOUNT: "3",
      MAX_DELIVERIES_PER_ACCOUNT_PER_DAY: "50",
      MAX_CUSTOM_CODE_BYTES: "1000",
      MAX_EVENTS_PER_DAY: "1000000",
      MAX_DELIVERIES_PER_DAY: "1000000",
    };
    const [u, c] = [await account(), await account(true)];
    const Cu = await u.newContainer("usage-unclaimed.test");
    await c.newContainer("usage-claimed.test");
    for (const n of [1, 2]) await collect("usage-unclaimed.test", Cu, { type: "visit", event_id: `usage_unc_${n}` });
    // A draft with custom code (saved; publishing it would need a verified domain and a claimed account).
    const html = "<script>console.log('hi')</script>";
    const draft = {
      triggers: [{ id: "all_pages", type: "page_view" }],
      tags: [{ id: "c", type: "custom_html", params: { html }, triggers: ["all_pages"] }],
    };
    expect((await u.api("PUT", `/v1/containers/${Cu}/draft`, draft)).status).toBe(200);

    const unclaimed = await getUsage({ ...E, ...vars } as Bindings, u.accountId);
    expect(unclaimed.claimed).toBe(false);
    expect(unclaimed.limits.browser_events_per_container_per_day).toMatchObject({ used: 2, limit: 10, remaining: 8 });
    expect(unclaimed.limits.containers).toMatchObject({ used: 1, limit: 3, remaining: 2 });
    expect(unclaimed.limits.deliveries_per_day).toMatchObject({ used: 0, limit: 50, remaining: 50 });
    expect(unclaimed.limits.custom_code_bytes).toMatchObject({
      used: html.length,
      limit: 1000,
      remaining: 1000 - html.length,
      per: [{ id: Cu, label: "usage-unclaimed.test", used: html.length, remaining: 1000 - html.length }],
    });
    // Deployment-wide budgets stay out even when set.
    expect(Object.values(unclaimed.limits).map((i) => i.var)).not.toContain("MAX_EVENTS_PER_DAY");
    expect(Object.values(unclaimed.limits).map((i) => i.var)).not.toContain("MAX_DELIVERIES_PER_DAY");

    const claimed = await getUsage({ ...E, ...vars } as Bindings, c.accountId);
    expect(claimed).toMatchObject({ claimed: true, policy: { custom_code_allowed: true } });
    expect(claimed.limits.browser_events_per_container_per_day).toMatchObject({ used: 0, limit: 100, remaining: 100 });
    expect(claimed.limits.containers).toMatchObject({ used: 1, limit: 10, remaining: 9 });
    expect(claimed.next_steps.join(" ")).not.toMatch(/claim/);
    // "0" turns a cap off.
    const off = await getUsage({ ...E, MAX_DESTINATIONS_PER_CONTAINER: "0" } as Bindings, c.accountId);
    expect(off.limits.destinations_per_container).toMatchObject({ limit: null, remaining: null, per: [{ remaining: null }] });
  });

  it("caps per at 25 containers, highest first", async () => {
    const a = await account();
    const ids: string[] = [];
    for (let n = 0; n < PER_MAX + 2; n++) ids.push(await a.newContainer(`usage-many-${n}.test`));
    // The newest container gets the most hits, so it leads despite being created last.
    const last = ids[ids.length - 1]!;
    for (const n of [1, 2]) await collect(`usage-many-${PER_MAX + 1}.test`, last, { type: "visit", event_id: `usage_many_${n}` });
    const L = (await a.usage()).limits;
    expect(L.containers.used).toBe(PER_MAX + 2);
    expect(L.browser_events_per_container_per_day.per).toHaveLength(PER_MAX);
    expect(L.browser_events_per_container_per_day.per![0]).toMatchObject({ id: last, used: 2 });
    const rest = (await oldestFirst(a.accountId)).filter((id) => id !== last);
    expect(L.browser_events_per_container_per_day.per!.slice(1).map((p) => p.id)).toEqual(rest.slice(0, PER_MAX - 1));
  });

  it("works with a read key, over MCP, and for the platform's internal calls", async () => {
    const a = await account();
    await a.newContainer("usage-read.test");
    const read = await a.api("POST", "/v1/keys", { scope: "read" });
    expect(read.status, JSON.stringify(read.body)).toBe(201);
    const viaRead = await a.call(read.body.api_key)("GET", "/v1/usage");
    expect(viaRead.status).toBe(200);
    expect(viaRead.body.limits.containers.used).toBe(1);

    const mcp = async (key: string, method: string, params?: Record<string, unknown>) =>
      (
        await json(
          await SELF.fetch(`${B}/mcp`, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
          }),
        )
      ).result;
    const tools = (await mcp(read.body.api_key, "tools/list")).tools as { name: string; description: string }[];
    expect(tools.find((t) => t.name === "get_usage")?.description).toMatch(/drops_data: true.*per:/);
    const got = JSON.parse((await mcp(read.body.api_key, "tools/call", { name: "get_usage", arguments: {} })).content[0].text);
    expect(got.limits.containers.used).toBe(1);
    expect(got.limits.visitors_per_container.drops_data).toBe(true);

    // The site reads it hourly over the service binding with internal auth, as the account.
    const internal = await SELF.fetch("https://tags.internal/v1/usage", {
      headers: { "x-afs-internal": E.INTERNAL_TOKEN!, "x-afs-account": a.accountId },
    });
    expect(internal.status).toBe(200);
    expect((await json(internal)).limits.containers.used).toBe(1);
    expect((await SELF.fetch(`${B}/v1/usage`)).status).toBe(401);
  });
});
