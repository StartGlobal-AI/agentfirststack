import { badRequest, notFound, parse } from "@afs/shared";
import type { z } from "zod";
import { chunkKey } from "../do/engine";
import { decodeCursor, type SessionFilters, type SessionSort, type TagFilter } from "../do/queries";
import { TAG_KEY_RE } from "../lib/derive";
import { validGlob } from "../lib/glob";
import { userIdForms } from "../lib/hash";
import { parseAnswerFilter } from "../lib/survey-def";
import { SESSION_ID_RE } from "../lib/protocol";
import type { PageRow, SessionRow } from "../lib/rows";
import { PeriodError, type Period, resolveRange } from "../lib/time";
import { buildTimeline, sessionJson, transcriptText } from "../lib/transcript";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import { type Ctx, loadSite, type SiteRow, siteStub } from "./context";
import { eventMatchFor } from "./event-definitions";
import { segmentById } from "./segments";
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
  if (v !== undefined && !validGlob(v.startsWith("!") ? v.slice(1) : v))
    throw badRequest(
      `${field} must be a path glob starting with "/" or "*" (a leading "!" negates).`,
      `Example: ${field}=/checkout* or ${field}=!/admin*`,
    );
}

/** "plan:pro", "plan", "!exp:B" -> tag filters. */
export function parseTagFilters(list: readonly string[] | undefined): TagFilter[] | undefined {
  if (!list?.length) return undefined;
  return list.map((raw) => {
    const not = raw.startsWith("!");
    const t = not ? raw.slice(1) : raw;
    const i = t.indexOf(":");
    const key = (i === -1 ? t : t.slice(0, i)).trim();
    if (!TAG_KEY_RE.test(key))
      throw badRequest(
        `tag ${JSON.stringify(raw.slice(0, 60))} is not key, key:value or !key:value.`,
        "Keys are letters, digits, _ . - (at most 50), e.g. tag=plan:pro or tag=!exp:B; several: tag=plan:pro,country_group:eu.",
      );
    return { key, ...(i === -1 ? {} : { value: t.slice(i + 1) }), ...(not ? { not: true } : {}) };
  });
}

/**
 * Validated filters for the DO, with the time range resolved (default: everything retained). Needs
 * the site: user_id is matched in every form the site stores it (hashed with hash_user_ids).
 */
export async function resolveFilters(
  ctx: Ctx,
  site: SiteRow,
  raw: FilterInput & { session_ids?: string[] },
  fallback: Period = "all",
): Promise<SessionFilters & { period: string; segment?: { id: string; name: string } }> {
  let q = raw;
  let segment: { id: string; name: string } | undefined;
  if (raw.segment_id) {
    const seg = await segmentById(ctx, site, raw.segment_id);
    const own = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    q = { ...seg.filters, ...own };
    segment = { id: seg.id, name: seg.name };
  }
  const f = toFilters(q, fallback);
  if (q.user_id) f.user_ids = await userIdForms(site.id, q.user_id, !!site.hash_user_ids);
  if (q.event) {
    const m = await eventMatchFor(ctx.env, site, q.event.startsWith("!") ? q.event.slice(1) : q.event);
    if (m) f.event_match = m;
  }
  return segment ? { ...f, segment } : f;
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
    referrer: q.referrer,
    region: q.region,
    city: q.city,
    min_pageviews: q.min_pageviews,
    min_active_ms: q.min_active !== undefined ? Math.round(q.min_active * 1000) : undefined,
    min_scroll_pct: q.min_scroll_pct,
    user_id: q.user_id,
    analytics_visitor_id: q.analytics_visitor_id,
    clicked: q.clicked,
    error_fingerprint: q.error_fingerprint,
    event: q.event,
    forced: q.forced,
    starred: q.starred,
    upgraded: q.upgraded,
    received_since: q.active ? Date.now() - 120_000 : undefined,
    label: q.label,
    tags: parseTagFilters(q.tag),
    ...surveyFilter(q.survey_id, q.survey_answer),
    session_ids: q.session_ids,
  };
}

function surveyFilter(id: string | undefined, answer: string | undefined): Pick<SessionFilters, "survey_id" | "survey_answer"> {
  if (answer !== undefined && !id) throw badRequest("survey_answer needs survey_id.", "Example: survey_id=rsv_...&survey_answer=q1<=6");
  if (!id) return {};
  if (answer === undefined) return { survey_id: id };
  const a = parseAnswerFilter(answer);
  if (!a) throw badRequest("survey_answer is <question id><op><value> with op <=, >=, = or !=.", "Examples: q1<=6, q1>=9, q2=Pricing.");
  if ((a.op === "<=" || a.op === ">=") && !Number.isFinite(Number(a.value)))
    throw badRequest(`survey_answer ${answer.slice(0, 60)}: <= and >= compare numbers.`, "Example: q1<=6.");
  return { survey_id: id, survey_answer: a };
}

/** A session in a list: numbers in the clear, page-derived strings under `untrusted`. */
export function sessionListItem(s: SessionRow) {
  const j = sessionJson(s);
  return {
    ...j,
    untrusted: {
      entry_path: s.entry_path,
      exit_path: s.exit_path,
      user_id: s.user_id,
      ...(s.upgraded ? { upgraded_reason: s.upgraded } : {}),
    },
  };
}

/** Labels of a page of sessions (one DO call). */
async function withLabels<T extends { id: string }>(ctx: Ctx, site: SiteRow, list: T[]): Promise<(T & { labels: string[] })[]> {
  const m = list.length ? await siteStub(ctx.env, site.id).labelsOf(list.map((s) => s.id)) : {};
  return list.map((s) => ({ ...s, labels: m[s.id] ?? [] }));
}

export async function searchSessions(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(searchInput, raw);
  if (q.format && q.format !== "json")
    throw badRequest(
      "Exports are a REST download or export_sessions.",
      `GET /v1/sites/${siteId}/sessions?format=${q.format} (MCP export_sessions).`,
    );
  const site = await loadSite(ctx, siteId);
  const f = await resolveFilters(ctx, site, q);
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
    ...(f.segment ? { segment: f.segment } : {}),
    sort,
    total: r.total,
    notice: UNTRUSTED_NOTICE,
    sessions: await withLabels(ctx, site, r.sessions.map(sessionListItem)),
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
    active_ms: p.active_ms ?? 0,
    max_scroll_pct: p.max_scroll,
    quick_back: !!p.quick_back,
    excessive_scroll: !!p.excessive_scroll,
    untrusted: { path: p.path, title: p.title, referrer: p.referrer },
  };
}

/** Tag rows as {key: [values]}. */
export const tagMap = (rows: readonly { key: string; value: string }[]) => {
  // no prototype: a stored key can never reach Object.prototype
  const out: Record<string, string[]> = Object.create(null);
  for (const r of rows) (out[r.key] ??= []).push(r.value);
  return out;
};

export async function getSession(ctx: Ctx, siteId: string, sessionId: string) {
  const site = await loadSite(ctx, siteId);
  const r = await sessionOr404(ctx, site, sessionId);
  return {
    site_id: site.id,
    session: {
      ...sessionListItem(r.session),
      labels: r.labels,
      untrusted: {
        ...sessionListItem(r.session).untrusted,
        tags: tagMap(r.tags),
        notes: r.notes.map((n) => ({ id: n.id, t_ms: n.t_ms, text: n.text })),
      },
    },
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
  const timeline = buildTimeline(d.session, d.pages, d.events, d.tags, d.notes);
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
      tags: tagMap(d.tags),
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
  const f = await resolveFilters(ctx, site, q);
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
    top_failed_requests,
    quick_back_pages,
    excessive_scroll_pages,
    not_clickable_but_clicked,
    entry_pages,
    exit_pages,
    common_journeys,
    top_tags,
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
      top_failed_requests,
      quick_back_pages,
      excessive_scroll_pages,
      not_clickable_but_clicked,
      entry_pages,
      exit_pages,
      common_journeys,
      top_tags,
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
      ? await siteStub(ctx.env, site.id).findVisitor({
          user_ids: q.user_id ? await userIdForms(site.id, q.user_id, !!site.hash_user_ids) : undefined,
          analytics_visitor_id: q.analytics_visitor_id,
        })
      : [];
  const ids = [...new Set([...found, ...(q.session_ids ?? [])])];
  const r = await deleteMany(ctx, site, ids);
  // Survey responses of the visitor whose sessions are already gone (linked ones went with their sessions).
  const responses = q.user_id
    ? await siteStub(ctx.env, site.id).deleteVisitorResponses(await userIdForms(site.id, q.user_id, !!site.hash_user_ids))
    : 0;
  return {
    site_id: site.id,
    deleted_sessions: r.deleted.length,
    session_ids: r.deleted,
    chunks_deleted: r.chunks,
    survey_responses_deleted_without_session: responses,
    note: `Recordings, derived events, signals, custom tags, notes, survey responses and share links of these sessions are deleted, and their ids refused for two days (open tabs don't record them again). Heatmap daily aggregates hold only per-element counts with no visitor or session reference, so they are unchanged. Sessions recorded without identify() or the analytics tracker can only be deleted by session id.${analyticsNote(site)}`,
  };
}

export const chunkKeyFor = (siteId: string, sid: string, seq: number) => `${siteId}/${chunkKey(sid, seq)}`;
