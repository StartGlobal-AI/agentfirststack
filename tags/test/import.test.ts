import { describe, expect, it } from "vitest";
import { ImportShapeError, jsonDepth, mapGtmExport } from "../src/config/gtm-import";
import { mergeConfigs } from "../src/config/merge";
import type { ContainerConfig } from "../src/config/schema";
import { parseConfig, validateConfig } from "../src/config/validate";
import { GTM_EXPORT } from "./fixtures/gtm-export";

const names = (items: { gtm: { name: string } }[]) => items.map((i) => i.gtm.name);

describe("GTM import mapping", () => {
  const { config, report } = mapGtmExport(GTM_EXPORT);

  it("produces a valid config and accounts for every tag, trigger and variable", () => {
    expect(parseConfig(config).ok).toBe(true);
    const all = [...report.mapped, ...report.adapted, ...report.unmapped];
    for (const t of GTM_EXPORT.containerVersion.tag) expect(names(all), t.name).toContain(t.name);
    for (const t of GTM_EXPORT.containerVersion.trigger) expect(names(all), t.name).toContain(t.name);
    for (const v of GTM_EXPORT.containerVersion.variable)
      expect(
        names(all).some((n) => n.includes(v.name)),
        v.name,
      ).toBe(true);
    expect(report.container).toBe("GTM-ABC1234");
    for (const u of report.unmapped) expect(u.reason, u.gtm.name).toBeTruthy();
  });

  it("maps tags with their ids, params, triggers and options", () => {
    const tag = (id: string) => config.tags!.find((t) => t.id === id)!;
    expect(tag("google_tag")).toMatchObject({
      type: "ga4",
      params: { measurement_id: "G-ABC123XYZ", config_params: { cookie_prefix: "shop" } },
      triggers: ["all_pages"],
    });
    expect(tag("ga4_purchase")).toMatchObject({
      type: "ga4",
      params: { event_name: "purchase", event_params: { value: "{{dlv_value}}", transaction_id: "{{dlv_order_id}}" } },
      triggers: ["purchase"],
      priority: 5,
    });
    expect(tag("ads_conversion")).toMatchObject({
      type: "google_ads",
      params: { conversion_id: "AW-123456789", conversion_label: "AbCdEfGh", value: "{{dlv_value}}", currency: "USD" },
    });
    expect(tag("ads_conversion").exclude_triggers).toBeUndefined(); // the AMP blocking trigger wasn't importable
    expect(tag("chat_widget")).toMatchObject({ type: "custom_html", consent: ["functionality_storage"] });
    expect(tag("chat_widget").params).toEqual({ html: "<script src='https://chat.example.net/w.js' data-plan='{{url_plan}}'></script>" });
    expect(tag("affiliate_pixel")).toMatchObject({ type: "image_pixel", once_per_page: true, triggers: ["thank_you_pages"] });
    expect(tag("meta_pixel")).toMatchObject({ type: "meta_pixel", params: { pixel_id: "1234567890123456" }, enabled: false });
    expect(tag("engaged_event")).toMatchObject({ triggers: ["engaged"], after: { tag: "google_tag", require_success: true } });
    expect(tag("video_event").schedule).toEqual({ end: 4102444800000 });
  });

  it("maps triggers and variables", () => {
    const trig = (id: string) => config.triggers!.find((t) => t.id === id)!;
    expect(trig("outbound_links")).toMatchObject({
      type: "click",
      links_only: true,
      wait_for_tags_ms: 2000,
      check_validation: true,
      conditions: [{ var: "click_url", op: "contains", value: "partner.example.net" }],
    });
    expect(trig("thank_you_pages")).toMatchObject({
      conditions: [{ var: "page_path", op: "matches_regex", value: "^/thank-?you", ignore_case: true }],
    });
    expect(trig("big_order")).toMatchObject({ event: "purchase", conditions: [{ var: "dlv_value", op: "gt", value: "100" }] });
    expect(trig("pricing_seen")).toMatchObject({
      type: "element_visible",
      selector: "#pricing",
      once: "page",
      threshold: 0.5,
      min_duration_ms: 2000,
    });
    expect(trig("youtube")).toMatchObject({
      type: "video",
      providers: ["youtube"],
      statuses: ["start", "progress", "complete"],
      percentages: [25, 50, 75],
    });
    expect(trig("engaged")).toMatchObject({ type: "trigger_group", triggers: ["scroll_50_90", "pricing_seen"] });
    const v = (n: string) => config.variables!.find((x) => x.name === n)!;
    expect(v("plan_value")).toMatchObject({ type: "lookup", input: "url_plan", map: { pro: "99", basic: "19" }, default: "0" });
    expect(v("page_group")).toMatchObject({ type: "regex_table", input: "page_path", ignore_case: true });
    expect(v("url_plan")).toMatchObject({ type: "url", component: "param", param: "plan" });
    expect(v("cookie_uid")).toMatchObject({ type: "cookie", format: { lowercase: true } });
    expect(v("js_cart_size")).toMatchObject({ type: "custom_js" });
    expect(v("product_id")).toMatchObject({ type: "event_attr", attr: "data-product-id" });
  });

  it("reports what was adapted and what couldn't be mapped, with reasons", () => {
    expect(names(report.unmapped)).toEqual(
      expect.arrayContaining([
        "UA pageview",
        "Hotjar",
        "AMP click",
        "Random filter",
        "AMP only",
        "Random",
        "GA Settings",
        "JS - templated",
      ]),
    );
    expect(report.unmapped.find((u) => u.gtm.name === "Random filter")!.reason).toContain("fire it more often");
    expect(report.unmapped.find((u) => u.gtm.name === "AMP only")!.reason).toContain("firing triggers");
    expect(names(report.adapted)).toEqual(
      expect.arrayContaining(["Conversion Linker", "Chat widget", "Ads conversion", "Outbound links", "Ads", "Meta Pixel"]),
    );
    expect(report.adapted.find((a) => a.gtm.name === "Ads conversion")!.note).toContain("blocking trigger");
  });

  it("validates as a config (custom code is reported by the publish gate, not dropped)", () => {
    const r = validateConfig(config);
    expect(r.errors.filter((e) => e.code !== "placeholder_id")).toEqual([]);
  });

  it("rejects things that aren't exports, and bounds depth", () => {
    expect(() => mapGtmExport({ tag: "nope" })).toThrow(ImportShapeError);
    let deep: unknown = {};
    for (let i = 0; i < 100; i++) deep = { list: [deep] };
    expect(jsonDepth(deep)).toBeGreaterThan(24);
    expect(() => mapGtmExport({ containerVersion: { tag: [{ name: "x", type: "html", parameter: [deep] }] } })).toThrow(/nested/);
  });
});

describe("merge", () => {
  const base: ContainerConfig = {
    triggers: [{ id: "all_pages", type: "page_view" }],
    tags: [{ id: "ga4", type: "ga4", params: { measurement_id: "G-OLD1234" }, triggers: ["all_pages"] }],
    consent: { mode: "opt_in" },
  };
  const incoming: ContainerConfig = {
    triggers: [{ id: "all_pages", type: "page_view", conditions: [{ var: "page_path", op: "equals", value: "/" }] }],
    tags: [
      { id: "ga4", type: "ga4", params: { measurement_id: "G-NEW1234" }, triggers: ["all_pages"] },
      { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
    ],
    consent: { mode: "none" },
  };

  it("overwrite / skip / rename conflict rules; re-running changes nothing", () => {
    const ov = mergeConfigs(base, incoming, { mode: "merge", on_conflict: "overwrite" });
    expect(ov.config.tags!.map((t) => t.id)).toEqual(["ga4", "meta"]);
    expect(ov.counts.tags).toMatchObject({ replaced: ["ga4"], added: ["meta"] });
    expect(ov.config.consent).toEqual({ mode: "none" });
    expect(mergeConfigs(ov.config, incoming, { mode: "merge", on_conflict: "overwrite" }).config).toEqual(ov.config);

    const sk = mergeConfigs(base, incoming, { mode: "merge", on_conflict: "skip" });
    expect(sk.counts.tags.skipped).toEqual(["ga4"]);
    expect(sk.config.consent).toEqual({ mode: "opt_in" });

    const rn = mergeConfigs(base, incoming, { mode: "merge", on_conflict: "rename" });
    expect(rn.counts.triggers.renamed).toEqual([{ from: "all_pages", to: "all_pages_2" }]);
    expect(rn.config.tags!.find((t) => t.id === "ga4_2")!.triggers).toEqual(["all_pages_2"]); // its reference followed the rename
    expect(rn.config.tags!.find((t) => t.id === "meta")!.triggers).toEqual(["all_pages_2"]);
    expect(rn.config.tags!.find((t) => t.id === "ga4")!.triggers).toEqual(["all_pages"]);
    const again = mergeConfigs(rn.config, incoming, { mode: "merge", on_conflict: "rename" });
    expect(again.config).toEqual(rn.config);
    expect(again.counts.tags.unchanged).toEqual(["ga4_2", "meta"]);
  });

  it("overwrite mode replaces the draft", () => {
    const r = mergeConfigs(base, incoming, { mode: "overwrite", on_conflict: "overwrite" });
    expect(r.config).toEqual(incoming);
    expect(r.counts.tags).toMatchObject({ replaced: ["ga4"], added: ["meta"] });
  });
});
