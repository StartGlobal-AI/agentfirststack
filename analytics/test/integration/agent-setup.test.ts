import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * What a fresh agent hit following the setup prompt: test traffic that couldn't cover the first
 * pageview, URL props that kept their query strings, backend events that counted as visits, and the
 * stats response shape the manual didn't describe.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";

type Init = RequestInit & { key?: string; json?: unknown };

async function call(path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await SELF.fetch(
    new Request(`${B}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }),
  );
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let accountKey: string | null = null;
async function newSite(domain: string) {
  accountKey ??= (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const created = await call("/v1/sites", { method: "POST", key: accountKey, json: { domain } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { key: accountKey, site: created.body.site.id as string, proxyKey: created.body.install.first_party_proxy.proxy_key as string };
}

const beacon = (proxyKey: string, payload: Record<string, unknown>, ip: string) =>
  call("/_a/e", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "user-agent": UA, "content-type": "text/plain", "x-forwarded-for": ip, "x-afs-proxy-key": proxyKey },
  });
/** Top-level keys of an answer, without the optional `notes` (identity notes in cookieless mode). */
const keys = (o: Record<string, unknown>) =>
  Object.keys(o)
    .filter((k) => k !== "notes")
    .sort();
const sql = (key: string, site: string, q: string) => call(`/v1/sites/${site}/sql?q=${encodeURIComponent(q)}`, { key });

describe("?afsa_debug=1 in the page URL (finding 2)", () => {
  it("is test traffic from the page load's own pageview, even from a tracker that doesn't send dbg, and is never stored", async () => {
    const { key, site, proxyKey } = await newSite("flag.test");
    expect(
      (await beacon(proxyKey, { s: site, u: "https://flag.test/pricing?utm_source=newsletter&afsa_debug=1" }, "10.30.0.1")).body.ok,
    ).toBe(true);
    await beacon(proxyKey, { s: site, u: "https://flag.test/" }, "10.30.0.2");
    expect((await call(`/v1/sites/${site}/stats?period=today&metrics=visitors,pageviews`, { key })).body.metrics).toEqual({
      visitors: 1,
      pageviews: 1,
    });
    const dbg = await call(`/v1/sites/${site}/realtime?debug=only`, { key });
    expect(dbg.body.recent_events).toMatchObject([{ name: "pageview", pathname: "/pricing", debug: true }]);
    // the flag is taken out before the query is read: UTM tags still count, the URL has no query
    const rows = (await sql(key, site, "SELECT url, utm_source, debug FROM events ORDER BY id")).body.rows;
    expect(rows).toEqual([
      { url: "https://flag.test/pricing", utm_source: "newsletter", debug: 1 },
      { url: "https://flag.test/", utm_source: null, debug: 0 },
    ]);
    // server events: a url carrying it does the same; debug: true (what replay sends for test sessions) too
    const srv = await call(`/v1/sites/${site}/events`, {
      method: "POST",
      key,
      json: {
        events: [
          { name: "signup", url: "https://flag.test/?afsa_debug=1" },
          { name: "dead_click", url: "https://flag.test/", debug: true },
        ],
      },
    });
    expect(srv.body.accepted).toBe(2);
    expect((await call(`/v1/sites/${site}/stats?period=today&metrics=events`, { key })).body.metrics.events).toBe(1);
  });
});

describe("an agent's headless test browser (second setup run)", () => {
  it("is let through as test traffic when the visit is marked; otherwise dropped like any bot", async () => {
    const { key, site, proxyKey } = await newSite("headless.test");
    const headless = (payload: Record<string, unknown>, ip: string, ua: string) =>
      call("/_a/e", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "user-agent": ua, "content-type": "text/plain", "x-forwarded-for": ip, "x-afs-proxy-key": proxyKey },
      });
    const HEADLESS = UA.replace("Chrome/", "HeadlessChrome/");
    // unmarked: dropped as before (webdriver, and a HeadlessChrome user agent)
    expect((await headless({ s: site, u: "https://headless.test/", b: 1 }, "10.31.0.1", UA)).body).toMatchObject({ dropped: "bot" });
    expect((await headless({ s: site, u: "https://headless.test/" }, "10.31.0.2", HEADLESS)).body).toMatchObject({ dropped: "bot" });
    // marked with ?afsa_debug=1 or dbg: stored as test traffic
    expect((await headless({ s: site, u: "https://headless.test/?afsa_debug=1", b: 1 }, "10.31.0.3", UA)).body.ok).toBe(true);
    expect((await headless({ s: site, u: "https://headless.test/pricing", dbg: 1 }, "10.31.0.4", HEADLESS)).body.ok).toBe(true);
    // a crawler stays out even when it claims to be a test
    const crawler = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    expect((await headless({ s: site, u: "https://headless.test/?afsa_debug=1" }, "10.31.0.5", crawler)).body).toMatchObject({
      dropped: "bot",
    });
    expect((await call(`/v1/sites/${site}/stats?period=today&metrics=visitors`, { key })).body.metrics.visitors).toBe(0);
    const dbg = await call(`/v1/sites/${site}/realtime?debug=only`, { key });
    expect(dbg.body.recent_events.map((e: { pathname: string }) => e.pathname).sort()).toEqual(["/", "/pricing"]);
  });
});

describe("URL props keep no query string, from every source (finding 5)", () => {
  it("browser and server props are cut at ? or #; PII redaction still runs", async () => {
    const { key, site, proxyKey } = await newSite("props.test");
    await beacon(
      proxyKey,
      {
        s: site,
        n: "link_click",
        u: "https://props.test/",
        p: {
          link_href: "https://props.test/?afst_preview=tok_1&afsr=1#how",
          path: "/pricing?utm_campaign=launch",
          profile: "https://props.test/u/jane@example.com?ref=mail",
          label: "Pricing? See plans",
        },
      },
      "10.31.0.1",
    );
    // what the tags app's analytics destination sends ({{click_url}} as a prop) is a server event
    await call(`/v1/sites/${site}/events`, {
      method: "POST",
      key,
      json: { name: "cta_click", props: { link_href: "https://props.test/signup?gclid=abc123&email=jane@example.com#top" } },
    });
    const rows = (await sql(key, site, "SELECT name, props FROM events ORDER BY id")).body.rows.map((r: any) => [
      r.name,
      JSON.parse(r.props),
    ]);
    expect(rows).toEqual([
      [
        "link_click",
        { link_href: "https://props.test/", path: "/pricing", profile: "https://props.test/u/[email]", label: "Pricing? See plans" },
      ],
      ["cta_click", { link_href: "https://props.test/signup" }],
    ]);
  });
});

describe("server events with visit: false (finding 4)", () => {
  it("count as events and conversions, never as visitors or visits; REST, MCP and validate_only say so", async () => {
    const { key, site } = await newSite("novisit.test");
    await call(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Signup", type: "event", match: "signup" } });
    const r = await call(`/v1/sites/${site}/events`, { method: "POST", key, json: { name: "signup", visit: false, user_id: "agent_1" } });
    expect(r.status).toBe(202);
    expect(r.body.results).toEqual([{ index: 0, ok: true, visitor_id: null, session_id: null, visit: false }]);
    const mcp = await call("/mcp", {
      method: "POST",
      key,
      headers: { accept: "application/json, text/event-stream" },
      json: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "track_events", arguments: { site_id: site, events: [{ name: "signup", visit: false }] } },
      },
    });
    expect(JSON.parse(mcp.body.result.content[0].text).results[0]).toMatchObject({ ok: true, visit: false, session_id: null });
    const dry = await call(`/v1/sites/${site}/events?validate_only=true`, { method: "POST", key, json: { name: "signup", visit: false } });
    expect(dry.body.results[0]).toMatchObject({ ok: true, visit: false, stored: { name: "signup", no_visit: true } });
    const stats = await call(
      `/v1/sites/${site}/stats?period=today&metrics=visitors,visits,events,conversions,conversion_rate,bounce_rate`,
      {
        key,
      },
    );
    expect(stats.body.metrics).toMatchObject({ visitors: 0, visits: 0, events: 2, conversions: 2, conversion_rate: 0 });
    expect((await sql(key, site, "SELECT COUNT(*) AS n FROM sessions")).body.rows).toEqual([{ n: 0 }]);
    expect((await sql(key, site, "SELECT no_visit, user_id FROM events ORDER BY id")).body.rows).toEqual([
      { no_visit: 1, user_id: "agent_1" },
      { no_visit: 1, user_id: null },
    ]);
  });
});

describe("response shapes of stats, breakdown and timeseries match the manual (finding 6)", () => {
  it("stats puts breakdown rows under `breakdown`; breakdown at the top level; timeseries by date", async () => {
    const { key, site, proxyKey } = await newSite("shape.test");
    await beacon(proxyKey, { s: site, u: "https://shape.test/" }, "10.32.0.1");
    const period = {
      name: "today",
      from: expect.any(String),
      to: expect.any(String),
      timezone: "UTC",
      start: expect.any(Number),
      end: expect.any(Number),
    };
    const stats = (await call(`/v1/sites/${site}/stats?period=today&breakdown=channel&compare=previous`, { key })).body;
    expect(keys(stats)).toEqual(["breakdown", "comparison", "filters", "metrics", "period", "site_id"]);
    expect(stats).toMatchObject({ period, filters: [], metrics: { visitors: 1 } });
    expect(stats.comparison).toMatchObject({
      period: { name: "today", partial: expect.any(Boolean), mode: "previous" },
      metrics: {},
      change_percent: {},
    });
    expect(stats.breakdown).toMatchObject({ property: "channel", sort: "visitors", total_rows: 1, offset: 0, next_offset: null });
    expect(stats.breakdown.results[0]).toMatchObject({ value: "Direct", visitors: 1, comparison: { metrics: {}, change_percent: {} } });
    expect(stats.results).toBeUndefined();

    const bd = (await call(`/v1/sites/${site}/breakdown?period=today&breakdown=channel`, { key })).body;
    expect(keys(bd)).toEqual(["filters", "next_offset", "offset", "period", "property", "results", "site_id", "sort", "total_rows"]);
    expect(bd.results[0]).toMatchObject({ value: "Direct", visitors: 1 });

    const ts = (await call(`/v1/sites/${site}/timeseries?period=today&interval=hour`, { key })).body;
    expect(keys(ts)).toEqual(["annotations", "filters", "interval", "period", "results", "site_id"]);
    expect(ts.results[0]).toEqual({
      date: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:00$/),
      visitors: expect.any(Number),
      visits: expect.any(Number),
      pageviews: expect.any(Number),
      events: expect.any(Number),
      conversions: expect.any(Number),
      revenue: expect.any(Number),
    });

    const manual = (await call("/llms.txt")).body as string;
    expect(manual).toContain("the rows are under the key `breakdown`, not at the top");
    for (const k of [
      "total_rows, offset, next_offset",
      "annotations: [{id, kind, date",
      "default metrics visitors, visits, pageviews, events, conversions, revenue",
    ])
      expect(manual).toContain(k);
  });
});
