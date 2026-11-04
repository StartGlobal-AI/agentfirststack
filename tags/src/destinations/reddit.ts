import { z } from "zod";
import { sha256 } from "../lib/pii";
import { compact, type Connector, type DispatchEvent, execute, type HttpRequestSpec } from "./types";

/**
 * Reddit Conversions API v3.
 *   POST https://ads-api.reddit.com/api/v3/pixels/{pixel_id}/conversion_events
 *   Authorization: Bearer <conversion access token>   (scope adsconversions)
 *   { data: { test_id?, events: [{ event_at: <unix ms>, action_source: "WEBSITE" | "OTHER", event_source_url,
 *     referrer_url, type: { tracking_type: "PURCHASE" | ... | "CUSTOM", custom_event_name? }, click_id: <rdt_cid>,
 *     metadata: { conversion_id, order_id, currency, value: 49.5, item_count, products: [{ id, name, quantity, item_price }] },
 *     user: { email, phone_number, external_id, ip_address, user_agent, uuid: <_rdt_uuid>, data_processing_options? } }] } }
 *   200 { data: { message: "Successfully processed 1 conversion events." } }; 400 invalid (nothing processed),
 *   401 bad token, 403 not allowed on this pixel, 429 rate limited, 5xx unavailable (retry).
 * (v4 is in preview with the same endpoint and schema; v2.0 is deprecated.)
 *
 * Identifiers: email and phone may be sent pre-hashed (sha256, 64 lowercase hex). Reddit's email
 * canonical form removes dots and "+suffix" from the local part of every address; we send the
 * Google Ads variant (dots/suffix removed for gmail.com) when present, else the lowercased-email
 * hash, so dotted or +suffixed non-Gmail addresses won't match. Phone = sha256 of +E.164.
 * external_id = sha256 of external_id / user_id. ip, user agent, _rdt_uuid and rdt_cid as-is.
 *
 * Dedupe with the Reddit Pixel: the pixel's conversionId (rdt("track", name, { conversionId }))
 * equals metadata.conversion_id here; same event type (and custom name), within 2 days, same
 * action source.
 *
 * Test mode: data.test_id, the id shown in Events Manager > Event Testing (events appear there).
 * Without credentials.test_id there is no test mode: test traffic is skipped (see testModeMissing).
 *
 * Docs: https://ads-api.reddit.com/docs/v3/api/post-conversion-events
 *       https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration
 *       https://ads-api.reddit.com/docs/v3/guides/programs/capi/verify-events
 *       https://ads-api.reddit.com/docs/v3/guides/programs/capi/error-handling
 */
export const REDDIT_API = "https://ads-api.reddit.com/api/v3";
/** Reddit throttles default user agents; send a descriptive one. */
export const REDDIT_USER_AGENT = "afs-tags-conversions/1.0";

export const redditCredentials = z.strictObject({
  pixel_id: z
    .string()
    .regex(/^(a2|t2)_[a-z0-9]{4,20}$/, "Reddit pixel ids look like a2_abc123 or t2_abc123.")
    .describe("Events Manager > Configure data source > Conversions API: Copy the Pixel ID."),
  access_token: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      "Conversion access token: Ads Manager > Events Manager > Conversions API > Generate Access Token (a business admin can create one; it is shown once).",
    ),
  test_id: z
    .string()
    .min(3)
    .max(100)
    .optional()
    .describe(
      "Events Manager > Event Testing: the test ID. Used by the test endpoint and preview traffic (events then show under Event Testing).",
    ),
});
export type RedditCredentials = z.infer<typeof redditCredentials>;

/** Pixel / CAPI v2 names -> CAPI v3 tracking types. */
const TRACKING_TYPES: Record<string, string> = {
  pagevisit: "PAGE_VISIT",
  viewcontent: "VIEW_CONTENT",
  search: "SEARCH",
  addtocart: "ADD_TO_CART",
  addtowishlist: "ADD_TO_WISHLIST",
  purchase: "PURCHASE",
  lead: "LEAD",
  signup: "SIGN_UP",
};

/** send_to.reddit.event_name -> { tracking_type, custom_event_name? }, as the pixel tags it. */
export function redditEventType(name: string): { tracking_type: string; custom_event_name?: string } {
  const std = TRACKING_TYPES[name.replace(/[\s_-]/g, "").toLowerCase()];
  return std ? { tracking_type: std } : { tracking_type: "CUSTOM", custom_event_name: name.slice(0, 64) };
}

export function buildRedditEvent(e: DispatchEvent) {
  const u = e.user;
  const items = e.items ?? [];
  const ext = u.external_id ?? e.user_id;
  const country = (u.country ?? e.geo?.country)?.toUpperCase();
  // Limited Data Use for visitors who declined ad personalization (Reddit needs the country).
  const ldu =
    e.consent.ad_personalization === "denied" && country && /^[A-Z]{2}$/.test(country)
      ? compact({ modes: ["LDU"], country, region: e.geo?.region_code })
      : undefined;
  return compact({
    event_at: e.ts,
    action_source: e.page_url || e.user_agent ? "WEBSITE" : "OTHER",
    event_source_url: e.page_url,
    referrer_url: e.referrer,
    type: redditEventType(e.send_to.reddit?.event_name ?? e.name),
    click_id: e.click_ids.rdt_cid,
    metadata: compact({
      conversion_id: e.event_id,
      order_id: e.transaction_id?.slice(0, 100),
      currency: e.currency?.toUpperCase(),
      value: typeof e.value === "number" && Number.isFinite(e.value) && e.value >= 0 ? e.value : undefined,
      item_count: items.length ? items.reduce((s, i) => s + (Number(i.quantity) || 1), 0) : undefined,
      products: items.length
        ? items
            .filter((i) => i.item_id)
            .map((i) => compact({ id: String(i.item_id), name: i.item_name, quantity: i.quantity, item_price: i.price }))
        : undefined,
    }),
    user: compact({
      email: u.em_gads ?? u.em,
      phone_number: u.ph_e164,
      external_id: ext ? sha256(ext) : undefined,
      ip_address: e.ip,
      user_agent: e.user_agent,
      uuid: e.rdt_uuid,
      data_processing_options: ldu,
    }),
  });
}

export function buildRedditRequest(e: DispatchEvent, c: RedditCredentials, test: boolean): HttpRequestSpec {
  return {
    url: `${REDDIT_API}/pixels/${c.pixel_id}/conversion_events`,
    method: "POST",
    headers: { authorization: `Bearer ${c.access_token}`, "user-agent": REDDIT_USER_AGENT },
    body: { data: compact({ test_id: test ? c.test_id : undefined, events: [buildRedditEvent(e)] }) },
  };
}

type RedditAnswer = {
  data?: { message?: string };
  error?: { code?: number; message?: string; fields?: { field: string; message: string }[] };
} | null;

export const reddit: Connector<RedditCredentials> = {
  type: "reddit",
  label: "Reddit Conversions API v3",
  api: `POST ${REDDIT_API}/pixels/{pixel_id}/conversion_events`,
  credentials: redditCredentials,
  publicFields: ["pixel_id", "test_id"],
  testModeMissing: (c) =>
    c.test_id
      ? null
      : 'Reddit records test traffic only with a test id: PATCH the destination { "credentials": { "test_id": "..." } } (Events Manager > Event Testing).',
  naturalKey: (c) => c.pixel_id,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode:
    "Adds data.test_id, so the event shows in Events Manager > Event Testing. Requires credentials.test_id (or test_event_code in the test request body); without it test traffic (preview hits, test: true server events) is skipped, never sent as a real event.",
  example: { pixel_id: "a2_abc123def456", access_token: "eyJhbGciOiJSUzI1NiIsImtpZCI6xxxxxxxx", test_id: "t2_testid123" },
  docs: "https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration",
  skipReason: (e) =>
    !e.click_ids.rdt_cid && !e.user.em && !e.user.ph_e164 && !e.rdt_uuid && !e.user.external_id && !e.user_id && !e.ip && !e.user_agent
      ? "no identifier Reddit accepts (needs rdt_cid, _rdt_uuid, hashed email/phone, external_id, or IP / user agent)"
      : null,
  async send(e, c, ctx) {
    const test = ctx.test || !!e.test;
    const { json, ...r } = await execute(buildRedditRequest(e, c, test), ctx);
    if (!r.ok && !r.error) {
      const err = (json as RedditAnswer)?.error;
      const fields = err?.fields?.length ? ` (${err.fields.map((f) => `${f.field}: ${f.message}`).join("; ")})` : "";
      return {
        ...r,
        error: `Reddit returned ${r.http_status}${err?.message ? `: ${err.message.slice(0, 300)}` : ""}${fields.slice(0, 500)}.`,
      };
    }
    return r;
  },
};
