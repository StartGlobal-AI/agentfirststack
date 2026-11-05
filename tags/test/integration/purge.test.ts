import { createAccount, forgetStanding } from "@afs/shared";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchMessage } from "../../src/do/container-do";
import type { Bindings } from "../../src/env";
import { createContainer } from "../../src/service/containers";
import { sampleEvent } from "../../src/service/destinations";
import { handleDispatchBatch } from "../../src/service/dispatch";
import { purgeAccount } from "../../src/service/purge";

const B = "https://tags.test";
const E = env as unknown as Bindings;
const UA = "Mozilla/5.0 Chrome/130";
const granted = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" };
const HINT =
  "Projects are deleted on the platform: the owner deletes it from the dashboard, or an agent of an unclaimed project calls DELETE https://agentfirststack.com/v1/me. This app's data is erased 7 days later.";

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** Deliveries never leave the isolate: record them. */
let sent: string[] = [];
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    sent.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return Response.json({ ok: true });
  });
});
afterEach(() => vi.restoreAllMocks());

/** A fresh account straight in the identity DB (no signup rate limit), with an API client. */
async function account() {
  const { accountId, apiKey } = await createAccount(E.AUTH_DB, { keyPrefix: "afs" });
  const H = { authorization: `Bearer ${apiKey.key}`, "content-type": "application/json" };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await SELF.fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await json(res) };
  };
  return { accountId, api };
}

/** What the platform's purge sends: over the service binding, with internal auth as the account. */
const purge = (accountId: string) =>
  SELF.fetch("https://tags.internal/v1/account", {
    method: "DELETE",
    headers: { "x-afs-internal": E.INTERNAL_TOKEN!, "x-afs-account": accountId },
  });

/** Delete the project the way the site does (identity DB), and drop its cached standing. */
async function markDeleted(accountId: string, now = Date.now()) {
  await E.AUTH_DB.prepare("UPDATE accounts SET deleted_at = ?, purge_after = ? WHERE id = ?")
    .bind(now, now + 7 * 86_400_000, accountId)
    .run();
  forgetStanding(accountId);
}

const collect = (domain: string, C: string, body: object) =>
  SELF.fetch(`${B}/collect`, {
    method: "POST",
    headers: { origin: `https://${domain}`, "user-agent": UA },
    body: JSON.stringify({ container_id: C, consent: granted, ...body }),
  });

/** The container's Durable Object storage: user tables (SQLite) and its alarm. */
const storage = (C: string) =>
  runInDurableObject(E.CONTAINER.getByName(C), async (_i, state) => ({
    tables: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray().length,
    alarm: await state.storage.getAlarm(),
  }));

const rows = async (table: string, where: string, ...args: string[]) =>
  (
    await E.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .bind(...args)
      .first<{ n: number }>()
  )?.n ?? 0;

/** A container with a published draft, a webhook destination, an environment, a lookup, a preview link and one visit. */
async function configured(api: Awaited<ReturnType<typeof account>>["api"], domain: string) {
  const created = await api("POST", "/v1/containers", { domain });
  expect(created.status).toBe(201);
  const C = created.body.container.id as string;
  const dest = await api("POST", `/v1/containers/${C}/destinations`, {
    type: "webhook",
    credentials: { url: `https://hooks.test/${domain}`, secret: "integration-secret-123" },
  });
  expect(dest.status).toBe(201);
  const draft = {
    triggers: [
      { id: "all_pages", type: "page_view" },
      { id: "p", type: "custom_event", event: "purchase" },
    ],
    tags: [{ id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] }],
    conversions: [{ name: "purchase", trigger: "p", value: 10, currency: "USD", send_to: { meta: { event_name: "Purchase" } } }],
  };
  const put = await api("PUT", `/v1/containers/${C}/draft`, draft);
  expect(put.body.validation.valid, JSON.stringify(put.body.validation.errors)).toBe(true);
  expect((await api("POST", `/v1/containers/${C}/publish`, {})).status).toBe(201);
  expect((await api("POST", `/v1/containers/${C}/environments`, { name: "staging", version: 1 })).status).toBe(201);
  expect((await api("PUT", `/v1/containers/${C}/lookups/sku_margin`, { rows: { "SKU-1": 12.5 } })).status).toBe(201);
  expect((await api("POST", `/v1/containers/${C}/preview`, {})).status).toBeLessThan(300);
  expect((await collect(domain, C, { type: "visit", visitor_id: `vis_${C.slice(4, 12)}` })).status).toBe(200);
  return { C, destinationId: dest.body.destination.id as string };
}

describe("DELETE /v1/account (the platform's purge of a deleted project)", () => {
  it("erases the project's containers and their storage, repeats as done, refuses API keys, leaves other accounts alone", async () => {
    const a = await account();
    const one = await configured(a.api, "purge-one.test");
    const two = await configured(a.api, "purge-two.test");
    const other = await account();
    const kept = await configured(other.api, "purge-kept.test");
    expect((await storage(one.C)).tables).toBeGreaterThan(0);

    // An API key may never call it, not even the project's own.
    const refused = await other.api("DELETE", "/v1/account");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: "forbidden", hint: HINT });

    await markDeleted(a.accountId);
    const res = await purge(a.accountId);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({
      account_id: a.accountId,
      done: true,
      deleted: { containers: 2, destinations: 2, versions: 2, preview_tokens: 2, environments: 2, lookups: 2, api_keys: 0 },
    });

    for (const C of [one.C, two.C]) {
      for (const table of ["destinations", "container_versions", "preview_tokens", "environments", "lookups"])
        expect(await rows(table, "container_id = ?", C), `${table} of ${C}`).toBe(0);
      expect(await storage(C)).toEqual({ tables: 0, alarm: null });
      // The snippet and /collect now answer as for any unknown container.
      expect((await SELF.fetch(`${B}/c/${C}.js`)).status).toBe(404);
    }
    expect(await rows("containers", "account_id = ?", a.accountId)).toBe(0);
    // Kept: the bare account mirror (foreign keys) and the fair-use counters, which never go down.
    expect(await rows("accounts", "id = ?", a.accountId)).toBe(1);

    // A delivery still queued for a purged container is dropped quietly, and recreates no storage.
    const m = {
      id: "m1",
      timestamp: new Date(),
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
      body: {
        container_id: one.C,
        destination_id: one.destinationId,
        type: "webhook",
        test: false,
        event: sampleEvent("purchase", one.C, "purge-one.test"),
      },
    };
    await handleDispatchBatch({ queue: "q", messages: [m], ackAll() {}, retryAll() {} } as unknown as MessageBatch<DispatchMessage>, E);
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    expect(sent.filter((u) => u.startsWith("https://hooks.test/"))).toEqual([]);
    expect(await storage(one.C)).toEqual({ tables: 0, alarm: null });

    // Again: nothing left.
    const again = await purge(a.accountId);
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({
      account_id: a.accountId,
      done: true,
      deleted: { containers: 0, destinations: 0, versions: 0, preview_tokens: 0, environments: 0, lookups: 0, api_keys: 0 },
    });

    // The other account's container is untouched.
    const k = await other.api("GET", `/v1/containers/${kept.C}`);
    expect(k.status).toBe(200);
    expect(k.body.container.live_version).toBe(1);
    expect((await other.api("GET", `/v1/containers/${kept.C}/destinations`)).body.destinations).toHaveLength(1);
    expect((await storage(kept.C)).tables).toBeGreaterThan(0);
  });

  it("refuses a live project (409 not_deleted) and erases nothing", async () => {
    const live = await account();
    const { C } = await configured(live.api, "purge-live.test");
    const res = await purge(live.accountId);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({
      code: "not_deleted",
      message: "This project isn't deleted, so its data isn't erased.",
      hint: "Projects are deleted on the platform first (dashboard, or DELETE https://agentfirststack.com/v1/me); the site erases them 7 days later.",
    });
    await expect(purgeAccount(E, live.accountId)).rejects.toMatchObject({ status: 409, code: "not_deleted" });
    expect(await rows("containers", "id = ?", C)).toBe(1);
    for (const table of ["destinations", "container_versions", "preview_tokens", "environments", "lookups"])
      expect(await rows(table, "container_id = ?", C), table).toBe(1);
    expect((await storage(C)).tables).toBeGreaterThan(0);
    const got = await live.api("GET", `/v1/containers/${C}`);
    expect(got.status).toBe(200);
    expect(got.body.container.live_version).toBe(1);
  });

  it("stops at its time budget with containers left (done: false); the next call finishes", async () => {
    const { accountId } = await createAccount(E.AUTH_DB, { keyPrefix: "afs" });
    await E.DB.prepare("INSERT OR IGNORE INTO accounts (id, created_at) VALUES (?, ?)").bind(accountId, Date.now()).run();
    for (const domain of ["budget-one.test", "budget-two.test"]) await createContainer(E, accountId, { domain });
    await markDeleted(accountId);
    const out = await purgeAccount(E, accountId, { budgetMs: 0 });
    expect(out).toMatchObject({ account_id: accountId, done: false, deleted: { containers: 0 } });
    expect(await rows("containers", "account_id = ?", accountId)).toBe(2);
    const rest = await purgeAccount(E, accountId);
    expect(rest).toMatchObject({ done: true, deleted: { containers: 2 } });
    expect(await rows("containers", "account_id = ?", accountId)).toBe(0);
  });

  it("before the purge, /collect, the script and server events refuse a deleted project", async () => {
    // Deleted before anything read its standing (cached a minute per isolate).
    const { accountId, apiKey } = await createAccount(E.AUTH_DB, { keyPrefix: "afs" });
    await markDeleted(accountId);
    const now = Date.now();
    const C = "ctr_deletedproject01";
    await E.DB.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").bind(accountId, now).run();
    await E.DB.prepare(
      "INSERT INTO containers (id, account_id, domain, allowed_hostnames, draft, draft_revision, draft_updated_at, created_at, updated_at) VALUES (?, ?, 'deleted.test', '[]', '{}', 1, ?, ?, ?)",
    )
      .bind(C, accountId, now, now, now)
      .run();
    const res = await collect("deleted.test", C, { type: "visit", visitor_id: "vis_deleted_1" });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("account_suspended");
    const js = await SELF.fetch(`${B}/c/${C}.js`);
    expect(js.status).toBe(403);
    // Server events need a key, and a deleted project's keys stop at once.
    const events = await SELF.fetch(`${B}/v1/containers/${C}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey.key}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [{ name: "purchase", event_id: "evt_deleted_1" }] }),
    });
    expect(events.status).toBe(403);
    expect((await json(events)).error.code).toBe("project_deleted");
    // Data is still there until the purge.
    expect(await rows("containers", "id = ?", C)).toBe(1);
  });
});
