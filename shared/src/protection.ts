/**
 * Attack protection shared by the services that take public browser traffic (analytics, tags):
 * the vocabulary of a resource's protection state, and the networks that are data centres.
 *
 * Site and container ids sit in every customer's HTML, so anyone can send events with them. Two
 * defences, per site or container:
 *  - A network's daily share: past MAX_EVENTS_PER_NETWORK_PER_<RESOURCE>_PER_DAY events from one
 *    network (the same network as the per-IP limiter) in a UTC day, its events are quarantined,
 *    not counted against the daily budget, so one source can't use up the budget real visitors need.
 *  - Attack mode: a sudden spike marks the resource under attack for at least an hour. While it
 *    lasts, traffic from data-centre networks is quarantined too, and (tags) browser conversions
 *    are not forwarded to ad platforms.
 * Quarantined traffic is kept out of reports and budgets for review, then released or purged.
 */

/** auto (default): share cap always, attack measures when a spike is detected; strict: attack measures always; off: neither. */
export type ProtectionMode = "auto" | "strict" | "off";
export const PROTECTION_MODES: readonly ProtectionMode[] = ["auto", "strict", "off"];

export type AttackReason = "network_share" | "spike" | "datacenter";

/**
 * One entry of `attacks` in a service's GET /v1/usage: a site or container whose protection is
 * active now, or was in the last 24 hours. The site Worker emails the project's people and shows a
 * banner from these (src/project-health.ts).
 */
export interface AttackItem {
  service: "analytics" | "tags";
  /** site_... or ctr_... */
  resource_id: string;
  /** the domain (or name) people know it by */
  resource_label: string;
  /** under_attack: a spike, attack measures on. contained: only networks over their share, already quarantined. ended: in the last 24 h. */
  state: "under_attack" | "contained" | "ended";
  mode: ProtectionMode;
  /** unix ms: when this episode started */
  since: number;
  /** unix ms: the last time a trigger fired */
  last_seen_at: number;
  /** unix ms, state "ended" only */
  ended_at: number | null;
  reasons: { kind: AttackReason; detail: string }[];
  /** events quarantined in this episode (today's count when the episode spans days) */
  quarantined: number;
  /** what an agent or the owner can do next, as in every API answer */
  next_steps: string[];
}

/**
 * Autonomous systems that are hosting providers and clouds: real people rarely browse from them,
 * scripted traffic often does. Used only while a resource is under attack (or strict), and what
 * matches is quarantined, never dropped, so a VPN or corporate proxy user can be released.
 * Left out on purpose: networks that carry real people's browsing, such as Cloudflare (WARP),
 * Akamai and Fastly (iCloud Private Relay egress) and Google (15169).
 */
export const DATACENTER_ASNS: ReadonlySet<number> = new Set([
  // Amazon AWS
  16509, 14618, 8987,
  // Google Cloud
  396982,
  // Microsoft Azure
  8075,
  // DigitalOcean, Hetzner, OVH, Akamai Linode, Vultr, Contabo, Oracle Cloud, Scaleway
  14061, 24940, 16276, 63949, 20473, 51167, 31898, 12876,
  // Alibaba Cloud, Tencent Cloud, Huawei Cloud
  45102, 37963, 132203, 45090, 136907,
  // Leaseweb, M247, Clouvider, ColoCrossing, HIVELOCITY, Stark Industries
  60781, 16265, 28753, 9009, 62240, 36352, 29802, 44477,
  // Unified Layer, GoDaddy, Liquid Web
  46606, 26496, 32244,
  // Hosting often behind scanners and floods: IP Volume, AEZA, Pfcloud, Delis, BL Networks, Censys
  202425, 210644, 51396, 211252, 399629, 398324,
]);

export const isDatacenterAsn = (asn: number | null | undefined): boolean => typeof asn === "number" && DATACENTER_ASNS.has(asn);

/** How long a resource stays under attack after the last trigger. */
export const ATTACK_COOLDOWN_MS = 60 * 60_000;
/** Spike detection: the window, and how far above the site's usual rate it must be. */
export const SPIKE_WINDOW_MS = 15 * 60_000;
export const SPIKE_FACTOR = 10;
