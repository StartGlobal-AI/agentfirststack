import { z } from "zod";
import { CONSENT_TYPES } from "../lib/consent";
import type { ItemKind } from "./diff";
import {
  BUILTIN_VARIABLES,
  type ContainerConfig,
  type Tag,
  tagSchema,
  type Trigger,
  triggerSchema,
  URL_COMPONENTS,
  type Variable,
  variableSchema,
} from "./schema";

/**
 * GTM container export (Admin > Export container, exportFormatVersion 2, or the Tag Manager API's
 * containerVersion) -> this platform's config. Pure. Every GTM tag, trigger and variable ends up
 * in exactly one list of the report: mapped (same behaviour), adapted (works, with a difference
 * the note explains) or unmapped (left out, with the reason and what to do instead). Nothing is
 * dropped silently. The export is untrusted input: its shape is validated, its size and depth are
 * bounded, and every produced item is validated with this platform's own schema; custom HTML and
 * custom JavaScript become custom_html / custom_js (variables), which publish only through the
 * custom-code gate (verified domain, claimed account).
 */

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;
const MAX_DEPTH = 24;

// ------------------------------------------------------------------ the export's shape (lenient)

type Param = { type?: string; key?: string; value?: string; list?: Param[]; map?: Param[] };
const param: z.ZodType<Param> = z.lazy(() =>
  z.object({
    type: z.string().max(40).optional(),
    key: z.string().max(200).optional(),
    value: z.string().max(200_000).optional(),
    list: z.array(param).max(2000).optional(),
    map: z.array(param).max(500).optional(),
  }),
);
const ids = z.array(z.string().max(40)).max(100).optional();
const gtmTag = z.object({
  tagId: z.string().max(40).optional(),
  name: z.string().max(500),
  type: z.string().max(200),
  parameter: z.array(param).max(500).optional(),
  firingTriggerId: ids,
  blockingTriggerId: ids,
  tagFiringOption: z.string().max(40).optional(),
  paused: z.boolean().optional(),
  priority: param.optional(),
  scheduleStartMs: z.union([z.string().max(20), z.number()]).optional(),
  scheduleEndMs: z.union([z.string().max(20), z.number()]).optional(),
  liveOnly: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
  consentSettings: z.object({ consentStatus: z.string().max(40).optional(), consentType: param.optional() }).optional(),
  setupTag: z
    .array(z.object({ tagName: z.string().max(500), stopOnSetupFailure: z.boolean().optional() }))
    .max(10)
    .optional(),
  teardownTag: z
    .array(z.object({ tagName: z.string().max(500) }))
    .max(10)
    .optional(),
});
const gtmTrigger = z.object({
  triggerId: z.string().max(40).optional(),
  name: z.string().max(500),
  type: z.string().max(100),
  filter: z
    .array(z.object({ type: z.string().max(40), parameter: z.array(param).max(10).optional() }))
    .max(50)
    .optional(),
  customEventFilter: z
    .array(z.object({ type: z.string().max(40), parameter: z.array(param).max(10).optional() }))
    .max(10)
    .optional(),
  autoEventFilter: z
    .array(z.object({ type: z.string().max(40), parameter: z.array(param).max(10).optional() }))
    .max(50)
    .optional(),
  parameter: z.array(param).max(100).optional(),
  waitForTags: param.optional(),
  checkValidation: param.optional(),
  waitForTagsTimeout: param.optional(),
  interval: param.optional(),
  limit: param.optional(),
  notes: z.string().max(5000).optional(),
});
const gtmVariable = z.object({
  name: z.string().max(500),
  type: z.string().max(100),
  parameter: z.array(param).max(500).optional(),
  notes: z.string().max(5000).optional(),
  formatValue: z
    .object({
      caseConversionType: z.string().max(40).optional(),
      convertNullToValue: param.optional(),
      convertUndefinedToValue: param.optional(),
      convertTrueToValue: param.optional(),
      convertFalseToValue: param.optional(),
    })
    .optional(),
});
const gtmVersion = z.object({
  container: z.object({ publicId: z.string().max(40).optional(), usageContext: z.array(z.string().max(40)).max(10).optional() }).optional(),
  tag: z.array(gtmTag).max(2000).optional(),
  trigger: z.array(gtmTrigger).max(2000).optional(),
  variable: z.array(gtmVariable).max(2000).optional(),
  builtInVariable: z
    .array(z.object({ name: z.string().max(200).optional(), type: z.string().max(100).optional() }))
    .max(500)
    .optional(),
  folder: z
    .array(z.object({ name: z.string().max(500).optional() }))
    .max(1000)
    .optional(),
  customTemplate: z
    .array(
      z.object({
        templateId: z.string().max(40).optional(),
        name: z.string().max(500).optional(),
        galleryReference: z.object({ owner: z.string().max(200).optional(), repository: z.string().max(200).optional() }).optional(),
      }),
    )
    .max(500)
    .optional(),
  client: z
    .array(z.object({ name: z.string().max(500).optional() }))
    .max(500)
    .optional(),
  zone: z
    .array(z.object({ name: z.string().max(500).optional() }))
    .max(500)
    .optional(),
});
const gtmExport = z.union([z.object({ containerVersion: gtmVersion }), gtmVersion]);
type GtmVersion = z.infer<typeof gtmVersion>;
type GtmTag = z.infer<typeof gtmTag>;
type GtmTrigger = z.infer<typeof gtmTrigger>;
type GtmVariable = z.infer<typeof gtmVariable>;

// ------------------------------------------------------------------ report

export interface ImportItem {
  gtm: { kind: "tag" | "trigger" | "variable" | "built_in_variable" | "folder" | "client" | "zone"; name: string; type?: string };
  to?: { kind: ItemKind; key: string }[];
  note?: string;
  reason?: string;
  hint?: string;
}
export interface ImportReport {
  container?: string;
  mapped: ImportItem[];
  adapted: ImportItem[];
  unmapped: ImportItem[];
}

export class ImportShapeError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** Depth of a JSON value, without recursion (so a deeply nested body can't exhaust the stack). */
export function jsonDepth(v: unknown, limit = MAX_DEPTH + 1): number {
  let max = 0;
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (d > max) max = d;
    if (max > limit) return max;
    if (x && typeof x === "object") for (const c of Object.values(x as object)) if (c && typeof c === "object") stack.push([c, d + 1]);
  }
  return max;
}

// ------------------------------------------------------------------ helpers

const lc = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[_\s-]/g, "");
const p = (list: Param[] | undefined, key: string) => list?.find((x) => x.key === key);
const val = (list: Param[] | undefined, key: string) => p(list, key)?.value;
const bool = (list: Param[] | undefined, key: string) => val(list, key) === "true";
const rows = (list: Param[] | undefined, key: string) =>
  (p(list, key)?.list ?? []).map(
    (m) => Object.fromEntries((m.map ?? []).map((x) => [x.key ?? "", x.value ?? ""])) as Record<string, string>,
  );
const pv = (x: Param | undefined) => x?.value;

/** GTM built-in variable names -> this platform's built-ins. */
const GTM_BUILTINS: Record<string, string> = {
  "Page URL": "page_url",
  "Page Hostname": "page_hostname",
  "Page Path": "page_path",
  "Page Title": "page_title",
  Referrer: "referrer",
  Event: "event",
  _event: "event",
  "Click Element": "click_element",
  "Click Classes": "click_classes",
  "Click ID": "click_id",
  "Click Target": "click_target",
  "Click URL": "click_url",
  "Click Text": "click_text",
  "Form Element": "form_element",
  "Form Classes": "form_classes",
  "Form ID": "form_id",
  "Form Target": "form_target",
  "Form URL": "form_action",
  "Form Text": "form_text",
  "Error Message": "error_message",
  "Error URL": "error_url",
  "Error Line": "error_line",
  "Debug Mode": "debug_mode",
  "Container ID": "container_id",
  "Container Version": "container_version",
  "Environment Name": "environment",
  "Scroll Depth Threshold": "scroll_depth",
  "Scroll Depth Units": "scroll_units",
  "Scroll Direction": "scroll_direction",
  "Percent Visible": "percent_visible",
  "On-Screen Duration": "visible_ms",
  "History Source": "history_source",
  "New History URL": "history_new_url",
  "Old History URL": "history_old_url",
  "Video Provider": "video_provider",
  "Video Status": "video_status",
  "Video URL": "video_url",
  "Video Title": "video_title",
  "Video Duration": "video_duration",
  "Video Current Time": "video_current_time",
  "Video Percent": "video_percent",
  "Video Visible": "video_visible",
};
/** GTM's built-in trigger ids (they aren't in the export's trigger list). */
const BUILTIN_TRIGGERS: Record<string, Trigger> = {
  "2147479553": { id: "all_pages", type: "page_view", description: "GTM built-in: All Pages" },
  "2147479572": { id: "consent_init_all_pages", type: "consent_init", description: "GTM built-in: Consent Initialization - All Pages" },
  "2147479573": { id: "init_all_pages", type: "init", description: "GTM built-in: Initialization - All Pages" },
};

/** A GTM name as an id here: letters, digits and _ (start with a letter), unique. */
function idFor(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56);
  if (!/^[a-z]/.test(base)) base = `x_${base}`.replace(/_+$/, "");
  let id = base || "item";
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

const ID_PATTERNS: Record<string, RegExp> = {
  meta_pixel: /^\d{8,20}$/,
  tiktok_pixel: /^[A-Z0-9]{15,25}$/,
  linkedin_insight: /^\d{3,12}$/,
  microsoft_uet: /^\d{4,15}$/,
  reddit_pixel: /^(a2|t2)_[a-z0-9]{4,20}$/,
  x_pixel: /^[a-z0-9]{4,10}$/,
  pinterest_tag: /^\d{8,16}$/,
  snap_pixel: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};
const TEMPLATE_PLATFORMS: [RegExp, keyof typeof ID_PATTERNS | "replay"][] = [
  [/facebook|meta pixel|\bmeta\b/i, "meta_pixel"],
  [/tiktok/i, "tiktok_pixel"],
  [/linkedin/i, "linkedin_insight"],
  [/pinterest/i, "pinterest_tag"],
  [/reddit/i, "reddit_pixel"],
  [/snap/i, "snap_pixel"],
  [/twitter|\bx\b pixel|x ads/i, "x_pixel"],
  [/microsoft|bing|\buet\b/i, "microsoft_uet"],
  [/hotjar|clarity/i, "replay"],
];

// ------------------------------------------------------------------ the mapper

export function mapGtmExport(raw: unknown): { config: ContainerConfig; report: ImportReport } {
  if (jsonDepth(raw) > MAX_DEPTH) throw new ImportShapeError(`The export is nested deeper than ${MAX_DEPTH} levels.`);
  const parsed = gtmExport.safeParse(raw);
  if (!parsed.success)
    throw new ImportShapeError(
      "This doesn't look like a GTM container export.",
      parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  const cv: GtmVersion = "containerVersion" in parsed.data ? parsed.data.containerVersion : parsed.data;
  const report: ImportReport = { container: cv.container?.publicId, mapped: [], adapted: [], unmapped: [] };
  const out = { variables: [] as Variable[], triggers: [] as Trigger[], tags: [] as Tag[] };
  const taken = { variables: new Set(Object.keys(BUILTIN_VARIABLES)), triggers: new Set<string>(), tags: new Set<string>() };

  if ((cv.container?.usageContext ?? []).some((u) => u.toUpperCase() !== "WEB"))
    report.adapted.push({
      gtm: { kind: "zone", name: cv.container?.publicId ?? "container", type: cv.container?.usageContext?.join(",") },
      note: "Not a web container: only its web-compatible tags, triggers and variables are mapped.",
    });
  for (const c of cv.client ?? [])
    report.unmapped.push({
      gtm: { kind: "client", name: c.name ?? "client" },
      reason: "Server-container clients aren't imported.",
      hint: "Backends send events with POST /v1/containers/:id/events; destinations replace server tags.",
    });
  for (const z of cv.zone ?? [])
    report.unmapped.push({ gtm: { kind: "zone", name: z.name ?? "zone" }, reason: "Zones (GTM 360) have no equivalent." });
  for (const f of cv.folder ?? [])
    report.adapted.push({
      gtm: { kind: "folder", name: f.name ?? "folder" },
      note: "Folders aren't kept; items keep their names (as ids) and notes.",
    });
  if ((cv.builtInVariable ?? []).length)
    report.mapped.push({
      gtm: { kind: "built_in_variable", name: `${cv.builtInVariable!.length} enabled built-in variables` },
      note: "Built-ins are always available here (page_url, click_text, form_id...); nothing to enable.",
    });

  // ---- variables: GTM name -> a reference here (a new variable's name, or a built-in)
  const refs = new Map<string, string>(Object.entries(GTM_BUILTINS));
  const constants = new Map<string, string>();
  const pendingVars: { v: GtmVariable; build: () => { item?: Variable; ref?: string; note?: string; reason?: string; hint?: string } }[] =
    [];
  for (const v of cv.variable ?? []) {
    const name = v.name;
    const id = idFor(name, taken.variables);
    refs.set(name, id);
    if (lc(v.type) === "c") constants.set(name, val(v.parameter, "value") ?? "");
    pendingVars.push({ v, build: () => mapVariable(v, id) });
  }
  const unresolved = new Set<string>();
  /** {{GTM Name}} -> {{our_name}} in a string; unknown names are noted. */
  const tpl = (s: string | undefined): string | undefined =>
    s?.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, n: string) => {
      const r = refs.get(n);
      if (!r) unresolved.add(n);
      return `{{${r ?? n.replace(/[^A-Za-z0-9_]/g, "_")}}}`;
    });
  /** A whole-value variable reference ("{{X}}") -> our name, else undefined. */
  const ref = (s: string | undefined) => {
    const m = s ? /^\{\{\s*([^}]+?)\s*\}\}$/.exec(s) : null;
    return m ? refs.get(m[1]!) : undefined;
  };
  /** A literal id, or a constant variable's value. */
  const literal = (s: string | undefined) => {
    const m = s ? /^\{\{\s*([^}]+?)\s*\}\}$/.exec(s) : null;
    return m ? constants.get(m[1]!) : s;
  };

  function mapVariable(v: GtmVariable, id: string): { item?: Variable; ref?: string; note?: string; reason?: string; hint?: string } {
    const P = v.parameter;
    const base = { name: id, ...(v.notes ? { description: v.notes.slice(0, 500) } : {}), ...format(v) };
    const dflt = bool(P, "setDefaultValue") && val(P, "defaultValue") !== undefined ? { default: val(P, "defaultValue")! } : {};
    switch (lc(v.type)) {
      case "v": {
        const key = val(P, "name");
        if (!key) return { reason: "Data layer variable without a key." };
        return {
          item: { ...base, ...dflt, type: "data_layer", key },
          ...(val(P, "dataLayerVersion") === "1" ? { note: "Data layer version 1: read as a version 2 dot path." } : {}),
        };
      }
      case "k":
        return val(P, "name")
          ? { item: { ...base, type: "cookie", cookie: val(P, "name")! } }
          : { reason: "Cookie variable without a name." };
      case "j":
        return val(P, "name")
          ? { item: { ...base, type: "js", path: val(P, "name")! } }
          : { reason: "JavaScript variable without a name." };
      case "c":
        return { item: { ...base, type: "constant", value: val(P, "value") ?? "" } };
      case "u":
      case "f": {
        const comp = lc(val(P, "component") ?? "URL");
        const source = lc(v.type) === "f" ? "referrer" : ref(val(P, "customUrlSource"));
        const key = val(P, "queryKey");
        const table: Record<string, (typeof URL_COMPONENTS)[number]> = {
          url: "href",
          protocol: "protocol",
          host: "host",
          port: "port",
          path: "path",
          query: key ? "param" : "query",
          fragment: "fragment",
        };
        const component = table[comp];
        if (!component) return { reason: `URL component "${val(P, "component")}" isn't supported.` };
        if (val(P, "customUrlSource") && !source) return { reason: "Its custom URL source isn't a variable that could be imported." };
        return {
          item: {
            ...base,
            type: "url",
            component,
            ...(component === "param" ? { param: key! } : {}),
            ...(source ? { source } : {}),
            ...(bool(P, "stripWww") ? { strip_www: true } : {}),
          },
        };
      }
      case "d": {
        const sel = lc(val(P, "selectorType")) === "id" ? cssId(val(P, "elementId")) : val(P, "elementSelector");
        if (!sel) return { reason: "DOM element variable without a selector." };
        const attr = val(P, "attributeName");
        return { item: attr ? { ...base, type: "dom_attr", selector: sel, attr } : { ...base, type: "dom_text", selector: sel } };
      }
      case "smm": {
        const input = ref(val(P, "input"));
        if (!input) return { reason: "Its input isn't a variable that could be imported." };
        const map: Record<string, string> = {};
        for (const r of rows(P, "map")) {
          if (/\{\{/.test(r.value ?? ""))
            return {
              reason: "An output is another variable ({{...}}); lookup outputs here are literal values.",
              hint: "Rebuild it as a regex_table or separate variables.",
            };
          map[r.key ?? ""] = r.value ?? "";
        }
        return { item: { ...base, ...dflt, type: "lookup", input, map } };
      }
      case "remm": {
        const input = ref(val(P, "input"));
        if (!input) return { reason: "Its input isn't a variable that could be imported." };
        const table = rows(P, "map");
        if (!table.length) return { reason: "RegEx table without rows." };
        if (table.some((r) => /\{\{/.test(r.value ?? "")))
          return { reason: "An output is another variable ({{...}}); regex_table outputs here are literal values (with $1 groups)." };
        return {
          item: {
            ...base,
            ...dflt,
            type: "regex_table",
            input,
            rows: table.slice(0, 100).map((r) => ({ pattern: r.key ?? "", output: r.value ?? "" })),
            ...(bool(P, "ignoreCase") ? { ignore_case: true } : {}),
            ...(val(P, "fullMatch") === "false" ? { full_match: false } : {}),
            ...(val(P, "enableExtraction") === "false" ? { extract: false } : {}),
          },
          ...(bool(P, "replaceAllMatches") ? { note: "replaceAllMatches isn't supported: the first matching row's output is used." } : {}),
        };
      }
      case "aev": {
        const t = lc(val(P, "varType"));
        const builtin = {
          element: "event_element",
          classes: "click_classes",
          id: "click_id",
          target: "click_target",
          text: "click_text",
          historynewurlfragment: "history_new_url",
          historyoldurlfragment: "history_old_url",
          historychangesource: "history_source",
        }[t];
        if (t === "attribute" && val(P, "attribute")) return { item: { ...base, type: "event_attr", attr: val(P, "attribute")! } };
        if (t === "url") {
          const comp = lc(val(P, "urlComponent") ?? "URL");
          if (comp === "url") return { ref: "click_url" };
          const component = (
            { protocol: "protocol", host: "host", port: "port", path: "path", query: "query", fragment: "fragment" } as const
          )[comp as "host"];
          return component
            ? { item: { ...base, type: "url", component, source: "click_url" } }
            : { reason: `Auto-event URL component "${val(P, "urlComponent")}" isn't supported.` };
        }
        return builtin
          ? { ref: builtin, note: `Uses the built-in ${builtin}.` }
          : { reason: `Auto-event variable type "${val(P, "varType")}" isn't supported.` };
      }
      case "e":
        return { ref: "event" };
      case "cid":
        return { ref: "container_id" };
      case "ctv":
        return { ref: "container_version" };
      case "dbg":
        return { ref: "debug_mode" };
      case "jsm": {
        const js = val(P, "javascript") ?? "";
        if (/\{\{/.test(js))
          return {
            reason: "The code references other variables ({{...}}), which custom_js variables can't template.",
            hint: "Rewrite it with lookup / regex_table / url / format, or read the values from event.model.",
          };
        return {
          item: { ...base, type: "custom_js", code: `return (${js.trim()}).call(this);`.slice(0, 10_000) },
          note: "Custom JavaScript: publishing it needs a verified domain and a claimed account (custom code).",
        };
      }
      case "gtcs":
      case "gtes": {
        const t = rows(P, lc(v.type) === "gtcs" ? "configSettingsTable" : "eventSettingsTable");
        const params: Record<string, string> = {};
        for (const r of t) if (r.parameter) params[r.parameter] = tpl(r.parameterValue) ?? "";
        return { item: { ...base, type: "param_set", params } };
      }
      case "r":
        return {
          reason: "Random Number has no equivalent (it's for sampling and cache busting).",
          hint: "image_pixel adds a cache buster itself (cache_bust).",
        };
      case "awec":
        return {
          reason: "User-provided data variables aren't imported.",
          hint: 'Map PII on conversions instead: conversions[].user_data { email: <variable> } or "auto".',
        };
      case "gas":
        return { reason: "Google Analytics Settings is for Universal Analytics, which no longer collects data." };
      case "vis":
        return {
          reason: "Element visibility variables aren't supported.",
          hint: "Use an element_visible trigger with the percent_visible built-in.",
        };
      default:
        return { reason: `GTM variable type "${v.type}" has no equivalent here.` };
    }
  }

  function format(v: GtmVariable): { format?: NonNullable<Variable["format"]> } {
    const f = v.formatValue;
    if (!f) return {};
    const out: NonNullable<Variable["format"]> = {};
    const ct = lc(f.caseConversionType);
    if (ct === "lowercase") out.lowercase = true;
    if (ct === "uppercase") out.uppercase = true;
    for (const [k, to] of [
      ["convertNullToValue", "map_null"],
      ["convertUndefinedToValue", "map_undefined"],
      ["convertTrueToValue", "map_true"],
      ["convertFalseToValue", "map_false"],
    ] as const) {
      const x = pv(f[k]);
      if (x !== undefined) out[to] = x;
    }
    return Object.keys(out).length ? { format: out } : {};
  }

  for (const { v, build } of pendingVars) {
    const r = build();
    const g = { kind: "variable" as const, name: v.name, type: v.type };
    if (r.ref) {
      refs.set(v.name, r.ref);
      (r.note ? report.adapted : report.mapped).push({ gtm: g, note: r.note ?? `Uses the built-in ${r.ref} (no variable needed).` });
      continue;
    }
    if (!r.item) {
      refs.delete(v.name);
      report.unmapped.push({ gtm: g, reason: r.reason ?? "Not supported.", ...(r.hint ? { hint: r.hint } : {}) });
      continue;
    }
    const ok = variableSchema.safeParse(r.item);
    if (!ok.success || out.variables.length >= MAX_ITEMS) {
      refs.delete(v.name);
      report.unmapped.push({
        gtm: g,
        reason: !ok.success ? `Doesn't fit this platform's schema: ${ok.error.issues[0]?.message}` : `Over ${MAX_ITEMS} variables.`,
      });
      continue;
    }
    out.variables.push(ok.data);
    (r.note ? report.adapted : report.mapped).push({
      gtm: g,
      to: [{ kind: "variables", key: r.item.name }],
      ...(r.note ? { note: r.note } : {}),
    });
  }
  // Variables that read others: their input/source refs were resolved in order; re-point late ones.
  for (const v of out.variables) {
    if ((v.type === "lookup" || v.type === "regex_table") && !isKnown(v.input)) unresolved.add(v.input);
  }
  function isKnown(n: string) {
    return n in BUILTIN_VARIABLES || out.variables.some((x) => x.name === n);
  }

  // ---- triggers: GTM trigger id -> our trigger ids
  const trigMap = new Map<string, string[]>();
  const conditions = (filters: GtmTrigger["filter"]): Trigger["conditions"] | string => {
    const outc: NonNullable<Trigger["conditions"]> = [];
    for (const f of filters ?? []) {
      const a0 = val(f.parameter, "arg0");
      const a1 = val(f.parameter, "arg1") ?? "";
      const name = ref(a0);
      if (!name) return `condition on "${a0}", which isn't a variable that could be imported`;
      const neg = bool(f.parameter, "negate");
      const op = (
        {
          equals: neg ? "not_equals" : "equals",
          contains: neg ? "not_contains" : "contains",
          startswith: neg ? "not_starts_with" : "starts_with",
          endswith: neg ? "not_ends_with" : "ends_with",
          matchregex: neg ? "not_matches_regex" : "matches_regex",
          cssselector: neg ? "not_matches_css_selector" : "matches_css_selector",
          greater: neg ? "lte" : "gt",
          greaterorequals: neg ? "lt" : "gte",
          less: neg ? "gte" : "lt",
          lessorequals: neg ? "gt" : "lte",
        } as const
      )[lc(f.type) as "equals"];
      if (!op) return `condition type "${f.type}"`;
      const ic = bool(f.parameter, "ignore_case") || lc(f.type) === "matchregexignorecase";
      outc.push({ var: name, op, value: a1, ...(ic ? { ignore_case: true } : {}) });
    }
    return outc.length ? outc : undefined;
  };

  for (const t of cv.trigger ?? []) {
    const g = { kind: "trigger" as const, name: t.name, type: t.type };
    const id = idFor(t.name, taken.triggers);
    const conds = conditions(t.filter);
    if (typeof conds === "string") {
      report.unmapped.push({
        gtm: g,
        reason: `Can't map its ${conds}; importing it without that condition would fire it more often.`,
        hint: "Recreate the trigger by hand (GET /v1/schema -> catalog.triggers).",
      });
      continue;
    }
    const P = t.parameter;
    const base = { id, ...(conds ? { conditions: conds } : {}), ...(t.notes ? { description: t.notes.slice(0, 500) } : {}) };
    const notes: string[] = [];
    const wait = pv(t.waitForTags) === "true" ? Math.min(Number(pv(t.waitForTagsTimeout) ?? 2000) || 2000, 2000) : 0;
    if (pv(t.waitForTags) === "true" && Number(pv(t.waitForTagsTimeout) ?? 2000) > 2000) notes.push("wait for tags capped at 2000 ms");
    const wc = { ...(wait ? { wait_for_tags_ms: wait } : {}), ...(pv(t.checkValidation) === "true" ? { check_validation: true } : {}) };
    if ((t.autoEventFilter ?? []).length)
      notes.push('its "enable this trigger when" page filter is not needed here (listeners are always on)');
    const made: Trigger[] = [];
    let unsupported: string | null = null;
    switch (lc(t.type)) {
      case "pageview":
        made.push({ ...base, type: "page_view" });
        break;
      case "domready":
        made.push({ ...base, type: "dom_ready" });
        break;
      case "windowloaded":
        made.push({ ...base, type: "window_loaded" });
        break;
      case "init":
        made.push({ ...base, type: "init" });
        break;
      case "consentinit":
        made.push({ ...base, type: "consent_init" });
        break;
      case "historychange":
        made.push({ ...base, type: "history_change" });
        break;
      case "jserror":
        made.push({ ...base, type: "js_error" });
        break;
      case "click":
        made.push({ ...base, type: "click", ...wc });
        break;
      case "linkclick":
        made.push({ ...base, type: "click", links_only: true, ...wc });
        break;
      case "formsubmission":
        made.push({ ...base, type: "form_submit", ...wc });
        break;
      case "customevent": {
        const f = t.customEventFilter?.[0];
        const name = val(f?.parameter, "arg1");
        if (!name) {
          unsupported = "custom event trigger without an event name";
          break;
        }
        const regex = lc(f?.type).startsWith("matchregex");
        made.push({
          ...base,
          type: "custom_event",
          ...(regex ? { event_regex: name, ...(bool(f?.parameter, "ignore_case") ? { ignore_case: true } : {}) } : { event: name }),
        });
        if (f && !["equals", "matchregex", "matchregexignorecase"].includes(lc(f.type)))
          notes.push(`event name "${f.type}" match read as equals`);
        break;
      }
      case "timer": {
        const ms = Math.max(250, Math.min(Number(pv(t.interval) ?? val(P, "interval")) || 1000, 3_600_000));
        const limit = Number(pv(t.limit) ?? val(P, "limit"));
        made.push({ ...base, type: "timer", interval_ms: ms, ...(limit >= 1 ? { limit: Math.min(limit, 1000) } : { limit: 1000 }) });
        if (!(limit >= 1)) notes.push("no limit in GTM: capped at 1000 fires per page");
        break;
      }
      case "scrolldepth": {
        const list = (s: string | undefined) =>
          (s ?? "")
            .split(",")
            .map((x) => Number(x.trim()))
            .filter((n) => Number.isInteger(n) && n > 0)
            .slice(0, 10);
        for (const dir of ["vertical", "horizontal"] as const) {
          if (val(P, `${dir}ThresholdOn`) !== "true") continue;
          const px = lc(val(P, `${dir}ThresholdUnits`)) === "pixels";
          const nums = list(val(P, px ? `${dir}ThresholdsPixels` : `${dir}ThresholdsPercent`));
          if (!nums.length) continue;
          made.push({
            ...base,
            id: dir === "vertical" ? id : idFor(`${t.name}_horizontal`, taken.triggers),
            type: "scroll_depth",
            ...(px ? { pixels: nums } : { percentages: nums.map((n) => Math.min(n, 100)) }),
            ...(dir === "horizontal" ? { direction: "horizontal" as const } : {}),
          });
        }
        if (!made.length) unsupported = "scroll depth trigger without thresholds";
        else if (made.length > 1) notes.push("vertical and horizontal thresholds became two triggers; tags use both");
        break;
      }
      case "elementvisibility": {
        const sel = lc(val(P, "selectorType")) === "id" ? cssId(val(P, "elementId")) : val(P, "elementSelector");
        if (!sel) {
          unsupported = "visibility trigger without a selector";
          break;
        }
        const freq = lc(val(P, "firingFrequency"));
        const ratio = Number(val(P, "onScreenRatio"));
        const dur = bool(P, "useOnScreenDuration") ? Number(val(P, "onScreenDuration")) : 0;
        made.push({
          ...base,
          type: "element_visible",
          selector: sel,
          ...(ratio > 0 ? { threshold: Math.min(ratio, 100) / 100 } : {}),
          once: freq === "once" ? "page" : freq === "manyperelement" ? false : "element",
          ...(dur > 0 ? { min_duration_ms: Math.min(dur, 60_000) } : {}),
          ...(bool(P, "useDomChangeListener") ? { observe_dom: true } : {}),
        });
        break;
      }
      case "youtubevideo": {
        const statuses = [
          ...(bool(P, "captureStart") ? ["start" as const] : []),
          ...(bool(P, "captureProgress") ? ["progress" as const] : []),
          ...(bool(P, "capturePause") ? ["pause" as const, "seek" as const] : []),
          ...(bool(P, "captureComplete") ? ["complete" as const] : []),
        ];
        if (!statuses.length) {
          unsupported = "video trigger without any captured status";
          break;
        }
        const pct = (val(P, "progressThresholdsPercent") ?? "")
          .split(",")
          .map((x) => Number(x.trim()))
          .filter((n) => n >= 1 && n <= 99)
          .slice(0, 10);
        if (val(P, "progressThresholdsTimeInSeconds")) notes.push("progress thresholds in seconds aren't supported (only percentages)");
        made.push({ ...base, type: "video", providers: ["youtube"], statuses, ...(pct.length ? { percentages: pct } : {}) });
        break;
      }
      case "triggergroup":
        // Resolved after every trigger has an id (members can come later in the export).
        made.push({ ...base, type: "trigger_group", triggers: (p(P, "triggerIds")?.list ?? []).map((x) => `@${x.value}`) });
        break;
      default:
        unsupported = `GTM trigger type "${t.type}" has no equivalent here`;
    }
    if (unsupported || !made.length) {
      report.unmapped.push({ gtm: g, reason: `${unsupported ?? "Not supported"}.` });
      continue;
    }
    if (t.triggerId)
      trigMap.set(
        t.triggerId,
        made.map((m) => m.id),
      );
    out.triggers.push(...made);
    const item: ImportItem = { gtm: g, to: made.map((m) => ({ kind: "triggers", key: m.id })) };
    if (notes.length) report.adapted.push({ ...item, note: `${notes.join("; ")}.` });
    else report.mapped.push(item);
  }
  // Built-in triggers the tags use.
  const builtinTrigger = (gid: string) => {
    const b = BUILTIN_TRIGGERS[gid];
    if (!b) return undefined;
    if (!out.triggers.some((t) => t.id === b.id)) {
      taken.triggers.add(b.id);
      out.triggers.push(triggerSchema.parse(b));
      report.mapped.push({
        gtm: { kind: "trigger", name: b.description!.replace("GTM built-in: ", ""), type: "built-in" },
        to: [{ kind: "triggers", key: b.id }],
      });
    }
    return [b.id];
  };
  const triggerIds = (gids: string[] | undefined) => {
    const ok: string[] = [];
    const missing: string[] = [];
    for (const gid of gids ?? []) {
      const m = trigMap.get(gid) ?? builtinTrigger(gid);
      if (m) ok.push(...m);
      else missing.push(gid);
    }
    return { ok: [...new Set(ok)], missing };
  };
  // Trigger groups: member GTM ids -> our ids (a group with a member that wasn't imported can't fire as in GTM).
  out.triggers = out.triggers.filter((t) => {
    if (t.type !== "trigger_group") return true;
    const { ok, missing } = triggerIds(t.triggers.map((x) => x.slice(1)));
    const r = report.mapped.find((i) => i.to?.some((x) => x.key === t.id)) ?? report.adapted.find((i) => i.to?.some((x) => x.key === t.id));
    if (missing.length || ok.length < 2 || ok.some((m) => out.triggers.find((x) => x.id === m)?.type === "trigger_group")) {
      if (r) {
        report.mapped = report.mapped.filter((i) => i !== r);
        report.adapted = report.adapted.filter((i) => i !== r);
        report.unmapped.push({
          gtm: r.gtm,
          reason: "A trigger in this group couldn't be imported (or is a group itself), so the group would never fire as in GTM.",
        });
      }
      trigMap.forEach((v, k) => v.includes(t.id) && trigMap.delete(k));
      return false;
    }
    t.triggers = ok;
    return true;
  });
  const validTriggers: Trigger[] = [];
  for (const t of out.triggers) {
    const r = triggerSchema.safeParse(t);
    if (r.success && validTriggers.length < MAX_ITEMS) validTriggers.push(r.data);
    else {
      trigMap.forEach((v, k) => v.includes(t.id) && trigMap.delete(k));
      const i = [...report.mapped, ...report.adapted].find((x) => x.to?.some((y) => y.key === t.id));
      report.mapped = report.mapped.filter((x) => x !== i);
      report.adapted = report.adapted.filter((x) => x !== i);
      report.unmapped.push({
        gtm: i?.gtm ?? { kind: "trigger", name: t.id },
        reason: r.success
          ? `Over ${MAX_ITEMS} triggers.`
          : `Doesn't fit this platform's schema: ${r.error.issues[0]?.message} (${r.error.issues[0]?.path.join(".")}).`,
      });
    }
  }
  out.triggers = validTriggers;

  // ---- tags
  const templates = new Map((cv.customTemplate ?? []).map((t) => [t.templateId ?? "", t]));
  const tagNames = new Map<string, string>();
  const pendingTags: { t: GtmTag; id: string }[] = [];
  for (const t of cv.tag ?? []) {
    const id = idFor(t.name, taken.tags);
    tagNames.set(t.name, id);
    pendingTags.push({ t, id });
  }
  for (const { t, id } of pendingTags) {
    const g = { kind: "tag" as const, name: t.name, type: t.type };
    const r = mapTag(t, id);
    if (!r.tag) {
      report[r.adapted ? "adapted" : "unmapped"].push({
        gtm: g,
        ...(r.adapted ? { note: r.reason } : { reason: r.reason ?? "Not supported." }),
        ...(r.hint ? { hint: r.hint } : {}),
      });
      continue;
    }
    const fire = triggerIds(t.firingTriggerId);
    const block = triggerIds(t.blockingTriggerId);
    const notes = [...(r.notes ?? [])];
    if (!fire.ok.length) {
      report.unmapped.push({
        gtm: g,
        reason: (t.firingTriggerId ?? []).length
          ? "None of its firing triggers could be imported (see unmapped triggers)."
          : "It has no firing trigger.",
      });
      continue;
    }
    if (fire.missing.length) notes.push(`${fire.missing.length} firing trigger(s) couldn't be imported, so it fires on fewer events`);
    if (block.missing.length)
      notes.push(`${block.missing.length} blocking trigger(s) couldn't be imported, so it may fire where GTM blocked it`);
    const tag: Record<string, unknown> = { ...r.tag, id, triggers: fire.ok.slice(0, 20) };
    if (block.ok.length) tag.exclude_triggers = block.ok.slice(0, 20);
    if (t.paused) tag.enabled = false;
    if (lc(t.tagFiringOption) === "onceperload") tag.once_per_page = true;
    const prio = Number(pv(t.priority));
    if (prio) tag.priority = Math.max(-1000, Math.min(1000, Math.round(prio)));
    const start = Number(t.scheduleStartMs);
    const end = Number(t.scheduleEndMs);
    if (start > 0 || end > 0) tag.schedule = { ...(start > 0 ? { start } : {}), ...(end > 0 ? { end } : {}) };
    if (t.liveOnly) tag.live_only = true;
    if (t.notes) tag.description = t.notes.slice(0, 500);
    const cs = lc(t.consentSettings?.consentStatus);
    if (cs === "notneeded") tag.consent = [];
    else if (cs === "needed") {
      const types = (t.consentSettings?.consentType?.list ?? []).map((x) => x.value ?? "");
      const known = types.filter((x): x is (typeof CONSENT_TYPES)[number] => (CONSENT_TYPES as readonly string[]).includes(x));
      tag.consent = known;
      if (known.length < types.length)
        notes.push(`consent types ${types.filter((x) => !known.includes(x as never)).join(", ")} aren't known here`);
    }
    const setup = t.setupTag?.[0];
    if (setup) {
      const sid = tagNames.get(setup.tagName);
      if (sid) tag.after = { tag: sid, ...(setup.stopOnSetupFailure ? { require_success: true } : {}) };
      else notes.push(`setup tag "${setup.tagName}" isn't in the export`);
    }
    if ((t.teardownTag ?? []).length) notes.push("cleanup (teardown) tags aren't supported; fire it on the same trigger instead");
    const parsedTag = tagSchema.safeParse(tag);
    if (!parsedTag.success || out.tags.length >= MAX_ITEMS) {
      report.unmapped.push({
        gtm: g,
        reason: parsedTag.success
          ? `Over ${MAX_ITEMS} tags.`
          : `Doesn't fit this platform's schema: ${parsedTag.error.issues[0]?.message} (${parsedTag.error.issues[0]?.path.join(".")}).`,
        hint: "Fix the value in GTM and export again, or add the tag by hand (PUT /draft/tags/:id).",
      });
      continue;
    }
    out.tags.push(parsedTag.data);
    const item: ImportItem = { gtm: g, to: [{ kind: "tags", key: id }] };
    if (notes.length) report.adapted.push({ ...item, note: `${notes.join("; ")}.` });
    else report.mapped.push(item);
  }
  // A setup tag that wasn't imported can't be waited for.
  for (const tag of out.tags) if (tag.after && !out.tags.some((x) => x.id === tag.after!.tag)) delete tag.after;

  function mapTag(
    t: GtmTag,
    id: string,
  ): { tag?: Partial<Tag> & { type: Tag["type"] }; notes?: string[]; reason?: string; hint?: string; adapted?: boolean } {
    const P = t.parameter;
    const notes: string[] = [];
    switch (lc(t.type)) {
      case "googtag":
      case "gaawc": {
        const raw = literal(val(P, lc(t.type) === "googtag" ? "tagId" : "measurementId"));
        const table = rows(P, lc(t.type) === "googtag" ? "configSettingsTable" : "fieldsToSet");
        const cfgp: Record<string, string | boolean> = {};
        let spv: boolean | undefined = lc(t.type) === "gaawc" && val(P, "sendPageView") === "false" ? false : undefined;
        for (const r of table) {
          const k = r.parameter ?? r.fieldName ?? "";
          const v = tpl(r.parameterValue ?? r.value) ?? "";
          if (k === "send_page_view") spv = v !== "false";
          else if (/^[a-z][a-z0-9_]{0,39}$/.test(k)) cfgp[k] = v;
          else notes.push(`config field "${k}" skipped (not a gtag config parameter name)`);
        }
        const from = ref(val(P, "configSettingsVariable"));
        if (rows(P, "eventSettingsTable").length || val(P, "eventSettingsVariable"))
          notes.push("its shared event settings apply to config only; add event_params_from to event tags");
        if (raw && /^AW-\d{6,15}$/.test(raw))
          return {
            tag: {
              type: "google_ads",
              params: {
                conversion_id: raw,
                ...(Object.keys(cfgp).length ? { config_params: cfgp } : {}),
                ...(from ? { config_params_from: from } : {}),
              },
            } as never,
            notes,
          };
        if (!raw || !/^G-[A-Z0-9]{4,15}$/.test(raw))
          return {
            reason: `Google tag id "${raw ?? ""}" isn't a GA4 (G-) or Google Ads (AW-) id (or a constant holding one).`,
            hint: "GT- and DC- tags aren't supported; add a ga4 or google_ads tag by hand.",
          };
        return {
          tag: {
            type: "ga4",
            params: {
              measurement_id: raw,
              ...(spv === false ? { send_page_view: false } : {}),
              ...(Object.keys(cfgp).length ? { config_params: cfgp } : {}),
              ...(from ? { config_params_from: from } : {}),
            },
          } as never,
          notes,
        };
      }
      case "gaawe": {
        let mid = literal(val(P, "measurementIdOverride") || val(P, "measurementId"));
        if (mid && !/^G-/.test(mid)) {
          // A TAG_REFERENCE to a GA4 configuration tag: use its measurement id.
          const cfgTag = (cv.tag ?? []).find((x) => x.name === mid || x.tagId === mid);
          mid = cfgTag ? literal(val(cfgTag.parameter, "measurementId") ?? val(cfgTag.parameter, "tagId")) : undefined;
        }
        const name = val(P, "eventName");
        if (!mid || !/^G-[A-Z0-9]{4,15}$/.test(mid)) return { reason: "No GA4 measurement id (G-...) could be found for this event tag." };
        if (!name || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name))
          return {
            reason: `Event name "${name ?? ""}" must be a literal GA4 event name here (letters, digits, _).`,
            hint: "Variables in event names aren't supported; one tag per event name.",
          };
        const ev: Record<string, string> = {};
        for (const r of [...rows(P, "eventParameters"), ...rows(P, "eventSettingsTable")]) {
          const k = r.name ?? r.parameter;
          if (k) ev[k.slice(0, 40)] = tpl(r.value ?? r.parameterValue) ?? "";
        }
        const from = ref(val(P, "eventSettingsVariable"));
        if (Object.keys(ev).length > 50) notes.push("more than 50 event parameters");
        return {
          tag: {
            type: "ga4",
            params: {
              measurement_id: mid,
              event_name: name,
              ...(Object.keys(ev).length ? { event_params: ev } : {}),
              ...(from ? { event_params_from: from } : {}),
            },
          } as never,
          notes,
        };
      }
      case "awct":
      case "sp": {
        const cid = literal(val(P, "conversionId"));
        if (!cid || !/^\d{6,15}$/.test(cid))
          return { reason: `Google Ads conversion id "${cid ?? ""}" must be the literal number (or a constant).` };
        if (lc(t.type) === "sp") {
          if (val(P, "enableDynamicRemarketing") === "true")
            notes.push("dynamic remarketing: set send_to.google_ads.remarketing on a conversion to send items");
          return { tag: { type: "google_ads", params: { conversion_id: `AW-${cid}` } } as never, notes };
        }
        const label = literal(val(P, "conversionLabel"));
        const value = tpl(val(P, "conversionValue"));
        const currency = literal(val(P, "currencyCode"));
        notes.push("a conversion tag: consider a conversions[] entry instead (one event_id shared with server delivery)");
        if (val(P, "orderId")) notes.push("orderId isn't passed by a google_ads tag (conversions[].transaction_id is)");
        return {
          tag: {
            type: "google_ads",
            params: {
              conversion_id: `AW-${cid}`,
              ...(label ? { conversion_label: label } : {}),
              ...(value ? { value: /^\d+(\.\d+)?$/.test(value) ? Number(value) : value } : {}),
              ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
            },
          } as never,
          notes,
        };
      }
      case "gclidw":
        return {
          adapted: true,
          reason:
            "Conversion Linker isn't needed: the runtime captures gclid, gbraid, wbraid and other click ids into first-party cookies itself.",
        };
      case "html": {
        const html = val(P, "html") ?? "";
        if (bool(P, "supportDocumentWrite")) notes.push("document.write isn't supported in injected HTML");
        if (/<script[\s\S]*\{\{[\s\S]*<\/script>/i.test(html))
          notes.push(
            "{{variables}} inside <script> are HTML-encoded here (GTM inserts them raw), so that code may need event.data / event.model in a custom_js tag instead",
          );
        notes.push("custom HTML: publishing it needs a verified domain and a claimed account (custom code)");
        return { tag: { type: "custom_html", params: { html: tpl(html)!.slice(0, 50_000) } } as never, notes };
      }
      case "img": {
        const url = tpl(val(P, "url")) ?? "";
        return {
          tag: { type: "image_pixel", params: { url, ...(val(P, "useCacheBuster") === "false" ? { cache_bust: false } : {}) } } as never,
          notes,
        };
      }
      case "ua":
        return { reason: "Universal Analytics no longer collects data.", hint: "Use a ga4 tag." };
      case "flc":
      case "fls":
        return {
          reason: "Floodlight tags aren't supported yet.",
          hint: 'A custom_js tag calling gtag("event", "conversion", { send_to: "DC-..." }) works meanwhile.',
        };
      case "bzi":
        return platformTag("linkedin_insight", P);
      case "baut":
        return platformTag("microsoft_uet", P);
      case "pntr":
        return platformTag("pinterest_tag", P);
      default: {
        const m = /^cvt_(?:\d+_)?(\d+)$/.exec(t.type);
        const tmpl = m ? templates.get(m[1]!) : undefined;
        const label = `${tmpl?.name ?? ""} ${tmpl?.galleryReference?.owner ?? ""} ${tmpl?.galleryReference?.repository ?? ""}`;
        const hit = tmpl ? TEMPLATE_PLATFORMS.find(([re]) => re.test(label)) : undefined;
        if (hit?.[1] === "replay")
          return {
            reason: `${tmpl!.name}: session replay tags aren't imported.`,
            hint: "This platform's replay app records sessions (replay.<domain>).",
          };
        if (hit) return platformTag(hit[1] as keyof typeof ID_PATTERNS, P, tmpl!.name);
        return {
          reason: tmpl ? `Custom template "${tmpl.name}" has no built-in equivalent.` : `GTM tag type "${t.type}" has no equivalent here.`,
          hint: "Use a built-in tag type, or custom_html (custom code: needs a verified domain and a claimed account).",
        };
      }
    }
    function platformTag(type: keyof typeof ID_PATTERNS, P: Param[] | undefined, template?: string) {
      // Template parameter names vary by vendor: take the first value shaped like this platform's id.
      const flat: string[] = [];
      const walk = (l: Param[] | undefined) =>
        l?.forEach((x) => (x.value !== undefined ? flat.push(literal(x.value) ?? "") : walk(x.list ?? x.map)));
      walk(P);
      const idv = flat
        .find((v) => ID_PATTERNS[type]!.test(v.split(",")[0]!.trim()))
        ?.split(",")[0]!
        .trim();
      if (!idv) return { reason: `${template ?? type}: no ${type} id found in its parameters.` };
      const keys: Record<string, string> = {
        meta_pixel: "pixel_id",
        tiktok_pixel: "pixel_id",
        linkedin_insight: "partner_id",
        microsoft_uet: "tag_id",
        reddit_pixel: "pixel_id",
        x_pixel: "pixel_id",
        pinterest_tag: "tag_id",
        snap_pixel: "pixel_id",
      };
      const key = keys[type] ?? "pixel_id";
      notes.push(
        `${template ? `template "${template}"` : "built-in tag"}: the base tag is imported; event names and parameters aren't (add send_to.<platform> on conversions)`,
      );
      return { tag: { type, params: { [key]: idv } } as never, notes };
    }
  }

  if (unresolved.size)
    report.adapted.push({
      gtm: { kind: "variable", name: [...unresolved].slice(0, 20).join(", ") },
      note: "These {{variables}} are referenced but couldn't be imported; they render as empty strings.",
    });

  const config: ContainerConfig = {};
  if (out.variables.length) config.variables = out.variables;
  if (out.triggers.length) config.triggers = out.triggers;
  if (out.tags.length) config.tags = out.tags;
  return { config, report };
}

function cssId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/["\\]/g, "")}"]`;
}
