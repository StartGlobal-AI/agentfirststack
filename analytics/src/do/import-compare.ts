/**
 * Do our numbers line up with the old tool's? Its imported daily visitors (kind visitors) against
 * our live daily visitors (as reports count them: test traffic left out) on the complete days both
 * have: after the first day of live visitors (the tracker started partway through it) and before
 * today (not over yet), the latest MAX_COMPARE_DAYS of them.
 */

import type { ImportSource } from "../lib/imports";
import { addDays, localDay, parseYmd, ymdString } from "../lib/time";
import { type SiteSettings, isDoError } from "../lib/types";
import type { Db } from "./common";
import { timeseries } from "./engine";
import { importedDailyVisitors, latestVisitorsImport } from "./imports";

export const MIN_OVERLAP_DAYS = 3;
export const MAX_COMPARE_DAYS = 90;
/** live / imported within this range is "close". */
export const CLOSE_RATIO = { min: 0.75, max: 1.25 } as const;

export type CompareVerdict = "close" | "lower" | "higher" | "not_enough_overlap";

export interface CompareRequest {
  source?: ImportSource;
  tool?: string;
}

const labelOf = (source: ImportSource | null, tool: string | null) =>
  source === "other" ? (tool ?? "the old tool") : source === "ga4" ? "GA4" : source === "plausible" ? "Plausible" : "the old tool";

const CAUSES =
  "Tools rarely agree exactly: they filter bots differently, a consent banner can hold one tool back and not the other, ad blockers block some tools' scripts (our first-party proxy avoids most), the snippet may be missing from some pages or subdomains, and cookieless visitors (ours by default) are counted again when their network or browser changes, where a cookie tool keeps one visitor.";

/** The first day (site timezone) with a live visitor: no payments, test traffic or visit-less server events. */
function firstVisitorDay(db: Db, tz: string): string | null {
  const t = db.all("SELECT ts FROM events WHERE origin != 'payment' AND debug = 0 AND no_visit = 0 ORDER BY ts LIMIT 1")[0]?.ts;
  return t == null ? null : ymdString(localDay(Number(t), tz));
}

function importExample(siteId: string, source: ImportSource | null, tool: string | null, from: string, to: string): string {
  const p = `POST /v1/sites/${siteId}/imports`;
  if (source === "ga4")
    return `${p} {"source":"ga4","report":<runReport with dateRanges [{"startDate":"${from}","endDate":"${to}"}], dimensions [{"name":"date"}], metrics activeUsers, sessions, screenPageViews>}`;
  if (source === "plausible")
    return `${p} {"source":"plausible","report":<POST /api/v2/query {"date_range":["${from}","${to}"],"dimensions":["time:day"],"metrics":["visitors","visits","pageviews"]}>}`;
  return `${p} {"source":"other","tool":"${tool ?? "<tool>"}","rows":[{"date":"${from}","visitors":<n>}, ... one per day to ${to}]} (or source ga4 / plausible with their report)`;
}

export function compareImports(db: Db, settings: SiteSettings, q: CompareRequest, now = Date.now()) {
  const tz = settings.timezone || "UTC";
  const siteId = settings.id;
  const live = firstVisitorDay(db, tz);
  const yesterday = ymdString(addDays(localDay(now, tz), -1));
  const from = live ? ymdString(addDays(parseYmd(live)!, 1)) : null;
  const candidates = (from && from <= yesterday ? importedDailyVisitors(db, from, yesterday) : []).filter(
    (c) => (!q.source || c.source === q.source) && (!q.tool || c.tool === q.tool),
  );
  // Default: the source with the most overlapping days (then the most recently imported).
  const best = candidates.sort((a, b) => b.days.size - a.days.size || b.updated_at - a.updated_at)[0] ?? null;
  // Nothing overlaps: name the tool asked for, else the latest daily-visitors import (to say what to import).
  const named =
    best ??
    (q.source && q.tool
      ? { source: q.source, tool: q.tool }
      : (latestVisitorsImport(db, q.source) ?? (q.source ? { source: q.source, tool: null } : null)));
  const source = named?.source ?? null;
  const tool = named?.tool ?? null;
  const label = labelOf(source, tool);

  const dates = best ? [...best.days.keys()].sort().slice(-MAX_COMPARE_DAYS) : [];
  const liveByDay = new Map<string, number>();
  if (dates.length) {
    const ts = timeseries(db, settings, { from: dates[0], to: dates.at(-1), interval: "day", metrics: ["visitors"], filters: [] }, now);
    if (isDoError(ts)) return ts;
    for (const r of (ts as { results: { date: string; visitors?: unknown }[] }).results) liveByDay.set(r.date, Number(r.visitors) || 0);
  }
  const days = dates.map((date) => ({ date, imported_visitors: best!.days.get(date) ?? 0, live_visitors: liveByDay.get(date) ?? 0 }));
  const imported = days.reduce((s, d) => s + d.imported_visitors, 0);
  const counted = days.reduce((s, d) => s + d.live_visitors, 0);
  const ratio = days.length && imported > 0 ? Math.round((counted / imported) * 100) / 100 : null;
  const verdict: CompareVerdict =
    days.length < MIN_OVERLAP_DAYS
      ? "not_enough_overlap"
      : ratio == null
        ? counted > 0
          ? "higher"
          : "not_enough_overlap"
        : ratio < CLOSE_RATIO.min
          ? "lower"
          : ratio > CLOSE_RATIO.max
            ? "higher"
            : "close";

  const span = days.length ? `${days[0]!.date} to ${days.at(-1)!.date}` : "";
  const keep = `Keep ${label} installed until the verdict is close.`;
  const compareAgain = `GET /v1/sites/${siteId}/imports/compare${source ? `?source=${source}${tool ? `&tool=${tool}` : ""}` : ""} again after importing more days.`;
  let note: string;
  const next_steps: string[] = [];
  if (verdict === "not_enough_overlap") {
    const ready = live ? ymdString(addDays(parseYmd(live)!, MIN_OVERLAP_DAYS + 1)) : null;
    note = !live
      ? `No live visitors yet, so there is nothing to compare ${label} with. ${keep}`
      : `${days.length} complete day${days.length === 1 ? "" : "s"} since live data began (${live}) ${days.length === 1 ? "has" : "have"} ${label}'s imported daily visitors too; ${MIN_OVERLAP_DAYS} are needed (the first live day and today are left out: they are partial). ${CAUSES} ${keep}`;
    if (!live) next_steps.push(`Install the tracker (GET /v1/sites/${siteId}/install) and check it (POST /v1/sites/${siteId}/verify).`);
    else if (from && from <= yesterday)
      next_steps.push(
        `Import ${label}'s daily visitors for ${from} to ${yesterday}: ${importExample(siteId, source, tool, from, yesterday)}.`,
      );
    if (ready && ready > ymdString(localDay(now, tz)))
      next_steps.push(`Come back on or after ${ready}, when ${MIN_OVERLAP_DAYS} complete days of live data exist.`);
    if (live) next_steps.push(compareAgain);
  } else {
    const pct = ratio == null ? null : Math.round(Math.abs(1 - ratio) * 100);
    const over = `over ${days.length} days (${span}, ratio ${ratio ?? "n/a"})`;
    if (verdict === "close") {
      note = `Our daily visitors are within 25% of ${label}'s ${over}. ${CAUSES} A gap this size is normal: ${label} can be removed when you are ready.`;
      next_steps.push(
        `Remove ${label}'s script when you no longer need it; its history stays in reports with imported=true (GET /v1/sites/${siteId}/stats?period=12mo&imported=true).`,
      );
    } else if (verdict === "lower") {
      note = `We count ${pct}% fewer visitors than ${label} ${over}. ${CAUSES} A lower count most often means pages without the snippet, or an ad blocker or consent banner holding our script back. ${keep}`;
      next_steps.push(
        `GET /v1/sites/${siteId}/breakdown?breakdown=page&from=${days[0]!.date}&to=${days.at(-1)!.date}: pages ${label} shows that are missing or low here usually lack the snippet.`,
        `GET /v1/sites/${siteId}/breakdown?breakdown=hostname&from=${days[0]!.date}&to=${days.at(-1)!.date}: a subdomain ${label} tracks may be missing here (the snippet, or allowed_hostnames).`,
        `GET /v1/sites/${siteId}/install: serve the script first-party (first_party_proxy) so ad blockers don't drop it, and check that no consent banner holds it back.`,
        compareAgain,
      );
    } else {
      note = `We count ${pct == null ? "more" : `${pct}% more`} visitors than ${label} ${over}. ${CAUSES} A higher count most often means ${label} loses visitors to its consent banner or to ad blockers, or counts with cookies where we count cookieless; it can also be bots or internal traffic we keep. ${keep}`;
      next_steps.push(
        `GET /v1/sites/${siteId}/breakdown?breakdown=hostname&from=${days[0]!.date}&to=${days.at(-1)!.date}: staging or preview hosts counted here can be left out with allowed_hostnames (PATCH /v1/sites/${siteId}).`,
        `GET /v1/sites/${siteId}/exclusions: leave out internal traffic (office IPs, monitoring) with exclusions.`,
        compareAgain,
      );
    }
  }
  return { source, tool, overlap_days: days.length, days, ratio, verdict, note, next_steps, live_data_from: live };
}
