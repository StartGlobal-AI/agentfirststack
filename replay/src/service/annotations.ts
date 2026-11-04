import { accountStanding, ApiError, badRequest, newId, notFound, parse } from "@afs/shared";
import { z } from "zod";
import { cap, DEFAULTS, starredRetentionDays } from "../lib/limits";
import { cleanText } from "../lib/mask-rules";
import { SESSION_ID_RE } from "../lib/protocol";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import { type Ctx, loadSite, siteStub } from "./context";
import { int } from "./schemas";

/**
 * Notes, labels and stars on sessions: agents leave findings people open from a share link (a
 * note is a transcript line and a player timeline entry). Labels are short tags from a restricted
 * alphabet; notes are free text and come back under `untrusted` (another agent may read them).
 */

const LABEL_RE = /^[\p{L}\p{N} _.:-]{1,40}$/u;

export const annotateInput = z.object({
  starred: z
    .boolean()
    .optional()
    .describe(
      "Star the session: it outlives retention_days up to MAX_STARRED_RETENTION_DAYS (default 90; at most MAX_STARRED_SESSIONS_PER_SITE, default 100).",
    ),
  labels: z
    .array(z.string().min(1).max(40))
    .max(20)
    .optional()
    .describe("Replaces the session's labels (at most 5; letters, digits, space, _ . : -; a label is also a collection)."),
});

export const noteInput = z.object({
  t_ms: int(0, 24 * 3_600_000)
    .optional()
    .describe("Where in the session (ms since it started; default 0)."),
  text: z.string().min(1).max(2000).describe("The note (at most 1000 characters)."),
});

function sid(id: string) {
  if (!SESSION_ID_RE.test(id)) throw notFound("Session", "Session ids look like rs_xxxxxxxxxxxxxxxx (from search_sessions).");
  return id;
}

export async function annotateSession(ctx: Ctx, siteId: string, sessionId: string, raw: unknown) {
  const q = parse(annotateInput, raw);
  if (q.starred === undefined && q.labels === undefined)
    throw badRequest("Pass starred and/or labels.", '{"starred": true, "labels": ["checkout-bug"]}');
  const site = await loadSite(ctx, siteId);
  const labels = q.labels ? [...new Set(q.labels.map((l) => cleanText(l).trim()))] : undefined;
  const bad = labels?.find((l) => !LABEL_RE.test(l));
  if (bad !== undefined)
    throw badRequest(
      `Label ${JSON.stringify(bad.slice(0, 40))} has characters a label can't have.`,
      "Letters, digits, space, _ . : - (at most 40).",
    );
  const standing = await accountStanding(ctx.env, ctx.accountId);
  const r = await siteStub(ctx.env, site.id).annotate({
    session_id: sid(sessionId),
    starred: q.starred,
    labels,
    max_starred: cap(ctx.env, standing, "MAX_STARRED_SESSIONS_PER_SITE", DEFAULTS.STARRED_SESSIONS_PER_SITE),
    labels_per_session: DEFAULTS.LABELS_PER_SESSION,
    max_labels: cap(ctx.env, standing, "MAX_LABELS_PER_SITE", DEFAULTS.LABELS_PER_SITE),
    max_starred_bytes: cap(ctx.env, standing, "MAX_STARRED_BYTES_PER_SITE", DEFAULTS.STARRED_BYTES_PER_SITE),
    now: Date.now(),
  });
  if (!r.ok) {
    if (r.reason === "not_found") throw notFound("Session", `GET /v1/sites/${site.id}/sessions lists recorded sessions.`);
    const msg = {
      starred_limit: [
        "This site has the most starred sessions allowed (MAX_STARRED_SESSIONS_PER_SITE).",
        'Unstar one: PATCH .../sessions/<id> {"starred": false}; GET .../sessions?starred=true lists them.',
      ],
      labels_limit: [`A session has at most ${DEFAULTS.LABELS_PER_SESSION} labels.`, "Pass fewer labels."],
      site_labels_limit: [
        "This site uses the most distinct labels allowed (MAX_LABELS_PER_SITE).",
        "Reuse existing labels: GET /v1/sites/:id/labels.",
      ],
      starred_bytes_limit: [
        "Starred sessions' playback copies would pass this site's storage for them (MAX_STARRED_BYTES_PER_SITE).",
        'Unstar sessions you no longer need: PATCH .../sessions/<id> {"starred": false}.',
      ],
    }[r.reason]!;
    throw new ApiError(403, "quota_exceeded", msg[0]!, msg[1]);
  }
  return {
    session_id: sessionId,
    starred: r.starred,
    labels: r.labels,
    ...(r.starred
      ? {
          note: `Its recording is copied to a separate prefix so playback outlives the storage lifecycle too (it counts against MAX_STARRED_BYTES_PER_SITE and today's byte budget). Starred sessions are kept ${Math.max(site.retention_days, starredRetentionDays(ctx.env))} days (retention_days ${site.retention_days} for the rest).`,
        }
      : {}),
    next_steps: [
      `Find them: GET /v1/sites/${site.id}/sessions?${r.starred ? "starred=true" : `label=${encodeURIComponent(r.labels[0] ?? "<label>")}`}.`,
    ],
  };
}

export async function listLabels(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  return { labels: await siteStub(ctx.env, site.id).siteLabels() };
}

export async function addSessionNote(ctx: Ctx, siteId: string, sessionId: string, raw: unknown) {
  const q = parse(noteInput, raw);
  const site = await loadSite(ctx, siteId);
  const text = cleanText(q.text, true).trim().slice(0, 1000);
  if (!text) throw badRequest("text is empty.", 'Write the finding, e.g. "Pay button throws after the address step".');
  const standing = await accountStanding(ctx.env, ctx.accountId);
  const r = await siteStub(ctx.env, site.id).addNote({
    id: newId("note"),
    session_id: sid(sessionId),
    t_ms: q.t_ms ?? 0,
    text,
    now: Date.now(),
    per_session: cap(ctx.env, standing, "MAX_NOTES_PER_SESSION", DEFAULTS.NOTES_PER_SESSION) ?? Number.MAX_SAFE_INTEGER,
    per_site: cap(ctx.env, standing, "MAX_NOTES_PER_SITE", DEFAULTS.NOTES_PER_SITE),
  });
  if (!r.ok) {
    if (r.reason === "not_found") throw notFound("Session", `GET /v1/sites/${site.id}/sessions lists recorded sessions.`);
    throw new ApiError(
      403,
      "quota_exceeded",
      r.reason === "session_limit"
        ? "This session has the most notes allowed (MAX_NOTES_PER_SESSION)."
        : "This site has the most notes allowed (MAX_NOTES_PER_SITE).",
      "Delete notes you no longer need: DELETE /v1/sites/:id/sessions/:sid/notes/:note_id.",
    );
  }
  return {
    note: { id: r.note.id, session_id: r.note.session_id, t_ms: r.note.t_ms, created_at: r.note.created_at },
    next_steps: [
      `It is a transcript line now (GET /v1/sites/${site.id}/sessions/${sessionId}/transcript) and an entry in the player's timeline.`,
      `For a person: POST /v1/sites/${site.id}/links {"session_id":"${sessionId}","start_ms":${Math.max(0, r.note.t_ms - 5000)},"end_ms":${r.note.t_ms + 15_000}} makes a clip around it.`,
    ],
  };
}

export async function listSessionNotes(ctx: Ctx, siteId: string, sessionId: string) {
  const site = await loadSite(ctx, siteId);
  const notes = await siteStub(ctx.env, site.id).listNotes(sid(sessionId));
  return {
    session_id: sessionId,
    notice: UNTRUSTED_NOTICE,
    notes: notes.map(({ text, ...n }) => ({ ...n, untrusted: { text } })),
  };
}

export async function deleteSessionNote(ctx: Ctx, siteId: string, sessionId: string, noteId: string) {
  const site = await loadSite(ctx, siteId);
  if (!(await siteStub(ctx.env, site.id).deleteNote(sid(sessionId), noteId)))
    throw notFound("Note", `GET /v1/sites/${site.id}/sessions/${sessionId}/notes lists them.`);
  return { deleted: noteId };
}
