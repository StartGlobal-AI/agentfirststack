/**
 * AI search: which AI crawlers read the site, which AI assistants send visitors, and how the two
 * line up. Pure: the vendor map, what counts as a page, and the advice. The numbers come from
 * do/ai-search.ts (crawler_hits, and events of the AI Assistants channel).
 */

import { CRAWLERS, type CrawlerCategory } from "./crawlers";

export const AI_CHANNEL = "AI Assistants";
export const AI_CATEGORIES: readonly CrawlerCategory[] = ["ai_training", "ai_search", "ai_assistant"];

/**
 * The assistant a visitor came from (lib/channel.ts source names) -> the operator whose crawlers
 * fetch pages for it (lib/crawlers.ts operators). Google and Microsoft answer from their search
 * indexes, so Googlebot and bingbot count for Gemini and Copilot. Assistants with no crawler on
 * our list (DeepSeek, Grok, Poe, ...) are left out of the gap check.
 */
export const ASSISTANT_OPERATOR: Record<string, string> = {
  ChatGPT: "OpenAI",
  Perplexity: "Perplexity",
  Claude: "Anthropic",
  Gemini: "Google",
  NotebookLM: "Google",
  Copilot: "Microsoft",
  "Meta AI": "Meta",
  Mistral: "Mistral",
  "You.com": "You.com",
  "Duck.ai": "DuckDuckGo",
};

/** The crawlers of an operator, by name (for "fetched by none of GPTBot, OAI-SearchBot, ChatGPT-User"). */
export const crawlersOf = (operator: string) => CRAWLERS.filter((c) => c.operator === operator).map((c) => c.name);

/** Files AI crawlers ask for to find their way around a site. */
export const DISCOVERY_FILES = ["/robots.txt", "/llms.txt", "/llms-full.txt", "/sitemap.xml"] as const;

const PAGE_EXT = /\.(html?|php|aspx?|jsp)$/i;

/**
 * A path a visitor could land on with the tracker running: not a file (robots.txt, sitemaps,
 * feeds, images, PDFs, scripts), not the "(other)" bucket.
 */
export function isPagePath(path: string): boolean {
  if (!path.startsWith("/") || path === "(other)") return false;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return !last.includes(".") || PAGE_EXT.test(last);
}

/** The AI search and answer bots a site wants to let in to be cited (training bots are a separate choice). */
export const CITATION_BOTS = ["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User", "Claude-SearchBot", "Claude-User"];

export interface AiSearchSignals {
  siteId: string;
  /** the site has ever reported a crawler hit */
  reportsCrawls: boolean;
  aiHits: number;
  /** AI search / answer bots with page hits in the period */
  citationBotsSeen: string[];
  /** AI search and answer bots that fetched robots.txt and nothing else in the period */
  robotsOnly: string[];
  /**
   * The site's robots.txt, to tell "robots.txt blocks them" from "they haven't crawled yet":
   * a string when it was read, null when it couldn't be, undefined when nobody looked.
   */
  robotsTxt?: string | null;
  /** share (0-1) of AI crawler page requests (not robots.txt, llms.txt, sitemaps) answered 4xx/5xx */
  errorShare: number;
  llmsTxt: { ok: number; error: number };
  aiVisitors: number;
  hasGoals: boolean;
  crawledNotReferred: number;
  referredNotCrawled: number;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Does robots.txt let `agent` fetch `path`? RFC 9309: the groups naming the agent (case-insensitive
 * product token) or else the "*" groups; the longest matching rule wins and Allow wins a tie; "*"
 * and a final "$" in a rule are wildcards; no matching rule means allowed.
 */
export function robotsAllows(robotsTxt: string, agent: string, path = "/"): boolean {
  const want = agent.toLowerCase();
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let inAgents = false;
  for (const raw of robotsTxt.slice(0, 512 * 1024).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !inAgents) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      inAgents = true;
    } else if (key === "allow" || key === "disallow") {
      inAgents = false;
      if (cur && value) cur.rules.push({ allow: key === "allow", path: value });
    } else inAgents = false;
  }
  const named = groups.filter((g) => g.agents.includes(want));
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  const matches = (rule: string) => {
    const anchored = rule.endsWith("$");
    const body = (anchored ? rule.slice(0, -1) : rule).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
  };
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (!matches(r.path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

export function aiSearchNextSteps(s: AiSearchSignals): string[] {
  const base = `/v1/sites/${s.siteId}`;
  const steps: string[] = [];
  if (!s.reportsCrawls)
    steps.push(
      `Report bot requests from your server so this report sees AI crawlers: POST ${base}/crawls (MCP record_crawls) for each request whose user agent matches the prefilter from GET /v1/crawlers (the "AI crawlers" section of llms.txt has middleware for Cloudflare Workers, Next.js and Express).`,
    );
  // A search or answer bot that only read robots.txt: blocked there, or (when robots.txt allows it)
  // simply not crawling yet, which needs nothing from you.
  const robotsTxt = s.robotsTxt;
  const blocked = typeof robotsTxt === "string" ? s.robotsOnly.filter((b) => !robotsAllows(robotsTxt, b)) : [];
  const unchecked = typeof robotsTxt === "string" ? [] : s.robotsOnly;
  if (blocked.length)
    steps.push(
      `Your robots.txt disallows ${blocked.join(", ")}, so ${blocked.length === 1 ? "it reads" : "they read"} robots.txt and stop there. To be cited in AI answers, allow the search and answer bots (${CITATION_BOTS.join(", ")}); blocking training bots (GPTBot, ClaudeBot, CCBot) is a separate choice.`,
    );
  if (unchecked.length)
    steps.push(
      `${unchecked.join(", ")} read robots.txt but fetched no page in this period, and your robots.txt couldn't be read to check why. Make sure it allows the search and answer bots (${CITATION_BOTS.join(", ")}).`,
    );
  if (s.reportsCrawls && !s.citationBotsSeen.length && !s.robotsOnly.length)
    steps.push(
      `No AI search or answer bot (${CITATION_BOTS.join(", ")}) fetched a page in this period: check robots.txt allows them and that your CDN or firewall doesn't block or challenge them (bot protection and "block AI bots" settings often do).`,
    );
  if (s.aiHits >= 20 && s.errorShare >= 0.1)
    steps.push(
      `${Math.round(s.errorShare * 100)}% of AI crawler page requests got a 4xx/5xx answer: GET ${base}/crawlers?by=page&category=ai_search (and ai_assistant) lists the pages; fix or redirect them.`,
    );
  if (s.llmsTxt.error && !s.llmsTxt.ok)
    steps.push(
      `AI crawlers asked for /llms.txt ${plural(s.llmsTxt.error, "time")} and got an error: publish one (markdown: what the site is, then links to your key pages with a one-line summary each; https://llmstxt.org).`,
    );
  if (!s.aiVisitors)
    steps.push(
      `No visits from AI assistants in this period. Assistants cite pages that answer a question directly: a specific title, the answer in the first paragraph, facts and numbers worth quoting, schema.org structured data${
        s.llmsTxt.ok ? "" : ", and an /llms.txt index of your key pages"
      }.`,
    );
  if (s.aiVisitors && !s.hasGoals)
    steps.push(
      `Create goals (POST ${base}/goals, e.g. your sign-up) to see whether visitors from AI assistants convert better or worse than your other channels.`,
    );
  if (s.crawledNotReferred)
    steps.push(
      `${plural(s.crawledNotReferred, "page")} read by AI crawlers sent no visitors in this period (gaps.crawled_not_referred): make the answer easy to quote, and give readers a reason to click through (a tool, a price, a download).`,
    );
  if (s.referredNotCrawled)
    steps.push(
      "Some pages get visitors from an assistant whose vendor's crawlers didn't fetch them lately (gaps.referred_not_crawled): it probably knows them from a search index (Bing for ChatGPT and Copilot, Google for Gemini), so keep them indexable there.",
    );
  return steps.slice(0, 6);
}
