import { z } from "zod";
import { CONNECTORS } from "../destinations";
import { CONDITION_OPS } from "../lib/conditions";
import { CLICK_IDS } from "../lib/clickids";
import { CONSENT_TYPES, DEFAULT_TAG_CONSENT } from "../lib/consent";
import { BUILTIN_VARIABLES, configJsonSchema, type ContainerConfig, type Tag, type Trigger, type Variable } from "./schema";

/** One example per type. Every example is checked against the schema in tests. */
export const VARIABLE_EXAMPLES: Record<Variable["type"], { description: string; example: Variable }> = {
  data_layer: {
    description: "Value from the dataLayer model (dot path; arrays by index).",
    example: { name: "order_value", type: "data_layer", key: "ecommerce.value" },
  },
  url_param: { description: "Query-string parameter of the current URL.", example: { name: "plan", type: "url_param", param: "plan" } },
  cookie: { description: "First-party cookie value.", example: { name: "user_cookie", type: "cookie", cookie: "uid" } },
  dom_text: {
    description: "textContent of the first element matching a selector.",
    example: { name: "order_total_text", type: "dom_text", selector: ".order-total" },
  },
  dom_value: {
    description: "value of an input (the submitted form is searched first).",
    example: { name: "email", type: "dom_value", selector: "input[type=email]" },
  },
  dom_attr: {
    description: "Attribute of an element.",
    example: { name: "product_sku", type: "dom_attr", selector: "[data-sku]", attr: "data-sku" },
  },
  js: {
    description: "Global variable path (read, never evaluated).",
    example: { name: "shopify_total", type: "js", path: "Shopify.checkout.total_price" },
  },
  constant: { description: "A fixed value.", example: { name: "lead_value", type: "constant", value: 50 } },
  page_url: { description: "Alias of the page_url built-in.", example: { name: "url", type: "page_url" } },
  page_path: { description: "Alias of the page_path built-in.", example: { name: "path", type: "page_path" } },
  page_hostname: { description: "Alias of the page_hostname built-in.", example: { name: "host", type: "page_hostname" } },
  referrer: { description: "Alias of the referrer built-in.", example: { name: "ref", type: "referrer" } },
  click_text: { description: "Alias of the click_text built-in.", example: { name: "button_text", type: "click_text" } },
  click_url: { description: "Alias of the click_url built-in.", example: { name: "link_url", type: "click_url" } },
  form_id: { description: "Alias of the form_id built-in.", example: { name: "submitted_form", type: "form_id" } },
};

export const TRIGGER_EXAMPLES: Record<Trigger["type"], { description: string; example: Trigger }> = {
  page_view: {
    description: "Once when the container loads. Add conditions for specific pages.",
    example: { id: "thank_you", type: "page_view", conditions: [{ var: "page_path", op: "starts_with", value: "/thank-you" }] },
  },
  dom_ready: { description: "When the DOM is parsed (DOMContentLoaded).", example: { id: "dom_ready", type: "dom_ready" } },
  history_change: {
    description: "SPA navigation: pushState, replaceState, popstate, hashchange.",
    example: { id: "spa_nav", type: "history_change" },
  },
  click: {
    description: "Clicks on elements matching selector (or any click). click_text/click_url are available.",
    example: { id: "call_click", type: "click", selector: "a[href^='tel:']" },
  },
  form_submit: {
    description: "A form submit event (forms matching selector).",
    example: { id: "lead_form", type: "form_submit", selector: "form#contact" },
  },
  custom_event: {
    description: "dataLayer.push({ event: '<name>' }) or afst('event', '<name>').",
    example: { id: "purchase_dl", type: "custom_event", event: "purchase" },
  },
  element_visible: {
    description: "Element scrolled into view (IntersectionObserver).",
    example: { id: "pricing_seen", type: "element_visible", selector: "#pricing", threshold: 0.5 },
  },
  scroll_depth: {
    description: "Vertical scroll depth thresholds (percent).",
    example: { id: "scroll", type: "scroll_depth", percentages: [50, 90] },
  },
  timer: {
    description: "Every interval_ms, up to limit times.",
    example: { id: "engaged_30s", type: "timer", interval_ms: 30000, limit: 1 },
  },
};

export const TAG_EXAMPLES: Record<Tag["type"], { description: string; example: Tag }> = {
  ga4: {
    description: "Google Analytics 4 via gtag.js. Without event_name: config + page_view.",
    example: { id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] },
  },
  google_ads: {
    description: "Google Ads tag (remarketing + conversion linker). Conversions go in conversions[].send_to.google_ads.",
    example: { id: "gads", type: "google_ads", params: { conversion_id: "AW-123456789" }, triggers: ["all_pages"] },
  },
  meta_pixel: {
    description: "Meta (Facebook) pixel. Default event PageView.",
    example: { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
  },
  tiktok_pixel: {
    description: "TikTok pixel. Default ttq.page().",
    example: { id: "tiktok", type: "tiktok_pixel", params: { pixel_id: "C1A2B3C4D5E6F7G8H9I0" }, triggers: ["all_pages"] },
  },
  linkedin_insight: {
    description: "LinkedIn Insight Tag.",
    example: { id: "linkedin", type: "linkedin_insight", params: { partner_id: "1234567" }, triggers: ["all_pages"] },
  },
  microsoft_uet: {
    description: "Microsoft Advertising UET tag.",
    example: { id: "uet", type: "microsoft_uet", params: { tag_id: "12345678" }, triggers: ["all_pages"] },
  },
  reddit_pixel: {
    description: "Reddit pixel. Default PageVisit.",
    example: { id: "reddit", type: "reddit_pixel", params: { pixel_id: "a2_abc123def456" }, triggers: ["all_pages"] },
  },
  x_pixel: {
    description: "X (Twitter) pixel.",
    example: { id: "x", type: "x_pixel", params: { pixel_id: "o1abc" }, triggers: ["all_pages"] },
  },
  pinterest_tag: {
    description: "Pinterest tag. Default pagevisit.",
    example: { id: "pinterest", type: "pinterest_tag", params: { tag_id: "2612345678901" }, triggers: ["all_pages"] },
  },
  analytics: {
    description: "This platform's analytics app (loads <base_url>/s.js with data-site).",
    example: { id: "analytics", type: "analytics", params: { site_id: "site_3k9x2m7q8w1e5r4t" }, triggers: ["all_pages"] },
  },
  custom_html: {
    description:
      "Arbitrary HTML injected into <body>; <script> tags run. {{variables}} are interpolated HTML-encoded (all but letters, digits and _ . , : @ - become &#N;; javascript:/vbscript: values are dropped), so page data can't add markup. To use a value in JavaScript, use custom_js (event.data / event.model).",
    example: {
      id: "chat_widget",
      type: "custom_html",
      params: { html: "<script src='https://widget.example.com/w.js' async></script>" },
      triggers: ["all_pages"],
      consent: ["functionality_storage"],
    },
  },
  custom_js: {
    description: "A function body run as (afst, event) => { ... }.",
    example: { id: "log_purchase", type: "custom_js", params: { code: "console.log('purchase', event.data)" }, triggers: ["purchase_dl"] },
  },
};

export const CONVERSION_EXAMPLE = {
  name: "purchase",
  trigger: "purchase_dl",
  value: "order_value",
  currency: "USD",
  transaction_id: "order_id",
  user_data: { email: "email" },
  send_to: {
    ga4: { event_name: "purchase" },
    google_ads: { send_to: "AW-123456789/AbCdEfGh" },
    meta: { event_name: "Purchase" },
    tiktok: { event_name: "CompletePayment" },
  },
  server: true,
} satisfies NonNullable<ContainerConfig["conversions"]>[number];

export const CONSENT_EXAMPLE = {
  mode: "none",
  default: { analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
  regions: {
    EEA: { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" },
    GB: { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" },
  },
  google_consent_mode: "basic",
} satisfies NonNullable<ContainerConfig["consent"]>;

export const FULL_EXAMPLE: ContainerConfig = {
  variables: [
    { name: "order_value", type: "data_layer", key: "ecommerce.value" },
    { name: "order_id", type: "data_layer", key: "ecommerce.transaction_id" },
    { name: "email", type: "data_layer", key: "user.email" },
  ],
  triggers: [
    { id: "all_pages", type: "page_view" },
    { id: "purchase_dl", type: "custom_event", event: "purchase" },
  ],
  tags: [
    { id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] },
    { id: "gads", type: "google_ads", params: { conversion_id: "AW-123456789" }, triggers: ["all_pages"] },
    { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
    { id: "tiktok", type: "tiktok_pixel", params: { pixel_id: "C1A2B3C4D5E6F7G8H9I0" }, triggers: ["all_pages"] },
  ],
  conversions: [CONVERSION_EXAMPLE],
  consent: CONSENT_EXAMPLE,
};

/** Standard event names per platform for common conversion kinds (used by the recipe tool). */
export const STANDARD_EVENTS: Record<
  string,
  Partial<Record<"ga4" | "meta" | "tiktok" | "microsoft_uet" | "reddit" | "pinterest" | "analytics", string>>
> = {
  purchase: {
    ga4: "purchase",
    meta: "Purchase",
    tiktok: "CompletePayment",
    microsoft_uet: "purchase",
    reddit: "Purchase",
    pinterest: "checkout",
    analytics: "purchase",
  },
  lead: {
    ga4: "generate_lead",
    meta: "Lead",
    tiktok: "SubmitForm",
    microsoft_uet: "submit_lead_form",
    reddit: "Lead",
    pinterest: "lead",
    analytics: "lead",
  },
  sign_up: {
    ga4: "sign_up",
    meta: "CompleteRegistration",
    tiktok: "CompleteRegistration",
    microsoft_uet: "sign_up",
    reddit: "SignUp",
    pinterest: "signup",
    analytics: "sign_up",
  },
  contact: {
    ga4: "contact",
    meta: "Contact",
    tiktok: "Contact",
    microsoft_uet: "contact",
    reddit: "Lead",
    pinterest: "lead",
    analytics: "contact",
  },
  subscribe: {
    ga4: "purchase",
    meta: "Subscribe",
    tiktok: "Subscribe",
    microsoft_uet: "subscribe",
    reddit: "Purchase",
    pinterest: "checkout",
    analytics: "subscribe",
  },
  start_trial: {
    ga4: "sign_up",
    meta: "StartTrial",
    tiktok: "Subscribe",
    microsoft_uet: "sign_up",
    reddit: "SignUp",
    pinterest: "signup",
    analytics: "start_trial",
  },
  add_to_cart: {
    ga4: "add_to_cart",
    meta: "AddToCart",
    tiktok: "AddToCart",
    microsoft_uet: "add_to_cart",
    reddit: "AddToCart",
    pinterest: "addtocart",
    analytics: "add_to_cart",
  },
  begin_checkout: {
    ga4: "begin_checkout",
    meta: "InitiateCheckout",
    tiktok: "InitiateCheckout",
    microsoft_uet: "begin_checkout",
    reddit: "Custom",
    pinterest: "custom",
    analytics: "begin_checkout",
  },
  book_appointment: {
    ga4: "generate_lead",
    meta: "Schedule",
    tiktok: "Contact",
    microsoft_uet: "book_appointment",
    reddit: "Lead",
    pinterest: "lead",
    analytics: "book_appointment",
  },
};

export function destinationCatalog() {
  return Object.fromEntries(
    Object.values(CONNECTORS).map((c) => [
      c.type,
      {
        label: c.label,
        api: c.api,
        credentials_schema: z.toJSONSchema(c.credentials as z.ZodType, { io: "input", unrepresentable: "any" }),
        example: { type: c.type, credentials: c.example },
        public_fields: c.publicFields,
        required_consent: c.requiredConsent,
        receives: c.needsMapping ? `server conversions with send_to.${c.type}` : "every server conversion and server event",
        dedupe: c.skipIfFiredBy
          ? `a browser conversion's server copy is skipped when that hit's ${c.skipIfFiredBy} tag already sent it (the platform doesn't dedupe by event_id); backend events are always delivered`
          : c.type === "google_ads"
            ? "transaction id (order id) within the conversion action"
            : c.type === "webhook"
              ? "x-event-id header (dedupe on your side)"
              : "event_id shared with the pixel",
        test_mode: c.testMode,
        docs: c.docs,
      },
    ]),
  );
}

export function schemaDocument() {
  return {
    json_schema: configJsonSchema(),
    catalog: {
      variables: VARIABLE_EXAMPLES,
      built_in_variables: BUILTIN_VARIABLES,
      triggers: TRIGGER_EXAMPLES,
      condition_ops: CONDITION_OPS,
      tags: Object.fromEntries(Object.entries(TAG_EXAMPLES).map(([k, v]) => [k, { ...v, default_consent: DEFAULT_TAG_CONSENT[k] }])),
      conversions: {
        description:
          "Defined once; the runtime creates one event_id per fire, sends it with every client tag (gtag transaction_id, fbq eventID, ttq event_id) and, with server: true, posts it to /collect for the conversion APIs, so each platform counts it once.",
        example: CONVERSION_EXAMPLE,
        standard_events: STANDARD_EVENTS,
      },
      consent: { description: "Consent state with Google Consent Mode v2 passthrough.", types: CONSENT_TYPES, example: CONSENT_EXAMPLE },
      settings: {
        example: { phone_country_code: "1", send_page_views: true },
      },
      click_ids: CLICK_IDS,
      full_example: FULL_EXAMPLE,
    },
    destinations: destinationCatalog(),
  };
}
