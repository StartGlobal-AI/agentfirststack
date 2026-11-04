import { sha256Hex } from "@afs/shared";
import { z } from "zod";
import { sha256 } from "../lib/pii";
import { type Connector, type DeliveryResult, type DispatchEvent, execute, type HttpRequestSpec, type SendContext } from "./types";

/**
 * LinkedIn Conversions API (versioned Marketing API).
 *   POST https://api.linkedin.com/rest/conversionEvents
 *   Authorization: Bearer <member access token, scopes rw_conversions + r_ads>
 *   LinkedIn-Version: 202610    X-Restli-Protocol-Version: 2.0.0
 *   { conversion: "urn:lla:llaPartnerConversion:<rule id>", conversionHappenedAt: <unix ms, last 90 days>,
 *     conversionValue?: { currencyCode: "USD", amount: "49.5" }, eventId,
 *     user: { userIds: [{ idType: SHA256_EMAIL | LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID | PLAINTEXT_IP_ADDRESS, idValue }],
 *             userInfo?: { hashedFirstName, hashedLastName, countryCode }, externalIds?: [<one id>] } }
 *   201 Created (no body) on success; 400/422 validation, 401/403 token or ad account role, 429 throttled.
 *
 * Identifiers: SHA256_EMAIL = sha256(lowercased, trimmed email) (our `em`); li_fat_id (first-party
 * click id); the IP in plain text (IPv4 only, LinkedIn hashes it); hashed first + last name (from
 * 202609) with countryCode; one external id (sha256 of external_id / user_id).
 *
 * Dedupe with the Insight Tag: the tag sends lintrk("track", { conversion_id, event_id }) and this
 * sends the same value as eventId. LinkedIn requires a separate conversion rule per data source
 * (an Insight Tag rule and a rule with conversionMethod CONVERSIONS_API), so credentials can map
 * each Insight Tag conversion id to its Conversions API rule (conversion_rules); unmapped ids are
 * sent as they are (CAPI-only setups use the CAPI rule id in send_to.linkedin.conversion_id).
 *
 * No test mode exists: a test sends one real conversion event.
 *
 * Tokens: member access tokens live 60 days. Apps approved for LinkedIn's Marketing Developer
 * Platform also get a programmatic refresh token (365 days, fixed); with refresh_token + client_id +
 * client_secret the access token is minted at https://www.linkedin.com/oauth/v2/accessToken and
 * cached per isolate under a hash of those three values.
 *
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api
 *       https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api-schema
 *       https://learn.microsoft.com/en-us/linkedin/marketing/conversions/deduplication
 *       https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
 */
export const LINKEDIN_VERSION = "202610";
export const LINKEDIN_URL = "https://api.linkedin.com/rest/conversionEvents";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

const ruleId = z.string().regex(/^\d{3,15}$/, "Conversion rule ids are numeric.");

export const linkedinCredentials = z.strictObject({
  ad_account_id: z
    .string()
    .regex(/^\d{3,15}$/, "Ad account id: digits only.")
    .describe(
      "Campaign Manager ad account id (the number in /campaignmanager/accounts/<id>/). Identifies this destination; the conversion rules you send to must belong to this account.",
    ),
  access_token: z
    .string()
    .min(20)
    .max(4000)
    .optional()
    .describe(
      "Member access token (3-legged OAuth, scopes rw_conversions and r_ads) of a user with a non-viewer role on the ad account. Expires after 60 days; add refresh_token + client_id + client_secret to refresh it automatically.",
    ),
  refresh_token: z
    .string()
    .min(20)
    .max(4000)
    .optional()
    .describe(
      "Programmatic refresh token (valid 365 days; only apps approved for the Marketing Developer Platform get one). With client_id and client_secret, access tokens are refreshed automatically.",
    ),
  client_id: z
    .string()
    .min(6)
    .max(100)
    .optional()
    .describe("LinkedIn app Client ID (developer portal > your app > Auth). Needed with refresh_token."),
  client_secret: z.string().min(8).max(200).optional().describe("LinkedIn app Client Secret. Needed with refresh_token."),
  conversion_rules: z
    .record(ruleId, ruleId)
    .refine((m) => Object.keys(m).length <= 50, "At most 50 mappings.")
    .optional()
    .describe(
      'Insight Tag conversion id (send_to.linkedin.conversion_id) -> Conversions API conversion rule id, e.g. { "1234567": "7654321" }. LinkedIn needs one rule per data source to dedupe tag and server events; create the CAPI rule with conversionMethod CONVERSIONS_API (Campaign Manager > Measurement > Conversion tracking). Ids not listed are sent unchanged.',
    ),
});
export type LinkedinCredentials = z.infer<typeof linkedinCredentials>;

const hasRefresh = (c: LinkedinCredentials) => !!(c.refresh_token && c.client_id && c.client_secret);
const isIpv4 = (ip: string | undefined): ip is string => !!ip && /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip);
const externalId = (e: DispatchEvent) => (e.user.external_id ? sha256(e.user.external_id) : e.user_id ? sha256(e.user_id) : undefined);

/** The Conversions API rule an event goes to (mapped from the Insight Tag id when configured). */
export function linkedinRuleId(e: DispatchEvent, c: LinkedinCredentials): string | undefined {
  const id = e.send_to.linkedin?.conversion_id;
  return id ? (c.conversion_rules?.[id] ?? id) : undefined;
}

export function buildLinkedinBody(e: DispatchEvent, c: LinkedinCredentials) {
  const u = e.user;
  const userIds: { idType: string; idValue: string }[] = [];
  if (u.em) userIds.push({ idType: "SHA256_EMAIL", idValue: u.em });
  if (e.click_ids.li_fat_id) userIds.push({ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: e.click_ids.li_fat_id });
  if (isIpv4(e.ip)) userIds.push({ idType: "PLAINTEXT_IP_ADDRESS", idValue: e.ip });
  const country = (u.country ?? e.geo?.country)?.toUpperCase();
  const user: Record<string, unknown> = { userIds }; // userIds is required, even when empty.
  if (u.fn && u.ln) {
    user.userInfo = {
      hashedFirstName: u.fn,
      hashedLastName: u.ln,
      ...(country && /^[A-Z]{2}$/.test(country) ? { countryCode: country } : {}),
    };
  }
  const ext = externalId(e);
  if (ext) user.externalIds = [ext];
  const body: Record<string, unknown> = {
    conversion: `urn:lla:llaPartnerConversion:${linkedinRuleId(e, c)}`,
    conversionHappenedAt: e.ts,
  };
  if (typeof e.value === "number" && Number.isFinite(e.value) && e.currency) {
    body.conversionValue = { currencyCode: e.currency.toUpperCase(), amount: String(e.value) };
  }
  body.user = user;
  body.eventId = e.event_id;
  return body;
}

/** The request for one event. LinkedIn has no test mode, so there is no test flag. */
export function buildLinkedinRequest(e: DispatchEvent, c: LinkedinCredentials, accessToken: string): HttpRequestSpec {
  return {
    url: LINKEDIN_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "linkedin-version": LINKEDIN_VERSION,
      "x-restli-protocol-version": "2.0.0",
    },
    body: buildLinkedinBody(e, c),
  };
}

// Access tokens minted from a refresh token are cached per isolate (they live 60 days). An isolate
// serves every account, so the key is a hash of the whole refresh tuple.
const tokenCache = new Map<string, { token: string; exp: number }>();
const MAX_CACHED_TOKENS = 1000;

export const linkedinTokenCacheKey = (c: LinkedinCredentials) =>
  sha256Hex(JSON.stringify([c.client_id ?? null, c.client_secret ?? null, c.refresh_token ?? null]));

export async function linkedinAccessToken(
  c: LinkedinCredentials,
  ctx: SendContext,
  opts: { force?: boolean } = {},
): Promise<{ token?: string; cached?: boolean; result?: DeliveryResult }> {
  if (!hasRefresh(c)) {
    if (c.access_token) return { token: c.access_token };
    return {
      result: {
        ok: false,
        retryable: false,
        error: "No LinkedIn credentials: PATCH credentials.access_token (or refresh_token + client_id + client_secret).",
      },
    };
  }
  const key = await linkedinTokenCacheKey(c);
  const hit = tokenCache.get(key);
  if (!opts.force && hit && hit.exp > Date.now() + 60_000) return { token: hit.token, cached: true };
  const r = await execute(
    {
      url: LINKEDIN_TOKEN_URL,
      method: "POST",
      headers: {},
      form: { grant_type: "refresh_token", refresh_token: c.refresh_token!, client_id: c.client_id!, client_secret: c.client_secret! },
    },
    ctx,
  );
  const j = r.json as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
  if (!r.ok || !j?.access_token) {
    return {
      result: {
        ...r,
        request: { url: LINKEDIN_TOKEN_URL, body: { grant_type: "refresh_token", client_id: c.client_id } },
        ok: false,
        retryable: r.retryable,
        error: `LinkedIn token refresh failed: ${j?.error ?? r.error ?? r.http_status}${j?.error_description ? ` (${j.error_description})` : ""}. Re-authorise the member and PATCH credentials.refresh_token.`,
      },
    };
  }
  if (tokenCache.size >= MAX_CACHED_TOKENS) tokenCache.delete(tokenCache.keys().next().value as string);
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 86_400) * 1000 });
  return { token: j.access_token };
}

function errorText(json: unknown): string | undefined {
  const j = json as { message?: string; code?: string; serviceErrorCode?: number } | null;
  return j && typeof j === "object" && typeof j.message === "string" ? j.message.slice(0, 500) : undefined;
}

export const linkedin: Connector<LinkedinCredentials> = {
  type: "linkedin",
  label: "LinkedIn Conversions API",
  api: `POST ${LINKEDIN_URL} (LinkedIn-Version ${LINKEDIN_VERSION})`,
  credentials: linkedinCredentials,
  publicFields: ["ad_account_id", "client_id", "conversion_rules"],
  naturalKey: (c) => c.ad_account_id,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode:
    "LinkedIn has no test mode: the test sends one real conversion event to the (mapped) conversion rule, so it counts in Campaign Manager.",
  example: {
    ad_account_id: "512345678",
    access_token: "AQXNnd2kXITHELmWblJigbHEuoFdfRhOwGA0QNnumBI8XOVSs0HtOHEU",
    conversion_rules: { "1234567": "7654321" },
  },
  docs: "https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api",
  skipReason: (e) =>
    !e.user.em && !e.click_ids.li_fat_id && !isIpv4(e.ip) && !(e.user.fn && e.user.ln) && !e.user.external_id && !e.user_id
      ? "no identifier LinkedIn accepts (needs hashed email, li_fat_id, an IPv4 address, first + last name or external_id)"
      : null,
  check(c) {
    const some = !!(c.refresh_token || c.client_id || c.client_secret);
    if (some && !hasRefresh(c)) throw new Error("refresh_token, client_id and client_secret go together: send all three (or none).");
    if (!c.access_token && !hasRefresh(c)) throw new Error("Send access_token, or refresh_token + client_id + client_secret.");
  },
  async send(e, c, ctx) {
    if (!linkedinRuleId(e, c)) return { ok: false, retryable: false, error: "No send_to.linkedin.conversion_id on this event." };
    const t = await linkedinAccessToken(c, ctx);
    if (!t.token) return t.result!;
    let r = await execute(buildLinkedinRequest(e, c, t.token), ctx);
    if (r.http_status === 401 && t.cached) {
      // The cached token was revoked or expired early: mint a new one and try once more.
      const fresh = await linkedinAccessToken(c, ctx, { force: true });
      if (!fresh.token) return fresh.result!;
      r = await execute(buildLinkedinRequest(e, c, fresh.token), ctx);
    }
    const { json: _json, ...result } = r;
    if (!r.ok && !r.error) {
      const msg = errorText(r.json);
      const hint =
        r.http_status === 401
          ? " Refresh the access token (they expire after 60 days) and PATCH credentials."
          : r.http_status === 403
            ? " The token's member needs a non-viewer role on the ad account and the rw_conversions scope."
            : "";
      return { ...result, error: `LinkedIn returned ${r.http_status}${msg ? `: ${msg}` : ""}.${hint}` };
    }
    return result;
  },
};
