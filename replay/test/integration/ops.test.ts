import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import worker from "../../src/index";
import { runPurge } from "../../src/service/purge";
import { click, error, hide, mutation, page, scroll } from "../fixtures/rrweb";
import { E, call, hosted, newSid, newSite, sendChunk, signup, tool } from "./helpers";

const DAY = 86_400_000;

async function session(site: string, opts: { env?: Bindings; end?: boolean } = {}) {
  const sid = newSid();
  const T = Date.now() - 60_000;
  await sendChunk(site, sid, 0, [page(T, 1, "/checkout"), scroll(T + 100, 1, 600)], { env: opts.env });
  const r = await sendChunk(
    site,
    sid,
    1,
    [
      click(T + 1000, 1, "#pay", { l: "Pay" }),
      click(T + 1200, 1, "#pay", { l: "Pay" }),
      click(T + 1400, 1, "#pay", { l: "Pay" }),
      error(T + 1500, 1, "Error: declined"),
      hide(T + 4000, 1),
    ],
    { env: opts.env, extra: opts.end ? { end: 1, avid: "vid_abcdefghij" } : {} },
  );
  return { sid, r };
}

describe("verify_install", () => {
  it("finds the snippet, checks the script and CSP, then confirms sessions arrive", async () => {
    const { key, site } = await newSite("shop.test");
    const orig = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input instanceof Request ? input.url : input);
      seen.push(u);
      if (u === "https://shop.test/")
        return new Response(`<html><head><script defer src="http://replay.test/r/${site}.js"></script></head></html>`, {
          headers: { "content-security-policy": "default-src 'self'; script-src 'self'" },
        });
      if (u === `http://replay.test/r/${site}.js`) return new Response(`/*! afs-replay ${site} */`);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const before = await call("POST", `/v1/sites/${site}/verify`, { key, body: {} });
      const ids = (c: { id: string; ok: boolean }[]) => Object.fromEntries(c.map((x) => [x.id, x.ok]));
      expect(ids(before.json.checks)).toMatchObject({
        page_reachable: true,
        snippet_present: true,
        script_loads: true,
        csp: false,
        sessions_received: false,
        labels_masked: true,
      });
      expect(before.json.ok).toBe(false);
      expect(before.json.installed).toBe(true);
      expect(before.json.fixes.join(" ")).toContain(
        `script-src http://replay.test/r/${site}.js http://replay.test/rec/; connect-src http://replay.test/i`,
      );
      expect(before.json.fixes.join(" ")).toContain("?afsr=1");
      await session(site);
      const after = await tool(key, "verify_install", { site_id: site });
      expect(after.data.receiving_sessions).toBe(true);
      expect(seen).toContain("https://shop.test/");
      expect((await call("POST", `/v1/sites/${site}/verify`, { key, body: { url: "https://evil.test/" } })).json.error.hint).toContain(
        "shop.test",
      );
    } finally {
      globalThis.fetch = orig;
    }
    const ro = (await call("POST", "/v1/keys", { key, body: { scope: "read" } })).json.api_key;
    expect((await call("POST", `/v1/sites/${site}/verify`, { key: ro, body: {} })).status).toBe(403);
    expect((await call("GET", `/v1/sites/${site}/sessions`, { key: ro })).status).toBe(200);
  });
});

describe("analytics link", () => {
  it("validates the analytics site, forwards settled signals as events joined to the visitor, and reads analytics funnels", async () => {
    const { key, account, site } = await newSite("shop.test");
    const received: { path: string; body: any; headers: Headers }[] = [];
    const ANALYTICS = {
      fetch: async (req: Request) => {
        const u = new URL(req.url);
        if (req.headers.get("x-afs-internal") !== "test-internal-0123456789" || req.headers.get("x-afs-account") !== account)
          return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
        if (req.method === "GET" && u.pathname === "/v1/sites/site_0123456789abcdef")
          return Response.json({ site: { id: "site_0123456789abcdef", domain: "shop.test" } });
        if (req.method === "GET" && u.pathname === "/v1/sites/site_0123456789abcdef/funnels")
          return Response.json({ funnels: [{ id: "fnl_0123456789abcdef", steps: ["/pricing", "/checkout"] }] });
        if (req.method === "POST" && u.pathname === "/v1/sites/site_0123456789abcdef/events") {
          received.push({ path: u.pathname, body: await req.json(), headers: req.headers });
          return Response.json({ ok: true }, { status: 202 });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
    } as unknown as Fetcher;
    const env = hosted({ ANALYTICS, INTERNAL_TOKEN: "test-internal-0123456789" });
    expect(
      (await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: "site_aaaaaaaaaaaaaaaa" }, env })).json.error.message,
    ).toContain("not found");
    const linked = await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: "site_0123456789abcdef" }, env });
    expect(linked.status).toBe(200);
    expect(linked.json.site).toMatchObject({ analytics_site_id: "site_0123456789abcdef", analytics_forwarding: "on" });
    const { sid } = await session(site, { env, end: true });
    const events = received.flatMap((r) => r.body.events);
    expect(events.map((e: any) => e.name).sort()).toEqual(["error_click", "js_error", "rage_click"]);
    for (const e of events) {
      expect(e).toMatchObject({ url: "https://shop.test/checkout", visitor_id: "vid_abcdefghij" });
      expect(e.props.replay_session_id).toBe(sid);
    }
    expect(events.find((e: any) => e.name === "rage_click").props).toMatchObject({ selector: "#pay", label: "Pay" });
    // nothing is sent twice
    const before = events.length;
    await sendChunk(site, sid, 2, [mutation(Date.now() - 1000)], { env, extra: { end: 1 } });
    expect(received.flatMap((r) => r.body.events)).toHaveLength(before);

    const f = await call("GET", `/v1/sites/${site}/funnel?analytics_funnel_id=fnl_0123456789abcdef`, { key, env });
    expect(f.json.untrusted.steps.map((s: any) => s.match)).toEqual(["/pricing", "/checkout"]);
    // without the binding the link reports unavailable instead of failing ingest
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.site.analytics_forwarding).toBe("unavailable_on_this_deployment");
    expect((await call("GET", `/v1/sites/${site}/funnel?analytics_funnel_id=fnl_x`, { key })).json.error.code).toBe(
      "analytics_not_available",
    );
    expect((await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: null } })).json.site.analytics_forwarding).toBe(
      "off",
    );
  });
});

describe("retention, deletion and the cron", () => {
  it("purges sessions past retention (DO + R2) and keeps heatmap aggregates", async () => {
    const { key, site } = await newSite("shop.test", { retention_days: 1 });
    const { sid } = await session(site);
    expect((await E.CHUNKS.list({ prefix: `${site}/${sid}/` })).objects).toHaveLength(2);
    const r = await runPurge(E, Date.now() + 2 * DAY);
    expect(r.sessions_deleted).toBeGreaterThanOrEqual(1);
    expect((await E.CHUNKS.list({ prefix: `${site}/${sid}/` })).objects).toHaveLength(0);
    expect((await call("GET", `/v1/sites/${site}/sessions`, { key })).json.total).toBe(0);
    const heat = await call("GET", `/v1/sites/${site}/heatmap?page=/checkout`, { key });
    expect(heat.json.untrusted.elements[0]).toMatchObject({ selector: "#pay", clicks: 3, rage_clicks: 3 });
    expect(heat.json.rolled_up_through).not.toBeNull();
    // the scheduled handler runs the same purge
    const ctx = createExecutionContext();
    await worker.scheduled({} as ScheduledController, E, ctx);
    await waitOnExecutionContext(ctx);
  });

  it("deleting a site removes its data; late chunks are refused and R2 is cleaned by prefix", async () => {
    const { key, site } = await newSite("shop.test");
    const { sid } = await session(site);
    const link = await call("POST", `/v1/sites/${site}/links`, { key, body: { session_id: sid } });
    const del = await call("DELETE", `/v1/sites/${site}`, { key });
    expect(del.json.deleted).toBe(site);
    expect((await call("GET", new URL(link.json.link.url).pathname)).status).toBe(404);
    expect((await sendChunk(site, newSid(), 0, [page(Date.now(), 1, "/")])).json).toMatchObject({ error: "unknown_site", stop: true });
    // a stale cached site row elsewhere still can't recreate storage: the DO keeps a tombstone
    const stub = E.SITE.get(E.SITE.idFromName(site));
    const late = await stub.ingest({
      now: Date.now(),
      session_id: newSid(),
      seq: 0,
      bytes: 1,
      skew_ms: 0,
      chunk: {
        first_ts: 0,
        last_ts: 0,
        cover_end: 0,
        rr_events: 0,
        full_snapshots: 0,
        effects: 0,
        pages: [],
        clicks: [],
        inputs: [],
        errors: [],
        customs: [],
        marks: [],
        scrolls: [],
        effect_head: [],
        viewport: null,
        hosts: [],
        dropped: 0,
        invalid: 0,
        truncated: false,
      },
      meta: {
        device: null,
        browser: null,
        browser_version: null,
        os: null,
        country: null,
        region: null,
        city: null,
        ua_hash: null,
        user_id: null,
        analytics_visitor_id: null,
        forced: false,
      },
      end: false,
      limits: { session_bytes: 1e9, max_session_ms: 1e9, daily_sessions: null },
      forward: false,
      account_id: "acct_x",
      config: { site_id: site, retention_days: 30, heatmap_retention_days: 180 },
    });
    expect(late).toEqual({ status: "rejected", reason: "unknown_site", stop: true });
    expect((await E.CHUNKS.list({ prefix: `${site}/` })).objects.length).toBe(2);
    const r = await runPurge(E);
    expect(r.prefixes_cleaned).toBeGreaterThanOrEqual(1);
    expect((await E.CHUNKS.list({ prefix: `${site}/` })).objects).toHaveLength(0);
    expect((await call("GET", `/v1/sites/${site}`, { key })).status).toBe(404);
  });

  it("read keys can read but not change anything", async () => {
    const { key } = await signup();
    const ro = (await call("POST", "/v1/keys", { key, body: { scope: "read" } })).json.api_key;
    expect((await call("POST", "/v1/sites", { key: ro, body: { domain: "ro.test" } })).status).toBe(403);
    expect((await call("GET", "/v1/sites", { key: ro })).status).toBe(200);
    const t = await tool(ro, "create_replay_site", { domain: "ro.test" });
    expect(t.raw.error ?? t.isError).toBeTruthy();
  });
});
