import { badRequest, parse } from "@afs/shared";
import { INTERVAL_MS, type Interval, type MetricsBy } from "../do/queries";
import { TAG_KEY_RE } from "../lib/derive";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import { type Ctx, loadSite, siteStub } from "./context";
import { METRICS_BY, metricsInput } from "./schemas";
import { resolveFilters } from "./sessions";

const COLUMN: Record<Exclude<(typeof METRICS_BY)[number], "page">, Extract<MetricsBy, { kind: "session" }>["col"]> = {
  referrer: "referrer",
  device: "device",
  browser: "browser",
  os: "os",
  country: "country",
  entry_page: "entry_path",
  exit_page: "exit_path",
};

function parseBy(by: string | undefined): MetricsBy | null {
  if (!by) return null;
  if (by.startsWith("tag:")) {
    const key = by.slice(4);
    if (!TAG_KEY_RE.test(key)) throw badRequest(`by=${by.slice(0, 60)}: the tag key is letters, digits, _ . -.`, "Example: by=tag:plan");
    return { kind: "tag", key };
  }
  if (by === "page") return { kind: "page" };
  if (by in COLUMN) return { kind: "session", col: COLUMN[by as keyof typeof COLUMN] };
  throw badRequest(`by=${by.slice(0, 60)} is not a breakdown.`, `Use one of ${METRICS_BY.join(", ")} or tag:<key>.`);
}

/**
 * GET /v1/sites/:id/metrics (MCP get_replay_metrics): trends over time, optionally per dimension
 * value, with the shared session filters and segment_id. Clarity's export API questions (sessions,
 * pages, referrers, devices, ... per day) with no daily request cap.
 */
export async function getMetrics(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(metricsInput, raw);
  const site = await loadSite(ctx, siteId);
  const f = await resolveFilters(ctx, site, q, "30d");
  const span = f.end - (f.start || Date.now() - site.retention_days * 86_400_000);
  const interval: Interval = q.interval ?? (span <= 2 * 86_400_000 ? "hour" : "day");
  if (span / INTERVAL_MS[interval] > 1000)
    throw badRequest(
      `That period has more than 1,000 ${interval} buckets.`,
      `Use a coarser interval (${interval === "hour" ? "day or week" : "week"}) or a shorter period.`,
    );
  const by = parseBy(q.by);
  const r = await siteStub(ctx.env, site.id).metrics({ ...f, interval, by, limit: q.limit ?? 10 });
  const { breakdown, ...rest } = r as Record<string, unknown> & { breakdown?: unknown[] };
  return {
    site_id: site.id,
    period: { name: f.period, start: f.start, end: f.end },
    ...(f.segment ? { segment: f.segment } : {}),
    interval,
    ...rest,
    ...(by ? { by: q.by, untrusted: { notice: UNTRUSTED_NOTICE, breakdown } } : {}),
    how_to_read: [
      "series: one entry per bucket (UTC; weeks start on Monday), zeros where nothing was recorded. share_with.* = share of the bucket's sessions with that signal.",
      "avg_active_ms: time the visitor was active (input, scroll, pointer or touch activity; gaps over 5 s don't count), vs avg_duration_ms (first to last event).",
      "Counts are recorded sessions only (sampling, consent and the daily caps apply), kept retention_days.",
    ],
    next_steps: [
      `Sessions behind a bucket: GET /v1/sites/${site.id}/sessions?from=<start>&to=<start + interval> with the same filters (MCP search_sessions).`,
    ],
  };
}
