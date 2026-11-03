import { z } from "zod";
import { CONDITION_OPS } from "../lib/conditions";
import { CONSENT_TYPES } from "../lib/consent";

/**
 * The container config (a draft or a published version). Validated by zod; `GET /v1/schema`
 * serves `z.toJSONSchema(containerConfigSchema)` plus the catalog in ./catalog.ts.
 *
 * Objects are strict: an unknown key is an error, so typos ("trigger" vs "triggers") surface
 * immediately instead of silently doing nothing.
 */

const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/, "Use letters, digits, _ . - (start with a letter or _), max 64 chars.");
const selector = z.string().min(1).max(500).describe("CSS selector");
const scalar = z.union([z.string().max(2000), z.number(), z.boolean()]);

// ---------------------------------------------------------------- variables

export const BUILTIN_VARIABLES = {
  page_url: "Full URL of the current page.",
  page_path: "Path of the current page, e.g. /thank-you.",
  page_hostname: "Hostname of the current page.",
  page_title: "document.title.",
  referrer: "document.referrer.",
  event: "Name of the event being processed (dataLayer event, or page_view, click, form_submit...).",
  click_text: "Text of the clicked element (click triggers).",
  click_url: "href of the clicked link (click triggers).",
  click_id: "id attribute of the clicked element.",
  click_classes: "class attribute of the clicked element.",
  form_id: "id attribute of the submitted form (form_submit triggers).",
  form_action: "action attribute of the submitted form.",
  form_classes: "class attribute of the submitted form.",
  scroll_depth: "Scroll depth percentage that fired (scroll_depth triggers).",
} as const;
export type BuiltinVariable = keyof typeof BUILTIN_VARIABLES;

const varBase = {
  name: ident.describe("Name used to reference this variable from conditions, conversions and {{templates}}."),
  default: scalar.optional().describe("Value when the source is empty."),
};

export const variableSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...varBase,
    type: z.literal("data_layer"),
    key: z.string().min(1).max(200).describe("Dot path into the dataLayer model, e.g. ecommerce.value or items.0.price."),
  }),
  z.strictObject({ ...varBase, type: z.literal("url_param"), param: z.string().min(1).max(100) }),
  z.strictObject({ ...varBase, type: z.literal("cookie"), cookie: z.string().min(1).max(200) }),
  z.strictObject({ ...varBase, type: z.literal("dom_text"), selector }),
  z.strictObject({
    ...varBase,
    type: z.literal("dom_value"),
    selector: selector.describe("CSS selector of an input/select/textarea. On form_submit the submitted form is searched first."),
  }),
  z.strictObject({ ...varBase, type: z.literal("dom_attr"), selector, attr: z.string().min(1).max(100) }),
  z.strictObject({
    ...varBase,
    type: z.literal("js"),
    path: z
      .string()
      .min(1)
      .max(200)
      .describe("Global variable path, e.g. Shopify.checkout.total_price. Read only, never evaluated as code."),
  }),
  z.strictObject({ ...varBase, type: z.literal("constant"), value: scalar }),
  ...(["page_url", "page_path", "page_hostname", "referrer", "click_text", "click_url", "form_id"] as const).map((t) =>
    z.strictObject({ ...varBase, type: z.literal(t) }),
  ),
]);
export type Variable = z.infer<typeof variableSchema>;
export const VARIABLE_TYPES = [
  "data_layer",
  "url_param",
  "cookie",
  "dom_text",
  "dom_value",
  "dom_attr",
  "js",
  "constant",
  "page_url",
  "page_path",
  "page_hostname",
  "referrer",
  "click_text",
  "click_url",
  "form_id",
] as const;

// ---------------------------------------------------------------- triggers

export const conditionSchema = z.strictObject({
  var: z.string().min(1).max(64).describe("A variable name or a built-in (page_path, click_text, event...)."),
  op: z.enum(CONDITION_OPS),
  value: scalar.describe("Compared as a string. For matches_regex: a JavaScript regex source."),
  ignore_case: z.boolean().optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

const trigBase = {
  id: ident,
  conditions: z.array(conditionSchema).max(20).optional().describe("All must match (AND)."),
  description: z.string().max(500).optional(),
};

export const triggerSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...trigBase, type: z.literal("page_view") }),
  z.strictObject({ ...trigBase, type: z.literal("dom_ready") }),
  z.strictObject({ ...trigBase, type: z.literal("history_change") }),
  z.strictObject({
    ...trigBase,
    type: z.literal("click"),
    selector: selector.optional().describe("Match the click target or its closest ancestor matching this selector."),
    links_only: z.boolean().optional().describe("Only clicks on <a href> elements."),
  }),
  z.strictObject({
    ...trigBase,
    type: z.literal("form_submit"),
    selector: selector.optional().describe("Only forms matching this selector."),
  }),
  z.strictObject({
    ...trigBase,
    type: z.literal("custom_event"),
    event: z.string().min(1).max(100).describe("dataLayer event name, e.g. purchase."),
  }),
  z.strictObject({
    ...trigBase,
    type: z.literal("element_visible"),
    selector,
    threshold: z.number().min(0).max(1).optional().describe("Fraction visible, default 0.5."),
    once: z.boolean().optional().describe("Fire once per element per page (default true)."),
    observe_dom: z.boolean().optional().describe("Also watch elements added later (MutationObserver)."),
  }),
  z.strictObject({ ...trigBase, type: z.literal("scroll_depth"), percentages: z.array(z.number().int().min(1).max(100)).min(1).max(10) }),
  z.strictObject({
    ...trigBase,
    type: z.literal("timer"),
    interval_ms: z.number().int().min(250).max(3_600_000),
    limit: z.number().int().min(1).max(1000).optional().describe("Stop after this many fires (default 1)."),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;
export const TRIGGER_TYPES = [
  "page_view",
  "dom_ready",
  "history_change",
  "click",
  "form_submit",
  "custom_event",
  "element_visible",
  "scroll_depth",
  "timer",
] as const;

// ---------------------------------------------------------------- tags

const eventParams = z
  .record(z.string().max(40), scalar)
  .optional()
  .describe("Extra event parameters; strings may use {{variable}} templates.");

const tagBase = {
  id: ident,
  triggers: z.array(ident).min(1).max(20).describe("Trigger ids; the tag fires when any of them fires."),
  exclude_triggers: z.array(ident).max(20).optional().describe("Blocking triggers: if any fired for the same event, the tag doesn't."),
  consent: z
    .array(z.enum(CONSENT_TYPES))
    .max(7)
    .optional()
    .describe(
      "Consent types that must be granted. Omitted = the type's default (ad pixels: ad_storage, ga4: analytics_storage, others: none). [] = no consent needed.",
    ),
  once_per_page: z.boolean().optional().describe("Fire at most once per page (a history_change starts a new page)."),
  enabled: z.boolean().optional().describe("false keeps the tag in the config without firing it."),
  description: z.string().max(500).optional(),
};

export const tagSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...tagBase,
    type: z.literal("ga4"),
    params: z.strictObject({
      measurement_id: z.string().regex(/^G-[A-Z0-9]{4,15}$/, "GA4 measurement ids look like G-ABC123XYZ (Admin > Data streams)."),
      event_name: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
        .optional()
        .describe("Omit for the config/page_view tag; set to send an event instead."),
      event_params: eventParams,
      send_page_view: z.boolean().optional().describe("Default true: the first fire sends page_view via gtag config."),
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("google_ads"),
    params: z.strictObject({
      conversion_id: z.string().regex(/^AW-\d{6,15}$/, "Google Ads tag ids look like AW-123456789 (Tools > Conversions > Tag setup)."),
      conversion_label: z
        .string()
        .regex(/^[A-Za-z0-9_-]{4,64}$/)
        .optional()
        .describe("Set to fire a conversion on this tag's triggers (prefer conversions[].send_to.google_ads)."),
      value: scalar.optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("meta_pixel"),
    params: z.strictObject({
      pixel_id: z.string().regex(/^\d{8,20}$/, "Meta pixel (dataset) ids are 15-16 digits (Events Manager > Data sources)."),
      event_name: z.string().min(1).max(50).optional().describe("Default PageView."),
      event_params: eventParams,
      advanced_matching: z.boolean().optional().describe("Default true: pass hashed em/ph from conversions and afst('identify')."),
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("tiktok_pixel"),
    params: z.strictObject({
      pixel_id: z.string().regex(/^[A-Z0-9]{15,25}$/, "TikTok pixel codes are ~20 uppercase letters/digits (Events Manager > Web events)."),
      event_name: z.string().min(1).max(50).optional().describe("Default: ttq.page()."),
      event_params: eventParams,
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("linkedin_insight"),
    params: z.strictObject({
      partner_id: z.string().regex(/^\d{3,12}$/, "LinkedIn partner ids are numeric (Campaign Manager > Insight Tag)."),
      conversion_id: z
        .string()
        .regex(/^\d{3,15}$/)
        .optional()
        .describe("Fire this conversion id on the tag's triggers."),
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("microsoft_uet"),
    params: z.strictObject({
      tag_id: z.string().regex(/^\d{4,15}$/, "UET tag ids are numeric (Microsoft Ads > Tools > UET tag)."),
      event_action: z.string().min(1).max(100).optional(),
      event_params: eventParams,
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("reddit_pixel"),
    params: z.strictObject({
      pixel_id: z.string().regex(/^(a2|t2)_[a-z0-9]{4,20}$/, "Reddit pixel ids look like a2_abc123 or t2_abc123."),
      event_name: z.string().min(1).max(50).optional().describe("Default PageVisit."),
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("x_pixel"),
    params: z.strictObject({
      pixel_id: z.string().regex(/^[a-z0-9]{4,10}$/, "X pixel ids are short lowercase codes like o1abc."),
      event_id: z
        .string()
        .regex(/^tw-[a-z0-9]+-[a-z0-9]+$/)
        .optional()
        .describe("Fire this event (tw-<pixel>-<event>) on the tag's triggers."),
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("pinterest_tag"),
    params: z.strictObject({
      tag_id: z.string().regex(/^\d{8,16}$/, "Pinterest tag ids are 13 digits (Ads > Conversions > Tag manager)."),
      event_name: z.string().min(1).max(50).optional().describe("Default pagevisit."),
    }),
  }),
  z.strictObject({
    ...tagBase,
    type: z.literal("analytics"),
    params: z.strictObject({
      site_id: z.string().regex(/^site_[a-z0-9]+$/, "Use the site id from the analytics app (POST /v1/sites)."),
      base_url: z.url().optional().describe("Analytics app base URL; default the deployment's ANALYTICS_BASE_URL."),
    }),
  }),
  z.strictObject({ ...tagBase, type: z.literal("custom_html"), params: z.strictObject({ html: z.string().min(1).max(50_000) }) }),
  z.strictObject({
    ...tagBase,
    type: z.literal("custom_js"),
    params: z.strictObject({ code: z.string().min(1).max(50_000).describe("Function body; receives (afst, event).") }),
  }),
]);
export type Tag = z.infer<typeof tagSchema>;
export type TagType = Tag["type"];
export const TAG_TYPES = [
  "ga4",
  "google_ads",
  "meta_pixel",
  "tiktok_pixel",
  "linkedin_insight",
  "microsoft_uet",
  "reddit_pixel",
  "x_pixel",
  "pinterest_tag",
  "analytics",
  "custom_html",
  "custom_js",
] as const;

// ---------------------------------------------------------------- conversions

const varRef = ident.describe("A variable name (or built-in).");

export const sendToSchema = z.strictObject({
  ga4: z.strictObject({ event_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), params: eventParams }).optional(),
  google_ads: z
    .strictObject({
      send_to: z
        .string()
        .regex(/^AW-\d{6,15}\/[A-Za-z0-9_-]{4,64}$/, "Looks like AW-123456789/AbCdEfGh (conversion id/label).")
        .optional()
        .describe("Client-side gtag conversion."),
      conversion_action_id: z
        .string()
        .regex(/^\d{3,20}$/)
        .optional()
        .describe("Server-side: overrides the google_ads destination's conversion_action_id for this conversion."),
    })
    .optional(),
  meta: z.strictObject({ event_name: z.string().min(1).max(50), custom_data: eventParams }).optional(),
  tiktok: z.strictObject({ event_name: z.string().min(1).max(50) }).optional(),
  linkedin: z.strictObject({ conversion_id: z.string().regex(/^\d{3,15}$/) }).optional(),
  microsoft_uet: z.strictObject({ event_action: z.string().min(1).max(100) }).optional(),
  reddit: z.strictObject({ event_name: z.string().min(1).max(50) }).optional(),
  x: z.strictObject({ event_id: z.string().regex(/^tw-[a-z0-9]+-[a-z0-9]+$/) }).optional(),
  pinterest: z.strictObject({ event_name: z.string().min(1).max(50) }).optional(),
  analytics: z.strictObject({ event_name: z.string().min(1).max(64).optional() }).optional(),
});
export type SendTo = z.infer<typeof sendToSchema>;
export const SEND_TO_PLATFORMS = [
  "ga4",
  "google_ads",
  "meta",
  "tiktok",
  "linkedin",
  "microsoft_uet",
  "reddit",
  "x",
  "pinterest",
  "analytics",
] as const;
export type SendToPlatform = (typeof SEND_TO_PLATFORMS)[number];

export const userDataMapSchema = z.strictObject({
  email: varRef.optional(),
  phone: varRef.optional(),
  first_name: varRef.optional(),
  last_name: varRef.optional(),
  city: varRef.optional(),
  state: varRef.optional(),
  zip: varRef.optional(),
  country: varRef.optional(),
  external_id: varRef.optional().describe("Your user id; hashed for Meta/TikTok."),
});

export const conversionSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Letters, digits and _ (max 40), e.g. purchase."),
  trigger: ident.describe("Trigger id that fires this conversion."),
  value: z.union([z.number(), varRef]).optional().describe("A number, or a variable name holding the value."),
  currency: z
    .union([z.string().regex(/^[A-Z]{3}$/), z.strictObject({ var: varRef })])
    .optional()
    .describe('ISO 4217 code ("USD"), or { "var": "<variable>" }.'),
  transaction_id: varRef.optional().describe("Variable holding the order id (dedupe key for GA4 and Google Ads)."),
  items: varRef.optional().describe("Variable holding a GA4-style items array."),
  user_data: userDataMapSchema.optional().describe("Variables holding PII; normalised and SHA-256 hashed in the browser."),
  params: eventParams,
  send_to: sendToSchema,
  server: z.boolean().optional().describe("Also deliver server-side (conversion APIs) with the same event_id. Default false."),
  once_per_page: z.boolean().optional(),
  description: z.string().max(500).optional(),
});
export type Conversion = z.infer<typeof conversionSchema>;

// ---------------------------------------------------------------- consent + settings

const consentValue = z.enum(["granted", "denied"]);
export const consentStateSchema = z.strictObject(
  Object.fromEntries(CONSENT_TYPES.map((t) => [t, consentValue.optional()])) as Record<
    (typeof CONSENT_TYPES)[number],
    z.ZodOptional<typeof consentValue>
  >,
);

export const consentSchema = z.strictObject({
  mode: z
    .enum(["none", "opt_in", "opt_out"])
    .optional()
    .describe("none: granted unless default/regions say otherwise; opt_in: denied until granted; opt_out: granted until denied."),
  default: consentStateSchema.optional(),
  regions: z
    .record(
      z.string().regex(/^(EEA|[A-Z]{2}(-[A-Z0-9]{1,3})?)$/, 'Region keys: "EEA", a country ("GB"), or country-region ("US-CA").'),
      consentStateSchema,
    )
    .optional()
    .describe("Overrides by visitor location (from Cloudflare's edge). Most specific wins."),
  google_consent_mode: z
    .enum(["basic", "advanced"])
    .optional()
    .describe(
      "basic (default): Google tags wait for consent. advanced: Google tags load immediately and gtag's Consent Mode v2 sends cookieless pings while denied.",
    ),
  wait_for_update_ms: z.number().int().min(0).max(10_000).optional().describe("Passed to gtag('consent','default') as wait_for_update."),
});
export type ConsentConfig = z.infer<typeof consentSchema>;

export const settingsSchema = z.strictObject({
  phone_country_code: z
    .string()
    .regex(/^\d{1,4}$/)
    .optional()
    .describe('Calling code for phones without one, e.g. "1" (US) or "44" (UK).'),
  cookie_domain: z.string().max(253).optional().describe("Default: the container domain when the page is on it, else the page host."),
  listen_to_gtag_events: z
    .boolean()
    .optional()
    .describe("Treat gtag('event', name, params) calls already on the page as custom events. Off by default to avoid double-counting."),
  send_page_views: z
    .boolean()
    .optional()
    .describe(
      "Default true: send a light identity hit to /collect on landing (click ids, UTMs) so later server conversions can be attributed.",
    ),
  debug: z.boolean().optional().describe("Log runtime decisions to the console on the live site."),
});

export const containerConfigSchema = z.strictObject({
  variables: z.array(variableSchema).max(200).optional(),
  triggers: z.array(triggerSchema).max(200).optional(),
  tags: z.array(tagSchema).max(200).optional(),
  conversions: z.array(conversionSchema).max(100).optional(),
  consent: consentSchema.optional(),
  settings: settingsSchema.optional(),
});
export type ContainerConfig = z.infer<typeof containerConfigSchema>;

export const EMPTY_CONFIG: ContainerConfig = { variables: [], triggers: [], tags: [], conversions: [], consent: { mode: "none" } };

export function configJsonSchema() {
  return z.toJSONSchema(containerConfigSchema, { io: "input", unrepresentable: "any" });
}
