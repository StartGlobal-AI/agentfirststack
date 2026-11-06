import { z } from "zod";
import { SIGNALS } from "../lib/signals";
import { PERIODS } from "../lib/time";

/** Shared input pieces. REST query strings arrive as strings, so numbers coerce and booleans accept "true"/"false". */

export const bool = z.preprocess((v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v), z.boolean());
export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** A comma-separated string (REST) or an array (MCP, JSON). */
export const list = <T extends z.ZodType<string>>(item: T, max: number) =>
  z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(item).max(max),
  );

export const periodShape = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe(`${PERIODS.join(" | ")}. Ignored when from/to are given.`),
  from: z.union([z.string(), z.number()]).optional().describe("Start: unix ms, unix seconds or ISO 8601 (2026-11-01)."),
  to: z.union([z.string(), z.number()]).optional().describe("End (default now). A bare date means the end of that day."),
};

const glob = z.string().min(1).max(500);
const NOT = ' A leading "!" negates.';

export const filtersShape = {
  ...periodShape,
  segment_id: z
    .string()
    .max(40)
    .optional()
    .describe("A saved segment (seg_... from create_segment): its filters apply, and filters you pass here override the same ones."),
  page: glob
    .optional()
    .describe(
      `Sessions that visited a page matching this path glob, * = anything: "/checkout*", "/blog/*".${NOT} "!/admin*" = never visited one.`,
    ),
  entry_page: glob.optional().describe(`Sessions that started on a page matching this glob.${NOT}`),
  exit_page: glob.optional().describe(`Sessions whose last page matches this glob (where they left).${NOT}`),
  referrer: z
    .string()
    .min(1)
    .max(253)
    .optional()
    .describe(`The entry page's referrer: an external hostname ("google.com", "*.google.*") or a same-site path glob.${NOT}`),
  signal: z
    .enum(SIGNALS)
    .optional()
    .describe(`Sessions with at least one: ${SIGNALS.join(", ")}.`),
  has_error: bool.optional().describe("true: sessions with a JS error; false: without."),
  device: z.string().max(20).optional().describe(`desktop | mobile | tablet.${NOT}`),
  browser: z.string().max(60).optional().describe(`e.g. "Chrome", "Mobile Safari", "Firefox" (case-insensitive).${NOT}`),
  os: z.string().max(60).optional().describe(`e.g. "iOS", "Android", "Windows", "Mac OS".${NOT}`),
  country: z
    .string()
    .regex(/^!?[A-Za-z]{2}$/, "ISO 3166-1 alpha-2, e.g. US or !US")
    .optional()
    .describe(`ISO 3166-1 alpha-2, e.g. US; "!US" = every other country.`),
  region: z.string().max(100).optional().describe(`Region as Cloudflare names it (e.g. "California"), case-insensitive.${NOT}`),
  city: z.string().max(100).optional().describe(`City as Cloudflare names it, case-insensitive.${NOT}`),
  min_pageviews: int(0, 1000).optional().describe("Sessions with at least this many pageviews."),
  min_active: z.coerce
    .number()
    .min(0)
    .optional()
    .describe("Minimum active time, seconds (input, scroll or pointer activity, gaps up to 5 s)."),
  min_scroll_pct: int(0, 100).optional().describe("Sessions that scrolled some page at least this far (% of the page)."),
  min_duration: z.coerce.number().min(0).optional().describe("Minimum session duration, seconds."),
  max_duration: z.coerce.number().min(0).optional().describe("Maximum session duration, seconds."),
  min_frustration: int(0, 100).optional().describe("Minimum frustration score 0-100."),
  user_id: z.string().max(200).optional().describe("Sessions identified with afsr('identify', user_id)."),
  analytics_visitor_id: z.string().max(64).optional().describe("Sessions of this analytics visitor (afsa.visitorId())."),
  clicked: z
    .string()
    .max(200)
    .optional()
    .describe(`Sessions that clicked an element whose selector contains this text or whose label equals it, e.g. "button.pay".${NOT}`),
  error_fingerprint: z.string().max(33).optional().describe(`Sessions that hit this error group (from list_errors).${NOT}`),
  event: z.string().max(101).optional().describe(`Sessions with this afsr('event', name).${NOT}`),
  forced: bool.optional().describe("true: only recordings forced with ?afsr=1 (your own tests); false: exclude them."),
  starred: bool.optional().describe("true: starred sessions (label_session); false: the rest."),
  upgraded: bool.optional().describe("true: sessions recorded because the page called afsr('upgrade', reason); false: the rest."),
  active: bool.optional().describe("true: sessions in progress (a chunk arrived in the last 2 minutes)."),
  label: z.string().max(41).optional().describe('Sessions with this label (a leading "!" = without it).'),
  survey_id: z.string().max(40).optional().describe("Sessions with a response to this survey (rsv_...): read what respondents did."),
  survey_answer: z
    .string()
    .max(230)
    .optional()
    .describe('With survey_id: the answer matches, "q1<=6" (detractors), "q1>=9", "q2=Pricing", "q2!=Pricing" (multi choice: contains).'),
  tag: list(z.string().min(1).max(160), 10)
    .optional()
    .describe(
      'Custom tags (afsr(\'set\'), identify attributes), all must hold: "plan:pro" (key = value), "plan" (has the key), "!exp:B" (must not). Comma list or array.',
    ),
};

/**
 * Session filters a heatmap or error list also accepts, besides its own page/device/browser (which
 * keep their event-level meaning there): they restrict the clicks or errors to matching sessions.
 */
export const SESSION_ONLY_FILTERS = [
  "segment_id",
  "entry_page",
  "referrer",
  "region",
  "city",
  "min_pageviews",
  "min_scroll_pct",
  "min_active",
  "exit_page",
  "signal",
  "has_error",
  "os",
  "country",
  "min_duration",
  "max_duration",
  "min_frustration",
  "user_id",
  "analytics_visitor_id",
  "clicked",
  "error_fingerprint",
  "event",
  "forced",
  "starred",
  "upgraded",
  "active",
  "label",
  "tag",
  "survey_id",
  "survey_answer",
] as const;
type SessionOnly = (typeof SESSION_ONLY_FILTERS)[number];
export const sessionOnlyShape = Object.fromEntries(SESSION_ONLY_FILTERS.map((k) => [k, filtersShape[k as keyof typeof filtersShape]])) as {
  [K in SessionOnly]: (typeof filtersShape)[K];
};

export const sortField = z
  .enum(["frustration", "recent", "duration", "clicks", "pageviews", "active"])
  .optional()
  .describe("frustration (default): most frustrated first; recent; duration; clicks; pageviews; active (active time).");

export const searchInput = z.object({
  ...filtersShape,
  sort: sortField,
  format: z
    .enum(["json", "csv", "ndjson"])
    .optional()
    .describe("json (default, paged) or an export: csv / ndjson of every matching session up to MAX_EXPORT_ROWS."),
  limit: int(1, 100).optional().describe("Sessions per page (default 20, max 100)."),
  cursor: z.string().max(400).optional().describe("next_cursor from the previous page."),
});

export const summarizeInput = z.object({
  ...filtersShape,
  session_ids: list(z.string().max(40), 500).optional().describe("Summarize exactly these sessions (max 500) instead of filtering."),
  sort: sortField,
  limit: int(1, 1000).optional().describe("Most sessions considered when filtering (default 200, max 1000), taken in `sort` order."),
  top: int(1, 25).optional().describe("Rows per group (default 10)."),
});

export const transcriptInput = z.object({
  format: z.enum(["text", "json"]).optional().describe("text (default): one line per event; json: structured timeline."),
  max_events: int(1, 5000).optional().describe("Most derived events returned (default 500, max 5000). Pages always come with them."),
  kinds: list(z.enum(["page", "click", "input", "scroll", "error", "event", "hide", "idle", "tag", "net", "warn", "survey", "note"]), 13)
    .optional()
    .describe('Only these entry kinds, e.g. "click,error" (comma list or array). Default all.'),
});

export const heatmapInput = z.object({
  ...periodShape,
  ...sessionOnlyShape,
  page: glob.describe('Path glob of the page(s), e.g. "/pricing" or "/blog/*". Required.'),
  device: z.string().max(20).optional().describe("desktop | mobile | tablet (default all)."),
  type: z
    .enum(["click", "scroll", "both", "attention"])
    .optional()
    .describe("both (default), click, scroll, or attention (time each 10% band of the page was in view, with its clicks)."),
  group_by: z.enum(["element", "zone"]).optional().describe("element (default) or zone (the site's zones and landmarks)."),
  click: z
    .enum(["all", "first", "last"])
    .optional()
    .describe("all (default) clicks, or only each pageview's first / last click (live data)."),
  sort: z.enum(["clicks", "rage", "dead", "error"]).optional().describe("Elements by clicks (default), rage, dead or error clicks."),
  converted_event: z
    .string()
    .max(100)
    .optional()
    .describe("An afsr('event') name: per element, the share of its clicking sessions that later fired it (conversion map; live data)."),
  compare: z
    .string()
    .max(80)
    .optional()
    .describe('"previous" (the period just before, same length) or "<from>..<to>": per element click_share_delta and scroll reach deltas.'),
  compare_device: z.string().max(20).optional().describe("Compare with another device class (same period)."),
  compare_segment_id: z.string().max(40).optional().describe("Compare with the sessions of another segment (same period)."),
  format: z.enum(["json", "csv"]).optional().describe("json (default) or csv (the elements)."),
  limit: int(1, 500).optional().describe("Most elements returned (default 50)."),
});

export const errorsInput = z.object({
  ...periodShape,
  ...sessionOnlyShape,
  page: glob.optional().describe("Only errors on pages matching this glob."),
  device: z.string().max(20).optional(),
  browser: z.string().max(60).optional(),
  fingerprint: z.string().max(32).optional().describe("One error group."),
  kind: z
    .enum(["js", "network", "console_warn", "all"])
    .optional()
    .describe(
      "js (default): uncaught errors, rejections, console.error; network: failed requests; console_warn: console.warn (opt-in); all.",
    ),
  limit: int(1, 50).optional().describe("Most error groups (default 20)."),
});

export const funnelInput = z.object({
  ...filtersShape,
  steps: list(z.string().min(1).max(500), 8)
    .optional()
    .describe(
      '2-8 ordered steps: "/pricing" or "page:/pricing" (path glob), "event:checkout_started" (afsr(\'event\')). Comma list or array.',
    ),
  analytics_funnel_id: z
    .string()
    .max(40)
    .optional()
    .describe("Use the steps of a saved funnel of the linked analytics site instead (page and event steps)."),
  drop_step: int(1, 8)
    .optional()
    .describe(
      "Return the sessions that reached this step (1-based) but not the next, most frustrated first, with what they had in common.",
    ),
  limit: int(1, 100).optional().describe("Most dropped sessions listed (default 20)."),
});

export const deleteVisitorInput = z.object({
  user_id: z.string().max(200).optional().describe("Every session identified with this user id."),
  analytics_visitor_id: z.string().max(64).optional().describe("Every session of this analytics visitor id."),
  session_ids: list(z.string().max(40), 500).optional().describe("These sessions."),
  email: z
    .string()
    .max(254)
    .optional()
    .describe(
      "Survey responses holding this address (an email question's answer, or a text answer that is exactly it), and the sessions they are linked to.",
    ),
});

export const createLinkInput = z.object({
  session_id: z.string().max(40).describe("rs_... from search_sessions."),
  expires_in: int(60, 30 * 86_400)
    .optional()
    .describe("Seconds until the link stops working (default 86400 = 1 day, max 30 days)."),
  start_ms: int(0, 24 * 3_600_000)
    .optional()
    .describe("A clip: play from here (ms since the session started)."),
  end_ms: int(1, 24 * 3_600_000)
    .optional()
    .describe("A clip: stop here. Only the recording of the window is served."),
  note: z.string().max(500).optional().describe("Shown above the player (e.g. what to look at)."),
});

/** A saved segment's filters: the session filters, without segment_id (no nesting) and session_ids. */
const { segment_id: _seg, ...segmentShape } = filtersShape;
export const segmentFilters = z.object(segmentShape).strict();

export const createSegmentInput = z.object({
  name: z.string().min(1).max(100).describe("Natural key per site: the same name again returns the existing segment."),
  filters: segmentFilters.describe('The session filters, as for search_sessions, e.g. {"tag":["plan:pro"],"device":"mobile"}.'),
});
export const updateSegmentInput = z.object({
  name: z.string().min(1).max(100).optional(),
  filters: segmentFilters.optional().describe("Replaces the whole filter set."),
});

export const METRICS_BY = ["page", "referrer", "device", "browser", "os", "country", "entry_page", "exit_page"] as const;

export const metricsInput = z.object({
  ...filtersShape,
  interval: z
    .enum(["hour", "day", "week"])
    .optional()
    .describe("Bucket size, UTC (default day; hour when the period is 48 h or less). At most 1,000 buckets."),
  by: z
    .string()
    .max(60)
    .optional()
    .describe(
      `Break down by ${METRICS_BY.join(" | ")} | tag:<key> (top values, each with its own series). page is per pageview (dwell, active time, scroll, quick backs); the others per session.`,
    ),
  limit: int(1, 50).optional().describe("Most breakdown values (default 10)."),
});
