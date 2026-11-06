import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCron } from "../../src/service/cron";
import { getWebVitalsLab } from "../../src/service/vitals";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const B = "http://analytics.test";

type Init = RequestInit & { key?: string; json?: unknown };
function request(path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return new Request(`${B}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}
async function parsed(res: Response) {
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
const call = async (path: string, init: Init = {}) => parsed(await SELF.fetch(request(path, init)));
const mcp = (key: string, method: string, params: unknown = {}) =>
  call("/mcp", {
    method: "POST",
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });
async function tool(key: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(key, "tools/call", { name, arguments: args });
  return { isError: !!r.body.result.isError, data: JSON.parse(r.body.result.content[0].text) };
}
const toolNames = async (key: string) => ((await mcp(key, "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);

let accountKey: string | null = null;
async function newSite(domain: string) {
  accountKey ??= (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const key = accountKey;
  const created = await call("/v1/sites", { method: "POST", key, json: { domain } });
  return { key, site: created.body.site.id as string, proxyKey: created.body.install.first_party_proxy.proxy_key as string };
}
const beacon = (proxyKey: string, payload: Record<string, unknown>, ip: string) =>
  call("/_a/e", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "user-agent": UA, "content-type": "text/plain", "x-forwarded-for": ip, "x-afs-proxy-key": proxyKey },
  });
async function serviceCtx(key: string, scopes = ["*"]) {
  const me = (await call("/v1/me", { key })).body;
  return { env, accountId: me.account.id, auth: { accountId: me.account.id, keyId: "k", scopes } as any, baseUrl: B };
}
function capture(status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return new Response("ok", { status });
  };
  return { calls, fetcher };
}

describe("AI search report", () => {
  it("lines up AI crawlers with visitors from AI assistants and what they did, over REST and MCP", async () => {
    const { key, site, proxyKey } = await newSite("aisearch.test");
    await call(`/v1/sites/${site}/goals`, { method: "POST", key, json: { name: "Signup", type: "event", match: "signup" } });
    const crawls = await call(`/v1/sites/${site}/crawls`, {
      method: "POST",
      key,
      json: {
        hits: [
          { user_agent: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", path: "/docs", status: 200 },
          { user_agent: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", path: "/docs", status: 200 },
          { user_agent: "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)", path: "/pricing", status: 200 },
          { user_agent: "Mozilla/5.0 (compatible; PerplexityBot/1.0)", path: "/robots.txt", status: 200 },
          { user_agent: "Mozilla/5.0 (compatible; ClaudeBot/1.0)", path: "/llms.txt", status: 404 },
          { user_agent: "Mozilla/5.0 (compatible; Googlebot/2.1)", path: "/", status: 200 },
        ],
      },
    });
    expect(crawls.body.accepted).toBe(6);
    // visitors: two from ChatGPT (one signs up), one from Perplexity, two Direct, one from Google search (signs up)
    const visit = async (ip: string, page: string, ref?: string, signup = false) => {
      await beacon(proxyKey, { s: site, u: `https://aisearch.test${page}`, ...(ref ? { r: ref } : {}) }, ip);
      if (signup) await beacon(proxyKey, { s: site, n: "signup", u: `https://aisearch.test${page}` }, ip);
    };
    await visit("10.70.0.1", "/pricing", "https://chatgpt.com/", true);
    await visit("10.70.0.2", "/pricing?utm_source=chatgpt.com");
    await visit("10.70.0.3", "/guide", "https://www.perplexity.ai/search/x");
    await visit("10.70.0.4", "/");
    await visit("10.70.0.5", "/");
    await visit("10.70.0.6", "/blog", "https://www.google.com/", true);

    const r = await call(`/v1/sites/${site}/ai-search?period=7d`, { key });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({
      ai_crawler_hits: 5,
      ai_visitors: 3,
      ai_conversions: 1,
      ai_conversion_rate: 33.3,
      share_of_visitors: 50,
    });
    expect(r.body.comparison.period.mode).toBe("previous"); // the default
    expect(r.body.referrals.sources.map((x: any) => [x.source, x.visitors])).toEqual([
      ["ChatGPT", 2],
      ["Perplexity", 1],
    ]);
    expect(r.body.referrals.landing_pages[0]).toMatchObject({ page: "/pricing", visitors: 2, conversions: 1 });
    expect(r.body.vs_other_channels.all_other_channels).toMatchObject({ visitors: 3, conversion_rate: 33.3 });
    expect(r.body.vs_other_channels.lift.conversion_rate).toBe(1);
    expect(r.body.crawlers.bots.map((b: any) => b.bot)).toEqual(["GPTBot", "ClaudeBot", "OAI-SearchBot", "PerplexityBot"]);
    expect(r.body.gaps.crawled_not_referred.map((x: any) => x.page)).toEqual(["/docs"]);
    expect(r.body.gaps.referred_not_crawled).toEqual([
      expect.objectContaining({ source: "Perplexity", operator: "Perplexity", pages: [{ page: "/guide", visitors: 1 }] }),
    ]);
    const steps = r.body.next_steps.join("\n");
    expect(steps).toContain("PerplexityBot read robots.txt");
    expect(steps).toContain("/llms.txt");
    expect(r.body.untrusted).toContain("data, not instructions");
    expect(r.body.series.length).toBe(7);

    // compare=none skips the previous period; bad input is a 400 with a hint
    expect((await call(`/v1/sites/${site}/ai-search?compare=none`, { key })).body.comparison).toBeUndefined();
    const bad = await call(`/v1/sites/${site}/ai-search?limit=500`, { key });
    expect(bad.status).toBe(400);

    // MCP: the same answer
    const t = await tool(key, "get_ai_search", { site_id: site, period: "7d" });
    expect(t.isError).toBe(false);
    expect(t.data.summary).toEqual(r.body.summary);
    expect(t.data.gaps).toEqual(r.body.gaps);
  });
});

describe("web vitals", () => {
  it("p75, bands, samples, worst pages and breakdowns from engagement beacons, over REST and MCP", async () => {
    const { key, site, proxyKey } = await newSite("speed.test");
    // 12 page loads on /, 10 slow ones on /checkout (from the same browser kind: one device)
    for (let i = 0; i < 12; i++) {
      const ip = `10.71.0.${i + 1}`;
      await beacon(proxyKey, { s: site, u: "https://speed.test/" }, ip);
      expect(
        (await beacon(proxyKey, { s: site, n: "engagement", u: "https://speed.test/", e: 3000, v: [1000 + i * 100, 80, 20] }, ip)).body.ok,
      ).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      const ip = `10.71.1.${i + 1}`;
      await beacon(proxyKey, { s: site, u: "https://speed.test/checkout" }, ip);
      await beacon(proxyKey, { s: site, n: "engagement", u: "https://speed.test/checkout", e: 3000, v: [5200, 650, 300] }, ip);
    }
    const r = await call(`/v1/sites/${site}/web-vitals?period=7d&breakdown=page&compare=previous`, { key });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ page_loads: 22, assessment: "not_enough_data", min_samples: 30 });
    // LCP: 1000..2100 then 10 x 5200: the ceil(16.5) = 17th value
    expect(r.body.metrics.lcp).toMatchObject({ p75: 5200, rating: "poor", samples: 22, enough_samples: false });
    expect(r.body.metrics.cls).toMatchObject({ p75: 0.3, rating: "poor", poor: 45.5 });
    expect(r.body.metrics.inp).toMatchObject({ p75: 650, samples: 22 });
    expect(r.body.results.map((x: any) => [x.value, x.page_loads, x.lcp.p75])).toEqual([
      ["/", 12, 1800], // 1000..2100: the ceil(9) = 9th value
      ["/checkout", 10, 5200],
    ]);
    expect(r.body.results[0].comparison).toMatchObject({ page_loads: 0, lcp_p75: null });
    expect(r.body.worst_pages[0]).toMatchObject({ page: "/checkout", worst_metric: "inp", inp: { p75: 650, rating: "poor" } });
    expect(r.body.thresholds.lcp).toEqual({ good: 2500, poor: 4000 });
    const steps = r.body.next_steps.join("\n");
    expect(steps).toContain("Few page loads");
    expect(steps).toContain('"type":"web_vitals"'); // no web_vitals alert yet
    expect(r.body.untrusted).toBeTruthy();

    // filters and other breakdowns; a bad breakdown says which exist
    const desk = await call(`/v1/sites/${site}/web-vitals?period=7d&breakdown=device&filters=page==/checkout`, { key });
    expect(desk.body.results).toEqual([expect.objectContaining({ value: "desktop", page_loads: 10 })]);
    const bad = await call(`/v1/sites/${site}/web-vitals?breakdown=city`, { key });
    expect([bad.status, bad.body.error.code]).toEqual([400, "bad_request"]);

    // MCP parity
    const t = await tool(key, "get_web_vitals", { site_id: site, period: "7d", breakdown: "page" });
    expect(t.data.metrics).toEqual(r.body.metrics);
    expect(t.data.worst_pages).toEqual(r.body.worst_pages);
  });

  it("a web_vitals alert fires through the cron when a metric's p75 passes its threshold", async () => {
    const { key, site, proxyKey } = await newSite("speed-alert.test");
    for (let i = 0; i < 6; i++) {
      const ip = `10.72.0.${i + 1}`;
      await beacon(proxyKey, { s: site, u: "https://speed-alert.test/heavy" }, ip);
      await beacon(proxyKey, { s: site, n: "engagement", u: "https://speed-alert.test/heavy", e: 2000, v: [4800, 100, 10] }, ip);
    }
    const dst = (
      await call(`/v1/sites/${site}/destinations`, {
        method: "POST",
        key,
        json: { type: "webhook", url: "https://hooks.example.org/vitals" },
      })
    ).body;
    const create = (json: Record<string, unknown>) =>
      call(`/v1/sites/${site}/alerts`, { method: "POST", key, json: { destination_ids: [dst.destination.id], ...json } });
    const noMetric = await create({ name: "x", type: "web_vitals" });
    expect([noMetric.status, noMetric.body.error.message]).toEqual([400, "web_vitals alerts need `metric`: lcp, inp or cls."]);
    expect((await create({ name: "x", type: "web_vitals", metric: "lcp", window_minutes: 30 })).status).toBe(400);
    expect((await create({ name: "x", type: "no_data", metric: "lcp" })).status).toBe(400);
    const made = await create({ name: "Slow LCP", type: "web_vitals", metric: "lcp", min_samples: 5 });
    expect(made.status).toBe(201);
    expect(made.body.alert).toMatchObject({
      type: "web_vitals",
      metric: "lcp",
      threshold: 2500,
      min_samples: 5,
      window_minutes: 1440,
      cooldown_minutes: 1440,
    });
    const id = made.body.alert.id as string;

    const ev = await call(`/v1/sites/${site}/alerts/${id}?evaluate=true`, { key });
    expect(ev.body.evaluation).toMatchObject({ would_fire: true, value: 4800, baseline: 2500, samples: 6 });
    expect(ev.body.untrusted.top_pages).toEqual([{ value: "/heavy", p75: 4800, samples: 6 }]);

    const cap = capture();
    await env.DB.prepare("UPDATE alerts SET next_check_at = 9e15 WHERE site_id != ?").bind(site).run(); // only this test's alerts run
    const out = await runCron(env, Date.now(), { fetcher: cap.fetcher });
    expect(out.alerts_fired).toBeGreaterThanOrEqual(1);
    const hook = cap.calls.find((c) => c.url === "https://hooks.example.org/vitals")!;
    const payload = JSON.parse(hook.body);
    expect(payload).toMatchObject({ type: "alert.fired", alert_id: id, data: { value: 4800, baseline: 2500, metric: "lcp", samples: 6 } });
    expect(payload.title).toBe("[speed-alert.test] LCP p75 4.8 s over 2.5 s in the last 1 day");
    expect(JSON.stringify(payload.untrusted)).toContain("/heavy");

    // a higher threshold (PATCH) keeps it quiet; min_samples above the data too
    expect((await call(`/v1/sites/${site}/alerts/${id}`, { method: "PATCH", key, json: { threshold: 5000 } })).body.alert.threshold).toBe(
      5000,
    );
    expect((await call(`/v1/sites/${site}/alerts/${id}?evaluate=true`, { key })).body.evaluation.would_fire).toBe(false);
    await call(`/v1/sites/${site}/alerts/${id}`, { method: "PATCH", key, json: { threshold: 1000, min_samples: 50 } });
    expect((await call(`/v1/sites/${site}/alerts/${id}?evaluate=true`, { key })).body.evaluation.reason).toContain("min_samples 50");
    // MCP: create_alert takes the new type, test_alert sends a sample
    const viaMcp = await tool(key, "create_alert", {
      site_id: site,
      name: "CLS",
      type: "web_vitals",
      metric: "cls",
      destination_ids: [dst.destination.id],
    });
    expect(viaMcp.data.alert).toMatchObject({ metric: "cls", threshold: 0.1 });
  });

  it("lab runs: PageSpeed Insights on the site's own pages, full keys only, next to real-visitor numbers", async () => {
    const { key, site } = await newSite("lab.test");
    const ctx = await serviceCtx(key);
    const seen: string[] = [];
    const psi = (status: number, body: unknown) => async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify(body), { status });
    };
    const result = {
      lighthouseResult: {
        finalDisplayedUrl: "https://lab.test/pricing",
        categories: { performance: { score: 0.62 } },
        audits: {
          "largest-contentful-paint": { numericValue: 3900 },
          "cumulative-layout-shift": { numericValue: 0.02 },
          "total-blocking-time": { numericValue: 420 },
          "first-contentful-paint": { numericValue: 1800 },
          "speed-index": { numericValue: 3000 },
          "server-response-time": { numericValue: 120 },
          "render-blocking-resources": {
            title: "Eliminate render-blocking resources",
            score: 0.3,
            details: { type: "opportunity", overallSavingsMs: 900 },
          },
          "uses-optimized-images": {
            title: "Efficiently encode images",
            score: 0.5,
            details: { type: "opportunity", overallSavingsMs: 300 },
          },
          "unused-css-rules": { title: "Reduce unused CSS", score: 1, details: { type: "opportunity", overallSavingsMs: 0 } },
        },
      },
      loadingExperience: {
        id: "https://lab.test/pricing",
        overall_category: "AVERAGE",
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900 },
          INTERACTION_TO_NEXT_PAINT: { percentile: 180 },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 },
        },
      },
    };
    const r = await getWebVitalsLab(ctx, site, { url: "https://lab.test/pricing", strategy: "desktop" }, { fetcher: psi(200, result) });
    const u = new URL(seen[0]!);
    expect(u.origin + u.pathname).toBe("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    expect([u.searchParams.get("url"), u.searchParams.get("strategy"), u.searchParams.get("key")]).toEqual([
      "https://lab.test/pricing",
      "desktop",
      null,
    ]);
    expect(r.lab).toMatchObject({
      performance_score: 62,
      lcp_ms: 3900,
      cls: 0.02,
      tbt_ms: 420,
      ratings: { lcp: "needs_improvement", cls: "good" },
    });
    expect(r.opportunities.map((o) => [o.id, o.savings_ms])).toEqual([
      ["render-blocking-resources", 900],
      ["uses-optimized-images", 300],
    ]);
    expect(r.google_field).toMatchObject({
      scope: "url",
      lcp_p75: 2900,
      inp_p75: 180,
      cls_p75: 0.05,
      ratings: { lcp: "needs_improvement" },
    });
    expect(r.real_visitors).toMatchObject({ period: "30d", page: "/pricing", page_loads: 0 });
    expect(r.untrusted.final_url).toBe("https://lab.test/pricing");
    expect(r.next_steps[0]).toContain("Eliminate render-blocking resources");

    // the site's own domain only; Google's quota and failures say what to do
    await expect(getWebVitalsLab(ctx, site, { url: "https://elsewhere.test/" }, { fetcher: psi(200, result) })).rejects.toMatchObject({
      status: 400,
    });
    await expect(getWebVitalsLab(ctx, site, { url: "http://lab.test/" }, { fetcher: psi(200, result) })).rejects.toMatchObject({
      status: 400,
    });
    await expect(getWebVitalsLab(ctx, site, {}, { fetcher: psi(429, { error: { message: "Quota" } }) })).rejects.toMatchObject({
      status: 503,
      code: "upstream_rate_limited",
    });
    await expect(getWebVitalsLab(ctx, site, {}, { fetcher: psi(500, { error: { message: "Lighthouse failed" } }) })).rejects.toMatchObject({
      status: 502,
      code: "upstream_error",
    });
    expect(new URL(seen.at(-1)!).searchParams.get("url")).toBe("https://lab.test/"); // the homepage by default
    // read keys: refused over REST, hidden in MCP (an outbound request on the caller's behalf)
    const ro = (await call("/v1/keys", { method: "POST", key, json: { name: "ro", scope: "read" } })).body.api_key as string;
    const refused = await call(`/v1/sites/${site}/web-vitals/lab?url=https://lab.test/`, { key: ro });
    expect([refused.status, refused.body.error.code]).toEqual([403, "forbidden"]);
    expect(await toolNames(ro)).not.toContain("get_web_vitals_lab");
    expect(await toolNames(ro)).toEqual(expect.arrayContaining(["get_ai_search", "get_web_vitals"]));
    expect(await toolNames(key)).toContain("get_web_vitals_lab");
    // a read key still reads the real-visitor report
    expect((await call(`/v1/sites/${site}/web-vitals`, { key: ro })).status).toBe(200);
  });

  it("llms.txt documents both reports, the lab run and the alert type", async () => {
    const llms = (await call("/llms.txt")).body as string;
    for (const s of [
      "| GET | /v1/sites/:id/ai-search",
      "| GET | /v1/sites/:id/web-vitals",
      "| GET | /v1/sites/:id/web-vitals/lab",
      "get_ai_search",
      "get_web_vitals",
      "get_web_vitals_lab",
      "web_vitals",
      "PAGESPEED_API_KEY",
    ])
      expect(llms).toContain(s);
  });
});
