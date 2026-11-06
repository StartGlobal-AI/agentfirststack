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
   * errors of a verified site with analytics_site_id are forwarded there as events, and analytics
   * funnels can be read for get_funnel_dropoffs. Unbound = off.
   */
  ANALYTICS?: Fetcher;
  /**
   * Optional service binding to the tags Worker. With INTERNAL_TOKEN set, a verified site with
   * tags_container_id queues its chosen signals and survey scores and sends them in batches to
   * POST /v1/containers/:id/events there (server events, routed on to GA4 and ad platforms by the
   * container's config). Unbound = off.
   */
  TAGS?: Fetcher;
  /**
   * Optional Cloudflare Browser Rendering binding ("browser": { "binding": "BROWSER" }): renders
   * heatmap images (GET /v1/sites/:id/heatmap/image) from a recorded snapshot. Unbound = off (503).
   */
  BROWSER?: BrowserRun;
  /**
   * Edge rate limits on the public browser routes (Workers rate-limit bindings, per Cloudflare
   * location): per client network (loader + ingest, before any D1 read), per site and network,
   * and per site. Unbound = off.
   */
  INGEST_IP_LIMITER?: RateLimit;
  INGEST_SITE_IP_LIMITER?: RateLimit;
  INGEST_SITE_LIMITER?: RateLimit;
  PUBLIC_BASE_URL?: string;
  SIGNUP_MODE?: string;
  SIGNUP_TOKEN?: string;
  ADMIN_TOKEN?: string;
  /** "true" in local dev only: x-dev-geo-country, localhost origins, verify may fetch localhost. */
  DEV_MODE?: string;
  /**
   * Hosted fair-use controls (README "Config"). Count caps read through capFor(), so each also has
   * an UNCLAIMED_<NAME> variant for accounts no person has claimed. Unset = the built-in default
   * named in src/lib/limits.ts (DEFAULTS), or no cap.
   */
  MAX_SITES_PER_ACCOUNT?: string;
  MAX_UNVERIFIED_SITES_PER_ACCOUNT?: string;
  /** Cap on every site's sample_rate (0..1). */
  MAX_SAMPLE_RATE?: string;
  /** Cap on every site's max_session_minutes. */
  MAX_SESSION_MINUTES?: string;
  /** Recorded sessions a site may start per UTC day; more are refused (the recorder stops). */
  MAX_SESSIONS_PER_SITE_PER_DAY?: string;
  MAX_UNVERIFIED_SESSIONS_PER_SITE_PER_DAY?: string;
  MAX_FORCED_SESSIONS_PER_SITE_PER_DAY?: string;
  /** New sessions per site per day that afsr('upgrade') started (default 50; they count as sessions too). */
  MAX_UPGRADED_SESSIONS_PER_SITE_PER_DAY?: string;
  MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY?: string;
  MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY?: string;
  /** Signals and survey scores queued for the linked tags container per site per UTC day (default 500). */
  MAX_TAGS_EVENTS_PER_SITE_PER_DAY?: string;
  /** Heatmap images rendered per UTC day (cached images are free): per site, per account, deployment-wide. */
  MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY?: string;
  MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY?: string;
  MAX_PLATFORM_HEATMAP_IMAGES_PER_DAY?: string;
  /** Bytes per ingest request (compressed). Lower than the built-in 1 MB only. */
  MAX_CHUNK_BYTES?: string;
  /** Stored bytes per session (compressed). Lower than the built-in 20 MB only. */
  MAX_SESSION_BYTES?: string;
  MAX_CHUNKS_PER_SESSION?: string;
  MAX_DERIVED_PER_CHUNK?: string;
  MAX_DERIVED_PER_SESSION?: string;
  MAX_SESSIONS_PER_ACCOUNT_PER_DAY?: string;
  MAX_CHUNKS_PER_ACCOUNT_PER_DAY?: string;
  MAX_BYTES_PER_ACCOUNT_PER_DAY?: string;
  MAX_DERIVED_PER_ACCOUNT_PER_DAY?: string;
  /**
   * One site's daily chunks, stored bytes and derived rows (429 site_daily_limit), so a flooded
   * site stops alone. Unset: half the account's budget for that counter when it has one.
   */
  MAX_CHUNKS_PER_SITE_PER_DAY?: string;
  MAX_BYTES_PER_SITE_PER_DAY?: string;
  MAX_DERIVED_PER_SITE_PER_DAY?: string;
  /** Stored bytes one client network may send one site per UTC day (429 ip_bytes_limit). Unset: a tenth of the site's byte budget. */
  MAX_BYTES_PER_IP_PER_SITE_PER_DAY?: string;
  MAX_PLATFORM_SESSIONS_PER_DAY?: string;
  MAX_PLATFORM_CHUNKS_PER_DAY?: string;
  MAX_PLATFORM_BYTES_PER_DAY?: string;
  MAX_PLATFORM_DERIVED_PER_DAY?: string;
  /** Cap on every site's retention_days. */
  MAX_RETENTION_DAYS?: string;
  MAX_HEATMAP_RETENTION_DAYS?: string;
  /** Active (unexpired, unrevoked) share links per site. */
  MAX_LINKS_PER_SITE?: string;
  MAX_LINK_BYTES_PER_DAY?: string;
  MAX_VERIFY_PER_ACCOUNT_PER_HOUR?: string;
  /** "false" = new sites start with capture_console_errors off. */
  CAPTURE_CONSOLE_ERRORS_DEFAULT?: string;
  /** "true" = new sites start with capture_network_errors on. */
  CAPTURE_NETWORK_ERRORS_DEFAULT?: string;
  /** Rows per session export (default 10,000, at most 100,000); recorded bytes raw event exports may read per site per day (default 100 MB). */
  MAX_EXPORT_ROWS?: string;
  MAX_EXPORT_BYTES_PER_DAY?: string;
  /** Event definitions per site (default 20). */
  MAX_EVENT_DEFINITIONS_PER_SITE?: string;
  /** Saved segments per site (default 50). */
  MAX_SEGMENTS_PER_SITE?: string;
  /** Surveys (defaults in lib/limits.ts DEFAULTS): per site, active per site, questions, answer length, responses per day. */
  MAX_SURVEYS_PER_SITE?: string;
  MAX_ACTIVE_SURVEYS_PER_SITE?: string;
  MAX_QUESTIONS_PER_SURVEY?: string;
  MAX_ANSWER_CHARS?: string;
  MAX_RESPONSES_PER_SITE_PER_DAY?: string;
  MAX_RESPONSES_PER_NETWORK_PER_SITE_PER_DAY?: string;
  MAX_TEST_RESPONSES_PER_SITE_PER_DAY?: string;
  MAX_IMPRESSIONS_PER_NETWORK_PER_SITE_PER_DAY?: string;
  /**
   * 32-byte base64 key that seals webhook secrets at rest (secret). Without it webhooks can't be
   * created (DEV_MODE: stored plain). Also derives each site's path-proxy key (service/proxy.ts).
   */
  ENCRYPTION_KEY?: string;
  /** Webhooks per account (default 10), deliveries per account per UTC day (1000), test sends per day (50). */
  MAX_WEBHOOKS_PER_ACCOUNT?: string;
  MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY?: string;
  MAX_WEBHOOK_TESTS_PER_DAY?: string;
  /** Session annotations: starred sessions per site (default 100), how long they are kept (days, default 90), notes, labels. */
  MAX_STARRED_SESSIONS_PER_SITE?: string;
  MAX_STARRED_RETENTION_DAYS?: string;
  /** Bytes of starred sessions' playback copies per site (default 200 MB). */
  MAX_STARRED_BYTES_PER_SITE?: string;
  MAX_NOTES_PER_SESSION?: string;
  MAX_NOTES_PER_SITE?: string;
  MAX_LABELS_PER_SITE?: string;
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
