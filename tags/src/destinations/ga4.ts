import { z } from "zod";
import { compact, type Connector, type DispatchEvent, execute } from "./types";

/**
 * GA4 Measurement Protocol (web streams).
 *   POST https://www.google-analytics.com/mp/collect?measurement_id=G-..&api_secret=..
 *   test: POST /debug/mp/collect -> { validationMessages: [...] } (nothing is recorded)
 * GA4 does not dedupe MP hits against gtag hits, so when the browser ga4 tag already sent the
 * conversion the server copy is skipped (ad-blocked browsers still get counted server-side).
 */
export const ga4Credentials = z.strictObject({
  measurement_id: z.string().regex(/^G-[A-Z0-9]{4,15}$/, "Looks like G-ABC123XYZ."),
  api_secret: z.string().min(8).max(200).describe("Admin > Data streams > (stream) > Measurement Protocol API secrets."),
  region: z.enum(["global", "eu"]).optional().describe("eu = region1.google-analytics.com (EU collection)."),
});
export type Ga4Credentials = z.infer<typeof ga4Credentials>;

const GA4_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export function buildGa4Body(e: DispatchEvent, c: Ga4Credentials) {
  const name = e.send_to.ga4?.event_name ?? e.name;
  const adUserData = e.consent.ad_user_data ?? "granted";
  const userData =
    adUserData === "granted"
      ? compact({
          sha256_email_address: (e.user.em_ga4 ?? e.user.em) ? [e.user.em_ga4 ?? e.user.em] : undefined,
          sha256_phone_number: e.user.ph_e164 ? [e.user.ph_e164] : undefined,
          address:
            e.user.fn || e.user.ln || e.user.zp
              ? [
                  compact({
                    sha256_first_name: e.user.fn,
                    sha256_last_name: e.user.ln,
                    city: e.user.ct,
                    region: e.user.st,
                    postal_code: e.user.zp,
                    country: e.user.country?.toUpperCase(),
                  }),
                ]
              : undefined,
        })
      : undefined;
  const params: Record<string, unknown> = compact({
    value: e.value,
    currency: e.currency,
    transaction_id: e.transaction_id,
    items: e.items,
    session_id: e.ga_session_id && /^\d+$/.test(e.ga_session_id) ? e.ga_session_id : undefined,
    engagement_time_msec: 1,
    page_location: e.page_url,
    page_referrer: e.referrer,
    page_title: e.page_title,
    event_id: e.event_id,
    ...(e.test ? { debug_mode: 1 } : {}),
  });
  for (const [k, v] of Object.entries({ ...(e.params ?? {}), ...(e.send_to.ga4?.params ?? {}) })) {
    if (GA4_NAME.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
      params[k] = typeof v === "string" ? v.slice(0, 100) : v;
  }
  const geo = e.geo ?? {};
  return compact({
    client_id: e.ga_client_id ?? e.visitor_id ?? e.event_id,
    user_id: e.user_id,
    timestamp_micros: e.ts * 1000,
    consent: {
      ad_user_data: adUserData === "granted" ? "GRANTED" : "DENIED",
      ad_personalization: (e.consent.ad_personalization ?? "granted") === "granted" ? "GRANTED" : "DENIED",
    },
    user_data: userData,
    user_location: geo.country
      ? compact({ city: geo.city, region_id: geo.region_code ? `${geo.country}-${geo.region_code}` : undefined, country_id: geo.country })
      : undefined,
    ip_override: geo.country ? undefined : e.ip,
    device: e.device
      ? compact({
          category: e.device.category,
          language: e.device.language,
          operating_system: e.device.os,
          operating_system_version: e.device.os_version,
          model: e.device.model,
          brand: e.device.brand,
          browser: e.device.browser,
          browser_version: e.device.browser_version,
        })
      : undefined,
    events: [{ name: GA4_NAME.test(name) ? name : name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40), params }],
  });
}

export function ga4Url(c: Ga4Credentials, test: boolean) {
  const host = c.region === "eu" ? "https://region1.google-analytics.com" : "https://www.google-analytics.com";
  return `${host}/${test ? "debug/mp" : "mp"}/collect?measurement_id=${encodeURIComponent(c.measurement_id)}&api_secret=${encodeURIComponent(c.api_secret)}`;
}

export const ga4: Connector<Ga4Credentials> = {
  type: "ga4",
  label: "Google Analytics 4 (Measurement Protocol)",
  api: "POST https://www.google-analytics.com/mp/collect",
  credentials: ga4Credentials,
  publicFields: ["measurement_id", "region"],
  naturalKey: (c) => c.measurement_id,
  requiredConsent: ["analytics_storage"],
  skipIfFiredBy: "ga4",
  needsMapping: true,
  testMode: "Sends to /debug/mp/collect (validation server, nothing recorded) and returns validationMessages.",
  example: { measurement_id: "G-ABC123XYZ", api_secret: "xxxxxxxxxxxxxxxxxxxxxx" },
  docs: "https://developers.google.com/analytics/devguides/collection/protocol/ga4",
  async send(e, c, ctx) {
    const r = await execute({ url: ga4Url(c, ctx.test || !!e.test), method: "POST", headers: {}, body: buildGa4Body(e, c) }, ctx, [
      "api_secret",
    ]);
    if (ctx.test || e.test) {
      const msgs = (r.json as { validationMessages?: unknown[] } | null)?.validationMessages;
      if (r.ok && Array.isArray(msgs) && msgs.length > 0)
        return { ...r, ok: false, retryable: false, error: "GA4 validation failed; see response.validationMessages." };
    }
    return r;
  },
};
