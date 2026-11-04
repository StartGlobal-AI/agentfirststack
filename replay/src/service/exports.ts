import { accountStanding, ApiError, badRequest, notFound, parse } from "@afs/shared";
import { z } from "zod";
import { chunkKey } from "../do/engine";
import type { SessionSort } from "../do/queries";
import { gunzipCapped } from "../lib/body";
import { toCsv } from "../lib/csv";
import { userIdForms } from "../lib/hash";
import { cap, DEFAULTS, LIMITS } from "../lib/limits";
import { SESSION_ID_RE } from "../lib/protocol";
import type { SessionRow } from "../lib/rows";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import { llmsTxt } from "../llms";
import { type Ctx, loadSite, siteStub } from "./context";
import { int, searchInput } from "./schemas";
import { resolveFilters, sessionListItem, tagMap } from "./sessions";
import type { RawExport } from "./surveys";

/**
 * Exports and small reads: the session list as CSV / NDJSON, one session's raw rrweb events,
 * everything stored about one visitor (a data-access request), and the manual by section.
 */

const COLUMNS = [
  "id",
  "started_at",
  "duration_ms",
  "active_ms",
  "pageviews",
  "clicks",
  "inputs",
  "errors",
  "api_errors",
  "rage_clicks",
  "dead_clicks",
  "dead_interactive",
  "error_clicks",
  "quick_backs",
  "excessive_scrolls",
  "frustration",
  "device",
  "browser",
  "browser_version",
  "os",
  "country",
  "region",
  "city",
  "entry_path",
  "exit_path",
  "referrer",
  "user_id",
  "analytics_visitor_id",
  "starred",
  "forced",
  "upgraded",
  "limited",
] as const;

const exportRows = (ctx: Ctx, standing: Awaited<ReturnType<typeof accountStanding>>) =>
  Math.min(100_000, cap(ctx.env, standing, "MAX_EXPORT_ROWS", DEFAULTS.EXPORT_ROWS) ?? 100_000);

/** GET /sessions?format=csv|ndjson (and MCP export_sessions): every matching session, in `sort` order, up to MAX_EXPORT_ROWS. */
export async function exportSessions(ctx: Ctx, siteId: string, raw: unknown, opts: { maxRows?: number } = {}): Promise<RawExport> {
  const q = parse(searchInput.extend({ limit: int(1, 100_000).optional() }), raw);
  const format = q.format === "ndjson" ? "ndjson" : "csv";
  const site = await loadSite(ctx, siteId);
  const f = await resolveFilters(ctx, site, q);
  const sort: SessionSort = q.sort ?? "recent";
  const max = Math.min(
    opts.maxRows ?? Number.POSITIVE_INFINITY,
    q.limit ?? Number.POSITIVE_INFINITY,
    exportRows(ctx, await accountStanding(ctx.env, ctx.accountId)),
  );
  const stub = siteStub(ctx.env, site.id);
  const rows: SessionRow[] = [];
  let cursor: [number, number, string] | null = null;
  while (rows.length < max) {
    const page = await stub.search({ ...f, sort, limit: Math.min(1000, max - rows.length), cursor });
    rows.push(...(page.sessions as SessionRow[]));
    if (!page.next_cursor) break;
    const last = page.sessions[page.sessions.length - 1]!;
    const col = {
      frustration: "frustration",
      recent: "started_at",
      duration: "duration_ms",
      clicks: "clicks",
      pageviews: "pageviews",
      active: "active_ms",
    }[sort];
    cursor = [Number((last as unknown as Record<string, number>)[col] ?? 0), last.started_at, last.id];
  }
  const value = (r: SessionRow, c: (typeof COLUMNS)[number]) =>
    c === "started_at"
      ? new Date(r.started_at).toISOString()
      : c === "starred" || c === "forced"
        ? !!r[c]
        : ((r as unknown as Record<string, unknown>)[c] ?? null);
  const body =
    format === "csv"
      ? toCsv(
          COLUMNS,
          rows.map((r) => COLUMNS.map((c) => value(r, c))),
        )
      : rows.map((r) => JSON.stringify(Object.fromEntries(COLUMNS.map((c) => [c, value(r, c)])))).join("\n") + (rows.length ? "\n" : "");
  return {
    raw: true,
    format,
    content_type: format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
    filename: `${site.id}-sessions.${format}`,
    body,
    rows: rows.length,
  };
}

export const eventsInput = z.object({
  from_seq: int(0, 100_000).optional().describe("First chunk (default 0)."),
  to_seq: int(0, 100_000).optional().describe("Last chunk (default: as many as fit)."),
  max_bytes: int(10_000, 20 * 1_048_576)
    .optional()
    .describe("Most decompressed bytes returned (default 5 MB, max 20 MB; MCP: 512 KB)."),
});

/**
 * GET /sessions/:sid/events: the session's rrweb events as NDJSON (one event per line, in chunk
 * order), as recorded (masked in the browser). Paged by chunk: next_seq says where to go on.
 * Charged against the site's daily export budget (MAX_EXPORT_BYTES_PER_DAY, compressed bytes).
 */
export async function sessionEvents(ctx: Ctx, siteId: string, sessionId: string, raw: unknown, opts: { maxBytes?: number } = {}) {
  const q = parse(eventsInput, raw);
  const site = await loadSite(ctx, siteId);
  if (!SESSION_ID_RE.test(sessionId)) throw notFound("Session", "Session ids look like rs_xxxxxxxxxxxxxxxx (from search_sessions).");
  const stub = siteStub(ctx.env, site.id);
  const s = await stub.session(sessionId);
  if (!s) throw notFound("Session", `GET /v1/sites/${site.id}/sessions lists recorded sessions.`);
  const budget = cap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_EXPORT_BYTES_PER_DAY", DEFAULTS.EXPORT_BYTES_PER_DAY);
  const max = Math.min(opts.maxBytes ?? 20 * 1_048_576, q.max_bytes ?? 5 * 1_048_576);
  const seqs = (await stub.playable(sessionId, LIMITS.CHUNKS_PER_SESSION)).filter(
    (n) => n >= (q.from_seq ?? 0) && (q.to_seq === undefined || n <= q.to_seq),
  );
  const lines: string[] = [];
  let bytes = 0;
  let next: number | null = null;
  let over = false;
  for (const seq of seqs) {
    if (bytes >= max) {
      next = seq;
      break;
    }
    const ok = await stub.exportChunk({ session_id: sessionId, seq, budget });
    if (!ok.ok) {
      if (ok.reason === "budget") {
        over = true;
        next = seq;
        break;
      }
      continue;
    }
    const obj = await ctx.env.CHUNKS.get(`${site.id}/${chunkKey(sessionId, seq)}`);
    if (!obj) continue;
    const r = await gunzipCapped(new Uint8Array(await obj.arrayBuffer()), LIMITS.DECOMPRESSED_BYTES);
    if ("error" in r) continue;
    let ev: unknown[] = [];
    try {
      ev = (JSON.parse(r.text) as { ev?: unknown[] }).ev ?? [];
    } catch {
      continue;
    }
    for (const e of ev) lines.push(JSON.stringify(e));
    bytes += r.text.length;
  }
  if (over && !lines.length)
    throw new ApiError(
      429,
      "rate_limited",
      "This site exported its daily share of recording data (MAX_EXPORT_BYTES_PER_DAY).",
      "It works again tomorrow (UTC); share links have their own budget.",
    );
  return { body: lines.join("\n") + (lines.length ? "\n" : ""), events: lines.length, next_seq: next, chunks: seqs.length };
}

export const visitorInput = z.object({
  user_id: z
    .string()
    .max(200)
    .optional()
    .describe("The id the page passed to afsr('identify') (raw: hashed here when the site hashes ids)."),
  analytics_visitor_id: z.string().max(64).optional().describe("The analytics visitor id (afsa.visitorId())."),
});

/** GET /visitors (MCP get_visitor): what is stored about one visitor; the answer to a data-access request. */
export async function getVisitor(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(visitorInput, raw);
  if (!q.user_id && !q.analytics_visitor_id)
    throw badRequest("Say whose data.", "Pass user_id (afsr('identify')) or analytics_visitor_id, e.g. ?user_id=u_123.");
  const site = await loadSite(ctx, siteId);
  const user_ids = q.user_id ? await userIdForms(site.id, q.user_id, !!site.hash_user_ids) : undefined;
  const v = await siteStub(ctx.env, site.id).visitor({ user_ids, analytics_visitor_id: q.analytics_visitor_id });
  return {
    site_id: site.id,
    sessions_total: v.session_count,
    notice: UNTRUSTED_NOTICE,
    sessions: (v.sessions as SessionRow[]).map(sessionListItem),
    untrusted: {
      tags: tagMap(v.tags),
      survey_responses: v.responses.map(({ answers, element, ...r }) => ({ ...r, answers, element })),
    },
    notes_on_sessions: v.notes,
    what_is_stored:
      "Per session: device class, browser, OS, country/region/city, a 16-hex prefix of the user agent's hash, the id passed to identify, the analytics visitor id, the pages visited (paths without query strings), clicks (selectors, masked labels), fields typed into (never values), scroll, errors, custom events and tags, and the masked DOM recording. Never the IP address.",
    next_steps: [`Delete all of it: POST /v1/sites/${site.id}/delete-visitor-data with the same id (MCP delete_visitor_data).`],
  };
}

export const manualInput = z.object({
  section: z.string().max(80).optional().describe('A section title or part of it ("surveys", "webhooks", "filters"); omit for the list.'),
});

/** The manual (llms.txt) by section: MCP get_manual, GET /v1/manual. */
export function getManual(ctx: Ctx, raw: unknown) {
  const q = parse(manualInput, raw);
  const text = llmsTxt(ctx.baseUrl);
  const parts = text.split(/\n(?=##+ )/);
  const titles = parts.map((p) => /^(#+ .+)$/m.exec(p)?.[1] ?? "").filter((t) => t.startsWith("##"));
  if (!q.section)
    return { sections: titles, hint: "Pass section (a title or part of it) for its text; GET /llms.txt is the whole manual." };
  const want = q.section.toLowerCase();
  const hits = parts.filter((p) => (/^(#+ .+)$/m.exec(p)?.[1] ?? "").toLowerCase().includes(want));
  if (!hits.length) throw notFound("Manual section", `Sections: ${titles.map((t) => t.replace(/^#+ /, "")).join("; ")}.`);
  return { section: q.section, text: hits.join("\n") };
}
