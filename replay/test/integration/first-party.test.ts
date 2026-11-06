import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { geo, visitorIp } from "../../src/service/ingest";

/**
 * First-party domains: the platform's edge (edge.example.com/_r/*, forwarded by the site Worker
 * over a service binding with INTERNAL_TOKEN and x-afs-edge-host) is the only caller whose
 * X-Forwarded-For and x-afs-geo-* replay uses; everyone else gets cf-connecting-ip and request.cf.
 */
describe("replay behind the platform's edge", () => {
  const TOKEN = "replay-edge-token";
  const edgeEnv = { INTERNAL_TOKEN: TOKEN };
  const headers = {
    "cf-connecting-ip": "203.0.113.5",
    "x-forwarded-for": "198.51.100.9",
    "x-afs-edge-host": "edge.shop.test",
    "x-afs-geo-country": "fr",
    "x-afs-geo-region": "Auvergne-Rh%C3%B4ne-Alpes",
    "x-afs-geo-city": "Lyon",
  };

  it("uses the edge's visitor IP and geo, only over a service binding with the right token", () => {
    const edge = new Request("https://replay.internal/_r/i?s=x", { headers: { ...headers, "x-afs-internal": TOKEN } });
    expect(visitorIp(edge, edgeEnv)).toBe("198.51.100.9");
    expect(geo(edge, false, edgeEnv)).toEqual({ country: "FR", region: "Auvergne-Rhône-Alpes", city: "Lyon" });
    for (const req of [
      new Request("https://replay.internal/_r/i", { headers: { ...headers, "x-afs-internal": "wrong" } }),
      new Request("https://replay.example.com/_r/i", { headers: { ...headers, "x-afs-internal": TOKEN } }),
      new Request("https://replay.internal/_r/i", { headers }),
    ]) {
      expect(visitorIp(req, edgeEnv)).toBe("203.0.113.5");
      expect(geo(req, false, edgeEnv).country).toBeNull();
    }
    expect(visitorIp(edge, {})).toBe("203.0.113.5"); // no INTERNAL_TOKEN on this deployment: no edge
  });

  it("serves the loader under the edge's /_r prefix", async () => {
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("https://replay.internal/_r/r/rsite_0000000000000000.js", {
      headers: { ...headers, "x-afs-internal": env.INTERNAL_TOKEN ?? TOKEN },
    });
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("unknown replay site");
  });
});
