import { describe, expect, it } from "vitest";
import { aiSearch } from "../../src/do/ai-search";
import { alertNumbers } from "../../src/do/alerts";
import { recordCrawls } from "../../src/do/crawlers";
import * as engine from "../../src/do/engine";
import { webVitals } from "../../src/do/vitals";
import { aiSearchNextSteps, isPagePath, robotsAllows } from "../../src/lib/ai-search";
import { type AlertRule, alertText, decide, vitalsThreshold } from "../../src/lib/alerts";
import { assess, formatVital, rate } from "../../src/lib/vitals";
import { DAY, HOUR, NOW, ev, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const S = settings();

/** One page load: its pageview, then the engagement beacon with the page's vitals. */
function load(
  db: ReturnType<typeof memoryDb>,
  v: string,
  o: { page?: string; device?: string; lcp?: number | null; inp?: number | null; cls?: number | null; ts?: number },
) {
  const page = o.page ?? "/";
  const ts = o.ts ?? NOW - HOUR;
  engine.ingest(db, [ev({ visitor_hash: v, ts, pathname: page, url: `https://example.com${page}`, device: o.device ?? "desktop" })], NOW);
  engine.ingest(
    db,
    [
      ev({
        visitor_hash: v,
        ts: ts + 1000,
        name: "engagement",
        pathname: page,
        engagement_ms: 5000,
        lcp: o.lcp ?? null,
        inp: o.inp ?? null,
        cls: o.cls ?? null,
      }),
    ],
    NOW,
  );
}

describe("web vitals", () => {
  it("ratings, formatting and Google's assessment", () => {
    expect([rate("lcp", 2500), rate("lcp", 2501), rate("lcp", 4001), rate("cls", 0.1), rate("inp", 500), rate("inp", null)]).toEqual([
      "good",
      "needs_improvement",
      "poor",
      "good",
      "needs_improvement",
      null,
    ]);
    expect([formatVital("lcp", 2140), formatVital("lcp", 640), formatVital("inp", 180.4), formatVital("cls", 0.081)]).toEqual([
      "2.1 s",
      "640 ms",
      "180 ms",
      "0.08",
    ]);
    const m = (rating: any, enough = true) => ({
      p75: 1,
      rating,
      samples: enough ? 50 : 5,
      good: 0,
      needs_improvement: 0,
      poor: 0,
      enough_samples: enough,
    });
    expect(assess({ lcp: m("good"), inp: m(null, false), cls: m("good") })).toBe("passed");
    expect(assess({ lcp: m("good"), inp: m("poor"), cls: m("good") })).toBe("failed");
    expect(assess({ lcp: m("poor", false), inp: m(null, false), cls: m("good") })).toBe("not_enough_data");
  });

  it("p75 by nearest rank, bands, samples, worst pages, breakdown and comparison", () => {
    const db = memoryDb();
    engine.configure(db, S);
    for (let i = 0; i < 40; i++) load(db, `a${i}`, { lcp: 100 * (i + 1), inp: i < 12 ? 700 : 100, cls: 0.05 });
    for (let i = 0; i < 12; i++) load(db, `b${i}`, { page: "/slow", device: "mobile", lcp: 5000, cls: 0.3 });
    for (let i = 0; i < 5; i++) engine.ingest(db, [ev({ visitor_hash: `c${i}`, pathname: "/novitals" })], NOW);
    for (let i = 0; i < 30; i++) load(db, `p${i}`, { lcp: 1000, cls: 0.01, ts: NOW - 8 * DAY });

    const r = webVitals(db, S, { period: "7d", filters: [], breakdown: "device", compare: { mode: "previous" } }, NOW) as any;
    expect(r.page_loads).toBe(52);
    expect(r.coverage).toEqual({ pageviews: 57, with_vitals: 52, share: 91.2 });
    // 100..4000 then 12 x 5000: the ceil(0.75 x 52) = 39th value
    expect(r.metrics.lcp).toMatchObject({ p75: 3900, rating: "needs_improvement", samples: 52, enough_samples: true });
    expect(r.metrics.lcp.good + r.metrics.lcp.needs_improvement + r.metrics.lcp.poor).toBeCloseTo(100, 0);
    expect(r.metrics.lcp.poor).toBe(23.1); // 12 of 52
    expect(r.metrics.inp).toMatchObject({ p75: 700, samples: 40, poor: 30 }); // 28 x 100, 12 x 700: the 30th
    expect(r.metrics.cls).toMatchObject({ p75: 0.05, rating: "good", poor: 23.1 }); // /slow is poor, but only 12 of 52 loads
    expect(r.assessment).toBe("failed");
    expect(r.worst_pages.map((p: any) => [p.page, p.worst_metric])).toEqual([
      ["/", "inp"], // 700 / 200 = 3.5x
      ["/slow", "cls"], // 0.3 / 0.1 = 3x
    ]);
    expect(r.results.map((x: any) => [x.value, x.page_loads, x.lcp.p75])).toEqual([
      ["desktop", 40, 3000],
      ["mobile", 12, 5000],
    ]);
    expect(r.results[1].lcp.enough_samples).toBe(false);
    expect(r.comparison).toMatchObject({ page_loads: 30, metrics: { lcp: { p75: 1000 } }, change_percent: { lcp_p75: 290 } });
    expect(r.results[0].comparison).toMatchObject({ page_loads: 30, lcp_p75: 1000, change_percent: { lcp_p75: 200 } });
    expect(r.results[1].comparison).toMatchObject({ page_loads: 0, lcp_p75: null, change_percent: { lcp_p75: null } });
    expect(r.next_steps.join(" ")).toContain("LCP p75 is 3.9 s");
    expect(r.next_steps.join(" ")).toContain("/web-vitals/lab");

    // filters apply; a page breakdown reuses the page rows
    const m = webVitals(db, S, { period: "7d", filters: [{ key: "device", op: "==", values: ["mobile"] }], breakdown: "page" }, NOW) as any;
    expect(m.page_loads).toBe(12);
    expect(m.results).toEqual([expect.objectContaining({ value: "/slow", page_loads: 12 })]);
    expect(m.comparison).toBeUndefined();

    // nothing yet: the advice says where vitals come from
    const none = webVitals(memoryDbWith(), S, { period: "7d", filters: [] }, NOW) as any;
    expect(none).toMatchObject({ page_loads: 0, assessment: "not_enough_data", worst_pages: [] });
    expect(none.next_steps[0]).toContain("Install the tracker");
  });

  it("web_vitals alerts: numbers from the window, decision by p75 and min_samples", () => {
    const db = memoryDb();
    engine.configure(db, S);
    for (let i = 0; i < 40; i++) load(db, `v${i}`, { page: i < 8 ? "/heavy" : "/", lcp: i < 8 ? 6000 : 2000 });
    const n = alertNumbers(db, S, { type: "web_vitals", window_minutes: 1440, filters: [], metric: "lcp" }, NOW) as any;
    expect(n.vitals).toMatchObject({ metric: "lcp", p75: 2000, samples: 40 });
    expect(n.top_pages[0]).toEqual({ value: "/heavy", p75: 6000, samples: 8 });
    const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
      type: "web_vitals",
      window_minutes: 1440,
      threshold: null,
      min_visitors: null,
      goal: null,
      metric: "lcp",
      ...over,
    });
    expect(vitalsThreshold(rule())).toBe(2500);
    expect(vitalsThreshold(rule({ metric: "cls" }))).toBe(0.1);
    expect(decide(rule(), n, {}, NOW)).toMatchObject({ fire: false, value: 2000, baseline: 2500 });
    const d = decide(rule({ threshold: 1500 }), n, {}, NOW);
    expect(d).toMatchObject({ fire: true, value: 2000, baseline: 1500, reason: "LCP p75 2 s is over 1.5 s (40 page loads)" });
    expect(decide(rule({ threshold: 1500, min_samples: 50 }), n, {}, NOW)).toMatchObject({
      fire: false,
      reason: expect.stringContaining("min_samples 50"),
    });
    const text = alertText({ ...rule({ threshold: 1500 }), name: "Slow LCP" }, "example.com", d, n);
    expect(text.title).toBe("[example.com] LCP p75 2 s over 1.5 s in the last 1 day");
    expect(text.lines.join(" ")).toContain("good up to 2.5 s");
  });
});

function memoryDbWith() {
  const db = memoryDb();
  engine.configure(db, S);
  return db;
}

describe("AI search", () => {
  it("pages vs files", () => {
    expect(["/", "/docs", "/a/b.html", "/x.php"].every(isPagePath)).toBe(true);
    expect(["/robots.txt", "/llms.txt", "/sitemap.xml", "/img/a.png", "/doc.pdf", "(other)"].some(isPagePath)).toBe(false);
  });

  it("crawlers, assistants, what their visitors did, the gaps and the advice", () => {
    const db = memoryDb();
    const s = settings({ goals: [{ id: "g1", name: "Signup", type: "event", match: "signup", value: null, created_at: 1 }] });
    engine.configure(db, s);
    const hit = (bot: string, operator: string, category: any, path: string, status = 200, ts = NOW - HOUR) => ({
      bot,
      operator,
      category,
      path,
      status,
      ts,
    });
    recordCrawls(
      db,
      [
        hit("GPTBot", "OpenAI", "ai_training", "/docs"),
        hit("GPTBot", "OpenAI", "ai_training", "/docs"),
        hit("GPTBot", "OpenAI", "ai_training", "/pricing"),
        hit("OAI-SearchBot", "OpenAI", "ai_search", "/pricing"),
        hit("PerplexityBot", "Perplexity", "ai_search", "/robots.txt"),
        hit("ClaudeBot", "Anthropic", "ai_training", "/llms.txt", 404),
        hit("Googlebot", "Google", "search", "/blog/a"),
        hit("GPTBot", "OpenAI", "ai_training", "/docs", 200, NOW - 10 * DAY),
      ],
      s,
      1e9,
      NOW,
    );
    const ai = (source: string, host: string) => ({ channel: "AI Assistants", source, referrer: `https://${host}/`, referrer_host: host });
    const visit = (v: string, page: string, attr: Record<string, unknown>, signup = false) => {
      engine.ingest(db, [ev({ visitor_hash: v, pathname: page, url: `https://example.com${page}`, ...attr })], NOW);
      if (signup) engine.ingest(db, [ev({ visitor_hash: v, name: "signup", pathname: page, ts: NOW - 30_000 })], NOW);
    };
    visit("c1", "/pricing", ai("ChatGPT", "chatgpt.com"), true);
    visit("p1", "/guide", ai("Perplexity", "perplexity.ai"));
    visit("g1", "/blog/a", ai("Gemini", "gemini.google.com"));
    visit("g2", "/blog/b", ai("Gemini", "gemini.google.com"));
    visit("d1", "/", {});
    visit("d2", "/", {});
    visit("d3", "/", {});
    visit("o1", "/blog/a", { channel: "Organic Search", source: "Google", referrer_host: "www.google.com" }, true);

    const r = aiSearch(db, s, { period: "7d", compare: { mode: "previous" } }, NOW) as any;
    expect(r.summary).toMatchObject({
      ai_crawler_hits: 6,
      ai_visitors: 4,
      ai_conversions: 1,
      ai_conversion_rate: 25,
      share_of_visitors: 50,
      ai_bots: 4,
    });
    expect(r.comparison.summary).toMatchObject({ ai_crawler_hits: 1, ai_visitors: 0 });
    expect(r.comparison.change_percent).toMatchObject({ ai_crawler_hits: 500, ai_visitors: null });
    expect(r.crawlers.totals).toMatchObject({ hits: 6, errors: 1, by_category: { ai_training: 4, ai_search: 2 } });
    expect(r.crawlers.bots[0]).toMatchObject({
      bot: "GPTBot",
      operator: "OpenAI",
      hits: 3,
      pages: 2,
      previous_hits: 1,
      change_percent: 200,
    });
    expect(r.crawlers.bots.find((b: any) => b.bot === "Googlebot")).toBeUndefined(); // search, not AI
    expect(r.crawlers.top_pages.map((p: any) => p.page)).toEqual(["/docs", "/pricing"]);
    expect(r.crawlers.discovery_files.find((f: any) => f.path === "/llms.txt")).toEqual({ path: "/llms.txt", hits: 1, ok: 0, errors: 1 });
    expect(r.referrals.sources.map((x: any) => [x.source, x.visitors, x.crawler_operator])).toEqual([
      ["Gemini", 2, "Google"],
      ["ChatGPT", 1, "OpenAI"],
      ["Perplexity", 1, "Perplexity"],
    ]);
    expect(r.referrals.sources.find((x: any) => x.source === "ChatGPT")).toMatchObject({ conversions: 1, conversion_rate: 100 });
    expect(r.referrals.landing_pages.map((x: any) => x.page).sort()).toEqual(["/blog/a", "/blog/b", "/guide", "/pricing"]);
    expect(r.vs_other_channels.ai_assistants).toMatchObject({ visitors: 4, conversion_rate: 25 });
    expect(r.vs_other_channels.all_other_channels).toMatchObject({ visitors: 4, conversion_rate: 25 });
    expect(r.vs_other_channels.lift.conversion_rate).toBe(1);
    expect(r.vs_other_channels.enough_data).toBe(false);
    expect(r.vs_other_channels.channels.map((c: any) => c.channel)).toContain("AI Assistants");
    expect(r.gaps.crawled_not_referred).toEqual([expect.objectContaining({ page: "/docs", ai_crawler_hits: 2, operators: ["OpenAI"] })]);
    const missing = Object.fromEntries(r.gaps.referred_not_crawled.map((g: any) => [g.source, g.pages.map((x: any) => x.page)]));
    expect(missing).toEqual({ Perplexity: ["/guide"], Gemini: ["/blog/b"] }); // ChatGPT's /pricing was fetched by OpenAI's bots
    expect(r.series.at(-1)).toMatchObject({ ai_crawler_hits: 6, ai_visitors: 4 });
    const steps = r.next_steps.join("\n");
    expect(steps).toContain("PerplexityBot read robots.txt");
    expect(steps).toContain("/llms.txt 1 time");
    expect(steps).toContain("1 page read by AI crawlers sent no visitors");
    expect(steps).not.toContain("POST /v1/sites/site_test0000000000/crawls");
    expect(r.notes.join(" ")).toContain("Only 4 visitors from AI assistants");
  });

  it("without crawler data or AI visitors, the report says what to set up", () => {
    const db = memoryDb();
    engine.configure(db, S);
    engine.ingest(db, [ev({ visitor_hash: "d1" })], NOW);
    const r = aiSearch(db, S, { period: "30d" }, NOW) as any;
    expect(r.summary).toMatchObject({ ai_crawler_hits: 0, ai_visitors: 0 });
    expect(r.comparison).toBeUndefined();
    expect(r.gaps).toMatchObject({ crawled_not_referred: null, referred_not_crawled: null });
    expect(r.referrals).toEqual({ sources: [], landing_pages: [] });
    expect(r.next_steps[0]).toContain(`POST /v1/sites/${S.id}/crawls`);
    expect(r.next_steps.join(" ")).toContain("No visits from AI assistants");
    expect(
      aiSearchNextSteps({
        siteId: "s",
        reportsCrawls: true,
        aiHits: 100,
        citationBotsSeen: [],
        robotsOnly: [],
        errorShare: 0.2,
        llmsTxt: { ok: 1, error: 0 },
        aiVisitors: 10,
        hasGoals: false,
        crawledNotReferred: 0,
        referredNotCrawled: 1,
      }).join("\n"),
    ).toMatch(/No AI search or answer bot[\s\S]*20% of AI crawler page requests[\s\S]*Create goals[\s\S]*search index/);
  });
});

describe("robots.txt: blocked, or just not crawling yet", () => {
  // Shaped like agentfirststack.com's own robots.txt: everyone welcome, private paths closed.
  const ours = [
    "User-agent: *",
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
    "Allow: /",
    "Disallow: /v1/",
    "Disallow: /dashboard",
    "",
    "# AI search and assistant crawlers",
    "User-agent: OAI-SearchBot",
    "User-agent: ChatGPT-User",
    "Allow: /",
    "Disallow: /v1/",
  ].join("\n");
  it("reads groups, the longest rule and wildcards the way RFC 9309 does", () => {
    expect(robotsAllows(ours, "OAI-SearchBot")).toBe(true);
    expect(robotsAllows(ours, "oai-searchbot", "/v1/sites")).toBe(false);
    expect(robotsAllows(ours, "Bytespider")).toBe(true); // no group of its own: "*"
    expect(robotsAllows(ours, "Bytespider", "/dashboard/x")).toBe(false);
    expect(robotsAllows("", "GPTBot")).toBe(true); // no robots.txt: everything allowed
    const strict = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok$";
    expect(robotsAllows(strict, "GPTBot")).toBe(false);
    expect(robotsAllows(strict, "ClaudeBot")).toBe(true);
    expect(robotsAllows(strict, "ClaudeBot", "/private/x")).toBe(false);
    expect(robotsAllows(strict, "ClaudeBot", "/private/ok")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "x", "/a.pdf")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "x", "/a.pdf?x=1")).toBe(true);
  });
  const signals = (robotsTxt?: string | null) => ({
    siteId: "s",
    reportsCrawls: true,
    aiHits: 30,
    citationBotsSeen: ["PerplexityBot"],
    robotsOnly: ["OAI-SearchBot"],
    robotsTxt,
    errorShare: 0,
    llmsTxt: { ok: 1, error: 0 },
    aiVisitors: 5,
    hasGoals: true,
    crawledNotReferred: 0,
    referredNotCrawled: 0,
  });
  it("says robots.txt blocks a bot only when it does, and nothing when the bot just hasn't crawled yet", () => {
    expect(aiSearchNextSteps(signals(ours)).join("\n")).not.toMatch(/OAI-SearchBot/);
    const blocked = aiSearchNextSteps(signals("User-agent: OAI-SearchBot\nDisallow: /")).join("\n");
    expect(blocked).toContain("Your robots.txt disallows OAI-SearchBot");
    expect(aiSearchNextSteps(signals(null)).join("\n")).toContain("couldn't be read to check why");
    expect(aiSearchNextSteps(signals(null)).join("\n")).not.toContain("disallows");
  });
});
