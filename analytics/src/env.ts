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
  /** Hosted fair use: max sites per account (UNCLAIMED_MAX_SITES_PER_ACCOUNT for unclaimed accounts). Unset = no cap. */
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
  /** cost rows (date x source x campaign) a site keeps (default 50000; UNCLAIMED_ variant) */
  MAX_COST_ROWS_PER_SITE?: string;
  /** crawler hits counted per site per UTC day (default 100000; UNCLAIMED_ variant) */
  MAX_CRAWL_HITS_PER_SITE_PER_DAY?: string;
  /** crawler hits per account (all its sites) and for the whole deployment per UTC day (unset = none; UNCLAIMED_ variants) */
  MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY?: string;
  MAX_CRAWL_HITS_PER_DAY?: string;
  /** imported GA4 / Plausible rows a site keeps (default 500000) and imports (files) per site (default 100); UNCLAIMED_ variants */
  MAX_IMPORTED_ROWS_PER_SITE?: string;
  MAX_IMPORTS_PER_SITE?: string;
  /** raw events exported per site per UTC day (default 1000000; UNCLAIMED_ variant) */
  MAX_EXPORT_ROWS_PER_SITE_PER_DAY?: string;
  /** Fair use: max saved funnels per site. Unset = no cap. */
  MAX_FUNNELS_PER_SITE?: string;
  /**
   * The replay service's public URL (e.g. https://replay.example.com). With it, the tracker of a
   * site that has replay_site_id loads REPLAY_BASE_URL/r/<replay_site_id>.js by itself. Unset = off.
   */
  REPLAY_BASE_URL?: string;

  // Fair use (all optional; every account-level one also reads UNCLAIMED_<NAME> for accounts no
  // person has claimed, via capFor). See src/lib/limits.ts and README "Config".
  /** Accepted events (+ engagement beacons) per site per UTC day; 429 beyond. Unset = no cap. */
  MAX_EVENTS_PER_SITE_PER_DAY?: string;
  /** The same summed over the account's sites (D1 aggregate, reported once a minute). Unset = no cap. */
  MAX_EVENTS_PER_ACCOUNT_PER_DAY?: string;
  /** Events per UTC day for the whole deployment; 429 beyond (UNCLAIMED_ = the level at which unclaimed accounts are shed). */
  DAILY_EVENT_BUDGET?: string;
  /** Stop storing a site's events once its Durable Object database passes this many MB. Unset = no budget. */
  MAX_SITE_STORAGE_MB?: string;
  /** Attack protection: browser events one network may send a site per UTC day before the rest are quarantined. Unset = no share. */
  MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY?: string;
  /** Quarantined events kept per site per UTC day (past it they are dropped). Unset = no cap. */
  MAX_QUARANTINED_EVENTS_PER_SITE_PER_DAY?: string;
  /** Spike detection: the fewest accepted browser events in 15 minutes that count as a spike. Default 1000. */
  SPIKE_MIN_EVENTS?: string;
  /** Bounds for retention_days (and what the daily purge applies). Unset = 1..3650. */
  MIN_RETENTION_DAYS?: string;
  MAX_RETENTION_DAYS?: string;
  /** Goals per site (they ride in the DO's settings copy). Default 100. */
  MAX_GOALS_PER_SITE?: string;
  /** Active share links per site. Default 10. */
  MAX_SHARE_LINKS_PER_SITE?: string;
  /** SQL wall time a site may use per 10 minutes, in ms. Default 60000. */
  SQL_TIME_BUDGET_MS?: string;
  /** Alert rules per site. Default 20. */
  MAX_ALERTS_PER_SITE?: string;
  /** Alert / report destinations (webhook, Slack, email) per site. Default 5. */
  MAX_ALERT_DESTINATIONS_PER_SITE?: string;
  /** Scheduled reports per site. Default 5. */
  MAX_REPORTS_PER_SITE?: string;
  /** Alert, report and test deliveries (one per destination) per site per UTC day. Default 100. */
  MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY?: string;
  /** Of those, emails per site per UTC day. Default 10. */
  MAX_ALERT_EMAILS_PER_SITE_PER_DAY?: string;
  /** Saved segments per site. Default 50. */
  MAX_SEGMENTS_PER_SITE?: string;

  /**
   * Optional Cloudflare Email Service binding (send_email in wrangler.jsonc) plus the sender
   * address on a domain onboarded for Email Sending: with both, alerts and reports can go to the
   * project's members by email. Without either, email destinations are refused (503 not_configured).
   */
  EMAIL?: SendEmail;
  ALERT_EMAIL_FROM?: string;

  // Workers rate-limit bindings (wrangler.jsonc "ratelimits"); each is optional (absent = no limit).
  /** POST /e per client network (networkKey: an IPv4 address or an IPv6 prefix; the forwarded visitor IP behind a keyed proxy). */
  INGEST_IP_LIMITER?: RateLimit;
  /** POST /e per site. */
  INGEST_SITE_LIMITER?: RateLimit;
  /** Server events and payments API calls per account. */
  API_INGEST_LIMITER?: RateLimit;
  /** SQL queries per account. */
  SQL_LIMITER?: RateLimit;
  /** verify per account and per verified domain. */
  VERIFY_LIMITER?: RateLimit;
  /** Stripe webhook deliveries per site id. */
  WEBHOOK_LIMITER?: RateLimit;
  /** Public share dashboard reads per share token. */
  SHARE_LIMITER?: RateLimit;
}

export type AppEnv = { Bindings: Bindings; Variables: { auth: AuthContext } };

export const isDev = (env: Bindings) => env.DEV_MODE === "true";

export const VERSION = "0.1.0";
