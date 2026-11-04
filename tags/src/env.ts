import type { AuthContext } from "@afs/shared";

/**
 * Worker bindings. `Env` comes from `wrangler types` (wrangler.jsonc + .dev.vars); the optional
 * fields keep typecheck working when .dev.vars doesn't exist. Every cap below also reads
 * `UNCLAIMED_<NAME>` for accounts no person has claimed (see src/service/limits.ts); "0" = off.
 */
export type Bindings = Env & {
  ENCRYPTION_KEY?: string;
  /** Max containers per account. Unset = no cap. */
  MAX_CONTAINERS_PER_ACCOUNT?: string;
  /** Published versions kept per container (newest first; the live one is never pruned). Default 50, "0" = keep all. */
  MAX_VERSIONS_PER_CONTAINER?: string;
  /** Largest draft config in bytes (serialised JSON). Default 524288 (512 KB), "0" = no cap below D1's row limit. */
  MAX_DRAFT_BYTES?: string;
  /** Server-side destinations per container (each /collect conversion fans out to all). Default 10, "0" = no cap. */
  MAX_DESTINATIONS_PER_CONTAINER?: string;
  /** Bytes of drafts + kept versions across an account's containers. Default 20 MB. */
  MAX_TAGS_BYTES_PER_ACCOUNT?: string;
  /** custom_html + custom_js (and external analytics scripts) bytes per config. Unset = only the 50 KB per-tag schema limit. */
  MAX_CUSTOM_CODE_BYTES?: string;
  /** "false" stops claimed accounts publishing custom code; UNCLAIMED_ALLOW_CUSTOM_CODE ("true" to allow) for unclaimed ones (default not allowed). */
  ALLOW_CUSTOM_CODE?: string;
  UNCLAIMED_ALLOW_CUSTOM_CODE?: string;
  /** Daily delivery budgets (UTC day): per container, per account, platform-wide. Unset = off. */
  MAX_DELIVERIES_PER_CONTAINER_PER_DAY?: string;
  MAX_DELIVERIES_PER_ACCOUNT_PER_DAY?: string;
  MAX_DELIVERIES_PER_DAY?: string;
  /** Browser hits per container per UTC day, and separately backend events. Unset = off. */
  MAX_EVENTS_PER_CONTAINER_PER_DAY?: string;
  /**
   * The same, summed over an account's containers, and for the whole deployment (unclaimed accounts
   * stop at UNCLAIMED_MAX_EVENTS_PER_DAY on the same counter). Counted in D1. Unset = off.
   */
  MAX_EVENTS_PER_ACCOUNT_PER_DAY?: string;
  MAX_EVENTS_PER_DAY?: string;
  /** Visitor rows kept per container (least recently seen evicted). Default 250000. */
  MAX_VISITORS_PER_CONTAINER?: string;
  /** A container's Durable Object database size above which /collect stops writing. Default 1 GiB. */
  MAX_CONTAINER_DB_BYTES?: string;
  /** Environment snippets per container. Default 5. */
  MAX_ENVIRONMENTS_PER_CONTAINER?: string;
  /** Enrichment lookup tables per container (default 10), rows per table (default 10000), bytes per table (default 1048576, at most 1.5 MB). */
  MAX_LOOKUPS_PER_CONTAINER?: string;
  MAX_LOOKUP_ROWS?: string;
  MAX_LOOKUP_BYTES?: string;
  /** Consecutive failed attempts that open a destination's circuit (default 20, "0" = off), and minutes it stays open (default 60). */
  CIRCUIT_BREAKER_FAILURES?: string;
  CIRCUIT_BREAKER_MINUTES?: string;
  ADMIN_TOKEN?: string;
  /** The site's public URL (set by `pnpm afs`); refusal hints point to its claim links. */
  AUTH_ISSUER?: string;
  SIGNUP_TOKEN?: string;
  DEV_MODE?: string;
  ANALYTICS_BASE_URL?: string;
  /** Workers rate-limit bindings (wrangler.jsonc `ratelimits`); each is skipped when not bound. */
  COLLECT_IP_LIMITER?: RateLimit;
  COLLECT_CONTAINER_LIMITER?: RateLimit;
  CONVERSION_IP_LIMITER?: RateLimit;
  CONVERSION_CONTAINER_LIMITER?: RateLimit;
  SCAN_LIMITER?: RateLimit;
  TEST_LIMITER?: RateLimit;
  SERVER_EVENTS_LIMITER?: RateLimit;
};

export type AppEnv = { Bindings: Bindings; Variables: { auth: AuthContext } };

export const isDevMode = (env: { DEV_MODE?: unknown }) => String(env.DEV_MODE ?? "") === "true";
