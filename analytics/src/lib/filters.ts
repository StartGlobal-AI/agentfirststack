/**
 * Dimensions (breakdowns + filters), metrics, and the filter grammar:
 *   filters=country==US;page~/blog;channel!=Direct;country==US|CA;prop:plan==pro;utm_source==(none);page==/blog/*
 * ops: == equals, != not equals, ~ contains (case-insensitive), !~ does not contain.
 * `|` separates alternatives (OR). `(none)` matches a missing value. `*` in an == / != value is a
 * wildcard (GLOB, case-sensitive like ==). `\;`, `\|`, `\*` and `\\` escape. Nested and / or / not
 * groups: parseFilterJson.
 */

export const METRICS = [
  "visitors",
  "visits",
  "pageviews",
  "views_per_visit",
  "bounce_rate",
  "visit_duration",
  "events",
  "conversions",
  "conversion_rate",
  "revenue",
  "revenue_per_visitor",
  "new_revenue",
  "renewal_revenue",
  "refunds",
  "purchases",
  "customers",
  "purchase_rate",
  "new_visitors",
  "returning_visitors",
  "scroll_depth",
  "time_on_page",
  "lcp_p75",
  "inp_p75",
  "cls_p75",
  "engaged_visits",
  "engagement_rate",
  "engagement_time",
  "visits_per_visitor",
  "events_per_visit",
  "visit_conversion_rate",
  "average_order_value",
  "revenue_per_customer",
  "percentage",
  // ad spend (POST /costs): cost, revenue / cost, cost per conversion, per new customer, per visit
  "cost",
  "roas",
  "cpa",
  "cac",
  "cost_per_visit",
] as const;
/** A numeric custom metric over a prop: sum:prop:amount, avg:prop:amount, min:..., max:... */
export type CustomMetric = `${"sum" | "avg" | "min" | "max"}:prop:${string}`;
export type Metric = (typeof METRICS)[number] | CustomMetric;
export const CUSTOM_METRIC_RE = /^(sum|avg|min|max):prop:([A-Za-z0-9_.-]{1,64})$/;
export const MAX_CUSTOM_METRICS = 5;
export const isCustomMetric = (m: string): m is CustomMetric => CUSTOM_METRIC_RE.test(m);
/** The SQL alias of a custom metric (an identifier made only of [A-Za-z0-9_]). */
export const customAlias = (m: string) => `cm_${m.replace(/[^A-Za-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;

/** What stats and breakdowns return when `metrics` is not given (the rest are opt-in). */
export const DEFAULT_METRICS: readonly Metric[] = [
  "visitors",
  "visits",
  "pageviews",
  "views_per_visit",
  "bounce_rate",
  "visit_duration",
  "events",
  "conversions",
  "conversion_rate",
  "revenue",
  "revenue_per_visitor",
];

/** Metrics that need the sessions table (bounce, duration), visitor history, or Web Vitals percentiles. */
export const SESSION_METRICS: readonly Metric[] = ["bounce_rate", "visit_duration", "engaged_visits", "engagement_rate"];
export const VISITOR_TYPE_METRICS: readonly Metric[] = ["new_visitors", "returning_visitors"];
export const VITALS_METRICS: readonly Metric[] = ["lcp_p75", "inp_p75", "cls_p75"];

/** Metrics a breakdown can be ordered by in SQL (before LIMIT). */
export const SORTABLE_METRICS: readonly Metric[] = [
  "visitors",
  "visits",
  "pageviews",
  "events",
  "conversions",
  "conversion_rate",
  "revenue",
  "revenue_per_visitor",
  "new_revenue",
  "renewal_revenue",
  "refunds",
  "purchases",
  "customers",
  "purchase_rate",
  "engagement_time",
  "visits_per_visitor",
  "events_per_visit",
  "visit_conversion_rate",
  "average_order_value",
  "revenue_per_customer",
  "percentage",
];

export const BREAKDOWNS = [
  "page",
  "entry_page",
  "exit_page",
  "hostname",
  "source",
  "referrer",
  "channel",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  "click_id_type",
  "country",
  "region",
  "city",
  "continent",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device",
  "language",
  "screen",
  "page_title",
  "content_group",
  "channel_group",
  "first_channel",
  "first_source",
  "first_referrer",
  "first_utm_source",
  "first_utm_medium",
  "first_utm_campaign",
  "first_entry_page",
  "event_name",
  "visitor_type",
  "goal",
] as const;

/** First-touch dimensions: the identity's first session (identified users and persistent visitors see across days). */
export const FIRST_TOUCH_DIMS = [
  "first_channel",
  "first_source",
  "first_referrer",
  "first_utm_source",
  "first_utm_medium",
  "first_utm_campaign",
  "first_entry_page",
] as const;

/** An event's identity row (user:<id> when identified, else its visitor id), one column of it. */
const firstTouch = (col: string) => `(SELECT i.${col} FROM identities i WHERE i.ident = COALESCE('user:' || e.user_id, e.visitor_id))`;
export type Breakdown = (typeof BREAKDOWNS)[number] | `prop:${string}` | `user:${string}`;

/** Dimension -> SQL over `events e` (and `sessions s` for entry/exit page). Never user input. */
export const DIMENSION_SQL: Record<Exclude<(typeof BREAKDOWNS)[number], "goal" | "content_group" | "channel_group">, string> = {
  page: "e.pathname",
  entry_page: "s.entry_page",
  exit_page: "s.exit_page",
  hostname: "e.hostname",
  source: "e.source",
  referrer: "e.referrer",
  channel: "e.channel",
  utm_source: "e.utm_source",
  utm_medium: "e.utm_medium",
  utm_campaign: "e.utm_campaign",
  utm_term: "e.utm_term",
  utm_content: "e.utm_content",
  utm_id: "e.utm_id",
  utm_source_platform: "e.utm_source_platform",
  utm_creative_format: "e.utm_creative_format",
  utm_marketing_tactic: "e.utm_marketing_tactic",
  click_id_type: "e.click_id_type",
  country: "e.country",
  region: "e.region",
  city: "e.city",
  continent: "e.continent",
  browser: "e.browser",
  browser_version: "e.browser_version",
  os: "e.os",
  os_version: "e.os_version",
  device: "e.device",
  language: "e.language",
  screen: "e.screen",
  page_title: "e.title",
  first_channel: firstTouch("channel"),
  first_source: firstTouch("source"),
  first_referrer: firstTouch("referrer"),
  first_utm_source: firstTouch("utm_source"),
  first_utm_medium: firstTouch("utm_medium"),
  first_utm_campaign: firstTouch("utm_campaign"),
  first_entry_page: firstTouch("entry_page"),
  event_name: "e.name",
  // new: the visitor's first session; returning: they had a session that ended before this one began
  visitor_type:
    "(CASE WHEN EXISTS (SELECT 1 FROM sessions s2 WHERE s2.visitor_id = e.visitor_id AND s2.last_seen_at < (SELECT s3.started_at FROM sessions s3 WHERE s3.id = e.session_id)) THEN 'returning' ELSE 'new' END)",
};

export const PROP_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export type FilterOp = "==" | "!=" | "~" | "!~";

export interface Filter {
  key: (typeof BREAKDOWNS)[number] | `prop:${string}` | `user:${string}` | "did";
  op: FilterOp;
  values: string[];
}

export class FilterError extends Error {}

/** Filter-only keys: did==<event> keeps visitors who did that event in the range (did!= who didn't). */
export const FILTER_ONLY_KEYS = ["did"] as const;
export const isFilterKey = (key: string) => isBreakdown(key) || (FILTER_ONLY_KEYS as readonly string[]).includes(key);

export const NONE = "(none)";
export const MAX_FILTER_VALUES = 30;

export function isBreakdown(key: string): key is Breakdown {
  if (key.startsWith("prop:") || key.startsWith("user:")) return PROP_KEY_RE.test(key.slice(5));
  return (BREAKDOWNS as readonly string[]).includes(key);
}

function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && (s[i + 1] === ";" || s[i + 1] === "|" || s[i + 1] === "\\" || s[i + 1] === "*")) {
      cur += `\\${s[i + 1]}`;
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// `\*` stays escaped: valueCond reads an unescaped * as a wildcard and \* as a literal star.
const unescape = (s: string) => s.replace(/\\([;|\\])/g, "$1");

export function parseFilters(input: string | null | undefined): Filter[] {
  if (!input || !input.trim()) return [];
  const out: Filter[] = [];
  let total = 0;
  for (const rawPart of splitEscaped(input, ";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const m = /^([a-z_]+|(?:prop|user):[A-Za-z0-9_.-]{1,64})\s*(==|!=|!~|~)(.*)$/s.exec(part);
    if (!m) {
      throw new FilterError(`Bad filter "${unescape(part)}". Use key==value, key!=value, key~text or key!~text, separated by ';'.`);
    }
    const key = m[1]!;
    if (!isFilterKey(key))
      throw new FilterError(`Unknown filter key "${key}". Valid: ${BREAKDOWNS.join(", ")}, prop:<key>, user:<key>, did.`);
    const values = splitEscaped(m[3]!, "|").map((v) => unescape(v).trim());
    if (values.some((v) => v === "")) throw new FilterError(`Filter "${key}" has an empty value. Use (none) to match a missing value.`);
    if (values.some((v) => v.length > 500)) throw new FilterError(`Filter "${key}" value is too long (max 500 chars).`);
    total += values.length;
    if (total > MAX_FILTER_VALUES) throw new FilterError(`Too many filter values (max ${MAX_FILTER_VALUES}).`);
    out.push({ key: key as Filter["key"], op: m[2] as FilterOp, values });
  }
  return out;
}

// ------------------------------------------------------------------ nested groups

/**
 * Nested and / or / not groups (filters_json): a leaf is [op, key, values], a group
 * ["and" | "or", [expr, ...]] or ["not", expr]. Same keys, ops and wildcards as the string grammar.
 *   ["or", [["==", "country", ["US"]], ["and", [["~", "page", ["/blog"]], ["!=", "device", ["mobile"]]]]]]
 */
export type FilterExpr = { and: FilterExpr[] } | { or: FilterExpr[] } | { not: FilterExpr } | Filter;

export const MAX_FILTER_DEPTH = 4;
export const MAX_FILTER_LEAVES = 20;

export const isLeaf = (e: FilterExpr): e is Filter => "key" in e;

export function filterLeaves(e: FilterExpr | null | undefined): Filter[] {
  if (!e) return [];
  if (isLeaf(e)) return [e];
  if ("not" in e) return filterLeaves(e.not);
  return ("and" in e ? e.and : e.or).flatMap(filterLeaves);
}

export function parseFilterJson(input: unknown): FilterExpr | null {
  let v = input;
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new FilterError('filters_json is not valid JSON. Example: ["or", [["==","country",["US"]], ["~","page",["/blog"]]]]');
    }
  }
  let leaves = 0;
  let values = 0;
  const walk = (x: unknown, depth: number): FilterExpr => {
    if (depth > MAX_FILTER_DEPTH) throw new FilterError(`filters_json is nested too deeply (max ${MAX_FILTER_DEPTH} levels).`);
    if (!Array.isArray(x) || x.length < 2)
      throw new FilterError('Each filters_json node is ["and"|"or", [...]], ["not", node] or [op, key, [values]].');
    const [head, a, b] = x as [unknown, unknown, unknown];
    if (head === "and" || head === "or") {
      if (!Array.isArray(a) || !a.length || a.length > MAX_FILTER_LEAVES)
        throw new FilterError(`"${head}" takes a list of 1-${MAX_FILTER_LEAVES} nodes.`);
      const items = a.map((n) => walk(n, depth + 1));
      return head === "and" ? { and: items } : { or: items };
    }
    if (head === "not") return { not: walk(a, depth + 1) };
    if (head !== "==" && head !== "!=" && head !== "~" && head !== "!~")
      throw new FilterError(`Unknown filters_json op "${String(head)}". Use and, or, not, ==, !=, ~, !~.`);
    if (typeof a !== "string" || !isFilterKey(a))
      throw new FilterError(`Unknown filter key "${String(a)}". Valid: ${BREAKDOWNS.join(", ")}, prop:<key>, user:<key>, did.`);
    const vals = (Array.isArray(b) ? b : [b]).map((y) => String(y ?? "").trim());
    if (!vals.length || vals.some((y) => !y))
      throw new FilterError(`Filter "${a}" needs non-empty values. Use (none) to match a missing value.`);
    if (vals.some((y) => y.length > 500)) throw new FilterError(`Filter "${a}" value is too long (max 500 chars).`);
    if (++leaves > MAX_FILTER_LEAVES) throw new FilterError(`Too many filters in filters_json (max ${MAX_FILTER_LEAVES}).`);
    values += vals.length;
    if (values > MAX_FILTER_VALUES) throw new FilterError(`Too many filter values (max ${MAX_FILTER_VALUES}).`);
    return { key: a as Filter["key"], op: head, values: vals };
  };
  return walk(v, 1);
}

export function parseMetrics(input: string | null | undefined, fallback: readonly Metric[]): Metric[] {
  if (!input || !input.trim()) return [...fallback];
  const list = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((m) => !(METRICS as readonly string[]).includes(m) && !isCustomMetric(m));
  if (bad.length)
    throw new FilterError(
      `Unknown metric(s): ${bad.join(", ")}. Valid: ${METRICS.join(", ")}, or sum|avg|min|max:prop:<key> (a numeric prop).`,
    );
  if (list.filter(isCustomMetric).length > MAX_CUSTOM_METRICS)
    throw new FilterError(`At most ${MAX_CUSTOM_METRICS} custom metrics (sum|avg|min|max:prop:<key>) at once.`);
  return [...new Set(list)] as Metric[];
}
