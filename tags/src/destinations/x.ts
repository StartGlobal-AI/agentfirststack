import { z } from "zod";
import { oauth1Header } from "../lib/oauth1";
import { compact, type Connector, type DispatchEvent, execute, type HttpRequestSpec } from "./types";

/**
 * X (Twitter) Ads API Conversion API for web events.
 *   POST https://ads-api.x.com/12/measurement/conversions/{pixel_id}
 *   Authorization: OAuth 1.0a user context (HMAC-SHA1), app with Ads API access, user with
 *   AD_MANAGER or ACCOUNT_ADMIN on the ad account. The JSON body is not part of the signature.
 *   { conversions: [{ conversion_time: "2026-11-03T12:30:45.123Z", event_id: "tw-<pixel>-<event>",
 *     identifiers: [{ twclid }, { hashed_email }, { hashed_phone_number }, { ip_address, user_agent }],
 *     conversion_id, event_source_url, value, price_currency, number_items,
 *     contents: [{ content_id, content_name, content_price, num_items }] }] }
 *   200 { data: { conversions_processed: 1, debug_id }, request: { params } }; errors { errors: [{ code, message }] }.
 *   Rate limit: 60,000 events per ad account per 15 minutes.
 *
 * Identifiers: twclid (click id), hashed_email = sha256 of the trimmed, lowercased email,
 * hashed_phone_number = sha256 of +E.164. IP address and user agent only count next to another
 * identifier, so events without twclid, email or phone are skipped.
 *
 * Dedupe with the X Pixel: same Events Manager event (event_id) and the same per-occurrence
 * conversion_id on both sides (twq("event", "tw-<pixel>-<event>", { conversion_id })).
 *
 * No test mode exists, so test traffic is never sent (noTestMode: skipped in dispatch, 400 in tests).
 *
 * (X's own GTM server template can authenticate with an Events Manager token in an X-Pixel-Token
 * header; X documents that for the template only and requires OAuth for custom integrations.)
 *
 * Docs: https://docs.x.com/x-ads-api/measurement/web-conversions
 *       https://docs.x.com/x-ads-api/fundamentals/versioning
 *       https://docs.x.com/fundamentals/authentication/oauth-1-0a/authorizing-a-request
 */
export const X_ADS_API = "https://ads-api.x.com/12";

export const xCredentials = z.strictObject({
  pixel_id: z
    .string()
    .regex(/^[a-z0-9]{4,10}$/, "X pixel ids are short lowercase codes like o1abc.")
    .describe("Ads Manager > Tools > Events Manager > your X Pixel event source: its id (the <pixel> in event ids tw-<pixel>-<event>)."),
  consumer_key: z
    .string()
    .min(10)
    .max(100)
    .describe(
      "API Key (consumer key) of a developer app approved for the Ads API: Developer Console > Projects & Apps > the app > Keys and tokens.",
    ),
  consumer_secret: z.string().min(20).max(200).describe("API Key Secret (consumer secret) of the same app."),
  access_token: z
    .string()
    .min(20)
    .max(200)
    .describe(
      "OAuth 1.0a user access token of a handle with AD_MANAGER or ACCOUNT_ADMIN on the ad account (Developer Console > Keys and tokens for the app owner, or a 3-legged OAuth flow).",
    ),
  access_token_secret: z.string().min(20).max(200).describe("The access token's secret."),
});
export type XCredentials = z.infer<typeof xCredentials>;

const EVENT_ID = /^tw-([a-z0-9]+)-([a-z0-9]+)$/;

/** Why this event can't go to this pixel (its event id belongs to another pixel), or null. */
export function xEventProblem(e: DispatchEvent, c: XCredentials): string | null {
  const id = e.send_to.x?.event_id;
  if (!id) return "No send_to.x.event_id on this event.";
  const m = EVENT_ID.exec(id);
  if (m && m[1] !== c.pixel_id) return `send_to.x.event_id ${id} belongs to pixel ${m[1]}, not this destination's pixel ${c.pixel_id}.`;
  return null;
}

export function buildXBody(e: DispatchEvent) {
  const u = e.user;
  const items = e.items ?? [];
  const identifiers: Record<string, string>[] = [];
  if (e.click_ids.twclid) identifiers.push({ twclid: e.click_ids.twclid });
  if (u.em) identifiers.push({ hashed_email: u.em });
  if (u.ph_e164) identifiers.push({ hashed_phone_number: u.ph_e164 });
  // IP and user agent go together in one identifier (X's example); each only counts next to another.
  const device: Record<string, string> = {};
  if (e.ip) device.ip_address = e.ip;
  if (e.user_agent) device.user_agent = e.user_agent;
  if (Object.keys(device).length) identifiers.push(device);
  const contents = items.map((i) =>
    compact({
      content_id: i.item_id === undefined ? undefined : String(i.item_id),
      content_name: i.item_name,
      content_price: i.price,
      num_items: i.quantity,
    }),
  );
  return {
    conversions: [
      compact({
        conversion_time: new Date(e.ts).toISOString(),
        event_id: e.send_to.x?.event_id,
        identifiers,
        conversion_id: e.event_id,
        event_source_url: e.page_url,
        value: typeof e.value === "number" && Number.isFinite(e.value) ? e.value : undefined,
        price_currency: e.currency?.toUpperCase(),
        number_items: items.length ? items.reduce((s, i) => s + (Number(i.quantity) || 1), 0) : undefined,
        contents: contents.some((x) => Object.keys(x).length) ? contents : undefined,
      }),
    ],
  };
}

/** URL, method and body (the OAuth header is added by `send`, it needs a fresh nonce). X has no test mode. */
export function buildXRequest(e: DispatchEvent, c: XCredentials): HttpRequestSpec {
  return { url: `${X_ADS_API}/measurement/conversions/${c.pixel_id}`, method: "POST", headers: {}, body: buildXBody(e) };
}

type XAnswer = { data?: { conversions_processed?: number }; errors?: { code?: string; message?: string; parameter?: string }[] } | null;

export const x: Connector<XCredentials> = {
  type: "x",
  label: "X Ads Conversion API (web)",
  api: `POST ${X_ADS_API}/measurement/conversions/{pixel_id} (OAuth 1.0a)`,
  credentials: xCredentials,
  publicFields: ["pixel_id"],
  naturalKey: (c) => c.pixel_id,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode:
    "X has no test mode, so test traffic (preview hits, test: true server events, destination tests) is never sent to it: deliveries are skipped and the destination test answers 400 no_test_mode. Live conversions are delivered as usual; GET /events shows X's answer to the first ones.",
  noTestMode: true,
  testModeMissing: () =>
    "X's Conversion API has no test mode, so test and preview events are never sent to it (live conversions are). Check the first live deliveries in GET /v1/containers/:id/events.",
  example: {
    pixel_id: "o1abc",
    consumer_key: "xvz1evFS4wEEPTGEFPHBog",
    consumer_secret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    access_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    access_token_secret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  },
  docs: "https://docs.x.com/x-ads-api/measurement/web-conversions",
  skipReason: (e) =>
    !e.click_ids.twclid && !e.user.em && !e.user.ph_e164
      ? "no identifier X accepts (needs twclid or a hashed email/phone; IP and user agent alone aren't enough)"
      : null,
  async send(e, c, ctx) {
    const problem = xEventProblem(e, c);
    const spec = buildXRequest(e, c);
    if (problem) return { ok: false, retryable: false, error: problem, request: { url: spec.url, body: spec.body } };
    const authorization = await oauth1Header({
      method: spec.method,
      url: spec.url,
      credentials: {
        consumerKey: c.consumer_key,
        consumerSecret: c.consumer_secret,
        token: c.access_token,
        tokenSecret: c.access_token_secret,
      },
    });
    const { json, ...r } = await execute({ ...spec, headers: { authorization } }, ctx);
    const j = json as XAnswer;
    const errors = j && typeof j === "object" && Array.isArray(j.errors) ? j.errors : [];
    const msg = errors.length
      ? errors
          .map((x) => [x.code, x.message].filter(Boolean).join(": "))
          .join("; ")
          .slice(0, 500)
      : undefined;
    if (r.ok && j && typeof j === "object" && j.data?.conversions_processed === 0) {
      return { ...r, ok: false, retryable: false, error: `X processed 0 conversions${msg ? `: ${msg}` : ""}.` };
    }
    if (!r.ok && !r.error) {
      const hint = r.http_status === 401 ? " Check the four OAuth values and that the app has Ads API access." : "";
      return { ...r, error: `X returned ${r.http_status}${msg ? `: ${msg}` : ""}.${hint}` };
    }
    return r;
  },
};
