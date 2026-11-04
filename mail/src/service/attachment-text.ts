import { ApiError, badRequest } from "@afs/shared";
import { type AppEnv, type Standing, cap, standingOf } from "../env";
import { assertActive, dailyLimitError, refundDaily, reserveDaily } from "./budgets";
import { getAttachment } from "./messages";

/**
 * GET /v1/messages/:id/attachments/:aid/text: a document attachment (PDF, Word, Excel,
 * OpenDocument, CSV, HTML, XML) as Markdown, through Workers AI toMarkdown
 * (developers.cloudflare.com/workers-ai/features/markdown-conversion/). On demand, never at
 * ingest; only on deployments with an AI binding (the generic template has none: 501 without it).
 *
 *   - At most 10 MB in and MAX_TEXT_CHARS out; images are not converted (no vision models, so the
 *     cost per call stays the document conversion's), and embedded images are skipped.
 *   - MAX_ATTACHMENT_TEXT_PER_DAY conversions per account per UTC day (default 20, 5 unclaimed).
 *   - Not cached: each call converts again and counts once.
 * The text is the sender's: REST marks it untrusted, MCP fences it.
 */

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 250_000;
export const DEFAULT_ATTACHMENT_TEXT_PER_DAY = 20;
export const DEFAULT_UNCLAIMED_ATTACHMENT_TEXT_PER_DAY = 5;

/** Document types toMarkdown converts (images left out on purpose). */
const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "text/csv": "csv",
  "text/html": "html",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/vnd.apple.numbers": "numbers",
};
const EXTENSIONS = new Set(Object.values(DOCUMENT_TYPES));

export const attachmentTextPerDay = (env: AppEnv, standing: Standing) =>
  cap(
    env,
    standing,
    "MAX_ATTACHMENT_TEXT_PER_DAY",
    standing.claimed ? DEFAULT_ATTACHMENT_TEXT_PER_DAY : DEFAULT_UNCLAIMED_ATTACHMENT_TEXT_PER_DAY,
  );

/** The document kind of an attachment from its type, else its extension; null = not convertible. Pure. */
export function documentKind(contentType: string | null, filename: string | null): string | null {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (DOCUMENT_TYPES[t]) return DOCUMENT_TYPES[t]!;
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  return EXTENSIONS.has(ext) && (t === "" || t === "application/octet-stream") ? ext : null;
}

export async function getAttachmentText(env: AppEnv, accountId: string, messageId: string, attachmentId: string, now = Date.now()) {
  if (!env.AI)
    throw new ApiError(
      501,
      "not_available",
      "Attachment text is not enabled on this deployment (no Workers AI binding).",
      `Download the file (GET /v1/messages/${messageId}/attachments/${attachmentId}) and read it locally. Operators: add an "ai" binding named AI to the deploy config.`,
    );
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const { meta, open } = await getAttachment(env, accountId, messageId, attachmentId);
  const kind = documentKind(meta.content_type, meta.filename);
  if (!kind)
    throw badRequest(
      `${meta.filename ?? "This attachment"} (${meta.content_type ?? "unknown type"}) is not a document this can convert.`,
      "Supported: PDF, Word (docx), Excel (xlsx/xls), OpenDocument (odt/ods), Numbers, CSV, HTML, XML. Images are not converted; download them instead.",
    );
  if (meta.size > MAX_INPUT_BYTES)
    throw badRequest(
      `The attachment is ${Math.round(meta.size / 1048576)} MB; at most 10 MB are converted.`,
      "Download it and read it locally.",
    );
  const limit = attachmentTextPerDay(env, standing);
  const budget = await reserveDaily(env, accountId, "attachment_text", limit, now);
  if (!budget.ok)
    throw dailyLimitError(
      `this account converted ${limit} attachments today`,
      limit,
      "Download attachments and read them locally, or wait.",
    );
  try {
    const bytes = new Uint8Array(await new Response(await open()).arrayBuffer());
    const name = (meta.filename ?? `attachment.${kind}`).replace(/[\\/]/g, "_");
    const res = await env.AI.toMarkdown(
      {
        name: name.toLowerCase().endsWith(`.${kind}`) ? name : `${name}.${kind}`,
        blob: new Blob([bytes], { type: meta.content_type ?? "" }),
      },
      {
        conversionOptions: {
          html: { images: { convert: false, convertOGImage: false } },
          docx: { images: { convert: false } },
          pdf: { images: { convert: false }, metadata: false },
        },
      },
    );
    if (res.format === "error")
      throw new ApiError(
        422,
        "conversion_failed",
        `Could not convert ${meta.filename ?? "the attachment"}: ${res.error}`,
        "Download it and read it locally.",
      );
    const truncated = res.data.length > MAX_TEXT_CHARS;
    return {
      attachment: { id: meta.id, filename: meta.filename, content_type: meta.content_type, size: meta.size },
      format: "markdown" as const,
      text: truncated ? res.data.slice(0, MAX_TEXT_CHARS) : res.data,
      truncated,
      tokens: res.tokens,
      daily: { used: budget.used, limit: Number.isFinite(limit) ? limit : null },
    };
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "conversion_failed")) await refundDaily(env, accountId, "attachment_text", budget.day);
    throw e;
  }
}
