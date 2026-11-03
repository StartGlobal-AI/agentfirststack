/**
 * Dimensions (breakdowns + filters), metrics, and the filter grammar:
 *   filters=country==US;page~/blog;channel!=Direct;country==US|CA;prop:plan==pro;utm_source==(none)
 * ops: == equals, != not equals, ~ contains (case-insensitive), !~ does not contain.
 * `|` separates alternatives (OR). `(none)` matches a missing value. `\;` and `\|` escape.
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
] as const;
export type Metric = (typeof METRICS)[number];

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
  "click_id_type",
  "country",
  "region",
  "city",
  "continent",
  "browser",
  "browser_version",
  "os",
  "device",
  "event_name",
  "goal",
] as const;
export type Breakdown = (typeof BREAKDOWNS)[number] | `prop:${string}`;

/** Dimension -> SQL over `events e` (and `sessions s` for entry/exit page). Never user input. */
export const DIMENSION_SQL: Record<Exclude<(typeof BREAKDOWNS)[number], "goal">, string> = {
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
  click_id_type: "e.click_id_type",
  country: "e.country",
  region: "e.region",
  city: "e.city",
  continent: "e.continent",
  browser: "e.browser",
  browser_version: "e.browser_version",
  os: "e.os",
  device: "e.device",
  event_name: "e.name",
};

export const PROP_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export type FilterOp = "==" | "!=" | "~" | "!~";

export interface Filter {
  key: (typeof BREAKDOWNS)[number] | `prop:${string}`;
  op: FilterOp;
  values: string[];
}

export class FilterError extends Error {}

export const NONE = "(none)";
export const MAX_FILTER_VALUES = 30;

export function isBreakdown(key: string): key is Breakdown {
  if (key.startsWith("prop:")) return PROP_KEY_RE.test(key.slice(5));
  return (BREAKDOWNS as readonly string[]).includes(key);
}

function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && (s[i + 1] === ";" || s[i + 1] === "|" || s[i + 1] === "\\")) {
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

const unescape = (s: string) => s.replace(/\\([;|\\])/g, "$1");

export function parseFilters(input: string | null | undefined): Filter[] {
  if (!input || !input.trim()) return [];
  const out: Filter[] = [];
  let total = 0;
  for (const rawPart of splitEscaped(input, ";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const m = /^([a-z_]+|prop:[A-Za-z0-9_.-]{1,64})\s*(==|!=|!~|~)(.*)$/s.exec(part);
    if (!m) {
      throw new FilterError(`Bad filter "${unescape(part)}". Use key==value, key!=value, key~text or key!~text, separated by ';'.`);
    }
    const key = m[1]!;
    if (!isBreakdown(key)) throw new FilterError(`Unknown filter key "${key}". Valid: ${BREAKDOWNS.join(", ")}, prop:<key>.`);
    const values = splitEscaped(m[3]!, "|").map((v) => unescape(v).trim());
    if (values.some((v) => v === "")) throw new FilterError(`Filter "${key}" has an empty value. Use (none) to match a missing value.`);
    if (values.some((v) => v.length > 500)) throw new FilterError(`Filter "${key}" value is too long (max 500 chars).`);
    total += values.length;
    if (total > MAX_FILTER_VALUES) throw new FilterError(`Too many filter values (max ${MAX_FILTER_VALUES}).`);
    out.push({ key: key as Filter["key"], op: m[2] as FilterOp, values });
  }
  return out;
}

export function parseMetrics(input: string | null | undefined, fallback: readonly Metric[]): Metric[] {
  if (!input || !input.trim()) return [...fallback];
  const list = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((m) => !(METRICS as readonly string[]).includes(m));
  if (bad.length) throw new FilterError(`Unknown metric(s): ${bad.join(", ")}. Valid: ${METRICS.join(", ")}.`);
  return [...new Set(list)] as Metric[];
}
