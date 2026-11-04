import { sha256Hex } from "@afs/shared";
import { z } from "zod";
import { compact, type Connector, type DeliveryResult, type DispatchEvent, execute, type SendContext } from "./types";

/**
 * Google Ads offline click conversions, two transports behind one connector:
 *
 * api = "data_manager" (default)
 *   POST https://datamanager.googleapis.com/v1/events:ingest   (OAuth scope .../auth/datamanager)
 *   No developer token. Google's recommended path for new integrations: since June 15 2026,
 *   UploadClickConversions fails with CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE for developer
 *   tokens that made no offline conversion uploads between Dec 17 2025 and Jun 15 2026.
 *
 * api = "google_ads_api"
 *   POST https://googleads.googleapis.com/v26/customers/{customer_id}:uploadClickConversions
 *   (OAuth scope .../auth/adwords + developer-token header; partialFailure must be true)
 *
 * Both: the conversion action must be type UPLOAD_CLICKS ("Import from clicks"), identifiers are
 * gclid / gbraid / wbraid plus SHA-256 email/phone (enhanced conversions for leads), and
 * transaction id (order id) dedupes within the conversion action. Test mode = validateOnly.
 */
export const GOOGLE_ADS_API_VERSION = "v26";
export const DATA_MANAGER_URL = "https://datamanager.googleapis.com/v1/events:ingest";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const digits = (label: string) =>
  z
    .string()
    .transform((s) => s.replace(/-/g, ""))
    .pipe(z.string().regex(/^\d{3,20}$/, `${label}: digits only (hyphens are stripped).`));

export const googleAdsCredentials = z.strictObject({
  api: z.enum(["data_manager", "google_ads_api"]).optional().describe("Default data_manager (no developer token needed)."),
  customer_id: digits("customer_id").describe("Google Ads account that owns the conversion action, e.g. 123-456-7890."),
  conversion_action_id: digits("conversion_action_id").describe(
    "Numeric id of an UPLOAD_CLICKS conversion action (Goals > Conversions > the action, ctId= in the URL).",
  ),
  login_customer_id: digits("login_customer_id").optional().describe("Manager (MCC) account id when access is through a manager."),
  developer_token: z.string().min(10).optional().describe("Required for api=google_ads_api only."),
  client_id: z.string().min(10).describe("OAuth client id (Google Cloud console)."),
  client_secret: z.string().min(6),
  refresh_token: z
    .string()
    .min(10)
    .describe(
      "Refresh token with scope https://www.googleapis.com/auth/datamanager (data_manager) or https://www.googleapis.com/auth/adwords (google_ads_api).",
    ),
});
export type GoogleAdsCredentials = z.infer<typeof googleAdsCredentials>;

type Consent = "granted" | "denied" | undefined;
const dmConsent = (v: Consent) => (v === "denied" ? "CONSENT_DENIED" : "CONSENT_GRANTED");
const gaConsent = (v: Consent) => (v === "denied" ? "DENIED" : "GRANTED");

/** RFC 3339 with offset (Data Manager eventTimestamp). */
export const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
/** "yyyy-mm-dd HH:mm:ss+00:00" (Google Ads conversionDateTime). */
export const adsDateTime = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "+00:00");

function identifiers(e: DispatchEvent) {
  const em = e.user.em_gads ?? e.user.em;
  return { em, ph: e.user.ph_e164 };
}

export function buildDataManagerBody(e: DispatchEvent, c: GoogleAdsCredentials, validateOnly: boolean) {
  const { em, ph } = identifiers(e);
  const ids: Record<string, unknown>[] = [];
  if (em) ids.push({ emailAddress: em });
  if (ph) ids.push({ phoneNumber: ph });
  if (e.user.fn && e.user.ln && e.user.country && e.user.zp) {
    ids.push({ address: { givenName: e.user.fn, familyName: e.user.ln, regionCode: e.user.country.toUpperCase(), postalCode: e.user.zp } });
  }
  const conversionAction = e.send_to.google_ads?.conversion_action_id ?? c.conversion_action_id;
  return {
    destinations: [
      compact({
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: c.customer_id },
        loginAccount: c.login_customer_id ? { accountType: "GOOGLE_ADS", accountId: c.login_customer_id } : undefined,
        productDestinationId: conversionAction,
      }),
    ],
    encoding: "HEX",
    consent: { adUserData: dmConsent(e.consent.ad_user_data), adPersonalization: dmConsent(e.consent.ad_personalization) },
    validateOnly,
    events: [
      compact({
        adIdentifiers: compact({
          gclid: e.click_ids.gclid,
          gbraid: e.click_ids.gbraid,
          wbraid: e.click_ids.wbraid,
          landingPageDeviceInfo: e.user_agent || e.ip ? compact({ userAgent: e.user_agent, ipAddress: e.ip }) : undefined,
        }),
        conversionValue: e.value,
        currency: e.currency,
        transactionId: e.transaction_id ?? e.event_id,
        eventTimestamp: rfc3339(e.ts),
        eventSource: "WEB",
        userData: ids.length ? { userIdentifiers: ids.slice(0, 10) } : undefined,
      }),
    ],
  };
}

export function buildUploadClickConversionsBody(e: DispatchEvent, c: GoogleAdsCredentials, validateOnly: boolean) {
  const { em, ph } = identifiers(e);
  const hasGclid = !!e.click_ids.gclid;
  // With only gbraid/wbraid Google ignores user identifiers, so don't send them.
  const userIdentifiers =
    hasGclid || (!e.click_ids.gbraid && !e.click_ids.wbraid)
      ? [
          ...(em ? [{ userIdentifierSource: "FIRST_PARTY", hashedEmail: em }] : []),
          ...(ph ? [{ userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: ph }] : []),
        ]
      : [];
  const conversionAction = e.send_to.google_ads?.conversion_action_id ?? c.conversion_action_id;
  return {
    conversions: [
      compact({
        gclid: e.click_ids.gclid,
        gbraid: hasGclid ? undefined : e.click_ids.gbraid,
        wbraid: hasGclid ? undefined : e.click_ids.wbraid,
        conversionAction: `customers/${c.customer_id}/conversionActions/${conversionAction}`,
        conversionDateTime: adsDateTime(e.ts),
        conversionValue: e.value,
        currencyCode: e.currency,
        orderId: e.transaction_id ?? e.event_id,
        userIdentifiers,
        consent: { adUserData: gaConsent(e.consent.ad_user_data), adPersonalization: gaConsent(e.consent.ad_personalization) },
      }),
    ],
    partialFailure: true,
    validateOnly,
  };
}

// Access tokens are cached per isolate (they live ~1h). An isolate serves every account, so the key
// is a hash of the whole credential tuple: one account's token is never used for another's credentials.
const tokenCache = new Map<string, { token: string; exp: number }>();
const MAX_CACHED_TOKENS = 1000;

export const tokenCacheKey = (c: GoogleAdsCredentials) =>
  sha256Hex(JSON.stringify([c.client_id, c.client_secret, c.refresh_token, c.login_customer_id ?? null]));

export async function googleAccessToken(c: GoogleAdsCredentials, ctx: SendContext): Promise<{ token?: string; result?: DeliveryResult }> {
  const key = await tokenCacheKey(c);
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 60_000) return { token: hit.token };
  const r = await execute(
    {
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: {},
      form: { client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token" },
    },
    ctx,
  );
  const j = r.json as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
  if (!r.ok || !j?.access_token) {
    return {
      result: {
        ...r,
        request: { url: GOOGLE_TOKEN_URL, body: { grant_type: "refresh_token", client_id: c.client_id } },
        ok: false,
        retryable: r.retryable,
        error: `OAuth refresh failed: ${j?.error ?? r.error ?? r.http_status}${j?.error_description ? ` (${j.error_description})` : ""}. Re-authorise and PATCH credentials.refresh_token.`,
      },
    };
  }
  if (tokenCache.size >= MAX_CACHED_TOKENS) tokenCache.delete(tokenCache.keys().next().value as string);
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return { token: j.access_token };
}

export const googleAds: Connector<GoogleAdsCredentials> = {
  type: "google_ads",
  label: "Google Ads offline click conversions (Data Manager API or Google Ads API)",
  api: `POST ${DATA_MANAGER_URL} (default) or POST https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/{customer_id}:uploadClickConversions`,
  credentials: googleAdsCredentials,
  publicFields: ["api", "customer_id", "conversion_action_id", "login_customer_id"],
  naturalKey: (c) => `${c.customer_id}:${c.conversion_action_id}`,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode: "validateOnly: true (the request is validated by Google, nothing is imported).",
  example: {
    api: "data_manager",
    customer_id: "1234567890",
    conversion_action_id: "987654321",
    client_id: "1234567890-abc.apps.googleusercontent.com",
    client_secret: "GOCSPX-xxxxxxxxxxxx",
    refresh_token: "1//0gxxxxxxxxxxxxxxxx",
  },
  docs: "https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events",
  skipReason: (e) =>
    !e.click_ids.gclid && !e.click_ids.gbraid && !e.click_ids.wbraid && !e.user.em && !e.user.ph_e164
      ? "no Google click id (gclid/gbraid/wbraid) or hashed email/phone for this visitor"
      : null,
  check(c) {
    if (c.api === "google_ads_api" && !c.developer_token) throw new Error("developer_token is required when api is google_ads_api.");
  },
  async send(e, c, ctx) {
    const validateOnly = ctx.test || !!e.test;
    const { token, result } = await googleAccessToken(c, ctx);
    if (!token) return result!;
    if ((c.api ?? "data_manager") === "data_manager") {
      return execute(
        {
          url: DATA_MANAGER_URL,
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: buildDataManagerBody(e, c, validateOnly),
        },
        ctx,
      );
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "developer-token": c.developer_token ?? "" };
    if (c.login_customer_id) headers["login-customer-id"] = c.login_customer_id;
    const r = await execute(
      {
        url: `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${c.customer_id}:uploadClickConversions`,
        method: "POST",
        headers,
        body: buildUploadClickConversionsBody(e, c, validateOnly),
      },
      ctx,
    );
    const pf = (r.json as { partialFailureError?: { message?: string } } | null)?.partialFailureError;
    if (r.ok && pf) return { ...r, ok: false, retryable: false, error: `Partial failure: ${pf.message ?? "see response"}` };
    return r;
  },
};
