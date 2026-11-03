/**
 * Traffic source + channel classification from referrer, UTM tags and click ids. Pure; runs at
 * ingest for the first event of a session (the session's attribution).
 *
 * Channels: Direct, Organic Search, Paid Search, Organic Social, Paid Social, Email, Referral,
 * Display, Affiliates, AI Assistants, Paid Other.
 */

export const CHANNELS = [
  "Direct",
  "Organic Search",
  "Paid Search",
  "Organic Social",
  "Paid Social",
  "Email",
  "Referral",
  "Display",
  "Affiliates",
  "AI Assistants",
  "Paid Other",
] as const;
export type Channel = (typeof CHANNELS)[number];

type Kind = "search" | "social" | "ai" | "email";

/** host suffix -> [friendly source name, kind]. Matched against the referrer host and its parents. */
const KNOWN: Record<string, [string, Kind]> = {
  // AI assistants (checked before search: gemini.google.com must not read as Google search)
  "chatgpt.com": ["ChatGPT", "ai"],
  "chat.openai.com": ["ChatGPT", "ai"],
  "openai.com": ["ChatGPT", "ai"],
  "perplexity.ai": ["Perplexity", "ai"],
  "claude.ai": ["Claude", "ai"],
  "gemini.google.com": ["Gemini", "ai"],
  "bard.google.com": ["Gemini", "ai"],
  "aistudio.google.com": ["Gemini", "ai"],
  "notebooklm.google.com": ["NotebookLM", "ai"],
  "copilot.microsoft.com": ["Copilot", "ai"],
  "copilot.cloud.microsoft": ["Copilot", "ai"],
  "m365.cloud.microsoft": ["Copilot", "ai"],
  "edgeservices.bing.com": ["Copilot", "ai"],
  "chat.deepseek.com": ["DeepSeek", "ai"],
  "deepseek.com": ["DeepSeek", "ai"],
  "meta.ai": ["Meta AI", "ai"],
  "grok.com": ["Grok", "ai"],
  "x.ai": ["Grok", "ai"],
  "chat.mistral.ai": ["Mistral", "ai"],
  "you.com": ["You.com", "ai"],
  "phind.com": ["Phind", "ai"],
  "poe.com": ["Poe", "ai"],
  "duck.ai": ["Duck.ai", "ai"],
  "huggingface.co": ["HuggingChat", "ai"],
  "kimi.com": ["Kimi", "ai"],
  "kimi.moonshot.cn": ["Kimi", "ai"],
  "chat.qwen.ai": ["Qwen", "ai"],
  "manus.im": ["Manus", "ai"],
  // webmail
  "mail.google.com": ["Gmail", "email"],
  "outlook.live.com": ["Outlook", "email"],
  "outlook.office.com": ["Outlook", "email"],
  "outlook.office365.com": ["Outlook", "email"],
  "mail.yahoo.com": ["Yahoo Mail", "email"],
  "mail.proton.me": ["Proton Mail", "email"],
  "mail.aol.com": ["AOL Mail", "email"],
  // search engines
  google: ["Google", "search"],
  "bing.com": ["Bing", "search"],
  "duckduckgo.com": ["DuckDuckGo", "search"],
  yahoo: ["Yahoo", "search"],
  yandex: ["Yandex", "search"],
  "baidu.com": ["Baidu", "search"],
  "ecosia.org": ["Ecosia", "search"],
  "search.brave.com": ["Brave Search", "search"],
  "startpage.com": ["Startpage", "search"],
  "qwant.com": ["Qwant", "search"],
  "naver.com": ["Naver", "search"],
  "seznam.cz": ["Seznam", "search"],
  "ask.com": ["Ask", "search"],
  "aol.com": ["AOL", "search"],
  "kagi.com": ["Kagi", "search"],
  "yep.com": ["Yep", "search"],
  "sogou.com": ["Sogou", "search"],
  "so.com": ["360 Search", "search"],
  "daum.net": ["Daum", "search"],
  "mojeek.com": ["Mojeek", "search"],
  // social
  "facebook.com": ["Facebook", "social"],
  "fb.com": ["Facebook", "social"],
  "fb.me": ["Facebook", "social"],
  "messenger.com": ["Facebook", "social"],
  "instagram.com": ["Instagram", "social"],
  "threads.net": ["Threads", "social"],
  "threads.com": ["Threads", "social"],
  "t.co": ["X", "social"],
  "twitter.com": ["X", "social"],
  "x.com": ["X", "social"],
  "linkedin.com": ["LinkedIn", "social"],
  "lnkd.in": ["LinkedIn", "social"],
  "reddit.com": ["Reddit", "social"],
  "youtube.com": ["YouTube", "social"],
  "youtu.be": ["YouTube", "social"],
  "tiktok.com": ["TikTok", "social"],
  pinterest: ["Pinterest", "social"],
  "pin.it": ["Pinterest", "social"],
  "snapchat.com": ["Snapchat", "social"],
  "bsky.app": ["Bluesky", "social"],
  "news.ycombinator.com": ["Hacker News", "social"],
  "quora.com": ["Quora", "social"],
  "tumblr.com": ["Tumblr", "social"],
  "vk.com": ["VK", "social"],
  "weibo.com": ["Weibo", "social"],
  "discord.com": ["Discord", "social"],
  "t.me": ["Telegram", "social"],
  "telegram.org": ["Telegram", "social"],
  "whatsapp.com": ["WhatsApp", "social"],
  "wa.me": ["WhatsApp", "social"],
  "mastodon.social": ["Mastodon", "social"],
  "producthunt.com": ["Product Hunt", "social"],
  "medium.com": ["Medium", "social"],
  "substack.com": ["Substack", "social"],
};

/** Lowercase utm_source values (as tagged by AI tools and ad platforms) -> [name, kind]. */
const SOURCE_ALIASES: Record<string, [string, Kind]> = {
  chatgpt: ["ChatGPT", "ai"],
  "chatgpt.com": ["ChatGPT", "ai"],
  openai: ["ChatGPT", "ai"],
  perplexity: ["Perplexity", "ai"],
  "perplexity.ai": ["Perplexity", "ai"],
  claude: ["Claude", "ai"],
  "claude.ai": ["Claude", "ai"],
  gemini: ["Gemini", "ai"],
  copilot: ["Copilot", "ai"],
  google: ["Google", "search"],
  bing: ["Bing", "search"],
  duckduckgo: ["DuckDuckGo", "search"],
  facebook: ["Facebook", "social"],
  fb: ["Facebook", "social"],
  meta: ["Facebook", "social"],
  instagram: ["Instagram", "social"],
  ig: ["Instagram", "social"],
  twitter: ["X", "social"],
  x: ["X", "social"],
  linkedin: ["LinkedIn", "social"],
  reddit: ["Reddit", "social"],
  youtube: ["YouTube", "social"],
  tiktok: ["TikTok", "social"],
  pinterest: ["Pinterest", "social"],
  snapchat: ["Snapchat", "social"],
  threads: ["Threads", "social"],
  bluesky: ["Bluesky", "social"],
  hackernews: ["Hacker News", "social"],
  hn: ["Hacker News", "social"],
  newsletter: ["Newsletter", "email"],
  email: ["Email", "email"],
};

export const CLICK_ID_PARAMS = [
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "fbclid",
  "ttclid",
  "li_fat_id",
  "twclid",
  "rdt_cid",
  "epik",
  "sccid",
] as const;
export type ClickIdType = (typeof CLICK_ID_PARAMS)[number];

const CLICK_ID_CHANNEL: Record<ClickIdType, Channel | null> = {
  gclid: "Paid Search",
  gbraid: "Paid Search",
  wbraid: "Paid Search",
  dclid: "Display",
  msclkid: "Paid Search",
  fbclid: null, // Meta adds fbclid to organic clicks too; only paid with a paid utm_medium
  ttclid: "Paid Social",
  li_fat_id: "Paid Social",
  twclid: "Paid Social",
  rdt_cid: "Paid Social",
  epik: "Paid Social",
  sccid: "Paid Social",
};

export interface Attribution {
  channel: Channel;
  /** Friendly source name ("Google", "ChatGPT", "news.example.com"), or null for Direct. */
  source: string | null;
}

export interface ChannelInput {
  referrerHost?: string | null;
  /** Hostname of the page itself; a same-site referrer counts as no referrer. */
  pageHost?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  clickIdType?: ClickIdType | string | null;
}

/** Look up a host (and each parent domain) in the known-source table. */
export function lookupHost(host: string): [string, Kind] | null {
  const h = host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  const parts = h.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join(".");
    const hit = KNOWN[suffix];
    if (hit) return hit;
  }
  // Brand-wide engines on any TLD: google.co.uk, yahoo.co.jp, yandex.ru, pinterest.de ...
  for (const brand of ["google", "yahoo", "yandex", "pinterest"]) {
    const idx = parts.indexOf(brand);
    if (idx >= 0 && idx >= parts.length - 3) {
      // Exclude non-search Google properties that aren't in the table (docs, sites, etc.)
      if (brand === "google" && idx > 0 && !["www", "m"].includes(parts[0]!)) return null;
      if (brand === "yahoo" && idx > 0 && !["www", "search", "m"].includes(parts[0]!)) return null;
      return KNOWN[brand] ?? null;
    }
  }
  return null;
}

function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return strip(a) === strip(b);
}

const PAID_MEDIUM = /^(.*cp.*|ppc|retargeting|paid.*|ads?)$/;
const DISPLAY_MEDIUM = /^(display|banner|expandable|interstitial|cpm)$/;
const SOCIAL_MEDIUM = /^(social|social[-_ ]?network|social[-_ ]?media|sm|social-post|organic[-_ ]?social)$/;
const EMAIL_MEDIUM = /^(email|e[-_]mail|newsletter|e-?mail[-_ ]?marketing)$/;

export function classifyChannel(input: ChannelInput): Attribution {
  const medium = input.utmMedium?.trim().toLowerCase() || "";
  const utmSource = input.utmSource?.trim() || "";
  const campaign = input.utmCampaign?.trim().toLowerCase() || "";
  let refHost = input.referrerHost?.trim().toLowerCase() || "";
  if (refHost && input.pageHost && sameSite(refHost, input.pageHost)) refHost = "";

  const fromSource = utmSource ? (SOURCE_ALIASES[utmSource.toLowerCase()] ?? lookupHost(utmSource)) : null;
  const fromRef = refHost ? lookupHost(refHost) : null;
  const known = fromSource ?? fromRef;
  const kind = known?.[1];
  const source = utmSource ? (fromSource?.[0] ?? utmSource) : refHost ? (fromRef?.[0] ?? refHost.replace(/^www\./, "")) : null;

  const clickType = (input.clickIdType ?? null) as ClickIdType | null;
  const paidMedium = PAID_MEDIUM.test(medium) || DISPLAY_MEDIUM.test(medium);

  // 1. Explicit paid signals.
  if (paidMedium || (clickType && CLICK_ID_CHANNEL[clickType])) {
    if (DISPLAY_MEDIUM.test(medium)) return { channel: "Display", source };
    if (kind === "social" || clickType === "fbclid") return { channel: "Paid Social", source };
    if (kind === "search") return { channel: "Paid Search", source };
    if (clickType && CLICK_ID_CHANNEL[clickType]) {
      const ch = CLICK_ID_CHANNEL[clickType]!;
      const fallback: Record<string, string> = {
        gclid: "Google",
        gbraid: "Google",
        wbraid: "Google",
        dclid: "Google",
        msclkid: "Bing",
        ttclid: "TikTok",
        li_fat_id: "LinkedIn",
        twclid: "X",
        rdt_cid: "Reddit",
        epik: "Pinterest",
        sccid: "Snapchat",
      };
      return { channel: ch, source: source ?? fallback[clickType] ?? null };
    }
    if (/^(cpc|ppc)$/.test(medium)) return { channel: "Paid Search", source };
    return { channel: "Paid Other", source };
  }
  if (/^(affiliate|affiliates|partner)$/.test(medium)) return { channel: "Affiliates", source };
  if (EMAIL_MEDIUM.test(medium) || (!medium && (kind === "email" || /email|newsletter/.test(utmSource.toLowerCase()))))
    return { channel: "Email", source };
  if (kind === "ai") return { channel: "AI Assistants", source };
  if (SOCIAL_MEDIUM.test(medium) || kind === "social" || clickType === "fbclid") {
    return { channel: "Organic Social", source: source ?? (clickType === "fbclid" ? "Facebook" : null) };
  }
  if (medium === "organic" || kind === "search") return { channel: "Organic Search", source };
  if (/^(referral|link|app)$/.test(medium) || refHost || utmSource || campaign) {
    return source ? { channel: "Referral", source } : { channel: "Direct", source: null };
  }
  return { channel: "Direct", source: null };
}
