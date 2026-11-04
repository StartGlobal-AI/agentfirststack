import { z } from "zod";
import { normCityMeta, normStateMeta, sha256 } from "../lib/pii";
import { compact, type Connector, type DispatchEvent, execute, type HttpRequestSpec } from "./types";

/**
 * Snap Conversions API v3 (web events on a Pixel).
 *   POST https://tr.snapchat.com/v3/{pixel_id}/events?access_token=<long-lived CAPI token>
 *   test: POST https://tr.snapchat.com/v3/{pixel_id}/events/validate?access_token=...
 *   { data: [{ event_name: "PURCHASE" | "SIGN_UP" | ..., event_time: <unix ms>, event_id, action_source: "WEB" | "OFFLINE",
 *              event_source_url, user_data: { em: [sha256], ph: [sha256], fn, ln, ct, st, zp, country, external_id,
 *              client_ip_address, client_user_agent, sc_click_id: <ScCid>, sc_cookie1: <_scid> },
 *              custom_data: { currency, value, order_id, content_ids, contents, num_items } }] }
 *   200 { status: "VALID", reason: "Events have been processed successfully." }
 *   400 { status: "INVALID", reason, event_logs: [{ status, errors: { codes, error_msgs } }] }
 *
 * Matching needs em, ph or client_ip_address + client_user_agent. Hashes: em = trimmed, lowercased;
 * ph = digits with country code, no leading zeros (Meta style, our `ph`); ct, st, zp, country
 * lowercased, stripped and hashed here; external_id hashed (recommended). Not hashed: ip, user
 * agent, sc_click_id, sc_cookie1. event_time can't be more than 7 days old. PURCHASE needs value
 * and currency.
 *
 * Dedupe with the Snap Pixel: the pixel's client_dedup_id equals event_id here (48 h window,
 * same event_name and Pixel). For PURCHASE the pixel's transaction_id also matches
 * custom_data.order_id (30-day fallback).
 *
 * Test mode: the /events/validate endpoint, which checks the event without sending production
 * events (test events show under Events Manager > Test Events and /events/validate/logs).
 *
 * Docs: https://developers.snap.com/api/marketing-api/Conversions-API/UsingTheAPI
 *       https://developers.snap.com/api/marketing-api/Conversions-API/Parameters
 *       https://developers.snap.com/api/marketing-api/Conversions-API/VerifySetUp
 *       https://developers.snap.com/api/marketing-api/Conversions-API/Deduplication
 *       https://developers.snap.com/api/marketing-api/Conversions-API/GetStarted
 */
export const SNAP_API = "https://tr.snapchat.com/v3";

export const snapCredentials = z.strictObject({
  pixel_id: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "Snap Pixel ids are UUIDs (Ads Manager > Events Manager > the Pixel).",
    )
    .describe("Ads Manager > Events Manager > your Pixel: the Pixel ID (a UUID)."),
  access_token: z
    .string()
    .min(20)
    .max(4000)
    .describe(
      "Long-lived Conversions API token: Ads Manager > Business Details > Conversions API Tokens > Generate Token (Organization Admins only; it doesn't expire). It must belong to the Pixel's organization.",
    ),
});
export type SnapCredentials = z.infer<typeof snapCredentials>;

export const SNAP_EVENTS = new Set([
  "PURCHASE",
  "SAVE",
  "START_CHECKOUT",
  "ADD_CART",
  "VIEW_CONTENT",
  "ADD_BILLING",
  "SIGN_UP",
  "SEARCH",
  "PAGE_VIEW",
  "SUBSCRIBE",
  "AD_CLICK",
  "AD_VIEW",
  "COMPLETE_TUTORIAL",
  "LEVEL_COMPLETE",
  "INVITE",
  "LOGIN",
  "SHARE",
  "RESERVE",
  "ACHIEVEMENT_UNLOCKED",
  "ADD_TO_WISHLIST",
  "SPENT_CREDITS",
  "RATE",
  "START_TRIAL",
  "LIST_VIEW",
  "APP_INSTALL",
  "APP_OPEN",
  "CUSTOM_EVENT_1",
  "CUSTOM_EVENT_2",
  "CUSTOM_EVENT_3",
  "CUSTOM_EVENT_4",
  "CUSTOM_EVENT_5",
]);

/** Standard names are uppercase (as snaptr("track", ...) takes them); others pass through. */
export function snapEventName(n: string): string {
  const up = n
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  return SNAP_EVENTS.has(up) ? up : n;
}

const h = (v: string | null | undefined) => (v ? [sha256(v)] : undefined);

export function buildSnapEvent(e: DispatchEvent) {
  const u = e.user;
  const items = e.items ?? [];
  const country = (u.country ?? e.geo?.country)?.toLowerCase();
  const zp = u.zp?.toLowerCase().replace(/[\s-]/g, "");
  const ext = u.external_id ?? e.user_id;
  return compact({
    event_name: snapEventName(e.send_to.snap?.event_name ?? e.name),
    event_time: e.ts,
    event_id: e.event_id,
    // WEB events require event_source_url; backend events without a page are OFFLINE.
    action_source: e.page_url ? "WEB" : "OFFLINE",
    event_source_url: e.page_url,
    user_data: compact({
      em: u.em ? [u.em] : undefined,
      ph: u.ph ? [u.ph] : undefined,
      fn: u.fn ? [u.fn] : undefined,
      ln: u.ln ? [u.ln] : undefined,
      ct: h(normCityMeta(u.ct)),
      st: h(normStateMeta(u.st)),
      zp: h(zp),
      country: h(country && /^[a-z]{2}$/.test(country) ? country : undefined),
      external_id: ext ? sha256(ext) : undefined,
      client_ip_address: e.ip,
      client_user_agent: e.user_agent,
      sc_click_id: e.click_ids.ScCid,
      sc_cookie1: e.scid,
    }),
    custom_data: compact({
      currency: e.currency?.toUpperCase(),
      value: typeof e.value === "number" && Number.isFinite(e.value) ? e.value : undefined,
      order_id: e.transaction_id,
      content_ids: items.length ? items.map((i) => i.item_id).filter((x): x is string => !!x) : undefined,
      contents: items.length ? items.map((i) => compact({ id: i.item_id, quantity: i.quantity, item_price: i.price })) : undefined,
      num_items: items.length ? String(items.reduce((s, i) => s + (Number(i.quantity) || 1), 0)) : undefined,
    }),
  });
}

export function buildSnapRequest(e: DispatchEvent, c: SnapCredentials, test: boolean): HttpRequestSpec {
  return {
    url: `${SNAP_API}/${c.pixel_id}/events${test ? "/validate" : ""}?access_token=${encodeURIComponent(c.access_token)}`,
    method: "POST",
    headers: {},
    body: { data: [buildSnapEvent(e)] },
  };
}

type SnapAnswer = {
  status?: string;
  reason?: string;
  event_logs?: { status?: string; errors?: { codes?: string[]; error_msgs?: string[] } }[];
} | null;

function snapError(j: SnapAnswer): string | undefined {
  if (!j || typeof j !== "object") return undefined;
  const msgs = (j.event_logs ?? []).flatMap((l) => l.errors?.error_msgs ?? []);
  const text = [j.reason, ...msgs].filter(Boolean).join(" ");
  return text ? text.slice(0, 500) : undefined;
}

export const snap: Connector<SnapCredentials> = {
  type: "snap",
  label: "Snap Conversions API v3",
  api: `POST ${SNAP_API}/{pixel_id}/events`,
  credentials: snapCredentials,
  publicFields: ["pixel_id"],
  naturalKey: (c) => c.pixel_id,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode:
    "Sends to /v3/{pixel_id}/events/validate: Snap validates the event without recording a production event (it shows under Events Manager > Test Events).",
  example: { pixel_id: "1ec32188-754e-4be2-8e55-c949a984a39f", access_token: "eyJhbGciOiJIUzI1NiIsImtpZCI6Ixxxxxxxx" },
  docs: "https://developers.snap.com/api/marketing-api/Conversions-API/UsingTheAPI",
  skipReason: (e) =>
    !e.user.em && !e.user.ph && !(e.ip && e.user_agent)
      ? "no identifier Snap accepts (needs a hashed email or phone, or the visitor's IP address and user agent together)"
      : null,
  async send(e, c, ctx) {
    const test = ctx.test || !!e.test;
    const { json, ...r } = await execute(buildSnapRequest(e, c, test), ctx, ["access_token"]);
    const j = json as SnapAnswer;
    const status = j && typeof j === "object" ? j.status : undefined;
    if (r.ok && status && status !== "VALID" && status !== "SUCCESS") {
      return { ...r, ok: false, retryable: false, error: `Snap answered ${status}${snapError(j) ? `: ${snapError(j)}` : ""}` };
    }
    if (!r.ok && !r.error) {
      const msg = snapError(j);
      return { ...r, error: `Snap returned ${r.http_status}${msg ? `: ${msg}` : ""}.` };
    }
    return r;
  },
};
