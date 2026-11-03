import { describe, expect, it } from "vitest";
import { classifyChannel, lookupHost } from "../../src/lib/channel";
import { botReason, parseUserAgent } from "../../src/lib/ua";
import { parsePage, parseReferrer, normalizeDomain, hostAllowed } from "../../src/lib/url";
import { dailySalt, userVisitorId, visitorHash } from "../../src/lib/visitor";
import { geoFromRequest, requestIp } from "../../src/lib/geo";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

describe("channel classification", () => {
  const ch = (i: Parameters<typeof classifyChannel>[0]) => classifyChannel(i);
  it("no referrer, no tags -> Direct", () => expect(ch({})).toEqual({ channel: "Direct", source: null }));
  it("same-site referrer counts as Direct", () =>
    expect(ch({ referrerHost: "www.example.com", pageHost: "example.com" }).channel).toBe("Direct"));
  it("search engines (any TLD) -> Organic Search", () => {
    expect(ch({ referrerHost: "www.google.com" })).toEqual({ channel: "Organic Search", source: "Google" });
    expect(ch({ referrerHost: "www.google.co.uk" }).channel).toBe("Organic Search");
    expect(ch({ referrerHost: "duckduckgo.com" }).source).toBe("DuckDuckGo");
    expect(ch({ referrerHost: "search.brave.com" }).channel).toBe("Organic Search");
    expect(ch({ referrerHost: "yandex.ru" }).channel).toBe("Organic Search");
  });
  it("non-search Google properties are referrals", () => expect(ch({ referrerHost: "docs.google.com" }).channel).toBe("Referral"));
  it("AI assistants by referrer and by utm_source", () => {
    expect(ch({ referrerHost: "chatgpt.com" })).toEqual({ channel: "AI Assistants", source: "ChatGPT" });
    expect(ch({ referrerHost: "www.perplexity.ai" }).source).toBe("Perplexity");
    expect(ch({ referrerHost: "claude.ai" }).source).toBe("Claude");
    expect(ch({ referrerHost: "gemini.google.com" })).toEqual({ channel: "AI Assistants", source: "Gemini" });
    expect(ch({ referrerHost: "copilot.microsoft.com" }).channel).toBe("AI Assistants");
    expect(ch({ utmSource: "chatgpt.com" })).toEqual({ channel: "AI Assistants", source: "ChatGPT" });
  });
  it("social", () => {
    expect(ch({ referrerHost: "l.facebook.com" })).toEqual({ channel: "Organic Social", source: "Facebook" });
    expect(ch({ referrerHost: "t.co" }).source).toBe("X");
    expect(ch({ referrerHost: "news.ycombinator.com" }).source).toBe("Hacker News");
    expect(ch({ utmSource: "newsletter-x", utmMedium: "social" }).channel).toBe("Organic Social");
  });
  it("paid search via click ids and cpc", () => {
    expect(ch({ clickIdType: "gclid" })).toEqual({ channel: "Paid Search", source: "Google" });
    expect(ch({ clickIdType: "msclkid" }).source).toBe("Bing");
    expect(ch({ referrerHost: "www.google.com", clickIdType: "gclid" }).channel).toBe("Paid Search");
    expect(ch({ utmSource: "google", utmMedium: "cpc" })).toEqual({ channel: "Paid Search", source: "Google" });
  });
  it("paid social", () => {
    expect(ch({ clickIdType: "ttclid" }).channel).toBe("Paid Social");
    expect(ch({ utmSource: "facebook", utmMedium: "paid_social" }).channel).toBe("Paid Social");
    expect(ch({ clickIdType: "fbclid", utmMedium: "cpc" }).channel).toBe("Paid Social");
  });
  it("fbclid alone is organic social", () =>
    expect(ch({ clickIdType: "fbclid" })).toEqual({ channel: "Organic Social", source: "Facebook" }));
  it("email, display, affiliates, paid other, referral", () => {
    expect(ch({ utmSource: "weekly", utmMedium: "email" }).channel).toBe("Email");
    expect(ch({ referrerHost: "mail.google.com" }).channel).toBe("Email");
    expect(ch({ utmSource: "dv360", utmMedium: "display" }).channel).toBe("Display");
    expect(ch({ utmSource: "partner", utmMedium: "affiliate" }).channel).toBe("Affiliates");
    expect(ch({ utmSource: "someone", utmMedium: "paid" }).channel).toBe("Paid Other");
    expect(ch({ referrerHost: "blog.example.org" })).toEqual({ channel: "Referral", source: "blog.example.org" });
    expect(ch({ utmSource: "producthunt" })).toEqual({ channel: "Referral", source: "producthunt" });
  });
  it("lookupHost handles subdomains", () => expect(lookupHost("old.reddit.com")?.[0]).toBe("Reddit"));
});

describe("page + referrer parsing", () => {
  it("keeps utm + first click id, drops the query", () => {
    const p = parsePage("https://Example.com/a/b?utm_source=x&utm_medium=y&utm_campaign=z&gclid=G1&fbclid=F&email=me@x.com#h");
    expect(p).toMatchObject({
      hostname: "example.com",
      pathname: "/a/b",
      url: "https://example.com/a/b",
      utm_source: "x",
      utm_medium: "y",
      utm_campaign: "z",
      click_id_type: "gclid",
      click_id: "G1",
    });
    expect(JSON.stringify(p)).not.toContain("me@x.com");
  });
  it("?ref= is a utm_source alias; bare paths work", () => {
    expect(parsePage("/pricing?ref=hn")).toMatchObject({ hostname: null, pathname: "/pricing", utm_source: "hn" });
  });
  it("referrer strips query and www", () => {
    expect(parseReferrer("https://www.google.com/search?q=secret")).toEqual({
      referrer: "google.com/search",
      referrer_host: "www.google.com",
    });
    expect(parseReferrer("not a url")).toEqual({ referrer: null, referrer_host: null });
  });
  it("normalizeDomain", () => {
    expect(normalizeDomain("https://WWW.Example.com:443/x?y")).toBe("example.com");
    expect(normalizeDomain("shop.example.co.uk")).toBe("shop.example.co.uk");
    expect(() => normalizeDomain("not a domain")).toThrow();
  });
  it("hostAllowed", () => {
    expect(hostAllowed("x.com", null)).toBe(true);
    expect(hostAllowed("a.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["example.com"])).toBe(false);
  });
});

describe("user agent + bots", () => {
  it("parses desktop, mobile, tablet", () => {
    expect(parseUserAgent(CHROME)).toMatchObject({ browser: "Chrome", browser_version: "130", os: "Mac OS", device: "desktop" });
    expect(parseUserAgent(IPHONE)).toMatchObject({ browser: "Mobile Safari", os: "iOS", device: "mobile" });
    expect(parseUserAgent(IPAD).device).toBe("tablet");
    expect(parseUserAgent(ANDROID)).toMatchObject({ os: "Android", device: "mobile" });
    expect(parseUserAgent(FIREFOX_WIN)).toMatchObject({ browser: "Firefox", os: "Windows", device: "desktop" });
    expect(parseUserAgent(null).browser).toBeNull();
  });
  it("lets real browsers through", () => {
    for (const ua of [
      CHROME,
      IPHONE,
      IPAD,
      ANDROID,
      FIREFOX_WIN,
      "Mozilla/5.0 (Linux; Android 9; CUBOT_X19) AppleWebKit/537.36 Chrome/90 Mobile Safari/537.36",
    ]) {
      expect(botReason({ ua })).toBeNull();
    }
  });
  it("flags crawlers, tools, headless and AI agents", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "curl/8.4.0",
      "python-requests/2.31",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      "facebookexternalhit/1.1",
      "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
    ]) {
      expect(botReason({ ua }), ua).not.toBeNull();
    }
    expect(botReason({ ua: "" })).toBe("empty_user_agent");
    expect(botReason({ ua: "SomeApp/1.0 (iOS)" })).toBe("non_browser_user_agent");
    expect(botReason({ ua: CHROME, webdriver: true })).toBe("webdriver");
    expect(botReason({ ua: CHROME, verifiedBot: true })).toBe("verified_bot");
    expect(botReason({ ua: CHROME, verifiedBotCategory: "Search Engine Crawler" })).toBe("verified_bot");
  });
});

describe("visitor hash", () => {
  const T = Date.UTC(2026, 10, 3, 12);
  it("is deterministic and 16 hex chars", async () => {
    const a = await visitorHash("secret", "site_a", "1.2.3.4", CHROME, T);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await visitorHash("secret", "site_a", "1.2.3.4", CHROME, T + 3_600_000)).toBe(a); // same UTC day
  });
  it("changes with the day, site, ip, ua and secret", async () => {
    const a = await visitorHash("secret", "site_a", "1.2.3.4", CHROME, T);
    const others = await Promise.all([
      visitorHash("secret", "site_a", "1.2.3.4", CHROME, T + 86_400_000),
      visitorHash("secret", "site_b", "1.2.3.4", CHROME, T),
      visitorHash("secret", "site_a", "1.2.3.5", CHROME, T),
      visitorHash("secret", "site_a", "1.2.3.4", FIREFOX_WIN, T),
      visitorHash("other", "site_a", "1.2.3.4", CHROME, T),
    ]);
    for (const o of others) expect(o).not.toBe(a);
  });
  it("daily salt is HMAC(secret, YYYY-MM-DD)", async () => {
    expect(await dailySalt("s", "2026-11-03")).toMatch(/^[0-9a-f]{64}$/);
    expect(await dailySalt("s", "2026-11-03")).not.toBe(await dailySalt("s", "2026-11-04"));
  });
  it("user ids map to a stable visitor", async () => {
    expect(await userVisitorId("site_a", "u1")).toBe(await userVisitorId("site_a", "u1"));
    expect(await userVisitorId("site_a", "u1")).not.toBe(await userVisitorId("site_a", "u2"));
  });
});

describe("geo + ip", () => {
  const req = (headers: Record<string, string>, cf?: Record<string, unknown>) => {
    const r = new Request("https://x/e", { headers });
    if (cf) Object.defineProperty(r, "cf", { value: cf });
    return r;
  };
  const cf = {
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    continent: "NA",
    latitude: "37.7749",
    longitude: "-122.4194",
    asn: 13335,
    asOrganization: "Cloudflare",
  };
  const direct = { devMode: false, trustForwarded: false };
  const viaProxy = { devMode: false, trustForwarded: true };
  it("reads request.cf with coarse coordinates", () => {
    expect(geoFromRequest(req({}, cf), direct)).toMatchObject({
      country: "US",
      region_code: "CA",
      city: "San Francisco",
      latitude: 37.8,
      longitude: -122.4,
      asn: 13335,
    });
  });
  it("proxy-forwarded geo wins over request.cf only for a trusted proxy", () => {
    const h = { "x-afs-geo-country": "de", "x-afs-geo-city": "M%C3%BCnchen" };
    expect(geoFromRequest(req(h, cf), viaProxy)).toMatchObject({ country: "DE", city: "München", region: null });
    // anyone can send these headers: without the proxy key they are ignored
    expect(geoFromRequest(req(h, cf), direct)).toMatchObject({ country: "US", city: "San Francisco" });
    expect(geoFromRequest(req({ "x-vercel-ip-country": "FR" }, cf), direct).country).toBe("US");
    expect(geoFromRequest(req({ "x-vercel-ip-country": "FR" }, cf), viaProxy).country).toBe("FR");
    // the old header name is gone
    expect(geoFromRequest(req({ "x-sg-geo-country": "JP" }, cf), viaProxy).country).toBe("US");
  });
  it("dev headers only in dev mode", () => {
    const r = req({ "x-dev-geo-country": "JP" }, cf);
    expect(geoFromRequest(r, direct).country).toBe("US");
    expect(geoFromRequest(r, { devMode: true, trustForwarded: false }).country).toBe("JP");
  });
  it("XX (unknown) is null", () => expect(geoFromRequest(req({}, { country: "XX" }), direct).country).toBeNull());
  it("ip: first x-forwarded-for hop only for a trusted proxy, else cf-connecting-ip", () => {
    const h = { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "cf-connecting-ip": "10.0.0.1", "x-real-ip": "192.0.2.1" };
    expect(requestIp(req(h), true)).toBe("203.0.113.7");
    expect(requestIp(req(h), false)).toBe("10.0.0.1");
    expect(requestIp(req({ "cf-connecting-ip": "198.51.100.1" }), true)).toBe("198.51.100.1");
    expect(requestIp(req({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "192.0.2.1" }), false)).toBe("0.0.0.0");
  });
});
