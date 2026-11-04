import {
  accountStanding,
  ApiError,
  assertPermanentKey,
  badRequest,
  newId,
  notFound,
  parse,
  randomString,
  sha256Hex,
  type Standing,
} from "@afs/shared";
import { chunkKey } from "../do/engine";
import { type Bindings, isDev } from "../env";
import { cap, DEFAULTS } from "../lib/limits";
import { SESSION_ID_RE } from "../lib/protocol";
import { buildTimeline, entryLine, sessionJson } from "../lib/transcript";
import { cleanText } from "../lib/mask-rules";
import { safePatterns } from "../lib/url";
import { type Ctx, isVerified, jsonList, loadSite, type SiteRow, siteStub } from "./context";
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
  /** migration 0008: a clip window (ms since the session started) and a note */
  start_ms?: number | null;
  end_ms?: number | null;
  note?: string | null;
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
  ...(l.start_ms != null || l.end_ms != null ? { clip: { start_ms: l.start_ms ?? 0, end_ms: l.end_ms ?? null } } : {}),
  ...(l.note ? { untrusted: { note: l.note } } : {}),
});

/** A clip's window in absolute ms, or null for the whole session. */
const windowOf = (l: LinkRow, startedAt: number) =>
  l.start_ms != null || l.end_ms != null
    ? { start: startedAt + (l.start_ms ?? 0), end: l.end_ms != null ? startedAt + l.end_ms : Number.MAX_SAFE_INTEGER }
    : null;

export async function createLink(ctx: Ctx, siteId: string, raw: unknown) {
  // A link works for up to 30 days; a connected app's 8-hour token must not leave one behind.
  assertPermanentKey(ctx.auth, "create share links");
  const q = parse(createLinkInput, raw);
  const site = await loadSite(ctx, siteId);
  if (!SESSION_ID_RE.test(q.session_id)) throw badRequest("session_id must be an rs_... id.", "Take it from search_sessions.");
  // A share link puts recorded content on this service's domain: only for sites whose domain is proven.
  if (!isVerified(site))
    throw new ApiError(
      403,
      "domain_not_verified",
      `Share links need a verified domain; ${site.domain} isn't verified yet.`,
      `Put the snippet on https://${site.domain}/ (or add DNS TXT _afs-verify.${site.domain} = "afs-replay-site=${site.id}"), then POST /v1/sites/${site.id}/verify.`,
    );
  const s = await siteStub(ctx.env, site.id).session(q.session_id);
  if (!s) throw notFound("Session", `GET /v1/sites/${site.id}/sessions lists recorded sessions.`);
  if (q.start_ms !== undefined && q.end_ms !== undefined && q.end_ms <= q.start_ms)
    throw badRequest("end_ms must be after start_ms.", "Both are ms since the session started, e.g. start_ms=12000&end_ms=30000.");
  if (q.start_ms !== undefined && q.start_ms > s.session.duration_ms)
    throw badRequest(
      `start_ms is after the session's end (${s.session.duration_ms} ms).`,
      "Take times from the transcript ([mm:ss.s]) or get_session.",
    );
  const now = Date.now();
  const max = cap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_LINKS_PER_SITE", Number.POSITIVE_INFINITY);
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
    start_ms: q.start_ms ?? null,
    end_ms: q.end_ms ?? null,
    note: q.note ? cleanText(q.note).trim().slice(0, 500) || null : null,
  };
  await ctx.env.DB.prepare(
    "INSERT INTO replay_links (id, token_hash, account_id, site_id, session_id, created_at, expires_at, start_ms, end_ms, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      row.id,
      row.token_hash,
      row.account_id,
      row.site_id,
      row.session_id,
      row.created_at,
      row.expires_at,
      row.start_ms,
      row.end_ms,
      row.note,
    )
    .run();
  return {
    link: { ...linkJson(row), url: `${ctx.baseUrl}/play/${token}` },
    existing: false,
    note: `Store the url now; it is not shown again. Anyone with it can watch this one session${row.start_ms != null || row.end_ms != null ? " (only the clip's window is served)" : ""} (masked as recorded) until it expires or is revoked. A new call makes a new link.`,
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
  standing: Standing;
}

/** The link behind a token, if it is active, its site exists and its account isn't suspended. */
export async function resolveToken(env: Bindings, token: string): Promise<ResolvedLink | null> {
  if (!/^rpt_[0-9a-z]{32}$/.test(token)) return null;
  const link = await env.DB.prepare("SELECT * FROM replay_links WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<LinkRow>();
  if (!link || link.revoked_at || link.expires_at <= Date.now()) return null;
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ? AND account_id = ?")
    .bind(link.site_id, link.account_id)
    .first<SiteRow>();
  if (!site) return null;
  const standing = await accountStanding(env, site.account_id);
  return standing.suspended ? null : { link, site, standing };
}

/** CSP host sources for the player: the recorded site's domain, its subdomains and allowed_hostnames. */
export function siteHostsForCsp(env: Bindings, site: SiteRow): string[] {
  const allowed = safePatterns(site.allowed_hostnames ? jsonList(site.allowed_hostnames) : null, isDev(env)).filter((p) =>
    /^(\*\.)?[a-z0-9.-]+$/.test(p),
  );
  return [`https://${site.domain}`, `https://*.${site.domain}`, ...allowed.map((p) => `https://${p}`)];
}

/** Recorded bytes one share link may serve per UTC day (MAX_LINK_BYTES_PER_DAY). */
const linkBudget = (env: Bindings, r: ResolvedLink) => cap(env, r.standing, "MAX_LINK_BYTES_PER_DAY", DEFAULTS.LINK_BYTES_PER_DAY);

export async function recordView(env: Bindings, linkId: string) {
  await env.DB.prepare("UPDATE replay_links SET views = views + 1, last_viewed_at = ? WHERE id = ?").bind(Date.now(), linkId).run();
}

/** Most chunks a player loads (with MAX_SESSION_BYTES, a real session has far fewer). */
const PLAYER_CHUNKS = 1000;

/**
 * What the player page loads: session facts, the event timeline as lines, the chunk list. A site
 * whose domain isn't verified (any more) gets no domain headline and no chunks: the player shows
 * an "unverified site" banner and the text timeline only.
 */
export async function playerData(env: Bindings, r: ResolvedLink) {
  const stub = siteStub(env, r.site.id);
  const d = await stub.transcript(r.link.session_id, { maxEvents: 3000 });
  if (!d) return null;
  const verified = isVerified(r.site);
  const win = windowOf(r.link, d.session.started_at);
  const chunks = verified ? await stub.playable(r.link.session_id, PLAYER_CHUNKS, win) : [];
  const all = buildTimeline(d.session, d.pages, d.events, d.tags, d.notes);
  const tl = win ? all.filter((e) => e.ts >= win.start && e.ts <= win.end) : all;
  const s = sessionJson(d.session);
  return {
    session: {
      ...s,
      site_domain: verified ? r.site.domain : null,
      site_verified: verified,
      pages: d.session.pageviews,
      signals: s.signals,
    },
    timeline: tl.map((e) => ({ t: e.t, kind: e.kind, text: entryLine(e).replace(/^\[[^\]]+\]\s*/, ""), signals: e.signals })),
    chunks,
    ...(win ? { clip: { start_ms: r.link.start_ms ?? 0, end_ms: r.link.end_ms ?? null } } : {}),
    ...(r.link.note ? { note: r.link.note } : {}),
    expires_at: r.link.expires_at,
  };
}

/**
 * One chunk for the player: only for a verified site, only chunks ingest accepted with rrweb events
 * (a real recording, not arbitrary bytes), within the link's daily byte budget.
 */
export async function playerChunk(env: Bindings, r: ResolvedLink, seq: number): Promise<ReadableStream | "budget" | null> {
  if (!isVerified(r.site)) return null;
  const stub = siteStub(env, r.site.id);
  let window: { start: number; end: number } | null = null;
  if (r.link.start_ms != null || r.link.end_ms != null) {
    const s = await stub.session(r.link.session_id);
    if (!s) return null;
    window = windowOf(r.link, s.session.started_at);
  }
  const ok = await stub.serveChunk({
    link_id: r.link.id,
    session_id: r.link.session_id,
    seq,
    budget: linkBudget(env, r),
    window,
  });
  if (!ok.ok) return ok.reason === "budget" ? "budget" : null;
  const obj = await env.CHUNKS.get(`${r.site.id}/${chunkKey(r.link.session_id, seq)}`);
  return obj ? obj.body : null;
}
