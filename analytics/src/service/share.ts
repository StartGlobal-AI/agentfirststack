import {
  ApiError,
  accountStanding,
  accountSuspended,
  assertCapability,
  assertPermanentKey,
  canWrite,
  capabilityPaused,
  capabilityPausedError,
  isTemporaryCredential,
  notFound,
  parse,
  randomString,
  sha256Hex,
  userContentOrigin,
} from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { DEFAULT_MAX_SHARE_LINKS_PER_SITE, enforce, quotaExceeded, siteCap } from "../lib/limits";
import { BREAKDOWNS, DEFAULT_METRICS, filterLeaves } from "../lib/filters";
import { getAiSearch } from "./ai-search";
import { getCrawlers } from "./crawlers";
import { listFunnels } from "./funnels";
import { listGoals } from "./goals";
import { getBreakdown, getFunnel, getInsights, getRealtime, getStats, getTimeseries } from "./stats";
import { getWebVitals } from "./vitals";
import { PERIODS } from "../lib/time";
import { type Ctx, type SiteRow, callSite, isVerified, loadSite } from "./context";
import { verifyRecord } from "./sites";
import { type SegmentRow, filterJsonOf, filtersOf, loadSegment } from "./filters";
import { saltSecret } from "./ingest";
import { checkPassword, checkUnlockCookie, hashPassword, unlockCookie } from "../lib/password";

export const createShareInput = z.object({
  new: z.boolean().optional().describe("Create an additional link even if one exists (default: return the existing one)."),
  password: z.string().min(8).max(200).optional().describe("Viewers must enter it (stored as a PBKDF2 hash, never returned)."),
  expires_in_days: z.number().int().min(1).max(3650).optional().describe("The link stops working after this many days."),
  segment: z.string().max(120).optional().describe("A saved segment (seg_... or name): the dashboard shows only its traffic."),
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Your name for the link; a link with options and the same label is returned again (retries are safe)."),
});

/**
 * A share link's URL: <USER_CONTENT_BASE_URL>/a/<token> when the deployment has a user-content host
 * (routes/share.ts), else <PUBLIC_BASE_URL>/share/<token> as always.
 */
export function shareUrl(env: Bindings, baseUrl: string, token: string): string {
  const uc = userContentOrigin(env);
  return uc ? `${uc}/a/${token}` : `${baseUrl}/share/${token}`;
}

export async function createShareLink(ctx: Ctx, siteId: string, raw: unknown) {
  // A share URL never expires: a connected app's 8-hour token must not get one (new or existing).
  assertPermanentKey(ctx.auth, "create share links");
  const input = parse(createShareInput, raw);
  const site = await loadSite(ctx, siteId);
  // Public dashboards can be paused for an account after an abuse report (analytics.share_links).
  await assertCapability(ctx.env, ctx.accountId, "analytics.share_links");
  // The page is titled with the domain on this service's host: only for a domain the account proved.
  if (!isVerified(site)) {
    const rec = verifyRecord(site);
    throw new ApiError(
      403,
      "domain_not_verified",
      `Share links need a verified domain; ${site.domain} isn't verified yet.`,
      `Put the snippet on https://${site.domain}/ (the homepage itself), or add DNS TXT ${rec.name} = "${rec.value}", then POST /v1/sites/${site.id}/verify (MCP verify_install).`,
    );
  }
  const options = input.password || input.expires_in_days || input.segment || input.label;
  if (!input.new && !options) {
    const existing = await ctx.env.DB.prepare(
      "SELECT token, created_at FROM share_links WHERE site_id = ? AND revoked_at IS NULL AND password_hash IS NULL AND expires_at IS NULL AND segment_id IS NULL AND label IS NULL ORDER BY created_at LIMIT 1",
    )
      .bind(site.id)
      .first<{ token: string; created_at: number }>();
    if (existing)
      return {
        url: shareUrl(ctx.env, ctx.baseUrl, existing.token),
        token: existing.token,
        existing: true,
        created_at: existing.created_at,
      };
  }
  if (input.label && !input.new) {
    const same = await ctx.env.DB.prepare("SELECT * FROM share_links WHERE site_id = ? AND label = ? AND revoked_at IS NULL")
      .bind(site.id, input.label)
      .first<ShareRow>();
    if (same)
      return {
        ...linkOut(ctx, same),
        existing: true,
        note: "A link with this label exists: returned as it is (revoke it to change its options).",
      };
  }
  const segment = input.segment ? await loadSegment(ctx, site.id, input.segment) : null;
  const max = siteCap(ctx.env, await accountStanding(ctx.env, ctx.accountId), "MAX_SHARE_LINKS_PER_SITE", DEFAULT_MAX_SHARE_LINKS_PER_SITE);
  if (Number.isFinite(max)) {
    const n = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM share_links WHERE site_id = ? AND revoked_at IS NULL")
      .bind(site.id)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw quotaExceeded(
        `This site already has ${max} active share links, the most allowed here.`,
        `Reuse one (POST /v1/sites/${site.id}/share without "new" returns it), or revoke them all with DELETE /v1/sites/${site.id}/share.`,
      );
  }
  const token = `shr_${randomString(32)}`;
  const now = Date.now();
  const expires = input.expires_in_days ? now + input.expires_in_days * 86_400_000 : null;
  await ctx.env.DB.prepare(
    "INSERT INTO share_links (token, site_id, created_at, password_hash, expires_at, segment_id, label) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      token,
      site.id,
      now,
      input.password ? await hashPassword(input.password) : null,
      expires,
      segment?.id ?? null,
      input.label ?? null,
    )
    .run();
  const row = (await ctx.env.DB.prepare("SELECT * FROM share_links WHERE token = ?").bind(token).first<ShareRow>())!;
  return {
    ...linkOut(ctx, row),
    existing: false,
    note: `${input.password ? "Anyone with this URL and the password" : "Anyone with this URL"} can see aggregate stats for this site${segment ? ` (segment ${segment.name} only)` : ""} (no raw events, no SQL)${expires ? ` until ${new Date(expires).toISOString()}` : ""}. Revoke with DELETE /v1/sites/:id/share (all) or ?token=.`,
    next_steps: ["Open the url to check it; GET /v1/sites/:id/share lists the site's links with their options."],
  };
}

interface ShareRow {
  token: string;
  site_id: string;
  created_at: number;
  revoked_at: number | null;
  password_hash: string | null;
  expires_at: number | null;
  segment_id: string | null;
  label: string | null;
}

function linkOut(ctx: Ctx, r: ShareRow) {
  return {
    url: shareUrl(ctx.env, ctx.baseUrl, r.token),
    token: r.token,
    created_at: r.created_at,
    label: r.label,
    password: { configured: !!r.password_hash },
    expires_at: r.expires_at,
    expired: r.expires_at != null && r.expires_at < Date.now(),
    segment_id: r.segment_id,
  };
}

export async function listShareLinks(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const { results } = await ctx.env.DB.prepare("SELECT * FROM share_links WHERE site_id = ? AND revoked_at IS NULL ORDER BY created_at")
    .bind(site.id)
    .all<ShareRow>();
  // A share URL never expires: a connected app's token, or a read-only key, must not walk away
  // with one (creating one already needs the project's own full key).
  if (isTemporaryCredential(ctx.auth) || !canWrite(ctx.auth))
    return {
      site_id: site.id,
      share_links: results.map((r) => {
        const { url: _url, token: _token, ...rest } = linkOut(ctx, r);
        return rest;
      }),
      hint: "URLs and tokens are left out for this credential: share links never expire, so only the project's own full API key sees them (not a connected app's temporary token or a read-only key).",
    };
  return { site_id: site.id, share_links: results.map((r) => linkOut(ctx, r)) };
}

export async function revokeShareLinks(ctx: Ctx, siteId: string, token?: string) {
  const site = await loadSite(ctx, siteId);
  // A revoked token can never be used again, so its row goes (create + revoke can't grow the table).
  const res = token
    ? await ctx.env.DB.prepare("DELETE FROM share_links WHERE site_id = ? AND token = ?").bind(site.id, token).run()
    : await ctx.env.DB.prepare("DELETE FROM share_links WHERE site_id = ?").bind(site.id).run();
  return { revoked: res.meta.changes ?? 0 };
}

export async function linkForToken(env: Bindings, token: string): Promise<{ site: SiteRow; link: ShareRow }> {
  if (!/^shr_[0-9a-z]{32}$/.test(token)) throw notFound("Share link");
  await enforce([[env.SHARE_LIMITER, `share:${token}`]], "dashboard requests", "Wait a minute and reload.");
  const link = await env.DB.prepare("SELECT * FROM share_links WHERE token = ? AND revoked_at IS NULL").bind(token).first<ShareRow>();
  const site = link ? await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(link.site_id).first<SiteRow>() : null;
  if (!link || !site) throw notFound("Share link", "The link was revoked or never existed.");
  if (link.expires_at != null && link.expires_at < Date.now())
    throw new ApiError(410, "share_link_expired", "This share link has expired.", "Ask the site's owner for a new link.");
  // A suspended account's public dashboards go dark with it, and so do they while the account's
  // share links are paused (analytics.share_links, after an abuse report).
  if ((await accountStanding(env, site.account_id)).suspended) throw accountSuspended();
  const pause = await capabilityPaused(env, site.account_id, "analytics.share_links");
  if (pause) throw capabilityPausedError(pause);
  return { site, link };
}

const siteForToken = async (env: Bindings, token: string) => (await linkForToken(env, token)).site;

/** Wrong passwords per link and (hashed) IP address in 15 minutes, then 429 until the window ends. */
export const SHARE_IP_FAILURES = 10;
const IP_WINDOW_MS = 15 * 60_000;
/** Wrong passwords per link in an hour from anywhere: past it, password attempts wait (cookies still work). */
export const SHARE_LINK_FAILURES = 200;
const LINK_WINDOW_MS = 60 * 60_000;

/**
 * Check a password under the attempt limits. The cheap checks (counters in D1) come first and
 * PBKDF2 runs only when they allow it; a wrong password counts against the link's (hashed) IP and
 * the link itself. Viewers holding a valid unlock cookie never come here.
 */
async function checkWithLimits(env: Bindings, link: ShareRow, password: string, ip: string | null): Promise<boolean> {
  const now = Date.now();
  const salt = saltSecret(env);
  const ipKey = `ip:${(await sha256Hex(`${salt}|share|${link.token}|${ip ?? "unknown"}`)).slice(0, 40)}`;
  const linkKey = `link:${(await sha256Hex(`${salt}|share|${link.token}`)).slice(0, 40)}`;
  const wIp = Math.floor(now / IP_WINDOW_MS);
  const wLink = Math.floor(now / LINK_WINDOW_MS);
  const { results } = await env.DB.prepare("SELECT key, win, count FROM share_attempts WHERE key IN (?, ?)")
    .bind(ipKey, linkKey)
    .all<{ key: string; win: number; count: number }>();
  const ipRow = results.find((r) => r.key === ipKey);
  const linkRow = results.find((r) => r.key === linkKey);
  const wait = (until: number, who: string) =>
    new ApiError(
      429,
      "too_many_attempts",
      `Too many wrong passwords ${who}; try again later.`,
      "Wait until retry_after seconds have passed. Viewers who already entered the password are not affected.",
      { retry_after: Math.max(1, Math.ceil((until - now) / 1000)) },
    );
  if (ipRow?.win === wIp && ipRow.count >= SHARE_IP_FAILURES) throw wait((wIp + 1) * IP_WINDOW_MS, "from this address");
  if (linkRow?.win === wLink && linkRow.count >= SHARE_LINK_FAILURES) throw wait((wLink + 1) * LINK_WINDOW_MS, "for this link");
  const ok = await checkPassword(password.slice(0, 200), link.password_hash!);
  if (!ok) {
    const bump = (key: string, w: number, expires: number) =>
      env.DB.prepare(
        `INSERT INTO share_attempts (key, win, count, expires_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = CASE WHEN win = excluded.win THEN count + 1 ELSE 1 END, win = excluded.win, expires_at = excluded.expires_at`,
      ).bind(key, w, expires);
    await env.DB.batch([bump(ipKey, wIp, (wIp + 1) * IP_WINDOW_MS), bump(linkKey, wLink, (wLink + 1) * LINK_WINDOW_MS)]);
  }
  return ok;
}

/** Was the password given: the unlock cookie, or the x-share-password header (scripts, under the attempt limits). */
export async function shareUnlocked(
  env: Bindings,
  link: ShareRow,
  cookie: string | undefined,
  header: string | undefined,
  ip: string | null = null,
): Promise<boolean> {
  if (!link.password_hash) return true;
  if (await checkUnlockCookie(saltSecret(env), link.token, cookie, Date.now())) return true;
  if (header) return checkWithLimits(env, link, header, ip);
  return false;
}

/** POST /share/:token/unlock: the cookie value (12 hours) when the password is right, else null. */
export async function unlockShare(env: Bindings, token: string, password: string, ip: string | null = null): Promise<string | null> {
  await enforce([[env.SHARE_LIMITER, `share-unlock:${token}`]], "password attempts", "Wait a minute and try again.");
  const { link } = await linkForToken(env, token);
  if (!link.password_hash) return null;
  if (!(await checkWithLimits(env, link, password, ip))) return null;
  return unlockCookie(saltSecret(env), token, Math.floor(Date.now() / 1000) + 12 * 3600);
}

/** Cron: forget expired attempt counters. */
export async function purgeShareAttempts(env: Bindings, now: number): Promise<number> {
  const r = await env.DB.prepare("DELETE FROM share_attempts WHERE expires_at < ?").bind(now).run();
  return r.meta.changes ?? 0;
}

export const shareDataInput = z.object({ period: z.enum(PERIODS).exclude(["custom"]).optional() });

/** Everything the public dashboard renders, in one call. Aggregates only. */
export async function shareData(
  env: Bindings,
  token: string,
  raw: unknown,
  auth: { cookie?: string; password?: string; ip?: string | null } = {},
) {
  const { period = "30d" } = parse(shareDataInput, raw);
  const { site, link } = await linkForToken(env, token);
  if (!(await shareUnlocked(env, link, auth.cookie, auth.password, auth.ip ?? null)))
    throw new ApiError(
      401,
      "share_password_required",
      "This dashboard needs its password.",
      "Open the share URL and enter the password (or send it as the x-share-password header).",
    );
  // A link made for a segment shows only that segment's traffic.
  const seg = link.segment_id
    ? await env.DB.prepare("SELECT * FROM segments WHERE id = ? AND site_id = ?").bind(link.segment_id, site.id).first<SegmentRow>()
    : null;
  if (link.segment_id && !seg) throw notFound("Share link", "The segment this link was made for was deleted.");
  const filters = seg ? filtersOf(seg.filters ?? undefined) : [];
  const where = seg?.filters_json ? filterJsonOf(seg.filters_json) : null;
  const base = { period, filters, where, metrics: [...DEFAULT_METRICS] };
  const top = (breakdown: "page" | "source" | "country" | "device") =>
    callSite(env, site, (s) => s.breakdown({ ...base, metrics: ["visitors", "pageviews"], breakdown, limit: 10 } as never)).then(
      (r) => (r as { results: unknown[] }).results,
    );
  const [stats, series, pages, sources, countries, devices, goals] = await Promise.all([
    callSite(env, site, (s) => s.stats({ ...base, compare: { mode: "previous" } } as never)),
    callSite(env, site, (s) => s.timeseries({ period, filters, where, metrics: ["visitors", "pageviews"] } as never)),
    top("page"),
    top("source"),
    top("country"),
    top("device"),
    callSite(env, site, (s) =>
      s.breakdown({ ...base, metrics: ["visitors", "conversions", "conversion_rate"], breakdown: "goal", limit: 20 } as never),
    ).then((r) =>
      ((r as { results: Record<string, unknown>[] }).results ?? []).map((g) => ({
        value: g.value,
        visitors: g.visitors,
        conversions: g.conversions,
        conversion_rate: g.conversion_rate,
      })),
    ),
  ]);
  // A site whose domain isn't verified (any more: it changed) shows its numbers, never a name.
  const verified = isVerified(site);
  return {
    site: { domain: verified ? site.domain : null, name: verified ? site.name : null, timezone: site.timezone, verified },
    period: (stats as { period: unknown }).period,
    metrics: (stats as { metrics: unknown }).metrics,
    comparison: (stats as { comparison?: unknown }).comparison ?? null,
    timeseries: (series as { results: unknown[]; interval: string }).results,
    interval: (series as { interval: string }).interval,
    top_pages: pages,
    top_sources: sources,
    top_countries: countries,
    top_devices: devices,
    goals,
    share: { segment: seg ? seg.name : null, expires_at: link.expires_at },
  };
}

/**
 * The reports a share link answers, one per call: GET <base>/:token/data/<report> (and
 * data/funnels/<fnl_...>). They are the dashboard's own reads, so the public page can be the
 * dashboard itself (dashboard-app.js in shared mode): the same service calls as
 * GET /v1/sites/:id/<report>, read-only, under the link's segment. Aggregates only: no visitors,
 * journeys, sessions or the realtime event list (one person's data), no SQL or exports, and no
 * web-vitals/lab (an outbound PageSpeed run).
 */
export const SHARE_REPORTS = [
  "stats",
  "timeseries",
  "breakdown",
  "goals",
  "funnels",
  "insights",
  "crawlers",
  "ai-search",
  "web-vitals",
  "realtime",
] as const;
export type ShareReport = (typeof SHARE_REPORTS)[number];
const isShareReport = (r: string): r is ShareReport => (SHARE_REPORTS as readonly string[]).includes(r);

/** Reports that aren't visitor traffic, so a segment can't narrow them: a segment link leaves them out. */
const SITE_WIDE_REPORTS: readonly ShareReport[] = ["crawlers", "ai-search"];

/**
 * What a shared dashboard may group and filter by: the standard dimensions. Never custom event or
 * user properties (prop:, user:), which can hold emails or account details, nor did==<event>.
 */
const SHARE_DIMS = new Set<string>(BREAKDOWNS);

/** Rows per list on a shared dashboard: its longest list (a card's "Show all") asks for 100. */
export const SHARE_MAX_ROWS = 100;

/**
 * Query keys a share link never passes on: the link's own segment applies (no other segment, no
 * compare_segments), test and quarantined traffic stay out (debug), no paging past the top rows
 * (offset), funnels are the site's saved ones (no ad-hoc steps).
 */
const SHARE_DROPPED_KEYS = new Set(["segment", "compare_segments", "debug", "offset", "steps", "format"]);

function notShared(key: string): ApiError {
  return new ApiError(
    400,
    "not_shared",
    `A shared dashboard can't group or filter by "${key}".`,
    `Use one of the standard dimensions: ${BREAKDOWNS.join(", ")}.`,
  );
}

/** A viewer's query, made safe for a share link: standard dimensions only, capped rows, the link's segment. */
export function shareQuery(raw: Record<string, string | undefined>, segmentId: string | null): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && !SHARE_DROPPED_KEYS.has(k)) q[k] = v;
  for (const f of filtersOf(q.filters)) if (!SHARE_DIMS.has(f.key)) throw notShared(f.key);
  for (const f of filterLeaves(filterJsonOf(q.filters_json))) if (!SHARE_DIMS.has(f.key)) throw notShared(f.key);
  if (q.breakdown) for (const dim of q.breakdown.split(",").map((s) => s.trim())) if (dim && !SHARE_DIMS.has(dim)) throw notShared(dim);
  if (q.limit !== undefined && Number(q.limit) > SHARE_MAX_ROWS) q.limit = String(SHARE_MAX_ROWS);
  if (segmentId) q.segment = segmentId;
  return q;
}

/** One report of a share link; `open` = the link has no password (its answers may be cached publicly). */
export async function shareReport(
  env: Bindings,
  token: string,
  report: string,
  funnelId: string | null,
  raw: Record<string, string | undefined>,
  auth: { cookie?: string; password?: string; ip?: string | null; baseUrl: string },
): Promise<{ body: unknown; open: boolean }> {
  if (!isShareReport(report) || (funnelId !== null && (report !== "funnels" || !/^fnl_[0-9a-z]{1,64}$/.test(funnelId))))
    throw notFound("Report", `A shared dashboard answers ${SHARE_REPORTS.join(", ")} (and funnels/<fnl_...>).`);
  const { site, link } = await linkForToken(env, token);
  if (!(await shareUnlocked(env, link, auth.cookie, auth.password, auth.ip ?? null)))
    throw new ApiError(
      401,
      "share_password_required",
      "This dashboard needs its password.",
      "Open the share URL and enter the password (or send it as the x-share-password header).",
    );
  if (link.segment_id) {
    const seg = await env.DB.prepare("SELECT id FROM segments WHERE id = ? AND site_id = ?").bind(link.segment_id, site.id).first();
    if (!seg) throw notFound("Share link", "The segment this link was made for was deleted.");
    if (SITE_WIDE_REPORTS.includes(report))
      throw new ApiError(
        403,
        "not_in_segment",
        "This link shows one segment's traffic, and crawler visits and AI search aren't split by segment.",
        "Ask the site's owner for a link without a segment.",
      );
  }
  // The site's own account, read-only: every service check (the site belongs to the account, no
  // writes) applies as it does for the owner's read-only key.
  const ctx: Ctx = {
    env,
    accountId: site.account_id,
    auth: { accountId: site.account_id, keyId: `share:${link.token.slice(0, 12)}`, scopes: ["read"] },
    baseUrl: auth.baseUrl,
  };
  const q = shareQuery(raw, link.segment_id);
  const open = !link.password_hash;
  switch (report) {
    case "stats":
      return { body: await getStats(ctx, site.id, q), open };
    case "breakdown":
      return { body: await getBreakdown(ctx, site.id, q), open };
    case "timeseries":
      return { body: await getTimeseries(ctx, site.id, q), open };
    case "goals":
      return { body: await listGoals(ctx, site.id), open };
    case "funnels":
      return { body: funnelId ? await getFunnel(ctx, site.id, { ...q, funnel_id: funnelId }) : await listFunnels(ctx, site.id), open };
    case "insights":
      return { body: await getInsights(ctx, site.id, q), open };
    case "crawlers":
      return { body: await getCrawlers(ctx, site.id, q), open };
    case "ai-search":
      return { body: await getAiSearch(ctx, site.id, q), open };
    case "web-vitals":
      return { body: await getWebVitals(ctx, site.id, q), open };
    case "realtime": {
      // The counts only: realtime's event list is one visitor at a time.
      const r = (await getRealtime(ctx, site.id, { ...(q.segment ? { segment: q.segment } : {}), limit: 1 })) as Record<string, unknown>;
      return {
        body: {
          online: r.online,
          visitors_last_5m: r.visitors_last_5m,
          visitors_last_30m: r.visitors_last_30m,
          pageviews_last_30m: r.pageviews_last_30m,
        },
        open,
      };
    }
  }
}

/** The domain the share page is titled with: null unless the site proved it. */
export async function shareSiteDomain(env: Bindings, token: string): Promise<string | null> {
  const s = await siteForToken(env, token);
  return isVerified(s) ? s.domain : null;
}
