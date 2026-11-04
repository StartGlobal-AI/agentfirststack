/**
 * IP ranges for exclude_ip_ranges: IPv4 and IPv6 CIDRs, matched at ingest against the client's
 * address (which is never stored). Pure, no dependencies.
 */

function v4(ip: string): bigint | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0n;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    n = (n << 8n) | BigInt(Number(x));
  }
  return n;
}

function v6(ip: string): bigint | null {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // an embedded IPv4 tail (::ffff:1.2.3.4)
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const t = v4(m[2]!);
    if (t === null) return null;
    s = `${m[1]}${(t >> 16n).toString(16)}:${(t & 0xffffn).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

export interface Cidr {
  v: 4 | 6;
  base: bigint;
  bits: number;
}

/** "203.0.113.0/24", "2001:db8::/32", a bare address (= /32 or /128); null when it isn't one. */
export function parseCidr(s: string): Cidr | null {
  const [addr, len, ...rest] = s.trim().split("/");
  if (!addr || rest.length) return null;
  const four = v4(addr);
  const six = four === null ? v6(addr) : null;
  if (four === null && six === null) return null;
  const v = four !== null ? 4 : 6;
  const max = v === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (bits < 0 || bits > max) return null;
  const n = (four ?? six)!;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v, base: n & mask, bits };
}

/** Is `ip` (v4 or v6; IPv4-mapped IPv6 counts as IPv4) inside one of the ranges? */
export function ipInRanges(ip: string | null | undefined, ranges: readonly Cidr[]): boolean {
  if (!ip || !ranges.length) return false;
  let n4 = v4(ip);
  let n6: bigint | null = null;
  if (n4 === null) {
    n6 = v6(ip);
    if (n6 !== null && n6 >> 32n === 0xffffn) n4 = n6 & 0xffffffffn;
  }
  for (const r of ranges) {
    const n = r.v === 4 ? n4 : n6;
    if (n === null) continue;
    const max = r.v === 4 ? 32 : 128;
    const mask = r.bits === 0 ? 0n : ((1n << BigInt(r.bits)) - 1n) << BigInt(max - r.bits);
    if ((n & mask) === r.base) return true;
  }
  return false;
}

/**
 * Countries where recording waits for consent with require_consent "eea": the EU, Iceland,
 * Liechtenstein and Norway (the EEA), the United Kingdom and Switzerland. An unknown country
 * (no Cloudflare country, Tor "T1", "XX") asks for consent too.
 */
export const CONSENT_COUNTRIES = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH".split(" "),
);
export const consentRequiredIn = (country: string | null | undefined) =>
  !country || !/^[A-Z]{2}$/.test(country) || country === "XX" || country === "T1" || CONSENT_COUNTRIES.has(country);
