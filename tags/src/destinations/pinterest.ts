import { z } from "zod";
import { normCityMeta, normStateMeta, sha256 } from "../lib/pii";
import { compact, type Connector, type DispatchEvent, execute, type HttpRequestSpec, isoSeconds } from "./types";

/**
 * Pinterest Conversions API (API v5).
 *   POST https://api.pinterest.com/v5/ad_accounts/{ad_account_id}/events[?test=true]
 *   Authorization: Bearer <conversion access token from Ads Manager>
 *   { data: [{ event_name, action_source: "web" | "offline", event_time: <unix s>, event_id, event_source_url,
 *              opt_out?, language?, user_data: { em: [sha256], ph: [sha256], fn, ln, ct, st, zp, country,
 *              external_id: [sha256], client_ip_address, client_user_agent, click_id: <_epik> },
 *              custom_data: { currency, value: "49.5", order_id, content_ids, contents, num_items } }] }
 *   200 { num_events_received, num_events_processed, events: [{ status: "processed" | "failed", error_message, warning_message }] }
 *   400/401/403/404, 422 (not all events processed), 429 (5,000 calls/min per ad account), 503.
 *
 * user_data needs em, hashed_maids, or client_ip_address + client_user_agent. Hashes: em = sha256 of
 * the lowercased email; ph = digits with country code (Meta style, our `ph`); ct/st/zp/country are
 * lowercased, stripped and hashed here.
 *
 * Event names: the CAPI names (page_visit, add_to_cart, checkout, lead, signup, custom, ...). Tag
 * names (pagevisit, addtocart, viewcategory, watchvideo) are mapped to them.
 *
 * Dedupe with the Pinterest tag: the tag's event_id (pintrk("track", name, { event_id })) equals
 * event_id here. Offline events can't be deduplicated.
 *
 * Test mode: ?test=true. Pinterest validates and answers as usual but records nothing; test events
 * show in Ads Manager > Conversions > Test events.
 *
 * Docs: https://developers.pinterest.com/docs/api/v5/events-create/
 *       https://developers.pinterest.com/docs/api-features/conversion-overview/
 *       https://github.com/pinterest/api-description (v5/openapi.json, operation events/create)
 */
export const PINTEREST_API = "https://api.pinterest.com/v5";

export const pinterestCredentials = z.strictObject({
  ad_account_id: z
    .string()
    .regex(/^\d{6,20}$/, "Pinterest ad account ids are numeric.")
    .describe("Ads Manager > the account picker (or the number in ads.pinterest.com/advertiser/<id>/)."),
  access_token: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      "Conversion access token: Ads Manager > Conversions > Conversion access token > Generate. Its user must own the ad account or have the Admin, Analyst, Audience or Campaign role.",
    ),
});
export type PinterestCredentials = z.infer<typeof pinterestCredentials>;

export const PINTEREST_EVENTS = new Set([
  "add_payment_info",
  "add_to_cart",
  "add_to_wishlist",
  "app_install",
  "app_open",
  "checkout",
  "contact",
  "custom",
  "customize_product",
  "find_location",
  "initiate_checkout",
  "lead",
  "page_visit",
  "schedule",
  "search",
  "signup",
  "start_trial",
  "submit_application",
  "subscribe",
  "view_category",
  "view_content",
  "watch_video",
]);

/** Pinterest tag event names that differ from the Conversions API names. */
const TAG_ALIASES: Record<string, string> = {
  pagevisit: "page_visit",
  addtocart: "add_to_cart",
  viewcategory: "view_category",
  watchvideo: "watch_video",
  sign_up: "signup",
};

/** Tag-style or CAPI-style name -> the Conversions API name (unknown names pass through). */
export function pinterestEventName(n: string): string {
  const k = n
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return TAG_ALIASES[k] ?? k;
}

const h = (v: string | null | undefined) => (v ? [sha256(v)] : undefined);
const money = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);

export function buildPinterestEvent(e: DispatchEvent) {
  const u = e.user;
  const country = (u.country ?? e.geo?.country)?.toLowerCase();
  const zp = u.zp?.toLowerCase().replace(/[\s-]/g, "");
  const ext = u.external_id ?? e.user_id;
  const lang = e.device?.language?.slice(0, 2).toLowerCase();
  const items = e.items ?? [];
  return compact({
    event_name: pinterestEventName(e.send_to.pinterest?.event_name ?? e.name),
    action_source: e.page_url || e.user_agent ? "web" : "offline",
    event_time: isoSeconds(e.ts),
    event_id: e.event_id,
    event_source_url: e.page_url,
    opt_out: e.consent.ad_personalization === "denied" ? true : undefined,
    language: lang && /^[a-z]{2}$/.test(lang) ? lang : undefined,
    user_data: compact({
      em: u.em ? [u.em] : undefined,
      ph: u.ph ? [u.ph] : undefined,
      fn: u.fn ? [u.fn] : undefined,
      ln: u.ln ? [u.ln] : undefined,
      ct: h(normCityMeta(u.ct)),
      st: h(normStateMeta(u.st)),
      zp: h(zp),
      country: h(country && /^[a-z]{2}$/.test(country) ? country : undefined),
      external_id: h(ext),
      client_ip_address: e.ip,
      client_user_agent: e.user_agent,
      click_id: e.click_ids.epik,
    }),
    custom_data: compact({
      currency: e.currency?.toUpperCase(),
      value: money(e.value),
      order_id: e.transaction_id,
      content_ids: items.length ? items.map((i) => i.item_id).filter((x): x is string => !!x) : undefined,
      contents: items.length
        ? items.map((i) => compact({ id: i.item_id, item_name: i.item_name, item_price: money(i.price), quantity: i.quantity }))
        : undefined,
      num_items: items.length ? items.reduce((s, i) => s + (Number(i.quantity) || 1), 0) : undefined,
    }),
  });
}

export function buildPinterestRequest(e: DispatchEvent, c: PinterestCredentials, test: boolean): HttpRequestSpec {
  return {
    url: `${PINTEREST_API}/ad_accounts/${c.ad_account_id}/events${test ? "?test=true" : ""}`,
    method: "POST",
    headers: { authorization: `Bearer ${c.access_token}` },
    body: { data: [buildPinterestEvent(e)] },
  };
}

type PinterestAnswer = {
  num_events_received?: number;
  num_events_processed?: number;
  events?: { status?: string; error_message?: string | null; warning_message?: string | null }[];
  code?: number;
  message?: string;
} | null;

export const pinterest: Connector<PinterestCredentials> = {
  type: "pinterest",
  label: "Pinterest Conversions API",
  api: `POST ${PINTEREST_API}/ad_accounts/{ad_account_id}/events`,
  credentials: pinterestCredentials,
  publicFields: ["ad_account_id"],
  naturalKey: (c) => c.ad_account_id,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode:
    "Adds ?test=true: Pinterest validates the event and answers as usual but records nothing (see Ads Manager > Conversions > Test events).",
  example: { ad_account_id: "549755885175", access_token: "pina_AEAxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  docs: "https://developers.pinterest.com/docs/api/v5/events-create/",
  skipReason: (e) =>
    !e.user.em && !(e.ip && e.user_agent)
      ? "no identifier Pinterest accepts (needs a hashed email, or the visitor's IP address and user agent together)"
      : null,
  async send(e, c, ctx) {
    const test = ctx.test || !!e.test;
    const { json, ...r } = await execute(buildPinterestRequest(e, c, test), ctx);
    const j = json as PinterestAnswer;
    if (r.ok && j && typeof j.num_events_processed === "number" && j.num_events_processed < (j.num_events_received ?? 1)) {
      const failed = j.events?.find((x) => x.status === "failed");
      return {
        ...r,
        ok: false,
        retryable: false,
        error: `Pinterest did not process the event: ${failed?.error_message ?? "see response"}`,
      };
    }
    if (!r.ok && !r.error) {
      const msg = (j && typeof j === "object" && (j.message ?? j.events?.find((x) => x.error_message)?.error_message)) || undefined;
      return { ...r, error: `Pinterest returned ${r.http_status}${msg ? `: ${String(msg).slice(0, 500)}` : ""}.` };
    }
    return r;
  },
};
