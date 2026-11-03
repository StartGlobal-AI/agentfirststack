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
  /** derived rows (clicks, inputs, errors, events, marks) kept per chunk and per session */
  DERIVED_PER_CHUNK: 2_000,
  DERIVED_PER_SESSION: 10_000,
  PAGES_PER_SESSION: 500,
  ERRORS_PER_SESSION: 300,
  /** effect timestamps per chunk sent to the DO for dead-click resolution across chunks */
  EFFECT_HEAD: 200,
  SESSION_MINUTES_MAX: 240,
  RETENTION_DAYS_MAX: 365,
  HEATMAP_RETENTION_DAYS_MAX: 730,
  LINK_SECONDS_MAX: 30 * 86_400,
  SITES_DEFAULT_LIST: 500,
} as const;

/** Defaults for new sites. */
export const DEFAULTS = {
  SAMPLE_RATE: 1,
  MAX_SESSION_MINUTES: 30,
  RETENTION_DAYS: 30,
  HEATMAP_RETENTION_DAYS: 180,
  IDLE_MS: 5 * 60_000,
  LINK_SECONDS: 7 * 86_400,
} as const;

const capped = (hard: number, v: string | undefined) => Math.min(hard, numVar(v) ?? Number.POSITIVE_INFINITY);

export const chunkBytesLimit = (env: Bindings) => Math.floor(capped(LIMITS.CHUNK_BYTES, env.MAX_CHUNK_BYTES));
export const sessionBytesLimit = (env: Bindings) => Math.floor(capped(LIMITS.SESSION_BYTES, env.MAX_SESSION_BYTES));
export const sampleRateCap = (env: Bindings) => Math.min(1, numVar(env.MAX_SAMPLE_RATE) ?? 1);
export const sessionMinutesCap = (env: Bindings) => Math.floor(capped(LIMITS.SESSION_MINUTES_MAX, env.MAX_SESSION_MINUTES));
export const retentionDaysCap = (env: Bindings) => Math.floor(capped(LIMITS.RETENTION_DAYS_MAX, env.MAX_RETENTION_DAYS));
/** null = no daily cap */
export const dailySessionsCap = (env: Bindings) => {
  const n = numVar(env.MAX_SESSIONS_PER_SITE_PER_DAY);
  return n === null ? null : Math.floor(n);
};
