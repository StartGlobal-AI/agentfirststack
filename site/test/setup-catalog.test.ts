import { describe, expect, it } from "vitest";
import checkSource from "../src/setup-check.ts?raw";
import { SETUP_CATALOG } from "../src/setup-catalog";

describe("the setup catalog", () => {
  it("lists every setup check, so projects set up before it arrived hear about it", () => {
    const checks = new Set([...checkSource.matchAll(/id: "([a-z_]+\.[a-z_.]+)"/g)].map((m) => m[1]!));
    const listed = new Set(SETUP_CATALOG.flatMap((i) => i.checks));
    expect(checks.size).toBeGreaterThan(20);
    expect([...checks].filter((id) => !listed.has(id))).toEqual([]);
  });
});
