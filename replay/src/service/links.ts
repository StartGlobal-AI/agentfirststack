import { ApiError, badRequest, newId, notFound, parse, randomString, sha256Hex } from "@afs/shared";
import { chunkKey } from "../do/engine";
import { type Bindings, numVar } from "../env";
import { DEFAULTS } from "../lib/limits";
import { SESSION_ID_RE } from "../lib/protocol";
import { buildTimeline, entryLine, sessionJson } from "../lib/transcript";
import { type Ctx, loadSite, type SiteRow, siteStub } from "./context";
import { createLinkInput } from "./schemas";

/**
 * Expiring share links to the human player. The token (rpt_ + 32 random characters) is shown
 * once; only its SHA-256 is stored. Anyone with the URL can watch that one session until it
 * expires or is revoked; nothing else is reachable with it.
 */

interface LinkRow {
  id: string;
  token_hash: string;
  account_id: string;
  site_id: string;
  session_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_viewed_at: number | null;
  views: number;
}

const linkJson = (l: LinkRow) => ({
  id: l.id,
  session_id: l.session_id,
  created_at: l.created_at,
  expires_at: l.expires_at,
  revoked_at: l.revoked_at,
  active: !l.revoked_at && l.expires_at > Date.now(),
  views: l.views,
  last_viewed_at: l.last_viewed_at,
});

export async function createLink(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(createLinkInput, raw);
  const site = await loadSite(ctx, siteId);
  if (!SESSION_ID_RE.test(q.session_id)) throw badRequest("session_id must be an rs_... id.", "Take it from search_sessions.");
  const s = await siteStub(ctx.env, site.id).session(q.session_id);
  if (!s) throw notFound("Session", `GET /v1/sites/${site.id}/sessions lists recorded sessions.`);
  const now = Date.now();
  const max = numVar(ctx.env.MAX_LINKS_PER_SITE);
  if (max !== null) {
    const n = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM replay_links WHERE site_id = ? AND revoked_at IS NULL AND expires_at > ?")
      .bind(site.id, now)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This site already has ${max} active share links.`,
        `Revoke some: DELETE /v1/sites/${site.id}/links/<id> (GET /v1/sites/${site.id}/links lists them).`,
      );
  }
  const token = `rpt_${randomString(32)}`;
  const row: LinkRow = {
    id: newId("rpl"),
    token_hash: await sha256Hex(token),
    account_id: ctx.accountId,
    site_id: site.id,
    session_id: q.session_id,
    created_at: now,
    expires_at: now + (q.expires_in ?? DEFAULTS.LINK_SECONDS) * 1000,
    revoked_at: null,
    last_viewed_at: null,
    views: 0,
  };
  await ctx.env.DB.prepare(
    "INSERT INTO replay_links (id, token_hash, account_id, site_id, session_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.token_hash, row.account_id, row.site_id, row.session_id, row.created_at, row.expires_at)
    .run();
  return {
    link: { ...linkJson(row), url: `${ctx.baseUrl}/play/${token}` },
    existing: false,
    note: "Store the url now; it is not shown again. Anyone with it can watch this one session (masked as recorded) until it expires or is revoked. A new call makes a new link.",
    next_steps: [`Revoke: DELETE /v1/sites/${site.id}/links/${row.id} (MCP revoke_replay_link).`],
  };
}

export async function listLinks(ctx: Ctx, siteId: string, sessionId?: string) {
  const site = await loadSite(ctx, siteId);
  const rows = sessionId
    ? await ctx.env.DB.prepare("SELECT * FROM replay_links WHERE site_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 200")
        .bind(site.id, sessionId)
        .all<LinkRow>()
    : await ctx.env.DB.prepare("SELECT * FROM replay_links WHERE site_id = ? ORDER BY created_at DESC LIMIT 200")
        .bind(site.id)
        .all<LinkRow>();
  return { links: rows.results.map(linkJson), note: "Link URLs are shown only when created." };
}

export async function revokeLink(ctx: Ctx, siteId: string, linkId: string) {
  const site = await loadSite(ctx, siteId);
  const r = await ctx.env.DB.prepare("UPDATE replay_links SET revoked_at = ? WHERE id = ? AND site_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), linkId, site.id)
    .run();
  if (!r.meta.changes) throw notFound("Active share link", `GET /v1/sites/${site.id}/links lists them.`);
  return { revoked: linkId };
}

// ---------------------------------------------------------------------------------- public player

export interface ResolvedLink {
  link: LinkRow;
  site: SiteRow;
}

export async function resolveToken(env: Bindings, token: string): Promise<ResolvedLink | null> {
  if (!/^rpt_[0-9a-z]{32}$/.test(token)) return null;
  const link = await env.DB.prepare("SELECT * FROM replay_links WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<LinkRow>();
  if (!link || link.revoked_at || link.expires_at <= Date.now()) return null;
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND account_id = ?")
    .bind(link.site_id, link.account_id)
    .first<SiteRow>();
  return site ? { link, site } : null;
}

export async function recordView(env: Bindings, linkId: string) {
  await env.DB.prepare("UPDATE replay_links SET views = views + 1, last_viewed_at = ? WHERE id = ?").bind(Date.now(), linkId).run();
}

/** What the player page loads: session facts, the event timeline as lines, the chunk list. */
export async function playerData(env: Bindings, r: ResolvedLink) {
  const stub = siteStub(env, r.site.id);
  const d = await stub.transcript(r.link.session_id, { maxEvents: 3000 });
  if (!d) return null;
  const chunks = await stub.chunks(r.link.session_id);
  const tl = buildTimeline(d.session, d.pages, d.events);
  const s = sessionJson(d.session);
  return {
    session: { ...s, site_domain: r.site.domain, pages: d.session.pageviews, signals: s.signals },
    timeline: tl.map((e) => ({ t: e.t, kind: e.kind, text: entryLine(e).replace(/^\[[^\]]+\]\s*/, ""), signals: e.signals })),
    chunks,
    expires_at: r.link.expires_at,
  };
}

export async function playerChunk(env: Bindings, r: ResolvedLink, seq: number): Promise<ReadableStream | null> {
  const obj = await env.CHUNKS.get(`${r.site.id}/${chunkKey(r.link.session_id, seq)}`);
  return obj ? obj.body : null;
}
