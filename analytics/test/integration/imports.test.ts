import { createApiKey } from "@afs/shared";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const B = "http://analytics.test";
const DAY = 86_400_000;

type Init = RequestInit & { key?: string; json?: unknown };
async function call(path: string, init: Init = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await SELF.fetch(
    new Request(`${B}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }),
  );
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
async function tool(key: string, name: string, args: Record<string, unknown>) {
  const r = await call("/mcp", {
    method: "POST",
    key,
    headers: { accept: "application/json, text/event-stream" },
    json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return { isError: !!r.body.result.isError, data: JSON.parse(r.body.result.content[0].text) };
}
let accountKey: string | null = null;
async function newSite(domain: string) {
  accountKey ??= (await call("/v1/signup", { method: "POST" })).body.api_key as string;
  const created = await call("/v1/sites", { method: "POST", key: accountKey, json: { domain } });
  return { key: accountKey, site: created.body.site.id as string };
}
const csvPost = (key: string, path: string, csv: string) =>
  call(path, { method: "POST", key, body: csv, headers: { "content-type": "text/csv" } });
const today0 = () => Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const ymd = (ago: number) => new Date(today0() - ago * DAY).toISOString().slice(0, 10);
/** `perDay[ago]` live visitors (server pageviews, one user each) at noon UTC `ago` days back. */
async function seedLive(key: string, site: string, domain: string, perDay: Record<number, number>) {
  const events = Object.entries(perDay).flatMap(([ago, n]) =>
    Array.from({ length: n }, (_, i) => ({
      name: "pageview",
      url: `https://${domain}/`,
      user_id: `u${ago}_${i}`,
      timestamp: today0() - Number(ago) * DAY + 12 * 3_600_000,
    })),
  );
  const r = await call(`/v1/sites/${site}/events`, { method: "POST", key, json: { events } });
  expect(r.body.accepted).toBe(events.length);
}
const ga4Report = (dims: string[], mets: string[], rows: (string | number)[][]) => ({
  dimensionHeaders: dims.map((name) => ({ name })),
  metricHeaders: mets.map((name) => ({ name, type: "TYPE_INTEGER" })),
  rows: rows.map((r) => ({
    dimensionValues: r.slice(0, dims.length).map((value) => ({ value: String(value) })),
    metricValues: r.slice(dims.length).map((value) => ({ value: String(value) })),
  })),
  rowCount: rows.length,
  kind: "analyticsData#runReport",
});

describe("imports from any tool", () => {
  it("generic CSV (text/csv, ?source=other&tool=) and JSON rows (MCP): tool required, kind detected, idempotent, listed with the tool", async () => {
    const { key, site } = await newSite("generic-import.test");
    const csv = "date,visitors,visits,pageviews,bounce_rate,visit_duration\n2026-01-01,10,12,30,50,60\n2026-01-02,20,25,50,40,30\n";
    const noTool = await csvPost(key, `/v1/sites/${site}/imports?source=other`, csv);
    expect([noTool.status, noTool.body.error.code]).toEqual([400, "bad_request"]);
    expect(noTool.body.error.hint).toMatch(/"tool":"fathom"/);
    const r = await csvPost(key, `/v1/sites/${site}/imports?source=other&tool=DataFast&file_name=datafast.csv`, csv);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      existing: false,
      import: { source: "other", tool: "datafast", kind: "visitors", from: "2026-01-01", to: "2026-01-02", rows: 2 },
    });
    expect(r.body.next_steps.join(" ")).toMatch(/imports\/compare\?source=other&tool=datafast/);
    const again = await csvPost(key, `/v1/sites/${site}/imports?source=other&tool=datafast`, csv);
    expect([again.status, again.body.existing, again.body.import.id]).toEqual([200, true, r.body.import.id]);
    // the same days from another tool are another import
    const fathom = await tool(key, "import_csv", {
      site_id: site,
      source: "other",
      tool: "fathom",
      rows: [
        { date: "2026-01-01", page: "https://generic-import.test/pricing?ref=x", visitors: 4, pageviews: 6 },
        { date: "2026-01-02", page: "/pricing", visitors: 5, pageviews: 7 },
      ],
    });
    expect(fathom.isError).toBe(false);
    expect(fathom.data.import).toMatchObject({ source: "other", tool: "fathom", kind: "pages", rows: 2 });
    const pages = await call(
      `/v1/sites/${site}/breakdown?from=2026-01-01&to=2026-01-31&breakdown=page&metrics=visitors,pageviews&imported=true`,
      {
        key,
      },
    );
    expect(pages.body.results).toEqual([{ value: "/pricing", visitors: 9, pageviews: 13 }]);
    await csvPost(key, `/v1/sites/${site}/imports?source=plausible`, "date,visitors\n2026-02-01,3\n");
    const list = (await call(`/v1/sites/${site}/imports`, { key })).body;
    expect(list.imports.map((i: any) => [i.source, i.tool, i.kind])).toEqual([
      ["other", "datafast", "visitors"],
      ["other", "fathom", "pages"],
      ["plausible", null, "visitors"],
    ]);
    // bad combinations say how to fix them
    const ga4Tool = await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "ga4", tool: "x", csv } });
    expect(ga4Tool.body.error.message).toMatch(/tool is only for source other/);
    const both = await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "other", tool: "x", csv, rows: [] } });
    expect(both.body.error.message).toMatch(/one of csv, rows or report/);
    const otherReport = await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "other", tool: "x", report: {} } });
    expect(otherReport.body.error.hint).toMatch(/rows: \[\{date, visitors/);
    const badTool = await call(`/v1/sites/${site}/imports`, {
      method: "POST",
      key,
      json: { source: "other", tool: "Simple Analytics", csv },
    });
    expect(badTool.body.error.details[0]).toMatchObject({ path: "tool" });
    const twoDims = await tool(key, "import_csv", {
      site_id: site,
      source: "other",
      tool: "umami",
      rows: [{ date: "2026-01-01", visitors: 1, page: "/", country: "DE" }],
    });
    expect([twoDims.isError, twoDims.data.error.code]).toEqual([true, "invalid_import"]);
  });

  it("GA4 runReport JSON (also over 1 MB) and Plausible Stats API v2 JSON; reports that can't be mapped get hinted 400s", async () => {
    const { key, site } = await newSite("api-import.test");
    const report = ga4Report(["date", "country"], ["activeUsers", "sessions", "screenPageViews"], [["20260101", "Germany", 5, 6, 9]]);
    const g = await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "ga4", report } });
    expect(g.status).toBe(201);
    expect(g.body.import).toMatchObject({ source: "ga4", tool: null, kind: "countries", rows: 1 });
    const countries = await call(
      `/v1/sites/${site}/breakdown?from=2026-01-01&to=2026-01-31&breakdown=country&metrics=visitors&imported=true`,
      {
        key,
      },
    );
    expect(countries.body.results).toEqual([{ value: "DE", visitors: 5 }]);
    // the same data as a GA4 CSV export is the same import (same source, kind, range): it replaces it
    const csv = await csvPost(
      key,
      `/v1/sites/${site}/imports?source=ga4`,
      "Date,Country,Active users,Sessions,Views\n20260101,Germany,5,6,9\n",
    );
    expect([csv.status, csv.body.existing, csv.body.import.id]).toEqual([200, true, g.body.import.id]);
    // a big report: past the 1 MB cap of other JSON bodies
    const big = ga4Report(
      ["date", "pagePath"],
      ["activeUsers"],
      Array.from({ length: 15_000 }, (_, i) => [`202602${String((i % 28) + 1).padStart(2, "0")}`, `/a-fairly-long-blog-path/post-${i}`, 1]),
    );
    expect(JSON.stringify(big).length).toBeGreaterThan(1024 * 1024);
    const b = await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "ga4", report: big } });
    expect([b.status, b.body.import?.rows]).toEqual([201, 15_000]);
    const noDate = await call(`/v1/sites/${site}/imports`, {
      method: "POST",
      key,
      json: { source: "ga4", report: ga4Report(["city"], ["activeUsers"], [["Berlin", 1]]) },
    });
    expect([noDate.status, noDate.body.error.code]).toEqual([400, "invalid_import"]);
    expect(noDate.body.error.hint).toMatch(/dimensions \[\{"name":"date"\}\].*metrics activeUsers/);
    const plausible = await tool(key, "import_csv", {
      site_id: site,
      source: "plausible",
      report: {
        results: [
          { dimensions: ["2026-01-01", "/"], metrics: [7, 8, 20] },
          { dimensions: ["2026-01-01", "/docs"], metrics: [2, 2, 3] },
        ],
        meta: {},
        query: { site_id: "api-import.test", metrics: ["visitors", "visits", "pageviews"], dimensions: ["time:day", "event:page"] },
      },
    });
    expect(plausible.data.import).toMatchObject({ source: "plausible", kind: "pages", rows: 2 });
    const badPlausible = await call(`/v1/sites/${site}/imports`, {
      method: "POST",
      key,
      json: { source: "plausible", report: { results: [], query: { dimensions: ["visit:source"], metrics: ["visitors"] } } },
    });
    expect(badPlausible.body.error.hint).toMatch(/"time:day"/);
  });

  it("compares our live daily visitors with the old tool's: close, lower, higher, not_enough_overlap (REST + MCP)", async () => {
    const domain = "compare-import.test";
    const { key, site } = await newSite(domain);
    const before = (await call(`/v1/sites/${site}/imports/compare`, { key })).body;
    expect(before).toMatchObject({
      site_id: site,
      source: null,
      tool: null,
      overlap_days: 0,
      days: [],
      ratio: null,
      verdict: "not_enough_overlap",
    });
    expect(before.next_steps[0]).toMatch(/Install the tracker/);
    // live from 6 days ago (a partial first day, left out), 10 visitors a day; today is left out too
    await seedLive(key, site, domain, { 6: 3, 5: 10, 4: 10, 3: 10, 2: 10, 1: 10, 0: 4 });
    const days = (counts: number[]) => counts.map((visitors, i) => ({ date: ymd(5 - i), visitors }));
    const ga4 = ga4Report(
      ["date"],
      ["activeUsers"],
      [6, 5, 4, 3, 2, 1].map((ago) => [ymd(ago).replace(/-/g, ""), ago === 6 ? 9 : 11]),
    );
    await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "ga4", report: ga4 } });
    await call(`/v1/sites/${site}/imports`, {
      method: "POST",
      key,
      json: { source: "other", tool: "fathom", rows: days([20, 20, 20, 20]) },
    });
    await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "other", tool: "umami", rows: days([5, 5, 5]) } });
    await call(`/v1/sites/${site}/imports`, { method: "POST", key, json: { source: "plausible", rows: days([10, 10]) } });

    const close = await call(`/v1/sites/${site}/imports/compare?source=ga4`, { key });
    expect(close.status).toBe(200);
    expect(close.body).toMatchObject({
      site_id: site,
      source: "ga4",
      tool: null,
      overlap_days: 5,
      ratio: 0.91,
      verdict: "close",
      live_data_from: ymd(6),
    });
    expect(close.body.days[0]).toEqual({ date: ymd(5), imported_visitors: 11, live_visitors: 10 });
    expect(close.body.days.at(-1).date).toBe(ymd(1));
    expect(close.body.note).toMatch(/bots/);
    const lower = await tool(key, "compare_import", { site_id: site, source: "other", tool: "fathom" });
    expect(lower.data).toMatchObject({ source: "other", tool: "fathom", overlap_days: 4, ratio: 0.5, verdict: "lower" });
    expect(lower.data.note).toMatch(/Keep fathom installed until the verdict is close/);
    const higher = await call(`/v1/sites/${site}/imports/compare?tool=umami`, { key });
    expect(higher.body).toMatchObject({ source: "other", tool: "umami", overlap_days: 3, ratio: 2, verdict: "higher" });
    const few = await call(`/v1/sites/${site}/imports/compare?source=plausible`, { key });
    expect(few.body).toMatchObject({ source: "plausible", overlap_days: 2, verdict: "not_enough_overlap" });
    // default: the source with the most overlapping days
    const auto = (await call(`/v1/sites/${site}/imports/compare`, { key })).body;
    expect([auto.source, auto.tool, auto.overlap_days, auto.verdict]).toEqual(["ga4", null, 5, "close"]);
    const other = (await call(`/v1/sites/${site}/imports/compare?source=other`, { key })).body;
    expect([other.tool, other.overlap_days]).toEqual(["fathom", 4]);
    const bad = await call(`/v1/sites/${site}/imports/compare?source=ga4&tool=x`, { key });
    expect(bad.body.error.message).toMatch(/tool is only for source other/);
    // compare is a read tool (read keys see it, and not import_csv); import_csv's schema has the new inputs
    const me = (await call("/v1/me", { key })).body;
    const read = (await createApiKey(env.AUTH_DB ?? env.DB, me.account.id, { keyPrefix: "afs", scope: "read" })).key;
    const list = async (k: string) =>
      (
        await call("/mcp", {
          method: "POST",
          key: k,
          headers: { accept: "application/json, text/event-stream" },
          json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        })
      ).body.result.tools as {
        name: string;
        annotations: { readOnlyHint: boolean };
        inputSchema: { properties: Record<string, unknown> };
      }[];
    const readTools = await list(read);
    expect(readTools.find((t) => t.name === "compare_import")?.annotations.readOnlyHint).toBe(true);
    expect(readTools.some((t) => t.name === "import_csv")).toBe(false);
    expect((await tool(read, "compare_import", { site_id: site, source: "ga4" })).data.verdict).toBe("close");
    const imp = (await list(key)).find((t) => t.name === "import_csv")!;
    for (const p of ["source", "tool", "csv", "rows", "report"]) expect(imp.inputSchema.properties).toHaveProperty(p);
  });
});
