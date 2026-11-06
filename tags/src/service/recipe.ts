import { z } from "zod";
import { STANDARD_EVENTS } from "../config/catalog";
import type { ContainerConfig, Conversion, Tag, Trigger, Variable } from "../config/schema";
import type { ValidationResult } from "../config/validate";

/**
 * setup_conversion_tracking: plain inputs -> a complete draft (tags, triggers, variables,
 * conversions, consent) + destinations, validated, with a list of what's still missing.
 * buildRecipe() is pure; the MCP tool/route writes the draft and destinations.
 */

const dl = z.strictObject({ data_layer: z.string().min(1).max(200) });
const sel = z.strictObject({ selector: z.string().min(1).max(500) });

export const recipeInput = z.strictObject({
  platforms: z
    .strictObject({
      ga4: z.strictObject({ measurement_id: z.string().optional(), api_secret: z.string().optional() }).optional(),
      google_ads: z
        .strictObject({
          conversion_id: z.string().optional().describe("AW-123456789 (browser tag)."),
          labels: z
            .record(z.string(), z.string())
            .optional()
            .describe("Conversion name -> conversion label for browser conversions, e.g. { purchase: 'AbCdEf' }."),
          server: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "google_ads destination credentials (customer_id, conversion_action_id, client_id, client_secret, refresh_token, ...).",
            ),
        })
        .optional(),
      meta: z
        .strictObject({ pixel_id: z.string().optional(), access_token: z.string().optional(), test_event_code: z.string().optional() })
        .optional(),
      tiktok: z
        .strictObject({ pixel_id: z.string().optional(), access_token: z.string().optional(), test_event_code: z.string().optional() })
        .optional(),
      linkedin: z
        .strictObject({ partner_id: z.string().optional(), conversion_ids: z.record(z.string(), z.string()).optional() })
        .optional(),
      microsoft_uet: z.strictObject({ tag_id: z.string().optional() }).optional(),
      reddit: z.strictObject({ pixel_id: z.string().optional() }).optional(),
      x: z.strictObject({ pixel_id: z.string().optional(), event_ids: z.record(z.string(), z.string()).optional() }).optional(),
      pinterest: z.strictObject({ tag_id: z.string().optional() }).optional(),
      analytics: z
        .strictObject({
          site_id: z.string().optional().describe("The analytics site (site_...): the browser tag, and server-side delivery."),
          api_key: z
            .string()
            .optional()
            .describe(
              "afs_ key for server-side delivery. Not needed when this deployment has the ANALYTICS service binding (setup then delivers over it as this account).",
            ),
          base_url: z.string().optional(),
        })
        .optional(),
      webhook: z.strictObject({ url: z.string(), secret: z.string() }).optional(),
    })
    .describe("Platforms to track with. Give whatever ids/credentials you have; missing ones are listed in the response."),
  conversions: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
        kind: z
          .enum([
            "purchase",
            "lead",
            "sign_up",
            "contact",
            "subscribe",
            "start_trial",
            "add_to_cart",
            "begin_checkout",
            "book_appointment",
            "custom",
          ])
          .optional()
          .describe("Picks each platform's standard event name. Default: the name if it's a kind, else custom."),
        when: z
          .strictObject({
            thank_you_path: z.string().optional().describe("Fires on page views whose path starts with this, e.g. /thank-you."),
            form_selector: z.string().optional().describe("Fires on submit of forms matching this CSS selector."),
            data_layer_event: z.string().optional().describe("Fires on dataLayer.push({ event: <this> })."),
            click_selector: z.string().optional().describe("Fires on clicks on elements matching this selector (e.g. a[href^='tel:'])."),
          })
          .describe("Exactly one way the conversion happens on the site."),
        value: z.union([z.number(), dl]).optional().describe("A fixed number or { data_layer: 'ecommerce.value' }."),
        currency: z.union([z.string().regex(/^[A-Z]{3}$/), dl]).optional(),
        transaction_id: dl.optional().describe("{ data_layer: 'ecommerce.transaction_id' }"),
        email: z.union([sel, dl]).optional().describe("Where the visitor's email is: { selector } of an input, or { data_layer } key."),
        phone: z.union([sel, dl]).optional(),
        server: z.boolean().optional().describe("Also deliver via conversion APIs (default true)."),
      }),
    )
    .min(1)
    .max(20),
  consent: z
    .enum(["none", "eea_opt_in", "opt_in", "opt_out", "banner"])
    .optional()
    .describe(
      "Default eea_opt_in: granted, except EEA/UK/CH visitors start denied until your banner grants. banner: the built-in consent banner asks EEA/UK/CH visitors (consent_banner, no CMP of your own needed).",
    ),
  phone_country_code: z
    .string()
    .regex(/^\d{1,4}$/)
    .optional(),
  mode: z
    .enum(["merge", "replace"])
    .optional()
    .describe("merge (default) upserts into the existing draft by id; replace starts from empty."),
});
export type RecipeInput = z.infer<typeof recipeInput>;

export interface Missing {
  platform: string;
  field: string;
  impact: string;
  where: string;
}

export interface PlannedDestination {
  type: string;
  credentials: Record<string, unknown>;
  name: string;
}

const WHERE: Record<string, string> = {
  "ga4.measurement_id": "GA4 > Admin > Data streams > (web stream) > Measurement ID (G-...).",
  "ga4.api_secret": "GA4 > Admin > Data streams > (web stream) > Measurement Protocol API secrets > Create.",
  "google_ads.conversion_id":
    "Google Ads > Goals > Conversions > Summary > (action) > Tag setup > Install the tag yourself: the AW-... id.",
  "google_ads.labels": "Same place: the event snippet's send_to 'AW-.../<label>' for each conversion action.",
  "google_ads.server":
    "Create an 'Import from clicks' (UPLOAD_CLICKS) conversion action; OAuth client (Google Cloud console) + refresh token with scope https://www.googleapis.com/auth/datamanager; customer_id and conversion_action_id (ctId in the URL).",
  "meta.pixel_id": "Meta Events Manager > Data sources > (pixel) > Settings: Dataset ID.",
  "meta.access_token": "Meta Events Manager > (pixel) > Settings > Conversions API > Generate access token.",
  "tiktok.pixel_id": "TikTok Ads Manager > Assets > Events > Web events > (pixel) code.",
  "tiktok.access_token": "TikTok Events Manager > (pixel) > Settings > Events API > Generate access token.",
  "linkedin.partner_id": "LinkedIn Campaign Manager > Analyze > Insight Tag > Partner ID.",
  "linkedin.conversion_ids": "LinkedIn Campaign Manager > Conversions > (conversion) id, per conversion name.",
  "microsoft_uet.tag_id": "Microsoft Ads > Tools > UET tag > Tag ID.",
  "reddit.pixel_id": "Reddit Ads > Events Manager > Pixel ID (a2_... / t2_...).",
  "x.pixel_id": "X Ads > Tools > Events manager > Pixel ID.",
  "x.event_ids": "X Ads > Events manager > (event) id 'tw-<pixel>-<event>' per conversion.",
  "pinterest.tag_id": "Pinterest Ads > Conversions > Tag manager > Tag ID.",
  "analytics.site_id": "analytics app: POST /v1/sites { domain } returns site_...",
  "analytics.api_key":
    "Your afs_ API key (POST /v1/signup on any app; one key works for every app). Only needed where the deployment has no ANALYTICS service binding.",
};

/** What buildRecipe needs to know about the deployment and the container beyond the input. */
export interface RecipeOptions {
  /** Analytics is reachable without an API key (ANALYTICS service binding + INTERNAL_TOKEN). */
  analyticsBinding?: boolean;
  /** Types of the container's enabled destinations before setup. */
  existingDestinations?: string[];
  /**
   * Destination types that will exist after setup. Default: the existing ones plus every planned
   * one; applyRecipe passes the real set when a planned destination couldn't be created.
   */
  available?: string[];
  /** Planned destination types that couldn't be created (named in the server: false note). */
  failed?: string[];
}

const KINDS = new Set(Object.keys(STANDARD_EVENTS));
const EEA_DENIED = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" } as const;

function upsert<T>(list: T[], item: T, key: (t: T) => string) {
  const i = list.findIndex((x) => key(x) === key(item));
  if (i >= 0) list[i] = item;
  else list.push(item);
}

export function buildRecipe(
  input: RecipeInput,
  existing: ContainerConfig,
  opts: RecipeOptions = {},
): { config: ContainerConfig; destinations: PlannedDestination[]; missing: Missing[]; notes: string[] } {
  const base: ContainerConfig = input.mode === "replace" ? {} : (JSON.parse(JSON.stringify(existing)) as ContainerConfig);
  const variables: Variable[] = base.variables ?? [];
  const triggers: Trigger[] = base.triggers ?? [];
  const tags: Tag[] = base.tags ?? [];
  const conversions: Conversion[] = base.conversions ?? [];
  const missing: Missing[] = [];
  const notes: string[] = [];
  const destinations: PlannedDestination[] = [];
  /** Why server delivery can't happen, for the note on conversions left browser-only. */
  const serverOffReasons: string[] = [];
  const p = input.platforms;
  const miss = (platform: string, field: string, impact: string) =>
    missing.push({ platform, field, impact, where: WHERE[`${platform}.${field}`] ?? "" });

  upsert(triggers, { id: "all_pages", type: "page_view" }, (t) => t.id);
  const addTag = (t: Tag) => upsert(tags, t, (x) => x.id);

  if (p.ga4) {
    if (p.ga4.measurement_id) addTag({ id: "ga4", type: "ga4", params: { measurement_id: p.ga4.measurement_id }, triggers: ["all_pages"] });
    else miss("ga4", "measurement_id", "No GA4 tag in the browser.");
    if (p.ga4.measurement_id && p.ga4.api_secret)
      destinations.push({
        type: "ga4",
        name: "GA4 Measurement Protocol",
        credentials: { measurement_id: p.ga4.measurement_id, api_secret: p.ga4.api_secret },
      });
    else miss("ga4", "api_secret", "No server-side GA4 (ad-blocked visitors and backend conversions won't reach GA4).");
  }
  if (p.google_ads) {
    if (p.google_ads.conversion_id)
      addTag({ id: "google_ads", type: "google_ads", params: { conversion_id: p.google_ads.conversion_id }, triggers: ["all_pages"] });
    else miss("google_ads", "conversion_id", "No Google Ads tag / browser conversions.");
    if (p.google_ads.server)
      destinations.push({ type: "google_ads", name: "Google Ads offline conversions", credentials: p.google_ads.server });
    else miss("google_ads", "server", "No server-side click conversion upload (gclid joins from backend events won't reach Google Ads).");
  }
  if (p.meta) {
    if (p.meta.pixel_id) addTag({ id: "meta", type: "meta_pixel", params: { pixel_id: p.meta.pixel_id }, triggers: ["all_pages"] });
    else miss("meta", "pixel_id", "No Meta pixel.");
    if (p.meta.pixel_id && p.meta.access_token) {
      destinations.push({
        type: "meta",
        name: "Meta Conversions API",
        credentials: {
          pixel_id: p.meta.pixel_id,
          access_token: p.meta.access_token,
          ...(p.meta.test_event_code ? { test_event_code: p.meta.test_event_code } : {}),
        },
      });
    } else miss("meta", "access_token", "No Meta Conversions API (browser pixel only; ad blockers and iOS lose conversions).");
  }
  if (p.tiktok) {
    if (p.tiktok.pixel_id) addTag({ id: "tiktok", type: "tiktok_pixel", params: { pixel_id: p.tiktok.pixel_id }, triggers: ["all_pages"] });
    else miss("tiktok", "pixel_id", "No TikTok pixel.");
    if (p.tiktok.pixel_id && p.tiktok.access_token) {
      destinations.push({
        type: "tiktok",
        name: "TikTok Events API",
        credentials: {
          pixel_code: p.tiktok.pixel_id,
          access_token: p.tiktok.access_token,
          ...(p.tiktok.test_event_code ? { test_event_code: p.tiktok.test_event_code } : {}),
        },
      });
    } else miss("tiktok", "access_token", "No TikTok Events API (browser pixel only).");
  }
  if (p.linkedin) {
    if (p.linkedin.partner_id)
      addTag({ id: "linkedin", type: "linkedin_insight", params: { partner_id: p.linkedin.partner_id }, triggers: ["all_pages"] });
    else miss("linkedin", "partner_id", "No LinkedIn Insight Tag.");
  }
  if (p.microsoft_uet) {
    if (p.microsoft_uet.tag_id)
      addTag({ id: "uet", type: "microsoft_uet", params: { tag_id: p.microsoft_uet.tag_id }, triggers: ["all_pages"] });
    else miss("microsoft_uet", "tag_id", "No Microsoft UET tag.");
  }
  if (p.reddit) {
    if (p.reddit.pixel_id) addTag({ id: "reddit", type: "reddit_pixel", params: { pixel_id: p.reddit.pixel_id }, triggers: ["all_pages"] });
    else miss("reddit", "pixel_id", "No Reddit pixel.");
  }
  if (p.x) {
    if (p.x.pixel_id) addTag({ id: "x", type: "x_pixel", params: { pixel_id: p.x.pixel_id }, triggers: ["all_pages"] });
    else miss("x", "pixel_id", "No X pixel.");
  }
  if (p.pinterest) {
    if (p.pinterest.tag_id)
      addTag({ id: "pinterest", type: "pinterest_tag", params: { tag_id: p.pinterest.tag_id }, triggers: ["all_pages"] });
    else miss("pinterest", "tag_id", "No Pinterest tag.");
  }
  if (p.analytics) {
    if (p.analytics.site_id)
      addTag({
        id: "analytics",
        type: "analytics",
        params: { site_id: p.analytics.site_id, ...(p.analytics.base_url ? { base_url: p.analytics.base_url } : {}) },
        triggers: ["all_pages"],
      });
    else miss("analytics", "site_id", "No analytics tag.");
    if (p.analytics.site_id && p.analytics.api_key) {
      destinations.push({
        type: "analytics",
        name: "analytics app",
        credentials: {
          site_id: p.analytics.site_id,
          api_key: p.analytics.api_key,
          ...(p.analytics.base_url ? { base_url: p.analytics.base_url } : {}),
        },
      });
    } else if (p.analytics.site_id && opts.analyticsBinding) {
      // No key needed: delivered over this deployment's ANALYTICS binding as the container's account.
      destinations.push({ type: "analytics", name: "analytics app (service binding)", credentials: { site_id: p.analytics.site_id } });
    } else if (p.analytics.site_id) {
      miss(
        "analytics",
        "api_key",
        "No server-side delivery to analytics: this deployment has no ANALYTICS service binding, so that needs an API key. The analytics tag still counts conversions in the browser.",
      );
      serverOffReasons.push(
        "platforms.analytics has a site_id but no api_key, and this deployment has no ANALYTICS service binding to deliver without one",
      );
    }
  }
  if (p.webhook) destinations.push({ type: "webhook", name: "webhook", credentials: { url: p.webhook.url, secret: p.webhook.secret } });

  // Destination types that will receive server conversions: existing + planned (or what was really created).
  const serverTypes = new Set(opts.available ?? [...(opts.existingDestinations ?? []), ...destinations.map((d) => d.type)]);
  if (opts.failed?.length)
    serverOffReasons.push(
      `the ${opts.failed.join(", ")} destination${opts.failed.length > 1 ? "s" : ""} couldn't be created (destination_errors)`,
    );
  const browserOnly: string[] = [];
  for (const c of input.conversions) {
    const kind = c.kind ?? (KINDS.has(c.name) ? c.name : "custom");
    const std = STANDARD_EVENTS[kind] ?? {};
    const trigId = `${c.name}_trigger`;
    const w = c.when;
    const ways = [w.thank_you_path, w.form_selector, w.data_layer_event, w.click_selector].filter(Boolean).length;
    if (ways !== 1)
      notes.push(
        `Conversion "${c.name}": give exactly one of when.thank_you_path / form_selector / data_layer_event / click_selector (got ${ways}). Using the first.`,
      );
    if (w.thank_you_path)
      upsert(
        triggers,
        { id: trigId, type: "page_view", conditions: [{ var: "page_path", op: "starts_with", value: w.thank_you_path }] },
        (t) => t.id,
      );
    else if (w.form_selector) upsert(triggers, { id: trigId, type: "form_submit", selector: w.form_selector }, (t) => t.id);
    else if (w.data_layer_event) upsert(triggers, { id: trigId, type: "custom_event", event: w.data_layer_event }, (t) => t.id);
    else if (w.click_selector) upsert(triggers, { id: trigId, type: "click", selector: w.click_selector }, (t) => t.id);
    else upsert(triggers, { id: trigId, type: "custom_event", event: c.name }, (t) => t.id);

    const conv: Conversion = { name: c.name, trigger: trigId, send_to: {}, server: c.server !== false };
    const dlVar = (suffix: string, key: string) => {
      const name = `${c.name}_${suffix}`;
      upsert(variables, { name, type: "data_layer", key }, (v) => v.name);
      return name;
    };
    if (typeof c.value === "number") conv.value = c.value;
    else if (c.value) conv.value = dlVar("value", c.value.data_layer);
    if (typeof c.currency === "string") conv.currency = c.currency;
    else if (c.currency) conv.currency = { var: dlVar("currency", c.currency.data_layer) };
    if (c.transaction_id) conv.transaction_id = dlVar("order_id", c.transaction_id.data_layer);
    const ud: NonNullable<Conversion["user_data"]> = {};
    for (const field of ["email", "phone"] as const) {
      const src = c[field];
      if (!src) continue;
      const name = `${c.name}_${field}`;
      if ("selector" in src) upsert(variables, { name, type: "dom_value", selector: src.selector }, (v) => v.name);
      else upsert(variables, { name, type: "data_layer", key: src.data_layer }, (v) => v.name);
      ud[field] = name;
    }
    if (Object.keys(ud).length) conv.user_data = ud;
    if (w.form_selector && !c.email)
      notes.push(
        `Conversion "${c.name}" is a form submit without an email mapping; add email: { selector: "input[type=email]" } for better match rates.`,
      );
    if ((kind === "purchase" || kind === "subscribe") && conv.value === undefined)
      notes.push(`Conversion "${c.name}" has no value; pass value: { data_layer: "ecommerce.value" } and currency.`);

    const has = (type: string) => tags.some((t) => t.type === type);
    const custom = kind === "custom";
    if (p.ga4) conv.send_to.ga4 = { event_name: custom ? c.name : std.ga4! };
    if (p.meta) conv.send_to.meta = { event_name: custom ? c.name : std.meta! };
    if (p.tiktok) conv.send_to.tiktok = { event_name: custom ? c.name : std.tiktok! };
    if (p.google_ads) {
      const label = p.google_ads.labels?.[c.name];
      if (label && p.google_ads.conversion_id) conv.send_to.google_ads = { send_to: `${p.google_ads.conversion_id}/${label}` };
      else if (serverTypes.has("google_ads")) conv.send_to.google_ads = {};
      else miss("google_ads", "labels", `Conversion "${c.name}" has no Google Ads label and no server upload, so Google Ads won't see it.`);
    }
    if (p.linkedin && has("linkedin_insight")) {
      const id = p.linkedin.conversion_ids?.[c.name];
      if (id) conv.send_to.linkedin = { conversion_id: id };
      else miss("linkedin", "conversion_ids", `Conversion "${c.name}" isn't sent to LinkedIn (needs its conversion id).`);
    }
    if (p.microsoft_uet && has("microsoft_uet")) conv.send_to.microsoft_uet = { event_action: custom ? c.name : std.microsoft_uet! };
    if (p.reddit && has("reddit_pixel")) conv.send_to.reddit = { event_name: custom ? c.name : std.reddit! };
    if (p.x && has("x_pixel")) {
      const id = p.x.event_ids?.[c.name];
      if (id) conv.send_to.x = { event_id: id };
      else miss("x", "event_ids", `Conversion "${c.name}" isn't sent to X (needs its event id).`);
    }
    if (p.pinterest && has("pinterest_tag")) conv.send_to.pinterest = { event_name: custom ? c.name : std.pinterest! };
    if (p.analytics) conv.send_to.analytics = { event_name: c.name };
    // server: true only when a destination will receive it (analytics and webhooks take every server
    // conversion, the others their send_to platform). An explicit server: true is kept; the gap then
    // shows in validation and missing.
    const receivable =
      serverTypes.has("analytics") || serverTypes.has("webhook") || Object.keys(conv.send_to).some((x) => serverTypes.has(x));
    if (conv.server && !receivable && c.server !== true) {
      conv.server = false;
      browserOnly.push(c.name);
    }
    upsert(conversions, conv, (x) => x.name);
  }
  if (browserOnly.length) {
    const why = serverOffReasons.length ? `: ${serverOffReasons.join("; ")}` : "";
    notes.push(
      `server: false on ${browserOnly.map((n) => `"${n}"`).join(", ")}, because no server-side destination would receive ${browserOnly.length > 1 ? "them" : "it"}${why}. Browser tags still fire. To deliver server-side too, give server credentials here (ga4.api_secret, meta.access_token, tiktok.access_token, analytics.api_key...) or add a destination (POST /v1/containers/:id/destinations), then run setup again (it merges).`,
    );
  }

  const consent = input.consent ?? "eea_opt_in";
  const consentCfg: ContainerConfig["consent"] =
    consent === "none" || consent === "banner"
      ? { mode: "none" }
      : consent === "eea_opt_in"
        ? { mode: "none", regions: { EEA: { ...EEA_DENIED }, GB: { ...EEA_DENIED }, CH: { ...EEA_DENIED } } }
        : { mode: consent };
  const consentBanner: ContainerConfig["consent_banner"] =
    consent === "banner" ? { ...base.consent_banner, enabled: true } : base.consent_banner;
  if (consent === "banner")
    notes.push(
      'The built-in consent banner asks visitors in the EEA, UK and Switzerland first; add consent_banner.privacy_url (your privacy policy) and a "Cookie settings" link (<a href="#" data-afst-consent-open>) to the footer. GET /v1/containers/:id/consent shows accept/reject rates after publishing.',
    );
  else if (consent !== "none")
    notes.push(
      'Your consent banner must call afst("consent", "update", { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }) when the visitor accepts (CMPs that call gtag("consent","update") work automatically). No banner yet? consent: "banner" turns on the built-in one.',
    );

  const settings = { ...(base.settings ?? {}) };
  if (input.phone_country_code) settings.phone_country_code = input.phone_country_code;
  return {
    config: {
      ...base,
      variables,
      triggers,
      tags,
      conversions,
      consent: consentCfg,
      ...(consentBanner ? { consent_banner: consentBanner } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
    },
    destinations,
    missing,
    notes,
  };
}

/** Validation warnings that mean a conversion won't reach a platform it targets (or won't go server-side as asked). */
export const DELIVERY_GAP_CODES = new Set(["no_route", "no_platforms", "no_destinations", "server_without_destination"]);

/**
 * The draft's delivery gaps as missing[] entries, one per (warning, platform), naming the
 * conversions. setup reports ready_to_publish only when there are none.
 */
export function deliveryGaps(validation: ValidationResult, config: ContainerConfig): Missing[] {
  const groups = new Map<string, { code: string; platform: string; names: string[]; hint: string }>();
  for (const w of validation.warnings) {
    if (!DELIVERY_GAP_CODES.has(w.code)) continue;
    const i = Number(/^conversions\.(\d+)/.exec(w.path)?.[1]);
    const name = config.conversions?.[i]?.name ?? w.path;
    const platform = /send_to\.([a-z0-9_]+)/.exec(w.path)?.[1] ?? /targets ([a-z0-9_]+)/.exec(w.message)?.[1] ?? "server";
    const key = `${w.code}:${platform}`;
    const g = groups.get(key) ?? { code: w.code, platform, names: [], hint: w.hint };
    if (!g.names.includes(name)) g.names.push(name);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const names = g.names.map((n) => `"${n}"`).join(", ");
    const impact = {
      no_route: `Conversion ${names} targets ${g.platform}, but nothing delivers it there (no browser tag, no destination).`,
      no_platforms: `Conversion ${names} has an empty send_to: nothing receives it.`,
      no_destinations: `Conversion ${names} has server: true, but the container has no destinations: nothing is sent server-side.`,
      server_without_destination: `Conversion ${names} has server: true and targets ${g.platform}, but there's no ${g.platform} destination: server-side delivery to ${g.platform} won't happen.`,
    }[g.code]!;
    const field = g.code === "no_platforms" ? "send_to" : g.code === "no_route" ? "tag_or_destination" : "destination";
    return { platform: g.platform, field, impact, where: g.hint };
  });
}

/** The missing[] field that turns server-side delivery on for each platform setup can configure. */
const SERVER_CREDENTIAL: Record<string, string> = {
  ga4: "api_secret",
  meta: "access_token",
  tiktok: "access_token",
  google_ads: "server",
  analytics: "api_key",
};

/**
 * missing[] with the delivery gaps added, except a platform's "no destination" gap when missing
 * already asks for that platform's server credential (the same gap, said once).
 */
export function withGaps(missing: Missing[], gaps: Missing[]): Missing[] {
  const covered = (g: Missing) =>
    g.field === "destination" && missing.some((m) => m.platform === g.platform && m.field === SERVER_CREDENTIAL[g.platform]);
  return [...missing, ...gaps.filter((g) => !covered(g))];
}

export function recipeNextSteps(
  containerId: string,
  validation: ValidationResult,
  missing: Missing[],
  published: boolean,
  gaps: Missing[] = [],
) {
  const steps: string[] = [];
  if (!validation.valid)
    steps.push(`Fix the ${validation.errors.length} validation error(s) (validation.errors) with patch_draft, then validate_draft.`);
  if (validation.valid && gaps.length)
    steps.push(
      `Not ready: some conversions won't reach a platform they target (missing[] lists each gap and the credential or destination that closes it). The draft is valid and would publish; close the gaps first, or set server: false / drop that platform from send_to if that's intended.`,
    );
  if (missing.length)
    steps.push(
      `Collect what missing[] lists (${missing.length} item(s), each with where to find it) and run setup_conversion_tracking again (it merges).`,
    );
  steps.push(`test_destination for each created destination (Meta/TikTok need a test_event_code).`);
  steps.push(
    `create_preview, open the preview_url, trigger each conversion, then get_event_log to see it arrive with per-destination results.`,
  );
  if (!published) steps.push(`publish (POST /v1/containers/${containerId}/publish) when the preview looks right.`);
  return steps;
}
