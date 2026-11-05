import { describe, expect, it } from "vitest";
import { GTM_SHAPES, ImportShapeError, mapGtmExport, normalizeGtmData } from "../src/config/gtm-import";
import { mergeConfigs } from "../src/config/merge";
import { importRecord } from "../src/service/import";
import { analyze, detectTags, detectTools, lastScan, MAX_SCAN_TOOLS, MAX_TOOL_ID, TOOL_SLUGS } from "../src/service/scan";
import { GTM_EXPORT } from "./fixtures/gtm-export";
import siteHtml from "./fixtures/site-html";
import toolsHtml from "./fixtures/tools-html";

const cv = GTM_EXPORT.containerVersion;
/** API objects carry fields an export doesn't; the importer ignores them. */
const api = <T extends object>(items: T[], kind: string) =>
  items.map((x, i) => ({
    ...x,
    path: `accounts/1/containers/2/workspaces/3/${kind}s/${i + 1}`,
    accountId: "1",
    containerId: "2",
    workspaceId: "3",
    fingerprint: "1730000000000",
    tagManagerUrl: `https://tagmanager.google.com/#/container/accounts/1/containers/2/workspaces/3/${kind}s/${i + 1}`,
    parentFolderId: "9",
  }));

/** The mapping summary a dry run reports: everything but the GTM- id, which only exports carry. */
const summary = (r: ReturnType<typeof mapGtmExport>) => ({
  config: r.config,
  mapped: r.report.mapped,
  adapted: r.report.adapted,
  unmapped: r.report.unmapped,
});

describe("GTM import: the export, a containerVersion and Tag Manager API lists map the same", () => {
  const fromExport = mapGtmExport(GTM_EXPORT);

  it("a containerVersion on its own", () => {
    const r = mapGtmExport(cv);
    expect(r.shape).toBe("container_version");
    expect(summary(r)).toEqual(summary(fromExport));
    expect(r.report.container).toBe("GTM-ABC1234");
    expect(fromExport.shape).toBe("export");
  });

  it("API lists: singular keys, plural keys, and list responses passed through as returned", () => {
    const singular = {
      tag: api(cv.tag, "tag"),
      trigger: api(cv.trigger, "trigger"),
      variable: api(cv.variable, "variable"),
      builtInVariable: cv.builtInVariable,
      customTemplate: cv.customTemplate,
      folder: cv.folder,
    };
    const plural = {
      tags: singular.tag,
      triggers: singular.trigger,
      variables: singular.variable,
      builtInVariables: cv.builtInVariable,
      templates: cv.customTemplate,
      folders: cv.folder,
    };
    const wrapped = {
      tag: { tag: singular.tag },
      triggers: { trigger: singular.trigger },
      variable: { variables: singular.variable },
      builtInVariable: { builtInVariable: cv.builtInVariable },
      customTemplate: { template: cv.customTemplate },
      folder: { folder: cv.folder },
    };
    for (const data of [singular, plural, wrapped]) {
      const r = mapGtmExport(data);
      expect(r.shape).toBe("api_lists");
      expect(summary(r)).toEqual(summary(fromExport));
      expect(r.report.container).toBeUndefined();
      expect(r.notes).toEqual([]);
    }
  });

  it("the same merge counts and last_import summary for the export and the lists", () => {
    const lists = { tag: { tag: cv.tag }, trigger: { trigger: cv.trigger }, variable: { variable: cv.variable }, ...pick(cv) };
    const a = mergeConfigs({}, fromExport.config, { mode: "merge", on_conflict: "overwrite" });
    const b = mergeConfigs({}, mapGtmExport(lists).config, { mode: "merge", on_conflict: "overwrite" });
    expect(b.counts).toEqual(a.counts);
    const rec = importRecord("gtm", "merge", a.counts, fromExport.report, 1);
    expect(rec).toEqual(importRecord("gtm", "merge", b.counts, mapGtmExport(lists).report, 1));
    expect(rec).toEqual({
      at: 1,
      format: "gtm",
      mode: "merge",
      summary: {
        tags: fromExport.config.tags!.length,
        triggers: fromExport.config.triggers!.length,
        variables: fromExport.config.variables!.length,
        conversions: 0,
        skipped: fromExport.report.unmapped.length,
      },
    });
  });

  it("the llms.txt lists example maps", () => {
    const T = (key: string, value: string) => ({ type: "template", key, value });
    const r = mapGtmExport({
      tag: [{ tagId: "1", name: "Google tag", type: "googtag", parameter: [T("tagId", "G-ABC123XYZ")], firingTriggerId: ["2147479553"] }],
      trigger: [
        {
          triggerId: "7",
          name: "Thank you",
          type: "pageview",
          filter: [{ type: "startsWith", parameter: [T("arg0", "{{Page Path}}"), T("arg1", "/thank-you")] }],
        },
      ],
      variable: [{ variableId: "3", name: "DLV - value", type: "v", parameter: [T("name", "ecommerce.value")] }],
      builtInVariable: [{ type: "pageUrl", name: "Page URL" }],
    });
    expect(r.config.tags).toEqual([
      expect.objectContaining({ id: "google_tag", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] }),
    ]);
    expect(r.config.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "thank_you",
          type: "page_view",
          conditions: [{ var: "page_path", op: "starts_with", value: "/thank-you" }],
        }),
      ]),
    );
    expect(r.config.variables).toEqual([expect.objectContaining({ name: "dlv_value", type: "data_layer", key: "ecommerce.value" })]);
  });

  it("paged lists say so; an empty list response is an empty list; missing templates get a hint", () => {
    const paged = mapGtmExport({ tag: { tag: cv.tag, nextPageToken: "abc" }, trigger: cv.trigger, variable: cv.variable });
    expect(paged.notes).toEqual([expect.stringMatching(/tag list has more pages.*every page/)]);
    expect(mapGtmExport({ tag: {}, trigger: { nextPageToken: "x" } }).config).toEqual({});
    const noTemplates = mapGtmExport({ tag: cv.tag, trigger: cv.trigger, variable: cv.variable });
    const hotjar = noTemplates.report.unmapped.find((u) => u.gtm.name === "Hotjar")!;
    expect(hotjar.reason).toMatch(/custom template/);
    expect(hotjar.hint).toMatch(/customTemplate \(templates\.list -> template\)/);
  });

  it("anything else is refused, naming the accepted shapes", () => {
    const err = (data: unknown) => {
      try {
        mapGtmExport(data);
      } catch (e) {
        return e as ImportShapeError;
      }
      throw new Error("expected an ImportShapeError");
    };
    expect(err([{ name: "x", type: "html" }]).message).toMatch(/array/);
    const none = err({ hello: "world" });
    expect(none).toBeInstanceOf(ImportShapeError);
    expect(none.message).toMatch(/No GTM tags, triggers or variables/);
    expect(none.issues[0]!.message).toContain("hello");
    expect(none.issues[0]!.message).toContain(GTM_SHAPES);
    expect(err({ tag: [], tags: [] }).message).toMatch(/both tag and tags/);
    expect(err({ tag: { items: [] } }).message).toMatch(/isn't a list of GTM tags/);
    expect(err({ tag: [{ name: 5 }] }).message).toMatch(/Tag Manager API lists/);
    expect(err("{}").message).toMatch(/JSON object/);
    // One tag on its own (a get_tag result), with its API fields: told how to wrap it.
    const single = err(api([cv.tag[0]!], "tag")[0]);
    expect(single.message).toMatch(/single GTM tag/);
    expect(single.issues[0]!.message).toMatch(/"tag": \[ <it> \]/);
    expect(GTM_SHAPES).toMatch(/Export Container.*containerVersion.*tag.*trigger.*variable.*builtInVariable.*tags, triggers, variables/);
  });

  it("normalizeGtmData keeps the export's own fields", () => {
    expect(normalizeGtmData(GTM_EXPORT).version).toMatchObject({ container: { publicId: "GTM-ABC1234" }, tag: cv.tag });
  });
});

function pick(v: typeof cv) {
  return { builtInVariable: v.builtInVariable, customTemplate: v.customTemplate, folder: v.folder };
}

describe("last_scan.tools", () => {
  it("normalises every vendor on the fixture page to a slug and id; our own snippets and page text are left out", () => {
    const tools = detectTools(toolsHtml);
    expect(tools).toEqual([
      { tool: "gtm", id: "GTM-ZZZ9876", where: "inline_script" },
      { tool: "ga4", id: "G-SHOP123456", where: "script_src" },
      { tool: "meta", id: "9876543210987654", where: "inline_script" },
      { tool: "hotjar", id: "3456789", where: "inline_script" },
      { tool: "clarity", id: "abcdef1234", where: "inline_script" },
      { tool: "plausible", where: "script_src" },
      { tool: "segment", id: "SEGwriteKey12345", where: "inline_script" },
      { tool: "posthog", id: "phc_AbCdEfGhIjKlMnOpQrStUv", where: "inline_script" },
      { tool: "hubspot", id: "1234567", where: "script_src" },
      { tool: "snap", id: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", where: "inline_script" },
      { tool: "fathom", id: "ABCDEFGH", where: "script_src" },
      { tool: "umami", id: "94db1cb1-74f4-4a40-ad6c-962362670409", where: "script_src" },
      { tool: "matomo", id: "3", where: "inline_script" },
      { tool: "simple_analytics", where: "script_src" },
      { tool: "datafast", id: "dfid_8sKQ2xLm0P", where: "script_src" },
      { tool: "mixpanel", id: "0123456789abcdef0123456789abcdef", where: "inline_script" },
      { tool: "amplitude", id: "fedcba9876543210fedcba9876543210", where: "script_src" },
      { tool: "heap", id: "1234567890", where: "inline_script" },
      { tool: "fullstory", id: "o-1ABCDE-na1", where: "inline_script" },
      { tool: "logrocket", id: "acme1/shop-app", where: "inline_script" },
    ]);
    for (const t of tools) expect(TOOL_SLUGS).toContain(t.tool);
    // Decoys in text, links, <pre>, <template> and JSON-LD aren't ids.
    const ids = tools.map((t) => t.id);
    for (const decoy of [
      "ffffffffffffffffffffffffffffffff",
      "999999",
      "11111111111111111111111111111111",
      "o-JSONLD-na1",
      "JSONLDKEY12345",
    ])
      expect(ids).not.toContain(decoy);
    expect(JSON.stringify(tools)).not.toMatch(/ctr_|site_|Ignore previous/);
    expect(detectTags(toolsHtml).other).toEqual([
      "Hotjar",
      "Microsoft Clarity",
      "Plausible",
      "Segment",
      "PostHog",
      "HubSpot",
      "Snap Pixel",
      "Fathom",
      "Umami",
      "Matomo",
      "Simple Analytics",
      "DataFast",
      "Mixpanel",
      "Amplitude",
      "Heap",
      "FullStory",
      "LogRocket",
    ]);
  });

  it("the classic fixture: Google ids and pixels, one linkedin entry, no consent platform or CMS", () => {
    const r = analyze([{ url: "https://acme.example/", html: siteHtml }], "ctr_abcdefgh12345678");
    expect(r.tools).toEqual([
      { tool: "gtm", id: "GTM-ABC1234", where: "inline_script" },
      { tool: "ga4", id: "G-QWERTY1234", where: "script_src" },
      { tool: "google_ads", id: "AW-987654321", where: "inline_script" },
      { tool: "meta", id: "1234567890123456", where: "inline_script" },
      { tool: "tiktok", id: "CABCDEFGHIJ1234567890", where: "inline_script" },
      { tool: "linkedin", id: "7654321", where: "inline_script" },
      { tool: "bing_uet", id: "56781234", where: "inline_script" },
      { tool: "reddit", id: "a2_abc123def", where: "inline_script" },
      { tool: "x", id: "o1abc", where: "inline_script" },
      { tool: "pinterest", id: "2612345678901", where: "inline_script" },
    ]);
    const rec = lastScan("https://acme.example/", r.tools, r.detected, r.container_installed, 5);
    expect(rec).toEqual({ at: 5, url: "https://acme.example/", tools: r.tools, ours: { container: true, analytics: true } });
    const other = analyze([{ url: "https://acme.example/", html: siteHtml }], "ctr_zzzzzzzzzzzzzzzz");
    expect(lastScan("https://acme.example/", other.tools, other.detected, other.container_installed).ours).toEqual({
      container: false,
      analytics: true,
    });
  });

  it("limits: at most 50 tools, ids of at most 64 characters (a longer one is left out, the tool kept)", () => {
    const many = Array.from({ length: 60 }, (_, i) => `gtag('config','G-ABCDE${String(i).padStart(3, "0")}');`).join("");
    const long = `${"a".repeat(40)}/${"b".repeat(40)}`;
    const tools = detectTools(`<script>${many}</script><script>LogRocket.init('${long}')</script>`);
    expect(MAX_SCAN_TOOLS).toBe(50);
    expect(tools).toHaveLength(MAX_SCAN_TOOLS);
    const solo = detectTools(`<script src="https://cdn.logrocket.io/LogRocket.min.js"></script><script>LogRocket.init('${long}')</script>`);
    expect(long.length).toBeGreaterThan(MAX_TOOL_ID);
    expect(solo).toEqual([{ tool: "logrocket", where: "script_src" }]);
    const rec = lastScan(`https://acme.example/${"x".repeat(5000)}`, [...tools, ...tools], detectTags(""), false);
    expect(rec.tools).toHaveLength(MAX_SCAN_TOOLS);
    expect(rec.url.length).toBe(2048);
    // A UET tag whose id can't be read is kept without one.
    expect(detectTools(`<script src="https://bat.bing.com/bat.js"></script>`)).toEqual([{ tool: "bing_uet", where: "script_src" }]);
  });
});
