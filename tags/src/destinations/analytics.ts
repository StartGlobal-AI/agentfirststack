import { ApiError } from "@afs/shared";
import { z } from "zod";
import { isIpLiteral } from "../lib/domain";
import { deploymentOrigins, targetsDeployment } from "../lib/http";
import { compact, type Connector, type DispatchEvent, execute, type SendContext } from "./types";

/**
 * The sibling analytics app's server ingest (analytics/README.md):
 *   POST {base_url}/v1/sites/{site_id}/events   Authorization: Bearer <api_key>
 *   { events: [{ name, timestamp, url, visitor_id?, user_id?, ip, user_agent, country, region,
 *                city, referrer, props, revenue: { amount, currency } }] }
 * Without an api_key, on a deployment with the ANALYTICS service binding and INTERNAL_TOKEN, the
 * same request goes to https://analytics.internal over the binding with internal auth
 * (x-afs-internal + x-afs-account: the container's account, from D1), so analytics checks the
 * site belongs to that account exactly as it does for an API key (404 otherwise).
 * The tags Worker is not where the visitor is, so ip, user_agent and geo are passed explicitly.
 * visitor_id is only sent when the browser exposed the analytics app's own id (afsa.visitorId()).
 */
export const analyticsCredentials = z.strictObject({
  site_id: z.string().regex(/^site_[a-z0-9]+$/, "The analytics site id (site_...)."),
  api_key: z
    .string()
    .min(8)
    .optional()
    .describe(
      "An API key (afs_...) with write scope on the analytics app; one key works for every app of the deployment. Optional when this deployment has the ANALYTICS service binding: events then go over it as this container's account (a site of another account is refused).",
    ),
  base_url: z
    .url()
    .optional()
    .describe(
      "With api_key only: the analytics app base URL; default ANALYTICS_BASE_URL. Must be https on the same host as ANALYTICS_BASE_URL (when the deployment sets it), with no query string.",
    ),
});
export type AnalyticsCredentials = z.infer<typeof analyticsCredentials>;

const LOCAL = (h: string) => ["localhost", "127.0.0.1", "[::1]"].includes(h) || h.endsWith(".localhost");

/**
 * Why a base_url can't be used, or null. The destination POSTs events there and its test returns
 * the answer, so it must be the analytics app itself: https, the host of ANALYTICS_BASE_URL when
 * the deployment sets one, no credentials, query or fragment, no IP literal, not this deployment.
 */
export function analyticsBaseUrlProblem(raw: string | undefined, env: SendContext["env"], origins: string[] = []): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "base_url is not a URL.";
  }
  const dev = String(env.DEV_MODE) === "true";
  const local = dev && LOCAL(u.hostname.toLowerCase());
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return "base_url must be an https URL.";
  if (u.username || u.password) return "base_url can't contain credentials.";
  if (u.search || u.hash || raw.includes("?") || raw.includes("#")) return "base_url can't have a query string or fragment.";
  if (u.port && u.port !== "443" && !local) return "base_url must use the default https port.";
  if (isIpLiteral(u.hostname) && !local) return "base_url can't be an IP address.";
  if (targetsDeployment(u, deploymentOrigins(env, origins), dev))
    return "base_url points at this tags deployment; use the analytics app's URL.";
  if (env.ANALYTICS_BASE_URL) {
    let own: URL | null = null;
    try {
      own = new URL(env.ANALYTICS_BASE_URL);
    } catch {
      own = null;
    }
    if (own && own.hostname.toLowerCase() !== u.hostname.toLowerCase())
      return `base_url must be on ${own.hostname} (this deployment's analytics app); leave it out to use ${env.ANALYTICS_BASE_URL}.`;
  }
  return null;
}

/** This deployment can reach its analytics Worker without an API key (service binding + INTERNAL_TOKEN). */
export const analyticsBindingAvailable = (env: SendContext["env"]) => !!env.ANALYTICS && !!env.INTERNAL_TOKEN;

/** Service bindings ignore the host; `.internal` marks the request as one (see @afs/shared viaServiceBinding). */
const INTERNAL_ORIGIN = "https://analytics.internal";

const internalHeaders = (env: SendContext["env"], accountId: string) => ({
  "x-afs-internal": env.INTERNAL_TOKEN ?? "",
  "x-afs-account": accountId,
});

/**
 * A site the container's account may send to, checked over the binding before an api_key-less
 * destination is saved. Throws a 400 when analytics doesn't know the site for this account.
 */
export async function checkAnalyticsSite(env: SendContext["env"], accountId: string, siteId: string): Promise<void> {
  let status: number;
  try {
    const res = await env.ANALYTICS!.fetch(`${INTERNAL_ORIGIN}/v1/sites/${encodeURIComponent(siteId)}`, {
      headers: { ...internalHeaders(env, accountId), accept: "application/json" },
    });
    status = res.status;
    await res.body?.cancel().catch(() => undefined);
  } catch {
    status = 0;
  }
  if (status === 200) return;
  if (status === 404)
    throw new ApiError(
      400,
      "analytics_site_not_found",
      `Analytics site ${siteId} was not found on this account.`,
      "Use the id of an analytics site of the same account (analytics GET /v1/sites with the same key), or create one with analytics POST /v1/sites { domain }.",
    );
  throw new ApiError(
    502,
    "analytics_unavailable",
    `The analytics service answered ${status ? `HTTP ${status}` : "nothing"} when checking ${siteId}.`,
    "Retry in a minute, or pass credentials.api_key to deliver with a key instead.",
  );
}

export function analyticsBaseUrl(c: AnalyticsCredentials, env: SendContext["env"]): string | null {
  const b = c.base_url || env.ANALYTICS_BASE_URL;
  return b ? b.replace(/\/$/, "") : null;
}

/** Click id types the analytics app accepts (its click_id_type enum). */
const ANALYTICS_CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id", "twclid", "rdt_cid"] as const;

function utmAndClick(e: DispatchEvent) {
  const out: Record<string, string> = {};
  const ft = e.first_touch ?? {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const v = ft[k];
    if (typeof v === "string" && v) out[k] = v.slice(0, 200);
  }
  const type = ANALYTICS_CLICK_IDS.find((k) => e.click_ids[k]);
  if (type) {
    out.click_id_type = type;
    out.click_id = e.click_ids[type]!.slice(0, 500);
  }
  return out;
}

export function buildAnalyticsBody(e: DispatchEvent) {
  const props = compact({
    event_id: e.event_id,
    transaction_id: e.transaction_id,
    source: e.source === "server" ? "tags_server" : "tags",
    ...(Object.fromEntries(
      Object.entries(e.params ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"),
    ) as Record<string, string | number | boolean>),
  });
  return {
    events: [
      compact({
        name: e.send_to.analytics?.event_name ?? e.name,
        // Test traffic (preview hits, test: true server events, destination tests) is analytics'
        // own test traffic: stored, but left out of every report unless a query asks for debug.
        debug: e.test ? true : undefined,
        timestamp: e.ts,
        url: e.page_url,
        visitor_id: e.analytics_visitor_id,
        user_id: e.user_id,
        ip: e.ip,
        user_agent: e.user_agent,
        country: e.geo?.country,
        region: e.geo?.region,
        region_code: e.geo?.region_code,
        city: e.geo?.city,
        ...utmAndClick(e),
        referrer: e.referrer,
        props,
        revenue: e.value !== undefined && e.currency ? { amount: e.value, currency: e.currency } : undefined,
      }),
    ],
  };
}

export const analytics: Connector<AnalyticsCredentials> = {
  type: "analytics",
  label: "analytics app (server ingest)",
  api: "POST {base_url}/v1/sites/{site_id}/events",
  credentials: analyticsCredentials,
  publicFields: ["site_id", "base_url"],
  naturalKey: (c) => c.site_id,
  requiredConsent: [],
  skipIfFiredBy: "analytics",
  needsMapping: false,
  testMode:
    "Sends one event named tags_test with debug: true: analytics stores it as test traffic, left out of every report unless a query passes debug=include or debug=only (GET /v1/sites/:id/realtime?debug=only shows it). Preview hits and test: true server events are sent with debug: true too.",
  example: { site_id: "site_3k9x2m7q8w1e5r4t", api_key: "afs_xxxxxxxx" },
  docs: "analytics/README.md (POST /v1/sites/:id/events)",
  check(c, env, origins) {
    if (!c.api_key && !analyticsBindingAvailable(env))
      throw new Error(
        "credentials.api_key is required here: this deployment has no ANALYTICS service binding (with INTERNAL_TOKEN) to deliver without one. Pass your afs_ API key (one key works for every app).",
      );
    if (!c.api_key) return; // over the binding: base_url isn't used
    const problem = analyticsBaseUrlProblem(c.base_url, env, origins);
    if (problem) throw new Error(problem);
  },
  async verify(c, env, accountId) {
    if (!c.api_key && analyticsBindingAvailable(env)) await checkAnalyticsSite(env, accountId, c.site_id);
  },
  async send(e, c, ctx) {
    // A destination test's sample is named tags_test; preview and test: true traffic keep their
    // names. All of them are sent with debug: true (see buildAnalyticsBody).
    const body = buildAnalyticsBody(
      ctx.sample ? { ...e, name: "tags_test", test: true, send_to: {} } : ctx.test ? { ...e, test: true } : e,
    );
    if (!c.api_key) {
      // Over the ANALYTICS binding as the container's account: analytics answers 404 for a site
      // of another account, which fails the delivery (not retried).
      if (!analyticsBindingAvailable(ctx.env) || !ctx.accountId)
        return {
          ok: false,
          retryable: false,
          error:
            "No api_key in credentials, and this deployment has no ANALYTICS service binding (with INTERNAL_TOKEN). PATCH credentials.api_key.",
        };
      const binding = ctx.env.ANALYTICS!;
      return execute(
        {
          url: `${INTERNAL_ORIGIN}/v1/sites/${encodeURIComponent(c.site_id)}/events`,
          method: "POST",
          headers: internalHeaders(ctx.env, ctx.accountId),
          body,
        },
        { ...ctx, fetch: ((input: RequestInfo | URL, init?: RequestInit) => binding.fetch(input, init)) as typeof fetch },
      );
    }
    // Re-checked at send time: destinations saved by older code, or vars changed since.
    const problem = analyticsBaseUrlProblem(c.base_url, ctx.env);
    if (problem) return { ok: false, retryable: false, error: `${problem} PATCH credentials.base_url (null uses the default).` };
    const base = analyticsBaseUrl(c, ctx.env);
    if (!base) return { ok: false, retryable: false, error: "No base_url in credentials and ANALYTICS_BASE_URL is not set." };
    return execute(
      {
        url: `${base}/v1/sites/${encodeURIComponent(c.site_id)}/events`,
        method: "POST",
        headers: { authorization: `Bearer ${c.api_key}` },
        body,
      },
      ctx,
    );
  },
};
