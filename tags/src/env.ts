import type { AuthContext } from "@afs/shared";

/**
 * Worker bindings. `Env` comes from `wrangler types` (wrangler.jsonc + .dev.vars); the optional
 * fields keep typecheck working when .dev.vars doesn't exist.
 */
export type Bindings = Env & {
  ENCRYPTION_KEY?: string;
  /** Hosted fair use: max containers per account. Unset = no cap. */
  MAX_CONTAINERS_PER_ACCOUNT?: string;
  /** Published versions kept per container (newest first; the live one is never pruned). Default 50, "0" = keep all. */
  MAX_VERSIONS_PER_CONTAINER?: string;
  /** Largest draft config in bytes (serialised JSON). Default 524288 (512 KB), "0" = no cap below D1's row limit. */
  MAX_DRAFT_BYTES?: string;
  /** Server-side destinations per container (each /collect conversion fans out to all). Default 10, "0" = no cap. */
  MAX_DESTINATIONS_PER_CONTAINER?: string;
  ADMIN_TOKEN?: string;
  SIGNUP_TOKEN?: string;
  DEV_MODE?: string;
  ANALYTICS_BASE_URL?: string;
};

export type AppEnv = { Bindings: Bindings; Variables: { auth: AuthContext } };

export const isDevMode = (env: { DEV_MODE?: unknown }) => String(env.DEV_MODE ?? "") === "true";
