import { type AuthContext, ApiError, notFound } from "@afs/shared";
import type { Bindings } from "../env";
import { SITE_ID_RE } from "../lib/protocol";

/** What every service call needs: bindings, the caller's account, and the public base URL. */
export interface Ctx {
  env: Bindings;
  accountId: string;
  /** The caller's credential (an API key, an OAuth access token, or internal auth). */
  auth: AuthContext;
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
  /** migration 0008: JSON list of zone selectors */
  zones?: string;
  exclude_paths: string;
  allowed_hostnames: string | null;
  max_session_minutes: number;
  retention_days: number;
  heatmap_retention_days: number;
  capture_console_errors: number;
  require_consent: number;
  analytics_site_id: string | null;
  /** migration 0008: hash afsr('identify') ids in the browser */
  hash_user_ids?: number;
  /** migration 0008: record failed fetch/XHR requests; console.warn */
  capture_network_errors?: number;
  capture_console_warnings?: number;
  auto_events?: number;
  /** migration 0008: api | gcm; JSON list of CIDRs */
  consent_source?: string;
  exclude_ip_ranges?: string | null;
  /** migration 0008: the active surveys' revision (NULL = none active) */
  surveys_rev?: string | null;
  /** when the analytics site confirmed its tracker loads this site's recorder (migration 0007; NULL = not) */
  analytics_linked_at?: number | null;
  purged_at: number | null;
  /** set when verify proved the domain is the account's (homepage loader or DNS TXT) */
  verified_at?: number | null;
  verify_method?: string | null;
  /** last daily kick of the site's Durable Object by the cron */
  maintained_at?: number | null;
  created_at: number;
  updated_at: number;
}

export const isVerified = (s: SiteRow) => s.verified_at !== null && s.verified_at !== undefined;

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
// Unknown ids are remembered longer and in their own map, so a flood of random site ids neither
// costs a D1 read each time it repeats one nor evicts the rows of real sites.
const SITE_CACHE_MS = 30_000;
const MISS_CACHE_MS = 300_000;
const cache = new Map<string, { row: SiteRow; at: number }>();
const misses = new Map<string, number>();

function bounded<K, V>(m: Map<K, V>, max: number) {
  while (m.size >= max) m.delete(m.keys().next().value as K);
}

export async function siteById(env: Bindings, siteId: string): Promise<SiteRow | null> {
  const now = Date.now();
  const hit = cache.get(siteId);
  if (hit && now - hit.at < SITE_CACHE_MS) return hit.row;
  const miss = misses.get(siteId);
  if (miss !== undefined && now - miss < MISS_CACHE_MS) return null;
  const row = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
  if (row) {
    bounded(cache, 5000);
    cache.set(siteId, { row, at: now });
    misses.delete(siteId);
  } else {
    bounded(misses, 20_000);
    misses.set(siteId, now);
  }
  return row ?? null;
}

export const forgetSite = (siteId: string) => {
  cache.delete(siteId);
  misses.delete(siteId);
};

/** DO errors are values; this turns one into an ApiError. */
export function doFailure(e: { error: { code: string; message: string; hint?: string } }): never {
  throw new ApiError(e.error.code === "not_found" ? 404 : 400, e.error.code, e.error.message, e.error.hint);
}
