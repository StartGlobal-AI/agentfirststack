import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GTM_EXPORT } from "../fixtures/gtm-export";
import siteHtml from "../fixtures/site-html";
import toolsHtml from "../fixtures/tools-html";

const B = "https://tags.test";

async function json(res: Response) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

/** Pages the scan fetches (by URL); everything else is a 404. */
let pages: Record<string, string> = {};
beforeEach(() => {
  pages = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return pages[url] !== undefined
      ? new Response(pages[url], { headers: { "content-type": "text/html" } })
      : new Response("not found", { status: 404 });
  });
});
afterEach(() => vi.restoreAllMocks());

/** One account for the whole file (signup is rate limited). */
let shared: Promise<{
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  mcp: (method: string, params?: Record<string, unknown>) => Promise<any>;
}> | null = null;
function account() {
  shared ??= (async () => {
    const s = await json(await SELF.fetch(`${B}/v1/signup`, { method: "POST" }));
    const H = { authorization: `Bearer ${s.api_key}`, "content-type": "application/json" };
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await SELF.fetch(`${B}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await json(res) };
    };
    const mcp = async (method: string, params?: Record<string, unknown>) =>
      (
        await json(
          await SELF.fetch(`${B}/mcp`, {
            method: "POST",
            headers: { ...H, accept: "application/json, text/event-stream" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
          }),
        )
      ).result;
    return { api, mcp };
  })();
  return shared;
}
async function container(domain: string) {
  const a = await account();
  const C = (await a.api("POST", "/v1/containers", { domain })).body.container.id as string;
  return { ...a, C };
}

const cv = GTM_EXPORT.containerVersion;
/** The same container as the Tag Manager API lists, each as its list response. */
const apiLists = {
  tag: { tag: cv.tag },
  trigger: { trigger: cv.trigger },
  variable: { variable: cv.variable },
  builtInVariable: { builtInVariable: cv.builtInVariable },
  customTemplate: { template: cv.customTemplate },
  folder: { folder: cv.folder },
};

describe("container.last_scan", () => {
  it("is null until a scan, then holds the normalised tools; GET and the list return it", async () => {
    const { api, C } = await container("migrate.test");
    const before = (await api("GET", `/v1/containers/${C}`)).body.container;
    expect(before).toMatchObject({ last_scan: null, last_import: null });

    pages["https://migrate.test/"] = siteHtml.replace("ctr_abcdefgh12345678", C);
    const scan = await api("POST", `/v1/containers/${C}/scan`, { follow_links: false });
    expect(scan.status).toBe(200);
    const ls = scan.body.last_scan;
    expect(ls).toMatchObject({ url: "https://migrate.test/", ours: { container: true, analytics: true } });
    expect(typeof ls.at).toBe("number");
    expect(ls.tools.map((t: { tool: string }) => t.tool)).toEqual([
      "gtm",
      "ga4",
      "google_ads",
      "meta",
      "tiktok",
      "linkedin",
      "bing_uet",
      "reddit",
      "x",
      "pinterest",
    ]);
    expect(ls.tools[0]).toEqual({ tool: "gtm", id: "GTM-ABC1234", where: "inline_script" });
    expect(JSON.stringify(ls)).not.toMatch(/ctr_|site_|Ignore previous|Cookiebot/);
    expect(scan.body.last_import).toBeNull();

    // next_steps: GTM -> draft/import (export file or API / MCP lists, dry run first); analytics
    // history -> analytics imports, keep the old tools until compare is close; ad pixel ids.
    const steps = scan.body.next_steps.join("\n");
    expect(steps).toMatch(/Google Tag Manager \(GTM-ABC1234\).*draft\/import.*"format": "gtm".*"dry_run": true/);
    expect(steps).toMatch(/Export Container.*Tag Manager MCP server.*"tag": \[\.\.\.\]/);
    expect(steps).toMatch(/\(ga4\).*POST https:\/\/analytics\.test\/v1\/sites\/:id\/imports.*imports\/compare says close/);
    expect(steps).toMatch(
      /Ad pixels on the site \(google_ads, meta, tiktok, linkedin, bing_uet, reddit, x, pinterest\).*destinations.*owner/,
    );

    const got = (await api("GET", `/v1/containers/${C}`)).body.container;
    expect(got.last_scan).toEqual(ls);
    const listed = (await api("GET", "/v1/containers")).body.containers.find((c: { id: string }) => c.id === C);
    expect(listed.last_scan).toEqual(ls);

    // A later scan replaces it.
    pages["https://migrate.test/"] = toolsHtml;
    const again = (await api("POST", `/v1/containers/${C}/scan`, { follow_links: false })).body.last_scan;
    expect(again.ours).toEqual({ container: false, analytics: true });
    expect(again.tools.map((t: { tool: string }) => t.tool)).toEqual(expect.arrayContaining(["fathom", "umami", "datafast", "logrocket"]));
    expect((await api("GET", `/v1/containers/${C}`)).body.container.last_scan).toEqual(again);
    expect(again.tools.some((t: { tool: string }) => t.tool === "google_ads")).toBe(false);
  });
});

describe("container.last_import", () => {
  it("dry runs don't write it; a real import does; the export and the API lists report the same mapping", async () => {
    const { api, C } = await container("migrate-import.test");
    const dryExport = (await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: GTM_EXPORT, dry_run: true })).body;
    const dryLists = (await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: apiLists, dry_run: true })).body;
    const dryPlural = (
      await api("POST", `/v1/containers/${C}/draft/import`, {
        format: "gtm",
        data: {
          tags: cv.tag,
          triggers: cv.trigger,
          variables: cv.variable,
          builtInVariables: cv.builtInVariable,
          templates: cv.customTemplate,
          folders: cv.folder,
        },
        dry_run: true,
      })
    ).body;
    expect(dryExport.input_shape).toBe("export");
    expect(dryLists.input_shape).toBe("api_lists");
    for (const d of [dryLists, dryPlural]) {
      expect(d.summary).toBe(dryExport.summary);
      expect(d.counts).toEqual(dryExport.counts);
      expect(d.config).toEqual(dryExport.config);
      for (const k of ["mapped", "adapted", "unmapped", "totals"]) expect(d.report[k]).toEqual(dryExport.report[k]);
    }
    expect(dryExport).not.toHaveProperty("last_import");
    expect((await api("GET", `/v1/containers/${C}`)).body.container.last_import).toBeNull();

    const saved = await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: apiLists });
    expect(saved.status).toBe(200);
    expect(saved.body.written).toBe(true);
    const li = saved.body.last_import;
    expect(li).toMatchObject({
      format: "gtm",
      mode: "merge",
      summary: {
        tags: dryExport.config.tags.length,
        triggers: dryExport.config.triggers.length,
        variables: dryExport.config.variables.length,
        conversions: 0,
        skipped: dryExport.report.totals.unmapped,
      },
    });
    const got = (await api("GET", `/v1/containers/${C}`)).body.container;
    expect(got.last_import).toEqual(li);
    expect(got.last_scan).toBeNull();
    const listed = (await api("GET", "/v1/containers")).body.containers.find((c: { id: string }) => c.id === C);
    expect(listed.last_import).toEqual(li);

    // A dry run afterwards leaves it as it was.
    await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: GTM_EXPORT, dry_run: true, mode: "overwrite" });
    expect((await api("GET", `/v1/containers/${C}`)).body.container.last_import).toEqual(li);

    // With an import recorded, a scan that still finds GTM says to remove it after publishing.
    pages["https://migrate-import.test/"] = siteHtml;
    const scan = (await api("POST", `/v1/containers/${C}/scan`, { follow_links: false })).body;
    expect(scan.last_import).toEqual(li);
    expect(scan.next_steps.join("\n")).toMatch(/GTM-ABC1234\) is still on the site; a GTM container was imported.*remove GTM's snippet/);
  });

  it("MCP: import_draft takes the Tag Manager lists and get_container returns last_import and last_scan", async () => {
    const { mcp, C } = await container("migrate-mcp.test");
    const tools = (await mcp("tools/list")).tools as { name: string; description: string; inputSchema: any }[];
    const imp = tools.find((t) => t.name === "import_draft")!;
    expect(imp.description).toMatch(/Tag Manager MCP server \(list_tags, list_triggers, list_variables\)/);
    expect(imp.inputSchema.properties.data.description).toMatch(/containerVersion.*"tag": \[\.\.\.\]/);
    expect(tools.find((t) => t.name === "get_container")!.description).toMatch(/container\.last_scan.*container\.last_import/);
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse((await mcp("tools/call", { name, arguments: args })).content[0].text);
    const r = await call("import_draft", { container_id: C, format: "gtm", data: apiLists });
    expect(r).toMatchObject({ written: true, input_shape: "api_lists", last_import: { format: "gtm", mode: "merge" } });
    const got = await call("get_container", { container_id: C });
    expect(got.container).toMatchObject({ last_scan: null, last_import: r.last_import });
  });

  it("own-config imports are recorded too; paged lists and unknown shapes are explained", async () => {
    const { api, C } = await container("migrate-own.test");
    const own = await api("POST", `/v1/containers/${C}/draft/import`, {
      config: {
        triggers: [{ id: "all_pages", type: "page_view" }],
        tags: [{ id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] }],
      },
    });
    expect(own.body.last_import).toMatchObject({
      format: "afst",
      mode: "merge",
      summary: { tags: 1, triggers: 1, variables: 0, skipped: 0 },
    });
    expect(own.body).not.toHaveProperty("input_shape");

    const paged = await api("POST", `/v1/containers/${C}/draft/import`, {
      format: "gtm",
      dry_run: true,
      data: { tag: { tag: cv.tag, nextPageToken: "next" }, trigger: cv.trigger, variable: cv.variable },
    });
    expect(paged.body.next_steps[0]).toMatch(/tag list has more pages \(nextPageToken\)/);

    const bad = await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: { workspace: "x" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_import");
    expect(bad.body.error.hint).toMatch(/Export Container.*containerVersion.*Tag Manager MCP lists/);
    const both = await api("POST", `/v1/containers/${C}/draft/import`, { format: "gtm", data: { tag: [], tags: [] } });
    expect(both.body.error.message).toMatch(/both tag and tags/);
  });
});
