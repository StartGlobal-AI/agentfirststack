import { accountStanding, forgetStanding } from "@afs/shared";
import { describe, expect, it } from "vitest";
import { addMember } from "../src/identity";
import { RESTORE_DAYS, purgeDeletedProjects, restoreProject } from "../src/project-deletion";
import { callService } from "../src/services";
import { Browser, E, call, csrfOf, failingPurges, purgeRounds, purges, signup, testEnv, uniqueEmail } from "./helpers";

const DAY = 86_400_000;
const me = (key: string) => call("GET", "/v1/me", { key });
const del = (key: string, json?: unknown) => call("DELETE", "/v1/me", { key, json });
const mcp = (key: string, name: string, args: Record<string, unknown>) =>
  call("POST", "/mcp", { key, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
const deletedAt = (id: string) =>
  E.DB.prepare("SELECT deleted_at, deleted_by, purge_after, purged_at, name FROM accounts WHERE id = ?").bind(id).first<{
    deleted_at: number | null;
    deleted_by: string | null;
    purge_after: number | null;
    purged_at: number | null;
    name: string | null;
  }>();

/** A project claimed by a signed-in owner. */
async function owned(label: string) {
  const agent = await signup(`${label}.test`);
  const link = (await call("POST", "/v1/claim-link", { key: agent.key })).json.url as string;
  const owner = new Browser();
  const path = new URL(link).pathname;
  await owner.signIn(uniqueEmail(label), path);
  const claim = await owner.get(path);
  expect((await owner.post(path, { csrf: csrfOf(claim.text) })).status).toBe(303);
  return { agent, owner, base: `/dashboard/projects/${agent.accountId}` };
}

describe("deleting a project: its agent (unclaimed projects only)", () => {
  it("needs a full key and the project's id, then stops every key and write at once", async () => {
    const agent = await signup("doomed.test");
    const read = await call("POST", "/v1/keys", { key: agent.key, json: { scope: "read" } });
    expect((await del(read.json.api_key)).status).toBe(403);
    const unconfirmed = await del(agent.key);
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.json.error.hint).toContain(agent.accountId);
    expect((await del(agent.key, { confirm: "acct_someoneelse" })).status).toBe(400);
    expect((await me(agent.key)).status).toBe(200); // nothing happened yet

    const before = Date.now();
    const r = await del(agent.key, { confirm: agent.accountId });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ deleted: true, existing: false, project_id: agent.accountId });
    expect(r.json.purge_after - r.json.deleted_at).toBe(RESTORE_DAYS * DAY);
    expect(r.json.deleted_at).toBeGreaterThanOrEqual(before);
    expect(r.json.next_steps.join(" ")).toContain("AGENTFIRSTSTACK.md");
    expect((await deletedAt(agent.accountId))?.deleted_by).toBe("agent");

    // Every key stops, with an error that says why and until when it can be undone.
    for (const key of [agent.key, read.json.api_key]) {
      const blocked = await me(key);
      expect(blocked.status).toBe(403);
      expect(blocked.json.error.code).toBe("project_deleted");
      expect(blocked.json.error.hint).toContain(new Date(r.json.purge_after).toISOString().slice(0, 10));
    }
    expect((await call("POST", "/mcp", { key: agent.key, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status).toBe(403);
    // A retry is refused the same way (the key is gone), and the dates don't move.
    expect((await del(agent.key, { confirm: agent.accountId })).json.error.code).toBe("project_deleted");

    // Public ingest reads it as stopped; the deployment's own Workers may still read and delete.
    forgetStanding(agent.accountId);
    expect(await accountStanding(E, agent.accountId)).toEqual({ suspended: true, claimed: false, deleted: true });
    const env = testEnv();
    expect((await callService(env, "tags", agent.accountId, "/v1/containers")).status).toBe(200);
    const write = await callService<{ error: { code: string } }>(env, "analytics", agent.accountId, "/v1/sites/site_x/events", {
      method: "POST",
      body: {},
    });
    expect(write.status).toBe(403);
    expect(write.json?.error.code).toBe("project_deleted");
    expect((await callService(env, "mail", agent.accountId, "/v1/account", { method: "DELETE" })).status).toBe(200);
  });

  it("works over MCP too, and refuses a project that has an owner", async () => {
    const agent = await signup("mcp-doomed.test");
    const list = await call("POST", "/mcp", { key: agent.key, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const tool = list.json.result.tools.find((t: { name: string }) => t.name === "afs_delete_project");
    expect(tool.annotations.destructiveHint).toBe(true);
    const wrong = await mcp(agent.key, "afs_delete_project", { confirm: "nope" });
    expect(wrong.json.result.isError).toBe(true);
    const ok = await mcp(agent.key, "afs_delete_project", { confirm: agent.accountId });
    expect(JSON.parse(ok.json.result.content[0].text)).toMatchObject({ deleted: true, project_id: agent.accountId });
    expect((await me(agent.key)).status).toBe(403);

    const { agent: claimedAgent, base } = await owned("has-owner");
    const refused = await del(claimedAgent.key, { confirm: claimedAgent.accountId });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("owner_required");
    expect(refused.json.error.hint).toContain(`${base}/settings`);
    const viaMcp = await mcp(claimedAgent.key, "afs_delete_project", { confirm: claimedAgent.accountId });
    expect(JSON.parse(viaMcp.json.result.content[0].text).error.code).toBe("owner_required");
    expect((await me(claimedAgent.key)).status).toBe(200);
  });
});

describe("deleting a project: its owner, in the dashboard", () => {
  it("deletes with the project's name typed, hides it, and restores it within the window", async () => {
    const { agent, owner, base } = await owned("ownerdel");
    await E.DB.prepare("UPDATE accounts SET name = 'Acme' WHERE id = ?").bind(agent.accountId).run();
    // A member sees neither the button nor can post the form.
    const member = new Browser();
    const memberEmail = uniqueEmail("member");
    await member.signIn(memberEmail);
    const uid = await E.DB.prepare("SELECT id FROM users WHERE email = ?").bind(memberEmail).first<string>("id");
    expect((await addMember(E.DB, uid!, agent.accountId)).role).toBe("member");
    const memberPage = await member.get(`${base}/settings`);
    expect(memberPage.text).not.toContain("Delete project");
    expect((await member.post(`${base}/delete`, { csrf: csrfOf(memberPage.text), confirm: "Acme" })).status).toBe(403);

    const settings = await owner.get(`${base}/settings`);
    expect(settings.text).toContain("Delete project");
    expect(settings.text).toContain("Type <b>Acme</b> to confirm");
    expect(settings.text).toContain("export everything worth keeping");
    const csrf = csrfOf(settings.text);
    expect((await owner.post(`${base}/delete`, { csrf, confirm: "acme" })).status).toBe(400);
    expect((await owner.post(`${base}/delete`, { csrf: "0".repeat(64), confirm: "Acme" })).status).toBe(403);
    expect((await deletedAt(agent.accountId))?.deleted_at).toBeNull();

    const done = await owner.post(`${base}/delete`, { csrf, confirm: "Acme" });
    expect(done.status).toBe(303);
    expect(done.location).toBe(`/dashboard?deleted=${agent.accountId}`);
    const state = await deletedAt(agent.accountId);
    expect(state?.deleted_by).toMatch(/^usr_/);

    // Gone from the project pages and the switcher; listed for its owner with Restore and the cleanup.
    const home = await owner.get(done.location!);
    expect(home.text).toContain("Acme is deleted");
    expect(home.text).toContain("Deleted projects");
    expect(home.text).toContain(`action="/dashboard/projects/${agent.accountId}/restore"`);
    expect(home.text).toContain("Remove it from this codebase");
    expect(home.text).not.toContain(`data-pcard="${agent.accountId}"`);
    expect(home.text).not.toContain(`href="/dashboard/projects/${agent.accountId}"`);
    for (const path of [base, `${base}/settings`, `${base}/tags`, `${base}/keys`]) expect((await owner.get(path)).status, path).toBe(404);
    // The member just loses it.
    const memberHome = await member.get("/dashboard");
    expect(memberHome.text).not.toContain("Deleted projects");
    expect((await member.get(base)).status).toBe(404);
    expect((await me(agent.key)).json.error.code).toBe("project_deleted");
    // Only its owner can restore it.
    expect((await member.post(`${base}/restore`, { csrf: csrfOf(memberHome.text) })).status).toBe(404);

    const restored = await owner.post(`${base}/restore`, { csrf: csrfOf(home.text) });
    expect(restored.status).toBe(303);
    expect(restored.location).toBe(base);
    expect((await owner.get(base)).status).toBe(200);
    expect((await me(agent.key)).status).toBe(200);
    expect((await member.get(base)).status).toBe(200);
    expect(await deletedAt(agent.accountId)).toMatchObject({ deleted_at: null, purge_after: null, name: "Acme" });
  });
});

describe("purging deleted projects (the daily cron)", () => {
  it("erases each service's data and the identity rows once the window has passed", async () => {
    const agent = await signup("purge.test");
    const d = (await del(agent.key, { confirm: agent.accountId })).json;
    const env = testEnv();
    const id = agent.accountId;

    expect((await purgeDeletedProjects(env, d.purge_after - 1)).purged).not.toContain(id);
    expect(purges.get(`analytics:${id}`)).toBeUndefined();

    purgeRounds.set(`mail:${id}`, 2); // mail needs three calls to finish
    const r = await purgeDeletedProjects(env, d.purge_after + 1);
    expect(r.purged).toContain(id);
    for (const svc of ["analytics", "tags", "replay"]) expect(purges.get(`${svc}:${id}`), svc).toBe(1);
    expect(purges.get(`mail:${id}`)).toBe(3);

    const count = (table: string) => E.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ?`).bind(id).first<number>("n");
    expect(await count("api_keys")).toBe(0);
    expect(await count("memberships")).toBe(0);
    const row = await deletedAt(id);
    expect(row?.purged_at).toBe(d.purge_after + 1);
    expect(row?.name).toBeNull();
    // Purged: not restorable, and the next run leaves it alone.
    await expect(restoreProject(env, id, d.purge_after - 1)).rejects.toMatchObject({ code: "project_purged" });
    expect((await purgeDeletedProjects(env, d.purge_after + 2)).purged).not.toContain(id);
    expect(purges.get(`analytics:${id}`)).toBe(1);
  });

  it("keeps the identity rows until every service has erased its part", async () => {
    const agent = await signup("purge-retry.test");
    const d = (await del(agent.key, { confirm: agent.accountId })).json;
    const id = agent.accountId;
    const env = testEnv();
    failingPurges.add(`tags:${id}`);
    const first = await purgeDeletedProjects(env, d.purge_after + 1);
    expect(first.pending).toContain(id);
    expect(purges.get(`mail:${id}`)).toBeUndefined(); // stops at the first service that failed
    expect((await deletedAt(id))?.purged_at).toBeNull();
    expect(await E.DB.prepare("SELECT count(*) AS n FROM api_keys WHERE account_id = ?").bind(id).first("n")).toBe(1);

    failingPurges.delete(`tags:${id}`);
    expect((await purgeDeletedProjects(env, d.purge_after + 1)).purged).toContain(id);
    expect(purges.get(`analytics:${id}`)).toBe(2); // erasing again is harmless
  });

  it("lets the operator restore an unclaimed project before it is purged", async () => {
    const ADMIN = "test-admin-token-0123456789";
    const env = testEnv({ ADMIN_TOKEN: ADMIN });
    const agent = await signup("oops.test");
    await del(agent.key, { confirm: agent.accountId });
    const path = `/v1/admin/accounts/${agent.accountId}`;
    expect((await call("GET", path, { env, key: ADMIN })).json.account.deleted_at).toEqual(expect.any(Number));
    expect((await call("POST", `${path}/restore`, { env, key: agent.key })).status).toBe(401);
    const r = await call("POST", `${path}/restore`, { env, key: ADMIN, json: {} });
    expect(r.json).toMatchObject({ restored: true, account: { deleted_at: null, purge_after: null } });
    expect((await me(agent.key)).status).toBe(200);
  });
});
