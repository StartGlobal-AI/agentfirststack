/**
 * Attack protection inside a site's Durable Object (the vocabulary is @afs/shared protection.ts).
 *
 *  - A network's daily share: each browser event bumps its network's row in net_daily (one upsert,
 *    keyed by a hash the Worker computed that rotates daily). Past the share, the network's events
 *    are quarantined for the rest of the UTC day, and the site's episode opens as "contained".
 *  - Spikes: accepted browser events are counted per 15-minute window in memory; a window with at
 *    least max(SPIKE_FACTOR x the usual rate, SPIKE_MIN_EVENTS) marks the site under attack. The
 *    usual rate is the average per 15 minutes over the previous 7 UTC days the site existed, from
 *    the daily usage counters (computed once a day).
 *  - Under attack (protection auto), and always with protection strict, browser events from
 *    data-centre networks are quarantined too. A viral spike from residential networks is not.
 *  - An episode ends ATTACK_COOLDOWN_MS after its last trigger (a spiking window, or a network
 *    over its share) and is reported as ended for 24 hours after that.
 *
 * The episode lives in memory and is written to meta('protection') when it changes state, and at
 * most every 10 seconds otherwise, so a flood costs no extra write per event; what an eviction
 * loses is a few seconds of counts.
 */

import { ATTACK_COOLDOWN_MS, type AttackReason, type ProtectionMode, SPIKE_FACTOR, SPIKE_WINDOW_MS, isDatacenterAsn } from "@afs/shared";
import type { EnrichedEvent, IngestOutcome, QuarantineReason } from "../lib/types";
import { DAY, type Db, num, utcDay } from "./common";
import { usageOn } from "./engine";

/** An ended episode is still reported (GET /v1/usage attacks, get_site) this long after it ended. */
export const ENDED_SHOWN_MS = 24 * 3_600_000;
/** Windows in a day, for the usual rate per window. */
const WINDOWS_PER_DAY = DAY / SPIKE_WINDOW_MS;
/** Days of history the usual rate is taken from. */
const BASELINE_DAYS = 7;
/** Counts that move without a state change are written at most this often. */
const PERSIST_EVERY_MS = 10_000;

export type ProtectionState = "under_attack" | "contained" | "ended" | "none";

interface Episode {
  state: "under_attack" | "contained";
  since: number;
  last_seen_at: number;
  /** set once the cooldown has passed */
  ended_at: number | null;
  reasons: { kind: AttackReason; detail: string }[];
  /** events quarantined in this episode, on quarantined_day (a new UTC day starts again from 0) */
  quarantined: number;
  quarantined_day: string;
}

interface Persisted {
  /** the latest episode, ongoing or ended */
  episode: Episode | null;
  /** today's networks: the busiest one's events, and how many passed their share */
  net: { day: string; max: number; over: number };
}

/** What get_site, get_usage and the quarantine view show. */
export interface ProtectionView {
  mode: ProtectionMode;
  state: ProtectionState;
  since: number | null;
  last_seen_at: number | null;
  ended_at: number | null;
  reasons: { kind: AttackReason; detail: string }[];
  /** events quarantined in the episode (today's when it spans days) */
  quarantined: number;
  /** every event quarantined today (UTC), episode or not (strict quarantines data centres without one) */
  quarantined_today: number;
  /** browser events today from the site's busiest network, and the networks past their share */
  busiest_network_today: number;
  networks_over_share_today: number;
}

export interface ClassifyContext {
  mode: ProtectionMode;
  /** the network's share (Infinity = no share: nothing is counted) */
  share: number;
  now: number;
}

export interface AfterIngestContext {
  mode: ProtectionMode;
  spikeMin: number;
  /** the site's creation time: days before it don't count towards the usual rate */
  createdAt: number;
  now: number;
}

const META_KEY = "protection";

export class Guard {
  private p: Persisted | null = null;
  private dirty = false;
  private writtenAt = 0;
  private window = { start: 0, count: 0 };
  private baseline = { day: "", perWindow: 0 };
  private prunedDay = "";
  /** today's networks past their share (net hashes; the hash itself changes every day) */
  private over = { day: "", nets: new Set<string>() };

  constructor(private readonly db: Db) {}

  private load(): Persisted {
    if (this.p) return this.p;
    let p: Persisted = { episode: null, net: { day: "", max: 0, over: 0 } };
    try {
      const raw = this.db.all("SELECT value FROM meta WHERE key = ?", [META_KEY])[0]?.value;
      if (raw) p = { ...p, ...(JSON.parse(String(raw)) as Partial<Persisted>) };
    } catch {
      // unreadable: start clean
    }
    this.p = p;
    return p;
  }

  /** Write the state now (`force`), or when counts moved and the last write is 10 s old. */
  private save(now: number, force = false): void {
    if (!this.p || (!force && (!this.dirty || now - this.writtenAt < PERSIST_EVERY_MS))) return;
    this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      META_KEY,
      JSON.stringify(this.p),
    ]);
    this.dirty = false;
    this.writtenAt = now;
  }

  /** Write pending counts (before a read, the daily alarm). */
  flush(now = Date.now()): void {
    if (this.dirty) this.save(now, true);
  }

  /** The ongoing episode, or null (an episode past its cooldown is closed here). */
  private active(now: number): Episode | null {
    const ep = this.load().episode;
    if (!ep || ep.ended_at !== null) return null;
    if (now - ep.last_seen_at < ATTACK_COOLDOWN_MS) return ep;
    ep.ended_at = ep.last_seen_at + ATTACK_COOLDOWN_MS;
    this.save(now, true);
    return null;
  }

  private netToday(day: string): Persisted["net"] {
    const p = this.load();
    if (p.net.day !== day) p.net = { day, max: 0, over: 0 };
    return p.net;
  }

  /** Something suspicious happened: open an episode, or keep the ongoing one alive. */
  private trigger(kind: AttackReason, detail: string, now: number): void {
    const ep = this.active(now);
    if (!ep) {
      this.load().episode = {
        state: kind === "spike" ? "under_attack" : "contained",
        since: now,
        last_seen_at: now,
        ended_at: null,
        reasons: [{ kind, detail }],
        quarantined: 0,
        quarantined_day: utcDay(now),
      };
      this.save(now, true);
      return;
    }
    let changed = false;
    if (kind === "spike" && ep.state !== "under_attack") {
      ep.state = "under_attack";
      changed = true;
    }
    const r = ep.reasons.find((x) => x.kind === kind);
    if (r) r.detail = detail;
    else {
      ep.reasons.push({ kind, detail });
      changed = true;
    }
    ep.last_seen_at = Math.max(ep.last_seen_at, now);
    this.dirty = true;
    this.save(now, changed);
  }

  /**
   * A browser event that passed the drop checks: quarantine it, or not (null). Runs inside the
   * ingest transaction; the network's counter is the only write (one upsert).
   */
  classify(ev: EnrichedEvent, c: ClassifyContext): QuarantineReason | null {
    if (ev.origin !== "browser") return null;
    const day = utcDay(c.now);
    let reason: QuarantineReason | null = null;
    if (ev.net_hash && Number.isFinite(c.share)) {
      if (this.prunedDay !== day) {
        this.db.run("DELETE FROM net_daily WHERE day < ?", [day]);
        this.prunedDay = day;
      }
      const n = num(
        this.db.all(
          `INSERT INTO net_daily (day, net, events) VALUES (?, ?, 1)
           ON CONFLICT(day, net) DO UPDATE SET events = events + 1 RETURNING events`,
          [day, ev.net_hash],
        )[0]?.events,
      );
      const net = this.netToday(day);
      if (n > net.max) {
        net.max = n;
        this.dirty = true;
      }
      if (n > c.share) {
        if (n - 1 <= c.share) net.over++;
        if (this.over.day !== day) this.over = { day, nets: new Set() };
        this.over.nets.add(ev.net_hash);
        const off = c.mode === "off" ? " (protection is off: not quarantined)" : "; their further events today are quarantined";
        this.trigger(
          "network_share",
          `${net.over} network${net.over === 1 ? "" : "s"} passed ${c.share} browser events today${off}`,
          c.now,
        );
        if (c.mode !== "off") reason = "network_share";
      }
    }
    if (!reason && c.mode !== "off" && isDatacenterAsn(ev.asn)) {
      const ep = this.active(c.now);
      if (c.mode === "strict" || ep?.state === "under_attack") {
        reason = "datacenter";
        if (ep && !ep.reasons.some((r) => r.kind === "datacenter")) {
          ep.reasons.push({
            kind: "datacenter",
            detail:
              c.mode === "strict"
                ? "browser events from data-centre networks are quarantined (protection strict)"
                : "browser events from data-centre networks are quarantined while the site is under attack",
          });
          this.save(c.now, true);
        }
      }
    }
    return reason;
  }

  /** Is this network (its hash for today) past its daily share on this site? Memory only (lost on eviction, which only means it is learned again). */
  overShare(netHash: string, now: number): boolean {
    return this.over.day === utcDay(now) && this.over.nets.has(netHash);
  }

  /** After an ingest: count the episode's quarantined events, and the window for spike detection. */
  afterIngest(events: EnrichedEvent[], results: IngestOutcome[], c: AfterIngestContext): void {
    let accepted = 0;
    let quarantined = 0;
    events.forEach((ev, i) => {
      const r = results[i];
      if (!r?.ok || ev.origin !== "browser") return;
      if (r.quarantined) quarantined += r.engagement ? 0 : 1 + (r.extra_events ?? 0);
      else if (!r.uncounted) accepted += 1 + (r.extra_events ?? 0);
    });
    if (quarantined) {
      const ep = this.active(c.now);
      if (ep) {
        const day = utcDay(c.now);
        if (ep.quarantined_day !== day) {
          ep.quarantined_day = day;
          ep.quarantined = 0;
        }
        ep.quarantined += quarantined;
        this.dirty = true;
      }
    }
    if (accepted) {
      const start = Math.floor(c.now / SPIKE_WINDOW_MS) * SPIKE_WINDOW_MS;
      if (this.window.start !== start) this.window = { start, count: 0 };
      this.window.count += accepted;
      const usual = this.usualPerWindow(c.now, c.createdAt);
      const threshold = Math.max(Math.ceil(SPIKE_FACTOR * usual), c.spikeMin);
      if (this.window.count >= threshold)
        this.trigger(
          "spike",
          `${this.window.count} browser events in ${SPIKE_WINDOW_MS / 60_000} minutes (usual: ${Math.round(usual)}; a spike is ${threshold} or more)${
            c.mode === "off" ? " (protection is off: nothing is quarantined)" : ""
          }`,
          c.now,
        );
    }
    this.save(c.now);
  }

  /** The site's average events per 15 minutes over the previous 7 UTC days it existed (0 without history). */
  private usualPerWindow(now: number, createdAt: number): number {
    const today = utcDay(now);
    if (this.baseline.day === today) return this.baseline.perWindow;
    const first = utcDay(Math.max(createdAt || 0, now - BASELINE_DAYS * DAY));
    const last = utcDay(now - DAY);
    let perWindow = 0;
    if (first <= last) {
      const days = Math.round((Date.parse(last) - Date.parse(first)) / DAY) + 1;
      const n = num(this.db.all("SELECT COALESCE(SUM(events), 0) AS n FROM usage WHERE day >= ? AND day <= ?", [first, last])[0]?.n);
      perWindow = n / (days * WINDOWS_PER_DAY);
    }
    this.baseline = { day: today, perWindow };
    return perWindow;
  }

  view(mode: ProtectionMode, now = Date.now()): ProtectionView {
    this.active(now); // closes an episode past its cooldown
    const p = this.load();
    const ep = p.episode;
    const day = utcDay(now);
    const net = p.net.day === day ? p.net : { max: 0, over: 0 };
    const base = {
      mode,
      quarantined_today: usageOn(this.db, day).quarantined,
      busiest_network_today: net.max,
      networks_over_share_today: net.over,
    };
    if (!ep || (ep.ended_at !== null && now - ep.ended_at > ENDED_SHOWN_MS))
      return { ...base, state: "none", since: null, last_seen_at: null, ended_at: null, reasons: [], quarantined: 0 };
    const ongoing = ep.ended_at === null;
    return {
      ...base,
      state: ongoing ? ep.state : "ended",
      since: ep.since,
      last_seen_at: ep.last_seen_at,
      ended_at: ep.ended_at,
      reasons: ep.reasons,
      // An ongoing episode that started before today shows today's count.
      quarantined: ongoing && ep.quarantined_day !== day ? 0 : ep.quarantined,
    };
  }
}
