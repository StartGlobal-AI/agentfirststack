import { accountStanding, ApiError, badRequest, newId, notFound, parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import type { EventMatch } from "../do/queries";
import { validGlob } from "../lib/glob";
import { cap, DEFAULTS } from "../lib/limits";
import { type Ctx, loadSite, type SiteRow, siteStub } from "./context";

/**
 * Events defined after the fact, without code (Clarity's smart events): a click (its selector
 * contains some text, its label equals some text, its link target contains some text) and/or a
 * visit to a page. They work over everything already recorded: event=<name> on every session read
 * and event:<name> as a funnel step. Built in: outbound_click (a link to another site) and
 * download (a link to a file); form_submit is recorded by the recorder (auto_events).
 */

const NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const DOWNLOAD_SUFFIXES = [
  ".pdf",
  ".zip",
  ".csv",
  ".xls",
  ".xlsx",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".dmg",
  ".exe",
  ".pkg",
  ".msi",
  ".apk",
  ".gz",
  ".tgz",
  ".rar",
  ".7z",
  ".mp3",
  ".mp4",
  ".mov",
  ".epub",
  ".ics",
];

export const BUILTIN_EVENTS: Record<string, { match: EventMatch; description: string }> = {
  outbound_click: {
    match: { click: { external: true } },
    description: "a click on a link to another site (from the recorded link target)",
  },
  download: {
    match: { click: { href_suffixes: DOWNLOAD_SUFFIXES } },
    description: `a click on a link to a file (${DOWNLOAD_SUFFIXES.join(" ")})`,
  },
};

export const defineEventInput = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe("Event name (letters, digits, _ . : -). Natural key per site: the same name again returns the existing definition."),
  match: z
    .object({
      click: z
        .object({
          selector_contains: z.string().min(1).max(200).optional(),
          label: z.string().min(1).max(120).optional().describe("The click label as recorded (masked text stays masked)."),
          href_contains: z.string().min(1).max(200).optional().describe("The link target (path, or origin + path) contains this."),
        })
        .strict()
        .optional(),
      page: z.string().min(1).max(300).optional().describe("Path glob: with click, the click is on such a page; alone, a visit to it."),
    })
    .strict(),
});

interface DefRow {
  id: string;
  site_id: string;
  account_id: string;
  name: string;
  match: string;
  created_at: number;
}

const defJson = (r: DefRow) => ({ id: r.id, name: r.name, match: JSON.parse(r.match) as EventMatch, created_at: r.created_at });

/** The match of a defined or built-in event, or null (then event= is an afsr('event') name). */
export async function eventMatchFor(env: Bindings, site: SiteRow, name: string): Promise<EventMatch | null> {
  if (BUILTIN_EVENTS[name]) return BUILTIN_EVENTS[name]!.match;
  const r = await env.DB.prepare("SELECT match FROM event_definitions WHERE site_id = ? AND name = ?")
    .bind(site.id, name)
    .first<{ match: string }>();
  return r ? (JSON.parse(r.match) as EventMatch) : null;
}

export async function defineEvent(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(defineEventInput, raw);
  const site = await loadSite(ctx, siteId);
  if (!NAME_RE.test(q.name))
    throw badRequest("name is letters, digits, _ . : - (at most 100).", 'Example: "pricing_cta" or "signup.started".');
  if (BUILTIN_EVENTS[q.name] || q.name === "form_submit")
    throw badRequest(
      `${q.name} is built in.`,
      "Use it as is (event=outbound_click, event=download, event=form_submit), or pick another name.",
    );
  const c = q.match.click;
  if (!c && !q.match.page)
    throw badRequest("match needs click and/or page.", '{"click":{"selector_contains":"#pricing .cta"}} or {"page":"/thank-you"}');
  if (c && !c.selector_contains && !c.label && !c.href_contains)
    throw badRequest("match.click needs selector_contains, label or href_contains.", '{"click":{"label":"Start trial"}}');
  if (q.match.page && !validGlob(q.match.page))
    throw badRequest('match.page is a path glob starting with "/" or "*".', "Example: /pricing*");
  const db = ctx.env.DB;
  const existing = await db.prepare("SELECT * FROM event_definitions WHERE site_id = ? AND name = ?").bind(site.id, q.name).first<DefRow>();
  const respond = async (r: DefRow, isExisting: boolean) => {
    const m = JSON.parse(r.match) as EventMatch;
    const now = await siteStub(ctx.env, site.id).search({
      start: 0,
      end: Number.MAX_SAFE_INTEGER,
      event: r.name,
      event_match: m,
      sort: "recent",
      limit: 3,
      cursor: null,
    });
    return {
      event_definition: defJson(r),
      existing: isExisting,
      ...(isExisting
        ? { note: "An event with this name is already defined; returned unchanged. Delete it and define it again to change it." }
        : {}),
      matching_now: { sessions: now.total, example_session_ids: now.sessions.map((s) => s.id) },
      next_steps: [
        `Sessions with it: GET /v1/sites/${site.id}/sessions?event=${encodeURIComponent(r.name)}; a funnel step: steps=/pricing,event:${r.name}.`,
      ],
    };
  };
  if (existing) return respond(existing, true);
  const max = cap(
    ctx.env,
    await accountStanding(ctx.env, ctx.accountId),
    "MAX_EVENT_DEFINITIONS_PER_SITE",
    DEFAULTS.EVENT_DEFINITIONS_PER_SITE,
  );
  if (max !== null) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM event_definitions WHERE site_id = ?").bind(site.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This site already has ${max} event definitions (MAX_EVENT_DEFINITIONS_PER_SITE).`,
        `Delete one: DELETE /v1/sites/${site.id}/event-definitions/<evd_id>.`,
      );
  }
  const row: DefRow = {
    id: newId("evd"),
    site_id: site.id,
    account_id: ctx.accountId,
    name: q.name,
    match: JSON.stringify(q.match),
    created_at: Date.now(),
  };
  try {
    await db
      .prepare("INSERT INTO event_definitions (id, site_id, account_id, name, match, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.site_id, row.account_id, row.name, row.match, row.created_at)
      .run();
  } catch (e) {
    const other = await db.prepare("SELECT * FROM event_definitions WHERE site_id = ? AND name = ?").bind(site.id, q.name).first<DefRow>();
    if (other) return respond(other, true);
    throw e;
  }
  return respond(row, false);
}

export async function listEventDefinitions(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const { results } = await ctx.env.DB.prepare(
    "SELECT * FROM event_definitions WHERE site_id = ? AND account_id = ? ORDER BY created_at LIMIT 200",
  )
    .bind(site.id, ctx.accountId)
    .all<DefRow>();
  return {
    event_definitions: results.map(defJson),
    built_in: [
      ...Object.entries(BUILTIN_EVENTS).map(([name, b]) => ({ name, description: b.description })),
      { name: "form_submit", description: "a form was submitted (recorded by the recorder with auto_events; props.form is its selector)" },
    ],
  };
}

export async function deleteEventDefinition(ctx: Ctx, siteId: string, id: string) {
  const site = await loadSite(ctx, siteId);
  const r = await ctx.env.DB.prepare("DELETE FROM event_definitions WHERE id = ? AND site_id = ? AND account_id = ?")
    .bind(id, site.id, ctx.accountId)
    .run();
  if (!r.meta.changes) throw notFound("Event definition", `GET /v1/sites/${site.id}/event-definitions lists them.`);
  return { deleted: id };
}
