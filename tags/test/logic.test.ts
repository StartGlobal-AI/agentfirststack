import { describe, expect, it } from "vitest";
import { matchCondition } from "../src/lib/conditions";
import { applyConsentUpdate, initialConsent } from "../src/lib/consent";
import { mergePatch } from "../src/lib/merge-patch";
import { activeClickIds, mergeVisitor } from "../src/service/identity";
import { cleanClickIds, parseTimestamp, serverEventId } from "../src/service/ingest";

describe("JSON merge patch (RFC 7396 appendix A)", () => {
  const cases: [unknown, unknown, unknown][] = [
    [{ a: "b" }, { a: "c" }, { a: "c" }],
    [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
    [{ a: "b" }, { a: null }, {}],
    [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
    [{ a: ["b"] }, { a: "c" }, { a: "c" }],
    [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
    [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
    [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
    [
      ["a", "b"],
      ["c", "d"],
      ["c", "d"],
    ],
    [{ a: "b" }, ["c"], ["c"]],
    [{ a: "foo" }, null, null],
    [{ a: "foo" }, "bar", "bar"],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: "b", c: null }, { a: "b" }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];
  it.each(cases)("%j + %j", (target, patch, expected) => {
    expect(mergePatch(target, patch)).toEqual(expected);
  });
  it("does not mutate the target", () => {
    const t = { a: { b: 1 } };
    mergePatch(t, { a: { b: 2 } });
    expect(t.a.b).toBe(1);
  });
});

describe("trigger conditions", () => {
  it("each op and its negation", () => {
    expect(matchCondition("/thank-you/order", "starts_with", "/thank-you")).toBe(true);
    expect(matchCondition("/thank-you/order", "not_starts_with", "/thank-you")).toBe(false);
    expect(matchCondition("/a/b", "ends_with", "/b")).toBe(true);
    expect(matchCondition("/a/b", "not_ends_with", "/b")).toBe(false);
    expect(matchCondition("Buy now", "contains", "now")).toBe(true);
    expect(matchCondition("Buy now", "not_contains", "now")).toBe(false);
    expect(matchCondition("purchase", "equals", "purchase")).toBe(true);
    expect(matchCondition("purchase", "not_equals", "purchase")).toBe(false);
    expect(matchCondition("/order/123/done", "matches_regex", "^/order/\\d+/done$")).toBe(true);
    expect(matchCondition("/order/x/done", "not_matches_regex", "^/order/\\d+/done$")).toBe(true);
  });
  it("ignore_case, numbers, empty values and bad regexes", () => {
    expect(matchCondition("BUY NOW", "contains", "buy", true)).toBe(true);
    expect(matchCondition("BUY NOW", "contains", "buy")).toBe(false);
    expect(matchCondition("ABC", "matches_regex", "^abc$", true)).toBe(true);
    expect(matchCondition(49.5, "equals", "49.5")).toBe(true);
    expect(matchCondition(undefined, "equals", "")).toBe(true);
    expect(matchCondition(undefined, "contains", "x")).toBe(false);
    expect(matchCondition("x", "matches_regex", "(")).toBe(false);
  });
});

describe("consent", () => {
  const cfg = {
    mode: "none" as const,
    regions: {
      EEA: { ad_storage: "denied" as const },
      "US-CA": { ad_personalization: "denied" as const },
      GB: { analytics_storage: "denied" as const },
    },
  };
  it("mode baseline, region specificity", () => {
    expect(initialConsent({ mode: "opt_in" }).ad_storage).toBe("denied");
    expect(initialConsent({ mode: "opt_out" }).ad_storage).toBe("granted");
    expect(initialConsent(cfg, "DE").ad_storage).toBe("denied");
    expect(initialConsent(cfg, "US", "CA").ad_personalization).toBe("denied");
    expect(initialConsent(cfg, "US", "NY").ad_personalization).toBe("granted");
    expect(initialConsent(cfg, "GB").analytics_storage).toBe("denied");
    expect(initialConsent(cfg, "GB").ad_storage).toBe("granted");
  });
  it("v1-style updates carry ad_user_data/ad_personalization along with ad_storage", () => {
    const s = applyConsentUpdate(initialConsent({ mode: "opt_in" }), { ad_storage: "granted" });
    expect(s.ad_user_data).toBe("granted");
    expect(s.ad_personalization).toBe("granted");
    const t = applyConsentUpdate(s, { ad_storage: "granted", ad_personalization: "denied" });
    expect(t.ad_personalization).toBe("denied");
  });
});

describe("identity", () => {
  it("merges click ids (newest wins), keeps first touch, accumulates hashes", () => {
    let v = mergeVisitor(
      null,
      { click_ids: { gclid: "g1" }, first_touch: { utm_source: "google" }, user: { em: "a".repeat(64) }, visit: true },
      1000,
    );
    v = mergeVisitor(
      v,
      { click_ids: { gclid: "g2", fbclid: "f1" }, first_touch: { utm_source: "meta" }, user: { ph: "b".repeat(64) }, visit: true },
      2000,
    );
    expect(v.click_ids.gclid).toEqual({ v: "g2", ts: 2000 });
    expect(v.first_touch).toEqual({ utm_source: "google" });
    expect(v.user.em).toBe("a".repeat(64));
    expect(v.user.ph).toBe("b".repeat(64));
    expect(v.visits).toBe(2);
    expect(activeClickIds(v, 2000 + 91 * 86_400_000)).toEqual({});
    expect(activeClickIds(v, 3000)).toEqual({ gclid: "g2", fbclid: "f1" });
  });
  it("server event ids are deterministic per name + order id", () => {
    expect(serverEventId({ name: "purchase", order_id: "T 1/2" }, () => "r")).toBe("purchase.T_1_2");
    expect(serverEventId({ name: "purchase", event_id: "abc123" }, () => "r")).toBe("abc123");
    expect(serverEventId({ name: "lead" }, () => "rand")).toBe("srv_rand");
  });
  it("click id cleaning and timestamps", () => {
    expect(cleanClickIds({ GCLID: "abc_123", sccid: "xyz-1", bogus: "x", fbclid: "<script>" })).toEqual({
      gclid: "abc_123",
      ScCid: "xyz-1",
    });
    expect(parseTimestamp(1700000000, 0)).toBe(1700000000000);
    expect(parseTimestamp("2026-01-01T00:00:00Z", 0)).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });
});
