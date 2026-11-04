import { CLICK_ID_PARAMS, type ClickIdType } from "./channel";

/**
 * Page + referrer parsing. Query strings are never stored (they can carry emails, tokens); only
 * the UTM tags and the first click id are kept, as their own columns.
 */

export interface ParsedPage {
  hostname: string | null;
  pathname: string;
  /** origin + pathname, no query or hash */
  url: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  utm_id: string | null;
  utm_source_platform: string | null;
  utm_creative_format: string | null;
  utm_marketing_tactic: string | null;
  click_id_type: ClickIdType | null;
  click_id: string | null;
}

const clip = (s: string | null | undefined, n: number): string | null => {
  if (s == null) return null;
  const t = s.trim();
  return t ? t.slice(0, n) : null;
};

export function parsePage(raw: string | null | undefined): ParsedPage {
  const empty: ParsedPage = {
    hostname: null,
    pathname: "/",
    url: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_term: null,
    utm_content: null,
    utm_id: null,
    utm_source_platform: null,
    utm_creative_format: null,
    utm_marketing_tactic: null,
    click_id_type: null,
    click_id: null,
  };
  if (!raw) return empty;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // A bare path ("/pricing?utm_source=x") is fine for server events.
    try {
      u = new URL(raw, "http://_");
    } catch {
      return empty;
    }
  }
  const q = u.searchParams;
  let clickType: ClickIdType | null = null;
  let clickId: string | null = null;
  for (const p of CLICK_ID_PARAMS) {
    const v = q.get(p);
    if (v) {
      clickType = p;
      clickId = v.slice(0, 500);
      break;
    }
  }
  const host = u.hostname === "_" ? null : u.hostname.toLowerCase();
  let pathname = u.pathname || "/";
  try {
    pathname = decodeURI(pathname);
  } catch {
    /* keep encoded */
  }
  return {
    hostname: host,
    pathname: pathname.slice(0, 1000),
    url: host ? `${u.protocol}//${u.host}${u.pathname}`.slice(0, 1500) : null,
    // `ref` and `source` are common short forms of utm_source (?ref=producthunt).
    utm_source: clip(q.get("utm_source") ?? q.get("ref") ?? q.get("source"), 200),
    utm_medium: clip(q.get("utm_medium"), 200),
    utm_campaign: clip(q.get("utm_campaign"), 200),
    utm_term: clip(q.get("utm_term"), 200),
    utm_content: clip(q.get("utm_content"), 200),
    utm_id: clip(q.get("utm_id"), 200),
    utm_source_platform: clip(q.get("utm_source_platform"), 200),
    utm_creative_format: clip(q.get("utm_creative_format"), 200),
    utm_marketing_tactic: clip(q.get("utm_marketing_tactic"), 200),
    click_id_type: clickType,
    click_id: clickId,
  };
}

export interface ParsedReferrer {
  /** origin + path, no query */
  referrer: string | null;
  referrer_host: string | null;
}

export function parseReferrer(raw: string | null | undefined): ParsedReferrer {
  if (!raw) return { referrer: null, referrer_host: null };
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "android-app:") {
      return { referrer: null, referrer_host: null };
    }
    const host = u.hostname.toLowerCase();
    if (!host) return { referrer: null, referrer_host: null };
    return { referrer: `${host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 1000), referrer_host: host };
  } catch {
    // Some apps send a bare host as referrer.
    const host = raw.trim().toLowerCase();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)
      ? { referrer: host.replace(/^www\./, ""), referrer_host: host }
      : { referrer: null, referrer_host: null };
  }
}

/**
 * The route of a hash-routed SPA (data-hash="true"): "#/settings/team?tab=x" -> "#/settings/team".
 * A plain anchor ("#pricing") is not a route: null. The query part is dropped like any query string.
 */
export function hashRoute(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const i = raw.indexOf("#");
  if (i < 0) return null;
  const h = raw.slice(i).split("?")[0]!;
  return /^#!?\//.test(h) ? h.slice(0, 500) : null;
}

/** The query string of a URL ("?a=1&b=2"), or "" (only read for site search; never stored). */
export function queryOf(raw: string | null | undefined): string {
  if (!raw) return "";
  const q = raw.split("#")[0]!.indexOf("?");
  return q < 0 ? "" : raw.split("#")[0]!.slice(q, q + 2000);
}

/** Viewport width -> a coarse class (no exact sizes: they help fingerprinting). */
export function screenClass(w: unknown): string | null {
  if (typeof w !== "number" || !Number.isFinite(w) || w <= 0 || w > 20_000) return null;
  return w < 576 ? "xs" : w < 992 ? "sm" : w < 1440 ? "md" : "lg";
}

/** Accept-Language -> the primary language subtag ("en-US,en;q=0.9" -> "en"). */
export function primaryLanguage(header: string | null | undefined): string | null {
  const m = /^\s*([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*\s*(?:[;,]|$)/.exec(header ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

/** "https://WWW.Example.com:443/x" -> "example.com". Throws on junk. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  if (!s) throw new Error("empty domain");
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  const u = new URL(s);
  const host = u.hostname.replace(/\.$/, "").replace(/^www\./, "");
  if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$/.test(host) || (!host.includes(".") && host !== "localhost")) {
    throw new Error("invalid domain");
  }
  return host;
}

// ------------------------------------------------------------------ hostnames and public suffixes

/**
 * Hosting platforms and other private registries where every subdomain belongs to someone else
 * (a compact slice of the Public Suffix List's private section; no dependency).
 */
const SHARED_SUFFIXES = new Set([
  "github.io",
  "gitlab.io",
  "bitbucket.io",
  "github.dev",
  "gitpod.io",
  "pages.dev",
  "workers.dev",
  "r2.dev",
  "trycloudflare.com",
  "vercel.app",
  "now.sh",
  "netlify.app",
  "netlify.com",
  "herokuapp.com",
  "herokussl.com",
  "onrender.com",
  "fly.dev",
  "deno.dev",
  "railway.app",
  "up.railway.app",
  "koyeb.app",
  "replit.app",
  "replit.dev",
  "repl.co",
  "glitch.me",
  "surge.sh",
  "stackblitz.io",
  "csb.app",
  "codesandbox.io",
  "lovable.app",
  "web.app",
  "firebaseapp.com",
  "firebaseio.com",
  "appspot.com",
  "run.app",
  "cloudfunctions.net",
  "azurewebsites.net",
  "azurestaticapps.net",
  "cloudapp.net",
  "trafficmanager.net",
  "blob.core.windows.net",
  "cloudfront.net",
  "amazonaws.com",
  "s3.amazonaws.com",
  "elasticbeanstalk.com",
  "ondigitalocean.app",
  "digitaloceanspaces.com",
  "supabase.co",
  "blogspot.com",
  "wordpress.com",
  "wpengine.com",
  "myshopify.com",
  "wixsite.com",
  "squarespace.com",
  "webflow.io",
  "framer.app",
  "framer.website",
  "carrd.co",
  "notion.site",
  "readthedocs.io",
  "gitbook.io",
  "neocities.org",
  "tumblr.com",
  "substack.com",
  "ghost.io",
  "hashnode.dev",
  "pythonanywhere.com",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "loca.lt",
  "localhost.run",
  "ts.net",
  "duckdns.org",
  "no-ip.org",
  "ddns.net",
  "dyndns.org",
  "translate.goog",
]);
/** Second-level labels that country registries sell under (co.uk, com.au, ac.jp, ...). */
const REGISTRY_SLDS = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "or",
  "ne",
  "go",
  "ltd",
  "plc",
  "me",
  "nom",
  "sch",
  "mil",
  "gob",
  "gouv",
  "nic",
]);

/**
 * Is `host` a public suffix, i.e. something under which unrelated parties own the names? A
 * single label (com, io, localhost), a country registry's second level (co.uk, com.br) or a
 * shared hosting suffix (github.io, vercel.app). Compact and conservative, not the full PSL.
 */
export function isPublicSuffix(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return true;
  if (SHARED_SUFFIXES.has(h)) return true;
  const labels = h.split(".");
  return labels.length === 2 && labels[1]!.length === 2 && REGISTRY_SLDS.has(labels[0]!);
}

/** "*.com", "*.co.uk", "*.vercel.app": a wildcard that would match other people's hosts. */
export const isPublicSuffixWildcard = (pattern: string) => pattern.startsWith("*.") && isPublicSuffix(pattern.slice(2));

/** An IPv4 or IPv6 literal (with or without brackets). */
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export const isDevHost = (host: string) => DEV_HOSTS.has(host.toLowerCase());

/** The site's own hosts: its domain and every subdomain (www. included). */
export function onSiteDomain(host: string | null, domain: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

/** One pattern: an exact host (its www. too) or "*.example.com" (the apex and every subdomain). */
export function matchesHostPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.startsWith("*.")) return h === pat.slice(2) || h.endsWith(pat.slice(1));
  return h === pat || h === `www.${pat}`;
}

/**
 * Does `host` match a pattern list (exact host or "*.example.com")? Public-suffix wildcards
 * ("*.com", "*.vercel.app") never match: they would let anyone's hostname in.
 */
export function hostAllowed(host: string | null, patterns: string[] | null | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  if (!host) return false;
  return patterns.some((p) => !isPublicSuffixWildcard(p.toLowerCase()) && matchesHostPattern(host, p));
}

/**
 * Browser events a site accepts: from allowed_hostnames when set; otherwise only from the site's
 * domain and its subdomains (plus localhost in DEV_MODE), so a public site id can't be used to
 * fill someone's site with events from anywhere.
 */
export function browserHostAllowed(
  host: string | null,
  settings: { domain: string; allowed_hostnames: string[] | null },
  dev: boolean,
): boolean {
  if (dev && host && isDevHost(host)) return true;
  if (settings.allowed_hostnames?.length) return hostAllowed(host, settings.allowed_hostnames);
  return onSiteDomain(host, settings.domain);
}
