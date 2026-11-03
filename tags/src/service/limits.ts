/**
 * Storage and fan-out caps. Each is an optional var with a safe default in code, so a deployment
 * that sets nothing is protected; "0" turns a cap off (self-hosting).
 */
export const DEFAULT_MAX_VERSIONS_PER_CONTAINER = 50;
export const DEFAULT_MAX_DRAFT_BYTES = 512 * 1024;
export const DEFAULT_MAX_DESTINATIONS_PER_CONTAINER = 10;

/** Unset, empty or invalid -> `fallback`; "0" -> Infinity (no cap); else the positive integer. */
export function capVar(raw: unknown, fallback: number): number {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

export interface LimitVars {
  MAX_VERSIONS_PER_CONTAINER?: string;
  MAX_DRAFT_BYTES?: string;
  MAX_DESTINATIONS_PER_CONTAINER?: string;
}

export function limits(env: LimitVars) {
  return {
    maxVersions: capVar(env.MAX_VERSIONS_PER_CONTAINER, DEFAULT_MAX_VERSIONS_PER_CONTAINER),
    maxDraftBytes: capVar(env.MAX_DRAFT_BYTES, DEFAULT_MAX_DRAFT_BYTES),
    maxDestinations: capVar(env.MAX_DESTINATIONS_PER_CONTAINER, DEFAULT_MAX_DESTINATIONS_PER_CONTAINER),
  };
}

/** For responses: a cap, or null when it's off. */
export const shownCap = (n: number) => (Number.isFinite(n) ? n : null);
