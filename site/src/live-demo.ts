import { Hono } from "hono";
import type { SiteEnv } from "./env";

/**
 * The landing page's live dashboard: this site's own analytics, read from its public share link
 * (DEMO_DASHBOARD_URL, a profile var: `<USER_CONTENT_BASE_URL>/a/shr_...`). Off when it is unset.
 *
 *   GET /live/analytics.json   the numbers the landing page draws, cached a minute per location
 *   GET /live                  302 to the full public dashboard
 *
 * A share link's data is aggregates only, but its page paths and referrers are text visitors send,
 * and this lands on our home page. So only what no visitor can write gets through: totals, the
 * series, two-letter country codes, device types, our own goal names, sources whose name is on
 * the list of sources analytics recognises (any other referrer counts as "Other sites"), and pages
 * that are in our sitemap (any other path counts in no list).
 */
export const liveDemo = new Hono<SiteEnv>();

/** Totals and lists since the site was added; the chart is the last 24 hours, by hour. */
const PERIOD = "all";
const CHART_PERIOD = "24h";
const CACHE_SECONDS = 60;

/** Source names analytics gives known referrers (analytics/src/lib/channel.ts), plus Direct. */
const KNOWN_SOURCES = new Set(
  [
    "Direct",
    "Google",
    "Bing",
    "DuckDuckGo",
    "Brave Search",
    "Ecosia",
    "Yahoo",
    "Yandex",
    "Baidu",
    "Naver",
    "Kagi",
    "Startpage",
    "Qwant",
    "Seznam",
    "ChatGPT",
    "Claude",
    "Perplexity",
    "Gemini",
    "Copilot",
    "Grok",
    "Mistral",
    "DeepSeek",
    "Meta AI",
    "Phind",
    "Poe",
    "You.com",
    "Duck.ai",
    "NotebookLM",
    "HuggingChat",
    "Kimi",
    "Qwen",
    "Manus",
    "Hacker News",
    "Reddit",
    "X",
    "LinkedIn",
    "Facebook",
    "Instagram",
    "Threads",
    "Bluesky",
    "Mastodon",
    "YouTube",
    "TikTok",
    "Pinterest",
    "Product Hunt",
    "Medium",
    "Substack",
    "Quora",
    "Discord",
    "Telegram",
    "WhatsApp",
    "Gmail",
    "Outlook",
    "Proton Mail",
    "Newsletter",
  ].map((s) => s.toLowerCase()),
);
const DEVICES = new Set(["desktop", "mobile", "tablet"]);

interface Row {
  value?: unknown;
  visitors?: unknown;
  conversions?: unknown;
}
interface ShareData {
  site?: { domain?: string | null; timezone?: string };
  metrics?: Record<string, unknown>;
  timeseries?: { date?: unknown; visitors?: unknown; pageviews?: unknown }[];
  interval?: unknown;
  top_pages?: Row[];
  top_sources?: Row[];
  top_countries?: Row[];
  top_devices?: Row[];
  goals?: Row[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** The share link's token and its public URL, or null when DEMO_DASHBOARD_URL is unset or not a share link. */
export function demoLink(raw: string | undefined): { token: string; url: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const token = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (u.protocol !== "https:" || !/^shr_[a-z0-9]{8,64}$/.test(token)) return null;
    return { token, url: `${u.origin}${u.pathname}` };
  } catch {
    return null;
  }
}

/** Our sitemap's paths: the only page paths the landing page may show. */
async function sitemapPaths(env: SiteEnv["Bindings"]): Promise<Set<string>> {
  const res = await env.ASSETS.fetch(new Request("https://assets.internal/sitemap.xml"));
  const xml = res.ok ? await res.text() : "";
  const paths = new Set<string>();
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    try {
      paths.add(new URL(m[1]!).pathname);
    } catch {
      /* not a URL */
    }
  }
  return paths;
}

/** The share data, reduced to what can't carry a visitor's text. */
export function safeDemoData(data: ShareData, pages: Set<string>, chart: ShareData = data) {
  const m = data.metrics ?? {};
  let other = 0;
  const sources: { name: string; visitors: number }[] = [];
  for (const r of data.top_sources ?? []) {
    const raw = typeof r.value === "string" ? r.value : "";
    const name = raw === "(none)" ? "Direct" : raw;
    if (KNOWN_SOURCES.has(name.toLowerCase())) sources.push({ name, visitors: num(r.visitors) });
    else other += num(r.visitors);
  }
  if (other) sources.push({ name: "Other sites", visitors: other });
  return {
    domain: typeof data.site?.domain === "string" ? data.site.domain : null,
    period: PERIOD,
    /** The first day the totals count (the site was added then). */
    since:
      (data.timeseries ?? [])
        .map((p) => (typeof p.date === "string" ? p.date.slice(0, 10) : ""))
        .find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) ?? null,
    timezone: typeof data.site?.timezone === "string" && /^[A-Za-z_/+-]{1,40}$/.test(data.site.timezone) ? data.site.timezone : "UTC",
    interval: typeof chart.interval === "string" && /^[a-z]+$/.test(chart.interval) ? chart.interval : "day",
    metrics: {
      visitors: num(m.visitors),
      visits: num(m.visits),
      pageviews: num(m.pageviews),
      visit_duration: num(m.visit_duration),
      conversions: num(m.conversions),
    },
    // "2026-11-06" by day, "2026-11-06 08:00" by hour (the site's timezone).
    series: (chart.timeseries ?? [])
      .filter((p) => typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(p.date))
      .map((p) => ({ date: p.date as string, visitors: num(p.visitors), pageviews: num(p.pageviews) })),
    pages: (data.top_pages ?? [])
      .filter((r) => typeof r.value === "string" && pages.has(r.value))
      .slice(0, 6)
      .map((r) => ({ path: r.value as string, visitors: num(r.visitors) })),
    sources: sources.sort((a, b) => b.visitors - a.visitors).slice(0, 6),
    countries: (data.top_countries ?? [])
      .filter((r) => typeof r.value === "string" && /^[A-Z]{2}$/.test(r.value))
      .slice(0, 6)
      .map((r) => ({ code: r.value as string, visitors: num(r.visitors) })),
    devices: (data.top_devices ?? [])
      .filter((r) => typeof r.value === "string" && DEVICES.has(r.value) && num(r.visitors) > 0)
      .map((r) => ({ name: r.value as string, visitors: num(r.visitors) })),
    goals: (data.goals ?? [])
      .filter((g) => typeof g.value === "string" && g.value.length <= 80)
      .slice(0, 4)
      .map((g) => ({ name: g.value as string, visitors: num(g.visitors), conversions: num(g.conversions) })),
    dashboard_url: "/live",
  };
}

const notConfigured = () =>
  Response.json(
    {
      error: {
        code: "not_configured",
        message: "This deployment has no live dashboard.",
        hint: "Set DEMO_DASHBOARD_URL to a public share link of the site's own analytics (POST /v1/sites/:id/share).",
      },
    },
    { status: 404 },
  );

liveDemo.get("/analytics.json", async (c) => {
  const link = demoLink(c.env.DEMO_DASHBOARD_URL);
  if (!link) return notConfigured();
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(`https://live-demo.internal/${link.token}/${PERIOD}/${CHART_PERIOD}`);
  const hit = await cache?.match(key);
  if (hit) return hit;
  const read = (period: string) => c.env.ANALYTICS.fetch(`https://analytics.internal/share/${link.token}/data?period=${period}`);
  const [res, chart] = await Promise.all([read(PERIOD), read(CHART_PERIOD)]);
  if (!res.ok || !chart.ok) {
    return Response.json(
      { error: { code: "unavailable", message: "The live numbers couldn't be read just now.", hint: "Try again in a minute." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const body = safeDemoData((await res.json()) as ShareData, await sitemapPaths(c.env), (await chart.json()) as ShareData);
  const out = Response.json(body, {
    headers: { "cache-control": `public, max-age=${CACHE_SECONDS}`, "x-robots-tag": "noindex", "x-content-type-options": "nosniff" },
  });
  if (cache) c.executionCtx.waitUntil(cache.put(key, out.clone()));
  return out;
});

liveDemo.get("/", (c) => {
  const link = demoLink(c.env.DEMO_DASHBOARD_URL);
  if (!link) return notConfigured();
  return c.redirect(link.url, 302);
});
