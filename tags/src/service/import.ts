import { ApiError, accountStanding, badRequest } from "@afs/shared";
import { z } from "zod";
import { diffConfigs } from "../config/diff";
import { GTM_SHAPES, type GtmShape, ImportShapeError, jsonDepth, MAX_IMPORT_BYTES, mapGtmExport } from "../config/gtm-import";
import { mergeConfigs } from "../config/merge";
import type { ContainerConfig } from "../config/schema";
import { parseConfig } from "../config/validate";
import type { Bindings } from "../env";
import { draftConfig, draftValidation, getContainerRow, type LastImport, recordImport } from "./containers";
import { editDraft } from "./draft-items";
import { assertDraftSize, invalidDraft } from "./versions";
import { assertCustomCodeSize } from "./verify";

export const importInput = z.strictObject({
  format: z
    .enum(["gtm", "afst"])
    .optional()
    .describe("gtm: a GTM container export (data). afst: this platform's own config (config). Default: detected from the body."),
  data: z
    .unknown()
    .optional()
    .describe(
      "GTM: the export file (GTM Admin > Export Container), its containerVersion on its own, or GTM API v2 / Tag Manager MCP lists { tag, trigger, variable, builtInVariable?, customTemplate? } (plural keys and list responses like { tag: { tag: [...] } } work too).",
    ),
  config: z.unknown().optional().describe("A config of this platform (GET /draft or GET /versions/:n -> config)."),
  mode: z.enum(["merge", "overwrite"]).optional().describe("merge (default): add to the draft by key; overwrite: replace the draft."),
  on_conflict: z
    .enum(["overwrite", "rename", "skip"])
    .optional()
    .describe("When an imported item's key is already in the draft (merge): overwrite (default), rename (add as <key>_2) or skip."),
  dry_run: z.boolean().optional().describe("Return the result and report without saving."),
});
export type ImportInput = z.infer<typeof importInput>;

export function assertImportSize(bytes: number) {
  if (bytes > MAX_IMPORT_BYTES)
    throw new ApiError(
      413,
      "import_too_large",
      `The import is ${bytes} bytes; the most accepted is ${MAX_IMPORT_BYTES}.`,
      "Export only the workspace you need from GTM, or import in parts (mode: merge).",
    );
}

export async function importDraft(env: Bindings, accountId: string, id: string, input: ImportInput, revision?: number) {
  const format = input.format ?? (input.data !== undefined ? "gtm" : "afst");
  const src = format === "gtm" ? input.data : input.config;
  if (src === undefined)
    throw badRequest(
      format === "gtm" ? "Missing data: the GTM container." : "Missing config.",
      format === "gtm"
        ? `Send { "format": "gtm", "data": ... }: ${GTM_SHAPES}`
        : 'Send { "config": { "tags": [...], ... } } (or { "format": "gtm", "data": ... } for a GTM export or Tag Manager API lists).',
    );
  // MCP inputs arrive already parsed; REST checks the raw body size before parsing (routes/v1.ts).
  assertImportSize(new TextEncoder().encode(JSON.stringify(src)).byteLength);
  if (jsonDepth(src) > 24) throw badRequest("The import is nested too deeply.", "Send the export as GTM produced it.");

  let incoming: ContainerConfig;
  let report: ReturnType<typeof mapGtmExport>["report"] | undefined;
  let gtm: { shape: GtmShape; notes: string[] } | undefined;
  if (format === "gtm") {
    try {
      const m = mapGtmExport(src);
      ({ config: incoming, report } = m);
      gtm = { shape: m.shape, notes: m.notes };
    } catch (e) {
      if (e instanceof ImportShapeError)
        throw new ApiError(400, "invalid_import", e.message, `Send { "format": "gtm", "data": ... }: ${GTM_SHAPES}`, e.issues);
      throw e;
    }
  } else {
    const parsed = parseConfig(src);
    if (!parsed.ok) throw invalidDraft(parsed.errors);
    incoming = parsed.config;
  }
  const mode = input.mode ?? "merge";
  const on_conflict = input.on_conflict ?? "overwrite";
  const run = (base: ContainerConfig) => mergeConfigs(base, incoming, { mode, on_conflict });

  if (input.dry_run) {
    const row = await getContainerRow(env, accountId, id);
    const before = draftConfig(row);
    const { config, counts } = run(before);
    const parsed = parseConfig(config);
    if (!parsed.ok) throw invalidDraft(parsed.errors);
    const standing = await accountStanding(env, row.account_id);
    assertDraftSize(env, JSON.stringify(parsed.config), standing);
    assertCustomCodeSize(env, parsed.config, standing);
    return {
      row,
      dry_run: true,
      written: false,
      format,
      gtm,
      last_import: null as LastImport | null,
      mode,
      on_conflict,
      counts,
      report,
      config: parsed.config,
      changes: diffConfigs(before, parsed.config),
      validation: await draftValidation(env, row, parsed.config),
    };
  }
  let before: ContainerConfig = {};
  const r = await editDraft(env, accountId, id, revision, (base) => {
    before = structuredClone(base);
    const m = run(base);
    return { config: m.config, result: m.counts };
  });
  // Remembered on the container (GET /v1/containers/:id -> container.last_import), also when the
  // draft already had everything (written: false): the import was still done.
  const last_import = importRecord(format, mode, r.result, report);
  await recordImport(env, id, last_import);
  return {
    row: r.row,
    dry_run: false,
    written: r.written,
    format,
    gtm,
    last_import: last_import as LastImport | null,
    mode,
    on_conflict,
    counts: r.result,
    report,
    config: r.config,
    changes: diffConfigs(before, r.config),
    validation: await draftValidation(env, r.row, r.config),
  };
}

/**
 * What container.last_import keeps. Per kind: the imported items now in the draft (added,
 * replaced, renamed or already identical). skipped: what the import didn't bring in (GTM items
 * in report.unmapped, plus items on_conflict "skip" left out).
 */
export function importRecord(
  format: "gtm" | "afst",
  mode: "merge" | "overwrite",
  counts: ReturnType<typeof mergeConfigs>["counts"],
  report: { unmapped: unknown[] } | undefined,
  at = Date.now(),
): LastImport {
  const n = (k: keyof typeof counts) =>
    counts[k].added.length + counts[k].replaced.length + counts[k].renamed.length + counts[k].unchanged.length;
  const skipped = Object.values(counts).reduce((s, c) => s + c.skipped.length, 0) + (report?.unmapped.length ?? 0);
  return {
    at,
    format,
    mode,
    summary: { tags: n("tags"), triggers: n("triggers"), variables: n("variables"), conversions: n("conversions"), skipped },
  };
}
