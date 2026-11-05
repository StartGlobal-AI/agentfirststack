import { createAccount, forgetStanding } from "@afs/shared";
import { SELF, createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { siteStub } from "../../src/service/context";
import { purgeAccount } from "../../src/service/purge";

/**
 * DELETE /v1/account: the platform's purge of a deleted project (internal auth from the site's
 * cron). Every site and its data go; other accounts, the accounts row and fair-use counters stay.
 */

const B = "http://analytics.test";
const INTERNAL = "purge-internal";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const idb = () => env.AUTH_DB ?? env.DB;

type Init = RequestInit & { key?: string; json?: unknown };
function request(path: string, init: Init = {}, base = B) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return new Request(`${base}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}
async function parsed(res: Response) {
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
const call = async (path: string, init: Init = {}) => parsed(await SELF.fetch(request(path, init)));

/** A request from another Worker of the deployment (service binding, INTERNAL_TOKEN). */
async function internal(accountId: string, path: string, method = "GET") {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    request(path, { method, headers: { "x-afs-internal": INTERNAL, "x-afs-account": accountId } }, "https://analytics.internal"),
    { ...env, INTERNAL_TOKEN: INTERNAL } as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return parsed(res);
}
const purge = (accountId: string) => internal(accountId, "/v1/account", "DELETE");

/** A project made in the identity DB (POST /v1/signup is rate limited per minute) and its key. */
async function project() {
  const { accountId, apiKey } = await createAccount(idb(), { keyPrefix: "afs", name: "purge" });
  return { key: apiKey.key, accountId };
}

const beacon = (proxyKey: string, payload: Record<string, unknown>) =>
  call("/_a/e", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "user-agent": UA, "content-type": "text/plain", "x-forwarded-for": "198.51.100.9", "x-afs-proxy-key": proxyKey },
  });

/** A site with events, a goal, a funnel, a segment (D1) and an annotation (its Durable Object). */
async function seededSite(key: string, domain: string) {
  const created = await call("/v1/sites", { method: "POST", key, json: { domain } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const site = created.body.site.id as string;
  const proxyKey = created.body.install.first_party_proxy.proxy_key as string;
  for (const path of ["/", "/pricing"]) expect((await beacon(proxyKey, { s: site, u: `https://${domain}${path}` })).body.ok).toBe(true);
  const post = async (sub: string, json: unknown) =>
    expect((await call(`/v1/sites/${site}/${sub}`, { method: "POST", key, json })).status).toBe(201);
  await post("goals", { name: "Signup", type: "event", match: "signup" });
  await post("funnels", { name: "F", steps: ["/", "event:signup"] });
  await post("segments", { name: "US", filters: "country==US" });
  await post("annotations", { date: new Date().toISOString().slice(0, 10), title: "Launch" });
  expect((await call(`/v1/sites/${site}/stats?period=24h&metrics=pageviews`, { key })).body.metrics.pageviews).toBe(2);
  return { site, proxyKey };
}

/** Rows left in the D1 tables a site owns. */
async function d1Rows(site: string): Promise<number> {
  const tables = ["sites WHERE id", "goals WHERE site_id", "funnels WHERE site_id", "segments WHERE site_id"];
  let n = 0;
  for (const t of tables) n += (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} = ?`).bind(site).first<{ n: number }>())?.n ?? 0;
  return n;
}

/** Tables left in a site's Durable Object (0 once its storage is deleted). */
const doTables = (site: string) =>
  runInDurableObject(
    siteStub(env, site) as unknown as DurableObjectStub,
    (_, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray()
        .length,
  );

async function markDeleted(accountId: string) {
  const now = Date.now();
  await idb()
    .prepare("UPDATE accounts SET deleted_at = ?, purge_after = ? WHERE id = ?")
    .bind(now, now + 7 * 86_400_000, accountId)
    .run();
  forgetStanding(accountId);
}

describe("DELETE /v1/account (purge of a deleted project)", () => {
  it("erases every site and its data, is idempotent, and leaves other accounts alone", async () => {
    const a = await project();
    const other = await project();
    const s1 = await seededSite(a.key, "purge-one.test");
    const s2 = await seededSite(a.key, "purge-two.test");
    const kept = await seededSite(other.key, "purge-kept.test");
    for (const s of [s1, s2, kept]) {
      expect(await d1Rows(s.site)).toBe(4);
      expect(await doTables(s.site)).toBeGreaterThan(0);
    }

    // Deleted, not yet purged: keys and public ingest stop at once (standing reads suspended).
    await markDeleted(a.accountId);
    const refused = await beacon(s1.proxyKey, { s: s1.site, u: "https://purge-one.test/" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("account_suspended");
    expect((await call("/v1/sites", { key: a.key })).body.error.code).toBe("project_deleted");
    // The platform's Workers may still read it (GET) and erase it (DELETE).
    expect((await internal(a.accountId, "/v1/sites")).body.sites).toHaveLength(2);
    // A stale copy of a key in this app's own DB (keys live in the identity DB) goes too.
    await env.DB.prepare("INSERT INTO api_keys (id, account_id, prefix, hash, created_at) VALUES (?, ?, 'afs_old', ?, ?)")
      .bind(`key_stale${Date.now()}`, a.accountId, `stale-${a.accountId}`, Date.now())
      .run();

    const first = await purge(a.accountId);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      account_id: a.accountId,
      done: true,
      deleted: { sites: 2, stripe_webhook_endpoints: 0, api_keys: 1 },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ?").bind(a.accountId).first("n")).toBe(0);
    for (const s of [s1, s2]) {
      expect(await d1Rows(s.site)).toBe(0);
      expect(await doTables(s.site)).toBe(0);
    }
    expect((await internal(a.accountId, "/v1/sites")).body.sites).toEqual([]);
    // Kept: the bare accounts row (foreign keys) and the fair-use counters.
    expect(await env.DB.prepare("SELECT id FROM accounts WHERE id = ?").bind(a.accountId).first()).not.toBeNull();

    // Again: nothing left, nothing to do.
    const again = await purge(a.accountId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ account_id: a.accountId, done: true, deleted: { sites: 0, stripe_webhook_endpoints: 0, api_keys: 0 } });

    // The other account's site is untouched, data and all.
    expect(await d1Rows(kept.site)).toBe(4);
    expect(await doTables(kept.site)).toBeGreaterThan(0);
    expect((await call(`/v1/sites/${kept.site}/stats?period=24h&metrics=pageviews`, { key: other.key })).body.metrics.pageviews).toBe(2);
    expect((await call(`/v1/sites/${kept.site}/annotations`, { key: other.key })).body.annotations).toHaveLength(1);
    expect((await beacon(kept.proxyKey, { s: kept.site, u: "https://purge-kept.test/" })).body.ok).toBe(true);
  });

  it("refuses API keys with 403 forbidden and a hint, and erases nothing", async () => {
    const p = await project();
    const { site } = await seededSite(p.key, "purge-key.test");
    const r = await call("/v1/account", { method: "DELETE", key: p.key });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
    expect(r.body.error.hint).toContain("DELETE https://agentfirststack.com/v1/me");
    expect(r.body.error.hint).toContain("7 days later");
    expect(await d1Rows(site)).toBe(4);
    expect(await doTables(site)).toBeGreaterThan(0);
    // The platform's own call erases only a deleted project.
    const live = await purge(p.accountId);
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe("not_deleted");
    expect(await d1Rows(site)).toBe(4);
    // Not an agent capability: no MCP tool for it.
    const tools = await call("/mcp", {
      method: "POST",
      key: p.key,
      headers: { accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const names = (tools.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("delete_site");
    expect(names.filter((n) => /account|purge/.test(n)).sort()).toEqual(["get_account_rollup", "purge_events"]);
  });

  it("stops when its time budget runs out (at least one site per call) and finishes on the next calls", async () => {
    const p = await project();
    const sites = [await seededSite(p.key, "purge-b1.test"), await seededSite(p.key, "purge-b2.test")];
    await markDeleted(p.accountId);
    const first = await purgeAccount(env, p.accountId, { budgetMs: 0 });
    expect(first).toMatchObject({ done: false, deleted: { sites: 1 } });
    const second = await purgeAccount(env, p.accountId, { budgetMs: 0 });
    expect(second).toMatchObject({ done: true, deleted: { sites: 1 } });
    for (const s of sites) {
      expect(await d1Rows(s.site)).toBe(0);
      expect(await doTables(s.site)).toBe(0);
    }
    expect(await purgeAccount(env, p.accountId, { budgetMs: 0 })).toEqual({
      account_id: p.accountId,
      done: true,
      deleted: { sites: 0, stripe_webhook_endpoints: 0, api_keys: 0 },
    });
  });
});
