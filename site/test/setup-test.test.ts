import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import type { SetupTest } from "../src/setup-test";
import { E, call, signup, testEnv } from "./helpers";

/**
 * Fake services for the setup test: they answer like the live APIs and keep state, so a test email
 * can be read back and test events show up in realtime and the tags event log.
 */
type Handler = (req: Request, url: URL) => unknown | Response | Promise<unknown | Response>;
interface Sent {
  service: string;
  method: string;
  path: string;
  body: any;
  authorization: string | null;
}

function fake(service: string, routes: Record<string, Handler | unknown>, sent: Sent[]): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      const text = req.method === "GET" ? "" : await req.clone().text();
      sent.push({
        service,
        method: req.method,
        path: url.pathname + url.search,
        body: text ? JSON.parse(text) : null,
        authorization: req.headers.get("authorization"),
      });
      if (req.headers.get("x-afs-internal") !== E.INTERNAL_TOKEN)
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      const hit = routes[`${req.method} ${url.pathname}`] ?? (req.method === "GET" ? routes[url.pathname] : undefined);
      if (hit === undefined)
        return Response.json({ error: { code: "not_found", message: `${req.method} ${url.pathname}` } }, { status: 404 });
      const out = typeof hit === "function" ? await (hit as Handler)(req, url) : hit;
      return out instanceof Response ? out : Response.json(out);
    },
  } as unknown as Fetcher;
}

const NOW = () => Date.now();

function world(
  opts: { liveBrowserConversion?: boolean; skipEvent?: string; noReplaySession?: boolean; browserOnlyAnalytics?: boolean } = {},
) {
  const sent: Sent[] = [];
  const analyticsEvents: { name: string; pathname?: string; debug: boolean; ts: number }[] = [];
  const tagsLog: any[] = [];
  let mailCode: string | null = null;

  const config = {
    tags: opts.browserOnlyAnalytics ? [{ id: "analytics", type: "analytics" }] : [],
    triggers: [
      { id: "copy_t", type: "click", selector: "[data-copy]" },
      {
        id: "guide_t",
        type: "click",
        selector: "a[href^='/guides']",
        conditions: [{ var: "page_path", op: "starts_with", value: "/guides" }],
      },
      { id: "mail_t", type: "click", selector: "a[href^='mailto:']" },
      { id: "signup_t", type: "form_submit", selector: "#signup" },
    ],
    conversions: [
      { name: "copy_prompt", trigger: "copy_t", send_to: { analytics: { event_name: "copy_prompt" } } },
      { name: "guide_click", trigger: "guide_t", send_to: { analytics: { event_name: "guide_click" } } },
      { name: "email_click", trigger: "mail_t", send_to: { analytics: { event_name: "email_click" } } },
      {
        name: "sign_up",
        trigger: "signup_t",
        send_to: { analytics: { event_name: "sign_up" }, meta: { event_name: "Lead" }, linkedin: { conversion_id: "1" } },
      },
      { name: "purchase", send_to: { meta: { event_name: "Purchase" } } },
    ],
  };

  const routes = {
    analytics: {
      "/v1/sites": { sites: [{ id: "site_acme", domain: "acme.test", name: null, created_at: NOW() }] },
      "/v1/sites/site_acme/goals": {
        goals: [
          { name: "Pricing", type: "pageview", match: "/pricing" },
          { name: "Guides", type: "pageview", match: "/guides/*" },
          { name: "Copied", type: "event", match: "copy_prompt" },
        ],
      },
      "POST /v1/sites/site_acme/verify": { ok: true, installed: true, receiving_events: true, domain_verified: true, fixes: [] },
      "POST /v1/sites/site_acme/events": async (req: Request) => {
        const body = (await req.json()) as { events: { name: string; debug?: boolean }[] };
        for (const e of body.events) analyticsEvents.push({ name: e.name, debug: !!e.debug, ts: NOW() });
        return { accepted: body.events.length, rejected: 0 };
      },
      "/v1/sites/site_acme/realtime": (_req: Request, url: URL) => {
        const since = Number(url.searchParams.get("since") ?? 0);
        return { recent_events: analyticsEvents.filter((e) => e.debug && e.ts >= since) };
      },
    },
    tags: {
      "/v1/containers": { containers: [{ id: "ctr_acme", domain: "acme.test", name: null, live_version: 3, created_at: NOW() }] },
      "/v1/containers/ctr_acme": { container: { id: "ctr_acme", live_version: 3 } },
      "/v1/containers/ctr_acme/versions/3": { config },
      "/v1/containers/ctr_acme/destinations": {
        destinations: [
          { id: "dst_meta", type: "meta", name: "Meta", enabled: true },
          { id: "dst_li", type: "linkedin", name: "LinkedIn", enabled: true },
        ],
      },
      "POST /v1/containers/ctr_acme/events": async (req: Request) => {
        const body = (await req.json()) as { test?: boolean; events: { name: string; event_id: string; destinations?: string[] }[] };
        const results = body.events.map((e) => {
          const known = config.conversions.find((c) => c.name === e.name);
          // A name no conversion uses goes to analytics only; destinations narrows to those ids.
          const dests = !known
            ? opts.browserOnlyAnalytics
              ? []
              : [{ destination_id: "analytics", type: "analytics", status: "queued" }]
            : (e.destinations ?? []).map((id) => ({ destination_id: id, type: id === "dst_meta" ? "meta" : "linkedin", status: "queued" }));
          if (!known) analyticsEvents.push({ name: e.name, debug: !!body.test, ts: NOW() });
          tagsLog.push({
            name: e.name,
            event_id: e.event_id,
            source: "server",
            preview: !!body.test,
            ts: NOW(),
            destinations: dests.map((d) =>
              d.type === "meta"
                ? { ...d, status: "delivered" }
                : d.type === "linkedin"
                  ? { ...d, status: "skipped", reason: "test event, no test mode configured: LinkedIn has no test mode" }
                  : { ...d, status: "delivered" },
            ),
          });
          return { event_id: e.event_id, name: e.name, status: "accepted", destinations: dests };
        });
        return Response.json({ accepted: results.length, results }, { status: 202 });
      },
      "/v1/containers/ctr_acme/events": (_req: Request, url: URL) => {
        const since = Number(url.searchParams.get("since") ?? 0);
        const source = url.searchParams.get("source");
        return { events: tagsLog.filter((e) => e.ts >= since && (!source || e.source === source)) };
      },
    },
    mail: {
      "/v1/inboxes": { inboxes: [{ id: "inb_1", address: "acme@afs.test", domain: "afs.test" }], shared_domain: "afs.test" },
      "POST /v1/inboxes/inb_1/send": async (req: Request) => {
        const body = (await req.json()) as { to: string; text: string };
        mailCode = /verification code: (\d{6})/.exec(body.text)?.[1] ?? null;
        return Response.json(
          {
            message: { id: "msg_1" },
            internal: [{ recipient: body.to, inbox_id: "inb_1", status: "delivered" }],
            daily: { used: 1, limit: 20 },
          },
          { status: 201 },
        );
      },
      "/v1/inboxes/inb_1/wait": (_req: Request, url: URL) =>
        url.searchParams.get("tag") === "afs-test" && mailCode
          ? { message: { id: "msg_2", code: mailCode, codes: [mailCode], tag: "afs-test" } }
          : Response.json({ error: { code: "timeout" } }, { status: 408 }),
    },
    replay: {
      "/v1/sites": { sites: [{ id: "rsite_acme", domain: "acme.test", name: null, enabled: true, created_at: NOW() }] },
      "POST /v1/sites/rsite_acme/verify": { ok: true, installed: true, receiving_sessions: true, domain_verified: true },
      "/v1/sites/rsite_acme/sessions": opts.noReplaySession
        ? { sessions: [] }
        : { sessions: [{ id: "rs_test1", pageviews: 3, clicks: 7, started_at: NOW(), forced: true }] },
    },
  };

  /** What a real browser visit with ?afsa_debug=1 would have sent. */
  const visit = () => {
    for (const p of ["/", "/pricing", "/guides/a"]) analyticsEvents.push({ name: "pageview", pathname: p, debug: true, ts: NOW() });
    for (const ev of ["copy_prompt", "guide_click", "sign_up"]) {
      if (ev === opts.skipEvent) continue;
      analyticsEvents.push({ name: ev, debug: true, ts: NOW() });
      const live = opts.liveBrowserConversion && ev === "sign_up";
      tagsLog.push({
        name: ev,
        source: "browser",
        preview: !live,
        ts: NOW(),
        destinations: live
          ? [{ destination_id: "dst_meta", type: "meta", status: "delivered" }]
          : [{ destination_id: "dst_meta", type: "meta", status: "delivered" }],
      });
    }
  };

  const env = testEnv({
    ANALYTICS: fake("analytics", routes.analytics, sent),
    TAGS: fake("tags", routes.tags, sent),
    MAIL: fake("mail", routes.mail, sent),
    REPLAY: fake("replay", routes.replay, sent),
  } as Partial<Bindings>);
  return { env, sent, visit };
}

const byId = (tests: SetupTest[]) => {
  const m = new Map(tests.map((t) => [t.id, t]));
  return (id: string): SetupTest => {
    const t = m.get(id);
    if (!t) throw new Error(`no test ${id}: ${[...m.keys()].join(", ")}`);
    return t;
  };
};

const mcp = (key: string, env: Bindings, method: string, params: unknown = {}) =>
  call("POST", "/mcp", {
    key,
    env,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });

describe("setup test", () => {
  it("sends test traffic through every service and checks it arrived", async () => {
    const agent = await signup("acme.test");
    const { env, sent } = world();
    const r = await call("POST", "/v1/setup/test", { key: agent.key, env, json: {} });
    expect(r.status).toBe(200);
    const t = byId(r.json.tests);
    expect(t("mail.roundtrip")).toMatchObject({ status: "passed", detail: expect.stringContaining("acme+afs-test@afs.test") });
    expect(t("analytics.verify").status).toBe("passed");
    expect(t("analytics.test_event").status).toBe("passed");
    expect(t("tags.to_analytics").status).toBe("passed");
    expect(t("tags.ad_platform.dst_meta")).toMatchObject({ status: "passed", detail: expect.stringContaining("sign_up, purchase") });
    expect(t("tags.ad_platform.dst_li")).toMatchObject({ status: "skipped", detail: expect.stringContaining("no test mode") });
    expect(t("replay.verify").status).toBe("passed");
    expect(r.json.passed).toBe(true);

    // Test conversions: flagged test, no identity, only to the ad platforms (never to analytics, so
    // they can't make a goal look verified).
    const conv = sent.find(
      (s) => s.method === "POST" && s.path === "/v1/containers/ctr_acme/events" && s.body.events[0].name !== "afs_test_tags",
    );
    expect(conv?.body.test).toBe(true);
    expect(conv?.body.events.map((e: any) => e.name)).toEqual(["sign_up", "purchase"]);
    for (const e of conv?.body.events ?? []) {
      expect(e.destinations).toEqual(["dst_meta", "dst_li"]);
      expect(Object.keys(e).sort()).toEqual(["destinations", "event_id", "name"]);
    }
    expect(sent.find((s) => s.path === "/v1/sites/site_acme/events")?.body.events[0]).toMatchObject({
      name: "afs_test_analytics",
      debug: true,
      visit: false,
    });
    expect(sent.every((s) => s.authorization === null)).toBe(true);

    // The browser plan, from the live tags config.
    const plan = r.json.browser_plan;
    expect(plan.start_url).toBe("https://acme.test/?afsa_debug=1&afsr=1");
    expect(plan.expected_events).toEqual(["copy_prompt", "guide_click", "sign_up"]);
    const actions = plan.steps.map((s: { action: string }) => s.action).join("\n");
    expect(actions).toContain("Open https://acme.test/pricing");
    expect(actions).toContain("Click an element matching `[data-copy]`");
    expect(actions).toContain("on a page whose path starts with /guides");
    expect(actions).toContain("only if that's harmless");
    expect(plan.not_in_browser.join(" ")).toContain("email_click: its links open a mail or phone app");
    expect(plan.not_in_browser.join(" ")).toContain("purchase: no browser trigger");
    expect(plan.check).toBe(`https://afs.test/v1/setup/test?since=${r.json.started_at}&domain=acme.test`);

    const md = r.json.report_markdown as string;
    expect(md).toMatch(/^\*\*AgentFirstStack setup test for acme\.test: passed\*\*/);
    expect(md).toContain("| ✅ | Test email: sent, received and read back |");
    expect(md).toContain("| ➖ | LinkedIn: test conversions |");
  });

  it("leaves the analytics path to the browser visit when the container reaches analytics from the browser", async () => {
    const agent = await signup("acme.test");
    const { env } = world({ browserOnlyAnalytics: true });
    const r = await call("POST", "/v1/setup/test", { key: agent.key, env, json: { services: ["tags"] } });
    expect(byId(r.json.tests)("tags.to_analytics")).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("from the browser"),
    });
  });

  it("checks the browser visit: pageviews, each event in both places, test-only, and a replay", async () => {
    const agent = await signup("acme.test");
    const { env, visit } = world();
    const since = Date.now() - 1000;
    visit();
    const r = await call("GET", `/v1/setup/test?since=${since}`, { key: agent.key, env });
    expect(r.status).toBe(200);
    const t = byId(r.json.tests);
    expect(t("browser.pageviews")).toMatchObject({ status: "passed", detail: "3 pages: /, /pricing, /guides/a." });
    expect(t("browser.events")).toMatchObject({ status: "passed", detail: "All 3 events arrived: copy_prompt, guide_click, sign_up." });
    expect(t("browser.test_flag").status).toBe("passed");
    expect(t("browser.replay")).toMatchObject({ status: "passed", detail: "Session rs_test1: 3 pages, 7 clicks." });
    expect(r.json.passed).toBe(true);
    expect(r.json.report_markdown).toContain("browser test visit for acme.test: passed");
  });

  it("says which events didn't arrive, and flags clicks that went out as live conversions", async () => {
    const agent = await signup("acme.test");
    const { env, visit } = world({ skipEvent: "guide_click", liveBrowserConversion: true, noReplaySession: true });
    const since = Date.now() - 1000;
    visit();
    const r = await call("GET", `/v1/setup/test?since=${since}`, { key: agent.key, env });
    const t = byId(r.json.tests);
    expect(t("browser.events")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("Missing: guide_click (not in the tags event log)"),
    });
    expect(t("browser.test_flag")).toMatchObject({ status: "failed", detail: expect.stringContaining("went to an ad platform") });
    expect(t("browser.replay").status).toBe("failed");
    expect(r.json.passed).toBe(false);
    expect(r.json.next_steps.length).toBe(3);
  });

  it("needs a recent since, a write key to send traffic, and is offered over MCP", async () => {
    const agent = await signup("acme.test");
    const { env, visit } = world();
    expect((await call("GET", "/v1/setup/test", { key: agent.key, env })).json.error.code).toBe("bad_request");
    expect((await call("GET", `/v1/setup/test?since=${Date.now() - 2 * 3_600_000}`, { key: agent.key, env })).json.error.message).toContain(
      "more than an hour ago",
    );
    expect((await call("POST", "/v1/setup/test", { key: agent.key, env, json: { services: ["crm"] } })).json.error.code).toBe(
      "bad_request",
    );

    const read = (await call("POST", "/v1/keys", { key: agent.key, json: { scope: "read" } })).json.api_key as string;
    expect((await call("POST", "/v1/setup/test", { key: read, env, json: {} })).status).toBe(403);
    const names = ((await mcp(read, env, "tools/list")).json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("afs_check_test_visit");
    expect(names).not.toContain("afs_test_setup");
    const since = Date.now() - 1000;
    visit();
    const tool = await mcp(read, env, "tools/call", { name: "afs_check_test_visit", arguments: { since } });
    expect(JSON.parse(tool.json.result.content[0].text).passed).toBe(true);
    expect((await mcp(read, env, "tools/call", { name: "afs_test_setup", arguments: {} })).json.result.isError).toBe(true);

    const full = ((await mcp(agent.key, env, "tools/list")).json.result.tools as { name: string }[]).map((t) => t.name);
    expect(full.slice(0, 3)).toEqual(["afs_check_setup", "afs_test_setup", "afs_check_test_visit"]);
    const run = await mcp(agent.key, env, "tools/call", { name: "afs_test_setup", arguments: { services: ["mail"] } });
    const body = JSON.parse(run.json.result.content[0].text);
    expect(body.tests.map((t: SetupTest) => t.id)).toEqual(["mail.roundtrip"]);
    expect(body.passed).toBe(true);
  });
});
