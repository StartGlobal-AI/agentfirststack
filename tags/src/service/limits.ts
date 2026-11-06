import { capFor, type Standing } from "@afs/shared";

/**
 * Storage, fan-out and abuse caps. Each is an optional var with a safe default in code (or off),
 * so a deployment that sets nothing is protected; "0" turns a cap off (self-hosting). Every cap
 * reads `UNCLAIMED_<NAME>` first for accounts no person has claimed (capFor in @afs/shared).
 */
export const DEFAULT_MAX_VERSIONS_PER_CONTAINER = 50;
export const DEFAULT_MAX_DRAFT_BYTES = 512 * 1024;
export const DEFAULT_MAX_DESTINATIONS_PER_CONTAINER = 10;
/** Drafts + kept versions of all of an account's containers, serialised JSON. */
export const DEFAULT_MAX_TAGS_BYTES_PER_ACCOUNT = 20 * 1024 * 1024;
/** Visitor rows per container; the least recently seen are evicted past it. */
export const DEFAULT_MAX_VISITORS_PER_CONTAINER = 250_000;
/** A container's Durable Object database; /collect stops writing above it. */
export const DEFAULT_MAX_CONTAINER_DB_BYTES = 1024 * 1024 * 1024;
/** Consecutive failed delivery attempts that open a destination's circuit, and for how long. */
export const DEFAULT_CIRCUIT_BREAKER_FAILURES = 20;
export const DEFAULT_CIRCUIT_BREAKER_MINUTES = 60;
/** Environment snippets per container. */
export const DEFAULT_MAX_ENVIRONMENTS_PER_CONTAINER = 5;
/** Enrichment lookup tables per container, rows per table, and bytes per table (serialised JSON). */
export const DEFAULT_MAX_LOOKUPS_PER_CONTAINER = 10;
export const DEFAULT_MAX_LOOKUP_ROWS = 10_000;
export const DEFAULT_MAX_LOOKUP_BYTES = 1024 * 1024;

/** Consent banner records (proof of consent) are kept 12 months. */
export const CONSENT_RETENTION_DAYS = 365;

/** A claimed account (or a deployment without the people tables): the plain caps apply. */
export const CLAIMED: Standing = { suspended: false, claimed: true };

/** Unset, empty or invalid -> `fallback`; "0" -> Infinity (no cap); else the positive integer. */
export function capVar(raw: unknown, fallback: number): number {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

/**
 * capFor() with this app's convention: `UNCLAIMED_<name>` for unclaimed accounts, else `<name>`;
 * unset or invalid -> `fallback`; "0" -> no cap.
 */
export function standingCap(env: object, standing: Standing, name: string, fallback: number): number {
  const n = capFor(env as Record<string, unknown>, standing, name, Number.NaN);
  if (Number.isNaN(n)) return fallback;
  return n === 0 ? Number.POSITIVE_INFINITY : Math.floor(n);
}

/**
 * A capFor-style on/off switch: `UNCLAIMED_<name>` for unclaimed accounts (default `unclaimedDefault`),
 * `<name>` for claimed ones (default `claimedDefault`). "true"/"1" and "false"/"0".
 */
export function standingFlag(env: object, standing: Standing, name: string, claimedDefault: boolean, unclaimedDefault: boolean): boolean {
  const read = (k: string) => {
    const v = String((env as Record<string, unknown>)[k] ?? "")
      .trim()
      .toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    return undefined;
  };
  if (!standing.claimed) return read(`UNCLAIMED_${name}`) ?? unclaimedDefault;
  return read(name) ?? claimedDefault;
}

/** Control-plane caps (D1 storage, destinations), for one account's standing. */
export function limits(env: object, standing: Standing = CLAIMED) {
  const cap = (name: string, fallback: number) => standingCap(env, standing, name, fallback);
  return {
    maxVersions: cap("MAX_VERSIONS_PER_CONTAINER", DEFAULT_MAX_VERSIONS_PER_CONTAINER),
    maxDraftBytes: cap("MAX_DRAFT_BYTES", DEFAULT_MAX_DRAFT_BYTES),
    maxDestinations: cap("MAX_DESTINATIONS_PER_CONTAINER", DEFAULT_MAX_DESTINATIONS_PER_CONTAINER),
    maxContainers: cap("MAX_CONTAINERS_PER_ACCOUNT", Number.POSITIVE_INFINITY),
    maxAccountBytes: cap("MAX_TAGS_BYTES_PER_ACCOUNT", DEFAULT_MAX_TAGS_BYTES_PER_ACCOUNT),
    maxCustomCodeBytes: cap("MAX_CUSTOM_CODE_BYTES", Number.POSITIVE_INFINITY),
    maxEnvironments: cap("MAX_ENVIRONMENTS_PER_CONTAINER", DEFAULT_MAX_ENVIRONMENTS_PER_CONTAINER),
    maxLookups: cap("MAX_LOOKUPS_PER_CONTAINER", DEFAULT_MAX_LOOKUPS_PER_CONTAINER),
    maxLookupRows: cap("MAX_LOOKUP_ROWS", DEFAULT_MAX_LOOKUP_ROWS),
    // A lookup is one D1 row (D1 rows max out at 2 MB), so this cap never goes past 1.5 MB.
    maxLookupBytes: Math.min(cap("MAX_LOOKUP_BYTES", DEFAULT_MAX_LOOKUP_BYTES), 1_500_000),
  };
}

/** Data-plane caps a ContainerDO enforces (per container, per UTC day where it says so; see also eventBudgets). */
export function containerCaps(env: object, standing: Standing = CLAIMED) {
  const cap = (name: string, fallback: number) => standingCap(env, standing, name, fallback);
  return {
    /** Browser hits per day, and separately backend events per day. */
    eventsPerDay: cap("MAX_EVENTS_PER_CONTAINER_PER_DAY", Number.POSITIVE_INFINITY),
    deliveriesPerDay: cap("MAX_DELIVERIES_PER_CONTAINER_PER_DAY", Number.POSITIVE_INFINITY),
    visitors: cap("MAX_VISITORS_PER_CONTAINER", DEFAULT_MAX_VISITORS_PER_CONTAINER),
    dbBytes: cap("MAX_CONTAINER_DB_BYTES", DEFAULT_MAX_CONTAINER_DB_BYTES),
    /** Consent banner choices recorded as proof of consent (the rest still apply in the browser, unrecorded). Unset = off. */
    consentRecordsPerDay: cap("MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY", Number.POSITIVE_INFINITY),
  };
}

/** Account and platform-wide daily delivery budgets (counted in D1, see budget.ts). */
export function deliveryBudgets(env: object, standing: Standing = CLAIMED) {
  return {
    perAccount: standingCap(env, standing, "MAX_DELIVERIES_PER_ACCOUNT_PER_DAY", Number.POSITIVE_INFINITY),
    // One platform counter; unclaimed accounts stop at UNCLAIMED_MAX_DELIVERIES_PER_DAY, claimed ones at the full budget.
    platform: standingCap(env, standing, "MAX_DELIVERIES_PER_DAY", Number.POSITIVE_INFINITY),
  };
}

/**
 * Daily budgets of the calls that make this platform fetch other sites or call ad platforms:
 * scans + domain verifications (`scans`) and destination tests (`tests`), per account and for the
 * whole deployment (one platform counter; unclaimed accounts stop at UNCLAIMED_<NAME> on it).
 * Counted in D1 delivery_usage (see reserveOutbound in budget.ts). Unset = off.
 */
export function outboundBudgets(env: object, standing: Standing = CLAIMED) {
  const cap = (name: string) => standingCap(env, standing, name, Number.POSITIVE_INFINITY);
  return {
    scans: { perAccount: cap("MAX_SCANS_PER_ACCOUNT_PER_DAY"), platform: cap("MAX_SCANS_PER_DAY") },
    tests: { perAccount: cap("MAX_DESTINATION_TESTS_PER_ACCOUNT_PER_DAY"), platform: cap("MAX_DESTINATION_TESTS_PER_DAY") },
  };
}
export type OutboundKind = keyof ReturnType<typeof outboundBudgets>;

/**
 * Account and platform-wide daily event budgets (each ContainerDO reports its counts to D1, see
 * budget.ts). Browser hits and backend events are counted, and capped, separately, like
 * MAX_EVENTS_PER_CONTAINER_PER_DAY.
 */
export function eventBudgets(env: object, standing: Standing = CLAIMED) {
  return {
    /** Summed over the account's containers. */
    perAccount: standingCap(env, standing, "MAX_EVENTS_PER_ACCOUNT_PER_DAY", Number.POSITIVE_INFINITY),
    // One platform counter; unclaimed accounts stop at UNCLAIMED_MAX_EVENTS_PER_DAY, claimed ones at the full budget.
    platform: standingCap(env, standing, "MAX_EVENTS_PER_DAY", Number.POSITIVE_INFINITY),
  };
}
export type EventBudgets = ReturnType<typeof eventBudgets>;

/** Do the budgets need the account / platform totals (a D1 aggregate)? No budget = no D1 call. */
export const needsAggregate = (b: EventBudgets) => Number.isFinite(b.perAccount) || Number.isFinite(b.platform);

/** CIRCUIT_BREAKER_FAILURES "0" turns the breaker off; CIRCUIT_BREAKER_MINUTES is how long it stays open. */
export function circuitBreaker(env: { CIRCUIT_BREAKER_FAILURES?: string; CIRCUIT_BREAKER_MINUTES?: string }) {
  const minutes = capVar(env.CIRCUIT_BREAKER_MINUTES, DEFAULT_CIRCUIT_BREAKER_MINUTES);
  return {
    failures: capVar(env.CIRCUIT_BREAKER_FAILURES, DEFAULT_CIRCUIT_BREAKER_FAILURES),
    openMs: (Number.isFinite(minutes) ? minutes : DEFAULT_CIRCUIT_BREAKER_MINUTES) * 60_000,
  };
}

/** For responses: a cap, or null when it's off. */
export const shownCap = (n: number) => (Number.isFinite(n) ? n : null);

/** "2026-11-03": the UTC day daily budgets count in. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
