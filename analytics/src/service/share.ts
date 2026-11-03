import { notFound, parse, randomString } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { DEFAULT_METRICS } from "../lib/filters";
import { PERIODS } from "../lib/time";
import { type Ctx, type SiteRow, callSite, loadSite } from "./context";

export const createShareInput = z.object({
  new: z.boolean().optional().describe("Create an additional link even if one exists (default: return the existing one)."),
});

const shareUrl = (baseUrl: string, token: string) => `${baseUrl}/share/${token}`;

export async function createShareLink(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(createShareInput, raw);
  const site = await loadSite(ctx, siteId);
  if (!input.new) {
    const existing = await ctx.env.DB.prepare(
      "SELECT token, created_at FROM share_links WHERE site_id = ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1",
    )
      .bind(site.id)
      .first<{ token: string; created_at: number }>();
    if (existing)
      return { url: shareUrl(ctx.baseUrl, existing.token), token: existing.token, existing: true, created_at: existing.created_at };
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
  const res = await ctx.env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE site_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), site.id)
    .run();
  return { revoked: res.meta.changes ?? 0 };
}

async function siteForToken(env: Bindings, token: string): Promise<SiteRow> {
  if (!/^shr_[0-9a-z]{32}$/.test(token)) throw notFound("Share link");
  const row = await env.DB.prepare(
    "SELECT s.* FROM share_links l JOIN sites s ON s.id = l.site_id WHERE l.token = ? AND l.revoked_at IS NULL",
  )
    .bind(token)
    .first<SiteRow>();
  if (!row) throw notFound("Share link", "The link was revoked or never existed.");
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
  return {
    site: { domain: site.domain, name: site.name, timezone: site.timezone },
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

export async function shareSiteName(env: Bindings, token: string): Promise<string> {
  const s = await siteForToken(env, token);
  return s.name || s.domain;
}
