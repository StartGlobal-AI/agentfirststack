/**
 * IPv4 / IPv6 address and CIDR matching for ingest exclusions. Pure and in memory: rules are
 * parsed once, an address is compared byte by byte and never stored or logged.
 *
 *   parseIp("203.0.113.7")            -> 4 bytes
 *   parseIp("2001:db8::1")            -> 16 bytes
 *   parseIp("::ffff:203.0.113.7")     -> 4 bytes (IPv4-mapped IPv6 is treated as IPv4)
 *   parseCidr("203.0.113.0/24"), parseCidr("2001:db8::/32"), parseCidr("198.51.100.9") (= /32)
 */

export interface IpRule {
  /** normalised text, e.g. "203.0.113.0/24" (shown as the drop sample instead of any IP) */
  text: string;
  bytes: Uint8Array;
  prefix: number;
}

function parseV4(s: string): Uint8Array | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    // No leading zeros: "010" is octal in some parsers, so it is ambiguous; refuse it.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(input: string): Uint8Array | null {
  let s = input.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two hex groups.
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseV4(last);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const group = (g: string) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN);
  const left = halves[0] ? halves[0].split(":").map(group) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map(group) : [];
  if ([...left, ...right].some((n) => Number.isNaN(n))) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...Array(fill).fill(0), ...right];
  } else groups = left;
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
}

const isV4Mapped = (b: Uint8Array) => b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;

/** 4 bytes for IPv4 (and IPv4-mapped IPv6), 16 for IPv6, null for anything else. */
export function parseIp(input: string): Uint8Array | null {
  const s = input.trim();
  if (!s) return null;
  const v4 = parseV4(s);
  if (v4) return v4;
  const v6 = parseV6(s);
  if (!v6) return null;
  return isV4Mapped(v6) ? v6.slice(12) : v6;
}

function formatBytes(b: Uint8Array): string {
  if (b.length === 4) return [...b].join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  // Compress the longest run of zero groups (RFC 5952).
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`;
}

/** "a.b.c.d", "a.b.c.d/n", "v6", "v6/n". Host bits are cleared. null when invalid. */
export function parseCidr(input: string): IpRule | null {
  const s = input.trim();
  const slash = s.indexOf("/");
  const addr = slash >= 0 ? s.slice(0, slash) : s;
  let bytes = parseIp(addr);
  if (!bytes) return null;
  const max = bytes.length * 8;
  let prefix = max;
  if (slash >= 0) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    // An IPv4-mapped rule written as IPv6 (::ffff:1.2.3.0/120) has a v6 prefix length.
    const writtenV6 = addr.includes(":");
    if (writtenV6 && bytes.length === 4) {
      if (prefix < 96 || prefix > 128) return null;
      prefix -= 96;
    } else if (prefix > max) return null;
  }
  bytes = Uint8Array.from(bytes);
  for (let bit = prefix; bit < max; bit++) bytes[bit >> 3]! &= ~(0x80 >> (bit & 7));
  return { text: prefix === max ? formatBytes(bytes) : `${formatBytes(bytes)}/${prefix}`, bytes, prefix };
}

export function ipInRule(ip: Uint8Array, rule: IpRule): boolean {
  if (ip.length !== rule.bytes.length) return false;
  const full = rule.prefix >> 3;
  for (let i = 0; i < full; i++) if (ip[i] !== rule.bytes[i]) return false;
  const rest = rule.prefix & 7;
  if (!rest) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (ip[full]! & mask) === rule.bytes[full];
}

/** The first rule containing `ip`, or null (also null for an unparseable ip). */
export function matchIp(ip: string | null | undefined, rules: IpRule[]): IpRule | null {
  if (!ip || !rules.length) return null;
  const b = parseIp(ip);
  if (!b) return null;
  return rules.find((r) => ipInRule(b, r)) ?? null;
}
