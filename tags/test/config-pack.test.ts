import { describe, expect, it } from "vitest";
import { bundleRuntime } from "../scripts/build-runtime.mjs";
import type { ContainerConfig } from "../src/config/schema";
import { parseConfig, validateConfig } from "../src/config/validate";
import { matchCondition } from "../src/lib/conditions";
import { customCodeIn, stripCustomCode } from "../src/service/verify";

const codes = (r: { errors: { code: string }[]; warnings: { code: string }[] }) => ({
  errors: r.errors.map((e) => e.code),
  warnings: r.warnings.map((w) => w.code),
});

describe("validation of the variable, trigger and tag packs", () => {
  it("checks variable references, cycles, regexes and param sets", () => {
    const r = validateConfig({
      variables: [
        { name: "a", type: "lookup", input: "b", map: {} },
        { name: "b", type: "regex_table", input: "a", rows: [{ pattern: "(", output: 1 }] },
        { name: "u", type: "url", component: "param" },
        { name: "x", type: "lookup", input: "nope", map: {} },
        { name: "c", type: "constant", value: 1 },
      ],
      triggers: [{ id: "all", type: "page_view" }],
      tags: [{ id: "g", type: "ga4", params: { measurement_id: "G-ABC123XYZ", event_params_from: "c" }, triggers: ["all"] }],
    });
    expect(codes(r).errors).toEqual(
      expect.arrayContaining(["variable_cycle", "invalid_regex", "missing_param", "undefined_variable", "not_a_param_set"]),
    );
  });

  it("checks custom events, trigger groups, scroll thresholds, numeric ops and css-selector vars", () => {
    const r = validateConfig({
      triggers: [
        { id: "both", type: "custom_event", event: "a", event_regex: "a" },
        { id: "neither", type: "custom_event" },
        { id: "grp", type: "trigger_group", triggers: ["both", "missing"] },
        { id: "grp2", type: "trigger_group", triggers: ["grp", "both"] },
        { id: "sc", type: "scroll_depth" },
        { id: "n", type: "page_view", conditions: [{ var: "page_path", op: "gt", value: "abc" }] },
        { id: "css", type: "click", conditions: [{ var: "click_text", op: "matches_css_selector", value: ".x" }] },
        { id: "w", type: "click", wait_for_tags_ms: 500 },
      ],
      tags: [{ id: "t", type: "custom_js", params: { code: "1" }, triggers: ["both", "neither", "grp", "grp2", "sc", "n", "css", "w"] }],
    });
    const c = codes(r);
    expect(c.errors.filter((e) => e === "custom_event_name")).toHaveLength(2);
    expect(c.errors).toEqual(expect.arrayContaining(["undefined_trigger", "nested_trigger_group", "scroll_thresholds", "not_a_number"]));
    expect(c.warnings).toEqual(expect.arrayContaining(["css_selector_needs_element", "wait_for_tags_links"]));
  });

  it("checks tag sequencing, schedules, consent_init use and cross-domain hosts", () => {
    const r = validateConfig(
      {
        triggers: [
          { id: "ci", type: "consent_init" },
          { id: "all", type: "page_view" },
        ],
        tags: [
          { id: "a", type: "custom_js", params: { code: "1" }, triggers: ["all"], after: { tag: "b" } },
          { id: "b", type: "custom_js", params: { code: "1" }, triggers: ["all"], after: { tag: "a" } },
          { id: "c", type: "custom_js", params: { code: "1" }, triggers: ["all"], after: { tag: "zzz" } },
          { id: "old", type: "custom_js", params: { code: "1" }, triggers: ["all"], schedule: { end: 1 } },
          { id: "bad", type: "custom_js", params: { code: "1" }, triggers: ["all"], schedule: { start: 5, end: 2 } },
          { id: "ga", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["ci"] },
        ],
        settings: { cross_domain: ["checkout.example.net", "sub.shop.test"] },
      },
      { domain: "shop.test", allowed_hostnames: [] },
    );
    const c = codes(r);
    expect(c.errors).toEqual(expect.arrayContaining(["sequence_cycle", "undefined_tag", "schedule_invalid"]));
    expect(c.warnings).toEqual(expect.arrayContaining(["schedule_expired", "consent_init_non_cmp", "cross_domain_not_allowed"]));
    expect(r.warnings.filter((w) => w.code === "cross_domain_not_allowed")).toHaveLength(1);
  });

  it("accepts snap_pixel, image_pixel (no template in the host), user_data auto and remarketing", () => {
    const ok = parseConfig({
      triggers: [{ id: "p", type: "custom_event", event: "purchase" }],
      tags: [
        { id: "s", type: "snap_pixel", params: { pixel_id: "6f5c0b3e-4a2d-4c1b-9e8f-1a2b3c4d5e6f" }, triggers: ["p"] },
        { id: "i", type: "image_pixel", params: { url: "https://px.example.net/i?o={{order}}" }, triggers: ["p"] },
      ],
      conversions: [
        {
          name: "purchase",
          trigger: "p",
          user_data: "auto",
          send_to: { snap: { event_name: "PURCHASE" }, google_ads: { remarketing: true } },
        },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(parseConfig({ tags: [{ id: "i", type: "image_pixel", params: { url: "https://{{host}}/i" }, triggers: ["p"] }] }).ok).toBe(
      false,
    );
    expect(parseConfig({ tags: [{ id: "i", type: "image_pixel", params: { url: "javascript:alert(1)" }, triggers: ["p"] }] }).ok).toBe(
      false,
    );
  });
});

describe("condition operators", () => {
  it("numeric and css-selector matching", () => {
    expect(matchCondition("150", "gt", 100)).toBe(true);
    expect(matchCondition("abc", "gt", 1)).toBe(false);
    expect(matchCondition(5, "lte", "5")).toBe(true);
    const el = { matches: (s: string) => s === ".buy" };
    expect(matchCondition(el, "matches_css_selector", ".buy")).toBe(true);
    expect(matchCondition(el, "not_matches_css_selector", ".buy")).toBe(false);
    expect(matchCondition("text", "matches_css_selector", ".buy")).toBe(false);
  });
});

describe("custom_js variables are custom code", () => {
  it("are counted, gated and stripped like custom-code tags", () => {
    const cfg: ContainerConfig = {
      variables: [
        { name: "x", type: "custom_js", code: "return 1" },
        { name: "y", type: "constant", value: 1 },
      ],
    };
    expect(customCodeIn(cfg, {})).toEqual({ paths: ["variables.0"], bytes: 8 });
    expect(stripCustomCode(cfg, {}).variables).toEqual([{ name: "y", type: "constant", value: 1 }]);
  });
});

async function gzipBytes(s: string) {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

describe("runtime size budget", () => {
  // The core bundle every container loads, and the extension bundle (video, js_error,
  // wait_for_tags, cross-domain, TCF, user_data auto) served only to configs that use it.
  // Raised from ~41.7 KB / 15.1 KB gzip (before the GTM parity work) for the variable and trigger
  // packs, the preview log, tag sequencing, scheduling and telemetry. Raise again only with a reason.
  it("stays within budget", async () => {
    const core = await bundleRuntime();
    const ext = await bundleRuntime({ ext: true });
    expect(core.length).toBeLessThanOrEqual(56_000);
    expect(await gzipBytes(core)).toBeLessThanOrEqual(20_000);
    expect(ext.length).toBeLessThanOrEqual(64_000);
    expect(await gzipBytes(ext)).toBeLessThanOrEqual(23_000);
  });
});
