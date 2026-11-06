import { ATTACK_COOLDOWN_MS } from "@afs/shared";
import { describe, expect, it } from "vitest";
import {
  attackItem,
  ENDED_VISIBLE_MS,
  effectiveProtection,
  measuresOn,
  networkHash,
  networkOperator,
  type ProtectionView,
  protectionCaps,
  type StoredProtection,
  spikeMin,
  spikeMinNetworks,
  spikeThreshold,
} from "../src/service/protection";

const T = Date.UTC(2026, 10, 6, 12);
const episode = (over: Partial<StoredProtection> = {}): StoredProtection => ({
  state: "under_attack",
  since: T,
  last_seen_at: T,
  ended_at: null,
  reasons: [{ kind: "spike", detail: "x" }],
  quarantined: 3,
  q_day: "2026-11-06",
  ...over,
});
const view = (over: Partial<ProtectionView> = {}): ProtectionView => ({
  mode: "auto",
  state: "under_attack",
  since: T,
  last_seen_at: T,
  ended_at: null,
  reasons: [{ kind: "spike", detail: "x" }],
  quarantined: 3,
  quarantined_today: 3,
  conversions_held_today: 1,
  measures: { network_share_limit: 1000, datacenter_quarantine: true, browser_conversions_held: false },
  ...over,
});

describe("attack protection: episode state", () => {
  it("under_attack and contained end ATTACK_COOLDOWN_MS after the last trigger, and ended shows for 24 h", () => {
    expect(effectiveProtection(null, T)).toBeNull();
    expect(effectiveProtection(episode(), T + ATTACK_COOLDOWN_MS - 1)?.state).toBe("under_attack");
    const ended = effectiveProtection(episode({ state: "contained" }), T + ATTACK_COOLDOWN_MS);
    expect(ended).toMatchObject({ state: "ended", ended_at: T + ATTACK_COOLDOWN_MS, since: T });
    expect(effectiveProtection(episode(), T + ATTACK_COOLDOWN_MS + ENDED_VISIBLE_MS - 1)?.state).toBe("ended");
    expect(effectiveProtection(episode(), T + ATTACK_COOLDOWN_MS + ENDED_VISIBLE_MS)).toBeNull();
  });

  it("measures: auto only while under attack, strict always, off never", () => {
    expect(measuresOn("auto", "under_attack")).toBe(true);
    expect(measuresOn("auto", "contained")).toBe(false);
    expect(measuresOn("auto", "none")).toBe(false);
    expect(measuresOn("strict", "none")).toBe(true);
    expect(measuresOn("off", "under_attack")).toBe(false);
  });

  it("a spike is SPIKE_FACTOR x the usual rate and at least the floor", () => {
    expect(spikeThreshold(0, 1000)).toBe(1000);
    expect(spikeThreshold(250, 1000)).toBe(2500);
    expect(spikeThreshold(12.3, 5)).toBe(123);
    expect(spikeMin({})).toBe(1000);
    expect(spikeMin({ SPIKE_MIN_EVENTS: "5" })).toBe(5);
    // An attack also needs that many distinct networks in the window (fewer = contained).
    expect(spikeMinNetworks({})).toBe(20);
    expect(spikeMinNetworks({ SPIKE_MIN_NETWORKS: "3" })).toBe(3);
    expect(spikeMinNetworks({ SPIKE_MIN_NETWORKS: "0" })).toBe(0);
  });

  it("the network share and quarantine caps are off when unset and read UNCLAIMED_ first", () => {
    const claimed = { suspended: false, claimed: true };
    const unclaimed = { suspended: false, claimed: false };
    expect(protectionCaps({}, claimed)).toEqual({ perNetwork: Infinity, quarantinedPerDay: Infinity });
    const env = {
      MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "1000",
      UNCLAIMED_MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY: "200",
      MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY: "20000",
    };
    expect(protectionCaps(env, claimed)).toEqual({ perNetwork: 1000, quarantinedPerDay: 20000 });
    expect(protectionCaps(env, unclaimed)).toEqual({ perNetwork: 200, quarantinedPerDay: 20000 });
  });
});

describe("attack protection: the network, as the Worker sees it", () => {
  it("the network hash is keyed, per container and per UTC day, and never contains the address", async () => {
    const env = { ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" };
    const a = await networkHash(env, "ctr_a", "2026-11-06", "203.0.113.5");
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(await networkHash(env, "ctr_a", "2026-11-06", "203.0.113.5")).toBe(a);
    expect(await networkHash(env, "ctr_a", "2026-11-07", "203.0.113.5")).not.toBe(a);
    expect(await networkHash(env, "ctr_b", "2026-11-06", "203.0.113.5")).not.toBe(a);
    expect(await networkHash(env, "ctr_a", "2026-11-06", "203.0.113.6")).not.toBe(a);
    expect(await networkHash({ ENCRYPTION_KEY: "another-key" }, "ctr_a", "2026-11-06", "203.0.113.5")).not.toBe(a);
  });

  it("the network operator comes from request.cf, not behind the container's own proxy; the dev header only in dev", () => {
    const req = (headers: Record<string, string> = {}) => {
      const r = new Request("https://tags.test/collect", { headers });
      Object.defineProperty(r, "cf", { value: { asn: 16509, asOrganization: "Amazon.com, Inc." } });
      return r;
    };
    expect(networkOperator(req(), false, false)).toEqual({ asn: 16509, as_org: "Amazon.com, Inc." });
    expect(networkOperator(req(), true, false)).toEqual({});
    expect(networkOperator(req({ "x-afs-dev-asn": "7922" }), false, false)).toEqual({ asn: 16509, as_org: "Amazon.com, Inc." });
    expect(networkOperator(req({ "x-afs-dev-asn": "7922", "x-afs-dev-as-org": "Comcast" }), true, true)).toEqual({
      asn: 7922,
      as_org: "Comcast",
    });
  });
});

describe("attack protection: the usage contract", () => {
  it("attacks items carry absolute next_steps; nothing to report is null", () => {
    expect(attackItem("https://tags.example", "ctr_x", "shop.test", view({ state: "none", since: null, last_seen_at: null }))).toBeNull();
    const a = attackItem("https://tags.example", "ctr_x", "shop.test", view());
    expect(a).toMatchObject({
      service: "tags",
      resource_id: "ctr_x",
      resource_label: "shop.test",
      state: "under_attack",
      mode: "auto",
      ended_at: null,
      quarantined: 3,
    });
    expect(a!.next_steps.join("\n")).toContain("GET https://tags.example/v1/containers/ctr_x/quarantine");
    expect(a!.next_steps.join("\n")).toContain('PATCH https://tags.example/v1/containers/ctr_x { "protection": "off" }');
    expect(a!.next_steps.join("\n")).toContain('"protection": "strict"');
    expect(a!.next_steps.join("\n")).toMatch(
      /Conversions from quarantined traffic .*data-centre networks while under attack.* aren't forwarded to ad platforms; conversions from every other network keep flowing/,
    );
    const strict = attackItem(
      "https://tags.example",
      "ctr_x",
      "shop.test",
      view({ mode: "strict", measures: { network_share_limit: 1000, datacenter_quarantine: true, browser_conversions_held: true } }),
    );
    expect(strict!.next_steps.join("\n")).toMatch(/protection is strict, so browser conversions aren't forwarded/);
    const ended = attackItem(
      "https://tags.example",
      "ctr_x",
      "shop.test",
      view({
        state: "ended",
        ended_at: T + ATTACK_COOLDOWN_MS,
        measures: { network_share_limit: 1000, datacenter_quarantine: false, browser_conversions_held: false },
      }),
    );
    expect(ended).toMatchObject({ state: "ended", ended_at: T + ATTACK_COOLDOWN_MS });
  });
});
