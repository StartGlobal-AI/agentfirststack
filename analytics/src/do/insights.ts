/**
 * Derived insights (DataFast's bento set) in one call: revenue share by device/OS/browser, daily
 * averages, top revenue and converting sources and countries, days- and visits-to-convert
 * histograms, first-visit conversion rate, median time to convert, top converting events and a
 * day x hour heatmap. The conversion is a new purchase by default, or a goal.
 */

import type { Filter } from "../lib/filters";
import { type Frag, type QueryCtx, evCte, localTsExpr, raw, sql } from "../lib/query";
import { DAYS_TO_CONVERT_BUCKETS, VISITS_TO_CONVERT_BUCKETS, changePercent, histogram, median, withShares } from "../lib/stats-math";
import { buckets, comparisonRange, offsetSegments } from "../lib/time";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { DAY, type Db, all, checkGoalFilters, ctxFor, guard, identityNote, num, periodOut, rangeFor, round, unknownGoals } from "./common";
import { converterStats, targetCond } from "./people";

export interface InsightsRequest extends PeriodParams {
  filters: Filter[];
  goal?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Visitors, converters and revenue per value of `key`, with conversion = `cond` anywhere in the range. */
function perValue(db: Db, ctx: QueryCtx, key: Frag, cond: Frag) {
  return all(
    db,
    sql`WITH ${evCte(ctx)},
    conv AS (SELECT DISTINCT e.visitor_id FROM ev e WHERE ${cond})
    SELECT ${key} AS value,
      COUNT(DISTINCT CASE WHEN e.origin != 'payment' THEN e.visitor_id END) AS visitors,
      COUNT(DISTINCT CASE WHEN e.origin != 'payment' AND e.visitor_id IN (SELECT visitor_id FROM conv) THEN e.visitor_id END) AS converters,
      COALESCE(SUM(e.revenue), 0) AS revenue
    FROM ev e GROUP BY value`,
  ).map((r) => {
    const visitors = num(r.visitors);
    const converters = num(r.converters);
    return {
      value: r.value,
      visitors,
      converters,
      conversion_rate: visitors ? round((converters / visitors) * 100, 1) : 0,
      revenue: round(num(r.revenue), 2),
    };
  });
}

function headline(db: Db, ctx: QueryCtx, cond: Frag) {
  const r = all(
    db,
    sql`WITH ${evCte(ctx)},
    conv AS (SELECT DISTINCT e.visitor_id FROM ev e WHERE ${cond})
    SELECT COUNT(DISTINCT CASE WHEN e.origin != 'payment' THEN e.visitor_id END) AS visitors,
      (SELECT COUNT(*) FROM conv) AS converters,
      COALESCE(SUM(e.revenue), 0) AS revenue
    FROM ev e`,
  )[0];
  const visitors = num(r?.visitors);
  const converters = num(r?.converters);
  const revenue = round(num(r?.revenue), 2);
  return {
    visitors,
    converters,
    revenue,
    conversion_rate: visitors ? round((Math.min(converters, visitors) / visitors) * 100, 1) : 0,
    revenue_per_visitor: visitors ? round(revenue / visitors, 2) : 0,
  };
}

export function insights(db: Db, settings: SiteSettings, q: InsightsRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where) ?? (q.goal ? unknownGoals(db, [q.goal]) : null);
    if (ge) return ge;
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q);
    const cond = targetCond(q.goal);
    const head = headline(db, ctx, cond);
    const prevRange = comparisonRange(r, { mode: "previous" }, now);
    const prev = prevRange ? headline(db, { ...ctx, start: prevRange.start, end: prevRange.end }, cond) : null;
    const days = Math.max(1, buckets(r, "day").filter((b) => b.start <= now).length);

    // daily visitors (distinct per day, averaged), not distinct visitors over the whole range / days
    const segs = offsetSegments(r.start, r.end, r.timezone);
    const local = localTsExpr(segs);
    const daily = all(
      db,
      sql`WITH ${evCte(ctx)} SELECT strftime('%Y-%m-%d', ${local} / 1000, 'unixepoch') AS d, COUNT(DISTINCT e.visitor_id) AS v
      FROM ev e WHERE e.origin != 'payment' GROUP BY d`,
    );
    const share = (dim: "device" | "os" | "browser") =>
      withShares(
        all(
          db,
          sql`WITH ${evCte(ctx)} SELECT COALESCE(e.${raw(dim)}, '(none)') AS value, SUM(e.revenue) AS revenue
          FROM ev e WHERE e.revenue IS NOT NULL GROUP BY value HAVING SUM(e.revenue) > 0 ORDER BY revenue DESC, value LIMIT 10`,
        ).map((x) => ({ value: x.value, revenue: round(num(x.revenue), 2) })),
        "revenue",
      );
    const minVisitors = Math.max(5, Math.ceil(head.visitors * 0.01));
    const ranked = (key: Frag) => {
      const rows = perValue(db, ctx, key, cond);
      return {
        by_revenue: rows
          .filter((x) => x.revenue > 0)
          .sort((a, b) => b.revenue - a.revenue || String(a.value).localeCompare(String(b.value)))
          .slice(0, 5),
        by_conversion_rate: rows
          .filter((x) => x.visitors >= minVisitors && x.converters > 0)
          .sort((a, b) => b.conversion_rate - a.conversion_rate || b.converters - a.converters)
          .slice(0, 5),
      };
    };

    const conv = converterStats(db, ctx, cond);
    const dayCounts = conv.map((c) => Math.floor((c.t - c.first_seen) / DAY));
    const hours = conv.map((c) => (c.t - c.first_seen) / 3_600_000);

    // Events whose doers convert most: custom events only, never the conversion itself.
    const goalRow = q.goal ? db.all("SELECT type, match FROM goals WHERE name = ?", [q.goal])[0] : null;
    const excludeTarget =
      goalRow?.type === "event"
        ? sql`AND e.name != ${String(goalRow.match)}`
        : q.goal
          ? raw("")
          : raw("AND e.name NOT IN (SELECT DISTINCT name FROM ev WHERE revenue IS NOT NULL)");
    const overall = head.conversion_rate;
    const events = all(
      db,
      sql`WITH ${evCte(ctx)},
      conv AS (SELECT DISTINCT e.visitor_id FROM ev e WHERE ${cond})
      SELECT e.name AS event, COUNT(DISTINCT e.visitor_id) AS visitors,
        COUNT(DISTINCT CASE WHEN e.visitor_id IN (SELECT visitor_id FROM conv) THEN e.visitor_id END) AS converted
      FROM ev e WHERE e.origin != 'payment' AND e.name != 'pageview' ${excludeTarget}
      GROUP BY e.name HAVING COUNT(DISTINCT e.visitor_id) >= 3`,
    )
      .map((x) => {
        const visitors = num(x.visitors);
        const converted = num(x.converted);
        const rate = visitors ? round((converted / visitors) * 100, 1) : 0;
        return { event: x.event, visitors, converted, conversion_rate: rate, lift: overall ? round(rate / overall, 2) : null };
      })
      .filter((x) => x.converted > 0)
      .sort((a, b) => b.conversion_rate - a.conversion_rate || b.converted - a.converted)
      .slice(0, 10);

    const cells = all(
      db,
      sql`WITH ${evCte(ctx)} SELECT CAST(strftime('%w', ${local} / 1000, 'unixepoch') AS INTEGER) AS dow,
        CAST(strftime('%H', ${local} / 1000, 'unixepoch') AS INTEGER) AS hour, COUNT(DISTINCT e.visitor_id) AS visitors
      FROM ev e WHERE e.origin != 'payment' GROUP BY dow, hour`,
    );
    const grid = WEEKDAYS.map(() => Array<number>(24).fill(0));
    let peak: { day: string; hour: number; visitors: number } | null = null;
    for (const c of cells) {
      const row = (num(c.dow) + 6) % 7; // SQLite %w: 0 = Sunday; rows start on Monday
      const v = num(c.visitors);
      grid[row]![num(c.hour)] = v;
      if (!peak || v > peak.visitors) peak = { day: WEEKDAYS[row]!, hour: num(c.hour), visitors: v };
    }

    const notes: string[] = [];
    const idn = identityNote(settings);
    if (idn) notes.push(`Days and visits to convert: ${idn}`);
    if (!q.goal && !head.revenue)
      notes.push(
        "No revenue in this period. Connect Stripe (POST /v1/sites/:id/integrations/stripe) or POST /v1/sites/:id/payments, or send revenue with events.",
      );
    return {
      period: periodOut(r),
      filters: q.filters,
      target: q.goal ? { type: "goal", goal: q.goal } : { type: "purchase" },
      kpis: {
        visitors: head.visitors,
        revenue: head.revenue,
        converters: head.converters,
        conversion_rate: head.conversion_rate,
        revenue_per_visitor: head.revenue_per_visitor,
        avg_daily_visitors: round(daily.reduce((a, d) => a + num(d.v), 0) / days, 1),
        avg_daily_revenue: round(head.revenue / days, 2),
        days,
        change_percent: prev
          ? {
              visitors: changePercent(head.visitors, prev.visitors),
              revenue: changePercent(head.revenue, prev.revenue),
              conversion_rate: changePercent(head.conversion_rate, prev.conversion_rate),
              revenue_per_visitor: changePercent(head.revenue_per_visitor, prev.revenue_per_visitor),
            }
          : null,
      },
      revenue_share: { device: share("device"), os: share("os"), browser: share("browser") },
      top_sources: { ...ranked(raw("COALESCE(e.source, e.channel)")), min_visitors: minVisitors },
      top_countries: { ...ranked(raw("COALESCE(e.country, '(none)')")), min_visitors: minVisitors },
      time_to_convert: {
        converters: conv.length,
        first_visit_rate: conv.length ? round((conv.filter((c) => c.visits === 1).length / conv.length) * 100, 1) : null,
        median_hours: conv.length ? round(median(hours) ?? 0, 1) : null,
        median_visits: median(conv.map((c) => c.visits)),
        days_histogram: histogram(dayCounts, DAYS_TO_CONVERT_BUCKETS),
        visits_histogram: histogram(
          conv.map((c) => c.visits),
          VISITS_TO_CONVERT_BUCKETS,
        ),
      },
      top_converting_events: events,
      heatmap: { metric: "visitors", timezone: r.timezone, days: WEEKDAYS, hours: [...Array(24).keys()], values: grid, peak },
      ...(notes.length ? { notes } : {}),
    };
  });
}
