import { badRequest, notFound, parse } from "@afs/shared";
import type { z } from "zod";
import { chunkKey } from "../do/engine";
import { decodeCursor, type SessionFilters, type SessionSort } from "../do/queries";
import { validGlob } from "../lib/glob";
import { SESSION_ID_RE } from "../lib/protocol";
import type { PageRow, SessionRow } from "../lib/rows";
import { PeriodError, type Period, resolveRange } from "../lib/time";
import { buildTimeline, sessionJson, transcriptText } from "../lib/transcript";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import { type Ctx, loadSite, type SiteRow, siteStub } from "./context";
import { deleteVisitorInput, filtersShape, searchInput, summarizeInput, transcriptInput } from "./schemas";

type FilterInput = z.infer<z.ZodObject<typeof filtersShape>>;

export function range(q: { period?: string; from?: string | number; to?: string | number }, fallback: Period) {
  try {
    return resolveRange(q, Date.now(), fallback);
  } catch (e) {
    if (e instanceof PeriodError) throw badRequest(e.message, "Example: period=7d, or from=2026-11-01&to=2026-11-03.");
    throw e;
  }
}

function checkGlob(field: string, v: string | undefined) {
  if (v !== undefined && !validGlob(v))
    throw badRequest(`${field} must be a path glob starting with "/" or "*".`, `Example: ${field}=/checkout*`);
}

/** Validated filters for the DO, with the time range resolved (default: everything retained). */
export function toFilters(q: FilterInput & { session_ids?: string[] }, fallback: Period = "all"): SessionFilters & { period: string } {
  checkGlob("page", q.page);
  checkGlob("entry_page", q.entry_page);
  checkGlob("exit_page", q.exit_page);
  const r = range(q, fallback);
  return {
    start: r.start,
    end: r.end,
    period: r.period,
    page: q.page,
    entry_page: q.entry_page,
    exit_page: q.exit_page,
    signal: q.signal,
    has_error: q.has_error,
    device: q.device,
    browser: q.browser,
    os: q.os,
    country: q.country,
    min_duration_ms: q.min_duration !== undefined ? Math.round(q.min_duration * 1000) : undefined,
    max_duration_ms: q.max_duration !== undefined ? Math.round(q.max_duration * 1000) : undefined,
    min_frustration: q.min_frustration,
    user_id: q.user_id,
    analytics_visitor_id: q.analytics_visitor_id,
    clicked: q.clicked,
    error_fingerprint: q.error_fingerprint,
    event: q.event,
    forced: q.forced,
    session_ids: q.session_ids,
  };
}

/** A session in a list: numbers in the clear, page-derived strings under `untrusted`. */
export function sessionListItem(s: SessionRow) {
  const j = sessionJson(s);
  return { ...j, untrusted: { entry_path: s.entry_path, exit_path: s.exit_path, user_id: s.user_id } };
}

export async function searchSessions(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(searchInput, raw);
  const site = await loadSite(ctx, siteId);
  const f = toFilters(q);
  let cursor = null;
  if (q.cursor) {
    cursor = decodeCursor(q.cursor);
    if (!cursor) throw badRequest("Invalid cursor.", "Pass next_cursor exactly as returned, with the same filters and sort.");
  }
  const sort: SessionSort = q.sort ?? "frustration";
  const r = await siteStub(ctx.env, site.id).search({ ...f, sort, limit: q.limit ?? 20, cursor });
  return {
    site_id: site.id,
    period: { name: f.period, start: f.start, end: f.end },
    sort,
    total: r.total,
    notice: UNTRUSTED_NOTICE,
    sessions: r.sessions.map(sessionListItem),
    next_cursor: r.next_cursor,
    next_steps: r.sessions.length
      ? [
          `Read one: GET /v1/sites/${site.id}/sessions/${r.sessions[0]!.id}/transcript (MCP get_session_transcript).`,
          `Patterns across them: GET /v1/sites/${site.id}/summary with the same filters (MCP summarize_sessions).`,
        ]
      : [
          r.total === 0 && !q.signal && !q.page
            ? `No sessions recorded yet. Check the install with POST /v1/sites/${site.id}/verify, and open https://${site.domain}/?afsr=1 to force one.`
            : "No session matches these filters; widen period or drop a filter.",
        ],
  };
}

async function sessionOr404(ctx: Ctx, site: SiteRow, sessionId: string) {
  if (!SESSION_ID_RE.test(sessionId)) throw notFound("Session", "Session ids look like rs_xxxxxxxxxxxxxxxx (from search_sessions).");
  const r = await siteStub(ctx.env, site.id).session(sessionId);
  if (!r)
    throw notFound(
      "Session",
      `GET /v1/sites/${site.id}/sessions lists recorded sessions (they are kept retention_days, ${site.retention_days} for this site).`,
    );
  return r;
}

function pageJson(p: PageRow) {
  return {
    pv: p.pv,
    ts: p.ts,
    nav: p.nav,
    stayed_ms: p.left_at !== null ? p.left_at - p.ts : null,
    max_scroll_pct: p.max_scroll,
    quick_back: !!p.quick_back,
    excessive_scroll: !!p.excessive_scroll,
    untrusted: { path: p.path, title: p.title, referrer: p.referrer },
  };
}

export async function getSession(ctx: Ctx, siteId: string, sessionId: string) {
  const site = await loadSite(ctx, siteId);
  const r = await sessionOr404(ctx, site, sessionId);
  return {
    site_id: site.id,
    session: sessionListItem(r.session),
    notice: UNTRUSTED_NOTICE,
    pages: r.pages.map(pageJson),
    chunks: r.chunks.length,
    next_steps: [
      `Timeline: GET /v1/sites/${site.id}/sessions/${sessionId}/transcript (MCP get_session_transcript).`,
      `For a person: POST /v1/sites/${site.id}/links {"session_id":"${sessionId}"} returns an expiring player link (MCP create_replay_link).`,
    ],
  };
}

export async function getTranscript(ctx: Ctx, siteId: string, sessionId: string, raw: unknown) {
  const q = parse(transcriptInput, raw);
  const site = await loadSite(ctx, siteId);
  if (!SESSION_ID_RE.test(sessionId)) throw notFound("Session", "Session ids look like rs_xxxxxxxxxxxxxxxx (from search_sessions).");
  const maxEvents = q.max_events ?? 500;
  const d = await siteStub(ctx.env, site.id).transcript(sessionId, { maxEvents, kinds: q.kinds ?? null });
  if (!d)
    throw notFound(
      "Session",
      `GET /v1/sites/${site.id}/sessions lists recorded sessions (kept ${site.retention_days} days for this site).`,
    );
  const timeline = buildTimeline(d.session, d.pages, d.events);
  const format = q.format ?? "text";
  const base = { site_id: site.id, session: sessionJson(d.session), format, truncated: d.truncated };
  if (format === "text")
    return { ...base, transcript: transcriptText(d.session, timeline, { maxEvents, siteDomain: site.domain, truncated: d.truncated }) };
  return {
    ...base,
    untrusted: {
      notice: UNTRUSTED_NOTICE,
      entry_path: d.session.entry_path,
      exit_path: d.session.exit_path,
      user_id: d.session.user_id,
      timeline,
    },
    ...(d.truncated ? { hint: "More events exist: raise max_events (up to 5000) or narrow with kinds=click,error." } : {}),
  };
}

export async function summarize(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(summarizeInput, raw);
  const site = await loadSite(ctx, siteId);
  if (q.session_ids?.some((id) => !SESSION_ID_RE.test(id)))
    throw badRequest("session_ids must be rs_... ids.", "Take them from search_sessions (sessions[].id).");
  const f = toFilters(q);
  const sort: SessionSort = q.sort ?? "frustration";
  const r = await siteStub(ctx.env, site.id).summarize({ ...f, sort, limit: q.session_ids?.length ?? q.limit ?? 200, top: q.top ?? 10 });
  if ("empty" in r)
    return {
      site_id: site.id,
      sessions_matching: r.sessions_matching,
      sessions_considered: 0,
      next_steps: ["No session matches; widen the period or drop filters (search_sessions shows what exists)."],
    };
  const { findings, ...rest } = r;
  const {
    top_rage_targets,
    top_dead_clicks,
    top_error_clicks,
    top_errors,
    quick_back_pages,
    excessive_scroll_pages,
    not_clickable_but_clicked,
    entry_pages,
    exit_pages,
    common_journeys,
    ...numbers
  } = rest;
  return {
    site_id: site.id,
    period: { name: f.period, start: f.start, end: f.end },
    ...numbers,
    method:
      "Deterministic grouping over the sessions' derived events (no model). Groups are sorted by the number of sessions they occur in.",
    untrusted: {
      notice: UNTRUSTED_NOTICE,
      findings,
      top_rage_targets,
      top_dead_clicks,
      top_error_clicks,
      top_errors,
      quick_back_pages,
      excessive_scroll_pages,
      not_clickable_but_clicked,
      entry_pages,
      exit_pages,
      common_journeys,
    },
    next_steps: ["Read the example_session_ids with get_session_transcript to see each pattern in context."],
  };
}

/** The site's DO deletes rows, tombstones the ids and deletes the chunks from R2 (retried until R2 confirms). */
async function deleteMany(ctx: Ctx, site: SiteRow, ids: string[]) {
  const stub = siteStub(ctx.env, site.id);
  const deleted: string[] = [];
  let chunks = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const r = await stub.deleteSessions(ids.slice(i, i + 200));
    deleted.push(...r.deleted);
    chunks += r.chunks;
  }
  if (deleted.length) {
    for (let i = 0; i < deleted.length; i += 50) {
      const part = deleted.slice(i, i + 50);
      await ctx.env.DB.prepare(`DELETE FROM replay_links WHERE site_id = ? AND session_id IN (${part.map(() => "?").join(", ")})`)
        .bind(site.id, ...part)
        .run();
    }
  }
  return { deleted, chunks };
}

/** Said with deletions when the site is linked: what replay can't delete on the analytics side. */
const analyticsNote = (site: SiteRow) =>
  site.analytics_site_id
    ? ` Signal events already forwarded to the linked analytics site (${site.analytics_site_id}) stay there: analytics has no per-visitor deletion API yet; delete that analytics data there if needed.`
    : "";

export async function deleteSession(ctx: Ctx, siteId: string, sessionId: string) {
  const site = await loadSite(ctx, siteId);
  await sessionOr404(ctx, site, sessionId);
  const r = await deleteMany(ctx, site, [sessionId]);
  return {
    deleted: sessionId,
    chunks_deleted: r.chunks,
    note: `The recording, its derived events and signals, and its share links are gone; the session id is refused for two days so an open tab can't record it again.${analyticsNote(site)}`,
  };
}

export async function deleteVisitorData(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(deleteVisitorInput, raw);
  if (!q.user_id && !q.analytics_visitor_id && !q.session_ids?.length)
    throw badRequest(
      "Say whose data to delete.",
      'Pass user_id (afsr(\'identify\')), analytics_visitor_id (afsa.visitorId()) or session_ids, e.g. {"user_id":"u_123"}.',
    );
  if (q.session_ids?.some((id) => !SESSION_ID_RE.test(id)))
    throw badRequest("session_ids must be rs_... ids.", "Take them from search_sessions.");
  const site = await loadSite(ctx, siteId);
  const found =
    q.user_id || q.analytics_visitor_id
      ? await siteStub(ctx.env, site.id).findVisitor({ user_id: q.user_id, analytics_visitor_id: q.analytics_visitor_id })
      : [];
  const ids = [...new Set([...found, ...(q.session_ids ?? [])])];
  const r = await deleteMany(ctx, site, ids);
  return {
    site_id: site.id,
    deleted_sessions: r.deleted.length,
    session_ids: r.deleted,
    chunks_deleted: r.chunks,
    note: `Recordings, derived events, signals and share links of these sessions are deleted, and their ids refused for two days (open tabs don't record them again). Heatmap daily aggregates hold only per-element counts with no visitor or session reference, so they are unchanged. Sessions recorded without identify() or the analytics tracker can only be deleted by session id.${analyticsNote(site)}`,
  };
}

export const chunkKeyFor = (siteId: string, sid: string, seq: number) => `${siteId}/${chunkKey(sid, seq)}`;
