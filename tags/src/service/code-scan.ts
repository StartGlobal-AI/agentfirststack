import type { ContainerConfig } from "../config/schema";

/**
 * The check custom code passes before it's published (and before a preview or environment build
 * serves it): known-bad patterns only, so ordinary tag code never trips it.
 *
 *   - miner: crypto-mining libraries and services (CoinHive and its successors, CryptoNight,
 *     XMRig, stratum+tcp:// pool URLs) and their hosts.
 *   - skimmer: code that looks up a password or payment-card field (querySelector / getElementById
 *     / getElementsByName / jQuery with a selector naming password, card number, cc-number, CVV,
 *     CVC or security code), reads its value and sends it somewhere (fetch, XMLHttpRequest,
 *     sendBeacon, an image or script src, WebSocket, jQuery ajax). Strong when the destination is
 *     another site (an absolute URL off the container's domain) or hidden (decoded at run time);
 *     a dom_value variable reading such a field is refused too (no pause).
 *   - obfuscated_eval: eval / Function / setTimeout of a decoded string (atob, unescape,
 *     String.fromCharCode, decodeURIComponent), the p,a,c,k,e,d packer, eval reached through
 *     string tricks (window["ev"+"al"], hex escapes), document.write of decoded markup, and
 *     JSFuck-style runs of []()!+.
 *   - malicious_host: hosts that served malware to sites (mining services and pools; the 2024
 *     polyfill.io supply-chain hosts), plus the operator's EXTRA_BLOCKED_CODE_HOSTS.
 *
 * Before matching, the code is also read de-obfuscated: hex and unicode escapes decoded, adjacent
 * string literals joined ("coin" + "hive"), atob("...") literals, String.fromCharCode(...) lists and
 * %XX runs decoded. Any finding refuses the publish (422 custom_code_blocked); a strong one also
 * pauses tags.custom_code for the account (the operator reviews it, the project's people are told).
 */

export type CodeRule = "miner" | "skimmer" | "obfuscated_eval" | "malicious_host";

export interface CodeFinding {
  /** Config path of the tag, variable or param. */
  path: string;
  rule: CodeRule;
  /** A strong match: publishing is refused and custom code is paused for the account. Else it's only refused. */
  strong: boolean;
  /** The text that matched (at most 80 characters). */
  match: string;
  message: string;
}

/** Strong: no legitimate tag loads from these. */
const MINER_HOSTS = [
  "coinhive.com",
  "coin-hive.com",
  "authedmine.com",
  "crypto-loot.com",
  "cryptoloot.pro",
  "webminepool.com",
  "jsecoin.com",
  "coinimp.com",
  "minero.cc",
  "ppoi.org",
  "monerise.com",
  "webmine.cz",
  "supportxmr.com",
  "moneroocean.stream",
  "minexmr.com",
  "nanopool.org",
  "hashvault.pro",
];
/** Refused (not paused): hosts that served malware in a supply-chain attack; the code may predate it. */
const COMPROMISED_HOSTS = [
  "polyfill.io",
  "polyfill.com",
  "bootcdn.net",
  "bootcss.com",
  "staticfile.org",
  "staticfile.net",
  "googie-anaiytics.com",
];

const MINER =
  /\b(?:coinhive|coin-hive|cryptonight|cryptoloot|crypto-loot|coinimp|authedmine|webminepool|jsecoin|deepminer|cryptonoter|monerominer|xmrig)\b|stratum\+(?:tcp|ssl|tls):\/\//i;

const SENSITIVE = "password|passwd|cc-?num|cc-?number|cc-csc|cc-exp|card-?num|card_num|cardnumber|cvv|cvc|security-?code";
const SENSITIVE_LOOKUP = new RegExp(
  `(?:querySelector(?:All)?|getElementById|getElementsByName|\\$|jQuery)\\s*\\(\\s*(['"\`])[^'"\`]{0,200}?(?:${SENSITIVE})[^'"\`]{0,200}?\\1`,
  "i",
);
const SENSITIVE_SELECTOR = new RegExp(SENSITIVE, "i");
const VALUE_READ = /\.value\b|new\s+FormData\b|\.val\s*\(\s*\)/i;
const SINK =
  /\bfetch\s*\(|XMLHttpRequest|sendBeacon\s*\(|new\s+Image\b|\.src\s*=|WebSocket\s*\(|(?:\$|jQuery)\.(?:ajax|post|get|getJSON)\s*\(/i;

const EVAL_DECODED =
  /\b(?:eval|Function|setTimeout|setInterval)\s*\(\s*(?:window\.)?(?:atob|unescape|decodeURIComponent|decodeURI|String\.fromCharCode)\s*\(/i;
const PACKER = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/i;
const EVAL_INDIRECT = /\[\s*(['"])(?:eval|Function)\1\s*\]/;
const WRITE_DECODED = /document\.write(?:ln)?\s*\(\s*(?:unescape|atob|decodeURIComponent|String\.fromCharCode)\s*\(/i;
const JSFUCK = /[[\]()!+]{80,}/;
const DECODER = /\b(?:atob|unescape|String\.fromCharCode|decodeURIComponent)\s*\(/i;
const URL_HOST = /(?:(?:https?|wss?):)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,63})(?![a-z0-9-])([^\s'"`)<>]*)/gi;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A whole host name (or a subdomain of one), not part of a longer label or a longer name (bad.example.org). */
const hostsRe = (hosts: string[]) =>
  hosts.length ? new RegExp(`(?<![a-z0-9-])(?:${hosts.map(esc).join("|")})(?![a-z0-9-]|\\.[a-z0-9])`, "i") : null;
const MINER_HOSTS_RE = hostsRe(MINER_HOSTS);
const COMPROMISED_RE = hostsRe(COMPROMISED_HOSTS);

const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

/** The code as written plus what it decodes to at run time, so hidden hosts and names are found too. */
export function deobfuscate(code: string): string {
  const parts: string[] = [];
  const unescaped = code
    .replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  // "coin" + "hive" -> "coinhive"
  const joined = unescaped.replace(/(['"`])\s*\+\s*(['"`])/g, "");
  parts.push(joined);
  for (const m of joined.matchAll(/atob\s*\(\s*(['"`])([A-Za-z0-9+/=\s]{8,})\1\s*\)/g)) {
    try {
      parts.push(atob(m[2]!.replace(/\s+/g, "")));
    } catch {
      /* not base64 */
    }
  }
  for (const m of joined.matchAll(/fromCharCode\s*\(\s*((?:\d{1,6}\s*,\s*){3,}\d{1,6})\s*\)/g))
    parts.push(String.fromCharCode(...m[1]!.split(",").map((n) => Number(n.trim()) & 0xffff)));
  for (const m of joined.matchAll(/(?:%[0-9a-f]{2}){4,}/gi)) {
    try {
      parts.push(decodeURIComponent(m[0]));
    } catch {
      parts.push(m[0].replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))));
    }
  }
  return parts.join("\n");
}

/**
 * Hosts of absolute URLs that aren't the site itself (or a subdomain) or this deployment's own.
 * A plain library load (a path ending in .js / .mjs / .css, no query) isn't somewhere data is sent.
 */
function offsiteHosts(text: string, own: string[]): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_HOST)) {
    const h = m[1]!.toLowerCase();
    if (/\.(?:m?js|css)$/i.test(m[2] ?? "")) continue;
    if (!own.some((o) => h === o || h.endsWith(`.${o}`))) out.add(h);
  }
  return [...out];
}

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

export interface ScanContext {
  /** The container's domain: URLs on it (or a subdomain) aren't "off-site". */
  domain: string;
  ANALYTICS_BASE_URL?: string;
  PUBLIC_BASE_URL?: string;
  /** Operator's extra hosts (comma or space separated): a match is strong. */
  EXTRA_BLOCKED_CODE_HOSTS?: string;
}

/** Every finding in one piece of code. */
export function scanCode(path: string, code: string, ctx: ScanContext): CodeFinding[] {
  const out: CodeFinding[] = [];
  const text = deobfuscate(code);
  const add = (rule: CodeRule, strong: boolean, match: string, message: string) => {
    if (!out.some((f) => f.rule === rule)) out.push({ path, rule, strong, match: clip(match), message });
  };
  const extra = (ctx.EXTRA_BLOCKED_CODE_HOSTS ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));

  let m = MINER.exec(text);
  if (m) add("miner", true, m[0], "It loads or runs a crypto miner.");
  m = MINER_HOSTS_RE?.exec(text) ?? null;
  if (m) add("miner", true, m[0], `It talks to ${m[0].toLowerCase()}, a crypto-mining service or pool.`);
  m = hostsRe(extra)?.exec(text) ?? null;
  if (m) add("malicious_host", true, m[0], `It loads from or talks to ${m[0].toLowerCase()}, a host this platform blocks.`);
  m = COMPROMISED_RE?.exec(text) ?? null;
  if (m)
    add(
      "malicious_host",
      false,
      m[0],
      `It loads from ${m[0].toLowerCase()}, a host that served malware to sites (the 2024 polyfill.io supply-chain attack). Use cdnjs.cloudflare.com or your own copy.`,
    );

  const lookup = SENSITIVE_LOOKUP.exec(text);
  if (lookup && VALUE_READ.test(text) && SINK.test(text)) {
    const own = [ctx.domain, hostOf(ctx.ANALYTICS_BASE_URL), hostOf(ctx.PUBLIC_BASE_URL)].filter((h): h is string => !!h);
    const away = offsiteHosts(text, own);
    const hidden = DECODER.test(code);
    add(
      "skimmer",
      away.length > 0 || hidden,
      lookup[0],
      away.length
        ? `It reads a password or payment-card field and sends data to ${away.slice(0, 3).join(", ")} (another site).`
        : hidden
          ? "It reads a password or payment-card field and sends data to an address it decodes at run time."
          : "It reads a password or payment-card field and sends data out. Keep that in your site's own code, not in a tag.",
    );
  }

  for (const re of [EVAL_DECODED, PACKER, WRITE_DECODED, JSFUCK]) {
    m = re.exec(code) ?? re.exec(text);
    if (m) {
      add("obfuscated_eval", false, m[0], "It runs code it decodes or hides at run time (eval of a decoded string, a packer, JSFuck).");
      break;
    }
  }
  m = EVAL_INDIRECT.exec(text);
  if (m && !out.some((f) => f.rule === "obfuscated_eval"))
    add("obfuscated_eval", false, m[0], "It reaches eval (or Function) through a string lookup, a way to hide what it runs.");
  return out;
}

/** Every finding in a config's custom code (custom_html, custom_js tags and variables, analytics base_url) and DOM reads. */
export function scanConfig(config: ContainerConfig | null | undefined, ctx: ScanContext): CodeFinding[] {
  const out: CodeFinding[] = [];
  (config?.tags ?? []).forEach((t, i) => {
    if (t.type === "custom_html") out.push(...scanCode(`tags.${i}.params.html`, t.params.html, ctx));
    else if (t.type === "custom_js") out.push(...scanCode(`tags.${i}.params.code`, t.params.code, ctx));
    else if (t.type === "analytics" && t.params.base_url)
      out.push(...scanCode(`tags.${i}.params.base_url`, t.params.base_url, ctx).filter((f) => f.rule !== "skimmer"));
  });
  (config?.variables ?? []).forEach((v, i) => {
    if (v.type === "custom_js") out.push(...scanCode(`variables.${i}.code`, v.code, ctx));
    // A built-in DOM variable reading a password or card field is the tag-manager way to skim one.
    else if (v.type === "dom_value" && SENSITIVE_SELECTOR.test(v.selector))
      out.push({
        path: `variables.${i}.selector`,
        rule: "skimmer",
        strong: false,
        match: clip(v.selector),
        message: "A dom_value variable may not read a password or payment-card field.",
      });
  });
  return out;
}

/** One line for errors and the pause reason: "a crypto miner (tags.2.params.code)". */
export function describeFindings(findings: CodeFinding[]): string {
  const what: Record<CodeRule, string> = {
    miner: "a crypto miner",
    skimmer: "code reading password or card fields and sending them out",
    obfuscated_eval: "obfuscated code run through eval",
    malicious_host: "a blocked host",
  };
  return findings
    .slice(0, 3)
    .map((f) => `${what[f.rule]} (${f.path})`)
    .join("; ");
}
