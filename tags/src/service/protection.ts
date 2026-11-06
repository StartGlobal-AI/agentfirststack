import {
  ATTACK_COOLDOWN_MS,
  type AttackItem,
  type AttackReason,
  hmacSha256Hex,
  type ProtectionMode,
  SPIKE_FACTOR,
  type Standing,
} from "@afs/shared";
import { capVar, standingCap } from "./limits";

/**
 * Attack protection for a container (vocabulary in @afs/shared protection.ts). Pure helpers: the
 * state lives in the ContainerDO, the network hash and the network operator are worked out in the
 * Worker (collect.ts) and passed in with the hit.
 *
 *  - A network's daily share (MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY): past it, that network's
 *    browser hits are quarantined for the rest of the UTC day, and the container is "contained".
 *  - A spike (a 15-minute window SPIKE_FACTOR times the usual rate, and at least SPIKE_MIN hits)
 *    from at least SPIKE_MIN_NETWORKS distinct networks puts the container under attack: data-centre
 *    traffic is quarantined (its conversions with it). Conversions from every other network keep
 *    flowing. The same volume from fewer networks is a flood each network's share already bounds:
 *    the container is "contained", not under attack.
 *  - strict (the owner's choice) quarantines data-centre traffic and holds every browser conversion
 *    all the time. Backend events (API key) are never touched.
 */

/** The fewest hits in one window that count as a spike (SPIKE_MIN_EVENTS overrides it, for tests). */
export const SPIKE_MIN = 1000;
/** The fewest distinct networks in that window for a spike to be an attack (SPIKE_MIN_NETWORKS overrides it). */
export const SPIKE_MIN_NETWORKS = 20;
/** An ended episode is still reported (GET /v1/usage attacks, GET /v1/containers/:id) this long. */
export const ENDED_VISIBLE_MS = 24 * 3_600_000;

export type QuarantineReason = "network_share" | "datacenter";
export const QUARANTINE_REASONS: readonly QuarantineReason[] = ["network_share", "datacenter"];
export type ProtectionState = "under_attack" | "contained" | "ended" | "none";

/** The episode as the ContainerDO stores it (meta "protection"). */
export interface StoredProtection {
  state: "under_attack" | "contained" | "ended";
  since: number;
  last_seen_at: number;
  ended_at: number | null;
  reasons: { kind: AttackReason; detail: string }[];
  /** Hits quarantined in the episode on q_day (today's count when the episode spans days). */
  quarantined: number;
  q_day: string;
}

/** What GET /v1/containers/:id, /quarantine and GET /v1/usage show (next_steps added by the Worker). */
export interface ProtectionView {
  mode: ProtectionMode;
  state: ProtectionState;
  since: number | null;
  last_seen_at: number | null;
  ended_at: number | null;
  reasons: { kind: AttackReason; detail: string }[];
  /** Quarantined in this episode (today's count when it spans days). */
  quarantined: number;
  /** Every hit quarantined today, in an episode or not (strict mode quarantines data-centre traffic all the time). */
  quarantined_today: number;
  /** Browser conversions not forwarded server-side today: quarantined ones, and every one while protection is strict. */
  conversions_held_today: number;
  /** What applies to the next browser hit (browser_conversions_held: all of them, strict only). */
  measures: { network_share_limit: number | null; datacenter_quarantine: boolean; browser_conversions_held: boolean };
}

export const parseMode = (v: unknown): ProtectionMode => (v === "strict" || v === "off" ? v : "auto");

/** The per-network share and the quarantine log cap, for an account's standing (UNCLAIMED_<NAME> first). Unset = off. */
export function protectionCaps(env: object, standing: Standing) {
  return {
    perNetwork: standingCap(env, standing, "MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY", Number.POSITIVE_INFINITY),
    quarantinedPerDay: standingCap(env, standing, "MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY", Number.POSITIVE_INFINITY),
  };
}

/** SPIKE_MIN_EVENTS (default 1000; "0" = never a spike). */
export const spikeMin = (env: { SPIKE_MIN_EVENTS?: string }) => capVar(env.SPIKE_MIN_EVENTS, SPIKE_MIN);

/** SPIKE_MIN_NETWORKS (default 20; "0" = any number of networks). */
export const spikeMinNetworks = (env: { SPIKE_MIN_NETWORKS?: string }) => {
  const n = capVar(env.SPIKE_MIN_NETWORKS, SPIKE_MIN_NETWORKS);
  return Number.isFinite(n) ? n : 0;
};

/** Hits in one window that make a spike, given the usual hits per window. */
export const spikeThreshold = (perWindow: number, min: number) => Math.max(Math.ceil(SPIKE_FACTOR * perWindow), min);

/** auto: attack measures only while under attack; strict: always; off: never (detection and reporting still run). */
export const measuresOn = (mode: ProtectionMode, state: ProtectionState) =>
  mode === "strict" || (mode === "auto" && state === "under_attack");

/** The episode as of `now`: under_attack / contained end ATTACK_COOLDOWN_MS after the last trigger; ended is shown for 24 h. */
export function effectiveProtection(s: StoredProtection | null, now: number): StoredProtection | null {
  if (!s) return null;
  let v = s;
  if (v.state !== "ended" && now - v.last_seen_at >= ATTACK_COOLDOWN_MS)
    v = { ...v, state: "ended", ended_at: v.last_seen_at + ATTACK_COOLDOWN_MS };
  if (v.state === "ended" && now - (v.ended_at ?? v.last_seen_at) >= ENDED_VISIBLE_MS) return null;
  return v;
}

export const isActive = (s: ProtectionState) => s === "under_attack" || s === "contained";

/**
 * The keyed hash a network is counted by: HMAC over the container id, the UTC day and the network
 * (IPv4 address or IPv6 /48), with a key derived from ENCRYPTION_KEY (INTERNAL_TOKEN without it).
 * It changes every day and per container, so the stored value can't be joined across days or
 * containers, and without the key it can't be reversed by trying every address.
 */
let derived: { secret: string; key: Promise<CryptoKey> } | null = null;
const enc = new TextEncoder();
function networkKeyFor(secret: string): Promise<CryptoKey> {
  if (derived?.secret !== secret)
    derived = {
      secret,
      key: hmacSha256Hex(secret, "afs-tags/network-share/v1").then((sub) =>
        crypto.subtle.importKey("raw", enc.encode(sub), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      ),
    };
  return derived.key;
}

export async function networkHash(
  env: { ENCRYPTION_KEY?: string; INTERNAL_TOKEN?: string },
  containerId: string,
  day: string,
  network: string,
): Promise<string> {
  // ENCRYPTION_KEY is a required secret; the constant only keeps a bare dev setup working.
  const secret = env.ENCRYPTION_KEY || env.INTERNAL_TOKEN || "afs-tags-dev-network-share";
  const sig = await crypto.subtle.sign("HMAC", await networkKeyFor(secret), enc.encode(`${containerId}|${day}|${network}`));
  return [...new Uint8Array(sig).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The network operator (autonomous system) the hit came from, from Cloudflare (request.cf).
 * Behind the container's own first-party proxy (trusted), cf describes the proxy, not the visitor,
 * so it's unknown. With DEV_MODE=true, x-afs-dev-asn / x-afs-dev-as-org stand in (local dev and tests).
 */
export function networkOperator(req: Request, trustedProxy: boolean, dev: boolean): { asn?: number; as_org?: string } {
  if (dev) {
    const h = req.headers.get("x-afs-dev-asn");
    if (h && /^\d{1,10}$/.test(h)) return { asn: Number(h), as_org: req.headers.get("x-afs-dev-as-org")?.slice(0, 100) || undefined };
  }
  if (trustedProxy) {
    // The network a trusted proxy or the platform's edge forwarded (x-afs-geo-asn), else none: cf describes the proxy.
    const asn = req.headers.get("x-afs-geo-asn");
    if (!asn || !/^\d{1,10}$/.test(asn)) return {};
    let org: string | undefined;
    try {
      org = decodeURIComponent(req.headers.get("x-afs-geo-as-org") ?? "").slice(0, 100) || undefined;
    } catch {
      org = undefined;
    }
    return { asn: Number(asn), as_org: org };
  }
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  return {
    asn: typeof cf.asn === "number" ? cf.asn : undefined,
    as_org: typeof cf.asOrganization === "string" && cf.asOrganization ? cf.asOrganization.slice(0, 100) : undefined,
  };
}

/** Only strict holds browser conversions; under attack only quarantined traffic's conversions are set aside. */
export const HELD_STRICT =
  "held: protection is strict, so browser conversions aren't forwarded server-side (send them from your backend: POST /v1/containers/:id/events)";

/** What an agent or the owner can do next about the container's protection. Absolute URLs (they go into emails). */
export function protectionNextSteps(base: string, id: string, v: ProtectionView): string[] {
  const u = `${base}/v1/containers/${id}`;
  const review = `Review what was set aside: GET ${u}/quarantine (MCP get_quarantine): counts by reason and day, networks (ASN), countries and pages.`;
  const backend = `Conversions your backend sends (POST ${u}/events, API key) are always delivered; send the ones that matter from there.`;
  const steps: string[] = [];
  if (isActive(v.state)) {
    steps.push(review);
    if (v.mode !== "off")
      steps.push(
        v.measures.browser_conversions_held
          ? `protection is strict, so browser conversions aren't forwarded to ad platforms. ${backend}`
          : `Conversions from quarantined traffic (networks over their share${v.measures.datacenter_quarantine ? ", data-centre networks while under attack" : ""}) aren't forwarded to ad platforms; conversions from every other network keep flowing. The episode ends ${ATTACK_COOLDOWN_MS / 60_000} minutes after the last trigger. ${backend}`,
      );
    steps.push(
      `If it's real traffic: PATCH ${u} { "protection": "off" }. Quarantined hits were never sent to destinations and can't be released later (a delivery can't safely be made after the fact).`,
    );
    if (v.mode !== "strict")
      steps.push(
        `Stricter: PATCH ${u} { "protection": "strict" } quarantines data-centre traffic and holds every browser conversion all the time.`,
      );
  } else if (v.state === "ended") {
    steps.push(`The episode ended at ${new Date(v.ended_at ?? 0).toISOString()}; nothing is set aside now. ${review}`);
  } else if (v.mode === "strict") {
    steps.push(
      `protection is strict: data-centre traffic is quarantined and browser conversions are never forwarded server-side. ${backend} PATCH ${u} { "protection": "auto" } applies these only during an attack.`,
    );
  } else if (v.mode === "off") {
    steps.push(
      `protection is off: no network share and no attack measures (detection still runs). PATCH ${u} { "protection": "auto" } turns them back on.`,
    );
  }
  if (!isActive(v.state) && v.quarantined_today > 0 && v.state !== "ended") steps.push(review);
  return steps;
}

/** The container's entry in GET /v1/usage `attacks`, or null when there's nothing to report. */
export function attackItem(base: string, id: string, label: string, v: ProtectionView): AttackItem | null {
  if (v.state === "none" || v.since === null || v.last_seen_at === null) return null;
  return {
    service: "tags",
    resource_id: id,
    resource_label: label,
    state: v.state,
    mode: v.mode,
    since: v.since,
    last_seen_at: v.last_seen_at,
    ended_at: v.state === "ended" ? v.ended_at : null,
    reasons: v.reasons,
    quarantined: v.quarantined,
    next_steps: protectionNextSteps(base, id, v),
  };
}
