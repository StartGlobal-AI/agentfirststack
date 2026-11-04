import { compileRegex } from "../lib/conditions";
import { DEFAULT_TAG_CONSENT } from "../lib/consent";
import {
  BUILTIN_VARIABLES,
  type ContainerConfig,
  type Conversion,
  containerConfigSchema,
  SEND_TO_PLATFORMS,
  type SendToPlatform,
  type Tag,
} from "./schema";

export interface Issue {
  path: string;
  code: string;
  message: string;
  hint: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  summary: {
    variables: number;
    triggers: number;
    tags: number;
    conversions: number;
    server_conversions: number;
    platforms: string[];
  };
}

export interface ValidationContext {
  /** Server-side destinations configured on the container (with their circuit breaker state). */
  destinations?: {
    id: string;
    type: string;
    enabled: boolean;
    settings?: { all_events?: boolean };
    circuit_open_until?: number | null;
    consecutive_failures?: number;
  }[];
  domain?: string;
  /** The container's extra allowed hostnames (cross_domain hosts must be among them or on the domain). */
  allowed_hostnames?: string[];
  /** Whether the config's custom code may be published here (src/service/verify.ts); an issue blocks publish. */
  customCode?: (config: ContainerConfig) => Issue | null;
  now?: number;
}

/** Client tag type that fires each send_to platform in the browser. */
export const PLATFORM_TAG: Record<SendToPlatform, Tag["type"]> = {
  ga4: "ga4",
  google_ads: "google_ads",
  meta: "meta_pixel",
  tiktok: "tiktok_pixel",
  linkedin: "linkedin_insight",
  microsoft_uet: "microsoft_uet",
  reddit: "reddit_pixel",
  x: "x_pixel",
  pinterest: "pinterest_tag",
  snap: "snap_pixel",
  analytics: "analytics",
};

/** send_to platforms with a server-side destination connector. */
export const SERVER_PLATFORMS = [
  "ga4",
  "google_ads",
  "meta",
  "tiktok",
  "linkedin",
  "pinterest",
  "reddit",
  "snap",
  "x",
  "analytics",
] as const;

const VALUE_EXPECTED = /purchase|order|checkout|payment|subscri|sale|revenue|transaction|book|deposit/i;
const PLACEHOLDER = /^(G-X+|AW-X+|AW-0+|X+|123)$/i;
const AD_TAGS = new Set([
  "google_ads",
  "meta_pixel",
  "tiktok_pixel",
  "linkedin_insight",
  "microsoft_uet",
  "reddit_pixel",
  "x_pixel",
  "pinterest_tag",
  "snap_pixel",
  "image_pixel",
]);
/** Element built-ins (for matches_css_selector). */
const ELEMENT_VARS = new Set(["click_element", "form_element", "event_element"]);
/** Tag types that belong on a consent_init trigger (a consent platform's loader). */
const CMP_TAGS = new Set(["custom_html", "custom_js", "image_pixel"]);

const toMs = (v: number | string | undefined) => (v === undefined ? undefined : typeof v === "number" ? v : Date.parse(v));

/**
 * Variables a variable reads (lookup/regex_table input, url source, param_set templates). The
 * other places a config names a variable, all counted for unused_variable: trigger conditions,
 * tags[].params templates and event_params_from / config_params_from, conversion value, currency,
 * transaction_id, items and user_data, and conversions[].params templates.
 */
function variableRefs(v: NonNullable<ContainerConfig["variables"]>[number]): string[] {
  const out = new Set<string>();
  if (v.type === "lookup" || v.type === "regex_table") out.add(v.input);
  if (v.type === "url" && v.source) out.add(v.source);
  if (v.type === "param_set") templateRefs(v.params, out);
  return [...out];
}

function zodHint(path: string): string {
  if (path.startsWith("tags"))
    return "Each tag needs id, type, params and triggers. GET /v1/schema -> catalog.tags.<type>.example shows a valid one.";
  if (path.startsWith("triggers")) return "GET /v1/schema -> catalog.triggers shows each trigger type with an example.";
  if (path.startsWith("variables")) return "GET /v1/schema -> catalog.variables shows each variable type with an example.";
  if (path.startsWith("conversions")) return "GET /v1/schema -> catalog.conversions.example shows a complete conversion.";
  if (path.startsWith("consent")) return "GET /v1/schema -> catalog.consent shows the consent block.";
  return "GET /v1/schema returns the JSON Schema and examples.";
}

/** Structural (zod) errors only. Used by PUT/PATCH, which reject configs that don't parse. */
export function parseConfig(raw: unknown): { ok: true; config: ContainerConfig } | { ok: false; errors: Issue[] } {
  const r = containerConfigSchema.safeParse(raw);
  if (r.success) return { ok: true, config: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => {
      const path = i.path.join(".");
      return { path, code: "invalid", message: i.message, hint: zodHint(path) };
    }),
  };
}

function templateRefs(v: unknown, out: Set<string>) {
  if (typeof v === "string") {
    const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v))) out.add(m[1]!);
  } else if (v && typeof v === "object") for (const x of Object.values(v)) templateRefs(x, out);
}

/** Full validation: structure, references, platform readiness, consent and server delivery. */
export function validateConfig(raw: unknown, ctx: ValidationContext = {}): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, code: string, message: string, hint: string) => errors.push({ path, code, message, hint });
  const warn = (path: string, code: string, message: string, hint: string) => warnings.push({ path, code, message, hint });

  const parsed = parseConfig(raw);
  const emptySummary = { variables: 0, triggers: 0, tags: 0, conversions: 0, server_conversions: 0, platforms: [] };
  if (!parsed.ok) return { valid: false, errors: parsed.errors, warnings, summary: emptySummary };
  const cfg = parsed.config;
  const variables = cfg.variables ?? [];
  const triggers = cfg.triggers ?? [];
  const tags = cfg.tags ?? [];
  const conversions = cfg.conversions ?? [];
  const consent = cfg.consent ?? {};
  const destinations = (ctx.destinations ?? []).filter((d) => d.enabled);
  const destTypes = new Set(destinations.map((d) => d.type));

  // ---- uniqueness
  const dup = (items: { key: string; path: string }[], what: string) => {
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.key)) err(it.path, "duplicate", `Duplicate ${what} "${it.key}".`, `${what} ids must be unique; rename one.`);
      seen.add(it.key);
    }
  };
  dup(
    variables.map((v, i) => ({ key: v.name, path: `variables.${i}.name` })),
    "variable",
  );
  dup(
    triggers.map((t, i) => ({ key: t.id, path: `triggers.${i}.id` })),
    "trigger",
  );
  dup(
    tags.map((t, i) => ({ key: t.id, path: `tags.${i}.id` })),
    "tag",
  );
  dup(
    conversions.map((c, i) => ({ key: c.name, path: `conversions.${i}.name` })),
    "conversion",
  );

  const varNames = new Set(variables.map((v) => v.name));
  for (const [i, v] of variables.entries()) {
    if (v.name in BUILTIN_VARIABLES && v.type !== v.name) {
      warn(
        `variables.${i}.name`,
        "shadows_builtin",
        `Variable "${v.name}" shadows the built-in of the same name.`,
        "Rename it unless that's intended.",
      );
    }
  }
  const isVar = (n: string) => varNames.has(n) || n in BUILTIN_VARIABLES;
  const triggerIds = new Set(triggers.map((t) => t.id));
  const usedTriggers = new Set<string>();
  const usedVars = new Set<string>();
  const varByName = new Map(variables.map((v) => [v.name, v]));

  // ---- variables: references, regexes, cycles
  for (const [i, v] of variables.entries()) {
    for (const r of variableRefs(v)) {
      usedVars.add(r);
      if (!isVar(r))
        err(
          `variables.${i}`,
          "undefined_variable",
          `Variable "${v.name}" reads undefined variable "${r}".`,
          `Define "${r}" in variables[] or use a built-in (page_path, click_url, referrer...).`,
        );
    }
    if (v.type === "regex_table")
      for (const [j, row] of v.rows.entries())
        if (!compileRegex(v.full_match === false ? row.pattern : `^(?:${row.pattern})$`, v.ignore_case))
          err(
            `variables.${i}.rows.${j}.pattern`,
            "invalid_regex",
            `"${row.pattern}" is not a valid regular expression.`,
            "Use JavaScript regex syntax without slashes, e.g. ^/blog/(.*).",
          );
    if (v.type === "url" && v.component === "param" && !v.param)
      err(
        `variables.${i}.param`,
        "missing_param",
        `Variable "${v.name}" reads a query parameter but doesn't say which.`,
        'Add "param": "<name>".',
      );
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (n: string): boolean => {
    if (done.has(n)) return false;
    if (visiting.has(n)) return true;
    visiting.add(n);
    const v = varByName.get(n);
    const hit = !!v && variableRefs(v).some(cyclic);
    visiting.delete(n);
    done.add(n);
    return hit;
  };
  for (const [i, v] of variables.entries()) {
    done.clear();
    visiting.clear();
    if (variableRefs(v).some((r) => r === v.name || cyclic(r)))
      err(
        `variables.${i}`,
        "variable_cycle",
        `Variable "${v.name}" depends on itself (through lookup/regex_table input, url source or param_set templates).`,
        "Break the cycle: point the input at a source variable (data_layer, url_param, a built-in...).",
      );
  }

  // ---- triggers
  for (const [i, t] of triggers.entries()) {
    for (const [j, c] of (t.conditions ?? []).entries()) {
      usedVars.add(c.var);
      if (!isVar(c.var)) {
        err(
          `triggers.${i}.conditions.${j}.var`,
          "undefined_variable",
          `Trigger "${t.id}" uses undefined variable "${c.var}".`,
          `Define it in variables[] or use a built-in: ${Object.keys(BUILTIN_VARIABLES).join(", ")}.`,
        );
      }
      if ((c.op === "matches_regex" || c.op === "not_matches_regex") && !compileRegex(String(c.value), c.ignore_case)) {
        err(
          `triggers.${i}.conditions.${j}.value`,
          "invalid_regex",
          `"${c.value}" is not a valid regular expression.`,
          "Use JavaScript regex syntax without slashes, e.g. ^/thank-?you.",
        );
      }
      if ((c.op === "matches_css_selector" || c.op === "not_matches_css_selector") && !ELEMENT_VARS.has(c.var) && !varNames.has(c.var))
        warn(
          `triggers.${i}.conditions.${j}.var`,
          "css_selector_needs_element",
          `matches_css_selector compares an element, but "${c.var}" is a text value.`,
          'Use "var": "click_element", "form_element" or "event_element".',
        );
      if (["lt", "lte", "gt", "gte"].includes(c.op) && !Number.isFinite(Number(c.value)))
        err(
          `triggers.${i}.conditions.${j}.value`,
          "not_a_number",
          `${c.op} needs a number, not "${c.value}".`,
          'e.g. { "op": "gt", "value": 100 }.',
        );
    }
    if (t.type === "custom_event") {
      if ((t.event === undefined) === (t.event_regex === undefined))
        err(
          `triggers.${i}`,
          "custom_event_name",
          `Custom event trigger "${t.id}" needs exactly one of event or event_regex.`,
          'e.g. "event": "purchase", or "event_regex": "^(purchase|refund)$".',
        );
      if (t.event_regex && !compileRegex(t.event_regex, t.ignore_case))
        err(
          `triggers.${i}.event_regex`,
          "invalid_regex",
          `"${t.event_regex}" is not a valid regular expression.`,
          "Use JavaScript regex syntax.",
        );
      if (t.event && /^gtm\./.test(t.event)) {
        warn(
          `triggers.${i}.event`,
          "gtm_internal_event",
          `"${t.event}" is a GTM-internal event; this runtime doesn't emit gtm.* events.`,
          "Use page_view, dom_ready, window_loaded or a custom dataLayer event instead.",
        );
      }
    }
    if (t.type === "scroll_depth" && !t.percentages && !t.pixels)
      err(
        `triggers.${i}`,
        "scroll_thresholds",
        `Scroll trigger "${t.id}" has no thresholds.`,
        'Add "percentages": [50, 90] and/or "pixels": [1000].',
      );
    if (t.type === "trigger_group") {
      for (const [j, m] of t.triggers.entries()) {
        usedTriggers.add(m);
        const member = triggers.find((x) => x.id === m);
        if (!member)
          err(
            `triggers.${i}.triggers.${j}`,
            "undefined_trigger",
            `Trigger group "${t.id}" includes undefined trigger "${m}".`,
            "Define it or remove it.",
          );
        else if (member.type === "trigger_group")
          err(
            `triggers.${i}.triggers.${j}`,
            "nested_trigger_group",
            `Trigger group "${t.id}" includes another group ("${m}").`,
            "List that group's triggers instead.",
          );
      }
    }
    if ((t.type === "click" || t.type === "form_submit") && t.wait_for_tags_ms && t.type === "click" && !t.links_only)
      warn(
        `triggers.${i}.wait_for_tags_ms`,
        "wait_for_tags_links",
        `wait_for_tags_ms on click trigger "${t.id}" only holds clicks on links (<a href>).`,
        'Add "links_only": true to make that explicit, or remove wait_for_tags_ms.',
      );
  }

  // ---- tags
  const tagTypes = new Set<string>();
  for (const [i, tag] of tags.entries()) {
    if (tag.enabled !== false) tagTypes.add(tag.type);
    for (const [j, tid] of tag.triggers.entries()) {
      usedTriggers.add(tid);
      if (!triggerIds.has(tid))
        err(
          `tags.${i}.triggers.${j}`,
          "undefined_trigger",
          `Tag "${tag.id}" references trigger "${tid}", which isn't defined.`,
          `Add { "id": "${tid}", "type": "page_view" } (or another type) to triggers[].`,
        );
    }
    for (const [j, tid] of (tag.exclude_triggers ?? []).entries()) {
      usedTriggers.add(tid);
      if (!triggerIds.has(tid))
        err(
          `tags.${i}.exclude_triggers.${j}`,
          "undefined_trigger",
          `Tag "${tag.id}" excludes undefined trigger "${tid}".`,
          "Define it in triggers[] or remove it.",
        );
    }
    const refs = new Set<string>();
    templateRefs(tag.params, refs);
    for (const r of refs) {
      usedVars.add(r);
      if (!isVar(r))
        warn(
          `tags.${i}.params`,
          "undefined_variable",
          `Tag "${tag.id}" uses {{${r}}}, which isn't a defined variable.`,
          "Define it in variables[]; undefined templates render as empty strings.",
        );
    }
    const p = tag.params as Record<string, unknown>;
    for (const key of ["measurement_id", "conversion_id", "pixel_id", "partner_id", "tag_id", "site_id"]) {
      const v = p[key];
      if (
        typeof v === "string" &&
        (PLACEHOLDER.test(v) || /x{4,}|your|placeholder|todo/i.test(v) || /^(?:[A-Z]{1,2}-)?(\d)\1{5,}$/.test(v))
      ) {
        err(
          `tags.${i}.params.${key}`,
          "placeholder_id",
          `Tag "${tag.id}" has a placeholder ${key} "${v}".`,
          `Replace it with the real ${key}. Don't know it? POST /v1/containers/:id/scan may find it on the site.`,
        );
      }
    }
    const tp = tag.params as { event_params_from?: string; config_params_from?: string };
    for (const k of ["event_params_from", "config_params_from"] as const) {
      const ref = tp[k];
      if (!ref) continue;
      usedVars.add(ref);
      if (varByName.get(ref)?.type !== "param_set")
        err(
          `tags.${i}.params.${k}`,
          "not_a_param_set",
          `Tag "${tag.id}" ${k} "${ref}" isn't a param_set variable.`,
          `Define { "name": "${ref}", "type": "param_set", "params": {...} } in variables[].`,
        );
    }
    if (tag.after) {
      if (tag.after.tag === tag.id || !tags.some((x) => x.id === tag.after!.tag))
        err(
          `tags.${i}.after.tag`,
          "undefined_tag",
          `Tag "${tag.id}" waits for setup tag "${tag.after.tag}", which ${tag.after.tag === tag.id ? "is itself" : "isn't defined"}.`,
          "Point after.tag at another tag's id.",
        );
      else {
        const seen = new Set([tag.id]);
        let cur = tags.find((x) => x.id === tag.after!.tag);
        while (cur?.after && !seen.has(cur.id)) {
          seen.add(cur.id);
          cur = tags.find((x) => x.id === cur!.after!.tag);
        }
        if (cur && seen.has(cur.id))
          err(
            `tags.${i}.after`,
            "sequence_cycle",
            `Tag sequencing from "${tag.id}" loops back on itself.`,
            "Remove one of the after links.",
          );
      }
    }
    if (tag.schedule) {
      const start = toMs(tag.schedule.start);
      const end = toMs(tag.schedule.end);
      if (start !== undefined && end !== undefined && end <= start)
        err(`tags.${i}.schedule`, "schedule_invalid", `Tag "${tag.id}" ends before it starts.`, "Set end after start.");
      else if (end !== undefined && end < (ctx.now ?? Date.now()))
        warn(
          `tags.${i}.schedule.end`,
          "schedule_expired",
          `Tag "${tag.id}"'s schedule ended ${new Date(end).toISOString()}; it never fires.`,
          "Move the end date, or remove the tag.",
        );
    }
    if (!CMP_TAGS.has(tag.type) && tag.triggers.some((id) => triggers.find((x) => x.id === id)?.type === "consent_init"))
      warn(
        `tags.${i}.triggers`,
        "consent_init_non_cmp",
        `Tag "${tag.id}" (${tag.type}) fires on consent_init, which is meant for consent platform loaders.`,
        "Use page_view or init for measurement tags; consent_init runs before consent is known.",
      );
    if (consent.mode === "opt_in" && tag.consent && tag.consent.length === 0 && AD_TAGS.has(tag.type)) {
      warn(
        `tags.${i}.consent`,
        "consent_gap",
        `Ad tag "${tag.id}" has consent: [] so it fires before the visitor opts in.`,
        'Remove "consent" to use the default (ad_storage) or list the required types.',
      );
    }
  }

  // ---- conversions
  let serverConversions = 0;
  const platforms = new Set<string>();
  for (const [i, c] of conversions.entries()) {
    const at = `conversions.${i}`;
    usedTriggers.add(c.trigger);
    if (!triggerIds.has(c.trigger)) {
      err(
        `${at}.trigger`,
        "undefined_trigger",
        `Conversion "${c.name}" uses trigger "${c.trigger}", which isn't defined.`,
        `Add a trigger with id "${c.trigger}" (e.g. a page_view with a page_path condition, a form_submit, or a custom_event).`,
      );
    }
    const refs: [string, string | undefined][] = [
      ["value", typeof c.value === "string" ? c.value : undefined],
      ["currency.var", typeof c.currency === "object" ? c.currency.var : undefined],
      ["transaction_id", c.transaction_id],
      ["items", c.items],
      ...Object.entries(c.user_data && c.user_data !== "auto" ? c.user_data : {}).map(
        ([k, v]) => [`user_data.${k}`, v] as [string, string],
      ),
    ];
    for (const [k, v] of refs) {
      if (!v) continue;
      usedVars.add(v);
      if (!isVar(v))
        err(
          `${at}.${k}`,
          "undefined_variable",
          `Conversion "${c.name}" ${k} refers to undefined variable "${v}".`,
          `Define it in variables[], e.g. { "name": "${v}", "type": "data_layer", "key": "ecommerce.${k === "value" ? "value" : k}" }.`,
        );
    }
    // conversions[].params: strings may use {{variable}} templates (resolved in the browser when it fires).
    const paramRefs = new Set<string>();
    templateRefs(c.params, paramRefs);
    for (const r of paramRefs) {
      usedVars.add(r);
      if (!isVar(r))
        warn(
          `${at}.params`,
          "undefined_variable",
          `Conversion "${c.name}" params use {{${r}}}, which isn't a defined variable.`,
          "Define it in variables[]; undefined templates render as empty strings.",
        );
    }
    // send_to.ga4.params and send_to.meta.custom_data are sent as written (by the pixel and by the
    // server): a template there stays literal text. It still names the variable, so it's not "unused".
    for (const [where, fixed] of [
      ["send_to.ga4.params", c.send_to.ga4?.params],
      ["send_to.meta.custom_data", c.send_to.meta?.custom_data],
    ] as const) {
      const fixedRefs = new Set<string>();
      templateRefs(fixed, fixedRefs);
      for (const r of fixedRefs) usedVars.add(r);
      if (fixedRefs.size)
        warn(
          `${at}.${where}`,
          "template_not_rendered",
          `Conversion "${c.name}" ${where} has {{${[...fixedRefs].join("}}, {{")}}}, but templates aren't rendered there: the text is sent as written.`,
          `Move page values to conversions[].params (templates are rendered there and sent to every platform), or use fixed values in ${where}.`,
        );
    }
    const sendTo = Object.keys(c.send_to) as SendToPlatform[];
    if (sendTo.length === 0) {
      const catchAll = destinations.some((d) => d.type === "webhook" || d.type === "analytics");
      if (!(c.server && catchAll))
        warn(
          `${at}.send_to`,
          "no_platforms",
          `Conversion "${c.name}" has an empty send_to, so no pixel fires it${c.server ? " and no destination receives it" : ""}.`,
          'Add platforms, e.g. "send_to": { "ga4": { "event_name": "purchase" } } (webhook/analytics destinations receive every server: true conversion).',
        );
    }
    for (const p of sendTo) platforms.add(p);

    const expectsValue =
      VALUE_EXPECTED.test(c.name) ||
      (c.send_to.meta && /Purchase|Subscribe|StartTrial/.test(c.send_to.meta.event_name)) ||
      c.send_to.tiktok?.event_name === "CompletePayment";
    if (c.value === undefined && expectsValue) {
      warn(
        `${at}.value`,
        "missing_value",
        `Conversion "${c.name}" has no value.`,
        'Set "value" to a variable (e.g. a data_layer ecommerce.value) or a number so bidding can optimise for revenue.',
      );
    }
    if (c.value !== undefined && !c.currency) {
      warn(
        `${at}.currency`,
        "missing_currency",
        `Conversion "${c.name}" has a value but no currency.`,
        'Add "currency": "USD" (or { "var": "currency" }). GA4, Meta and Google Ads ignore or reject values without a currency.',
      );
    }
    if (c.send_to.meta?.event_name === "Purchase" && (c.value === undefined || !c.currency)) {
      err(
        `${at}.send_to.meta`,
        "meta_purchase_requires_value",
        `Meta requires value and currency for Purchase ("${c.name}").`,
        'Set "value" and "currency" on the conversion.',
      );
    }
    if (c.user_data && (c.user_data === "auto" || c.user_data.phone) && !cfg.settings?.phone_country_code) {
      warn(
        `${at}.user_data.phone`,
        "phone_country_code",
        "Phones without a +country code will be dropped (they can't be normalised to E.164).",
        'Set settings.phone_country_code, e.g. "1" for the US.',
      );
    }

    for (const p of sendTo) {
      const tagType = PLATFORM_TAG[p];
      const hasTag = tagType ? tagTypes.has(tagType) : false;
      const isServerPlatform = (SERVER_PLATFORMS as readonly string[]).includes(p);
      const hasDest = destTypes.has(p);
      if (!hasTag && !(c.server && isServerPlatform && hasDest)) {
        const fix = isServerPlatform
          ? `Add a ${tagType} tag (browser) and/or a ${p} destination with server: true (POST /v1/containers/:id/destinations).`
          : `Add a ${tagType} tag (this platform is browser-only for now).`;
        warn(`${at}.send_to.${p}`, "no_route", `Conversion "${c.name}" targets ${p}, but nothing will deliver it.`, fix);
      }
      if (c.server && isServerPlatform && !hasDest) {
        warn(
          `${at}.server`,
          "server_without_destination",
          `Conversion "${c.name}" has server: true and targets ${p}, but there's no enabled ${p} destination.`,
          `POST /v1/containers/:id/destinations { "type": "${p}", "credentials": {...} } (see GET /v1/schema -> destinations.${p}).`,
        );
      }
      if (!c.server && isServerPlatform && hasDest && p !== "analytics") {
        warn(
          `${at}.server`,
          "destination_unused",
          `A ${p} destination exists but conversion "${c.name}" has server: false, so it is only sent from the browser.`,
          'Set "server": true to also deliver it server-side (deduplicated by event_id).',
        );
      }
    }
    if (c.send_to.google_ads?.send_to && c.server && destTypes.has("google_ads")) {
      warn(
        `${at}.send_to.google_ads`,
        "google_ads_double_count",
        `Conversion "${c.name}" fires a Google Ads tag conversion AND uploads server-side.`,
        "Google Ads counts them separately (different conversion actions). Keep only one as a primary conversion action in Google Ads, or drop one side.",
      );
    }
    if (c.send_to.google_ads && !c.send_to.google_ads.send_to && !c.server) {
      warn(
        `${at}.send_to.google_ads`,
        "google_ads_no_label",
        `Conversion "${c.name}" targets google_ads without send_to (AW-id/label) and without server delivery.`,
        'Add "send_to": "AW-123456789/AbCdEf" (Google Ads > Goals > Conversions > tag setup) or set server: true with a google_ads destination.',
      );
    }
    if (c.server) serverConversions++;
    if (c.server && destinations.length === 0) {
      warn(
        `${at}.server`,
        "no_destinations",
        `Conversion "${c.name}" has server: true but the container has no destinations.`,
        "Add one with POST /v1/containers/:id/destinations, or set server: false.",
      );
    }
    checkConversionTriggerFit(c, triggers, at, warn);
  }

  for (const [i, t] of triggers.entries()) {
    if (!usedTriggers.has(t.id))
      warn(
        `triggers.${i}`,
        "unused_trigger",
        `Trigger "${t.id}" isn't used by any tag or conversion.`,
        "Reference it from tags[].triggers or conversions[].trigger, or remove it.",
      );
  }
  for (const [i, v] of variables.entries()) {
    if (!usedVars.has(v.name))
      warn(
        `variables.${i}`,
        "unused_variable",
        `Variable "${v.name}" isn't referenced.`,
        "Use it in a condition, conversion or {{template}}, or remove it.",
      );
  }

  // ---- consent
  const hasAdTags = tags.some((t) => AD_TAGS.has(t.type) && t.enabled !== false);
  const hasAdServer = conversions.some((c) => c.server && (c.send_to.meta || c.send_to.tiktok || c.send_to.google_ads));
  const mode = consent.mode ?? "none";
  if ((hasAdTags || hasAdServer) && mode === "none" && !consent.regions) {
    warn(
      "consent",
      "consent_not_configured",
      "Ad pixels/conversion APIs run without any consent configuration.",
      'Visitors in the EEA/UK need opt-in consent. Add "consent": { "mode": "none", "regions": { "EEA": { "ad_storage": "denied", "ad_user_data": "denied", "ad_personalization": "denied", "analytics_storage": "denied" }, "GB": {...same} } } and have your banner call afst("consent", "update", {...}).',
    );
  }
  if (mode === "opt_in" || Object.values(consent.regions ?? {}).some((s) => Object.values(s).includes("denied"))) {
    warn(
      "consent",
      "consent_needs_banner",
      "Some visitors start with consent denied; tags needing it wait until consent is granted.",
      'Your consent banner must call afst("consent", "update", { ad_storage: "granted", analytics_storage: "granted", ... }) (or gtag("consent", "update", ...) from a CMP). Blocked tags fire once granted.',
    );
  }
  if (consent.regions?.EEA && !consent.regions.GB) {
    warn(
      "consent.regions",
      "consent_uk",
      "EEA is configured but the UK (GB) isn't; UK GDPR has the same opt-in requirement.",
      'Add a "GB" region with the same values (and "CH" if relevant).',
    );
  }
  for (const [i, tag] of tags.entries()) {
    const required = tag.consent ?? DEFAULT_TAG_CONSENT[tag.type] ?? [];
    if (consent.default && required.some((r) => consent.default?.[r] === "denied") && mode === "none" && !consent.regions) {
      warn(
        `tags.${i}.consent`,
        "never_fires_without_update",
        `Tag "${tag.id}" needs ${required.join(", ")} which defaults to denied.`,
        "It only fires after the site grants consent.",
      );
    }
  }
  if (consent.google_consent_mode === "advanced" && !tags.some((t) => t.type === "ga4" || t.type === "google_ads")) {
    warn(
      "consent.google_consent_mode",
      "no_google_tags",
      "google_consent_mode is set but there are no ga4/google_ads tags.",
      "Remove it or add Google tags.",
    );
  }

  // ---- cross-domain hosts must be allowed to send hits
  for (const [j, h] of (cfg.settings?.cross_domain ?? []).entries()) {
    const host = h.replace(/^\*\./, "");
    const d = ctx.domain;
    const onDomain = !!d && (host === d || host.endsWith(`.${d}`));
    const listed = (ctx.allowed_hostnames ?? []).some((a) => a === h || a === host || (a.startsWith("*.") && host.endsWith(a.slice(1))));
    if (ctx.domain !== undefined && !onDomain && !listed)
      warn(
        `settings.cross_domain.${j}`,
        "cross_domain_not_allowed",
        `${h} is a cross-domain host, but hits from it aren't accepted by this container.`,
        `PATCH /v1/containers/:id { "allowed_hostnames": [..., "${h}"] } and install the snippet there too.`,
      );
  }

  // ---- custom code: account standing, domain verification, size
  const custom = ctx.customCode?.(cfg);
  if (custom) err(custom.path, custom.code, custom.message, custom.hint);

  // ---- destinations whose circuit breaker is open (deliveries are skipped)
  const now = ctx.now ?? Date.now();
  for (const d of destinations) {
    if (d.circuit_open_until && d.circuit_open_until > now)
      warn(
        "destinations",
        "destination_circuit_open",
        `Destination ${d.id} (${d.type}) failed ${d.consecutive_failures ?? "many"} times in a row; deliveries are skipped until ${new Date(d.circuit_open_until).toISOString()}.`,
        `Read its last errors in GET /v1/containers/:id/events, fix the credentials or URL (PATCH the destination), then POST /v1/containers/:id/destinations/${d.id}/test: a passing test closes the circuit.`,
      );
  }

  // ---- destinations with nothing to send
  for (const d of destinations) {
    if (d.type === "webhook" || d.type === "analytics") {
      if (serverConversions === 0)
        warn(
          "destinations",
          "destination_idle",
          `Destination ${d.id} (${d.type}) receives server conversions, but none have server: true.`,
          d.type === "webhook"
            ? "Set server: true on the conversions it should receive (backend events reach it when their name matches a conversion, or every one with settings.all_events: true)."
            : "Set server: true on the conversions it should receive (server events from POST /v1/containers/:id/events also reach it).",
        );
      continue;
    }
    if (!conversions.some((c) => c.server && (c.send_to as Record<string, unknown>)[d.type])) {
      warn(
        "destinations",
        "destination_idle",
        `Destination ${d.id} (${d.type}) won't receive anything: no conversion has server: true and send_to.${d.type}.`,
        `Add send_to.${d.type} and server: true to the conversions it should get.`,
      );
    }
  }
  if (tags.length === 0 && conversions.length === 0) {
    warn(
      "",
      "empty_config",
      "The config has no tags or conversions.",
      "Start with setup_conversion_tracking (MCP) or PUT a draft; GET /v1/schema has examples.",
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      variables: variables.length,
      triggers: triggers.length,
      tags: tags.length,
      conversions: conversions.length,
      server_conversions: serverConversions,
      platforms: [...platforms].filter((p) => (SEND_TO_PLATFORMS as readonly string[]).includes(p)).sort(),
    },
  };
}

function checkConversionTriggerFit(
  c: Conversion,
  triggers: ContainerConfig["triggers"] & {},
  at: string,
  warn: (p: string, c: string, m: string, h: string) => void,
) {
  const t = triggers.find((x) => x.id === c.trigger);
  if (!t) return;
  if (t.type === "page_view" && !(t.conditions && t.conditions.length)) {
    warn(
      `${at}.trigger`,
      "conversion_on_every_page",
      `Conversion "${c.name}" fires on every page view (trigger "${t.id}" has no conditions).`,
      'Add a condition, e.g. { "var": "page_path", "op": "starts_with", "value": "/thank-you" }.',
    );
  }
  if (c.user_data === "auto" && t.type !== "form_submit")
    warn(
      `${at}.user_data`,
      "auto_user_data_page",
      `Conversion "${c.name}" detects user data automatically but its trigger isn't a form submit, so the whole page is searched.`,
      "Fine on a page with one form; otherwise map variables explicitly (user_data: { email: <dom_value variable> }).",
    );
  if (t.type === "form_submit" && c.user_data !== "auto" && c.user_data?.email === undefined) {
    // Fine, but lead forms usually carry an email worth hashing.
    warn(
      `${at}.user_data`,
      "lead_without_email",
      `Lead conversion "${c.name}" doesn't map an email.`,
      'Map one for better match rates: add a dom_value variable (selector "input[type=email]") and "user_data": { "email": "<that variable>" }.',
    );
  }
}
