import { type IpRule, matchIp, parseCidr } from "./cidr";
import { matchesHostPattern } from "./url";
import { hostUnder, normalizeHostList } from "./referrers";

/**
 * Ingest exclusions: drop events from the owner's own IPs (CIDR, v4 and v6), paths, hostnames
 * or countries before they are stored. Pure. The visitor IP is compared in memory inside the
 * site's Durable Object and never stored; a drop's sample is the rule that matched, not the IP.
 */

export interface Exclusions {
  ips: string[];
  paths: string[];
  hostnames: string[];
  countries: string[];
  /** referrer hosts to drop (the site's additions to the built-in referrer-spam list); older copies: none */
  referrers?: string[];
}

export const EXCLUSION_REASONS = ["excluded_ip", "excluded_path", "excluded_hostname", "excluded_country", "excluded_referrer"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const MAX_EXCLUSION_RULES = 100;

export interface CompiledExclusions {
  ips: IpRule[];
  paths: { text: string; re: RegExp }[];
  hostnames: string[];
  countries: Set<string>;
  referrers: string[];
}

/** `*` matches any run of characters (including "/"); everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** Validate and normalise user input. Returns problems (empty when fine) and the cleaned rules. */
export function normalizeExclusions(input: Partial<Exclusions>): { value: Exclusions; problems: string[] } {
  const problems: string[] = [];
  const ips: string[] = [];
  for (const raw of input.ips ?? []) {
    const r = parseCidr(raw);
    if (!r) problems.push(`ips: "${raw}" is not an IPv4/IPv6 address or CIDR range (e.g. 203.0.113.0/24, 2001:db8::/32).`);
    else if (!ips.includes(r.text)) ips.push(r.text);
  }
  const paths: string[] = [];
  for (const raw of input.paths ?? []) {
    const p = raw.trim();
    if (!p.startsWith("/")) problems.push(`paths: "${raw}" must start with "/" (use * as a wildcard, e.g. /admin/*).`);
    else if (!paths.includes(p)) paths.push(p);
  }
  const hostnames: string[] = [];
  for (const raw of input.hostnames ?? []) {
    const h = raw.trim().toLowerCase();
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(h)) problems.push(`hostnames: "${raw}" must be a hostname or *.example.com.`);
    else if (!hostnames.includes(h)) hostnames.push(h);
  }
  const countries: string[] = [];
  for (const raw of input.countries ?? []) {
    const c = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) problems.push(`countries: "${raw}" must be an ISO 3166-1 alpha-2 code like US or DE.`);
    else if (!countries.includes(c)) countries.push(c);
  }
  const refs = normalizeHostList(input.referrers ?? [], "referrers");
  problems.push(...refs.problems);
  return { value: { ips, paths, hostnames, countries, referrers: refs.value }, problems };
}

export const isEmptyExclusions = (x: Exclusions | null | undefined) =>
  !x || (!x.ips.length && !x.paths.length && !x.hostnames.length && !x.countries.length && !x.referrers?.length);

export function compileExclusions(x: Exclusions | null | undefined): CompiledExclusions | null {
  if (!x || isEmptyExclusions(x)) return null;
  return {
    ips: x.ips.map(parseCidr).filter((r): r is IpRule => !!r),
    paths: x.paths.map((p) => ({ text: p, re: globToRegExp(p) })),
    hostnames: x.hostnames,
    countries: new Set(x.countries),
    referrers: x.referrers ?? [],
  };
}

export interface ExclusionTarget {
  ip?: string | null;
  pathname?: string | null;
  hostname?: string | null;
  country?: string | null;
  referrer_host?: string | null;
}

/** Which rule drops this event, if any. `rule` is safe to store (never the IP itself). */
export function excludedBy(c: CompiledExclusions | null, t: ExclusionTarget): { reason: ExclusionReason; rule: string } | null {
  if (!c) return null;
  const ip = matchIp(t.ip, c.ips);
  if (ip) return { reason: "excluded_ip", rule: ip.text };
  if (t.hostname) {
    const h = c.hostnames.find((p) => matchesHostPattern(t.hostname!, p));
    if (h) return { reason: "excluded_hostname", rule: h };
  }
  if (t.pathname) {
    const p = c.paths.find((x) => x.re.test(t.pathname!));
    if (p) return { reason: "excluded_path", rule: p.text };
  }
  if (t.country && c.countries.has(t.country.toUpperCase())) return { reason: "excluded_country", rule: t.country.toUpperCase() };
  if (t.referrer_host) {
    const r = c.referrers.find((p) => hostUnder(t.referrer_host!, p));
    if (r) return { reason: "excluded_referrer", rule: r };
  }
  return null;
}
