import { ApiError, notFound } from "@afs/shared";
import type { Bindings } from "../env";
import { SITE_ID_RE } from "../lib/protocol";

/** What every service call needs: bindings, the caller's account, and the public base URL. */
export interface Ctx {
  env: Bindings;
  accountId: string;
  baseUrl: string;
  /** schedule work after the response (R2 deletes, analytics forwarding) */
  waitUntil: (p: Promise<unknown>) => void;
}

/** D1 row of `sites`. JSON columns are strings. */
export interface SiteRow {
  id: string;
  account_id: string;
  domain: string;
  name: string | null;
  enabled: number;
  sample_rate: number;
  mask_mode: "strict" | "balanced" | "relaxed";
  unmask_selectors: string;
  mask_selectors: string;
  block_selectors: string;
  exclude_paths: string;
  allowed_hostnames: string | null;
  max_session_minutes: number;
  retention_days: number;
  heatmap_retention_days: number;
  capture_console_errors: number;
  require_consent: number;
  analytics_site_id: string | null;
  purged_at: number | null;
  created_at: number;
  updated_at: number;
}

export const jsonList = (s: string | null | undefined): string[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export function siteStub(env: Bindings, siteId: string) {
  return env.SITE.get(env.SITE.idFromName(siteId));
}

export async function loadSite(ctx: Ctx, siteId: string): Promise<SiteRow> {
  if (!SITE_ID_RE.test(siteId))
    throw notFound("Replay site", "Replay site ids look like rsite_xxxxxxxxxxxxxxxx. GET /v1/sites lists yours.");
  const row = await ctx.env.DB.prepare("SELECT * FROM sites WHERE id = ? AND account_id = ?").bind(siteId, ctx.accountId).first<SiteRow>();
  if (!row) throw notFound("Replay site", "GET /v1/sites lists the replay sites this key can see.");
  return row;
}

// Ingest and the loader script read site rows on every request; keep them briefly per isolate.
const SITE_CACHE_MS = 30_000;
const cache = new Map<string, { row: SiteRow | null; at: number }>();

export async function siteById(env: Bindings, siteId: string): Promise<SiteRow | null> {
  const hit = cache.get(siteId);
  const now = Date.now();
  if (hit && now - hit.at < SITE_CACHE_MS) return hit.row;
  const row = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
  if (cache.size > 5000) cache.clear();
  cache.set(siteId, { row: row ?? null, at: now });
  return row ?? null;
}

export const forgetSite = (siteId: string) => cache.delete(siteId);

/** DO errors are values; this turns one into an ApiError. */
export function doFailure(e: { error: { code: string; message: string; hint?: string } }): never {
  throw new ApiError(e.error.code === "not_found" ? 404 : 400, e.error.code, e.error.message, e.error.hint);
}
