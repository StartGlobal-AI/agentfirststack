import { forgetStanding } from "@afs/shared";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { app } from "../../src/index";
import { siteStub } from "../../src/service/context";
import { purgeAccount, runPurge } from "../../src/service/purge";
import { meta, page, snapshot } from "../fixtures/rrweb";
import { call, E, hosted, markVerified, newSid, newSite, sendChunk, signup } from "./helpers";

const TOKEN = "test-internal-0123456789";

/** DELETE /v1/account as the site's purge cron sends it: a service binding with internal auth. */
async function internalDelete(account: string, env: Bindings) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("https://replay.internal/v1/account", {
      method: "DELETE",
      headers: { "x-afs-internal": TOKEN, "x-afs-account": account },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as any };
}

/** What the platform's DELETE /v1/me does to the identity row: keys and ingest stop at once. */
async function markDeleted(account: string) {
  const now = Date.now();
  await (E.AUTH_DB ?? E.DB)
    .prepare("UPDATE accounts SET deleted_at = ?, purge_after = ? WHERE id = ?")
    .bind(now, now + 7 * 86_400_000, account)
    .run();
  forgetStanding(account);
}

/** One more (verified) site on the account: only one unverified site per account is allowed. */
async function addSite(key: string, domain: string) {
  const r = await call("POST", "/v1/sites", { key, body: { domain } });
  expect(r.status).toBe(201);
  await markVerified(r.json.site.id);
  return r.json.site.id as string;
}

async function record(site: string, domain: string) {
  const sid = newSid();
  const T = Date.now() - 60_000;
  const r = await sendChunk(site, sid, 0, [meta(T, `https://${domain}/`), snapshot(T + 1), page(T + 5, 1, "/", { h: domain })], {
    origin: `https://${domain}`,
  });
  expect(r.status).toBe(202);
  return sid;
}

const count = async (sql: string, ...args: unknown[]) =>
  (
    await E.DB.prepare(sql)
      .bind(...args)
      .first<{ n: number }>()
  )?.n ?? 0;

const DAY = new Date().toISOString().slice(0, 10);

describe("DELETE /v1/account (project deletion purge)", () => {
  it("erases a deleted account's sites, recordings and account-level rows; keeps the mirror and counters; leaves others alone", async () => {
    // The deleted project: two sites (one with a session and a share link), webhooks, a verify call.
    const { key, account } = await signup();
    const siteA = await addSite(key, "purge-a.test");
    const siteB = await addSite(key, "purge-b.test");
    const sid = await record(siteA, "purge-a.test");
    expect((await E.CHUNKS.list({ prefix: `${siteA}/` })).objects.length).toBeGreaterThan(0);
    const link = await call("POST", `/v1/sites/${siteA}/links`, { key, body: { session_id: sid } });
    expect(link.status).toBe(201);
    const play = new URL(link.json.link.url).pathname;
    expect((await call("GET", play)).status).toBe(200);
    const hook = await call("POST", "/v1/webhooks", { key, body: { url: "https://hooks.example.test/all", events: ["error.new"] } });
    expect(hook.status).toBe(201);
    const siteHook = await call("POST", "/v1/webhooks", {
      key,
      body: { url: "https://hooks.example.test/b", events: ["error.new"], site_id: siteB },
    });
    expect(siteHook.status).toBe(201);
    const now = Date.now();
    await E.DB.batch([
      // a test delivery of the account-level webhook (site_id NULL)
      E.DB.prepare(
        "INSERT INTO webhook_deliveries (id, webhook_id, account_id, site_id, event_id, event_type, payload, status, attempts, next_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'webhook.test', '{}', 'delivered', 1, ?, ?, ?)",
      ).bind("whd_purgetest00000001", hook.json.webhook.id, account, "evt_purgetest0000001", now, now, now),
      E.DB.prepare("INSERT INTO verify_log (account_id, created_at) VALUES (?, ?)").bind(account, now),
      E.DB.prepare(
        "INSERT INTO account_usage (account_id, day, sessions, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(account_id, day) DO NOTHING",
      ).bind(account, DAY, now),
      // linked to an analytics site: the purge must not call analytics about it
      E.DB.prepare("UPDATE sites SET analytics_site_id = 'site_0123456789abcdef' WHERE id = ?").bind(siteA),
    ]);

    // Another project, which must come through untouched.
    const other = await newSite("purge-other.test");
    const otherSid = await record(other.site, "purge-other.test");
    expect(
      (await call("POST", "/v1/webhooks", { key: other.key, body: { url: "https://hooks.example.test/o", events: ["error.new"] } })).status,
    ).toBe(201);

    const analyticsCalls: string[] = [];
    const ANALYTICS = {
      fetch: async (req: Request) => {
        analyticsCalls.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ error: { code: "project_deleted" } }, { status: 403 });
      },
    } as unknown as Fetcher;
    const env = hosted({ INTERNAL_TOKEN: TOKEN, ANALYTICS });

    // API keys can't call it, whatever the project.
    const denied = await call("DELETE", "/v1/account", { key: other.key, env });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("forbidden");
    expect(denied.json.error.hint).toContain("DELETE https://agentfirststack.com/v1/me");
    expect(denied.json.error.hint).toContain("erased 7 days later");

    await markDeleted(account);
    // Deleted, not yet purged: the key, recording and the share link stop at once.
    expect((await call("GET", "/v1/sites", { key })).json.error.code).toBe("project_deleted");
    expect((await sendChunk(siteA, newSid(), 0, [snapshot(Date.now())], { origin: "https://purge-a.test" })).status).toBe(403);
    expect((await call("GET", play)).status).toBe(404);
    expect((await call("GET", `${play}/data`)).status).toBe(404);

    const purged = await internalDelete(account, env);
    expect(purged.status).toBe(200);
    expect(purged.json).toMatchObject({
      account_id: account,
      done: true,
      deleted: { sites: 2, replay_links: 1, webhooks: 2, webhook_deliveries: 1, verify_log: 1 },
      r2_prefixes_queued: 6,
    });
    expect(analyticsCalls).toEqual([]);

    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE account_id = ?", account)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM webhooks WHERE account_id = ?", account)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE account_id = ?", account)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM replay_links WHERE account_id = ?", account)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM verify_log WHERE account_id = ?", account)).toBe(0);
    const { results: queued } = await E.DB.prepare("SELECT prefix FROM r2_cleanup WHERE prefix LIKE ? OR prefix LIKE ?")
      .bind(`%${siteA}/`, `%${siteB}/`)
      .all<{ prefix: string }>();
    expect(queued.map((r) => r.prefix).sort()).toEqual(
      [`${siteA}/`, `${siteB}/`, `heatmaps/${siteA}/`, `heatmaps/${siteB}/`, `starred/${siteA}/`, `starred/${siteB}/`].sort(),
    );
    // The site's Durable Object is a tombstone: no session left.
    expect(await siteStub(E, siteA).session(sid)).toBeNull();
    // Kept: the bare account mirror and the fair-use counters.
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", account)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM account_usage WHERE account_id = ?", account)).toBeGreaterThan(0);

    // Again: nothing left, nothing to do.
    const again = await internalDelete(account, env);
    expect(again.status).toBe(200);
    expect(again.json.done).toBe(true);
    expect(again.json.r2_prefixes_queued).toBe(0);
    expect(Object.values(again.json.deleted).every((n) => n === 0)).toBe(true);

    // The hourly cron deletes the queued prefixes; nothing about it needs the account.
    for (let i = 0; i < 5 && (await count("SELECT COUNT(*) AS n FROM r2_cleanup WHERE prefix = ?", `${siteA}/`)); i++) await runPurge(E);
    expect(await count("SELECT COUNT(*) AS n FROM r2_cleanup WHERE prefix LIKE ? OR prefix LIKE ?", `%${siteA}/`, `%${siteB}/`)).toBe(0);
    expect((await E.CHUNKS.list({ prefix: `${siteA}/` })).objects).toHaveLength(0);

    // The other project: its site, session, recording and webhook are all still there.
    const sessions = await call("GET", `/v1/sites/${other.site}/sessions`, { key: other.key });
    expect(sessions.json.total).toBe(1);
    expect(sessions.json.sessions[0].id).toBe(otherSid);
    expect((await E.CHUNKS.list({ prefix: `${other.site}/` })).objects.length).toBeGreaterThan(0);
    expect((await call("GET", "/v1/webhooks", { key: other.key })).json.webhooks).toHaveLength(1);
  });

  it("refuses a live project (409 not_deleted) and keeps all its data", async () => {
    const live = await newSite("purge-live.test");
    const sid = await record(live.site, "purge-live.test");
    const env = hosted({ INTERNAL_TOKEN: TOKEN });
    const r = await internalDelete(live.account, env);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: "not_deleted", message: "This project isn't deleted, so its data isn't erased." });
    expect(r.json.error.hint).toContain("DELETE https://agentfirststack.com/v1/me");
    await expect(purgeAccount(E, live.account)).rejects.toMatchObject({ status: 409, code: "not_deleted" });
    // A suspended (not deleted) project isn't erased either; internal auth already refuses writes for it.
    await (E.AUTH_DB ?? E.DB).prepare("UPDATE accounts SET suspended_at = ? WHERE id = ?").bind(Date.now(), live.account).run();
    forgetStanding(live.account);
    await expect(purgeAccount(E, live.account)).rejects.toMatchObject({ status: 409, code: "not_deleted" });
    await (E.AUTH_DB ?? E.DB).prepare("UPDATE accounts SET suspended_at = NULL WHERE id = ?").bind(live.account).run();
    forgetStanding(live.account);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE account_id = ?", live.account)).toBe(1);
    expect(await siteStub(E, live.site).session(sid)).not.toBeNull();
    expect((await E.CHUNKS.list({ prefix: `${live.site}/` })).objects.length).toBeGreaterThan(0);
    expect((await call("GET", `/v1/sites/${live.site}/sessions`, { key: live.key })).json.total).toBe(1);
  });

  it("works within a wall-time budget: done: false until every site is gone", async () => {
    const { key, account } = await signup();
    await addSite(key, "budget-a.test");
    await addSite(key, "budget-b.test");
    await markDeleted(account);
    // A spent budget still erases one site per call, so every call makes progress.
    const first = await purgeAccount(E, account, { budgetMs: 0 });
    expect(first).toMatchObject({ done: false, deleted: { sites: 1 }, r2_prefixes_queued: 3 });
    const second = await purgeAccount(E, account, { budgetMs: 0 });
    expect(second).toMatchObject({ done: true, deleted: { sites: 1 } });
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE account_id = ?", account)).toBe(0);
    expect(await purgeAccount(E, account)).toMatchObject({ done: true, deleted: { sites: 0, webhooks: 0 }, r2_prefixes_queued: 0 });
  });
});
