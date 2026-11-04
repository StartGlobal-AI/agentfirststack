import { capFor, type Standing } from "@afs/shared";
import { type Bindings, numVar } from "../env";

/**
 * Built-in hard limits. They always apply; the optional fair-use vars (env.ts) can only tighten
 * them. Everything ingest does is bounded by these, so one chunk's Worker CPU and one session's DO
 * storage stay small whatever a browser sends.
 */
export const LIMITS = {
  /** compressed bytes per ingest request */
  CHUNK_BYTES: 1_048_576,
  /** decompressed bytes per chunk (zip-bomb guard) */
  DECOMPRESSED_BYTES: 8 * 1_048_576,
  /** compressed bytes stored per session */
  SESSION_BYTES: 20 * 1_048_576,
  CHUNKS_PER_SESSION: 2_000,
  /** rrweb events looked at per chunk when deriving */
  EVENTS_PER_CHUNK: 50_000,
  /** ceilings for MAX_DERIVED_PER_CHUNK / MAX_DERIVED_PER_SESSION (derived rows: clicks, inputs, errors, events, marks) */
  DERIVED_PER_CHUNK_MAX: 2_000,
  DERIVED_PER_SESSION_MAX: 10_000,
  PAGES_PER_SESSION: 500,
  /** custom tag keys per session (afsr('set') + identify attributes) and values per key */
  TAG_KEYS_PER_SESSION: 20,
  TAG_VALUES_PER_KEY: 5,
  ERRORS_PER_SESSION: 300,
  /** failed requests kept per session (capture_network_errors) */
  NET_PER_SESSION: 200,
  /** clicks kept in any 1 s window (nobody clicks faster; more is a script, and it would make rage detection expensive) */
  CLICKS_PER_SECOND: 20,
  /** effect timestamps per chunk sent to the DO for dead-click resolution across chunks */
  EFFECT_HEAD: 200,
  SESSION_MINUTES_MAX: 240,
  RETENTION_DAYS_MAX: 365,
  HEATMAP_RETENTION_DAYS_MAX: 730,
  LINK_SECONDS_MAX: 30 * 86_400,
  SITES_DEFAULT_LIST: 500,
} as const;

/** Defaults for new sites, and the built-in values of the caps that are on even when their var is unset. */
export const DEFAULTS = {
  SAMPLE_RATE: 1,
  MAX_SESSION_MINUTES: 30,
  RETENTION_DAYS: 30,
  HEATMAP_RETENTION_DAYS: 180,
  IDLE_MS: 5 * 60_000,
  LINK_SECONDS: 7 * 86_400,
  DERIVED_PER_CHUNK: 500,
  DERIVED_PER_SESSION: 1_500,
  FORCED_SESSIONS_PER_SITE_PER_DAY: 20,
  UPGRADED_SESSIONS_PER_SITE_PER_DAY: 50,
  SESSIONS_PER_IP_PER_SITE_PER_DAY: 50,
  UNVERIFIED_SESSIONS_PER_SITE_PER_DAY: 20,
  UNVERIFIED_SITES_PER_ACCOUNT: 1,
  FORWARDED_EVENTS_PER_SITE_PER_DAY: 500,
  LINK_BYTES_PER_DAY: 50 * 1_048_576,
  VERIFY_PER_ACCOUNT_PER_HOUR: 30,
  SEGMENTS_PER_SITE: 50,
  SURVEYS_PER_SITE: 10,
  ACTIVE_SURVEYS_PER_SITE: 3,
  QUESTIONS_PER_SURVEY: 20,
  ANSWER_CHARS: 2000,
  RESPONSES_PER_SITE_PER_DAY: 500,
  RESPONSES_PER_NETWORK_PER_SITE_PER_DAY: 5,
  TEST_RESPONSES_PER_SITE_PER_DAY: 20,
  IMPRESSIONS_PER_NETWORK_PER_SITE_PER_DAY: 50,
  STARRED_SESSIONS_PER_SITE: 100,
  STARRED_RETENTION_DAYS: 90,
  NOTES_PER_SESSION: 50,
  NOTES_PER_SITE: 2000,
  LABELS_PER_SESSION: 5,
  LABELS_PER_SITE: 1000,
  WEBHOOKS_PER_ACCOUNT: 10,
  WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY: 1000,
  WEBHOOK_TESTS_PER_DAY: 50,
  EVENT_DEFINITIONS_PER_SITE: 20,
  EXPORT_ROWS: 10_000,
  EXPORT_BYTES_PER_DAY: 100 * 1_048_576,
} as const;

const capped = (hard: number, v: string | undefined) => Math.min(hard, numVar(v) ?? Number.POSITIVE_INFINITY);

export const chunkBytesLimit = (env: Bindings) => Math.floor(capped(LIMITS.CHUNK_BYTES, env.MAX_CHUNK_BYTES));
export const sessionBytesLimit = (env: Bindings) => Math.floor(capped(LIMITS.SESSION_BYTES, env.MAX_SESSION_BYTES));
export const sampleRateCap = (env: Bindings) => Math.min(1, numVar(env.MAX_SAMPLE_RATE) ?? 1);
export const sessionMinutesCap = (env: Bindings) => Math.floor(capped(LIMITS.SESSION_MINUTES_MAX, env.MAX_SESSION_MINUTES));
export const retentionDaysCap = (env: Bindings) => Math.floor(capped(LIMITS.RETENTION_DAYS_MAX, env.MAX_RETENTION_DAYS));
export const heatmapRetentionDaysCap = (env: Bindings) =>
  Math.max(7, Math.floor(capped(LIMITS.HEATMAP_RETENTION_DAYS_MAX, env.MAX_HEATMAP_RETENTION_DAYS)));

/** How long a starred session is kept (it outlives retention_days up to this). */
export const starredRetentionDays = (env: Bindings) =>
  Math.floor(Math.min(LIMITS.RETENTION_DAYS_MAX, numVar(env.MAX_STARRED_RETENTION_DAYS) ?? DEFAULTS.STARRED_RETENTION_DAYS));

/**
 * A count cap by account standing (UNCLAIMED_<NAME> for accounts no person has claimed), or null
 * for "no cap". `fallback` applies when neither var is set (Infinity = off).
 */
export function cap(env: Bindings, standing: Standing, name: string, fallback: number): number | null {
  const n = capFor(env as unknown as Record<string, unknown>, standing, name, fallback);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** The counters every site, account and the whole deployment keep per UTC day. */
export const COUNTERS = ["sessions", "chunks", "bytes", "derived"] as const;
export type Counter = (typeof COUNTERS)[number];
export type Totals = Record<Counter, number>;
/** A cap per counter; null = no cap. */
export type Budget = Record<Counter, number | null>;

export const zeroTotals = (): Totals => ({ sessions: 0, chunks: 0, bytes: 0, derived: 0 });
export const hasBudget = (b: Budget) => COUNTERS.some((k) => b[k] !== null);

const VAR: Record<Counter, string> = { sessions: "SESSIONS", chunks: "CHUNKS", bytes: "BYTES", derived: "DERIVED" };

/** MAX_<COUNTER>_PER_ACCOUNT_PER_DAY (and UNCLAIMED_ variants). Unset = no cap. */
export function accountBudget(env: Bindings, standing: Standing): Budget {
  const b = {} as Budget;
  for (const k of COUNTERS) b[k] = cap(env, standing, `MAX_${VAR[k]}_PER_ACCOUNT_PER_DAY`, Number.POSITIVE_INFINITY);
  return b;
}

/**
 * MAX_PLATFORM_<COUNTER>_PER_DAY: the whole deployment's daily budget. Past it, ingest answers 429
 * for everyone (UNCLAIMED_ variants set a lower line at which unclaimed accounts are refused first).
 */
export function platformBudget(env: Bindings, standing: Standing): Budget {
  const b = {} as Budget;
  for (const k of COUNTERS) b[k] = cap(env, standing, `MAX_PLATFORM_${VAR[k]}_PER_DAY`, Number.POSITIVE_INFINITY);
  return b;
}

/** Everything ingest needs to decide one chunk, by the account's standing and the site's verification. */
export function ingestCaps(env: Bindings, standing: Standing, verified: boolean) {
  const clamp = (n: number | null, max: number) => Math.max(0, Math.min(max, n ?? max));
  const siteDaily = cap(env, standing, "MAX_SESSIONS_PER_SITE_PER_DAY", Number.POSITIVE_INFINITY);
  const trial = cap(env, standing, "MAX_UNVERIFIED_SESSIONS_PER_SITE_PER_DAY", DEFAULTS.UNVERIFIED_SESSIONS_PER_SITE_PER_DAY);
  return {
    derived_per_chunk: clamp(cap(env, standing, "MAX_DERIVED_PER_CHUNK", DEFAULTS.DERIVED_PER_CHUNK), LIMITS.DERIVED_PER_CHUNK_MAX),
    derived_per_session: clamp(cap(env, standing, "MAX_DERIVED_PER_SESSION", DEFAULTS.DERIVED_PER_SESSION), LIMITS.DERIVED_PER_SESSION_MAX),
    chunks_per_session: clamp(cap(env, standing, "MAX_CHUNKS_PER_SESSION", LIMITS.CHUNKS_PER_SESSION), LIMITS.CHUNKS_PER_SESSION),
    /** non-forced sessions per site per day; the trial cap while the domain isn't verified */
    daily_sessions: verified ? siteDaily : siteDaily === null ? trial : trial === null ? siteDaily : Math.min(siteDaily, trial),
    forced_daily: cap(env, standing, "MAX_FORCED_SESSIONS_PER_SITE_PER_DAY", DEFAULTS.FORCED_SESSIONS_PER_SITE_PER_DAY),
    upgraded_daily: cap(env, standing, "MAX_UPGRADED_SESSIONS_PER_SITE_PER_DAY", DEFAULTS.UPGRADED_SESSIONS_PER_SITE_PER_DAY),
    net_daily: cap(env, standing, "MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY", DEFAULTS.SESSIONS_PER_IP_PER_SITE_PER_DAY),
    forward_daily: cap(env, standing, "MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY", DEFAULTS.FORWARDED_EVENTS_PER_SITE_PER_DAY),
    account: accountBudget(env, standing),
    platform: platformBudget(env, standing),
  };
}

export type IngestCaps = ReturnType<typeof ingestCaps>;
