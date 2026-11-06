import { z } from "zod";
import { CONNECTORS } from "../destinations";
import { CONDITION_OPS } from "../lib/conditions";
import { CLICK_IDS } from "../lib/clickids";
import { DEFAULT_BANNER_TEXT } from "../lib/banner-text";
import { BANNER_CATEGORIES, CONSENT_TYPES, DEFAULT_TAG_CONSENT } from "../lib/consent";
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
  lookup: {
    description: "Lookup table: maps another variable's exact value to an output (GTM Lookup Table). No match: default.",
    example: { name: "plan_value", type: "lookup", input: "page_path", map: { "/thanks/pro": 99, "/thanks/basic": 19 }, default: 0 },
  },
  regex_table: {
    description: "RegEx table: first matching pattern wins; output may use $1..$9 (GTM RegEx Table).",
    example: {
      name: "page_group",
      type: "regex_table",
      input: "page_path",
      rows: [
        { pattern: "^/blog/(.*)", output: "blog:$1" },
        { pattern: "^/(pricing|plans)", output: "pricing" },
      ],
      default: "other",
    },
  },
  url: {
    description:
      "A part of a URL: href, protocol, host, port, path, query, fragment or one param; source defaults to page_url (also click_url, referrer, any variable).",
    example: { name: "link_host", type: "url", component: "host", source: "click_url", strip_www: true },
  },
  event_attr: {
    description: "Any attribute of the clicked, submitted or seen element (GTM auto-event variable).",
    example: { name: "product_id", type: "event_attr", attr: "data-product-id" },
  },
  param_set: {
    description:
      "Shared parameters (GTM Google tag event/configuration settings variable); tags merge them with event_params_from / config_params_from.",
    example: { name: "common_params", type: "param_set", params: { site_section: "{{page_group}}", logged_in: false } },
  },
  custom_js: {
    description:
      "Custom code, gated like custom_html/custom_js tags (a verified domain and a claimed account to publish): a function body run as (event) => { return value }. Prefer lookup, regex_table, url and format.",
    example: { name: "cart_size", type: "custom_js", code: "return (window.cart && window.cart.items.length) || 0;" },
  },
};

export const TRIGGER_EXAMPLES: Record<Trigger["type"], { description: string; example: Trigger }> = {
  page_view: {
    description: "Once when the container loads. Add conditions for specific pages.",
    example: { id: "thank_you", type: "page_view", conditions: [{ var: "page_path", op: "starts_with", value: "/thank-you" }] },
  },
  dom_ready: { description: "When the DOM is parsed (DOMContentLoaded).", example: { id: "dom_ready", type: "dom_ready" } },
  window_loaded: {
    description: "When the page has fully loaded (window load); right away if it already has.",
    example: { id: "loaded", type: "window_loaded" },
  },
  consent_init: {
    description: "Before everything else, for consent platform (CMP) loader tags (custom_html). Other tags warn.",
    example: { id: "consent_init", type: "consent_init" },
  },
  init: { description: "Before page_view (after consent_init).", example: { id: "init", type: "init" } },
  js_error: {
    description: "Uncaught JavaScript errors and unhandled promise rejections (at most 10 per page); error_message/error_url/error_line.",
    example: { id: "js_errors", type: "js_error" },
  },
  trigger_group: {
    description: "Fires once per page after every listed trigger has fired (in any order).",
    example: { id: "engaged", type: "trigger_group", triggers: ["scroll", "engaged_30s"] },
  },
  video: {
    description:
      "YouTube embeds (adds enablejsapi=1) and HTML5 <video>: start, progress (percentages), pause, seek, complete; video_* built-ins.",
    example: { id: "video", type: "video", statuses: ["start", "progress", "complete"], percentages: [25, 50, 75] },
  },
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
    description: "dataLayer.push({ event: '<name>' }) or afst('event', '<name>'). event_regex matches names by regex instead.",
    example: { id: "purchase_dl", type: "custom_event", event: "purchase" },
  },
  element_visible: {
    description: "Element scrolled into view (IntersectionObserver).",
    example: { id: "pricing_seen", type: "element_visible", selector: "#pricing", threshold: 0.5 },
  },
  scroll_depth: {
    description: "Scroll depth thresholds: percentages and/or pixels, vertical (default) or horizontal.",
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
  snap_pixel: {
    description: "Snap Pixel. Default PAGE_VIEW; conversions via send_to.snap.",
    example: { id: "snap", type: "snap_pixel", params: { pixel_id: "6f5c0b3e-4a2d-4c1b-9e8f-1a2b3c4d5e6f" }, triggers: ["all_pages"] },
  },
  image_pixel: {
    description:
      "An image request to a URL (GTM Custom Image tag), e.g. an affiliate pixel; {{variable}} values are URL-encoded; cache_bust (default true) adds afst_cb. Not custom code (no script runs).",
    example: {
      id: "affiliate",
      type: "image_pixel",
      params: { url: "https://track.example.net/pixel?order={{order_id}}&value={{order_value}}" },
      triggers: ["purchase_dl"],
    },
  },
  analytics: {
    description:
      "This platform's analytics app (loads <base_url>/s.js with data-site). A base_url on another host counts as custom code (needs a verified domain to publish).",
    example: { id: "analytics", type: "analytics", params: { site_id: "site_3k9x2m7q8w1e5r4t" }, triggers: ["all_pages"] },
  },
  custom_html: {
    description:
      "Custom code: publishing it needs a verified domain (POST /v1/containers/:id/verify) and a claimed account. Arbitrary HTML injected into <body>; <script> tags run. {{variables}} are interpolated HTML-encoded (all but letters, digits and _ . , : @ - become &#N;; javascript:/vbscript: values are dropped), so page data can't add markup. To use a value in JavaScript, use custom_js (event.data / event.model).",
    example: {
      id: "chat_widget",
      type: "custom_html",
      params: { html: "<script src='https://widget.example.com/w.js' async></script>" },
      triggers: ["all_pages"],
      consent: ["functionality_storage"],
    },
  },
  custom_js: {
    description: "Custom code (needs a verified domain and a claimed account to publish): a function body run as (afst, event) => { ... }.",
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

export const CONSENT_BANNER_EXAMPLE = {
  enabled: true,
  regions: "eea",
  categories: ["analytics", "ads", "personalization"],
  privacy_url: "https://example.com/privacy",
  position: "bottom",
  colors: { background: "#ffffff", text: "#1f2328", accent: "#1a56db", accent_text: "#ffffff" },
  expiry_days: 180,
  version: 1,
  languages: {
    de: {
      title: "Ihre Privatsphäre",
      body: "Wir verwenden Cookies und ähnliche Technologien, um die Nutzung unserer Website zu verstehen und Werbung zu messen und zu personalisieren. Sie entscheiden, welche wir verwenden dürfen.",
      accept: "Alle akzeptieren",
      reject: "Alle ablehnen",
      settings: "Anpassen",
      save: "Auswahl speichern",
    },
  },
} satisfies NonNullable<ContainerConfig["consent_banner"]>;

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
        receives: c.needsMapping
          ? `server conversions with send_to.${c.type}`
          : c.matchedOnly
            ? "every server conversion, and backend events whose name matches a conversion (settings.all_events: true for every backend event)"
            : "every server conversion and server event",
        max_attempts: c.maxAttempts ?? 6,
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
      consent_banner: {
        description:
          'The built-in consent banner (replaces Cookiebot and other CMPs). { "enabled": true } is complete: it asks visitors in the EEA, UK and Switzerland (regions "all": everyone) with "Reject all" as prominent as "Accept all", a settings layer per category, and records each choice as proof of consent (GET /v1/containers/:id/consent).',
        defaults: {
          regions: "eea",
          categories: Object.keys(BANNER_CATEGORIES),
          position: "bottom",
          expiry_days: 180,
          version: 1,
          reopen_button: false,
        },
        categories: { necessary: ["security_storage"], ...BANNER_CATEGORIES },
        text_defaults: DEFAULT_BANNER_TEXT,
        example: CONSENT_BANNER_EXAMPLE,
      },
      settings: {
        example: { phone_country_code: "1", send_page_views: true, cross_domain: ["checkout.example.net"], report_tag_fires: true },
      },
      click_ids: CLICK_IDS,
      full_example: FULL_EXAMPLE,
    },
    destinations: destinationCatalog(),
  };
}
