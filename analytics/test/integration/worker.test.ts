import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";

async function call(path: string, init: RequestInit & { key?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await SELF.fetch(`${B}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

/** A browser beacon as a first-party proxy forwards it: visitor IP in X-Forwarded-For + the site's proxy key. */
const beacon = (payload: unknown, ip: string, geo: Record<string, string> = {}, prefix = "", proxyKey = "") =>
  call(`${prefix}/e`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "user-agent": UA,
      "content-type": "text/plain",
      "x-forwarded-for": ip,
      ...(proxyKey ? { "x-afs-proxy-key": proxyKey } : {}),
      ...Object.fromEntries(Object.entries(geo).map(([k, v]) => [`x-dev-geo-${k}`, v])),
    },
  });

const mcp = (key: string, method: string, params: unknown = {}) =>
  call("/mcp", {
    method: "POST",
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });

async function newSite(domain: string) {
  const key = (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const created = await call("/v1/sites", { method: "POST", key, json: { domain } });
  return { key, site: created.body.site.id as string, proxyKey: created.body.install.first_party_proxy.proxy_key as string, created };
}

describe("analytics worker (workerd + D1 + SiteDO)", () => {
  it("signup -> site -> browser + server events -> goals -> stats, funnel, sql, mcp", async () => {
    const signup = await call("/v1/signup", { method: "POST" });
    expect(signup.status).toBe(201);
    const key = signup.body.api_key as string;
    expect(key).toMatch(/^(ana|afs)_/);

    const created = await call("/v1/sites", { method: "POST", key, json: { domain: "www.shop.test", timezone: "Europe/Berlin" } });
    expect(created.status).toBe(201);
    const site = created.body.site.id as string;
    const pk = created.body.install.first_party_proxy.proxy_key as string;
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body.site.domain).toBe("shop.test");
    expect((await call("/v1/sites", { method: "POST", key, json: { domain: "shop.test" } })).body.existing).toBe(true);

    const js = await SELF.fetch(`${B}/x/y/s.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("afs-analytics");

    expect(
      (await beacon({ s: site, u: "https://shop.test/", r: "https://chatgpt.com/" }, "1.1.1.1", { country: "DE", city: "Berlin" }, "", pk))
        .body.ok,
    ).toBe(true);
    expect(
      (await beacon({ s: site, u: "https://shop.test/pricing" }, "1.1.1.1", { country: "DE", city: "Berlin" }, "/_a", pk)).body.ok,
    ).toBe(true);
    expect((await beacon({ s: site, u: "https://shop.test/?gclid=abc" }, "2.2.2.2", { country: "US" }, "", pk)).body.ok).toBe(true);
    const bot = await call("/e", {
      method: "POST",
      body: JSON.stringify({ s: site, u: "https://shop.test/" }),
      headers: { "user-agent": "Googlebot/2.1" },
    });
    expect(bot.body).toMatchObject({ ok: false, dropped: "bot" });

    const srv = await call(`/v1/sites/${site}/events`, {
      method: "POST",
      key,
      json: {
        name: "purchase",
        url: "https://shop.test/checkout",
        ip: "1.1.1.1",
        user_agent: UA,
        revenue: { amount: 25, currency: "EUR" },
      },
    });
    expect(srv.status).toBe(202);
    expect(srv.body.accepted).toBe(1);

    await call(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Purchase", type: "event", match: "purchase" } });

    const stats = await call(`/v1/sites/${site}/stats?period=24h&breakdown=country&compare=previous`, { key });
    expect(stats.status).toBe(200);
    expect(stats.body.metrics).toMatchObject({ visitors: 2, pageviews: 3, events: 4, conversions: 1, conversion_rate: 50, revenue: 25 });
    expect(stats.body.breakdown.results.map((r: any) => [r.value, r.visitors])).toEqual([
      ["DE", 1],
      ["US", 1],
    ]);
    const ch = await call(`/v1/sites/${site}/breakdown?period=24h&breakdown=channel&metrics=visitors`, { key });
    expect(ch.body.results.map((r: any) => r.value).sort()).toEqual(["AI Assistants", "Paid Search"]);
    // the server purchase joined the AI Assistants session and inherited its geo
    const sql = await call(
      `/v1/sites/${site}/sql?q=${encodeURIComponent("SELECT channel, country, origin FROM events WHERE name = 'purchase'")}`,
      { key },
    );
    expect(sql.body.rows).toEqual([{ channel: "AI Assistants", country: "DE", origin: "server" }]);

    const funnel = await call(`/v1/sites/${site}/funnel?period=24h&steps=/,/pricing,goal:Purchase`, { key });
    expect(funnel.body.steps.map((s: any) => s.visitors)).toEqual([2, 1, 1]);

    const ts = await call(`/v1/sites/${site}/timeseries?period=7d`, { key });
    expect(ts.body.results).toHaveLength(7);

    const rtc = await mcp(key, "tools/call", { name: "get_realtime", arguments: { site_id: site } });
    const rt = JSON.parse(rtc.body.result.content[0].text);
    expect(rt.visitors_last_5m).toBe(2);
    expect(rt.recent_events).toHaveLength(4);

    // retention alarm runs and keeps recent data
    const stub = env.SITE.get(env.SITE.idFromName(site));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await call(`/v1/sites/${site}/stats?period=24h&metrics=events`, { key })).body.metrics.events).toBe(4);

    const del = await call(`/v1/sites/${site}`, { method: "DELETE", key });
    expect(del.body.deleted).toBe(site);
    expect((await beacon({ s: site, u: "https://shop.test/" }, "3.3.3.3")).status).toBe(404);
  });

  it("auth: signup is public, /v1 needs a key, errors carry hints", async () => {
    const r = await call("/v1/sites");
    expect(r.status).toBe(401);
    expect(r.body.error.hint).toContain("signup");
    expect((await call("/nope")).body.error.hint).toContain("llms.txt");
    const llms = await call("/llms.txt");
    expect(llms.headers.get("content-type")).toContain("markdown");
    expect(llms.body).toContain("track_events");
  });

  it("/e trusts forwarded IP and geo only with the site's proxy key", async () => {
    const { key, site, proxyKey } = await newSite("geo.test");
    const send = (ip: string, headers: Record<string, string>, prefix = "") =>
      call(`${prefix}/e`, {
        method: "POST",
        body: JSON.stringify({ s: site, u: "https://geo.test/" }),
        headers: { "user-agent": UA, "x-forwarded-for": ip, "x-afs-geo-country": "JP", "x-afs-geo-city": "Tokyo", ...headers },
      });
    // spoofed headers straight to the collector: ignored, so two "different" IPs are one visitor
    const a = await send("5.5.5.5", {});
    const b = await send("6.6.6.6", { "x-afs-proxy-key": "0".repeat(64) });
    expect(a.body.ok && b.body.ok).toBe(true);
    expect(a.body.v).toBe(b.body.v);
    // through a proxy that sends the key: the forwarded IP and geo count
    const c = await send("7.7.7.7", { "x-afs-proxy-key": proxyKey }, "/_a");
    const d = await send("8.8.8.8", { "x-afs-proxy-key": proxyKey }, "/_a");
    expect(c.body.v).not.toBe(a.body.v);
    expect(c.body.v).not.toBe(d.body.v);
    const rows = await call(`/v1/sites/${site}/sql?q=${encodeURIComponent("SELECT visitor_id, country, city FROM events ORDER BY id")}`, {
      key,
    });
    expect(rows.body.rows.map((r: any) => [r.country, r.city])).toEqual([
      [null, null],
      [null, null],
      ["JP", "Tokyo"],
      ["JP", "Tokyo"],
    ]);
    // a proxied path without a valid key is counted as a warning that get_site (and verify) report
    await send("9.9.9.9", {}, "/_a");
    const got = await call(`/v1/sites/${site}`, { key });
    expect(got.body.data.warnings_last_7d).toMatchObject({ proxy_key_missing: { count: 1 } });
    expect(got.body.data.untrusted.warning_samples).toEqual({ proxy_key_missing: "geo.test" });
    expect(got.body.data.dropped_last_7d).toEqual({});
    // every proxy snippet carries the key and the renamed geo headers
    const inst = (await call(`/v1/sites/${site}/install`, { key })).body.first_party_proxy;
    for (const k of ["cloudflare_worker", "nextjs", "vercel", "netlify", "nginx"]) expect(inst[k].code).toContain(proxyKey);
    expect(JSON.stringify(inst)).not.toMatch(/x-sg-|sga/i);
    expect(inst.cloudflare_worker.code).toContain('"x-afs-geo-"');
  });

  it("/e refuses bodies over 16 KB without buffering them", async () => {
    const { site } = await newSite("big.test");
    const big = JSON.stringify({ s: site, u: "https://big.test/", p: { x: "a".repeat(17_000) } });
    const declared = await call("/e", { method: "POST", body: big, headers: { "user-agent": UA } });
    expect(declared.status).toBe(413);
    expect(declared.body).toMatchObject({ ok: false, error: "payload_too_large" });
    expect(declared.headers.get("access-control-allow-origin")).toBe("*");
    // a streamed body (no content-length) is cut off by the capped read
    const chunk = new TextEncoder().encode("a".repeat(4096));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (++pulls > 64) c.close();
        else c.enqueue(chunk);
      },
    });
    const res = await SELF.fetch(`${B}/e`, { method: "POST", body: stream, headers: { "user-agent": UA } });
    expect(res.status).toBe(413);
    await res.body?.cancel();
    // just under the limit still works
    const ok = await call("/e", {
      method: "POST",
      body: JSON.stringify({ s: site, u: "https://big.test/", p: { x: "a".repeat(15_000) } }),
      headers: { "user-agent": UA },
    });
    expect(ok.body.ok).toBe(true);
  });

  it("verify needs a write key: REST refuses read keys and MCP hides verify_install from them", async () => {
    const { key, site } = await newSite("scope.test");
    const ro = (await call("/v1/keys", { method: "POST", key, json: { name: "ro", scope: "read" } })).body.api_key as string;
    expect((await call(`/v1/sites/${site}/verify`, { method: "POST", key: ro, json: {} })).status).toBe(403);
    const names = async (k: string) => ((await mcp(k, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(await names(ro)).not.toContain("verify_install");
    expect(await names(ro)).toContain("get_stats");
    expect(await names(key)).toContain("verify_install");
  });

  it("SQL: runaway shapes are rejected (REST and MCP); a query that keeps scanning is stopped", async () => {
    const { key, site } = await newSite("sql.test");
    const events = Array.from({ length: 60 }, (_, i) => ({ name: "pageview", url: `https://sql.test/p${i}`, user_id: `u${i}` }));
    expect((await call(`/v1/sites/${site}/events`, { method: "POST", key, json: { events } })).body.accepted).toBe(60);
    const sql = (q: string) => call(`/v1/sites/${site}/sql?q=${encodeURIComponent(q)}`, { key });
    for (const q of [
      "WITH x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x",
      "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x",
      "SELECT COUNT(*) FROM events a, events b",
      "SELECT COUNT(*) FROM events a JOIN events b",
      "SELECT COUNT(*) FROM events a JOIN events b ON 1 JOIN events c ON 1 JOIN events d ON 1",
    ]) {
      const r = await sql(q);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("sql_rejected");
      const m = await mcp(key, "tools/call", { name: "query_sql", arguments: { site_id: site, q } });
      expect(m.body.result.isError).toBe(true);
      expect(JSON.parse(m.body.result.content[0].text).error.code).toBe("sql_rejected");
    }
    // generate_series would be an unbounded generator: refused by name (it isn't in the DO's SQLite either)
    expect((await sql("SELECT COUNT(*) FROM generate_series(1, 1000000000000)")).body.error.code).toBe("sql_rejected");
    // legitimate queries still run (the integration config sets SQL_MAX_ROWS_READ=2000)
    expect((await sql("SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id")).body.rows).toEqual([{ n: 60 }]);
    expect((await sql("SELECT pathname FROM events ORDER BY id")).body.row_count).toBe(60);
    // a correlated subquery that scans all 60 events for every row reads ~3600 rows: stopped
    const slow = await sql("SELECT (SELECT COUNT(*) FROM events b WHERE instr(b.url, a.pathname) > 0) AS n FROM events a");
    expect(slow.status).toBe(400);
    expect(slow.body.error.code).toBe("sql_too_expensive");
    expect(slow.body.error.hint).toBeTruthy();
  });
});
