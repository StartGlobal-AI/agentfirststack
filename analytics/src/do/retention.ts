/**
 * Retention cohorts: identities grouped by when they were first seen (day, week or month, site
 * timezone), and how many came back in each later period, optionally split by first touch.
 *
 * Who counts: in persistent mode every identity (visitor ids are stable); in cookieless mode only
 * identified users (user:<id>), because an anonymous visitor id rotates daily and could never
 * "return". An identified visitor id counts as its user, so a user's visits before and after
 * signing up are one person.
 */

import { type Filter, FIRST_TOUCH_DIMS } from "../lib/filters";
import { type Frag, bucketKey, join, raw, sql, valueCond } from "../lib/query";
import { type Interval, addDays, addMonths, buckets, localDay, offsetSegments, ymdString, zonedToUtc } from "../lib/time";
import type { SiteSettings } from "../lib/types";
import { type Db, all, err, guard, identityNote, num, round } from "./common";
import { sessionIdent } from "./identities";

export const RETENTION_INTERVALS = ["day", "week", "month"] as const;
export type RetentionInterval = (typeof RETENTION_INTERVALS)[number];
export const MAX_PERIODS: Record<RetentionInterval, number> = { day: 31, week: 26, month: 24 };

export type FirstTouchDim = (typeof FIRST_TOUCH_DIMS)[number];
const DIM_COL: Record<FirstTouchDim, string> = {
  first_channel: "channel",
  first_source: "source",
  first_referrer: "referrer",
  first_utm_source: "utm_source",
  first_utm_medium: "utm_medium",
  first_utm_campaign: "utm_campaign",
  first_entry_page: "entry_page",
};

export interface RetentionRequest {
  interval: RetentionInterval;
  periods: number;
  breakdown?: FirstTouchDim;
  /** only first_* keys */
  filters: Filter[];
  timezone?: string;
}

/** The first day of the period `n` periods before the one containing `now`. */
function cohortStart(interval: RetentionInterval, tz: string, now: number, n: number): number {
  const today = localDay(now, tz);
  let d = today;
  if (interval === "day") d = addDays(today, -n);
  else if (interval === "week") {
    const dow = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
    d = addDays(today, -((dow + 6) % 7) - 7 * n);
  } else d = addMonths({ y: today.y, m: today.m, d: 1 }, -n);
  return zonedToUtc(d.y, d.m, d.d, 0, tz);
}

export function retention(db: Db, settings: SiteSettings, q: RetentionRequest, now = Date.now()) {
  return guard(() => {
    const bad = q.filters.find((f) => !(FIRST_TOUCH_DIMS as readonly string[]).includes(f.key));
    if (bad)
      return err(
        "bad_request",
        `Retention filters work on first-touch keys only (not "${bad.key}").`,
        `Use ${FIRST_TOUCH_DIMS.join(", ")}, e.g. filters=first_channel==Organic Search.`,
      );
    const tz = q.timezone || settings.timezone;
    const persistent = settings.visitor_id_mode === "persistent";
    const start = cohortStart(q.interval, tz, now, q.periods - 1);
    const segs = offsetSegments(start, now + 1, tz);
    const cb = bucketKey(q.interval as Interval, segs, "i.first_seen");
    const ab = bucketKey(q.interval as Interval, segs, "s.started_at");
    const dim = q.breakdown ? raw(`COALESCE(i.${DIM_COL[q.breakdown]}, '(none)')`) : raw("NULL");
    const conds: Frag[] = [sql`i.canonical IS NULL AND i.first_seen >= ${start} AND i.first_seen <= ${now}`];
    if (!persistent) conds.push(raw("i.ident LIKE 'user:%'"));
    for (const f of q.filters) conds.push(valueCond(raw(`i.${DIM_COL[f.key as FirstTouchDim]}`), f.op, f.values));
    const coh = sql`coh AS (SELECT i.ident, ${cb} AS cb, ${dim} AS dim FROM identities i WHERE ${join(conds, " AND ")})`;
    const act = sql`act AS (SELECT DISTINCT ${raw(sessionIdent(!!settings.trust_browser_user_id))} AS ident, ${ab} AS b FROM sessions s WHERE s.last_seen_at >= ${start} AND s.started_at <= ${now})`;
    const sizes = all(db, sql`WITH ${coh} SELECT cb, dim, COUNT(*) AS n FROM coh GROUP BY cb, dim ORDER BY cb, n DESC`);
    const back = all(
      db,
      sql`WITH ${coh}, ${act}
      SELECT coh.cb, coh.dim, act.b, COUNT(DISTINCT coh.ident) AS n FROM coh JOIN act ON act.ident = coh.ident AND act.b >= coh.cb
      GROUP BY coh.cb, coh.dim, act.b`,
    );
    const labels = buckets(
      {
        period: "custom",
        timezone: tz,
        from: ymdString(localDay(start, tz)),
        to: ymdString(localDay(now, tz)),
        start,
        end: now + 1,
        interval: q.interval as Interval,
      },
      q.interval as Interval,
    ).map((b) => b.label);
    const index = new Map(labels.map((l, i) => [l, i]));
    const key = (c: unknown, d: unknown) => `${String(c)}\u001f${String(d ?? "")}`;
    const retained = new Map<string, number[]>();
    for (const r of back) {
      const i = index.get(String(r.cb));
      const j = index.get(String(r.b));
      if (i == null || j == null || j < i) continue;
      const k = key(r.cb, r.dim);
      const arr = retained.get(k) ?? new Array(labels.length - i).fill(0);
      arr[j - i] = num(r.n);
      retained.set(k, arr);
    }
    const cohorts = sizes.map((s) => {
      const i = index.get(String(s.cb)) ?? 0;
      const size = num(s.n);
      const counts = retained.get(key(s.cb, s.dim)) ?? new Array(labels.length - i).fill(0);
      counts[0] = size; // everyone is active in the period they were first seen
      return {
        cohort: String(s.cb),
        ...(q.breakdown ? { [q.breakdown]: s.dim } : {}),
        size,
        retained: counts,
        rates: counts.map((c) => (size ? round((c / size) * 100, 1) : 0)),
        complete_periods: Math.max(0, counts.length - 1),
      };
    });
    return {
      interval: q.interval,
      periods: q.periods,
      timezone: tz,
      start,
      ...(q.breakdown ? { breakdown: q.breakdown } : {}),
      filters: q.filters,
      population: persistent ? "all_visitors" : "identified_users",
      cohorts,
      identity: {
        mode: settings.visitor_id_mode,
        note: persistent
          ? null
          : `${identityNote(settings)} Retention therefore counts identified users only (user_id); anonymous visitors can't come back under the same id.`,
      },
      note: "retained[k] = identities of the cohort with a session k periods after the one they were first seen in; the last period of each cohort is still in progress.",
    };
  });
}
