import UAParser from "ua-parser-js";

export interface DeviceInfo {
  browser: string | null;
  browser_version: string | null;
  os: string | null;
  /** desktop | mobile | tablet (others as ua-parser reports them: console, smarttv, wearable, embedded) */
  device: string | null;
}

/** Browser, OS and device class; the viewport width settles devices the user agent doesn't name. */
export function parseUserAgent(ua: string | null | undefined, viewportWidth?: number | null): DeviceInfo {
  if (!ua) return { browser: null, browser_version: null, os: null, device: deviceFromWidth(viewportWidth) };
  const r = new UAParser(ua).getResult();
  const osName = r.os.name ?? null;
  let device: string | null = r.device.type ?? null;
  if (!device) {
    // ua-parser leaves desktop undefined; iPadOS 13+ reports as Mac (a touch-sized viewport hints otherwise).
    device = osName && /android|ios/i.test(osName) ? "mobile" : osName || r.browser.name ? "desktop" : deviceFromWidth(viewportWidth);
  }
  return { browser: r.browser.name ?? null, browser_version: r.browser.major ?? null, os: osName, device };
}

export function deviceFromWidth(w: number | null | undefined): string | null {
  if (!w) return null;
  return w < 768 ? "mobile" : w < 1024 ? "tablet" : "desktop";
}

// Crawlers, uptime monitors, HTTP libraries and headless/automation browsers. Forced recordings
// (?afsr=1, used to verify an install) skip this check.
const BOT_UA =
  /(?<!cu)bot\b|(?<!cu)bot[/;_ -]|crawl|spider|slurp|scrap|curl\/|wget\/|python-|python\/|httpx|aiohttp|go-http-client|java\/|okhttp|axios\/|node-fetch|undici|headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|facebookexternalhit|preview|monitor(ing)?\b|scanner|gptbot|chatgpt-user|claudebot|claude-user|perplexitybot|ccbot|bytespider|amazonbot/i;

export function botReason(ua: string | null | undefined, webdriver: boolean): string | null {
  if (webdriver) return "webdriver";
  const s = ua?.trim();
  if (!s) return "empty_user_agent";
  if (BOT_UA.test(s)) return "user_agent";
  if (!/^(mozilla|opera)\//i.test(s)) return "non_browser_user_agent";
  return null;
}
