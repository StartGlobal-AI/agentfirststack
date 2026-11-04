/**
 * Read queries of the per-site engine: session search, transcript data, deterministic summaries,
 * heatmaps (live rows + daily rollups), error groups and funnel drop-offs. All plain SQL over the
 * DO's SQLite, no model involved.
 */

import { globToRegExp } from "../lib/mask-rules";
import type { EventRow, PageRow, SessionRow, TagRow } from "../lib/rows";
import type { Signal } from "../lib/signals";
import { sqlGlob } from "../lib/glob";
import { type Db, DAY, dayStart, IN_JSON, marks, num, type SqlValue, strOrNull, utcDay } from "./db";
import { ATTENTION_BANDS } from "../lib/derive";
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
  /** the entry page's referrer: an external hostname or a same-site path (glob) */
  referrer?: string;
  region?: string;
  city?: string;
  min_pageviews?: number;
  /** some page of the session scrolled at least this far (%) */
  min_scroll_pct?: number;
  min_active_ms?: number;
  user_id?: string;
  /** user_id in every stored form (as sent, hashed with hash_user_ids); replaces user_id */
  user_ids?: string[];
  analytics_visitor_id?: string;
  /** custom tags, all must hold: key (has the key), key + value, `not` = must not */
  tags?: TagFilter[];
  /** in progress: a chunk arrived since then */
  received_since?: number;
  starred?: boolean;
  /** recorded because the page called afsr('upgrade') */
  upgraded?: boolean;
  /** a label of the session (leading "!" = without it) */
  label?: string;
  /** sessions with a response to this survey (and an answer matching survey_answer) */
  survey_id?: string;
  survey_answer?: { qid: string; op: "<=" | ">=" | "=" | "!="; value: string };
  clicked?: string;
  error_fingerprint?: string;
  event?: string;
  /** with event: its definition (event=<name> of a defined or built-in event) */
  event_match?: EventMatch;
  forced?: boolean;
  session_ids?: string[];
}

/** An event defined after the fact (or built in): a click and/or a page visit. */
export interface EventMatch {
  click?: { selector_contains?: string; label?: string; href_contains?: string; href_suffixes?: string[]; external?: boolean };
  page?: string;
}

/** SQL (over sessions s) that a session has an event matching the definition. */
export function eventMatchSql(m: EventMatch): { sql: string; args: SqlValue[] } {
  const args: SqlValue[] = [];
  if (m.click) {
    const w = ["e.session_id = s.id", "e.kind = 'click'"];
    if (m.click.selector_contains) {
      w.push("e.selector LIKE ? ESCAPE '\\'");
      args.push(`%${likeEscape(m.click.selector_contains)}%`);
    }
    if (m.click.label) {
      w.push("e.label = ?");
      args.push(m.click.label);
    }
    if (m.click.href_contains) {
      w.push("e.href LIKE ? ESCAPE '\\'");
      args.push(`%${likeEscape(m.click.href_contains)}%`);
    }
    if (m.click.external) w.push("e.href LIKE 'http%'");
    if (m.click.href_suffixes?.length) {
      w.push(`(${m.click.href_suffixes.map(() => "LOWER(e.href) LIKE ?").join(" OR ")})`);
      args.push(...m.click.href_suffixes.map((x) => `%${x}`));
    }
    if (m.page) {
      w.push("e.path GLOB ?");
      args.push(sqlGlob(m.page));
    }
    return { sql: `EXISTS (SELECT 1 FROM events e WHERE ${w.join(" AND ")})`, args };
  }
  return { sql: "EXISTS (SELECT 1 FROM pages p WHERE p.session_id = s.id AND p.path GLOB ?)", args: [sqlGlob(m.page ?? "*")] };
}

/** Does a click (or page) row match the definition? The same rules in JS, for funnels. */
export function rowMatches(
  m: EventMatch,
  r: { t: string; path: string | null; selector: string | null; label: string | null; href: string | null },
): boolean {
  if (m.page && !(r.path && globToRegExp(m.page).test(r.path))) return false;
  if (!m.click) return r.t === "p";
  if (r.t !== "c") return false;
  const c = m.click;
  if (c.selector_contains && !(r.selector ?? "").includes(c.selector_contains)) return false;
  if (c.label && r.label !== c.label) return false;
  if (c.href_contains && !(r.href ?? "").includes(c.href_contains)) return false;
  if (c.external && !(r.href ?? "").startsWith("http")) return false;
  if (c.href_suffixes?.length && !c.href_suffixes.some((x) => (r.href ?? "").toLowerCase().endsWith(x))) return false;
  return true;
}

export interface TagFilter {
  key: string;
  value?: string;
  not?: boolean;
}

export type SessionSort = "frustration" | "recent" | "duration" | "clicks" | "pageviews" | "active";

const SIGNAL_COLUMN: Record<Signal, string> = {
  rage_click: "rage_clicks",
  dead_click: "dead_clicks",
  error_click: "error_clicks",
  quick_back: "quick_backs",
  excessive_scroll: "excessive_scrolls",
  js_error: "errors",
  api_error: "api_errors",
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A filter value with an optional leading "!" (negation). */
const neg = (v: string | undefined): { not: boolean; v: string } | null =>
  v === undefined ? null : v.startsWith("!") ? { not: true, v: v.slice(1) } : { not: false, v };

/** WHERE clause over `sessions s` for the filters. String filters take a leading "!" to negate. */
export function sessionWhere(f: SessionFilters): { sql: string; args: SqlValue[] } {
  const w: string[] = ["s.started_at >= ?", "s.started_at <= ?"];
  const args: SqlValue[] = [f.start, f.end];
  const add = (sql: string, ...a: SqlValue[]) => {
    w.push(sql);
    args.push(...a);
  };
  /** `sql` holds the value; negated it is NOT (...) over COALESCE'd columns, so unknown values count as "not". */
  const opt = (raw: string | undefined, sql: string, value: (v: string) => SqlValue | SqlValue[]) => {
    const n = neg(raw);
    if (!n) return;
    const v = value(n.v);
    add(n.not ? `NOT (${sql})` : sql, ...(Array.isArray(v) ? v : [v]));
  };
  if (f.session_ids?.length) add(`s.id IN ${IN_JSON}`, JSON.stringify(f.session_ids));
  opt(f.page, "EXISTS (SELECT 1 FROM pages p WHERE p.session_id = s.id AND p.path GLOB ?)", sqlGlob);
  opt(f.entry_page, "COALESCE(s.entry_path, '') GLOB ?", sqlGlob);
  opt(f.exit_page, "COALESCE(s.exit_path, '') GLOB ?", sqlGlob);
  opt(f.referrer, "COALESCE(s.referrer, '') GLOB ?", (v) => sqlGlob(v.toLowerCase()));
  if (f.signal) add(`s.${SIGNAL_COLUMN[f.signal]} > 0`);
  if (f.has_error === true) add("s.errors > 0");
  if (f.has_error === false) add("s.errors = 0");
  opt(f.device, "COALESCE(s.device, '') = ?", (v) => v.toLowerCase());
  opt(f.browser, "LOWER(COALESCE(s.browser, '')) = ?", (v) => v.toLowerCase());
  opt(f.os, "LOWER(COALESCE(s.os, '')) = ?", (v) => v.toLowerCase());
  opt(f.country, "COALESCE(s.country, '') = ?", (v) => v.toUpperCase());
  opt(f.region, "LOWER(COALESCE(s.region, '')) = ?", (v) => v.toLowerCase());
  opt(f.city, "LOWER(COALESCE(s.city, '')) = ?", (v) => v.toLowerCase());
  if (f.min_duration_ms !== undefined) add("s.duration_ms >= ?", f.min_duration_ms);
  if (f.max_duration_ms !== undefined) add("s.duration_ms <= ?", f.max_duration_ms);
  if (f.min_frustration !== undefined) add("s.frustration >= ?", f.min_frustration);
  if (f.min_pageviews !== undefined) add("s.pageviews >= ?", f.min_pageviews);
  if (f.min_active_ms !== undefined) add("s.active_ms >= ?", f.min_active_ms);
  if (f.min_scroll_pct !== undefined)
    add("EXISTS (SELECT 1 FROM pages p WHERE p.session_id = s.id AND p.max_scroll >= ?)", f.min_scroll_pct);
  if (f.user_ids?.length) add(`s.user_id IN ${IN_JSON}`, JSON.stringify(f.user_ids));
  else if (f.user_id) add("s.user_id = ?", f.user_id);
  if (f.analytics_visitor_id) add("s.analytics_visitor_id = ?", f.analytics_visitor_id);
  for (const t of f.tags ?? [])
    add(
      `${t.not ? "NOT " : ""}EXISTS (SELECT 1 FROM session_tags t WHERE t.session_id = s.id AND t.key = ?${t.value !== undefined ? " AND t.value = ?" : ""})`,
      t.key,
      ...(t.value !== undefined ? [t.value] : []),
    );
  opt(
    f.clicked,
    "EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.kind = 'click' AND (e.selector LIKE ? ESCAPE '\\' OR e.label = ?))",
    (v) => [`%${likeEscape(v)}%`, v],
  );
  opt(
    f.error_fingerprint,
    "EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.fingerprint = ? AND e.kind IN ('error', 'net', 'warn'))",
    (v) => v,
  );
  if (f.event_match && f.event !== undefined) {
    const m = eventMatchSql(f.event_match);
    add(f.event.startsWith("!") ? `NOT ${m.sql}` : m.sql, ...m.args);
  } else opt(f.event, "EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.kind = 'event' AND e.label = ?)", (v) => v);
  if (f.forced !== undefined) add("s.forced = ?", f.forced ? 1 : 0);
  if (f.received_since !== undefined) add("s.received_at >= ?", f.received_since);
  if (f.starred !== undefined) add("s.starred = ?", f.starred ? 1 : 0);
  if (f.upgraded !== undefined) add(f.upgraded ? "s.upgraded IS NOT NULL" : "s.upgraded IS NULL");
  opt(f.label, "EXISTS (SELECT 1 FROM session_labels l WHERE l.session_id = s.id AND l.label = ?)", (v) => v);
  if (f.survey_id) {
    const a = f.survey_answer;
    let cond = "";
    const ca: SqlValue[] = [];
    if (a) {
      const path = `$.${a.qid}`;
      if (a.op === "<=" || a.op === ">=") {
        cond = ` AND CAST(json_extract(r.answers, ?) AS REAL) ${a.op} ?`;
        ca.push(path, Number(a.value));
      } else {
        cond = ` AND ${a.op === "!=" ? "NOT " : ""}EXISTS (SELECT 1 FROM json_each(r.answers, ?) j WHERE CAST(j.value AS TEXT) = ?)`;
        ca.push(path, a.value);
      }
    }
    add(`EXISTS (SELECT 1 FROM survey_responses r WHERE r.session_id = s.id AND r.survey_id = ?${cond})`, f.survey_id, ...ca);
  }
  return { sql: w.join(" AND "), args };
}

const ORDER: Record<SessionSort, { col: string; sql: string }> = {
  frustration: { col: "frustration", sql: "s.frustration DESC, s.started_at DESC, s.id DESC" },
  recent: { col: "started_at", sql: "s.started_at DESC, s.id DESC" },
  duration: { col: "duration_ms", sql: "s.duration_ms DESC, s.started_at DESC, s.id DESC" },
  clicks: { col: "clicks", sql: "s.clicks DESC, s.started_at DESC, s.id DESC" },
  pageviews: { col: "pageviews", sql: "s.pageviews DESC, s.started_at DESC, s.id DESC" },
  active: { col: "active_ms", sql: "s.active_ms DESC, s.started_at DESC, s.id DESC" },
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

export function sessionTags(db: Db, id: string): TagRow[] {
  return db.all("SELECT key, value, ts FROM session_tags WHERE session_id = ? ORDER BY key, ts, value LIMIT 100", [
    id,
  ]) as unknown as TagRow[];
}

export function transcriptData(db: Db, id: string, opts: { maxEvents: number; kinds?: string[] | null }) {
  const session = getSessionRow(db, id);
  if (!session) return null;
  const pages = opts.kinds && !opts.kinds.includes("page") ? [] : sessionPages(db, id);
  const kinds = opts.kinds?.filter((k) => k !== "page" && k !== "tag" && k !== "note");
  const kindSql = kinds?.length ? ` AND kind IN (${marks(kinds.length)})` : opts.kinds ? " AND 0" : "";
  const events = db.all(`SELECT * FROM events WHERE session_id = ?${kindSql} ORDER BY ts, id LIMIT ?`, [
    id,
    ...(kinds?.length ? kinds : []),
    opts.maxEvents + 1,
  ]) as unknown as EventRow[];
  const truncated = events.length > opts.maxEvents;
  const tags =
    opts.kinds && !opts.kinds.includes("tag")
      ? []
      : (db.all("SELECT key, value, ts FROM session_tags WHERE session_id = ? ORDER BY ts, key, value LIMIT 100", [
          id,
        ]) as unknown as TagRow[]);
  const notes =
    opts.kinds && !opts.kinds.includes("note")
      ? []
      : (db.all("SELECT id, t_ms, text FROM notes WHERE session_id = ? ORDER BY t_ms, created_at LIMIT 200", [id]) as unknown as {
          id: string;
          t_ms: number;
          text: string;
        }[]);
  return { session, pages, events: events.slice(0, opts.maxEvents), truncated, tags, notes };
}

export function findVisitorSessions(db: Db, q: { user_id?: string; user_ids?: string[]; analytics_visitor_id?: string }): string[] {
  const w: string[] = [];
  const a: SqlValue[] = [];
  const uids = q.user_ids?.length ? q.user_ids : q.user_id ? [q.user_id] : [];
  if (uids.length) {
    w.push(`user_id IN ${IN_JSON}`);
    a.push(JSON.stringify(uids));
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
       SUM(COALESCE(api_errors, 0) > 0) AS api, AVG(active_ms) AS avg_active,
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
  const failedRequests = db
    .all(
      `SELECT fingerprint, MAX(tag) AS method, MAX(href) AS url, MAX(json_extract(detail, '$.status')) AS status, COUNT(DISTINCT session_id) AS sessions,
         COUNT(*) AS occurrences, SUM(error_click) AS after_click, GROUP_CONCAT(DISTINCT path) AS paths, GROUP_CONCAT(DISTINCT session_id) AS ex
       FROM events WHERE kind = 'net' AND session_id IN ${inIds} GROUP BY fingerprint ORDER BY sessions DESC, occurrences DESC, fingerprint LIMIT ?`,
      [idsArg, top],
    )
    .map((r) => ({
      fingerprint: strOrNull(r.fingerprint),
      method: strOrNull(r.method),
      url: strOrNull(r.url),
      status: num(r.status),
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
  const topTags = db
    .all(
      `SELECT key, value, COUNT(DISTINCT session_id) AS sessions, GROUP_CONCAT(DISTINCT session_id) AS ex FROM session_tags
       WHERE session_id IN ${inIds} GROUP BY key, value ORDER BY sessions DESC, key, value LIMIT ?`,
      [idsArg, top],
    )
    .map((r) => ({ key: String(r.key), value: String(r.value), sessions: num(r.sessions), example_session_ids: examples(r.ex) }));
  const n = num(agg.n);
  const result = {
    sessions_matching: total,
    sessions_considered: n,
    avg_duration_ms: Math.round(num(agg.avg_ms)),
    avg_active_ms: Math.round(num(agg.avg_active)),
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
      api_error: num(agg.api),
    },
    top_rage_targets: rage,
    top_dead_clicks: clickGroup("dead = 1", ""),
    top_error_clicks: clickGroup("error_click = 1"),
    top_errors: errors,
    top_failed_requests: failedRequests,
    quick_back_pages: pageGroup("quick_back"),
    excessive_scroll_pages: pageGroup("excessive_scroll"),
    not_clickable_but_clicked: clickGroup("interactive = 0"),
    entry_pages: sessionGroup("entry_path"),
    exit_pages: sessionGroup("exit_path"),
    devices: sessionGroup("device"),
    browsers: sessionGroup("browser"),
    countries: sessionGroup("country"),
    top_tags: topTags,
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
  top_failed_requests?: { method: string | null; url: string | null; status: number; sessions: number; after_click: number }[];
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
  for (const r of (s.top_failed_requests ?? []).slice(0, 2))
    out.push({
      weight: r.sessions * 2.2,
      text: `${r.sessions} of ${n} sessions (${pct(r.sessions, n)}%) had ${r.method} ${JSON.stringify(r.url)} fail (${r.status || "network error"})${r.after_click ? `, ${r.after_click} time(s) right after a click` : ""}.`,
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
  /** only clicks and pageviews of sessions matching these (live rows only: daily aggregates have no sessions) */
  sessions?: SessionFilters | null;
  /** first / last click of each pageview only (live rows) */
  click?: "all" | "first" | "last";
  sort?: "clicks" | "rage" | "dead" | "error";
  /** per element: the share of its clicking sessions that later had this afsr('event') (live rows) */
  converted_event?: string | null;
}

/** `AND <col> IN (sessions matching f)`, or nothing. */
function sessionScope(col: string, f: SessionFilters | null | undefined): { sql: string; args: SqlValue[] } {
  if (!f) return { sql: "", args: [] };
  const w = sessionWhere(f);
  return { sql: ` AND ${col} IN (SELECT s.id FROM sessions s WHERE ${w.sql})`, args: w.args };
}

export function heatmap(db: Db, q: HeatmapRequest) {
  const rolledThrough = strOrNull(db.all("SELECT value FROM meta WHERE key = 'rolled_through'")[0]?.value);
  // Days up to rolled_through come from the daily aggregates (whole days), later ones from live rows.
  // Session filters need live rows: the aggregates don't know sessions.
  const clickMode = q.click ?? "all";
  const through = q.sessions || clickMode !== "all" || q.converted_event ? null : rolledThrough;
  const scope = sessionScope("session_id", q.sessions);
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
      zone: string | null;
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
      zone: null,
    };
    if (!e.zone && r.zone) e.zone = String(r.zone);
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
  const attention = new Array<number>(ATTENTION_BANDS).fill(0);
  const bandClicks = new Array<number>(ATTENTION_BANDS).fill(0);
  let pageviews = 0;
  let foldSum = 0;
  let foldN = 0;
  let sessions = 0;
  const conversions = new Map<string, { clickers: number; converted: number }>();
  if (liveFrom <= q.end) {
    const devSql = (dev ? " AND device = ?" : "") + scope.sql;
    const a: SqlValue[] = [glob, liveFrom, q.end, ...(dev ? [dev] : []), ...scope.args];
    // first/last click of each pageview: the click whose time is the pageview's earliest/latest
    const pick =
      clickMode === "all"
        ? ""
        : ` AND ts = (SELECT ${clickMode === "first" ? "MIN" : "MAX"}(e2.ts) FROM events e2 WHERE e2.session_id = events.session_id AND e2.pv = events.pv AND e2.kind = 'click')`;
    for (const r of db.all(
      `SELECT path, selector, MAX(label) AS label, MAX(tag) AS tag, MAX(interactive) AS interactive, COUNT(*) AS clicks, COUNT(DISTINCT session_id) AS sessions,
         SUM(rage) AS rage, SUM(dead) AS dead, SUM(error_click) AS error_clicks, COALESCE(SUM(top_pct), 0) AS top_sum, COUNT(top_pct) AS top_n, MAX(zone) AS zone
       FROM events WHERE kind IN ('click', 'error') AND kind = 'click' AND path GLOB ? AND ts >= ? AND ts <= ? AND selector IS NOT NULL${devSql}${pick}
       GROUP BY path, selector`,
      a,
    ))
      addEl(r);
    if (q.converted_event)
      for (const r of db.all(
        `SELECT selector, COUNT(DISTINCT session_id) AS clickers,
           COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM events x WHERE x.session_id = events.session_id AND x.kind = 'event' AND x.label = ? AND x.ts > events.ts)
             THEN session_id END) AS converted
         FROM events WHERE kind IN ('click', 'error') AND kind = 'click' AND path GLOB ? AND ts >= ? AND ts <= ? AND selector IS NOT NULL${devSql}${pick}
         GROUP BY selector`,
        [q.converted_event, ...a],
      ))
        conversions.set(String(r.selector), { clickers: num(r.clickers), converted: num(r.converted) });
    const p = db.all(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions, ${REACH_BUCKETS.map((b) => `SUM(max_scroll >= ${b}) AS r${b}`).join(", ")},
         COALESCE(SUM(CASE WHEN doc_h > 0 AND view_h > 0 THEN MIN(100, view_h * 100 / doc_h) END), 0) AS fold_sum,
         SUM(CASE WHEN doc_h > 0 AND view_h > 0 THEN 1 ELSE 0 END) AS fold_n
       FROM pages WHERE path GLOB ? AND ts >= ? AND ts <= ?${devSql}`,
      a,
    )[0]!;
    for (const r of db.all(`SELECT attention FROM pages WHERE path GLOB ? AND ts >= ? AND ts <= ? AND attention IS NOT NULL${devSql}`, a))
      (JSON.parse(String(r.attention)) as number[]).forEach((v, i) => {
        if (i < ATTENTION_BANDS) attention[i]! += v;
      });
    for (const r of db.all(
      `SELECT MIN(${ATTENTION_BANDS - 1}, y * ${ATTENTION_BANDS} / doc_h) AS b, COUNT(*) AS n FROM events
       WHERE kind IN ('click', 'error') AND kind = 'click' AND path GLOB ? AND ts >= ? AND ts <= ? AND doc_h > 0${devSql}${pick} GROUP BY b`,
      a,
    ))
      bandClicks[Math.max(0, Math.min(ATTENTION_BANDS - 1, num(r.b)))]! += num(r.n);
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
         SUM(rage) AS rage, SUM(dead) AS dead, SUM(error_clicks) AS error_clicks, SUM(top_sum) AS top_sum, SUM(top_n) AS top_n, MAX(zone) AS zone
       FROM heat_daily WHERE path GLOB ? AND day >= ? AND day <= ?${devSql} GROUP BY path, selector`,
      a,
    ))
      addEl(r);
    for (const r of db.all(
      `SELECT pageviews, reach, fold_sum, fold_n, attention, click_bands FROM scroll_daily WHERE path GLOB ? AND day >= ? AND day <= ?${devSql}`,
      a,
    )) {
      for (const [col, into] of [
        ["attention", attention],
        ["click_bands", bandClicks],
      ] as const)
        if (r[col])
          (JSON.parse(String(r[col])) as number[]).forEach((v, i) => {
            if (i < ATTENTION_BANDS) into[i]! += v;
          });
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
  const key = { clicks: "clicks", rage: "rage", dead: "dead", error: "error_clicks" } as const;
  const k = key[q.sort ?? "clicks"];
  const list = [...elements.values()]
    .sort((a, b) => b[k] - a[k] || b.clicks - a.clicks || a.selector.localeCompare(b.selector))
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
        ...(q.converted_event
          ? (() => {
              const c = conversions.get(e.selector);
              return {
                converted_sessions: c?.converted ?? 0,
                conversion_share: c?.clickers ? Math.round((c.converted / c.clickers) * 1000) / 1000 : 0,
              };
            })()
          : {}),
        paths: [...e.paths].slice(0, 5),
        zone: e.zone,
      };
    });
  // Zones: clicks grouped by the zone the recorder put them in (configured zones or landmarks).
  const zoneMap = new Map<string, { zone: string; clicks: number; elements: number; rage: number; dead: number; error_clicks: number }>();
  for (const e of elements.values()) {
    const z = e.zone ?? "(no zone)";
    const g = zoneMap.get(z) ?? { zone: z, clicks: 0, elements: 0, rage: 0, dead: 0, error_clicks: 0 };
    g.clicks += e.clicks;
    g.elements++;
    g.rage += e.rage;
    g.dead += e.dead;
    g.error_clicks += e.error_clicks;
    zoneMap.set(z, g);
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const zones = [...zoneMap.values()]
    .sort((x, y) => y.clicks - x.clicks || x.zone.localeCompare(y.zone))
    .map((g) => ({
      zone: g.zone,
      clicks: g.clicks,
      click_share: totalClicks ? r3(g.clicks / totalClicks) : 0,
      elements: g.elements,
      rage_share: g.clicks ? r3(g.rage / g.clicks) : 0,
      dead_share: g.clicks ? r3(g.dead / g.clicks) : 0,
      error_share: g.clicks ? r3(g.error_clicks / g.clicks) : 0,
    }));
  const attTotal = attention.reduce((x, y) => x + y, 0);
  const attentionBands = attention.map((ms, i) => ({
    from_pct: i * (100 / ATTENTION_BANDS),
    to_pct: (i + 1) * (100 / ATTENTION_BANDS),
    avg_visible_ms: pageviews ? Math.round(ms / pageviews) : 0,
    time_share: attTotal ? r3(ms / attTotal) : 0,
    clicks: bandClicks[i]!,
    click_share: totalClicks ? r3(bandClicks[i]! / totalClicks) : 0,
  }));
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
    zones,
    attention: attentionBands,
    scroll: {
      pageviews,
      reach: curve,
      median_reach_pct: median,
      avg_fold_pct: foldN ? Math.round(foldSum / foldN) : null,
    },
    rolled_up_through: through,
    session_filtered: !!q.sessions,
    click: clickMode,
    live_only: through === null && rolledThrough !== null,
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
  /** only errors of sessions matching these */
  sessions?: SessionFilters | null;
  /** events kind: error (default), net (failed requests) or warn (console.warn) */
  kind?: "error" | "net" | "warn";
}

export function listErrors(db: Db, q: ErrorsRequest) {
  // The first term is the partial index's own (SQLite uses a partial index only when it is repeated).
  const kind = q.kind ?? "error";
  const w = [
    kind === "error" ? "e.kind IN ('click', 'error')" : "e.kind IN ('net', 'warn')",
    `e.kind = '${kind}'`,
    "e.ts >= ?",
    "e.ts <= ?",
  ];
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
  if (q.sessions) {
    const sw = sessionWhere(q.sessions);
    w.push(`e.session_id IN (SELECT s.id FROM sessions s WHERE ${sw.sql})`);
    a.push(...sw.args);
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
    const sample = db.all(
      `SELECT e.message, e.detail, e.session_id, e.path, e.tag, e.href FROM events e WHERE ${gw} ORDER BY e.ts DESC LIMIT 1`,
      ga,
    )[0];
    const d = sample?.detail ? (JSON.parse(String(sample.detail)) as Record<string, unknown>) : {};
    const request =
      kind === "net"
        ? {
            method: strOrNull(sample?.tag),
            url: strOrNull(sample?.href),
            status: typeof d.status === "number" ? d.status : 0,
            avg_ms: Math.round(num(db.all(`SELECT AVG(json_extract(e.detail, '$.ms')) AS v FROM events e WHERE ${gw}`, ga)[0]?.v)),
          }
        : undefined;
    const top = (sql: string) => db.all(sql, ga).map((r) => ({ value: strOrNull(r.v), count: num(r.n) }));
    return {
      fingerprint: fp,
      message: strOrNull(sample?.message),
      kind: kind === "net" ? "network" : kind === "warn" ? "console_warn" : typeof d.kind === "string" ? d.kind : "error",
      ...(request ? { request } : {}),
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

export type FunnelStep = { type: "page"; pattern: string } | { type: "event"; name: string; match?: EventMatch };

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
  const matchers = q.steps.map((s) =>
    s.type === "page" ? { t: "p", re: globToRegExp(s.pattern) } : { t: "e", name: s.name, match: s.match },
  );
  const clicks = q.steps.some((s) => s.type === "event" && s.match?.click);
  // ms from reaching the previous step to reaching this one, per session that converted
  const gaps: number[][] = q.steps.map(() => []);
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const inIds = IN_JSON;
    const arg = JSON.stringify(batch);
    const rows = db.all(
      `SELECT session_id, ts, 'p' AS t, path AS v, path, NULL AS selector, NULL AS label, NULL AS href FROM pages WHERE session_id IN ${inIds} AND path IS NOT NULL
       UNION ALL SELECT session_id, ts, 'e' AS t, label AS v, path, NULL, NULL, NULL FROM events WHERE kind = 'event' AND session_id IN ${inIds}
       ${clicks ? `UNION ALL SELECT session_id, ts, 'c' AS t, label AS v, path, selector, label, href FROM events WHERE kind = 'click' AND session_id IN ${inIds}` : ""}
       ORDER BY session_id, ts`,
      clicks ? [arg, arg, arg] : [arg, arg],
    );
    let cur = "";
    let step = 0;
    let prevTs = 0;
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
      const hit =
        m.t === "p"
          ? r.t === "p" && (m as { re: RegExp }).re.test(v)
          : (m as { match?: EventMatch }).match
            ? rowMatches((m as { match: EventMatch }).match, {
                t: String(r.t),
                path: strOrNull(r.path),
                selector: strOrNull(r.selector),
                label: strOrNull(r.label),
                href: strOrNull(r.href),
              })
            : r.t === "e" && v === (m as { name: string }).name;
      if (hit) {
        const ts = num(r.ts);
        if (step > 0) gaps[step]!.push(Math.max(0, ts - prevTs));
        prevTs = ts;
        step++;
      }
    }
    flush();
  }
  const steps = q.steps.map((s, i) => {
    const r = reached[i]!;
    const next = i + 1 < q.steps.length ? reached[i + 1]! : null;
    const g = [...gaps[i]!].sort((a, b) => a - b);
    const at = (p: number) => (g.length ? g[Math.min(g.length - 1, Math.floor(p * g.length))]! : null);
    return {
      step: i + 1,
      match: s.type === "page" ? s.pattern : `event:${s.name}`,
      sessions: r,
      dropped: next === null ? null : r - next,
      conversion_from_previous: i === 0 ? null : reached[i - 1] ? Math.round((r / reached[i - 1]!) * 1000) / 1000 : 0,
      // time to convert from the previous step (sessions that reached this one)
      median_ms_from_previous: i === 0 ? null : at(0.5),
      p75_ms_from_previous: i === 0 ? null : at(0.75),
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

// ---------------------------------------------------------------------------------- metrics (trends)

export type Interval = "hour" | "day" | "week";
export const INTERVAL_MS: Record<Interval, number> = { hour: 3_600_000, day: DAY, week: 7 * DAY };

/** SQL for the start of the bucket a unix-ms column falls in (weeks start on Monday, UTC). */
export function bucketSql(col: string, interval: Interval): string {
  if (interval === "hour") return `((${col} / 3600000) * 3600000)`;
  if (interval === "day") return `((${col} / 86400000) * 86400000)`;
  // 1970-01-01 was a Thursday: day d's Monday is d - ((d + 3) % 7)
  return `(((${col} / 86400000) - (((${col} / 86400000) + 3) % 7)) * 86400000)`;
}

export function bucketStart(ts: number, interval: Interval): number {
  if (interval === "hour") return Math.floor(ts / 3_600_000) * 3_600_000;
  const d = Math.floor(ts / DAY);
  return (interval === "day" ? d : d - ((d + 3) % 7)) * DAY;
}

export type MetricsBy =
  | { kind: "session"; col: "device" | "browser" | "os" | "country" | "entry_path" | "exit_path" | "referrer" }
  | { kind: "tag"; key: string }
  | { kind: "page" };

export interface MetricsRequest extends SessionFilters {
  interval: Interval;
  by?: MetricsBy | null;
  limit: number;
}

const SESSION_METRICS = `COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews, AVG(s.duration_ms) AS avg_ms, AVG(s.active_ms) AS avg_active,
  SUM(s.rage_clicks > 0) AS rage, SUM(s.dead_clicks > 0) AS dead, SUM(s.dead_interactive > 0) AS dead_i, SUM(s.error_clicks > 0) AS error_clicks,
  SUM(s.quick_backs > 0) AS qb, SUM(s.excessive_scrolls > 0) AS ex, SUM(s.errors > 0) AS err_sessions, COALESCE(SUM(s.errors), 0) AS errors,
  SUM(COALESCE(s.api_errors, 0) > 0) AS api_sessions, COALESCE(SUM(s.api_errors), 0) AS api_errors, AVG(s.frustration) AS frustration`;

const share = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0);

function sessionMetrics(r: Record<string, SqlValue> | undefined) {
  const n = num(r?.sessions);
  return {
    sessions: n,
    pageviews: num(r?.pageviews),
    avg_duration_ms: Math.round(num(r?.avg_ms)),
    avg_active_ms: Math.round(num(r?.avg_active)),
    avg_frustration: Math.round(num(r?.frustration)),
    js_errors: num(r?.errors),
    api_errors: num(r?.api_errors),
    share_with: {
      rage_click: share(num(r?.rage), n),
      dead_click: share(num(r?.dead), n),
      dead_click_interactive: share(num(r?.dead_i), n),
      error_click: share(num(r?.error_clicks), n),
      quick_back: share(num(r?.qb), n),
      excessive_scroll: share(num(r?.ex), n),
      js_error: share(num(r?.err_sessions), n),
      api_error: share(num(r?.api_sessions), n),
    },
  };
}

const REACH_SQL = REACH_BUCKETS.map((b) => `SUM(p.max_scroll >= ${b}) AS r${b}`).join(", ");
/** The median of pageviews' scroll reach from bucket counts: the deepest 10% step half of them reached. */
function medianReach(r: Record<string, SqlValue> | undefined): number | null {
  const n = num(r?.n);
  if (!n) return null;
  let m = 0;
  for (const b of REACH_BUCKETS) if (num(r?.[`r${b}`]) / n >= 0.5) m = b;
  return m;
}

/**
 * Sessions over time (and per dimension value): counts, durations, active time, the share of
 * sessions with each signal, error counts and median scroll reach, per hour, day or week (UTC).
 * Buckets with no sessions are returned as zeros. Bounded by the period (at most 1,000 buckets)
 * and by `limit` dimension values; every query is one GROUP BY over the site's sessions.
 */
export function metrics(db: Db, q: MetricsRequest) {
  const where = sessionWhere(q);
  const bs = bucketSql("s.started_at", q.interval);
  const step = INTERVAL_MS[q.interval];
  const first = bucketStart(q.start, q.interval);
  const last = bucketStart(q.end, q.interval);
  const totalsRow = db.all(`SELECT ${SESSION_METRICS} FROM sessions s WHERE ${where.sql}`, where.args)[0];
  const scrollTotal = db.all(
    `SELECT COUNT(*) AS n, ${REACH_SQL} FROM pages p JOIN sessions s ON s.id = p.session_id WHERE ${where.sql} AND p.path IS NOT NULL`,
    where.args,
  )[0];
  const byBucket = new Map<number, Record<string, SqlValue>>();
  for (const r of db.all(`SELECT ${bs} AS b, ${SESSION_METRICS} FROM sessions s WHERE ${where.sql} GROUP BY b`, where.args))
    byBucket.set(num(r.b), r);
  const scrollBucket = new Map<number, Record<string, SqlValue>>();
  for (const r of db.all(
    `SELECT ${bs} AS b, COUNT(*) AS n, ${REACH_SQL} FROM pages p JOIN sessions s ON s.id = p.session_id WHERE ${where.sql} AND p.path IS NOT NULL GROUP BY b`,
    where.args,
  ))
    scrollBucket.set(num(r.b), r);
  const series: Record<string, unknown>[] = [];
  // From the first bucket with data when the period is "all" (start 0), else from the period start.
  const from = q.start === 0 ? Math.min(...[...byBucket.keys(), last]) : first;
  for (let b = from; b <= last && series.length < 1000; b += step) {
    series.push({ start: b, ...sessionMetrics(byBucket.get(b)), median_scroll_pct: medianReach(scrollBucket.get(b)) });
  }
  const out: Record<string, unknown> = {
    totals: { ...sessionMetrics(totalsRow), median_scroll_pct: medianReach(scrollTotal) },
    series,
  };
  if (!q.by) return out;
  let rows: Record<string, unknown>[] = [];
  if (q.by.kind === "page") {
    const pageSql = `COUNT(*) AS pageviews, COUNT(DISTINCT p.session_id) AS sessions, AVG(CASE WHEN p.left_at >= p.ts THEN p.left_at - p.ts END) AS stayed,
      AVG(p.active_ms) AS active, SUM(p.quick_back) AS qb, SUM(p.excessive_scroll) AS ex, ${REACH_SQL}, COUNT(*) AS n`;
    const top = db.all(
      `SELECT p.path AS v, ${pageSql} FROM pages p JOIN sessions s ON s.id = p.session_id WHERE ${where.sql} AND p.path IS NOT NULL
       GROUP BY p.path ORDER BY pageviews DESC, p.path LIMIT ?`,
      [...where.args, q.limit],
    );
    const values = top.map((r) => String(r.v));
    const per = new Map<string, Map<number, number>>();
    if (values.length)
      for (const r of db.all(
        `SELECT p.path AS v, ${bucketSql("p.ts", q.interval)} AS b, COUNT(*) AS n FROM pages p JOIN sessions s ON s.id = p.session_id
         WHERE ${where.sql} AND p.path IN ${IN_JSON} GROUP BY v, b`,
        [...where.args, JSON.stringify(values)],
      )) {
        const m = per.get(String(r.v)) ?? new Map<number, number>();
        m.set(num(r.b), num(r.n));
        per.set(String(r.v), m);
      }
    rows = top.map((r) => ({
      value: String(r.v),
      pageviews: num(r.pageviews),
      sessions: num(r.sessions),
      avg_stayed_ms: Math.round(num(r.stayed)),
      avg_active_ms: Math.round(num(r.active)),
      quick_back_share: share(num(r.qb), num(r.pageviews)),
      excessive_scroll_share: share(num(r.ex), num(r.pageviews)),
      median_scroll_pct: medianReach(r),
      series: series.map((b) => ({ start: b.start, pageviews: per.get(String(r.v))?.get(b.start as number) ?? 0 })),
    }));
  } else {
    const join = q.by.kind === "tag" ? "JOIN session_tags t ON t.session_id = s.id AND t.key = ?" : "";
    const v = q.by.kind === "tag" ? "t.value" : `COALESCE(s.${q.by.col}, '')`;
    const jargs = q.by.kind === "tag" ? [q.by.key] : [];
    const top = db.all(
      `SELECT ${v} AS v, ${SESSION_METRICS} FROM sessions s ${join} WHERE ${where.sql} GROUP BY v ORDER BY sessions DESC, v LIMIT ?`,
      [...jargs, ...where.args, q.limit],
    );
    const values = top.map((r) => String(r.v));
    const per = new Map<string, Map<number, number>>();
    if (values.length)
      for (const r of db.all(
        `SELECT ${v} AS v, ${bs} AS b, COUNT(*) AS n FROM sessions s ${join} WHERE ${where.sql} AND ${v} IN ${IN_JSON} GROUP BY v, b`,
        [...jargs, ...where.args, JSON.stringify(values)],
      )) {
        const m = per.get(String(r.v)) ?? new Map<number, number>();
        m.set(num(r.b), num(r.n));
        per.set(String(r.v), m);
      }
    rows = top.map((r) => ({
      value: String(r.v) || null,
      ...sessionMetrics(r),
      series: series.map((b) => ({ start: b.start, sessions: per.get(String(r.v))?.get(b.start as number) ?? 0 })),
    }));
  }
  return { ...out, breakdown: rows };
}

// ---------------------------------------------------------------------------------- visitor (data access)

/** Everything stored about one visitor: sessions, their tags, survey responses (DSAR "access"). */
export function visitorData(db: Db, q: { user_ids?: string[]; analytics_visitor_id?: string }) {
  const ids = findVisitorSessions(db, q).slice(0, 1000);
  const sessions = ids.length
    ? (db.all(`SELECT * FROM sessions WHERE id IN ${IN_JSON} ORDER BY started_at DESC LIMIT 100`, [
        JSON.stringify(ids),
      ]) as unknown as SessionRow[])
    : [];
  const tags = ids.length
    ? (db.all(`SELECT DISTINCT key, value FROM session_tags WHERE session_id IN ${IN_JSON} ORDER BY key, value LIMIT 500`, [
        JSON.stringify(ids),
      ]) as unknown as {
        key: string;
        value: string;
      }[])
    : [];
  const notes = ids.length ? num(db.all(`SELECT COUNT(*) AS n FROM notes WHERE session_id IN ${IN_JSON}`, [JSON.stringify(ids)])[0]?.n) : 0;
  return { session_count: ids.length, sessions, tags, notes };
}
