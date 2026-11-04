/**
 * GA4 and Plausible CSV imports (lib/imports.ts parses, do/imports.ts stores and merges): POST
 * /v1/sites/:id/imports with the CSV (text/csv body or {csv}), idempotent per (source, kind, date
 * range); reports add them with imported=true.
 */

import { ApiError, accountStanding, badRequest, newId, notFound, parse } from "@afs/shared";
import { z } from "zod";
import { IMPORT_KINDS, IMPORT_SOURCES, ImportError, parseImport } from "../lib/imports";
import { enforce, limitVars, siteCap } from "../lib/limits";
import { type Ctx, callSite, loadSite } from "./context";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_FILE_ROWS = 50_000;
export const DEFAULT_MAX_IMPORTED_ROWS_PER_SITE = 500_000;
export const DEFAULT_MAX_IMPORTS_PER_SITE = 100;

export const importInput = z.object({
  source: z
    .enum(IMPORT_SOURCES)
    .describe(
      "plausible (its CSV export: imported_visitors, imported_pages, imported_sources, imported_locations, imported_devices) or ga4 (a report CSV with the Date dimension).",
    ),
  kind: z
    .enum(IMPORT_KINDS)
    .optional()
    .describe("visitors (daily totals), pages, sources, countries or devices. Default: detected from the columns."),
  file_name: z.string().max(200).optional(),
  csv: z.string().max(MAX_IMPORT_BYTES).optional().describe("The file's text (or send it as a text/csv body)."),
});

export async function importCsv(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(importInput, raw);
  if (!input.csv)
    throw badRequest(
      "Send the CSV: a text/csv body (with ?source=) or {source, csv}.",
      'Example: curl -X POST ".../imports?source=plausible" -H "content-type: text/csv" --data-binary @imported_pages.csv',
    );
  await enforce(
    [[ctx.env.API_INGEST_LIMITER, `acct:${ctx.accountId}`]],
    "ingest requests",
    "Send one file per request and retry in a minute.",
  );
  const site = await loadSite(ctx, siteId);
  let parsed: ReturnType<typeof parseImport>;
  try {
    parsed = parseImport(input.source, input.csv, input.kind, MAX_IMPORT_FILE_ROWS);
  } catch (e) {
    if (e instanceof ImportError) throw new ApiError(400, "invalid_import", e.message, e.hint);
    throw e;
  }
  const standing = await accountStanding(ctx.env, ctx.accountId);
  const maxRows = siteCap(ctx.env, standing, "MAX_IMPORTED_ROWS_PER_SITE", DEFAULT_MAX_IMPORTED_ROWS_PER_SITE);
  const maxImports = siteCap(ctx.env, standing, "MAX_IMPORTS_PER_SITE", DEFAULT_MAX_IMPORTS_PER_SITE);
  const res = await callSite(ctx.env, site, (s) =>
    s.saveImport(
      newId("imp"),
      { source: input.source, kind: parsed.kind, file_name: input.file_name ?? null },
      parsed.rows,
      {
        maxRows: Number.isFinite(maxRows) ? maxRows : 1e12,
        maxImports: Number.isFinite(maxImports) ? maxImports : 1e12,
      },
      limitVars(ctx.env),
    ),
  );
  return {
    site_id: site.id,
    ...res,
    skipped_rows: parsed.skipped,
    next_steps: [
      `GET /v1/sites/${site.id}/stats?period=12mo&imported=true adds it to reports (also breakdowns by ${parsed.kind === "visitors" ? "page, source, country or device once those files are imported" : "the imported dimension"} and timeseries).`,
      `Import the other files of the export the same way; GET /v1/sites/${site.id}/imports lists them.`,
    ],
  };
}

export async function listImports(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.listImports())) };
}

export async function deleteImport(ctx: Ctx, siteId: string, importId: string) {
  if (!/^imp_[0-9a-z]{16}$/.test(importId))
    throw notFound("Import", "Import ids look like imp_xxxxxxxxxxxxxxxx (GET /v1/sites/:id/imports).");
  const site = await loadSite(ctx, siteId);
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.deleteImport(importId))) };
}
