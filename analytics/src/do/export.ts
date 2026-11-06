/**
 * Bulk raw export: the site's events in a time range, oldest id first, one bounded page per call
 * with a cursor (the last event id), held to a daily row budget of its own (export_usage).
 */

import type { Db } from "./common";
import { num } from "./common";

export const EXPORT_SQL = ["CREATE TABLE IF NOT EXISTS export_usage (day TEXT PRIMARY KEY, rows INTEGER NOT NULL DEFAULT 0)"];

export const EXPORT_COLUMNS = [
  "id",
  "ts",
  "name",
  "origin",
  "visitor_id",
  "session_id",
  "user_id",
  "hostname",
  "pathname",
  "url",
  "title",
  "referrer",
  "source",
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
  "timezone",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device",
  "language",
  "screen",
  "props",
  "revenue",
  "currency",
  "revenue_type",
  "engagement_ms",
  "scroll_depth",
  "lcp",
  "inp",
  "cls",
  "debug",
  "no_visit",
] as const;

export interface ExportRequest {
  start: number;
  end: number;
  /** last id of the previous page */
  after: number;
  limit: number;
  debug: "exclude" | "include" | "only" | "quarantined";
}

export function exportEvents(db: Db, q: ExportRequest, dailyBudget: number, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const used = num(db.all("SELECT rows FROM export_usage WHERE day = ?", [today])[0]?.rows);
  const room = Math.max(0, Math.min(q.limit, dailyBudget - used));
  if (!room)
    return {
      error: {
        code: "daily_limit",
        message: `This site's export rows for today are used up (${dailyBudget}).`,
        hint: "Exports continue after 00:00 UTC (MAX_EXPORT_ROWS_PER_SITE_PER_DAY); the cursor stays valid.",
      },
    };
  // Columns this database has (older sites may lack a late one), from the table's own SQL.
  const ddl = String(db.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")[0]?.sql ?? "");
  const select = EXPORT_COLUMNS.filter((c) => new RegExp(`[(,]\\s*"?${c}"?\\s`, "i").test(ddl));
  const dbg = q.debug === "include" ? "AND debug < 2" : `AND debug = ${q.debug === "only" ? 1 : q.debug === "quarantined" ? 2 : 0}`;
  const rows = db.all(`SELECT ${select.join(", ")} FROM events WHERE id > ? AND ts >= ? AND ts < ? ${dbg} ORDER BY id LIMIT ?`, [
    q.after,
    q.start,
    q.end,
    room + 1,
  ]);
  const more = rows.length > room;
  const page = more ? rows.slice(0, room) : rows;
  if (page.length)
    db.run("INSERT INTO export_usage (day, rows) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET rows = rows + excluded.rows", [
      today,
      page.length,
    ]);
  db.run("DELETE FROM export_usage WHERE day < ?", [new Date(now - 40 * 86_400_000).toISOString().slice(0, 10)]);
  const last = page.at(-1);
  return {
    columns: select,
    rows: page.map((r) => ({
      ...r,
      time: new Date(num(r.ts)).toISOString(),
      props: r.props ? (JSON.parse(String(r.props)) as unknown) : null,
    })),
    next_cursor: more && last ? `e${num(last.id).toString(36)}` : null,
    used_today: used + page.length,
    daily_budget: Number.isFinite(dailyBudget) ? dailyBudget : null,
  };
}
