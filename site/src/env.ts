import type { AuthContext } from "@afs/shared";

/**
 * The site's bindings: what wrangler.jsonc declares (Env, generated) plus secrets and optional
 * vars a deployment may set. An intersection, so a var that's also in .dev.vars stays a string.
 */
export type Bindings = Env & {
  ADMIN_TOKEN?: string;
  SIGNUP_TOKEN?: string;
  SIGNUP_HOURLY_LIMIT?: string;
  SIGNUP_DAILY_LIMIT?: string;
  SIGNUP_ASN_DAILY_LIMIT?: string;
  SIGNUP_GLOBAL_HOURLY_LIMIT?: string;
  /** Active API keys per account (default 50), and the cap for accounts no person has claimed. */
  MAX_KEYS_PER_ACCOUNT?: string;
  UNCLAIMED_MAX_KEYS_PER_ACCOUNT?: string;
  /** New API keys per account per hour (off when unset). */
  KEYS_HOURLY_LIMIT?: string;
  /** Google OAuth client for "Sign in with Google". Without both, sign-in says it's not configured. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Shared with the services: lets the dashboard read a project's resources over service bindings. */
  INTERNAL_TOKEN?: string;
  /** The OAuth issuer (defaults to PUBLIC_BASE_URL, else the request origin). */
  AUTH_ISSUER?: string;
  /** "true" only for local dev and tests: enables GET /auth/dev-login. */
  DEV_MODE?: string;
  /** New OAuth client registrations per network per hour (default 30). */
  OAUTH_REGISTER_HOURLY_LIMIT?: string;
};

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  created_at: number;
}

export interface Session {
  user: User;
  /** sha256 of the cookie value (the sessions row key). */
  hash: string;
  /** Token every state-changing form must echo back. */
  csrf: string;
}

export type SiteEnv = { Bindings: Bindings; Variables: { auth: AuthContext; session: Session } };

export const isDev = (env: Bindings) => env.DEV_MODE === "true";

export const DAY = 86_400_000;
