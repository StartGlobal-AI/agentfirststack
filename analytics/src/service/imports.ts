/**
 * Imports of another tool's history (lib/imports.ts parses, do/imports.ts stores and merges): POST
 * /v1/sites/:id/imports with a CSV (text/csv body or {csv}), generic JSON rows, or a GA4 /
 * Plausible API response ({report}); idempotent per (source, tool, kind, date range); reports add
 * them with imported=true. GET .../imports/compare checks our live numbers against the old tool's.
 */

import { ApiError, accountStanding, badRequest, newId, notFound, parse } from "@afs/shared";
import { z } from "zod";
import { IMPORT_KINDS, IMPORT_SOURCES, ImportError, type ParsedImport, TOOL_RE, parseImport, parseReport, parseRows } from "../lib/imports";
import { enforce, limitVars, siteCap } from "../lib/limits";
import { type Ctx, callSite, loadSite } from "./context";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_FILE_ROWS = 50_000;
export const DEFAULT_MAX_IMPORTED_ROWS_PER_SITE = 500_000;
export const DEFAULT_MAX_IMPORTS_PER_SITE = 100;

const tool = z.string().trim().toLowerCase().regex(TOOL_RE, "a lowercase slug: a-z, 0-9, _ and -, at most 40 characters (e.g. datafast)");
const metric = z.union([z.number(), z.string().max(40)]);

export const importRowSchema = z.object({
  date: z.string().max(40).describe("YYYY-MM-DD"),
  visitors: metric.describe("unique visitors that day"),
  visits: metric.nullish().describe("visits / sessions"),
  pageviews: metric.nullish(),
  bounce_rate: metric.nullish().describe("% of visits, 0-100"),
  visit_duration: metric.nullish().describe("average seconds per visit"),
  page: z.string().max(2000).nullish().describe("path (a full URL's path is used; query strings are dropped)"),
  source: z.string().max(500).nullish().describe("referrer source, e.g. Google; Direct / (direct) become (none)"),
  country: z.string().max(100).nullish().describe("ISO 3166-1 alpha-2 or an English country name"),
  device: z.string().max(40).nullish().describe("desktop | mobile | tablet"),
});

export const importInput = z.object({
  source: z
    .enum(IMPORT_SOURCES)
    .describe(
      "plausible (its CSV export, or report: a Stats API v2 response), ga4 (a report CSV with the Date dimension, or report: a Data API runReport response) or other (any other tool, with tool: its CSV in the generic columns or rows).",
    ),
  tool: tool.optional().describe("Required for source other: the tool's name as a lowercase slug (datafast, fathom, umami, matomo, ...)."),
  kind: z
    .enum(IMPORT_KINDS)
    .optional()
    .describe("visitors (daily totals), pages, sources, countries or devices. Default: detected from the columns or dimensions."),
  file_name: z.string().max(200).optional(),
  csv: z.string().max(MAX_IMPORT_BYTES).optional().describe("A CSV file's text (or send it as a text/csv body)."),
  rows: z
    .array(importRowSchema)
    .max(MAX_IMPORT_FILE_ROWS, `at most ${MAX_IMPORT_FILE_ROWS} rows per import: split the date range`)
    .optional()
    .describe("Generic daily rows (any source): one per day, or per day and value with one of page, source, country, device."),
  report: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "ga4: a runReport response ({dimensionHeaders, metricHeaders, rows}, as the Data API and the GA4 MCP server return it); plausible: a Stats API v2 response ({results, query}).",
    ),
  dimensions: z
    .array(z.string().max(100))
    .max(10)
    .optional()
    .describe("plausible report only, when it lacks query: the query's dimensions, in order."),
  metrics: z
    .array(z.string().max(100))
    .max(20)
    .optional()
    .describe("plausible report only, when it lacks query: the query's metrics, in order."),
});

const LABEL = { ga4: "GA4", plausible: "Plausible" } as const;

export async function importData(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(importInput, raw);
  const given = [input.csv ? "csv" : null, input.rows ? "rows" : null, input.report ? "report" : null].filter((x) => x !== null);
  if (!given.length)
    throw badRequest(
      "Send the data: csv, rows or report.",
      'A text/csv body with ?source= (and &tool= for other), or JSON {source, csv | rows | report}. Example: curl -X POST ".../imports?source=plausible" -H "content-type: text/csv" --data-binary @imported_pages.csv',
    );
  if (given.length > 1) throw badRequest(`Send one of csv, rows or report, not ${given.join(" and ")}.`, "One file or report per request.");
  if (input.source === "other" && !input.tool)
    throw badRequest(
      "source other needs tool: the old tool's name as a lowercase slug.",
      'e.g. {"source":"other","tool":"fathom","rows":[...]}. It labels the import and keeps each tool\'s files apart.',
    );
  if (input.source !== "other" && input.tool)
    throw badRequest(`tool is only for source other; ${input.source} is named by its source.`, "Leave tool out, or use source other.");
  if (input.report && input.source === "other")
    throw badRequest(
      "report takes a GA4 or Plausible API response.",
      "For other tools, map their data to rows: [{date, visitors, visits?, pageviews?, bounce_rate?, visit_duration?, page? | source? | country? | device?}].",
    );
  await enforce(
    [[ctx.env.API_INGEST_LIMITER, `acct:${ctx.accountId}`]],
    "ingest requests",
    "Send one file per request and retry in a minute.",
  );
  const site = await loadSite(ctx, siteId);
  let parsed: ParsedImport;
  try {
    parsed = input.report
      ? parseReport(
          input.source as "ga4" | "plausible",
          input.report,
          { dimensions: input.dimensions, metrics: input.metrics },
          input.kind,
          MAX_IMPORT_FILE_ROWS,
        )
      : input.rows
        ? parseRows(input.rows, input.kind)
        : parseImport(input.source, input.csv!, input.kind, MAX_IMPORT_FILE_ROWS);
  } catch (e) {
    if (e instanceof ImportError) throw new ApiError(400, "invalid_import", e.message, e.hint);
    throw e;
  }
  const standing = await accountStanding(ctx.env, ctx.accountId);
  const maxRows = siteCap(ctx.env, standing, "MAX_IMPORTED_ROWS_PER_SITE", DEFAULT_MAX_IMPORTED_ROWS_PER_SITE);
  const maxImports = siteCap(ctx.env, standing, "MAX_IMPORTS_PER_SITE", DEFAULT_MAX_IMPORTS_PER_SITE);
  const toolName = input.source === "other" ? input.tool! : null;
  const res = await callSite(ctx.env, site, (s) =>
    s.saveImport(
      newId("imp"),
      { source: input.source, tool: toolName, kind: parsed.kind, file_name: input.file_name ?? null },
      parsed.rows,
      {
        maxRows: Number.isFinite(maxRows) ? maxRows : 1e12,
        maxImports: Number.isFinite(maxImports) ? maxImports : 1e12,
      },
      limitVars(ctx.env),
    ),
  );
  const label = toolName ?? LABEL[input.source as keyof typeof LABEL];
  const more = input.report
    ? input.source === "ga4"
      ? "Run the report again with another breakdown (pagePath, sessionSource, country or deviceCategory) and import each the same way"
      : "Query again with another breakdown (event:page, visit:source, visit:country or visit:device) and import each the same way"
    : input.rows
      ? "Send other breakdowns (page, source, country or device) as their own rows the same way"
      : "Import the other files of the export the same way";
  const compare = `GET /v1/sites/${site.id}/imports/compare?source=${input.source}${toolName ? `&tool=${toolName}` : ""}`;
  const live = typeof res.live_data_from === "string" ? res.live_data_from : null;
  return {
    site_id: site.id,
    ...res,
    skipped_rows: parsed.skipped,
    next_steps: [
      `GET /v1/sites/${site.id}/stats?period=12mo&imported=true adds it to reports (also breakdowns by ${parsed.kind === "visitors" ? "page, source, country or device once those are imported" : "the imported dimension"} and timeseries).`,
      `${more}; GET /v1/sites/${site.id}/imports lists them.`,
      live
        ? `To check our numbers against ${label}, import its daily visitors (kind visitors) for the days since ${live} too, then ${compare}.`
        : `Once the tracker is live, import ${label}'s daily visitors for the same days and ${compare} checks our numbers against it.`,
    ],
  };
}

export async function listImports(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.listImports())) };
}

export const compareInput = z.object({
  source: z
    .enum(IMPORT_SOURCES)
    .optional()
    .describe("plausible, ga4 or other. Default: the source with the most days that overlap live data."),
  tool: tool.optional().describe("source other: which tool (default: the one with the most overlapping days)."),
});

export async function compareImport(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(compareInput, raw);
  const source = q.source ?? (q.tool ? "other" : undefined);
  if (q.tool && source !== "other")
    throw badRequest(`tool is only for source other; ${source} is named by its source.`, "Leave tool out, or use source=other.");
  const site = await loadSite(ctx, siteId);
  const res = await callSite(ctx.env, site, (s) => s.compareImports({ source, tool: q.tool }));
  return { site_id: site.id, ...res };
}

export async function deleteImport(ctx: Ctx, siteId: string, importId: string) {
  if (!/^imp_[0-9a-z]{16}$/.test(importId))
    throw notFound("Import", "Import ids look like imp_xxxxxxxxxxxxxxxx (GET /v1/sites/:id/imports).");
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.deleteImport(importId))) };
}
