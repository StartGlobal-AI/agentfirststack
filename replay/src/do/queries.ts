/**
 * Read queries of the per-site engine: session search, transcript data, deterministic summaries,
 * heatmaps (live rows + daily rollups), error groups and funnel drop-offs. All plain SQL over the
 * DO's SQLite, no model involved.
 */

import { globToRegExp } from "../lib/mask-rules";
import type { EventRow, PageRow, SessionRow } from "../lib/rows";
import type { Signal } from "../lib/signals";
import { sqlGlob } from "../lib/glob";
import { type Db, DAY, dayStart, IN_JSON, marks, num, type SqlValue, strOrNull, utcDay } from "./db";
import { REACH_BUCKETS } from "./engine";

export interface SessionFilters {
  start: number;
  end: number;
  page?: string;
  entry_page?: string;
  exit_page?: string;
  signal?: Signal;
  has_error?: boolean;
  device?: string;
  browser?: string;
  os?: string;
  country?: string;
  min_duration_ms?: number;
  max_duration_ms?: number;
  min_frustration?: number;
  user_id?: string;
  analytics_visitor_id?: string;
  clicked?: string;
  error_fingerprint?: string;
  event?: string;
  forced?: boolean;
  session_ids?: string[];
}

export type SessionSort = "frustration" | "recent" | "duration";

const SIGNAL_COLUMN: Record<Signal, string> = {
  rage_click: "rage_clicks",
  dead_click: "dead_clicks",
  error_click: "error_clicks",
  quick_back: "quick_backs",
  excessive_scroll: "excessive_scrolls",
  js_error: "errors",
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** WHERE clause over `sessions s` for the filters. */
export function sessionWhere(f: SessionFilters): { sql: string; args: SqlValue[] } {
  const w: string[] = ["s.started_at >= ?", "s.started_at <= ?"];
  const args: SqlValue[] = [f.start, f.end];
  const add = (sql: string, ...a: SqlValue[]) => {
    w.push(sql);
    args.push(...a);
  };
  if (f.session_ids?.length) add(`s.id IN ${IN_JSON}`, JSON.stringify(f.session_ids));
  if (f.page) add("EXISTS (SELECT 1 FROM pages p WHERE p.session_id = s.id AND p.path GLOB ?)", sqlGlob(f.page));
  if (f.entry_page) add("s.entry_path GLOB ?", sqlGlob(f.entry_page));
  if (f.exit_page) add("s.exit_path GLOB ?", sqlGlob(f.exit_page));
  if (f.signal) add(`s.${SIGNAL_COLUMN[f.signal]} > 0`);
  if (f.has_error === true) add("s.errors > 0");
  if (f.has_error === false) add("s.errors = 0");
  if (f.device) add("s.device = ?", f.device.toLowerCase());
  if (f.browser) add("LOWER(s.browser) = ?", f.browser.toLowerCase());
  if (f.os) add("LOWER(s.os) = ?", f.os.toLowerCase());
  if (f.country) add("s.country = ?", f.country.toUpperCase());
  if (f.min_duration_ms !== undefined) add("s.duration_ms >= ?", f.min_duration_ms);
  if (f.max_duration_ms !== undefined) add("s.duration_ms <= ?", f.max_duration_ms);
  if (f.min_frustration !== undefined) add("s.frustration >= ?", f.min_frustration);
  if (f.user_id) add("s.user_id = ?", f.user_id);
  if (f.analytics_visitor_id) add("s.analytics_visitor_id = ?", f.analytics_visitor_id);
  if (f.clicked)
    add(
      "EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.kind = 'click' AND (e.selector LIKE ? ESCAPE '\\' OR e.label = ?))",
      `%${likeEscape(f.clicked)}%`,
      f.clicked,
    );
  if (f.error_fingerprint)
    add("EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.kind = 'error' AND e.fingerprint = ?)", f.error_fingerprint);
  if (f.event) add("EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.kind = 'event' AND e.label = ?)", f.event);
  if (f.forced !== undefined) add("s.forced = ?", f.forced ? 1 : 0);
  return { sql: w.join(" AND "), args };
}

const ORDER: Record<SessionSort, { col: string; sql: string }> = {
  frustration: { col: "frustration", sql: "s.frustration DESC, s.started_at DESC, s.id DESC" },
  recent: { col: "started_at", sql: "s.started_at DESC, s.id DESC" },
  duration: { col: "duration_ms", sql: "s.duration_ms DESC, s.started_at DESC, s.id DESC" },
};

export type Cursor = [number, number, string];

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor(s: string): Cursor | null {
  try {
    const v = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === "number" && typeof v[1] === "number" && typeof v[2] === "string")
      return v as Cursor;
  } catch {
    /* fallthrough */
  }
  return null;
}

export interface SearchRequest extends SessionFilters {
  sort: SessionSort;
  limit: number;
  cursor?: Cursor | null;
}

export function searchSessions(db: Db, q: SearchRequest) {
  const where = sessionWhere(q);
  const total = num(db.all(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where.sql}`, where.args)[0]?.n);
  const o = ORDER[q.sort];
  let page = where.sql;
  const args = [...where.args];
  if (q.cursor) {
    const [v, started, id] = q.cursor;
    if (q.sort === "recent") {
      page += " AND (s.started_at < ? OR (s.started_at = ? AND s.id < ?))";
      args.push(started, started, id);
    } else {
      page += ` AND (s.${o.col} < ? OR (s.${o.col} = ? AND (s.started_at < ? OR (s.started_at = ? AND s.id < ?))))`;
      args.push(v, v, started, started, id);
    }
  }
  const rows = db.all(`SELECT s.* FROM sessions s WHERE ${page} ORDER BY ${o.sql} LIMIT ?`, [
    ...args,
    q.limit + 1,
  ]) as unknown as SessionRow[];
  const more = rows.length > q.limit;
  const list = rows.slice(0, q.limit);
  const last = list[list.length - 1];
  return {
    total,
    sessions: list,
    next_cursor: more && last ? encodeCursor([num(last[o.col as keyof SessionRow] as number), last.started_at, last.id]) : null,
  };
}

export function getSessionRow(db: Db, id: string): SessionRow | null {
  return (db.all("SELECT * FROM sessions WHERE id = ?", [id])[0] as unknown as SessionRow | undefined) ?? null;
}

export function sessionPages(db: Db, id: string): PageRow[] {
  return db.all("SELECT * FROM pages WHERE session_id = ? AND path IS NOT NULL ORDER BY pv", [id]) as unknown as PageRow[];
}

export function transcriptData(db: Db, id: string, opts: { maxEvents: number; kinds?: string[] | null }) {
  const session = getSessionRow(db, id);
  if (!session) return null;
  const pages = opts.kinds && !opts.kinds.includes("page") ? [] : sessionPages(db, id);
  const kinds = opts.kinds?.filter((k) => k !== "page");
  const kindSql = kinds?.length ? ` AND kind IN (${marks(kinds.length)})` : opts.kinds ? " AND 0" : "";
  const events = db.all(`SELECT * FROM events WHERE session_id = ?${kindSql} ORDER BY ts, id LIMIT ?`, [
    id,
    ...(kinds?.length ? kinds : []),
    opts.maxEvents + 1,
  ]) as unknown as EventRow[];
  const truncated = events.length > opts.maxEvents;
  return { session, pages, events: events.slice(0, opts.maxEvents), truncated };
}

export function findVisitorSessions(db: Db, q: { user_id?: string; analytics_visitor_id?: string }): string[] {
  const w: string[] = [];
  const a: SqlValue[] = [];
  if (q.user_id) {
    w.push("user_id = ?");
    a.push(q.user_id);
  }
  if (q.analytics_visitor_id) {
    w.push("analytics_visitor_id = ?");
    a.push(q.analytics_visitor_id);
  }
  if (!w.length) return [];
  return db.all(`SELECT id FROM sessions WHERE ${w.join(" OR ")} LIMIT 1000`, a).map((r) => String(r.id));
}

// ---------------------------------------------------------------------------------- summarize

const examples = (v: SqlValue | undefined) => (v == null ? [] : String(v).split(",").filter(Boolean).slice(0, 3));

export interface SummarizeRequest extends SessionFilters {
  sort: SessionSort;
  /** max sessions considered */
  limit: number;
  top: number;
}

export function summarizeSessions(db: Db, q: SummarizeRequest) {
  const where = sessionWhere(q);
  const o = ORDER[q.sort];
  const ids = db
    .all(`SELECT s.id FROM sessions s WHERE ${where.sql} ORDER BY ${o.sql} LIMIT ?`, [...where.args, q.limit])
    .map((r) => String(r.id));
  const total = num(db.all(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where.sql}`, where.args)[0]?.n);
  if (!ids.length) return { sessions_matching: total, sessions_considered: 0, empty: true as const };
  const inIds = IN_JSON;
  const idsArg = JSON.stringify(ids);
  const top = q.top;
  const agg = db.all(
    `SELECT COUNT(*) AS n, AVG(duration_ms) AS avg_ms, SUM(rage_clicks > 0) AS rage, SUM(dead_clicks > 0) AS dead, SUM(dead_interactive > 0) AS dead_i,
       SUM(error_clicks > 0) AS error_clicks, SUM(errors > 0) AS errors, SUM(quick_backs > 0) AS qb, SUM(excessive_scrolls > 0) AS ex,
       AVG(frustration) AS avg_frustration, AVG(pageviews) AS avg_pages
     FROM sessions WHERE id IN ${inIds}`,
    [idsArg],
  )[0]!;
  const clickGroup = (cond: string, extra = "") =>
    db
      .all(
        `SELECT path, selector, MAX(label) AS label, MAX(tag) AS tag, MAX(interactive) AS interactive, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS clicks,
           SUM(rage_start) AS bursts, GROUP_CONCAT(DISTINCT session_id) AS ex ${extra}
         FROM events WHERE kind = 'click' AND session_id IN ${inIds} AND ${cond}
         GROUP BY path, selector ORDER BY sessions DESC, clicks DESC, path, selector LIMIT ?`,
        [idsArg, top],
      )
      .map((r) => ({
        path: strOrNull(r.path),
        selector: strOrNull(r.selector),
        label: strOrNull(r.label),
        tag: strOrNull(r.tag),
        interactive: !!num(r.interactive),
        sessions: num(r.sessions),
        clicks: num(r.clicks),
        example_session_ids: examples(r.ex),
      }));
  const rage = db
    .all(
      `SELECT path, selector, MAX(label) AS label, MAX(tag) AS tag, COUNT(DISTINCT session_id) AS sessions, SUM(rage_start) AS bursts, COUNT(*) AS clicks,
         GROUP_CONCAT(DISTINCT session_id) AS ex
       FROM events WHERE kind = 'click' AND rage = 1 AND session_id IN ${inIds} GROUP BY path, selector ORDER BY sessions DESC, bursts DESC, path, selector LIMIT ?`,
      [idsArg, top],
    )
    .map((r) => ({
      path: strOrNull(r.path),
      selector: strOrNull(r.selector),
      label: strOrNull(r.label),
      tag: strOrNull(r.tag),
      sessions: num(r.sessions),
      bursts: num(r.bursts),
      clicks: num(r.clicks),
      example_session_ids: examples(r.ex),
    }));
  const errors = db
    .all(
      `SELECT fingerprint, MAX(message) AS message, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS occurrences, SUM(error_click) AS after_click,
         GROUP_CONCAT(DISTINCT path) AS paths, GROUP_CONCAT(DISTINCT session_id) AS ex
       FROM events WHERE kind = 'error' AND session_id IN ${inIds} GROUP BY fingerprint ORDER BY sessions DESC, occurrences DESC, fingerprint LIMIT ?`,
      [idsArg, top],
    )
    .map((r) => ({
      fingerprint: strOrNull(r.fingerprint),
      message: strOrNull(r.message),
      sessions: num(r.sessions),
      occurrences: num(r.occurrences),
      after_click: num(r.after_click),
      paths: examples(r.paths),
      example_session_ids: examples(r.ex),
    }));
  const pageGroup = (col: string) =>
    db
      .all(
        `SELECT p.path, COUNT(DISTINCT p.session_id) AS sessions, COUNT(*) AS n, GROUP_CONCAT(DISTINCT prev.path) AS came_from, GROUP_CONCAT(DISTINCT p.session_id) AS ex
         FROM pages p LEFT JOIN pages prev ON prev.session_id = p.session_id AND prev.pv = p.pv - 1
         WHERE p.${col} = 1 AND p.session_id IN ${inIds} GROUP BY p.path ORDER BY sessions DESC, p.path LIMIT ?`,
        [idsArg, top],
      )
      .map((r) => ({
        path: strOrNull(r.path),
        sessions: num(r.sessions),
        count: num(r.n),
        came_from: examples(r.came_from),
        example_session_ids: examples(r.ex),
      }));
  const sessionGroup = (col: string) =>
    db
      .all(`SELECT ${col} AS v, COUNT(*) AS n FROM sessions WHERE id IN ${inIds} GROUP BY ${col} ORDER BY n DESC, v LIMIT ?`, [idsArg, top])
      .map((r) => ({ value: strOrNull(r.v), sessions: num(r.n) }));
  // The first four pages of each session, as a path.
  const journeys = new Map<string, { n: number; ex: string[] }>();
  const seq = new Map<string, string[]>();
  for (const r of db.all(`SELECT session_id, path FROM pages WHERE session_id IN ${inIds} AND path IS NOT NULL ORDER BY session_id, pv`, [
    idsArg,
  ])) {
    const k = String(r.session_id);
    const list = seq.get(k) ?? [];
    if (list.length < 4 && list[list.length - 1] !== r.path) list.push(String(r.path));
    seq.set(k, list);
  }
  for (const [sid, list] of seq) {
    const key = list.join(" > ");
    const j = journeys.get(key) ?? { n: 0, ex: [] };
    j.n++;
    if (j.ex.length < 3) j.ex.push(sid);
    journeys.set(key, j);
  }
  const n = num(agg.n);
  const result = {
    sessions_matching: total,
    sessions_considered: n,
    avg_duration_ms: Math.round(num(agg.avg_ms)),
    avg_pageviews: Math.round(num(agg.avg_pages) * 10) / 10,
    avg_frustration: Math.round(num(agg.avg_frustration)),
    sessions_with: {
      rage_click: num(agg.rage),
      dead_click: num(agg.dead),
      dead_click_interactive: num(agg.dead_i),
      error_click: num(agg.error_clicks),
      js_error: num(agg.errors),
      quick_back: num(agg.qb),
      excessive_scroll: num(agg.ex),
    },
    top_rage_targets: rage,
    top_dead_clicks: clickGroup("dead = 1", ""),
    top_error_clicks: clickGroup("error_click = 1"),
    top_errors: errors,
    quick_back_pages: pageGroup("quick_back"),
    excessive_scroll_pages: pageGroup("excessive_scroll"),
    not_clickable_but_clicked: clickGroup("interactive = 0"),
    entry_pages: sessionGroup("entry_path"),
    exit_pages: sessionGroup("exit_path"),
    devices: sessionGroup("device"),
    browsers: sessionGroup("browser"),
    countries: sessionGroup("country"),
    common_journeys: [...journeys.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([path, j]) => ({ pages: path, sessions: j.n, example_session_ids: j.ex })),
  };
  return { ...result, findings: findings(result) };
}

type Summary = Omit<ReturnType<typeof summarizeSessions>, "findings"> & { sessions_considered: number };

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** Plain sentences for the largest patterns, computed from the groups above. Labels stay quoted (untrusted). */
export function findings(s: {
  sessions_considered: number;
  top_rage_targets: { path: string | null; selector: string | null; label: string | null; sessions: number }[];
  top_dead_clicks: { path: string | null; selector: string | null; label: string | null; sessions: number; interactive: boolean }[];
  top_errors: { message: string | null; sessions: number; after_click: number; paths: string[] }[];
  quick_back_pages: { path: string | null; sessions: number; came_from: string[] }[];
  exit_pages: { value: string | null; sessions: number }[];
  excessive_scroll_pages: { path: string | null; sessions: number }[];
}): string[] {
  const n = s.sessions_considered;
  const out: { weight: number; text: string }[] = [];
  const target = (sel: string | null, label: string | null) => `${label ? `${JSON.stringify(label)} ` : ""}{${sel}}`;
  for (const r of s.top_rage_targets.slice(0, 2))
    out.push({
      weight: r.sessions * 3,
      text: `${r.sessions} of ${n} sessions (${pct(r.sessions, n)}%) rage-clicked ${target(r.selector, r.label)} on ${r.path}.`,
    });
  for (const r of s.top_dead_clicks.filter((d) => d.interactive).slice(0, 2))
    out.push({
      weight: r.sessions * 2,
      text: `${r.sessions} of ${n} sessions (${pct(r.sessions, n)}%) clicked ${target(r.selector, r.label)} on ${r.path} and nothing happened within 1 s (dead click on an interactive element).`,
    });
  for (const r of s.top_errors.slice(0, 2))
    out.push({
      weight: r.sessions * 2.5,
      text: `${r.sessions} of ${n} sessions (${pct(r.sessions, n)}%) hit the JS error ${JSON.stringify(r.message)}${r.paths.length ? ` on ${r.paths.join(", ")}` : ""}${r.after_click ? `, ${r.after_click} time(s) right after a click` : ""}.`,
    });
  for (const r of s.quick_back_pages.slice(0, 1))
    out.push({
      weight: r.sessions * 1.5,
      text: `${r.sessions} of ${n} sessions (${pct(r.sessions, n)}%) left ${r.path} within 7 s to go back${r.came_from.length ? ` to ${r.came_from.join(", ")}` : ""} (quick back).`,
    });
  for (const r of s.excessive_scroll_pages.slice(0, 1))
    out.push({
      weight: r.sessions,
      text: `${r.sessions} of ${n} sessions scrolled up and down ${r.path} repeatedly (excessive scrolling: searching for something).`,
    });
  const exit = s.exit_pages[0];
  if (exit && exit.value && n >= 3)
    out.push({
      weight: exit.sessions * 0.8,
      text: `${exit.sessions} of ${n} sessions (${pct(exit.sessions, n)}%) ended on ${exit.value}.`,
    });
  return out
    .filter((f) => f.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((f) => f.text);
}

export type SummaryResult = Summary;

// ---------------------------------------------------------------------------------- heatmap

export interface HeatmapRequest {
  start: number;
  end: number;
  page: string;
  device?: string;
  limit: number;
}

export function heatmap(db: Db, q: HeatmapRequest) {
  const through = strOrNull(db.all("SELECT value FROM meta WHERE key = 'rolled_through'")[0]?.value);
  // Days up to rolled_through come from the daily aggregates (whole days), later ones from live rows.
  const liveFrom = through ? Math.max(q.start, dayStart(through) + DAY) : q.start;
  const glob = sqlGlob(q.page);
  const dev = q.device ? q.device.toLowerCase() : null;
  const elements = new Map<
    string,
    {
      selector: string;
      label: string | null;
      tag: string | null;
      interactive: boolean;
      clicks: number;
      sessions: number;
      rage: number;
      dead: number;
      error_clicks: number;
      top_sum: number;
      top_n: number;
      paths: Set<string>;
    }
  >();
  const addEl = (r: Record<string, SqlValue>) => {
    const sel = String(r.selector);
    const e = elements.get(sel) ?? {
      selector: sel,
      label: strOrNull(r.label),
      tag: strOrNull(r.tag),
      interactive: false,
      clicks: 0,
      sessions: 0,
      rage: 0,
      dead: 0,
      error_clicks: 0,
      top_sum: 0,
      top_n: 0,
      paths: new Set<string>(),
    };
    e.clicks += num(r.clicks);
    e.sessions += num(r.sessions);
    e.rage += num(r.rage);
    e.dead += num(r.dead);
    e.error_clicks += num(r.error_clicks);
    e.top_sum += num(r.top_sum);
    e.top_n += num(r.top_n);
    e.interactive ||= !!num(r.interactive);
    if (!e.label && r.label) e.label = String(r.label);
    if (r.path) e.paths.add(String(r.path));
    elements.set(sel, e);
  };
  const reach = REACH_BUCKETS.map(() => 0);
  let pageviews = 0;
  let foldSum = 0;
  let foldN = 0;
  let sessions = 0;
  if (liveFrom <= q.end) {
    const devSql = dev ? " AND device = ?" : "";
    const a: SqlValue[] = [glob, liveFrom, q.end, ...(dev ? [dev] : [])];
    for (const r of db.all(
      `SELECT path, selector, MAX(label) AS label, MAX(tag) AS tag, MAX(interactive) AS interactive, COUNT(*) AS clicks, COUNT(DISTINCT session_id) AS sessions,
         SUM(rage) AS rage, SUM(dead) AS dead, SUM(error_click) AS error_clicks, COALESCE(SUM(top_pct), 0) AS top_sum, COUNT(top_pct) AS top_n
       FROM events WHERE kind = 'click' AND path GLOB ? AND ts >= ? AND ts <= ? AND selector IS NOT NULL${devSql}
       GROUP BY path, selector`,
      a,
    ))
      addEl(r);
    const p = db.all(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions, ${REACH_BUCKETS.map((b) => `SUM(max_scroll >= ${b}) AS r${b}`).join(", ")},
         COALESCE(SUM(CASE WHEN doc_h > 0 AND view_h > 0 THEN MIN(100, view_h * 100 / doc_h) END), 0) AS fold_sum,
         SUM(CASE WHEN doc_h > 0 AND view_h > 0 THEN 1 ELSE 0 END) AS fold_n
       FROM pages WHERE path GLOB ? AND ts >= ? AND ts <= ?${devSql}`,
      a,
    )[0]!;
    pageviews += num(p.n);
    sessions += num(p.sessions);
    foldSum += num(p.fold_sum);
    foldN += num(p.fold_n);
    REACH_BUCKETS.forEach((b, i) => {
      reach[i]! += num(p[`r${b}`]);
    });
  }
  if (through && q.start < dayStart(through) + DAY) {
    const fromDay = utcDay(q.start);
    const toDay = utcDay(Math.min(q.end, dayStart(through) + DAY - 1));
    const devSql = dev ? " AND device = ?" : "";
    const a: SqlValue[] = [glob, fromDay, toDay, ...(dev ? [dev] : [])];
    for (const r of db.all(
      `SELECT path, selector, MAX(label) AS label, MAX(tag) AS tag, MAX(interactive) AS interactive, SUM(clicks) AS clicks, SUM(sessions) AS sessions,
         SUM(rage) AS rage, SUM(dead) AS dead, SUM(error_clicks) AS error_clicks, SUM(top_sum) AS top_sum, SUM(top_n) AS top_n
       FROM heat_daily WHERE path GLOB ? AND day >= ? AND day <= ?${devSql} GROUP BY path, selector`,
      a,
    ))
      addEl(r);
    for (const r of db.all(
      `SELECT pageviews, reach, fold_sum, fold_n FROM scroll_daily WHERE path GLOB ? AND day >= ? AND day <= ?${devSql}`,
      a,
    )) {
      pageviews += num(r.pageviews);
      foldSum += num(r.fold_sum);
      foldN += num(r.fold_n);
      const arr = JSON.parse(String(r.reach)) as number[];
      arr.forEach((v, i) => {
        if (i < reach.length) reach[i]! += v;
      });
    }
  }
  const curve = REACH_BUCKETS.map((b, i) => ({ pct: b, share: pageviews ? Math.round((reach[i]! / pageviews) * 1000) / 1000 : 0 }));
  const reachedShare = (topPct: number) => {
    if (!pageviews) return null;
    if (topPct <= 0) return 1;
    // max_scroll is how far down the viewport's bottom got: an element at top% is seen once reach >= top%.
    const i = REACH_BUCKETS.findIndex((b) => b >= topPct);
    return i === -1 ? curve[curve.length - 1]!.share : curve[i]!.share;
  };
  const totalClicks = [...elements.values()].reduce((a, e) => a + e.clicks, 0);
  const list = [...elements.values()]
    .sort((a, b) => b.clicks - a.clicks || a.selector.localeCompare(b.selector))
    .slice(0, q.limit)
    .map((e) => {
      const top = e.top_n ? Math.round(e.top_sum / e.top_n) : null;
      return {
        selector: e.selector,
        label: e.label,
        tag: e.tag,
        interactive: e.interactive,
        clicks: e.clicks,
        click_share: totalClicks ? Math.round((e.clicks / totalClicks) * 1000) / 1000 : 0,
        sessions: e.sessions,
        rage_clicks: e.rage,
        dead_clicks: e.dead,
        error_clicks: e.error_clicks,
        rage_share: e.clicks ? Math.round((e.rage / e.clicks) * 1000) / 1000 : 0,
        dead_share: e.clicks ? Math.round((e.dead / e.clicks) * 1000) / 1000 : 0,
        error_share: e.clicks ? Math.round((e.error_clicks / e.clicks) * 1000) / 1000 : 0,
        position_pct: top,
        reached_by_share: top === null ? null : reachedShare(top),
        paths: [...e.paths].slice(0, 5),
      };
    });
  const median = (() => {
    if (!pageviews) return null;
    let m = 0;
    curve.forEach((c) => {
      if (c.share >= 0.5) m = c.pct;
    });
    return m;
  })();
  return {
    pageviews,
    sessions_live: sessions,
    clicks: totalClicks,
    elements: list,
    scroll: {
      pageviews,
      reach: curve,
      median_reach_pct: median,
      avg_fold_pct: foldN ? Math.round(foldSum / foldN) : null,
    },
    rolled_up_through: through,
  };
}

// ---------------------------------------------------------------------------------- errors

export interface ErrorsRequest {
  start: number;
  end: number;
  page?: string;
  device?: string;
  browser?: string;
  fingerprint?: string;
  limit: number;
}

export function listErrors(db: Db, q: ErrorsRequest) {
  const w = ["e.kind = 'error'", "e.ts >= ?", "e.ts <= ?"];
  const a: SqlValue[] = [q.start, q.end];
  if (q.page) {
    w.push("e.path GLOB ?");
    a.push(sqlGlob(q.page));
  }
  if (q.device) {
    w.push("e.device = ?");
    a.push(q.device.toLowerCase());
  }
  if (q.browser) {
    w.push("e.session_id IN (SELECT id FROM sessions WHERE LOWER(browser) = ?)");
    a.push(q.browser.toLowerCase());
  }
  if (q.fingerprint) {
    w.push("e.fingerprint = ?");
    a.push(q.fingerprint);
  }
  const where = w.join(" AND ");
  const totals = db.all(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT e.session_id) AS sessions, COUNT(DISTINCT e.fingerprint) AS groups FROM events e WHERE ${where}`,
    a,
  )[0]!;
  const sessionsInRange = num(
    db.all("SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ? AND started_at <= ?", [q.start, q.end])[0]?.n,
  );
  const groups = db.all(
    `SELECT e.fingerprint, COUNT(*) AS occurrences, COUNT(DISTINCT e.session_id) AS sessions, MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen,
       SUM(e.error_click) AS after_click
     FROM events e WHERE ${where} GROUP BY e.fingerprint ORDER BY sessions DESC, occurrences DESC, e.fingerprint LIMIT ?`,
    [...a, q.limit],
  );
  const errors = groups.map((g) => {
    const fp = String(g.fingerprint);
    const ga = [...a, fp];
    const gw = `${where} AND e.fingerprint = ?`;
    const sample = db.all(`SELECT e.message, e.detail, e.session_id, e.path FROM events e WHERE ${gw} ORDER BY e.ts DESC LIMIT 1`, ga)[0];
    const d = sample?.detail ? (JSON.parse(String(sample.detail)) as Record<string, unknown>) : {};
    const top = (sql: string) => db.all(sql, ga).map((r) => ({ value: strOrNull(r.v), count: num(r.n) }));
    return {
      fingerprint: fp,
      message: strOrNull(sample?.message),
      kind: typeof d.kind === "string" ? d.kind : "error",
      source: typeof d.source === "string" ? d.source : null,
      line: typeof d.line === "number" ? d.line : null,
      col: typeof d.col === "number" ? d.col : null,
      stack: typeof d.stack === "string" ? d.stack : null,
      occurrences: num(g.occurrences),
      sessions: num(g.sessions),
      first_seen: num(g.first_seen),
      last_seen: num(g.last_seen),
      after_click: num(g.after_click),
      triggered_by: db
        .all(
          `SELECT e.selector, MAX(e.label) AS label, COUNT(*) AS n FROM events e WHERE ${gw} AND e.error_click = 1 AND e.selector IS NOT NULL
           GROUP BY e.selector ORDER BY n DESC LIMIT 3`,
          ga,
        )
        .map((r) => ({ selector: strOrNull(r.selector), label: strOrNull(r.label), count: num(r.n) })),
      pages: top(`SELECT e.path AS v, COUNT(*) AS n FROM events e WHERE ${gw} GROUP BY e.path ORDER BY n DESC LIMIT 5`),
      browsers: top(
        `SELECT s.browser || COALESCE(' ' || s.browser_version, '') AS v, COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE ${gw} GROUP BY v ORDER BY n DESC LIMIT 5`,
      ),
      devices: top(`SELECT e.device AS v, COUNT(*) AS n FROM events e WHERE ${gw} GROUP BY e.device ORDER BY n DESC LIMIT 5`),
      example_session_ids: db
        .all(`SELECT e.session_id FROM events e WHERE ${gw} GROUP BY e.session_id ORDER BY MAX(e.ts) DESC LIMIT 3`, ga)
        .map((r) => String(r.session_id)),
    };
  });
  return {
    occurrences: num(totals.n),
    sessions_with_errors: num(totals.sessions),
    sessions_in_range: sessionsInRange,
    groups: num(totals.groups),
    errors,
  };
}

// ---------------------------------------------------------------------------------- funnel drop-offs

export type FunnelStep = { type: "page"; pattern: string } | { type: "event"; name: string };

export interface FunnelRequest extends SessionFilters {
  steps: FunnelStep[];
  /** 1-based: sessions that reached this step but not the next */
  drop_step?: number;
  limit: number;
  max_sessions: number;
}

export function funnelDropoffs(db: Db, q: FunnelRequest) {
  const where = sessionWhere(q);
  const ids = db
    .all(`SELECT s.id FROM sessions s WHERE ${where.sql} ORDER BY s.started_at DESC LIMIT ?`, [...where.args, q.max_sessions])
    .map((r) => String(r.id));
  const reached = new Array<number>(q.steps.length).fill(0);
  const lastStep = new Map<string, number>();
  const matchers = q.steps.map((s) => (s.type === "page" ? { t: "p", re: globToRegExp(s.pattern) } : { t: "e", name: s.name }));
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const inIds = IN_JSON;
    const arg = JSON.stringify(batch);
    const rows = db.all(
      `SELECT session_id, ts, 'p' AS t, path AS v FROM pages WHERE session_id IN ${inIds} AND path IS NOT NULL
       UNION ALL SELECT session_id, ts, 'e' AS t, label AS v FROM events WHERE kind = 'event' AND session_id IN ${inIds}
       ORDER BY session_id, ts`,
      [arg, arg],
    );
    let cur = "";
    let step = 0;
    const flush = () => {
      if (!cur) return;
      lastStep.set(cur, step);
      for (let k = 0; k < step; k++) reached[k]!++;
    };
    for (const r of rows) {
      const sid = String(r.session_id);
      if (sid !== cur) {
        flush();
        cur = sid;
        step = 0;
      }
      if (step >= matchers.length) continue;
      const m = matchers[step]!;
      const v = String(r.v ?? "");
      if (
        (m.t === "p" && r.t === "p" && (m as { re: RegExp }).re.test(v)) ||
        (m.t === "e" && r.t === "e" && v === (m as { name: string }).name)
      )
        step++;
    }
    flush();
  }
  const steps = q.steps.map((s, i) => {
    const r = reached[i]!;
    const next = i + 1 < q.steps.length ? reached[i + 1]! : null;
    return {
      step: i + 1,
      match: s.type === "page" ? s.pattern : `event:${s.name}`,
      sessions: r,
      dropped: next === null ? null : r - next,
      conversion_from_previous: i === 0 ? null : reached[i - 1] ? Math.round((r / reached[i - 1]!) * 1000) / 1000 : 0,
    };
  });
  let dropped: { step: number; session_ids: string[]; total: number } | null = null;
  if (q.drop_step !== undefined) {
    const k = q.drop_step;
    const all = [...lastStep.entries()].filter(([, st]) => st === k).map(([sid]) => sid);
    dropped = { step: k, total: all.length, session_ids: all };
  }
  return { sessions_considered: ids.length, steps, dropped };
}

export type { SessionRow };
