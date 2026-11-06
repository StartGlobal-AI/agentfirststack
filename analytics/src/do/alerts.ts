/**
 * The numbers an alert rule needs, read from the site's own data (the cron decides and delivers:
 * lib/alerts.ts, service/alerts.ts). Read-only, and bounded: a handful of aggregates over short
 * windows, and at most MAX_PAYMENTS_PER_ALERT payment rows.
 */

import { BASELINE_DAYS, MAX_PAYMENTS_PER_ALERT, type AlertNumbers, type AlertType } from "../lib/alerts";
import type { Filter, FilterExpr } from "../lib/filters";
import { groupSpecFor, groupedQuery } from "../lib/query";
import type { SiteSettings } from "../lib/types";
import { DAY, type Db, all, checkGoalFilters, ctxFor, guard, num, unknownGoals } from "./common";
import { totals } from "./engine";
import type { VitalMetric } from "../lib/vitals";
import { vitalTotals, vitalsRows } from "./vitals";

/** web_vitals: pages listed with a firing (the highest p75 among those with a few page loads). */
const ALERT_PAGES = 3;
const ALERT_PAGE_MIN_SAMPLES = 5;

export interface AlertCheckRequest {
  type: AlertType;
  window_minutes: number;
  goal?: string | null;
  filters: Filter[];
  where?: FilterExpr | null;
  /** payment: created_at of the last payment already alerted */
  cursor?: number | null;
  /** payment: minimum amount (absolute) */
  threshold?: number | null;
  /** web_vitals: lcp, inp or cls */
  metric?: VitalMetric | null;
}

export function alertNumbers(
  db: Db,
  _settings: SiteSettings,
  q: AlertCheckRequest,
  now = Date.now(),
): AlertNumbers | ReturnType<typeof unknownGoals> {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where) ?? (q.type === "goal" && q.goal ? unknownGoals(db, [q.goal]) : null);
    if (ge) return ge;
    const w = q.window_minutes * 60_000;
    const range = (start: number) => ({ start, end: start + w });
    switch (q.type) {
      case "traffic_spike":
      case "traffic_drop": {
        const visitors = (start: number) => Number(totals(db, ctxFor(db, range(start), q), ["visitors"]).visitors ?? 0);
        const ctx = ctxFor(db, range(now - w), q);
        const top = all(db, groupedQuery(ctx, { ...groupSpecFor("source"), limit: 3 })).map((r) => ({
          value: r.value,
          visitors: num(r.visitors),
        }));
        return {
          visitors: visitors(now - w),
          baseline: Array.from({ length: BASELINE_DAYS }, (_, i) => visitors(now - w - (i + 1) * DAY)),
          top_sources: top,
        };
      }
      case "no_data": {
        const r = db.all(
          `SELECT (SELECT MAX(ts) FROM events WHERE origin != 'payment' AND debug = 0) AS last,
                  (SELECT COUNT(*) FROM events WHERE ts >= ? AND origin != 'payment' AND debug = 0) AS n`,
          [now - w],
        )[0];
        return { last_event_at: r?.last == null ? null : num(r.last), events: num(r?.n) };
      }
      case "goal": {
        const filters: Filter[] = [...q.filters, { key: "goal", op: "==", values: [q.goal ?? ""] }];
        return { conversions: Number(totals(db, ctxFor(db, range(now - w), { filters }), ["conversions"]).conversions ?? 0) };
      }
      case "web_vitals": {
        const metric = q.metric ?? "lcp";
        const ctx = ctxFor(db, range(now - w), q);
        const t = vitalTotals(db, ctx)[metric];
        const pages = t.samples
          ? vitalsRows(db, ctx, groupSpecFor("page", ctx).key, 50)
              .filter((r) => r[metric].samples >= ALERT_PAGE_MIN_SAMPLES && r[metric].p75 != null)
              .sort((a, b) => (b[metric].p75 ?? 0) - (a[metric].p75 ?? 0))
              .slice(0, ALERT_PAGES)
              .map((r) => ({ value: r.value, p75: r[metric].p75, samples: r[metric].samples }))
          : [];
        return { vitals: { metric, p75: t.p75, samples: t.samples, good: t.good, poor: t.poor }, top_pages: pages };
      }
      case "payment": {
        const cursor = q.cursor ?? now;
        const min = Math.max(0, q.threshold ?? 0);
        const head = db.all(
          "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM payments WHERE created_at > ? AND livemode = 1 AND ABS(amount) >= ?",
          [cursor, min],
        )[0];
        const rows = db.all(
          `SELECT p.id, p.type, ABS(p.amount) AS amount, p.currency, p.ts, e.channel, e.source FROM payments p
           LEFT JOIN events e ON e.id = p.event_rowid
           WHERE p.created_at > ? AND p.livemode = 1 AND ABS(p.amount) >= ? ORDER BY p.created_at DESC LIMIT ?`,
          [cursor, min, MAX_PAYMENTS_PER_ALERT],
        );
        return {
          payment_count: num(head?.n),
          cursor: head?.last == null ? cursor : num(head.last),
          payments: rows.map((r) => ({
            id: String(r.id),
            type: String(r.type),
            amount: num(r.amount),
            currency: r.currency == null ? null : String(r.currency),
            ts: num(r.ts),
            channel: r.channel == null ? null : String(r.channel),
            source: r.source == null ? null : String(r.source),
          })),
        };
      }
    }
  });
}
