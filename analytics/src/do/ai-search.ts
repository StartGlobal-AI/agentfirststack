/**
 * The AI search report, in the site's Durable Object: AI crawler hits (crawler_hits, the daily
 * aggregate) next to visits from the AI Assistants channel (events), what those visitors did
 * compared with the other channels, the pages where the two don't meet, and a previous period.
 *
 * Bounded: crawler queries read the daily aggregate (at most MAX_CRAWL_PATHS_PER_BOT_DAY paths per
 * bot and day) with LIMITs; visitor numbers are the same grouped queries as stats and breakdowns
 * (a handful over the period's events, each with a LIMIT), and the gap check runs only when the
 * site reports crawler hits.
 */

import {
  AI_CATEGORIES,
  AI_CHANNEL,
  ASSISTANT_OPERATOR,
  DISCOVERY_FILES,
  aiSearchNextSteps,
  crawlersOf,
  isPagePath,
} from "../lib/ai-search";
import type { Filter, Metric } from "../lib/filters";
import { type QueryCtx, VISIT_ACTIVITY, evCte, localTsExpr, raw, sql } from "../lib/query";
import { changePercent } from "../lib/stats-math";
import { type CompareSpec, comparisonRange, offsetSegments } from "../lib/time";
import type { PeriodParams, SiteSettings } from "../lib/types";
import { DAY, type Db, all, ctxFor, guard, num, periodOut, rangeFor, round } from "./common";
import { type MetricValues, breakdownRows, shapeMetrics, totals } from "./engine";

export interface AiSearchRequest extends PeriodParams {
  compare?: CompareSpec;
  /** rows per list (default 10) */
  limit?: number;
  /** the site's robots.txt (null: couldn't be read), so next_steps can tell blocked from not crawling yet */
  robots_txt?: string | null;
}

/** What visitors did, per channel and for AI vs the rest. */
const CHANNEL_METRICS: Metric[] = [
  "visitors",
  "visits",
  "pageviews",
  "views_per_visit",
  "bounce_rate",
  "visit_duration",
  "engagement_rate",
  "conversions",
  "conversion_rate",
  "revenue",
  "revenue_per_visitor",
];
const ROW_METRICS: Metric[] = [
  "visitors",
  "visits",
  "conversions",
  "conversion_rate",
  "revenue",
  "engagement_rate",
  "bounce_rate",
  "visit_duration",
];
const SUMMARY_METRICS: Metric[] = ["visitors", "visits", "conversions", "conversion_rate", "revenue"];
/** Below this many AI (or other) visitors, rates and lifts are said to be noisy. */
export const MIN_COMPARE_VISITORS = 30;
/** (landing page, assistant) pairs read for the gap check. */
const GAP_PAIRS = 500;
/** AI-crawled paths read (top by hits) for top pages and crawled-but-never-referred. */
const CRAWLED_CANDIDATES = 200;
/** A vendor's crawler fetching a page up to this many days before the period still counts. */
export const GAP_LOOKBACK_DAYS = 30;
const MAX_SERIES_DAYS = 3700;

/** Fixed values (lib/ai-search.ts), never input: safe to inline. */
const AI_CATS = `category IN (${AI_CATEGORIES.map((c) => `'${c}'`).join(", ")})`;
const FILES_IN = `(${DISCOVERY_FILES.map((f) => `'${f}'`).join(", ")})`;

const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < MAX_SERIES_DAYS; d = shiftDay(d, 1)) out.push(d);
  return out;
}

function crawlTotals(db: Db, from: string, to: string) {
  const t = db.all(
    `SELECT COALESCE(SUM(hits), 0) AS hits, COUNT(DISTINCT path) AS pages, COUNT(DISTINCT bot) AS bots,
       COALESCE(SUM(CASE WHEN status >= 400 THEN hits ELSE 0 END), 0) AS errors,
       COALESCE(SUM(CASE WHEN path NOT IN ${FILES_IN} THEN hits ELSE 0 END), 0) AS page_hits,
       COALESCE(SUM(CASE WHEN status >= 400 AND path NOT IN ${FILES_IN} THEN hits ELSE 0 END), 0) AS page_errors
     FROM crawler_hits WHERE day >= ? AND day <= ? AND ${AI_CATS}`,
    [from, to],
  )[0];
  return {
    hits: num(t?.hits),
    pages: num(t?.pages),
    bots: num(t?.bots),
    errors: num(t?.errors),
    /** requests for pages (not robots.txt, llms.txt, sitemaps) and those answered 4xx/5xx */
    page_hits: num(t?.page_hits),
    page_errors: num(t?.page_errors),
  };
}

const pickMetrics = (row: Record<string, unknown> | undefined, metrics: Metric[]): MetricValues =>
  row ? (Object.fromEntries(metrics.map((m) => [m, (row[m] as number | null) ?? null])) as MetricValues) : shapeMetrics(undefined, metrics);

export function aiSearch(db: Db, settings: SiteSettings, q: AiSearchRequest, now = Date.now()) {
  return guard(() => {
    const r = rangeFor(db, settings, q, now);
    const p = q.compare ? comparisonRange(r, q.compare, now) : null;
    const limit = q.limit ?? 10;
    const base = ctxFor(db, r, { filters: [], debug: q.debug });
    const isAi: Filter = { key: "channel", op: "==", values: [AI_CHANNEL] };
    const notAi: Filter = { key: "channel", op: "!=", values: [AI_CHANNEL] };
    const ai: QueryCtx = { ...base, filters: [isAi] };
    const notes: string[] = [];

    // ---------------------------------------------------------------- AI crawlers
    const reportsCrawls = db.all("SELECT 1 FROM crawler_hits LIMIT 1").length > 0;
    const ct = crawlTotals(db, r.from, r.to);
    const byCategory = db.all(
      `SELECT category, SUM(hits) AS hits FROM crawler_hits WHERE day >= ? AND day <= ? AND ${AI_CATS} GROUP BY category ORDER BY hits DESC`,
      [r.from, r.to],
    );
    const botRows = db.all(
      `SELECT bot, MAX(operator) AS operator, MAX(category) AS category, SUM(hits) AS hits, COUNT(DISTINCT path) AS pages,
         SUM(CASE WHEN status >= 400 THEN hits ELSE 0 END) AS errors,
         SUM(CASE WHEN path = '/robots.txt' THEN hits ELSE 0 END) AS robots,
         SUM(CASE WHEN path NOT IN ${FILES_IN} THEN hits ELSE 0 END) AS page_hits, MAX(last_at) AS last_seen
       FROM crawler_hits WHERE day >= ? AND day <= ? AND ${AI_CATS} GROUP BY bot ORDER BY hits DESC, bot LIMIT 50`,
      [r.from, r.to],
    );
    const prevCt = p ? crawlTotals(db, p.from, p.to) : null;
    const prevBots = p
      ? new Map(
          db
            .all(`SELECT bot, SUM(hits) AS hits FROM crawler_hits WHERE day >= ? AND day <= ? AND ${AI_CATS} GROUP BY bot`, [p.from, p.to])
            .map((x) => [String(x.bot), num(x.hits)]),
        )
      : null;
    const crawled = ct.hits
      ? db.all(
          `SELECT path, SUM(hits) AS hits, COUNT(DISTINCT bot) AS bots, GROUP_CONCAT(DISTINCT operator) AS operators,
             SUM(CASE WHEN status >= 400 THEN hits ELSE 0 END) AS errors
           FROM crawler_hits WHERE day >= ? AND day <= ? AND ${AI_CATS} AND path != '(other)'
           GROUP BY path ORDER BY hits DESC, path LIMIT ?`,
          [r.from, r.to, CRAWLED_CANDIDATES],
        )
      : [];
    const fileRows = ct.hits
      ? db.all(
          `SELECT path, status, SUM(hits) AS hits FROM crawler_hits
           WHERE day >= ? AND day <= ? AND ${AI_CATS} AND path IN ${FILES_IN} GROUP BY path, status`,
          [r.from, r.to],
        )
      : [];
    const discovery = DISCOVERY_FILES.map((f) => {
      const rows = fileRows.filter((x) => x.path === f);
      const sum = (pred: (s: number) => boolean) => rows.filter((x) => pred(num(x.status))).reduce((a, x) => a + num(x.hits), 0);
      return { path: f, hits: sum(() => true), ok: sum((s) => s >= 200 && s < 400), errors: sum((s) => s >= 400) };
    });
    const crawlByDay = new Map(
      db
        .all(`SELECT day, SUM(hits) AS hits FROM crawler_hits WHERE day >= ? AND day <= ? AND ${AI_CATS} GROUP BY day`, [r.from, r.to])
        .map((x) => [String(x.day), num(x.hits)]),
    );
    const bots = botRows.map((b) => {
      const hits = num(b.hits);
      const prev = prevBots ? (prevBots.get(String(b.bot)) ?? 0) : null;
      return {
        bot: String(b.bot),
        operator: b.operator == null ? null : String(b.operator),
        category: String(b.category),
        hits,
        pages: num(b.pages),
        errors: num(b.errors),
        robots_txt_hits: num(b.robots),
        last_seen: b.last_seen == null ? null : num(b.last_seen),
        ...(prev == null ? {} : { previous_hits: prev, change_percent: changePercent(hits, prev) }),
        page_hits: num(b.page_hits),
      };
    });

    // ---------------------------------------------------------------- visitors from AI assistants
    const channelRows = breakdownRows(db, base, "channel", CHANNEL_METRICS, 20);
    const aiRow = channelRows.find((c) => c.value === AI_CHANNEL);
    const aiM = pickMetrics(aiRow, CHANNEL_METRICS);
    const aiVisitors = Number(aiM.visitors ?? 0);
    const others = totals(db, { ...base, filters: [notAi] }, CHANNEL_METRICS);
    const siteVisitors = Number(totals(db, base, ["visitors"]).visitors ?? 0);
    const aiPrev = p ? totals(db, { ...ai, start: p.start, end: p.end }, SUMMARY_METRICS) : null;
    const sources = aiVisitors
      ? breakdownRows(db, ai, "source", ROW_METRICS, limit, { cmp: p ? { ...ai, start: p.start, end: p.end } : null })
      : [];
    const landing = aiVisitors ? breakdownRows(db, ai, "entry_page", ROW_METRICS, limit) : [];
    const segs = offsetSegments(r.start, r.end, r.timezone);
    const visByDay = new Map(
      aiVisitors
        ? all(
            db,
            sql`WITH ${evCte(ai)} SELECT strftime('%Y-%m-%d', ${localTsExpr(segs)} / 1000, 'unixepoch') AS d,
              COUNT(DISTINCT CASE WHEN ${raw(VISIT_ACTIVITY)} THEN e.visitor_id END) AS v FROM ev e GROUP BY d`,
          ).map((x) => [String(x.d), num(x.v)])
        : [],
    );
    const lift = (m: Metric) => {
      const a = Number(aiM[m] ?? 0);
      const b = Number(others[m] ?? 0);
      return aiVisitors && b ? round(a / b, 2) : null;
    };

    // ---------------------------------------------------------------- where crawling and referrals don't meet
    let gaps: Record<string, unknown>;
    let crawledNotReferred: Record<string, unknown>[] = [];
    let referredNotCrawled: Record<string, unknown>[] = [];
    if (!ct.hits) {
      gaps = {
        crawled_not_referred: null,
        referred_not_crawled: null,
        note: reportsCrawls
          ? "No AI crawler hits in this period, so crawled and referred pages can't be lined up."
          : "This site reports no crawler hits (POST /v1/sites/:id/crawls), so crawled and referred pages can't be lined up.",
      };
    } else {
      const pairs = aiVisitors ? breakdownRows(db, ai, ["entry_page", "source"], ["visitors"], GAP_PAIRS) : [];
      const landed = new Set(pairs.map((x) => String(x.value)));
      crawledNotReferred = crawled
        .filter((x) => isPagePath(String(x.path)) && !landed.has(String(x.path)))
        .slice(0, limit)
        .map((x) => ({
          page: String(x.path),
          ai_crawler_hits: num(x.hits),
          bots: num(x.bots),
          operators: x.operators == null ? [] : String(x.operators).split(","),
        }));
      const bySource = new Map<string, { page: string; visitors: number }[]>();
      const notChecked: { source: string; operator: string | null; reason: string }[] = [];
      for (const x of pairs) {
        const src = String(x.source);
        const page = String(x.value);
        if (page === "(none)") continue;
        if (!ASSISTANT_OPERATOR[src]) {
          if (!notChecked.some((n) => n.source === src))
            notChecked.push({ source: src, operator: null, reason: "no crawler of this assistant is on the list (GET /v1/crawlers)" });
          continue;
        }
        bySource.set(src, [...(bySource.get(src) ?? []), { page, visitors: Number(x.visitors ?? 0) }]);
      }
      const from = shiftDay(r.from, -GAP_LOOKBACK_DAYS);
      const ops = [...new Set([...bySource.keys()].map((s) => ASSISTANT_OPERATOR[s]!))];
      const seen = new Map(
        (ops.length
          ? db.all(
              `SELECT operator, GROUP_CONCAT(DISTINCT bot) AS bots FROM crawler_hits
               WHERE day >= ? AND day <= ? AND operator IN (SELECT value FROM json_each(?)) GROUP BY operator`,
              [from, r.to, JSON.stringify(ops)],
            )
          : []
        ).map((x) => [String(x.operator), String(x.bots).split(",")]),
      );
      const candidates = [
        ...new Set(
          [...bySource.entries()].filter(([s]) => seen.has(ASSISTANT_OPERATOR[s]!)).flatMap(([, pages]) => pages.map((x) => x.page)),
        ),
      ];
      const fetched = new Set(
        candidates.length
          ? db
              .all(
                `SELECT DISTINCT operator, path FROM crawler_hits WHERE day >= ? AND day <= ?
                 AND operator IN (SELECT value FROM json_each(?)) AND path IN (SELECT value FROM json_each(?))`,
                [from, r.to, JSON.stringify([...seen.keys()]), JSON.stringify(candidates)],
              )
              .map((x) => `${x.operator}\u001f${x.path}`)
          : [],
      );
      for (const [src, pages] of bySource) {
        const op = ASSISTANT_OPERATOR[src]!;
        if (!seen.has(op)) {
          notChecked.push({
            source: src,
            operator: op,
            reason: `no hits from ${op}'s crawlers (${crawlersOf(op).join(", ")}) were reported since ${from}`,
          });
          continue;
        }
        const missing = pages.filter((x) => !fetched.has(`${op}\u001f${x.page}`));
        if (missing.length)
          referredNotCrawled.push({ source: src, operator: op, crawlers_seen: seen.get(op), pages: missing.slice(0, limit) });
      }
      gaps = {
        crawled_not_referred: crawledNotReferred,
        referred_not_crawled: referredNotCrawled,
        not_checked: notChecked,
        crawl_lookback_from: from,
        note: `crawled_not_referred: pages AI crawlers fetched in this period that no visitor from an AI assistant landed on in it (files such as robots.txt, sitemaps, images and PDFs left out: the tracker can't see visits to them). referred_not_crawled: landing pages of an assistant that none of its vendor's crawlers fetched from ${from} on; the vendor may know them from a search index or an older fetch, or your server didn't report the request.`,
      };
    }

    // ---------------------------------------------------------------- summary, trend, advice
    const aiConv = Number(aiM.conversion_rate ?? 0);
    const summaryNow = {
      ai_crawler_hits: ct.hits,
      ai_visitors: aiVisitors,
      ai_visits: Number(aiM.visits ?? 0),
      ai_conversions: Number(aiM.conversions ?? 0),
      ai_conversion_rate: aiConv,
      ai_revenue: Number(aiM.revenue ?? 0),
    };
    const out: Record<string, unknown> = {
      period: periodOut(r),
      summary: {
        ...summaryNow,
        ai_crawled_pages: ct.pages,
        ai_bots: ct.bots,
        share_of_visitors: siteVisitors ? round((aiVisitors / siteVisitors) * 100, 1) : 0,
      },
    };
    if (q.compare) {
      if (p && prevCt && aiPrev) {
        const prev = {
          ai_crawler_hits: prevCt.hits,
          ai_visitors: Number(aiPrev.visitors ?? 0),
          ai_visits: Number(aiPrev.visits ?? 0),
          ai_conversions: Number(aiPrev.conversions ?? 0),
          ai_conversion_rate: Number(aiPrev.conversion_rate ?? 0),
          ai_revenue: Number(aiPrev.revenue ?? 0),
        };
        out.comparison = {
          period: { ...periodOut(p), partial: p.partial, mode: p.mode },
          summary: prev,
          change_percent: Object.fromEntries(
            (Object.keys(summaryNow) as (keyof typeof summaryNow)[]).map((k) => [k, changePercent(summaryNow[k], prev[k])]),
          ),
        };
      } else out.comparison = null;
    }
    out.crawlers = {
      reporting: reportsCrawls,
      totals: {
        hits: ct.hits,
        pages: ct.pages,
        bots: ct.bots,
        errors: ct.errors,
        by_category: Object.fromEntries(byCategory.map((c) => [String(c.category), num(c.hits)])),
      },
      bots: bots.map(({ page_hits: _p, ...b }) => b),
      top_pages: crawled
        .filter((x) => isPagePath(String(x.path)))
        .slice(0, limit)
        .map((x) => ({
          page: String(x.path),
          hits: num(x.hits),
          bots: num(x.bots),
          operators: x.operators == null ? [] : String(x.operators).split(","),
          errors: num(x.errors),
        })),
      discovery_files: discovery,
    };
    out.referrals = {
      sources: sources.map((s) => {
        const { value, ...rest } = s;
        return { source: value, crawler_operator: ASSISTANT_OPERATOR[String(value)] ?? null, ...rest };
      }),
      landing_pages: landing.map(({ value, ...rest }) => ({ page: value, ...rest })),
    };
    out.vs_other_channels = {
      ai_assistants: aiM,
      all_other_channels: others,
      lift: {
        conversion_rate: lift("conversion_rate"),
        revenue_per_visitor: lift("revenue_per_visitor"),
        engagement_rate: lift("engagement_rate"),
        views_per_visit: lift("views_per_visit"),
      },
      enough_data: aiVisitors >= MIN_COMPARE_VISITORS && Number(others.visitors ?? 0) >= MIN_COMPARE_VISITORS,
      channels: channelRows.map(({ value, ...rest }) => ({ channel: value, ...rest })),
    };
    out.gaps = gaps;
    out.series = dayList(r.from, r.to).map((d) => ({
      date: d,
      ai_crawler_hits: crawlByDay.get(d) ?? 0,
      ai_visitors: visByDay.get(d) ?? 0,
    }));
    notes.push(
      "AI Assistants is the channel of visits referred by assistants (chatgpt.com, perplexity.ai, claude.ai, gemini.google.com, copilot.microsoft.com, ...; utm_source=chatgpt.com too). Assistants that open links without a referrer arrive as Direct, so these numbers are a floor.",
      "Crawler hits are what your server reported (POST /v1/sites/:id/crawls), classified by user agent (self-declared). lift = AI Assistants' value / all other channels' value.",
    );
    if (aiVisitors && aiVisitors < MIN_COMPARE_VISITORS)
      notes.push(
        `Only ${aiVisitors} visitors from AI assistants: conversion rates and lifts are noisy until there are at least ${MIN_COMPARE_VISITORS}.`,
      );
    out.notes = notes;
    const citationBots = bots
      .filter((b) => (b.category === "ai_search" || b.category === "ai_assistant") && b.page_hits > 0)
      .map((b) => b.bot);
    const llms = discovery.find((f) => f.path === "/llms.txt")!;
    out.next_steps = aiSearchNextSteps({
      siteId: settings.id,
      reportsCrawls,
      aiHits: ct.hits,
      citationBotsSeen: citationBots,
      // Only bots that can cite the site: whether training bots may read it is the site's choice.
      robotsOnly: bots
        .filter((b) => (b.category === "ai_search" || b.category === "ai_assistant") && b.robots_txt_hits > 0 && b.page_hits === 0)
        .map((b) => b.bot),
      robotsTxt: q.robots_txt,
      // robots.txt / llms.txt / sitemap misses have their own advice
      errorShare: ct.page_hits ? ct.page_errors / ct.page_hits : 0,
      llmsTxt: { ok: llms.ok, error: llms.errors },
      aiVisitors,
      hasGoals: base.hasGoals,
      crawledNotReferred: crawledNotReferred.length,
      referredNotCrawled: referredNotCrawled.length,
    });
    return out;
  });
}
