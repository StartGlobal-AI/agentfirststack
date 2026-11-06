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
  /**
   * The deployment's own analytics (src/own-analytics.ts): the project (acct_...) and analytics
   * site (site_...) that get a server event for each signup and claim here. Off unless both are set.
   */
  OWN_ANALYTICS_ACCOUNT_ID?: string;
  OWN_ANALYTICS_SITE_ID?: string;
  /** Proxy keys of our own analytics site and tags container: our pages use /_a/* and /_t/* (src/first-party.ts). Secrets. */
  OWN_ANALYTICS_PROXY_KEY?: string;
  OWN_TAGS_PROXY_KEY?: string;
  /**
   * First-party domains on Cloudflare for SaaS (src/first-party-domains.ts): a token with Zone > SSL
   * and Certificates Edit and Zone > Workers Routes Edit (secret), the SaaS zone, the originless
   * fallback host customers CNAME to (fp.example.com) and this Worker's name, which serves them.
   * Off (503 not_configured) unless all four are set.
   */
  CF_SAAS_API_TOKEN?: string;
  CF_SAAS_ZONE_ID?: string;
  CF_SAAS_FALLBACK_HOST?: string;
  CF_SAAS_WORKER?: string;
  /** First-party domains per project (unset = no cap), and the cap for projects nobody claimed. */
  MAX_FIRST_PARTY_DOMAINS_PER_ACCOUNT?: string;
  UNCLAIMED_MAX_FIRST_PARTY_DOMAINS_PER_ACCOUNT?: string;
  /** The emails the platform sends people (src/email.ts): the EMAIL binding and this sender. */
  EMAIL?: SendEmail;
  NOTIFY_EMAIL_FROM?: string;
  NOTIFY_REPLY_TO?: string;
  /** The operator's daily summary (src/operator-digest.ts): comma-separated addresses; off when unset. */
  OPERATOR_EMAIL?: string;
  MAX_EMAILS_PER_PERSON_PER_DAY?: string;
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
