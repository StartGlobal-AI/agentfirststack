import { describe, expect, it } from "vitest";
import { noticeTexts, readSetupState, refreshNotices } from "../src/notices";
import { AGENTS_MD_BLOCK, CATALOG_VERSION, itemsAfter, SETUP_CATALOG } from "../src/setup-catalog";
import { Browser, E, call, csrfOf, signup, testEnv, uniqueEmail } from "./helpers";

const notice = (accountId: string) =>
  E.DB.prepare("SELECT notice, owner_notice, shown_at FROM project_notices WHERE account_id = ?")
    .bind(accountId)
    .first<{ notice: string; owner_notice: string | null; shown_at: number | null }>();

describe("setup catalog and notices", () => {
  it("the catalog covers every check the setup check can return", async () => {
    const agent = await signup("catalog.test");
    const r = await call("GET", "/v1/setup", { key: agent.key });
    const known = new Set(SETUP_CATALOG.flatMap((i) => i.checks));
    // The stub services list nothing, so this run has the per-site "missing" checks; the full list
    // is in src/setup-check.ts. Every id it returns must be in the catalog.
    for (const c of r.json.checks as { id: string }[]) expect(known.has(c.id), c.id).toBe(true);
    expect(CATALOG_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("the first setup check records what the agent saw; later ones say what's new", async () => {
    const agent = await signup("history.test");
    const first = await call("GET", "/v1/setup", { key: agent.key });
    expect(first.json.last_checked_at).toBeNull();
    expect(first.json.new_since_last_check).toBeUndefined();
    expect(first.json.agents_md).toBe(AGENTS_MD_BLOCK("https://afs.test"));
    const state = await readSetupState(E.DB, agent.accountId);
    expect(state?.catalog_version).toBe(CATALOG_VERSION);
    expect(state?.seen).toEqual(expect.arrayContaining(["project.named", "project.claimed"]));

    // Pretend the agent last checked before mail.forwarding and the per-site checks existed.
    await E.DB.prepare("UPDATE setup_state SET seen = ?, catalog_version = 1 WHERE account_id = ?")
      .bind(JSON.stringify(["project.named", "project.claimed"]), agent.accountId)
      .run();
    const second = await call("GET", "/v1/setup", { key: agent.key });
    expect(second.json.last_checked_at).toBe(state?.checked_at);
    const fresh = (second.json.new_since_last_check as { id: string }[]).map((c) => c.id);
    expect(fresh).toContain("analytics.site");
    expect(fresh).not.toContain("project.named");
    expect(second.json.checks.find((c: { id: string }) => c.id === "analytics.site").new).toBe(true);
    expect(second.json.next_steps[0]).toMatch(/^New since the last setup check: /);
  });

  it("the daily job writes a notice for active projects that haven't seen the catalog, and the check clears it", async () => {
    const never = await signup("never-checked.test");
    const old = await signup("old-check.test");
    const current = await signup("current.test");
    const idle = await signup("idle.test");
    // Keys used recently, except idle's.
    for (const a of [never, old, current])
      await E.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE account_id = ?").bind(Date.now(), a.accountId).run();
    await E.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE account_id = ?")
      .bind(Date.now() - 60 * 86_400_000, idle.accountId)
      .run();
    await E.DB.prepare("INSERT INTO setup_state (account_id, checked_at, catalog_version, seen) VALUES (?, ?, 1, '[]')")
      .bind(old.accountId, Date.now())
      .run();
    await E.DB.prepare("INSERT INTO setup_state (account_id, checked_at, catalog_version, seen) VALUES (?, ?, ?, '[]')")
      .bind(current.accountId, Date.now(), CATALOG_VERSION)
      .run();

    await refreshNotices(testEnv(), "https://afs.test");
    expect((await notice(never.accountId))?.notice).toMatch(
      /^This project hasn't run the AgentFirstStack setup check yet\. Run GET https:\/\/afs\.test\/v1\/setup/,
    );
    expect((await notice(old.accountId))?.notice).toMatch(
      /^New AgentFirstStack setup items for this project since its last setup check: .*forwarding the inbox's email/,
    );
    expect((await notice(old.accountId))?.owner_notice).toMatch(/^New in AgentFirstStack for this project: /);
    expect(await notice(current.accountId)).toBeNull();
    expect(await notice(idle.accountId)).toBeNull();

    // Re-running keeps shown_at for an unchanged notice.
    await E.DB.prepare("UPDATE project_notices SET shown_at = 123 WHERE account_id = ?").bind(old.accountId).run();
    await refreshNotices(testEnv(), "https://afs.test");
    expect((await notice(old.accountId))?.shown_at).toBe(123);

    // The agent runs the setup check: the notice is gone, and the next job doesn't bring it back.
    expect((await call("GET", "/v1/setup", { key: old.key })).status).toBe(200);
    expect(await notice(old.accountId)).toBeNull();
    await refreshNotices(testEnv(), "https://afs.test");
    expect(await notice(old.accountId)).toBeNull();
  });

  it("the dashboard tells the owner what their agent hasn't seen, with what to ask it", async () => {
    const agent = await signup("owner-news.test");
    const link = (await call("POST", "/v1/claim-link", { key: agent.key })).json.url as string;
    const owner = new Browser();
    const path = new URL(link).pathname;
    await owner.signIn(uniqueEmail("owner"), path);
    const claimPage = await owner.get(path);
    expect((await owner.post(path, { csrf: csrfOf(claimPage.text) })).status).toBe(303);
    const projectPath = `/dashboard/projects/${agent.accountId}`;
    expect((await owner.get(projectPath)).text).toContain("Your agent hasn&#39;t run the setup check on this project yet.");
    // The dashboard itself never counts as the agent having checked.
    expect(await readSetupState(E.DB, agent.accountId)).toBeNull();
    await E.DB.prepare("INSERT INTO setup_state (account_id, checked_at, catalog_version, seen) VALUES (?, ?, 1, '[]')")
      .bind(agent.accountId, Date.now())
      .run();
    const page = (await owner.get(projectPath)).text;
    expect(page).toContain("New since your agent last checked this project:");
    expect(page).toContain("forwarding the inbox&#39;s email to the owner");
    expect(page).toContain("Run the AgentFirstStack setup check (GET https://afs.test/v1/setup) and apply what it lists.");
    await call("GET", "/v1/setup", { key: agent.key });
    expect((await owner.get(projectPath)).text).not.toContain("New since your agent last checked");
  });

  it("notice texts name what's new and the call to run", () => {
    expect(noticeTexts("https://x.test", CATALOG_VERSION)).toBeNull();
    const t = noticeTexts("https://x.test", 1)!;
    for (const i of itemsAfter(1)) expect(t.notice).toContain(i.label);
    expect(t.notice).toContain("GET https://x.test/v1/setup (MCP afs_check_setup)");
    expect(noticeTexts("https://x.test", null)!.owner_notice).toMatch(/^Your agent hasn't checked this project's setup yet/);
  });

  it("the manual shows the same AGENTS.md block the setup check returns", async () => {
    const llms = await (await E.ASSETS.fetch(new Request("https://afs.test/llms.txt"))).text();
    const unindent = llms
      .split("\n")
      .map((l) => l.replace(/^ {3}/, ""))
      .join("\n");
    expect(unindent).toContain(AGENTS_MD_BLOCK("https://agentfirststack.com"));
  });
});
