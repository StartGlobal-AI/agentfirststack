import type { AuthBindings, AuthContext } from "@afs/shared";
import type { ReplaySiteDO } from "./do/site-do";

/** Bindings, vars and secrets (see wrangler.jsonc and .dev.vars.example). */
export interface Bindings extends AuthBindings {
  DB: D1Database;
  SITE: DurableObjectNamespace<ReplaySiteDO>;
  /** Recording chunks: <site_id>/<session_id>/<seq>, gzip JSON as received. */
  CHUNKS: R2Bucket;
  /**
   * Optional service binding to the analytics Worker. With INTERNAL_TOKEN set, signals and JS
   * errors of a site with analytics_site_id are forwarded there as events, and analytics funnels
   * can be read for get_funnel_dropoffs. Unbound = off.
   */
  ANALYTICS?: Fetcher;
  PUBLIC_BASE_URL?: string;
  SIGNUP_MODE?: string;
  SIGNUP_TOKEN?: string;
  ADMIN_TOKEN?: string;
  /** "true" in local dev only: x-dev-geo-country, localhost origins, verify may fetch localhost. */
  DEV_MODE?: string;
  /**
   * Hosted fair-use controls. All optional; unset (or empty) = off, i.e. only the built-in hard
   * limits apply (see src/lib/limits.ts and README "Config").
   */
  MAX_SITES_PER_ACCOUNT?: string;
  /** Cap on every site's sample_rate (0..1). */
  MAX_SAMPLE_RATE?: string;
  /** Cap on every site's max_session_minutes. */
  MAX_SESSION_MINUTES?: string;
  /** Recorded sessions a site may start per UTC day; more are refused (the recorder stops). */
  MAX_SESSIONS_PER_SITE_PER_DAY?: string;
  /** Bytes per ingest request (compressed). Lower than the built-in 1 MB only. */
  MAX_CHUNK_BYTES?: string;
  /** Stored bytes per session (compressed). Lower than the built-in 20 MB only. */
  MAX_SESSION_BYTES?: string;
  /** Cap on every site's retention_days. */
  MAX_RETENTION_DAYS?: string;
  /** Active (unexpired, unrevoked) share links per site. */
  MAX_LINKS_PER_SITE?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: { auth: AuthContext } };

export const isDev = (env: Bindings) => env.DEV_MODE === "true";

export const VERSION = "0.1.0";

/** A positive number var, or null when unset, empty, zero or not a number (= the control is off). */
export function numVar(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
