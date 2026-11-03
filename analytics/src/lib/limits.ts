import { ApiError, type Standing, capFor } from "@afs/shared";

/**
 * Fair-use limits for a free, open-signup deployment. Every number here is a var (all optional:
 * unset = off, or the safe default named below), and every account-level cap reads an
 * `UNCLAIMED_<NAME>` variant first for accounts nobody has claimed (capFor in @afs/shared), so
 * agent-only accounts can get lower limits than ones a person signed in to.
 *
 * Rate limits use Workers rate-limit bindings (wrangler.jsonc, namespaces 42001-42009). A missing
 * binding means "no limit", and a binding that errors fails open: analytics should lose a limit
 * check before it loses a visitor.
 */

/** The vars ingest and retention read, passed from the Worker to the site's Durable Object. */
export const LIMIT_VARS = [
  "DEV_MODE",
  "MAX_EVENTS_PER_SITE_PER_DAY",
  "MAX_EVENTS_PER_ACCOUNT_PER_DAY",
  "DAILY_EVENT_BUDGET",
  "MAX_SITE_STORAGE_MB",
  "MIN_RETENTION_DAYS",
  "MAX_RETENTION_DAYS",
] as const;

export type LimitVars = Record<string, string | undefined>;

/** The limit vars of an env (both plain and UNCLAIMED_ forms), as a small plain object for RPC. */
export function limitVars(env: object): LimitVars {
  const e = env as Record<string, unknown>;
  const out: LimitVars = {};
  for (const k of LIMIT_VARS) {
    for (const name of [k, `UNCLAIMED_${k}`]) {
      const v = e[name];
      if (typeof v === "string" && v !== "") out[name] = v;
    }
  }
  return out;
}

export interface IngestCaps {
  /** accepted events (and engagement beacons) per site per UTC day */
  siteDaily: number;
  /** the same, summed over every site of the account */
  accountDaily: number;
  /** the whole deployment's events per UTC day (unclaimed accounts are refused at the lower UNCLAIMED_ value) */
  platformDaily: number;
  /** stop writing once the site's Durable Object database is this big */
  storageBytes: number;
}

export function ingestCaps(vars: LimitVars, standing: Standing): IngestCaps {
  const mb = capFor(vars, standing, "MAX_SITE_STORAGE_MB", Number.POSITIVE_INFINITY);
  return {
    siteDaily: capFor(vars, standing, "MAX_EVENTS_PER_SITE_PER_DAY", Number.POSITIVE_INFINITY),
    accountDaily: capFor(vars, standing, "MAX_EVENTS_PER_ACCOUNT_PER_DAY", Number.POSITIVE_INFINITY),
    platformDaily: capFor(vars, standing, "DAILY_EVENT_BUDGET", Number.POSITIVE_INFINITY),
    storageBytes: Number.isFinite(mb) ? Math.floor(mb * 1024 * 1024) : Number.POSITIVE_INFINITY,
  };
}

/** Do the caps need the account / platform totals (a D1 aggregate)? */
export const needsAggregate = (c: IngestCaps) => Number.isFinite(c.accountDaily) || Number.isFinite(c.platformDaily);

/** Schema bounds of retention_days (the zod schema) and the default for new sites. */
export const RETENTION_SCHEMA = { min: 1, max: 3650, default: 400 } as const;

/**
 * Retention bounds for an account: MIN_RETENTION_DAYS keeps data long enough that the storage
 * budget, not a daily purge, bounds a site (no fill-and-purge churn); MAX_RETENTION_DAYS bounds
 * storage. min never exceeds max.
 */
export function retentionBounds(vars: object, standing: Standing): { min: number; max: number; default: number } {
  const max = Math.min(
    RETENTION_SCHEMA.max,
    Math.max(1, Math.floor(capFor(vars as Record<string, unknown>, standing, "MAX_RETENTION_DAYS", RETENTION_SCHEMA.max))),
  );
  const min = Math.min(
    max,
    Math.max(1, Math.floor(capFor(vars as Record<string, unknown>, standing, "MIN_RETENTION_DAYS", RETENTION_SCHEMA.min))),
  );
  return { min, max, default: Math.min(max, Math.max(min, RETENTION_SCHEMA.default)) };
}

/** The retention the daily purge applies: the site's setting, clamped to the account's bounds. */
export function effectiveRetention(vars: object, standing: Standing, days: number): number {
  const b = retentionBounds(vars, standing);
  return Math.min(b.max, Math.max(b.min, days));
}

/** A count cap (sites, goals, share links, funnels, annotations): 0 means no cap, as before. */
export function siteCap(env: object, standing: Standing, name: string, fallback: number): number {
  const n = capFor(env as Record<string, unknown>, standing, name, fallback);
  return n > 0 ? n : Number.POSITIVE_INFINITY;
}

/** Safe defaults when the var is unset (a goal list rides in the site's DO settings, < 2 MB). */
export const DEFAULT_MAX_GOALS_PER_SITE = 100;
export const DEFAULT_MAX_SHARE_LINKS_PER_SITE = 10;
/** SQL wall time a site may use per 10 minutes (ms) when SQL_TIME_BUDGET_MS is unset. */
export const DEFAULT_SQL_TIME_BUDGET_MS = 60_000;
export const SQL_BUDGET_WINDOW_MS = 10 * 60_000;

/** One call to a rate-limit binding. True = allowed (no binding, or the binding failed). */
export async function allow(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

export function rateLimited(what: string, hint: string): ApiError {
  return new ApiError(429, "rate_limited", `Too many ${what}.`, hint);
}

/** Throw 429 unless every (binding, key) pair allows the call. */
export async function enforce(checks: [RateLimit | undefined, string][], what: string, hint: string): Promise<void> {
  for (const [b, k] of checks) if (!(await allow(b, k))) throw rateLimited(what, hint);
}

export const quotaExceeded = (message: string, hint: string) => new ApiError(403, "quota_exceeded", message, hint);
