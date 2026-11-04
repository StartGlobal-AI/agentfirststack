import { ApiError, accountStanding, accountSuspended, assertPermanentKey, notFound, parse, randomString } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { DEFAULT_MAX_SHARE_LINKS_PER_SITE, enforce, quotaExceeded, siteCap } from "../lib/limits";
import { DEFAULT_METRICS } from "../lib/filters";
import { PERIODS } from "../lib/time";
import { type Ctx, type SiteRow, callSite, isVerified, loadSite } from "./context";
import { verifyRecord } from "./sites";

export const createShareInput = z.object({
  new: z.boolean().optional().describe("Create an additional link even if one exists (default: return the existing one)."),
});

const shareUrl = (baseUrl: string, token: string) => `${baseUrl}/share/${token}`;

export async function createShareLink(ctx: Ctx, siteId: string, raw: unknown) {
  // A share URL never expires: a connected app's 8-hour token must not get one (new or existing).
  assertPermanentKey(ctx.auth, "create share links");
  const input = parse(createShareInput, raw);
  const site = await loadSite(ctx, siteId);
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
  if (!input.new) {
    const existing = await ctx.env.DB.prepare(
      "SELECT token, created_at FROM share_links WHERE site_id = ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1",
    )
      .bind(site.id)
      .first<{ token: string; created_at: number }>();
    if (existing)
      return { url: shareUrl(ctx.baseUrl, existing.token), token: existing.token, existing: true, created_at: existing.created_at };
  }
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
  await ctx.env.DB.prepare("INSERT INTO share_links (token, site_id, created_at) VALUES (?, ?, ?)").bind(token, site.id, now).run();
  return {
    url: shareUrl(ctx.baseUrl, token),
    token,
    existing: false,
    created_at: now,
    note: "Anyone with this URL can see aggregate stats for this site (no raw events, no SQL). Revoke with DELETE /v1/sites/:id/share.",
  };
}

export async function revokeShareLinks(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  // A revoked token can never be used again, so its row goes (create + revoke can't grow the table).
  const res = await ctx.env.DB.prepare("DELETE FROM share_links WHERE site_id = ?").bind(site.id).run();
  return { revoked: res.meta.changes ?? 0 };
}

async function siteForToken(env: Bindings, token: string): Promise<SiteRow> {
  if (!/^shr_[0-9a-z]{32}$/.test(token)) throw notFound("Share link");
  await enforce([[env.SHARE_LIMITER, `share:${token}`]], "dashboard requests", "Wait a minute and reload.");
  const row = await env.DB.prepare(
    "SELECT s.* FROM share_links l JOIN sites s ON s.id = l.site_id WHERE l.token = ? AND l.revoked_at IS NULL",
  )
    .bind(token)
    .first<SiteRow>();
  if (!row) throw notFound("Share link", "The link was revoked or never existed.");
  // A suspended account's public dashboards go dark with it.
  if ((await accountStanding(env, row.account_id)).suspended) throw accountSuspended();
  return row;
}

export const shareDataInput = z.object({ period: z.enum(PERIODS).exclude(["custom"]).optional() });

/** Everything the public dashboard renders, in one call. Aggregates only. */
export async function shareData(env: Bindings, token: string, raw: unknown) {
  const { period = "30d" } = parse(shareDataInput, raw);
  const site = await siteForToken(env, token);
  const base = { period, filters: [], metrics: [...DEFAULT_METRICS] };
  const top = (breakdown: "page" | "source" | "country" | "device") =>
    callSite(env, site, (s) => s.breakdown({ ...base, metrics: ["visitors", "pageviews"], breakdown, limit: 10 })).then(
      (r) => (r as { results: unknown[] }).results,
    );
  const [stats, series, pages, sources, countries, devices] = await Promise.all([
    callSite(env, site, (s) => s.stats({ ...base, compare: { mode: "previous" } })),
    callSite(env, site, (s) => s.timeseries({ period, filters: [], metrics: ["visitors", "pageviews"] })),
    top("page"),
    top("source"),
    top("country"),
    top("device"),
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
  };
}

/** The domain the share page is titled with: null unless the site proved it. */
export async function shareSiteDomain(env: Bindings, token: string): Promise<string | null> {
  const s = await siteForToken(env, token);
  return isVerified(s) ? s.domain : null;
}
