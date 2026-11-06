/**
 * What GET /v1/usage needs from a site's Durable Object: the counters its fair-use caps hold, read
 * from small tables only (today's usage rows, the imports list, primary-key and index lookups),
 * never a scan of events. The platform site reads it hourly for every claimed project.
 */

import { type Db, num, utcDay } from "./common";
import { usageOn } from "./engine";
import { userPropKeyCounts } from "./user-props";
import type { ProtectionView } from "./protection";

export interface SiteUsage {
  day: string;
  /** accepted browser events + engagement beacons today (UTC): MAX_EVENTS_PER_SITE_PER_DAY counts these */
  events_today: number;
  /** accepted server events, payments and subscription changes today: MAX_SERVER_EVENTS_PER_SITE_PER_DAY */
  server_events_today: number;
  crawl_hits_today: number;
  export_rows_today: number;
  /** manual annotations (kind note): MAX_ANNOTATIONS_PER_SITE */
  annotations: number;
  cost_rows: number;
  imports: number;
  imported_rows: number;
  user_prop_keys: number;
  browser_user_prop_keys: number;
  /** events quarantined today (UTC): MAX_QUARANTINED_EVENTS_PER_SITE_PER_DAY */
  quarantined_today: number;
  /** set by the DO: the SQLite database's size (MAX_SITE_STORAGE_MB) */
  database_bytes?: number;
  /** set by the DO: attack protection's state, today's busiest network (MAX_EVENTS_PER_NETWORK_PER_SITE_PER_DAY) */
  protection?: ProtectionView;
}

export function siteUsage(db: Db, now = Date.now()): SiteUsage {
  const day = utcDay(now);
  const one = (sql: string, args: string[] = []) => num(db.all(sql, args)[0]?.n);
  const keys = userPropKeyCounts(db);
  const today = usageOn(db, day);
  return {
    day,
    events_today: today.events,
    server_events_today: today.server_events,
    quarantined_today: today.quarantined,
    crawl_hits_today: one("SELECT hits AS n FROM crawl_usage WHERE day = ?", [day]),
    export_rows_today: one("SELECT rows AS n FROM export_usage WHERE day = ?", [day]),
    annotations: one("SELECT COUNT(*) AS n FROM annotations WHERE kind = 'note'"),
    // Bounded by MAX_COST_ROWS_PER_SITE; imported rows are summed from the imports list (each import's row count).
    cost_rows: one("SELECT COUNT(*) AS n FROM costs"),
    imports: one("SELECT COUNT(*) AS n FROM imports"),
    imported_rows: one("SELECT COALESCE(SUM(rows), 0) AS n FROM imports"),
    user_prop_keys: keys.server,
    browser_user_prop_keys: keys.browser,
  };
}
