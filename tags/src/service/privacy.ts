import type { DispatchEvent } from "../destinations/types";
import { identitySummary } from "./ingest";

/**
 * What the event log keeps of an event's network identity. The raw IP, user agent, city and
 * postal code are only needed to deliver it (conversion APIs and the analytics app match on
 * them): they travel in each destination's dispatch queue message, which is gone once that
 * delivery succeeded or gave up. The log row keeps the network (IPv4 /24, IPv6 /48), country and
 * region, coarse device fields and a summary of what the event carried. Dedupe (event_id, order
 * id) and visitor joins (the visitors table) don't read any of these fields.
 */

/** IPv4 as its /24 ("203.0.113.0/24"), IPv6 as its /48 ("2001:db8:1::/48"); null when it isn't an IP. */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const s = ip.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? `${v4[1]}.${v4[2]}.${v4[3]}.0/24` : null;
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  const head = groups.slice(0, 3);
  if (head.length < 3 || head.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${head.map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/48`;
}

/** Key under which a log row keeps the identity summary of the event as delivered (raw fields included). */
export const LOG_IDENTITY = "_identity";

/** The event as the event log stores it: no raw IP, user agent, city or postal code. */
export function eventForLog(e: DispatchEvent): Record<string, unknown> {
  const { ip, user_agent: _ua, geo, device, ...rest } = e;
  const network = truncateIp(ip);
  const coarseGeo = geo ? { country: geo.country, region: geo.region, region_code: geo.region_code } : undefined;
  const coarseDevice = device ? { category: device.category, browser: device.browser, os: device.os } : undefined;
  return {
    ...rest,
    ...(network ? { ip_network: network } : {}),
    ...(coarseGeo && Object.values(coarseGeo).some(Boolean) ? { geo: coarseGeo } : {}),
    ...(coarseDevice && Object.values(coarseDevice).some(Boolean) ? { device: coarseDevice } : {}),
    [LOG_IDENTITY]: identitySummary(e),
  };
}

/**
 * A destination's logged request or answer with the event's raw IP (-> its network), user agent,
 * city and postal code taken out, so the log doesn't keep what the delivery needed.
 */
export function scrubDelivered<T>(v: T, e: Pick<DispatchEvent, "ip" | "user_agent" | "geo">): T {
  const swaps: [string, string][] = [];
  if (e.ip && e.ip.length >= 3) swaps.push([e.ip, truncateIp(e.ip) ?? "(ip not kept)"]);
  if (e.user_agent && e.user_agent.length >= 8) swaps.push([e.user_agent, "(user agent not kept)"]);
  const exact = new Map<string, string>();
  if (e.geo?.city) exact.set(e.geo.city, "(city not kept)");
  if (e.geo?.postal_code) exact.set(e.geo.postal_code, "(postal code not kept)");
  if (!swaps.length && !exact.size) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      const hit = exact.get(x);
      if (hit) return hit;
      let s = x;
      for (const [from, to] of swaps) if (s.includes(from)) s = s.split(from).join(to);
      return s;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk(v) as T;
}
