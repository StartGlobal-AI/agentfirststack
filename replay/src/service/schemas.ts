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

export const filtersShape = {
  ...periodShape,
  page: glob.optional().describe('Sessions that visited a page matching this path glob, * = anything: "/checkout*", "/blog/*".'),
  entry_page: glob.optional().describe("Sessions that started on a page matching this glob."),
  exit_page: glob.optional().describe("Sessions whose last page matches this glob (where they left)."),
  signal: z
    .enum(SIGNALS)
    .optional()
    .describe(`Sessions with at least one: ${SIGNALS.join(", ")}.`),
  has_error: bool.optional().describe("true: sessions with a JS error; false: without."),
  device: z.string().max(20).optional().describe("desktop | mobile | tablet"),
  browser: z.string().max(60).optional().describe('e.g. "Chrome", "Mobile Safari", "Firefox" (case-insensitive).'),
  os: z.string().max(60).optional().describe('e.g. "iOS", "Android", "Windows", "Mac OS".'),
  country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2, e.g. US."),
  min_duration: z.coerce.number().min(0).optional().describe("Minimum session duration, seconds."),
  max_duration: z.coerce.number().min(0).optional().describe("Maximum session duration, seconds."),
  min_frustration: int(0, 100).optional().describe("Minimum frustration score 0-100."),
  user_id: z.string().max(200).optional().describe("Sessions identified with afsr('identify', user_id)."),
  analytics_visitor_id: z.string().max(64).optional().describe("Sessions of this analytics visitor (afsa.visitorId())."),
  clicked: z
    .string()
    .max(200)
    .optional()
    .describe('Sessions that clicked an element whose selector contains this text or whose label equals it, e.g. "button.pay".'),
  error_fingerprint: z.string().max(32).optional().describe("Sessions that hit this error group (from list_errors)."),
  event: z.string().max(100).optional().describe("Sessions with this afsr('event', name)."),
  forced: bool.optional().describe("true: only recordings forced with ?afsr=1 (your own tests); false: exclude them."),
};

export const sortField = z
  .enum(["frustration", "recent", "duration"])
  .optional()
  .describe("frustration (default): most frustrated first; recent; duration.");

export const searchInput = z.object({
  ...filtersShape,
  sort: sortField,
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
  kinds: list(z.enum(["page", "click", "input", "scroll", "error", "event", "hide", "idle"]), 8)
    .optional()
    .describe('Only these entry kinds, e.g. "click,error" (comma list or array). Default all.'),
});

export const heatmapInput = z.object({
  ...periodShape,
  page: glob.describe('Path glob of the page(s), e.g. "/pricing" or "/blog/*". Required.'),
  device: z.string().max(20).optional().describe("desktop | mobile | tablet (default all)."),
  type: z.enum(["click", "scroll", "both"]).optional().describe("both (default), click or scroll."),
  limit: int(1, 500).optional().describe("Most elements returned, by clicks (default 50)."),
});

export const errorsInput = z.object({
  ...periodShape,
  page: glob.optional().describe("Only errors on pages matching this glob."),
  device: z.string().max(20).optional(),
  browser: z.string().max(60).optional(),
  fingerprint: z.string().max(32).optional().describe("One error group."),
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
});

export const createLinkInput = z.object({
  session_id: z.string().max(40).describe("rs_... from search_sessions."),
  expires_in: int(60, 30 * 86_400)
    .optional()
    .describe("Seconds until the link stops working (default 604800 = 7 days, max 30 days)."),
});
