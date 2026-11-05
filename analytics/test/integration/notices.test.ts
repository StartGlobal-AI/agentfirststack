import { createAccount } from "@afs/shared";
import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { sendReport } from "../../src/service/reports";

/**
 * Project notices (shared/src/notices.ts) end to end in workerd with D1: the site's project_notices
 * row (created in setup.ts) reaches the agent through REST and MCP answers, and the owner through
 * the scheduled report.
 */

const B = "http://analytics.test";
const NOTICE = "New: forward the inbox to the owner. Run the setup check: GET https://agentfirststack.com/v1/setup (MCP afs_check_setup).";
const OWNER = "Your project's inbox can now forward its email to you.";
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
  return { status: res.status, body, headers: res.headers };
}
const call = async (path: string, init: Init = {}) => parsed(await SELF.fetch(request(path, init)));

/**
 * A new project (made in the identity DB: POST /v1/signup is rate limited per minute) and its key.
 * The notice row goes in before its first authenticated call, so no isolate has cached "no notice".
 */
async function project(notice?: { owner?: string | null }) {
  const { accountId, apiKey } = await createAccount(idb(), { keyPrefix: "afs", name: "notices" });
  if (notice)
    await idb()
      .prepare("INSERT INTO project_notices (account_id, notice, owner_notice, created_at) VALUES (?, ?, ?, ?)")
      .bind(accountId, NOTICE, notice.owner ?? null, Date.now())
      .run();
  return { key: apiKey.key, accountId };
}

const shownAt = async (accountId: string) =>
  (await idb().prepare("SELECT shown_at FROM project_notices WHERE account_id = ?").bind(accountId).first<{ shown_at: number | null }>())
    ?.shown_at ?? null;

describe("project notices (workerd + D1)", () => {
  it("REST: the header on every answer, the field in the first JSON answer to a GET only; marked shown once", async () => {
    const { key, accountId } = await project({});
    const created = await call("/v1/sites", { method: "POST", key, json: { domain: "notice.test" } });
    expect(created.status).toBe(201);
    expect(created.headers.get("afs-notice")).toBe(NOTICE);
    expect(created.body.notice).toBeUndefined(); // POST answers: header only
    expect(await shownAt(accountId)).toBeNull();

    const first = await call("/v1/sites", { key });
    expect(first.headers.get("afs-notice")).toBe(NOTICE);
    expect(first.body.notice).toBe(NOTICE);
    expect(first.body.sites).toHaveLength(1);
    const at = await shownAt(accountId);
    expect(at).toBeGreaterThan(0);

    const second = await call("/v1/sites", { key });
    expect(second.headers.get("afs-notice")).toBe(NOTICE);
    expect(second.body.notice).toBeUndefined();
    const csv = await call(`/v1/sites/${created.body.site.id}/stats?format=csv&period=7d`, { key });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.body)).not.toContain(NOTICE);
    expect((await call("/v1/sites/site_nope", { key })).body.error.code).toBe("not_found");
    expect(await shownAt(accountId)).toBe(at);
  });

  it("internal callers (the site's dashboard and setup check) never get it, nor use it up", async () => {
    const { accountId } = await project({});
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      request("/v1/sites", { headers: { "x-afs-internal": "notice-internal", "x-afs-account": accountId } }, "https://analytics.internal"),
      { ...env, INTERNAL_TOKEN: "notice-internal" } as typeof env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const r = await parsed(res);
    expect(r.status).toBe(200);
    expect(r.headers.get("afs-notice")).toBeNull();
    expect(r.body.notice).toBeUndefined();
    expect(await shownAt(accountId)).toBeNull();
  });

  it("MCP: one more text item on the first successful tools/call, then none that day", async () => {
    const { key, accountId } = await project({});
    const tool = async (name: string, args: Record<string, unknown> = {}) =>
      (
        await call("/mcp", {
          method: "POST",
          key,
          headers: { accept: "application/json, text/event-stream" },
          json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        })
      ).body.result as { content: { type: string; text: string }[]; isError?: boolean };
    const first = await tool("list_sites");
    expect(first.isError).toBeFalsy();
    expect(first.content).toHaveLength(2);
    expect(JSON.parse(first.content[0]!.text)).toMatchObject({ sites: [] });
    expect(first.content[1]).toEqual({ type: "text", text: `AgentFirstStack notice for this project: ${NOTICE}` });
    expect(await shownAt(accountId)).toBeGreaterThan(0);
    expect((await tool("list_sites")).content).toHaveLength(1);
  });

  it("the scheduled report has a 'New for your project' section with owner_notice, without marking it shown", async () => {
    const cases = [
      { notice: { owner: OWNER }, expect: OWNER },
      { notice: { owner: null }, expect: NOTICE },
      { notice: undefined, expect: null },
    ];
    for (const [i, c] of cases.entries()) {
      const { key, accountId } = await project(c.notice);
      const site = (await call("/v1/sites", { method: "POST", key, json: { domain: `notice-report-${i}.test` } })).body.site.id as string;
      const dst = (
        await call(`/v1/sites/${site}/destinations`, { method: "POST", key, json: { type: "webhook", url: "https://hooks.example.org/n" } })
      ).body;
      const rep = (
        await call(`/v1/sites/${site}/reports`, {
          method: "POST",
          key,
          json: { name: "Weekly", cadence: "weekly", destination_ids: [dst.destination.id] },
        })
      ).body;
      const before = c.notice ? await shownAt(accountId) : null;
      const bodies: string[] = [];
      const fetcher = async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("ok");
      };
      const ctx = {
        env: { ...env, AUTH_ISSUER: "https://agentfirststack.test/" } as typeof env,
        accountId,
        auth: { accountId, keyId: "k", scopes: ["*"] },
        baseUrl: B,
      };
      expect(await sendReport(ctx, site, rep.report.id, { fetcher })).toMatchObject({ sent: true, status: "delivered" });
      const text = JSON.parse(bodies[0]!).text as string;
      if (c.expect) {
        const lines = text.split("\n");
        expect(lines.slice(0, 3)).toEqual([
          "New for your project",
          c.expect,
          'Ask your agent: "Run the AgentFirstStack setup check (GET https://agentfirststack.test/v1/setup) and apply what it lists."',
        ]);
        expect(lines[4]).toMatch(/^\d{4}-\d{2}-\d{2} to /); // then the report as before
        expect(await shownAt(accountId)).toBe(before);
      } else {
        expect(text).not.toContain("New for your project");
        expect(text).toMatch(/^\d{4}-\d{2}-\d{2} to /);
      }
    }
  });
});
