import type { AuthBindings, AuthContext } from "@afs/shared";
import type { SiteDO } from "./do/site-do";

/** Bindings, vars and secrets (see wrangler.jsonc and .dev.vars.example). */
export interface Bindings extends AuthBindings {
  DB: D1Database;
  SITE: DurableObjectNamespace<SiteDO>;
  PUBLIC_BASE_URL?: string;
  SIGNUP_MODE?: string;
  SIGNUP_TOKEN?: string;
  ADMIN_TOKEN?: string;
  /** Derives the daily visitor salt. Required outside DEV_MODE. */
  SALT_SECRET?: string;
  /** "true" in local dev only: x-dev-geo-* headers, localhost verify, fallback salt. */
  DEV_MODE?: string;
  /** Hosted fair use: max sites per account. Unset = no cap. */
  MAX_SITES_PER_ACCOUNT?: string;
  /**
   * SQL endpoint: rows SQLite may read while streaming a query's results (after its first row)
   * before the query is stopped. Unset = engine.DEFAULT_SQL_MAX_ROWS_READ (1,000,000).
   */
  SQL_MAX_ROWS_READ?: string;
  /**
   * Seals third-party secrets at rest (the Stripe webhook signing secret): 32 bytes, base64
   * (openssl rand -base64 32). Optional; without it connecting Stripe is refused with a hint.
   */
  ENCRYPTION_KEY?: string;
  /** Fair use: max manual annotations per site. Unset = no cap. */
  MAX_ANNOTATIONS_PER_SITE?: string;
  /** Fair use: max saved funnels per site. Unset = no cap. */
  MAX_FUNNELS_PER_SITE?: string;
}

export type AppEnv = { Bindings: Bindings; Variables: { auth: AuthContext } };

export const isDev = (env: Bindings) => env.DEV_MODE === "true";

export const VERSION = "0.1.0";
