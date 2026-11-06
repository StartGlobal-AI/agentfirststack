import { describe, expect, it } from "vitest";
import { demoLink } from "../src/live-demo";
import { call, testEnv } from "./helpers";

const TOKEN = "shr_testtoken0123456789";
const URL_ = `https://uc.test/a/${TOKEN}`;

/** Share data as analytics answers it, with visitor-written text a spammer could send. */
const share = (period: string) => ({
  site: { domain: "afs.test", timezone: "UTC" },
  period: { name: period },
  metrics: { visitors: 128, visits: 136, pageviews: 188, visit_duration: 249, conversions: 69 },
  interval: period === "24h" ? "hour" : "day",
  timeseries:
    period === "24h"
      ? [
          { date: "2026-11-06 07:00", visitors: 3, pageviews: 6 },
          { date: "2026-11-06 08:00", visitors: 1, pageviews: 1 },
          { date: "<img src=x onerror=alert(1)>", visitors: 9, pageviews: 9 },
        ]
      : [
          { date: "2026-11-04", visitors: 95, pageviews: 120 },
          { date: "2026-11-05", visitors: 33, pageviews: 68 },
        ],
  top_pages: [
    { value: "/", visitors: 93 },
    { value: "/buy-cheap-pills-at-spam.example", visitors: 50 },
    { value: "/guides", visitors: 11 },
  ],
  top_sources: [
    { value: "(none)", visitors: 111 },
    { value: "spam.example", visitors: 40 },
    { value: "Hacker News", visitors: 13 },
    { value: "<script>alert(1)</script>", visitors: 2 },
  ],
  top_countries: [
    { value: "US", visitors: 71 },
    { value: "<b>", visitors: 5 },
    { value: "IN", visitors: 18 },
  ],
  top_devices: [
    { value: "desktop", visitors: 108 },
    { value: "toaster", visitors: 3 },
    { value: "mobile", visitors: 20 },
  ],
  goals: [{ value: "Copied setup prompt", visitors: 9, conversions: 12 }],
});

const seen: string[] = [];
const analytics = {
  fetch: async (input: RequestInfo) => {
    const u = new URL(new Request(input).url);
    seen.push(`${u.host}${u.pathname}?${u.searchParams}`);
    return Response.json(share(u.searchParams.get("period") ?? "30d"));
  },
} as unknown as Fetcher;
const assets = {
  fetch: async () => new Response("<urlset><url><loc>https://afs.test/</loc></url><url><loc>https://afs.test/guides</loc></url></urlset>"),
} as unknown as Fetcher;

describe("the landing page's live dashboard (/live)", () => {
  it("is off without DEMO_DASHBOARD_URL, and refuses anything but a share link", async () => {
    const off = await call("GET", "/live/analytics.json", { env: testEnv({ ANALYTICS: analytics }) });
    expect(off.status).toBe(404);
    expect(off.json.error.code).toBe("not_configured");
    expect(demoLink("https://uc.test/a/not-a-token")).toBeNull();
    expect(demoLink("http://uc.test/a/shr_testtoken0123456789")).toBeNull();
    expect(demoLink(URL_)).toEqual({ token: TOKEN, url: URL_ });
  });

  it("reads the share link's data and passes only what no visitor can write", async () => {
    const env = testEnv({ ANALYTICS: analytics, ASSETS: assets, DEMO_DASHBOARD_URL: URL_ });
    const r = await call("GET", "/live/analytics.json", { env });
    expect(r.status).toBe(200);
    expect(seen).toEqual(
      expect.arrayContaining([`analytics.internal/share/${TOKEN}/data?period=all`, `analytics.internal/share/${TOKEN}/data?period=24h`]),
    );
    expect(r.json).toMatchObject({
      domain: "afs.test",
      since: "2026-11-04",
      interval: "hour",
      metrics: { visitors: 128, pageviews: 188, visit_duration: 249, conversions: 69 },
      // The hourly chart, without the point whose "date" is markup.
      series: [
        { date: "2026-11-06 07:00", visitors: 3, pageviews: 6 },
        { date: "2026-11-06 08:00", visitors: 1, pageviews: 1 },
      ],
      // Only pages in the sitemap.
      pages: [
        { path: "/", visitors: 93 },
        { path: "/guides", visitors: 11 },
      ],
      // Known sources by name; any other referrer folds into "Other sites".
      sources: [
        { name: "Direct", visitors: 111 },
        { name: "Other sites", visitors: 42 },
        { name: "Hacker News", visitors: 13 },
      ],
      countries: [
        { code: "US", visitors: 71 },
        { code: "IN", visitors: 18 },
      ],
      devices: [
        { name: "desktop", visitors: 108 },
        { name: "mobile", visitors: 20 },
      ],
      goals: [{ name: "Copied setup prompt", visitors: 9, conversions: 12 }],
    });
    expect(r.text).not.toMatch(/spam|script|onerror|toaster|<b>/);
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("sends /live to the full public dashboard", async () => {
    const r = await call("GET", "/live", { env: testEnv({ DEMO_DASHBOARD_URL: URL_ }) });
    expect(r.status).toBe(302);
    expect(r.location).toBe(URL_);
  });

  it("serves the last minute's numbers from cache, and 503 when there are none and analytics can't be read", async () => {
    const down = { fetch: async () => new Response("no", { status: 500 }) } as unknown as Fetcher;
    const cached = await call("GET", "/live/analytics.json", { env: testEnv({ ANALYTICS: down, DEMO_DASHBOARD_URL: URL_ }) });
    expect(cached.status).toBe(200);
    expect(cached.json.metrics.visitors).toBe(128);
    const other = "https://uc.test/a/shr_othertoken0123456789";
    const r = await call("GET", "/live/analytics.json", { env: testEnv({ ANALYTICS: down, DEMO_DASHBOARD_URL: other }) });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("unavailable");
  });
});
