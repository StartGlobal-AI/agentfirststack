import { describe, expect, it } from "vitest";
import {
  CONSENT_EXAMPLE,
  CONVERSION_EXAMPLE,
  FULL_EXAMPLE,
  schemaDocument,
  TAG_EXAMPLES,
  TRIGGER_EXAMPLES,
  VARIABLE_EXAMPLES,
} from "../src/config/catalog";
import {
  conversionSchema,
  consentSchema,
  tagSchema,
  TAG_TYPES,
  triggerSchema,
  TRIGGER_TYPES,
  variableSchema,
  VARIABLE_TYPES,
} from "../src/config/schema";
import { parseConfig, validateConfig } from "../src/config/validate";

const codes = (r: { errors: { code: string }[]; warnings: { code: string }[] }) => ({
  errors: r.errors.map((e) => e.code),
  warnings: r.warnings.map((w) => w.code),
});

describe("catalog", () => {
  it("has a valid example for every variable, trigger and tag type", () => {
    for (const t of VARIABLE_TYPES) expect(variableSchema.safeParse(VARIABLE_EXAMPLES[t].example).success, t).toBe(true);
    for (const t of TRIGGER_TYPES) expect(triggerSchema.safeParse(TRIGGER_EXAMPLES[t].example).success, t).toBe(true);
    for (const t of TAG_TYPES) expect(tagSchema.safeParse(TAG_EXAMPLES[t].example).success, t).toBe(true);
    expect(conversionSchema.safeParse(CONVERSION_EXAMPLE).success).toBe(true);
    expect(consentSchema.safeParse(CONSENT_EXAMPLE).success).toBe(true);
  });
  it("full example has no errors", () => {
    const r = validateConfig(FULL_EXAMPLE, { destinations: [{ id: "d1", type: "meta", enabled: true }] });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });
  it("serves JSON Schema with every top-level section", () => {
    const doc = schemaDocument();
    const props = (doc.json_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["consent", "conversions", "settings", "tags", "triggers", "variables"]);
    expect(Object.keys(doc.destinations).sort()).toEqual(["analytics", "ga4", "google_ads", "meta", "tiktok", "webhook"]);
    expect(JSON.stringify(doc)).toContain("measurement_id");
  });
});

describe("structural validation", () => {
  it("rejects unknown keys and bad ids with paths", () => {
    const r = parseConfig({ tags: [{ id: "ga4", type: "ga4", params: { measurement_id: "UA-1" }, trigger: ["x"] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.errors.map((e) => e.path);
      expect(paths.some((p) => p.startsWith("tags.0"))).toBe(true);
      expect(r.errors.every((e) => e.hint.length > 0)).toBe(true);
    }
  });
  it("rejects unknown tag types", () => {
    expect(parseConfig({ tags: [{ id: "x", type: "hotjar", params: {}, triggers: ["a"] }] }).ok).toBe(false);
  });
});

describe("semantic validation", () => {
  const base = {
    triggers: [{ id: "all_pages", type: "page_view" }],
    tags: [{ id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] }],
  };
  it("flags triggers referenced but undefined", () => {
    const r = validateConfig({ ...base, tags: [{ ...base.tags[0], triggers: ["nope"] }] });
    expect(codes(r).errors).toContain("undefined_trigger");
    expect(r.valid).toBe(false);
  });
  it("flags undefined variables, invalid regexes and duplicates", () => {
    const r = validateConfig({
      triggers: [
        {
          id: "t",
          type: "page_view",
          conditions: [
            { var: "nope", op: "equals", value: "x" },
            { var: "page_path", op: "matches_regex", value: "(" },
          ],
        },
        { id: "t", type: "dom_ready" },
      ],
    });
    expect(codes(r).errors).toEqual(expect.arrayContaining(["undefined_variable", "invalid_regex", "duplicate"]));
  });
  it("flags placeholder pixel ids", () => {
    const r = validateConfig({
      ...base,
      tags: [{ id: "ga4", type: "ga4", params: { measurement_id: "G-XXXXXXX" }, triggers: ["all_pages"] }],
    });
    expect(codes(r).errors).toContain("placeholder_id");
  });
  it("conversions without value/currency", () => {
    const r = validateConfig({
      ...base,
      variables: [{ name: "v", type: "data_layer", key: "ecommerce.value" }],
      triggers: [...base.triggers, { id: "p", type: "custom_event", event: "purchase" }],
      conversions: [
        { name: "purchase", trigger: "p", send_to: { meta: { event_name: "Purchase" } } },
        { name: "order_two", trigger: "p", value: "v", send_to: { meta: { event_name: "Lead" } } },
      ],
    });
    expect(codes(r).warnings).toEqual(expect.arrayContaining(["missing_value", "missing_currency"]));
    expect(codes(r).errors).toContain("meta_purchase_requires_value");
  });
  it("server conversions with no destination of that type, and idle destinations", () => {
    const cfg = {
      ...base,
      triggers: [...base.triggers, { id: "p", type: "custom_event", event: "lead" }],
      conversions: [
        { name: "lead", trigger: "p", send_to: { meta: { event_name: "Lead" }, tiktok: { event_name: "SubmitForm" } }, server: true },
      ],
    };
    const r = validateConfig(cfg, { destinations: [{ id: "d_ga4", type: "ga4", enabled: true }] });
    const w = codes(r).warnings;
    expect(w).toContain("server_without_destination");
    expect(w).toContain("no_route"); // tiktok: no tag, no destination
    expect(w).toContain("destination_idle"); // ga4 destination gets nothing
    const ok = validateConfig(cfg, {
      destinations: [
        { id: "d", type: "meta", enabled: true },
        { id: "t", type: "tiktok", enabled: true },
      ],
    });
    expect(codes(ok).warnings).not.toContain("server_without_destination");
  });
  it("consent gaps", () => {
    expect(codes(validateConfig(base)).warnings).toContain("consent_not_configured");
    const eea = validateConfig({ ...base, consent: { mode: "none", regions: { EEA: { ad_storage: "denied" } } } });
    expect(codes(eea).warnings).toEqual(expect.arrayContaining(["consent_needs_banner", "consent_uk"]));
    const optIn = validateConfig({ ...base, consent: { mode: "opt_in" }, tags: [{ ...base.tags[0], consent: [] }] });
    expect(codes(optIn).warnings).toContain("consent_gap");
  });
  it("Google Ads double counting and missing labels", () => {
    const r = validateConfig(
      {
        triggers: [
          { id: "all_pages", type: "page_view" },
          { id: "p", type: "custom_event", event: "purchase" },
        ],
        tags: [{ id: "g", type: "google_ads", params: { conversion_id: "AW-123456789" }, triggers: ["all_pages"] }],
        conversions: [
          {
            name: "purchase",
            trigger: "p",
            value: 1,
            currency: "USD",
            send_to: { google_ads: { send_to: "AW-123456789/AbCdEf" } },
            server: true,
          },
        ],
      },
      { destinations: [{ id: "d", type: "google_ads", enabled: true }] },
    );
    expect(codes(r).warnings).toContain("google_ads_double_count");
  });
});
