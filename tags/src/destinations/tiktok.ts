import { z } from "zod";
import { sha256 } from "../lib/pii";
import { compact, type Connector, type DispatchEvent, execute, isoSeconds } from "./types";

/**
 * TikTok Events API 2.0 (web).
 *   POST https://business-api.tiktok.com/open_api/v1.3/event/track/   header Access-Token
 *   { event_source: "web", event_source_id: <pixel code>, test_event_code?, data: [{ event, event_time,
 *     event_id, user: { email, phone, external_id, ttclid, ttp, ip, user_agent }, page, properties }] }
 * Dedupe with the pixel: same event + event_id (the pixel sends event_id).
 */
export const tiktokCredentials = z.strictObject({
  pixel_code: z.string().regex(/^[A-Z0-9]{15,25}$/, "Pixel code, ~20 uppercase letters/digits."),
  access_token: z.string().min(20).describe("Events Manager > (pixel) > Settings > Generate access token."),
  test_event_code: z.string().min(3).max(50).optional().describe("Events Manager > (pixel) > Test events."),
});
export type TiktokCredentials = z.infer<typeof tiktokCredentials>;

export const TIKTOK_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

export function buildTiktokBody(e: DispatchEvent, c: TiktokCredentials, test: boolean) {
  const u = e.user;
  return compact({
    event_source: "web",
    event_source_id: c.pixel_code,
    test_event_code: test ? c.test_event_code : undefined,
    data: [
      compact({
        event: e.send_to.tiktok?.event_name ?? e.name,
        event_time: isoSeconds(e.ts),
        event_id: e.event_id,
        user: compact({
          email: u.em,
          phone: u.ph_e164,
          external_id: u.external_id ? sha256(u.external_id) : e.user_id ? sha256(e.user_id) : undefined,
          ttclid: e.click_ids.ttclid,
          ttp: e.ttp,
          ip: e.ip,
          user_agent: e.user_agent,
        }),
        page: e.page_url ? compact({ url: e.page_url, referrer: e.referrer }) : undefined,
        properties: compact({
          value: e.value,
          currency: e.currency,
          order_id: e.transaction_id,
          content_type: e.items?.length ? "product" : undefined,
          contents: e.items?.length
            ? e.items.map((i) => compact({ content_id: i.item_id, content_name: i.item_name, price: i.price, quantity: i.quantity }))
            : undefined,
        }),
      }),
    ],
  });
}

export const tiktok: Connector<TiktokCredentials> = {
  type: "tiktok",
  label: "TikTok Events API 2.0",
  api: `POST ${TIKTOK_URL}`,
  credentials: tiktokCredentials,
  publicFields: ["pixel_code", "test_event_code"],
  naturalKey: (c) => c.pixel_code,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode:
    "Adds test_event_code, so the event shows in Events Manager > Test events. Requires credentials.test_event_code (or test_event_code in the test request body).",
  example: { pixel_code: "C1A2B3C4D5E6F7G8H9I0", access_token: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", test_event_code: "TEST12345" },
  docs: "https://business-api.tiktok.com/portal/docs (Events API 2.0)",
  async send(e, c, ctx) {
    const test = ctx.test || !!e.test;
    const r = await execute(
      { url: TIKTOK_URL, method: "POST", headers: { "Access-Token": c.access_token }, body: buildTiktokBody(e, c, test) },
      ctx,
    );
    const code = (r.json as { code?: number } | null)?.code;
    if (r.ok && typeof code === "number" && code !== 0) {
      return { ...r, ok: false, retryable: code >= 50000 || code === 40100, error: `TikTok returned code ${code}.` };
    }
    return r;
  },
};
