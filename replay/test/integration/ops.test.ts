import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import worker from "../../src/index";
import { emptyChunk } from "../../src/lib/derive";
import { runPurge } from "../../src/service/purge";
import { findAnalyticsTrackers } from "../../src/service/verify";
import { click, error, hide, mutation, page, scroll } from "../fixtures/rrweb";
import { E, call, hosted, markVerified, newSid, newSite, sendChunk, signup, tool } from "./helpers";

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

const TOKEN = "test-internal-0123456789";
const A1 = "site_aaaaaaaaaaaaaaa1";
const A2 = "site_aaaaaaaaaaaaaaa2";

/** A stateful stand-in for the analytics Worker: its sites, each with replay_site_id. */
function analyticsStub(account: string, sites: Record<string, { domain: string; replay_site_id?: string | null }>) {
  const calls: string[] = [];
  const state = { patchStatus: 200 };
  const fetcher = {
    fetch: async (req: Request) => {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}`);
      if (req.headers.get("x-afs-internal") !== TOKEN || req.headers.get("x-afs-account") !== account)
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      const json = (id: string) => ({ id, domain: sites[id]!.domain, replay_site_id: sites[id]!.replay_site_id ?? null });
      if (req.method === "GET" && u.pathname === "/v1/sites") return Response.json({ sites: Object.keys(sites).map(json) });
      const id = /^\/v1\/sites\/(site_[0-9a-z]{16})$/.exec(u.pathname)?.[1];
      if (!id || !sites[id]) return Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (req.method === "PATCH") {
        if (state.patchStatus !== 200) return Response.json({ error: { code: "internal" } }, { status: state.patchStatus });
        const b = (await req.json()) as { replay_site_id?: string | null };
        if (b.replay_site_id !== undefined) sites[id]!.replay_site_id = b.replay_site_id;
      }
      return Response.json({ site: json(id) });
    },
  } as unknown as Fetcher;
  return { env: hosted({ ANALYTICS: fetcher, INTERNAL_TOKEN: TOKEN }), calls, state, sites };
}

describe("loading with analytics (no second snippet)", () => {
  it("linking sets the analytics site's replay_site_id; unlinking, moving and deleting clear it only while it points here", async () => {
    const { key, account } = await signup();
    const a = analyticsStub(account, { [A1]: { domain: "link.test" }, [A2]: { domain: "link.test" } });
    const created = await call("POST", "/v1/sites", { key, body: { domain: "link.test", analytics_site_id: A1 }, env: a.env });
    expect(created.status).toBe(201);
    const site = created.json.site.id as string;
    expect(a.sites[A1]!.replay_site_id).toBe(site);
    expect(created.json.site).toMatchObject({ analytics_site_id: A1, loads_with_analytics: true });
    expect(created.json.install.nothing_to_paste).toContain(A1);
    expect(created.json.install.code).toContain(`/r/${site}.js`); // the snippet stays the alternative
    expect(created.json.next_steps[0]).toContain("Nothing to paste");
    expect(created.json.site.verification.how[0]).toContain(`analytics tracker for ${A1}`);
    await markVerified(site);
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.site.loads_with_analytics).toBe(true);
    expect((await call("GET", "/v1/sites", { key })).json.sites[0].loads_with_analytics).toBe(true);

    // moving the link: the old analytics site is cleared, the new one set
    const moved = await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: A2 }, env: a.env });
    expect(moved.json.site.loads_with_analytics).toBe(true);
    expect(a.sites[A1]!.replay_site_id).toBeNull();
    expect(a.sites[A2]!.replay_site_id).toBe(site);

    // A2 was pointed at another replay site meanwhile: unlinking leaves it alone (GET first)
    a.sites[A2]!.replay_site_id = "rsite_zzzzzzzzzzzzzzzz";
    a.calls.length = 0;
    const unlinked = await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: null }, env: a.env });
    expect(unlinked.json.site).toMatchObject({ analytics_site_id: null, loads_with_analytics: false });
    expect(a.calls).toEqual([`GET /v1/sites/${A2}`]);
    expect(a.sites[A2]!.replay_site_id).toBe("rsite_zzzzzzzzzzzzzzzz");

    // a second replay site linked to the same analytics site takes it over
    await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: A1 }, env: a.env });
    const other = await call("POST", "/v1/sites", { key, body: { domain: "shop.link.test", analytics_site_id: A1 }, env: a.env });
    expect(a.sites[A1]!.replay_site_id).toBe(other.json.site.id);
    expect((await call("GET", `/v1/sites/${site}`, { key })).json.site.loads_with_analytics).toBe(false);

    // deleting: clears the analytics site only while it names the deleted replay site
    await call("DELETE", `/v1/sites/${site}`, { key, env: a.env });
    expect(a.sites[A1]!.replay_site_id).toBe(other.json.site.id);
    const del = await call("DELETE", `/v1/sites/${other.json.site.id}`, { key, env: a.env });
    expect(del.status).toBe(200);
    expect(del.json.next_steps).toBeUndefined();
    expect(a.sites[A1]!.replay_site_id).toBeNull();
  });

  it("an analytics failure never fails the replay call; the same analytics_site_id again repairs the link", async () => {
    const { key, account } = await signup();
    const a = analyticsStub(account, { [A1]: { domain: "repair.test" } });
    a.state.patchStatus = 500;
    const created = await call("POST", "/v1/sites", { key, body: { domain: "repair.test", analytics_site_id: A1 }, env: a.env });
    expect(created.status).toBe(201);
    const site = created.json.site.id as string;
    expect(created.json.site).toMatchObject({ analytics_site_id: A1, loads_with_analytics: false });
    expect(created.json.notes.join(" ")).toContain(`{"analytics_site_id": "${A1}"}`);
    expect(created.json.install.nothing_to_paste).toBeUndefined();
    expect(created.json.install.with_analytics).toContain("re-asserts the link");
    expect(created.json.next_steps.join(" ")).toContain(`/r/${site}.js`);
    a.state.patchStatus = 200;
    const repaired = await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: A1 }, env: a.env });
    expect(repaired.status).toBe(200);
    expect(repaired.json.site.loads_with_analytics).toBe(true);
    expect(a.sites[A1]!.replay_site_id).toBe(site);
    // a repeat is idempotent and still asks analytics (repair works even when nothing changed here)
    a.calls.length = 0;
    await call("PATCH", `/v1/sites/${site}`, { key, body: { analytics_site_id: A1 }, env: a.env });
    expect(a.calls).toEqual([`PATCH /v1/sites/${A1}`]);
    // other settings don't touch analytics
    a.calls.length = 0;
    await call("PATCH", `/v1/sites/${site}`, { key, body: { sample_rate: 0.5 }, env: a.env });
    expect(a.calls).toEqual([]);
    // analytics unreachable on delete: the delete still succeeds and says what to do
    const del = await call("DELETE", `/v1/sites/${site}`, {
      key,
      env: hosted({ ANALYTICS: { fetch: async () => new Response("down", { status: 503 }) } as unknown as Fetcher, INTERNAL_TOKEN: TOKEN }),
    });
    expect(del.status).toBe(200);
    expect(del.json.next_steps[0]).toContain(`PATCH /v1/sites/${A1} {"replay_site_id": null}`);
  });

  it("a site that isn't linked gets the account's analytics site suggested instead of a second snippet", async () => {
    const { key, account } = await signup();
    const a = analyticsStub(account, { [A1]: { domain: "other.test" }, [A2]: { domain: "suggest.test" } });
    const c = await call("POST", "/v1/sites", { key, body: { domain: "www.suggest.test" }, env: a.env });
    expect(c.json.install).toMatchObject({ loads_with_analytics: false, suggested_analytics_site_id: A2 });
    expect(c.json.install.with_analytics).toContain(`{"analytics_site_id": "${A2}"}`);
    expect(c.json.next_steps[0]).toContain("instead of pasting a second snippet");
    const i = await call("GET", `/v1/sites/${c.json.site.id}/install?framework=nextjs`, { key, env: a.env });
    expect(i.json.suggested_analytics_site_id).toBe(A2);
    // no analytics on this deployment: the generic hint
    const plain = await call("GET", `/v1/sites/${c.json.site.id}/install`, { key });
    expect(plain.json.suggested_analytics_site_id).toBeUndefined();
    expect(plain.json.with_analytics).toContain("no second snippet");
  });

  it("verify: the linked analytics site's tracker installs the recorder and proves the domain; another analytics site's doesn't", async () => {
    const { key, account } = await signup();
    const a = analyticsStub(account, { [A1]: { domain: "atrk.test" } });
    const created = await call("POST", "/v1/sites", { key, body: { domain: "atrk.test", analytics_site_id: A1 }, env: a.env });
    const site = created.json.site.id as string;
    let html = `<html><head><script data-site="${A2}" defer src="https://analytics.test/s.js"></script></head></html>`;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u === "https://atrk.test/")
        return new Response(html, {
          headers: { "content-security-policy": "script-src 'self' https://analytics.test; connect-src 'self'" },
        });
      if (u.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: [] });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const ids = (c: { id: string; ok: boolean }[]) => Object.fromEntries(c.map((x) => [x.id, x.ok]));
      const wrong = await call("POST", `/v1/sites/${site}/verify`, { key, body: {}, env: a.env });
      expect(wrong.json.domain_verified).toBe(false);
      expect(ids(wrong.json.checks)).toMatchObject({ snippet_present: false, domain_verified: false });
      expect(wrong.json.checks.find((c: { id: string }) => c.id === "snippet_present").fix).toContain(`analytics tracker for ${A1}`);

      html = `<html><head><script defer src="/_a/s.js" data-site="${A1}"></script></head></html>`;
      const ok = await call("POST", `/v1/sites/${site}/verify`, { key, body: {}, env: a.env });
      expect(ok.json).toMatchObject({
        installed: true,
        domain_verified: true,
        verification: { verified: true, method: "homepage_analytics" },
      });
      expect(ids(ok.json.checks)).toMatchObject({ snippet_present: true, csp: false });
      // the loader comes from this service directly, so the CSP advice names it
      expect(ok.json.fixes.join(" ")).toContain(
        `script-src http://replay.test/r/${site}.js http://replay.test/rec/; connect-src http://replay.test/i`,
      );

      // analytics no longer names this replay site: verify says so and refreshes loads_with_analytics
      a.sites[A1]!.replay_site_id = null;
      const stale = await call("POST", `/v1/sites/${site}/verify`, { key, body: {}, env: a.env });
      expect(stale.json.checks.find((c: { id: string }) => c.id === "snippet_present")).toMatchObject({ ok: false });
      expect(stale.json.fixes.join(" ")).toContain(`{"analytics_site_id": "${A1}"}`);
      expect((await call("GET", `/v1/sites/${site}`, { key })).json.site.loads_with_analytics).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
    // any attribute order and quoting; only an s.js src; only the linked analytics site's id
    expect(findAnalyticsTrackers(`<script data-site='${A1}' async src=https://a.test/s.js?v=1>`, A1)).toHaveLength(1);
    expect(findAnalyticsTrackers(`<script data-site="${A1}" src="https://a.test/tags.js">`, A1)).toHaveLength(0);
    expect(findAnalyticsTrackers(`<script src="https://a.test/s.js" data-site="${A2}">`, A1)).toHaveLength(0);
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
      chunk: emptyChunk(),
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
