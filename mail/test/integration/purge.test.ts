import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { forgetStanding } from "@afs/shared";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../src/env";
import { app } from "../../src/index";
import { pruneCounters } from "../../src/service/inboxes";
import { purgeAccount } from "../../src/service/purge";
import { E, acctOf, call, deliver, eml, errorOf, hosted, signup, uniq } from "./helpers";

// Erasing a deleted project's mail (DELETE /v1/account, src/service/purge.ts) and the permanent
// reservation of its addresses (migrations/0015).

const DAY = 86_400_000;
const TOKEN = "internal-test-token";
const env = hosted({ INTERNAL_TOKEN: TOKEN } as Partial<AppEnv>);

/** What the site sends over its service binding. */
async function internal(method: string, path: string, accountId: string) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://mail.internal${path}`, { method, headers: { "x-afs-internal": TOKEN, "x-afs-account": accountId } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as any };
}

/** The platform deleted the project 8 days ago (the identity DB's row, as the site writes it). */
async function deleteProject(accountId: string) {
  const now = Date.now();
  await E.AUTH_DB!.prepare("UPDATE accounts SET deleted_at = ?, purge_after = ? WHERE id = ?")
    .bind(now - 8 * DAY, now - DAY, accountId)
    .run();
  forgetStanding(accountId);
}

const mail = (to: string) =>
  eml({ from: "noreply@github.com", to, subject: "Reset your password", body: "Reset it here: https://github.com/reset?t=123" });

async function count(sql: string, ...binds: unknown[]) {
  return (
    (
      await E.DB.prepare(sql)
        .bind(...binds)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

const tombstone = (address: string) =>
  E.DB.prepare("SELECT * FROM address_tombstones WHERE address = ?")
    .bind(address)
    .first<{ account_id: string; deleted_at: number; permanent: number }>();

describe("DELETE /v1/account", () => {
  it("erases a deleted project's mail and reserves its addresses that received mail for good", async () => {
    const s = await signup();
    const acct = acctOf(s);
    const other = await signup();
    await deliver("noreply@github.com", other.inbox.address, mail(other.inbox.address));

    // The project: a webhook, a list entry, a custom domain claim, an inbox that received mail, one
    // that didn't (plus the default inbox, which didn't either), and an address it deleted itself
    // earlier (a 90-day tombstone).
    const hook = await call("POST", "/v1/webhooks", { key: s.key, body: { url: "https://hooks.example.com/purge" } });
    expect(hook.status).toBe(201);
    expect((await call("POST", "/v1/lists/receive/block", { key: s.key, body: { entry: "spam.example" } })).status).toBe(201);
    expect((await call("POST", "/v1/domains", { key: s.key, body: { domain: `${uniq("purge")}.example` } })).status).toBe(201);
    const used = (await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("used") } })).json.inbox;
    const fresh = (await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("fresh") } })).json.inbox;
    const earlier = (await call("POST", "/v1/inboxes", { key: s.key, body: { username: uniq("earlier") } })).json.inbox;
    for (const a of [used.address, used.address, earlier.address]) await deliver("noreply@github.com", a, mail(a));
    const del = await call("DELETE", `/v1/inboxes/${earlier.id}`, { key: s.key });
    expect(del.json.address_reserved_until).toBeGreaterThan(Date.now());
    // Rows the API creates only in passing: a wait slot and an Idempotency-Key replay.
    await E.DB.batch([
      E.DB.prepare("INSERT INTO active_waits (id, account_id, inbox_id, expires_at) VALUES (?, ?, ?, ?)").bind(
        uniq("wait"),
        acct,
        used.id,
        Date.now() + 60_000,
      ),
      E.DB.prepare(
        "INSERT INTO send_keys (account_id, key, body_hash, response_json, created_at, expires_at) VALUES (?, ?, 'h', '{}', ?, ?)",
      ).bind(acct, uniq("idem"), Date.now(), Date.now() + DAY),
      E.DB.prepare("INSERT INTO send_counters (account_id, day, count) VALUES (?, '2026-11-01', 3)").bind(acct),
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE account_id = ?", acct)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE account_id = ?", acct)).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?", hook.json.webhook.id)).toBeGreaterThan(0);
    expect((await E.BLOBS.list({ prefix: `inbox/${used.id}/` })).objects.length).toBeGreaterThan(0);

    await deleteProject(acct);
    const r = await internal("DELETE", "/v1/account", acct);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      account_id: acct,
      done: true,
      deleted: { inboxes: 3, messages: 2, domains: 1, webhooks: 1, list_entries: 1, send_keys: 1, active_waits: 1 },
      // used (deleted now) and earlier (its tombstone made permanent); fresh and the default never received mail.
      addresses_reserved: 2,
    });
    expect(r.json.deleted.blobs).toBeGreaterThan(0);
    expect(r.json.deleted.webhook_deliveries).toBeGreaterThan(0);

    // Everything is gone; the accounts mirror row and the fair-use counters stay.
    for (const t of [
      "inboxes",
      "messages",
      "threads",
      "domains",
      "webhooks",
      "list_entries",
      "send_keys",
      "deliveries",
      "events",
      "forward_queue",
      "active_waits",
    ]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`, acct), t).toBe(0);
    }
    expect(await count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?", hook.json.webhook.id)).toBe(0);
    for (const id of [used.id, fresh.id, s.inbox.id]) expect((await E.BLOBS.list({ prefix: `inbox/${id}/` })).objects).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE id = ?", acct)).toBe(1);
    expect(await count("SELECT count AS n FROM send_counters WHERE account_id = ?", acct)).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM account_usage WHERE account_id = ?", acct)).toBe(1);

    // The addresses that received mail are reserved for good: past the 90-day window, after the
    // cron, another account still gets the same 409 as for a taken address.
    for (const a of [used.address, earlier.address]) expect(await tombstone(a)).toMatchObject({ account_id: acct, permanent: 1 });
    await E.DB.prepare("UPDATE address_tombstones SET deleted_at = ? WHERE account_id = ?")
      .bind(Date.now() - 400 * DAY, acct)
      .run();
    await pruneCounters(E);
    for (const inbox of [used, earlier]) {
      const again = await call("POST", "/v1/inboxes", { key: other.key, body: { username: inbox.username } });
      expect(again.status, inbox.address).toBe(409);
      expect(again.json.error.code).toBe("conflict");
    }
    // The ones that never received mail are free.
    for (const address of [fresh.address, s.inbox.address]) {
      const take = await call("POST", "/v1/inboxes", { key: other.key, body: { username: address.split("@")[0] } });
      expect(take.status, address).toBe(201);
    }

    // Again: nothing left, nothing counted.
    const twice = await internal("DELETE", "/v1/account", acct);
    expect(twice.status).toBe(200);
    expect(twice.json.done).toBe(true);
    expect(twice.json.addresses_reserved).toBe(0);
    expect(Object.values(twice.json.deleted).every((n) => n === 0)).toBe(true);

    // The other account's inbox and mail are untouched.
    const theirs = await call("GET", `/v1/inboxes/${other.inbox.id}`, { key: other.key });
    expect(theirs.status).toBe(200);
    expect(theirs.json.inbox.message_count).toBe(1);
  });

  it("an API key gets 403 with a hint, and nothing is erased", async () => {
    const s = await signup();
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address));
    const r = await call("DELETE", "/v1/account", { key: s.key });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("forbidden");
    expect(r.json.error.hint).toMatch(/DELETE https:\/\/agentfirststack\.com\/v1\/me/);
    expect(r.json.error.hint).toMatch(/reserved for good/);
    expect((await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key })).json.inbox.message_count).toBe(1);
  });

  it("a live (not deleted) project gets 409 not_deleted and keeps its data", async () => {
    const s = await signup();
    const acct = acctOf(s);
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address));
    const r = await internal("DELETE", "/v1/account", acct);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: "not_deleted" });
    expect(r.json.error.hint).toMatch(/deleted on the platform first/);
    expect((await errorOf(purgeAccount(E, acct))).code).toBe("not_deleted");
    expect((await call("GET", `/v1/inboxes/${s.inbox.id}`, { key: s.key })).json.inbox.message_count).toBe(1);
    expect(await tombstone(s.inbox.address)).toBeNull();
  });

  it("works within its time budget: done false while work is left, every call makes progress", async () => {
    const s = await signup();
    const acct = acctOf(s);
    for (const u of [uniq("b1"), uniq("b2")]) await call("POST", "/v1/inboxes", { key: s.key, body: { username: u } });
    await deleteProject(acct);
    const calls = [];
    for (let i = 0; i < 10; i++) {
      const r = await purgeAccount(E, acct, { budgetMs: 0 });
      calls.push(r);
      if (r.done) break;
    }
    // One inbox per call (the budget is spent), and the last call finishes the rest.
    expect(calls.map((r) => [r.done, r.deleted.inboxes])).toEqual([
      [false, 1],
      [false, 1],
      [true, 1],
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM inboxes WHERE account_id = ?", acct)).toBe(0);
    const after = await purgeAccount(E, acct, { budgetMs: 0 });
    expect(after.done).toBe(true);
    expect(after.deleted.inboxes).toBe(0);
  });
});

describe("tombstone expiry cron (pruneCounters)", () => {
  it("prunes expired tombstones and never a permanent one; createInbox reads them the same way", async () => {
    const owner = `acct_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const expired = `${uniq("expired")}@mail.example.com`;
    const live = `${uniq("live")}@mail.example.com`;
    const permanent = `${uniq("forever")}@mail.example.com`;
    const old = Date.now() - 365 * DAY;
    await E.DB.batch([
      E.DB.prepare("INSERT INTO address_tombstones (address, account_id, deleted_at, permanent) VALUES (?, ?, ?, 0)").bind(
        expired,
        owner,
        old,
      ),
      E.DB.prepare("INSERT INTO address_tombstones (address, account_id, deleted_at, permanent) VALUES (?, ?, ?, 0)").bind(
        live,
        owner,
        Date.now() - DAY,
      ),
      E.DB.prepare("INSERT INTO address_tombstones (address, account_id, deleted_at, permanent) VALUES (?, ?, ?, 1)").bind(
        permanent,
        owner,
        old,
      ),
    ]);
    // Before the cron runs: an expired tombstone already frees its address, a permanent one never does.
    const s = await signup();
    const create = (address: string) => call("POST", "/v1/inboxes", { key: s.key, body: { username: address.split("@")[0] } });
    expect((await create(permanent)).status).toBe(409);
    expect((await create(live)).status).toBe(409);
    expect((await create(expired)).status).toBe(201);

    const r = await pruneCounters(E);
    expect(r.tombstones_pruned).toBeGreaterThanOrEqual(1);
    expect(await tombstone(expired)).toBeNull();
    expect(await tombstone(live)).toMatchObject({ permanent: 0 });
    expect(await tombstone(permanent)).toMatchObject({ permanent: 1, deleted_at: old });
    expect((await create(permanent)).status).toBe(409);
  });

  it("a permanent reservation is never downgraded by a later delete of the same address", async () => {
    // The original account is erased, so it can't recreate the address; were it ever recreated and
    // deleted again, the upsert keeps permanent = 1.
    const s = await signup();
    await deliver("noreply@github.com", s.inbox.address, mail(s.inbox.address));
    await E.DB.prepare("INSERT INTO address_tombstones (address, account_id, deleted_at, permanent) VALUES (?, ?, ?, 1)")
      .bind(s.inbox.address, acctOf(s), Date.now() - 400 * DAY)
      .run();
    const d = await call("DELETE", `/v1/inboxes/${s.inbox.id}`, { key: s.key });
    expect(d.status).toBe(200);
    expect(await tombstone(s.inbox.address)).toMatchObject({ permanent: 1 });
  });
});
