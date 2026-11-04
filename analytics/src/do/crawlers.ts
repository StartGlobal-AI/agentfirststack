/**
 * Crawler hits in the site's Durable Object: daily counts per (bot, path, status class), apart
 * from events (never visitors, visits or events), with their own daily budget (crawl_usage).
 */

import type { PeriodParams, SiteSettings } from "../lib/types";
import type { CrawlerCategory } from "../lib/crawlers";
import { type Db, all, guard, num, periodOut, rangeFor } from "./common";
import { localDay, ymdString } from "../lib/time";

export const CRAWLERS_SQL = [
  `CREATE TABLE IF NOT EXISTS crawler_hits (
    day TEXT NOT NULL, bot TEXT NOT NULL, operator TEXT, category TEXT NOT NULL, path TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
    PRIMARY KEY (day, bot, path, status)
  )`,
  "CREATE INDEX IF NOT EXISTS crawler_hits_day ON crawler_hits(day)",
  "CREATE TABLE IF NOT EXISTS crawl_usage (day TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0)",
];

/** Distinct paths kept per bot and day; the rest are counted under "(other)". */
export const MAX_CRAWL_PATHS_PER_BOT_DAY = 2000;

export interface CrawlHit {
  bot: string;
  operator: string | null;
  category: CrawlerCategory;
  path: string;
  /** status class: 2, 3, 4, 5 (x 100), or 0 unknown */
  status: number;
  ts: number;
}

/** Count hits within today's budget (UTC). Returns how many were counted and refused. */
/**
 * Count hits within today's budgets (UTC): the site's own (`dailyBudget`, counted here) and the
 * room left by the account's and the deployment's (`room`, from the Worker's D1 aggregate).
 */
export function recordCrawls(
  db: Db,
  hits: CrawlHit[],
  settings: SiteSettings,
  dailyBudget: number,
  now = Date.now(),
  room = Number.POSITIVE_INFINITY,
) {
  const today = new Date(now).toISOString().slice(0, 10);
  let counted = 0;
  let refused = 0;
  db.transaction(() => {
    let used = num(db.all("SELECT hits FROM crawl_usage WHERE day = ?", [today])[0]?.hits);
    let left = room;
    for (const h of hits) {
      if (used >= dailyBudget || left <= 0) {
        refused++;
        continue;
      }
      const day = ymdString(localDay(h.ts, settings.timezone));
      let path = h.path;
      const known = db.all("SELECT 1 FROM crawler_hits WHERE day = ? AND bot = ? AND path = ? LIMIT 1", [day, h.bot, path]).length;
      if (
        !known &&
        num(db.all("SELECT COUNT(DISTINCT path) AS n FROM crawler_hits WHERE day = ? AND bot = ?", [day, h.bot])[0]?.n) >=
          MAX_CRAWL_PATHS_PER_BOT_DAY
      )
        path = "(other)";
      db.run(
        `INSERT INTO crawler_hits (day, bot, operator, category, path, status, hits, last_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(day, bot, path, status) DO UPDATE SET hits = hits + 1, last_at = MAX(last_at, excluded.last_at)`,
        [day, h.bot, h.operator, h.category, path, h.status, h.ts],
      );
      used++;
      counted++;
      left--;
    }
    db.run(
      `INSERT INTO crawl_usage (day, hits, refused) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET hits = hits + excluded.hits, refused = refused + excluded.refused`,
      [today, counted, refused],
    );
  });
  return {
    counted,
    refused,
    used_today: num(db.all("SELECT hits FROM crawl_usage WHERE day = ?", [today])[0]?.hits),
    daily_budget: Number.isFinite(dailyBudget) ? dailyBudget : null,
  };
}

export const CRAWL_DIMS = ["bot", "operator", "category", "page", "status"] as const;

export interface CrawlersRequest extends PeriodParams {
  by: (typeof CRAWL_DIMS)[number];
  bot?: string;
  category?: string;
  page?: string;
  limit: number;
}

const COL: Record<(typeof CRAWL_DIMS)[number], string> = {
  bot: "bot",
  operator: "COALESCE(operator, '(none)')",
  category: "category",
  page: "path",
  status: "status",
};

export function crawlersReport(db: Db, settings: SiteSettings, q: CrawlersRequest, now = Date.now()) {
  return guard(() => {
    const r = rangeFor(db, settings, { ...q, period: q.period ?? (q.from ? undefined : "30d") }, now);
    const where = ["day >= ?", "day <= ?"];
    const args: (string | number)[] = [r.from, r.to];
    if (q.bot) where.push("bot = ?") && args.push(q.bot);
    if (q.category) where.push("category = ?") && args.push(q.category);
    if (q.page) where.push("path = ?") && args.push(q.page);
    const w = where.join(" AND ");
    const col = COL[q.by];
    const rows = all(db, {
      sql: `SELECT ${col} AS value, SUM(hits) AS hits, COUNT(DISTINCT path) AS pages, COUNT(DISTINCT bot) AS bots, MAX(last_at) AS last_seen,
              ${q.by === "bot" ? "MAX(operator) AS operator, MAX(category) AS category," : ""}
              SUM(CASE WHEN status >= 400 THEN hits ELSE 0 END) AS errors
            FROM crawler_hits WHERE ${w} GROUP BY value ORDER BY hits DESC, value LIMIT ?`,
      args: [...args, q.limit],
    });
    const totals = all(db, {
      sql: `SELECT COALESCE(SUM(hits), 0) AS hits, COUNT(DISTINCT path) AS pages, COUNT(DISTINCT bot) AS bots FROM crawler_hits WHERE ${w}`,
      args,
    })[0];
    const byCategory = all(db, {
      sql: `SELECT category, SUM(hits) AS hits FROM crawler_hits WHERE ${w} GROUP BY category ORDER BY hits DESC`,
      args,
    });
    const series = all(db, {
      sql: `SELECT day, category, SUM(hits) AS hits FROM crawler_hits WHERE ${w} GROUP BY day, category ORDER BY day`,
      args,
    });
    const days = new Map<string, Record<string, number>>();
    for (const s of series) {
      const d = days.get(String(s.day)) ?? {};
      d[String(s.category)] = num(s.hits);
      days.set(String(s.day), d);
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const usage = db.all("SELECT hits, refused FROM crawl_usage WHERE day = ?", [today])[0];
    return {
      period: periodOut(r),
      by: q.by,
      totals: {
        hits: num(totals?.hits),
        pages: num(totals?.pages),
        bots: num(totals?.bots),
        by_category: Object.fromEntries(byCategory.map((c) => [String(c.category), num(c.hits)])),
      },
      results: rows.map((x) => ({
        value: x.value,
        ...(q.by === "bot" ? { operator: x.operator ?? null, category: x.category } : {}),
        hits: num(x.hits),
        pages: num(x.pages),
        bots: num(x.bots),
        errors: num(x.errors),
        last_seen: x.last_seen,
      })),
      series: [...days.entries()].map(([date, c]) => ({ date, ...c })),
      usage_today: { hits: num(usage?.hits), refused: num(usage?.refused) },
      note: "Crawler hits are what your server reported (POST /v1/sites/:id/crawls), classified by user agent (self-declared); they never count as visitors, visits or events.",
    };
  });
}
