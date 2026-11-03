import UAParser from "ua-parser-js";

export interface DeviceInfo {
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  os_version: string | null;
  /** desktop | mobile | tablet | console | smarttv | wearable | embedded */
  device: string | null;
}

export function parseUserAgent(ua: string | null | undefined): DeviceInfo {
  if (!ua) return { browser: null, browser_version: null, os: null, os_version: null, device: null };
  const r = new UAParser(ua).getResult();
  const type = r.device.type;
  const osName = r.os.name ?? null;
  let device: string | null = type ?? null;
  if (!device) {
    // ua-parser leaves desktop undefined; iPadOS 13+ reports as Mac, nothing we can do server-side.
    device = osName && /android|ios/i.test(osName) ? "mobile" : osName || r.browser.name ? "desktop" : null;
  }
  return {
    browser: r.browser.name ?? null,
    browser_version: r.browser.major ?? r.browser.version ?? null,
    os: osName,
    os_version: r.os.version ?? null,
    device,
  };
}

// Crawlers, uptime monitors, preview fetchers, HTTP libraries and headless/automation browsers.
const BOT_UA =
  /(?<!cu)bot\b|(?<!cu)bot[/;_ -]|crawl|spider|slurp|archiver|scrap|fetch(er)?\b|curl\/|wget\/|python-|python\/|httpx|aiohttp|requests\/|go-http-client|java\/|okhttp|axios\/|node-fetch|undici|got \(|libwww|httpclient|http_request|postman|insomnia|headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|cypress|electron\/.*headless|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake|site24x7|newrelicpinger|datadog|checkly|better ?uptime|facebookexternalhit|facebookcatalog|meta-externalagent|embedly|quora link preview|slack-imgproxy|slackbot|discordbot|telegrambot|whatsapp\/|skypeuripreview|linkedinbot|pinterestbot|redditbot|twitterbot|applebot|bingpreview|google-inspectiontool|googleother|google-extended|adsbot|mediapartners|feedfetcher|feedburner|rss|preview|validator|monitor(ing)?\b|scanner|nessus|nikto|sqlmap|zgrab|masscan|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|ccbot|amazonbot|yandex(bot|images)|baiduspider|duckduckbot|sogou|exabot|seznambot|qwantify|ia_archiver|cloudflare-(healthchecks|diagnostics|alwaysonline|workers)/i;

export interface BotSignals {
  ua: string | null | undefined;
  /** request.cf.botManagement.verifiedBot (Enterprise Bot Management), when present */
  verifiedBot?: boolean;
  /** request.cf.verifiedBotCategory (any plan) */
  verifiedBotCategory?: string | null;
  /** navigator.webdriver reported by the tracker */
  webdriver?: boolean;
}

/** Returns a reason string when the request looks automated, else null. */
export function botReason(s: BotSignals): string | null {
  if (s.verifiedBot) return "verified_bot";
  if (s.verifiedBotCategory) return "verified_bot";
  if (s.webdriver) return "webdriver";
  const ua = s.ua?.trim();
  if (!ua) return "empty_user_agent";
  if (BOT_UA.test(ua)) return "user_agent";
  if (ua.length < 12) return "short_user_agent";
  // Real browsers always identify as Mozilla/5.0 (or Opera/ for very old Opera).
  if (!/^(mozilla|opera)\//i.test(ua)) return "non_browser_user_agent";
  return null;
}
