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

/** Does `host` match a pattern list (exact host or "*.example.com")? */
export function hostAllowed(host: string | null, patterns: string[] | null | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  if (!host) return false;
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    if (pat.startsWith("*.")) return h === pat.slice(2) || h.endsWith(pat.slice(1));
    return h === pat || h === `www.${pat}`;
  });
}
