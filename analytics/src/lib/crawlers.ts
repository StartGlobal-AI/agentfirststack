/**
 * Known crawlers by user agent: AI training crawlers, AI search and assistant fetchers, search
 * engines, SEO tools and link previews. A site's server reports the bot requests it sees (POST
 * /v1/sites/:id/crawls); they are counted apart from human traffic, never as visitors or events.
 * User agents are self-declared: a spoofed one is counted as the bot it claims to be.
 *
 * Maintained here. Sources: each operator's crawler documentation (OpenAI, Anthropic, Perplexity,
 * Google, Microsoft, Apple, Meta, Amazon, ByteDance, Common Crawl, Mistral, DuckDuckGo, Cohere,
 * You.com, Allen AI) and the user agents seen in practice. Order matters: the first match wins, so
 * specific names come before generic ones.
 */

export const CRAWLER_LIST_VERSION = "2026-11-04";

export const CRAWLER_CATEGORIES = ["ai_training", "ai_search", "ai_assistant", "search", "seo", "preview", "other"] as const;
export type CrawlerCategory = (typeof CRAWLER_CATEGORIES)[number];

export interface Crawler {
  name: string;
  operator: string;
  category: CrawlerCategory;
  /** case-insensitive substring of the user agent */
  match: string;
}

export const CRAWLERS: readonly Crawler[] = [
  // AI: OpenAI
  { name: "GPTBot", operator: "OpenAI", category: "ai_training", match: "gptbot" },
  { name: "OAI-SearchBot", operator: "OpenAI", category: "ai_search", match: "oai-searchbot" },
  { name: "ChatGPT-User", operator: "OpenAI", category: "ai_assistant", match: "chatgpt-user" },
  // Anthropic
  { name: "ClaudeBot", operator: "Anthropic", category: "ai_training", match: "claudebot" },
  { name: "Claude-SearchBot", operator: "Anthropic", category: "ai_search", match: "claude-searchbot" },
  { name: "Claude-User", operator: "Anthropic", category: "ai_assistant", match: "claude-user" },
  { name: "anthropic-ai", operator: "Anthropic", category: "ai_training", match: "anthropic-ai" },
  // Perplexity
  { name: "PerplexityBot", operator: "Perplexity", category: "ai_search", match: "perplexitybot" },
  { name: "Perplexity-User", operator: "Perplexity", category: "ai_assistant", match: "perplexity-user" },
  // Google (Google-Extended is a robots.txt token, not a user agent)
  { name: "Google-CloudVertexBot", operator: "Google", category: "ai_assistant", match: "google-cloudvertexbot" },
  { name: "GoogleOther", operator: "Google", category: "ai_training", match: "googleother" },
  { name: "Googlebot", operator: "Google", category: "search", match: "googlebot" },
  { name: "Google-InspectionTool", operator: "Google", category: "search", match: "google-inspectiontool" },
  // Meta
  { name: "Meta-ExternalAgent", operator: "Meta", category: "ai_training", match: "meta-externalagent" },
  { name: "Meta-ExternalFetcher", operator: "Meta", category: "ai_assistant", match: "meta-externalfetcher" },
  { name: "FacebookBot", operator: "Meta", category: "ai_training", match: "facebookbot" },
  { name: "facebookexternalhit", operator: "Meta", category: "preview", match: "facebookexternalhit" },
  // Others in AI
  { name: "Applebot-Extended", operator: "Apple", category: "ai_training", match: "applebot-extended" },
  { name: "Applebot", operator: "Apple", category: "search", match: "applebot" },
  { name: "Amazonbot", operator: "Amazon", category: "ai_search", match: "amazonbot" },
  { name: "Bytespider", operator: "ByteDance", category: "ai_training", match: "bytespider" },
  { name: "CCBot", operator: "Common Crawl", category: "ai_training", match: "ccbot" },
  { name: "MistralAI-User", operator: "Mistral", category: "ai_assistant", match: "mistralai-user" },
  { name: "DuckAssistBot", operator: "DuckDuckGo", category: "ai_assistant", match: "duckassistbot" },
  { name: "cohere-ai", operator: "Cohere", category: "ai_assistant", match: "cohere-ai" },
  { name: "cohere-training-data-crawler", operator: "Cohere", category: "ai_training", match: "cohere-training-data-crawler" },
  { name: "YouBot", operator: "You.com", category: "ai_search", match: "youbot" },
  { name: "AI2Bot", operator: "Allen Institute for AI", category: "ai_training", match: "ai2bot" },
  { name: "Diffbot", operator: "Diffbot", category: "ai_training", match: "diffbot" },
  { name: "PetalBot", operator: "Huawei", category: "search", match: "petalbot" },
  { name: "PanguBot", operator: "Huawei", category: "ai_training", match: "pangubot" },
  { name: "Timpibot", operator: "Timpi", category: "ai_training", match: "timpibot" },
  { name: "ImagesiftBot", operator: "ImageSift", category: "ai_training", match: "imagesiftbot" },
  { name: "omgili", operator: "Webz.io", category: "ai_training", match: "omgili" },
  { name: "Kangaroo Bot", operator: "Kangaroo LLM", category: "ai_training", match: "kangaroo bot" },
  // Search engines
  { name: "bingbot", operator: "Microsoft", category: "search", match: "bingbot" },
  { name: "DuckDuckBot", operator: "DuckDuckGo", category: "search", match: "duckduckbot" },
  { name: "YandexBot", operator: "Yandex", category: "search", match: "yandexbot" },
  { name: "Baiduspider", operator: "Baidu", category: "search", match: "baiduspider" },
  { name: "SeznamBot", operator: "Seznam", category: "search", match: "seznambot" },
  { name: "Qwantbot", operator: "Qwant", category: "search", match: "qwantbot" },
  // SEO tools
  { name: "AhrefsBot", operator: "Ahrefs", category: "seo", match: "ahrefsbot" },
  { name: "SemrushBot", operator: "Semrush", category: "seo", match: "semrushbot" },
  { name: "MJ12bot", operator: "Majestic", category: "seo", match: "mj12bot" },
  { name: "DotBot", operator: "Moz", category: "seo", match: "dotbot" },
  { name: "Screaming Frog", operator: "Screaming Frog", category: "seo", match: "screaming frog" },
  // Link previews
  { name: "Twitterbot", operator: "X", category: "preview", match: "twitterbot" },
  { name: "LinkedInBot", operator: "LinkedIn", category: "preview", match: "linkedinbot" },
  { name: "Slackbot", operator: "Slack", category: "preview", match: "slackbot" },
  { name: "Discordbot", operator: "Discord", category: "preview", match: "discordbot" },
  { name: "TelegramBot", operator: "Telegram", category: "preview", match: "telegrambot" },
  { name: "WhatsApp", operator: "Meta", category: "preview", match: "whatsapp/" },
];

/** Generic bot words: a user agent with one of these but no known name counts as "Other bot". */
const GENERIC = /bot\b|bot\/|crawl|spider|scraper|fetcher/i;

export interface Classified {
  name: string;
  operator: string | null;
  category: CrawlerCategory;
}

export function classifyCrawler(userAgent: string): Classified | null {
  const ua = userAgent.toLowerCase();
  for (const c of CRAWLERS) if (ua.includes(c.match)) return { name: c.name, operator: c.operator, category: c.category };
  return GENERIC.test(userAgent) ? { name: "Other bot", operator: null, category: "other" } : null;
}

/**
 * One regex a middleware can test before sending anything (escapes nothing: names are plain
 * words), so human requests never leave the site's server.
 */
export const CRAWLER_PREFILTER = new RegExp(
  `${[...new Set(CRAWLERS.map((c) => c.match.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")))].join("|")}|bot\\b|bot/|crawl|spider`,
  "i",
);
