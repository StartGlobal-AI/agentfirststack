import { z } from "zod";
import { compact, type Connector, type DispatchEvent, execute, type SendContext } from "./types";

/**
 * The sibling analytics app's server ingest (analytics/README.md):
 *   POST {base_url}/v1/sites/{site_id}/events   Authorization: Bearer <api_key>
 *   { events: [{ name, timestamp, url, visitor_id?, user_id?, ip, user_agent, country, region,
 *                city, referrer, props, revenue: { amount, currency } }] }
 * The tags Worker is not where the visitor is, so ip, user_agent and geo are passed explicitly.
 * visitor_id is only sent when the browser exposed the analytics app's own id (afsa.visitorId()).
 */
export const analyticsCredentials = z.strictObject({
  site_id: z.string().regex(/^site_[a-z0-9]+$/, "The analytics site id (site_...)."),
  api_key: z.string().min(8).describe("An analytics API key (ana_...) with write scope."),
  base_url: z.url().optional().describe("Analytics app base URL; default ANALYTICS_BASE_URL."),
});
export type AnalyticsCredentials = z.infer<typeof analyticsCredentials>;

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
    ...(e.test ? { test: true } : {}),
  });
  return {
    events: [
      compact({
        name: e.send_to.analytics?.event_name ?? e.name,
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
  testMode: "No test mode: sends one real event named tags_test with props.test = true.",
  example: { site_id: "site_3k9x2m7q8w1e5r4t", api_key: "ana_xxxxxxxx", base_url: "https://analytics.example.com" },
  docs: "analytics/README.md (POST /v1/sites/:id/events)",
  async send(e, c, ctx) {
    const base = analyticsBaseUrl(c, ctx.env);
    if (!base) return { ok: false, retryable: false, error: "No base_url in credentials and ANALYTICS_BASE_URL is not set." };
    const body = buildAnalyticsBody(ctx.test ? { ...e, name: "tags_test", test: true, send_to: {} } : e);
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
