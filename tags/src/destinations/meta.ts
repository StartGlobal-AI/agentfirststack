import { z } from "zod";
import { normCityMeta, normStateMeta, sha256 } from "../lib/pii";
import { compact, type Connector, type DispatchEvent, execute, isoSeconds } from "./types";

/**
 * Meta Conversions API.
 *   POST https://graph.facebook.com/v26.0/{pixel_id}/events?access_token=...
 *   { data: [{ event_name, event_time, event_id, action_source, event_source_url, user_data, custom_data }], test_event_code? }
 * Dedupe with the pixel: same event_name + event_id (the pixel sends eventID). Meta keeps the first.
 */
export const META_GRAPH_VERSION = "v26.0";

export const metaCredentials = z.strictObject({
  pixel_id: z.string().regex(/^\d{8,20}$/, "Pixel (dataset) id, 15-16 digits."),
  access_token: z.string().min(20).describe("Events Manager > (pixel) > Settings > Conversions API > Generate access token."),
  test_event_code: z
    .string()
    .regex(/^TEST\w+$/)
    .optional()
    .describe("Events Manager > Test events. Used by the test endpoint and preview traffic."),
});
export type MetaCredentials = z.infer<typeof metaCredentials>;

const META_STANDARD = new Set([
  "AddPaymentInfo",
  "AddToCart",
  "AddToWishlist",
  "CompleteRegistration",
  "Contact",
  "CustomizeProduct",
  "Donate",
  "FindLocation",
  "InitiateCheckout",
  "Lead",
  "Purchase",
  "Schedule",
  "Search",
  "StartTrial",
  "SubmitApplication",
  "Subscribe",
  "ViewContent",
  "PageView",
]);
export const isMetaStandardEvent = (n: string) => META_STANDARD.has(n);

const h = (v: string | undefined) => (v ? [v] : undefined);

export function buildMetaEvent(e: DispatchEvent) {
  const u = e.user;
  const country = u.country ?? e.geo?.country?.toLowerCase();
  const ct = normCityMeta(u.ct);
  const st = normStateMeta(u.st);
  const zp = u.zp?.replace(/[\s-]/g, "");
  const custom = compact({
    value: e.value,
    currency: e.currency,
    order_id: e.transaction_id,
    contents: e.items?.length ? e.items.map((i) => compact({ id: i.item_id, quantity: i.quantity, item_price: i.price })) : undefined,
    content_ids: e.items?.length ? e.items.map((i) => i.item_id).filter(Boolean) : undefined,
    content_type: e.items?.length ? "product" : undefined,
    num_items: e.items?.length ? e.items.reduce((s, i) => s + (Number(i.quantity) || 1), 0) : undefined,
    ...(e.send_to.meta?.custom_data ?? {}),
  });
  const actionSource = e.action_source ?? (e.user_agent && e.page_url ? "website" : "system_generated");
  return compact({
    event_name: e.send_to.meta?.event_name ?? e.name,
    event_time: isoSeconds(e.ts),
    event_id: e.event_id,
    action_source: actionSource,
    event_source_url: e.page_url,
    user_data: compact({
      em: h(u.em),
      ph: h(u.ph),
      fn: h(u.fn),
      ln: h(u.ln),
      ct: ct ? [sha256(ct)] : undefined,
      st: st ? [sha256(st)] : undefined,
      zp: zp ? [sha256(zp)] : undefined,
      country: country ? [sha256(country)] : undefined,
      external_id: u.external_id ? [sha256(u.external_id)] : e.user_id ? [sha256(e.user_id)] : undefined,
      client_ip_address: e.ip,
      client_user_agent: e.user_agent,
      fbc: e.fbc,
      fbp: e.fbp,
    }),
    custom_data: Object.keys(custom).length ? custom : undefined,
  });
}

export function buildMetaRequest(e: DispatchEvent, c: MetaCredentials, test: boolean) {
  const body: Record<string, unknown> = { data: [buildMetaEvent(e)] };
  if (test && c.test_event_code) body.test_event_code = c.test_event_code;
  return {
    url: `https://graph.facebook.com/${META_GRAPH_VERSION}/${c.pixel_id}/events?access_token=${encodeURIComponent(c.access_token)}`,
    method: "POST" as const,
    headers: {},
    body,
  };
}

export const meta: Connector<MetaCredentials> = {
  type: "meta",
  label: "Meta Conversions API",
  api: `POST https://graph.facebook.com/${META_GRAPH_VERSION}/{pixel_id}/events`,
  credentials: metaCredentials,
  publicFields: ["pixel_id", "test_event_code"],
  testModeMissing: (c) =>
    c.test_event_code
      ? null
      : 'Meta records test traffic only with a test_event_code: PATCH the destination { "credentials": { "test_event_code": "TEST..." } } (Events Manager > (pixel) > Test events).',
  naturalKey: (c) => c.pixel_id,
  requiredConsent: ["ad_user_data"],
  needsMapping: true,
  testMode:
    "Adds test_event_code, so the event shows in Events Manager > Test events. Requires credentials.test_event_code (or test_event_code in the test request body); without it test traffic (preview hits, test: true server events) is skipped, never sent as a real event.",
  example: { pixel_id: "1234567890123456", access_token: "EAABsbCS1iHgBAxxxxxxxxxxxxxxxx", test_event_code: "TEST12345" },
  docs: "https://developers.facebook.com/docs/marketing-api/conversions-api",
  skipReason: (e) =>
    !e.user_agent && !e.user.em && !e.user.ph && !e.fbc && !e.fbp && !e.user.external_id && !e.user_id
      ? "no customer information to match on (needs em, ph, fbc/fbp, external_id or ip+user agent)"
      : null,
  async send(e, c, ctx) {
    const test = ctx.test || !!e.test;
    const r = await execute(buildMetaRequest(e, c, test), ctx, ["access_token"]);
    const err = (r.json as { error?: { code?: number; is_transient?: boolean } } | null)?.error;
    if (err && (err.is_transient || [1, 2, 4, 17, 341].includes(Number(err.code)))) return { ...r, ok: false, retryable: true };
    if (!r.ok) return { ...r, retryable: r.retryable };
    return r;
  },
};
