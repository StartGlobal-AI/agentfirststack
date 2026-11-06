import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

const B = "http://analytics.test";
const INTERNAL = "integration-internal-token";

type Init = RequestInit & { key?: string; json?: unknown };
type Over = Record<string, unknown>;

async function callWith(over: Over, path: string, init: Init = {}, base = B) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const req = new Request(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
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
const call = (path: string, init: Init = {}) => callWith({}, path, init);

async function newAccount(): Promise<string> {
  return (await callWith({ SIGNUP_LIMITER: undefined }, "/v1/signup", { method: "POST" })).body.api_key as string;
}
async function newSite(key: string, domain: string): Promise<string> {
  const r = await call("/v1/sites", { method: "POST", key, json: { domain } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.site.id as string;
}
async function track(over: Over, key: string, site: string, events: Record<string, unknown>[]) {
  const r = await callWith(over, `/v1/sites/${site}/events`, { method: "POST", key, json: { events } });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return r.body;
}
async function tool(key: string, name: string, args: Record<string, unknown> = {}) {
  const r = await call("/mcp", {
    method: "POST",
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return { isError: !!r.body.result.isError, data: JSON.parse(r.body.result.content[0].text) };
}

const ACCOUNT_CAPS = ["events_per_account_per_day", "crawl_hits_per_account_per_day", "sites_per_account"];
const SITE_CAPS = [
  "events_per_site_per_day",
  "storage_bytes",
  "goals_per_site",
  "funnels_per_site",
  "segments_per_site",
  "share_links_per_site",
  "annotations_per_site",
  "alerts_per_site",
  "alert_destinations_per_site",
  "reports_per_site",
  "alert_deliveries_per_site_per_day",
  "alert_emails_per_site_per_day",
  "events_per_network_per_site_per_day",
  "quarantined_events_per_site_per_day",
  "cost_rows_per_site",
  "imported_rows_per_site",
  "imports_per_site",
  "user_prop_keys_per_site",
  "browser_user_prop_keys_per_site",
  "crawl_hits_per_site_per_day",
  "export_rows_per_site_per_day",
];
const DROPS_DATA = [
  "events_per_site_per_day",
  "events_per_account_per_day",
  "storage_bytes",
  "user_prop_keys_per_site",
  "browser_user_prop_keys_per_site",
  "crawl_hits_per_site_per_day",
  "crawl_hits_per_account_per_day",
];

describe("GET /v1/usage and get_usage", () => {
  it("lists every account and per-site cap with label, used, per (highest first) and drops_data; counts move with ingest", async () => {
    const key = await newAccount();
    const a = await newSite(key, "usage-a.test");
    const b = await newSite(key, "usage-b.test");
    await track({}, key, a, [{ name: "signup", user_id: "u1", user_props: { plan: "pro", seats: "3" } }, { name: "a" }, { name: "b" }]);
    await track({}, key, b, [{ name: "a" }]);
    expect(
      (await call(`/v1/sites/${b}/goals`, { method: "POST", key, json: { name: "Signup", type: "event", match: "signup" } })).status,
    ).toBe(201);
    expect((await call(`/v1/sites/${b}/annotations`, { method: "POST", key, json: { title: "Launch" } })).status).toBe(201);

    const now = Date.now();
    const r = await call("/v1/usage", { key });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const u = r.body;
    const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    expect(u).toMatchObject({ day: new Date(now).toISOString().slice(0, 10), resets_at: midnight, claimed: false, sites: 2 });
    expect(u.resets_at_iso).toBe(new Date(midnight).toISOString());
    expect(Object.keys(u.limits).sort()).toEqual([...ACCOUNT_CAPS, ...SITE_CAPS].sort());

    for (const [name, it] of Object.entries<any>(u.limits)) {
      expect(typeof it.label, name).toBe("string");
      expect(it.label.length, name).toBeGreaterThan(3);
      expect(it.label[0], name).toBe(it.label[0].toUpperCase());
      expect(typeof it.unit, name).toBe("string");
      expect(it.var, name).toMatch(/^MAX_[A-Z_]+$/);
      expect(it.resets_at, name).toBe(name.endsWith("_per_day") ? midnight : null);
      expect(!!it.drops_data, name).toBe(DROPS_DATA.includes(name));
      if (it.drops_data) expect(it.drops_data).toBe(true);
      if (it.limit === null) expect(it.remaining, name).toBeNull();
      else expect(it.remaining, name).toBe(Math.max(0, it.limit - it.used));
      if (SITE_CAPS.includes(name)) {
        // every site, highest use first; used = the top one
        expect(it.per.map((p: any) => p.id).sort(), name).toEqual([a, b].sort());
        for (let i = 1; i < it.per.length; i++) expect(it.per[i - 1].used, name).toBeGreaterThanOrEqual(it.per[i].used);
        expect(it.used, name).toBe(it.per[0].used);
        for (const p of it.per) expect(p.label, name).toBe(p.id === a ? "usage-a.test" : "usage-b.test");
      } else expect(it.per, name).toBeUndefined();
    }
    // Deployment-wide budgets are the deployment's volume, not the account's.
    expect(JSON.stringify(u)).not.toContain("DAILY_EVENT_BUDGET");
    expect(JSON.stringify(u)).not.toContain('MAX_CRAWL_HITS_PER_DAY"');

    const L = u.limits;
    // The test env neutralises the event and storage caps (limit null); code defaults show.
    expect(L.events_per_site_per_day).toMatchObject({ used: 3, limit: null, remaining: null, var: "MAX_EVENTS_PER_SITE_PER_DAY" });
    expect(L.events_per_site_per_day.per).toEqual([
      { id: a, label: "usage-a.test", used: 3, remaining: null },
      { id: b, label: "usage-b.test", used: 1, remaining: null },
    ]);
    expect(L.events_per_account_per_day).toMatchObject({ used: 4, limit: null });
    expect(L.storage_bytes.used).toBeGreaterThan(0);
    expect(L.storage_bytes.var).toBe("MAX_SITE_STORAGE_MB");
    expect(L.goals_per_site).toMatchObject({ used: 1, limit: 100, remaining: 99 });
    expect(L.goals_per_site.per[0]).toEqual({ id: b, label: "usage-b.test", used: 1, remaining: 99 });
    expect(L.annotations_per_site).toMatchObject({ used: 1, limit: null });
    expect(L.annotations_per_site.per[0].id).toBe(b);
    expect(L.user_prop_keys_per_site).toMatchObject({ used: 2, limit: 50, remaining: 48 });
    expect(L.browser_user_prop_keys_per_site).toMatchObject({ used: 0, limit: 20 });
    expect(L.sites_per_account).toMatchObject({ used: 2, limit: null, label: "Sites" });

    // With caps set (UNCLAIMED_ forms apply to this unclaimed account), and B overtaking A.
    const caps = {
      MAX_EVENTS_PER_SITE_PER_DAY: "100",
      UNCLAIMED_MAX_EVENTS_PER_SITE_PER_DAY: "10",
      MAX_EVENTS_PER_ACCOUNT_PER_DAY: "50",
      MAX_SITE_STORAGE_MB: "64",
      MAX_SITES_PER_ACCOUNT: "5",
      DAILY_EVENT_BUDGET: "100000",
    };
    await track(caps, key, b, [{ name: "c" }, { name: "d" }, { name: "e" }]);
    const capped = (await callWith(caps, "/v1/usage", { key })).body.limits;
    expect(capped.events_per_site_per_day).toMatchObject({ used: 4, limit: 10, remaining: 6 });
    expect(capped.events_per_site_per_day.per).toEqual([
      { id: b, label: "usage-b.test", used: 4, remaining: 6 },
      { id: a, label: "usage-a.test", used: 3, remaining: 7 },
    ]);
    expect(capped.events_per_account_per_day).toMatchObject({ used: 7, limit: 50, remaining: 43 });
    expect(capped.storage_bytes.limit).toBe(64 * 1024 * 1024);
    expect(capped.storage_bytes.per.every((p: any) => p.remaining === 64 * 1024 * 1024 - p.used)).toBe(true);
    expect(capped.sites_per_account).toMatchObject({ used: 2, limit: 5, remaining: 3 });
    expect(JSON.stringify(capped)).not.toContain("DAILY_EVENT_BUDGET");

    // MCP: the same answer.
    const m = await tool(key, "get_usage");
    expect(m.isError).toBe(false);
    expect(Object.keys(m.data.limits).sort()).toEqual(Object.keys(u.limits).sort());
    expect(m.data.limits.events_per_site_per_day.per[0]).toMatchObject({ id: b, used: 4 });
  });

  it("works with a read key (REST and MCP) and over internal auth, the way the platform site calls it", async () => {
    const key = await newAccount();
    const site = await newSite(key, "usage-ro.test");
    await track({}, key, site, [{ name: "a" }, { name: "b" }]);
    const ro = (await call("/v1/keys", { method: "POST", key, json: { name: "ro", scope: "read" } })).body.api_key as string;
    const rest = await call("/v1/usage", { key: ro });
    expect(rest.status).toBe(200);
    expect(rest.body.limits.events_per_site_per_day).toMatchObject({ used: 2, per: [{ id: site, label: "usage-ro.test", used: 2 }] });
    const listed = await call("/mcp", {
      method: "POST",
      key: ro,
      headers: { accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect((listed.body.result.tools as { name: string }[]).map((t) => t.name)).toContain("get_usage");
    expect((await tool(ro, "get_usage")).data.limits.events_per_account_per_day.used).toBe(2);
    const me = (await call("/v1/me", { key })).body;
    const internal = await callWith(
      { INTERNAL_TOKEN: INTERNAL },
      "/v1/usage",
      { headers: { "x-afs-internal": INTERNAL, "x-afs-account": me.account.id } },
      "https://analytics.internal",
    );
    expect(internal.status, JSON.stringify(internal.body)).toBe(200);
    expect(internal.body.limits.events_per_site_per_day.used).toBe(2);
    // An account with no sites: zeros, empty per lists.
    const empty = (await call("/v1/usage", { key: await newAccount() })).body;
    expect(empty.sites).toBe(0);
    expect(empty.limits.storage_bytes).toMatchObject({ used: 0, per: [] });
    expect(empty.limits.events_per_account_per_day.used).toBe(0);
  });

  it("llms.txt documents the endpoint, its fields and the tool", async () => {
    const llms = (await call("/llms.txt")).body as string;
    for (const s of ["| GET | /v1/usage |", "drops_data", "get_usage", "per`: every site"]) expect(llms).toContain(s);
  });
});
