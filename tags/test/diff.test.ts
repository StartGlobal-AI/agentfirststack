import { describe, expect, it } from "vitest";
import { diffConfigs, pathDiff } from "../src/config/diff";
import type { ContainerConfig } from "../src/config/schema";

const live: ContainerConfig = {
  variables: [{ name: "v", type: "data_layer", key: "ecommerce.value" }],
  triggers: [
    { id: "all_pages", type: "page_view" },
    { id: "p", type: "custom_event", event: "purchase" },
  ],
  tags: [
    { id: "ga4", type: "ga4", params: { measurement_id: "G-OLD1234" }, triggers: ["all_pages"] },
    { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
  ],
  consent: { mode: "none" },
};

describe("config diff", () => {
  it("identical configs", () => {
    const d = diffConfigs(live, structuredClone(live));
    expect(d.identical).toBe(true);
    expect(d.summary).toBe("No changes.");
  });

  it("reports added, removed and changed items with paths, sections and order, in plain words", () => {
    const draft = structuredClone(live);
    draft.tags![0] = { ...draft.tags![0]!, params: { measurement_id: "G-NEW1234" } } as never;
    draft.tags = [
      draft.tags![1]!,
      draft.tags![0]!,
      { id: "tt", type: "tiktok_pixel", params: { pixel_id: "C1A2B3C4D5E6F7G8H9I0" }, triggers: ["all_pages"] },
    ];
    draft.variables = [];
    draft.consent = { mode: "opt_in" };
    const d = diffConfigs(live, draft);
    expect(d.identical).toBe(false);
    expect(d.counts).toEqual({ added: 1, removed: 1, changed: 1 });
    const ga4 = d.changes.find((c) => c.key === "ga4")!;
    expect(ga4).toMatchObject({ kind: "tags", change: "changed", type: "ga4" });
    expect(ga4.paths).toEqual([{ path: "params.measurement_id", from: "G-OLD1234", to: "G-NEW1234" }]);
    expect(ga4.text).toBe('Tag "ga4" (ga4) changed: params.measurement_id "G-OLD1234" -> "G-NEW1234".');
    expect(d.changes.find((c) => c.key === "v")).toMatchObject({ kind: "variables", change: "removed" });
    expect(d.sections).toEqual([expect.objectContaining({ section: "consent", change: "changed" })]);
    expect(d.order_changed).toEqual(["tags"]);
    expect(d.summary).toBe("1 tag added (tt), 1 tag changed (ga4), 1 variable removed (v), consent changed, tags reordered.");
  });

  it("from nothing published (null) everything is added; long values are clipped", () => {
    const d = diffConfigs(null, live);
    expect(d.counts.added).toBe(5);
    const p = pathDiff({ html: "x".repeat(500) }, { html: "y".repeat(500) });
    expect(String(p[0]!.to)).toMatch(/\.\.\.\(500 chars\)$/);
  });
});
