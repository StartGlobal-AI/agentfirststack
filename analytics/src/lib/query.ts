/**
 * SQL builders for the per-site SQLite (run inside SiteDO). Pure: they return { sql, args }.
 *
 * Safety rule: every user-supplied value (filter values, prop keys, goal names, patterns, limits)
 * goes through a bound parameter. The only text spliced into SQL comes from fixed tables in this
 * file and filters.ts, or integers this code computed (timezone offsets), checked with
 * Number.isSafeInteger.
 *
 * Schema (see do/schema.ts): events e, sessions s, goals g (synced copy of the site's goals).
 */

import { DIMENSION_SQL, type Breakdown, type Filter, type FilterOp, NONE, PROP_KEY_RE } from "./filters";

export type SqlValue = string | number | null;
export interface Frag {
  sql: string;
  args: SqlValue[];
}

export const raw = (s: string): Frag => ({ sql: s, args: [] });
const EMPTY = raw("");

/** Tagged template: Frag values are inlined, everything else becomes a `?` parameter. */
export function sql(strings: TemplateStringsArray, ...vals: (Frag | SqlValue)[]): Frag {
  let text = strings[0]!;
  const args: SqlValue[] = [];
  vals.forEach((v, i) => {
    if (v !== null && typeof v === "object" && "sql" in v) {
      text += v.sql;
      args.push(...v.args);
    } else {
      text += "?";
      args.push(v as SqlValue);
    }
    text += strings[i + 1]!;
  });
  return { sql: text, args };
}

export function join(frags: Frag[], sep: string): Frag {
  return { sql: frags.map((f) => f.sql).join(sep), args: frags.flatMap((f) => f.args) };
}

const list = (values: SqlValue[]): Frag =>
  join(
    values.map((v) => sql`${v}`),
    ", ",
  );

export function int(n: number): Frag {
  if (!Number.isSafeInteger(n)) throw new Error("not a safe integer");
  return raw(String(n));
}

/** `*` wildcard path pattern -> SQLite GLOB with every other GLOB metachar escaped. */
export function toGlob(pattern: string): string {
  return pattern.replace(/[[?]/g, (c) => `[${c}]`);
}

// ---------------------------------------------------------------- goals

/** A goal matches an event: by name, by page path, or by page path once scrolled past its threshold. */
export const GOAL_MATCH =
  "((g.type = 'event' AND e.name = g.match) OR (g.type = 'pageview' AND e.name = 'pageview' AND e.pathname GLOB g.glob) OR (g.type = 'scroll' AND e.name = 'pageview' AND e.pathname GLOB g.glob AND e.scroll_depth >= g.threshold))";
const goalValue = raw(`(SELECT g.value FROM goals g WHERE ${GOAL_MATCH} AND g.value IS NOT NULL ORDER BY g.created_at LIMIT 1)`);

export interface QueryCtx {
  start: number;
  end: number;
  filters: Filter[];
  /** site has at least one goal / at least one goal with a value (lets us skip subqueries) */
  hasGoals: boolean;
  hasGoalValues: boolean;
}

/** Goal names named by `goal==...` filters: conversions then count only those goals. */
export function goalFilterNames(filters: Filter[]): string[] | null {
  const f = filters.filter((x) => x.key === "goal" && x.op === "==");
  if (!f.length) return null;
  return f.flatMap((x) => x.values);
}

export function conversionCond(ctx: QueryCtx): Frag {
  const names = goalFilterNames(ctx.filters);
  return sql`EXISTS (SELECT 1 FROM goals g WHERE ${raw(GOAL_MATCH)}${names ? sql` AND g.name IN (${list(names)})` : EMPTY})`;
}

// ---------------------------------------------------------------- filters

export function columnFor(key: string): Frag {
  if (key.startsWith("prop:")) {
    const k = key.slice(5);
    if (!PROP_KEY_RE.test(k)) throw new Error("bad prop key");
    return sql`json_extract(e.props, ${`$."${k}"`})`;
  }
  const col = DIMENSION_SQL[key as keyof typeof DIMENSION_SQL];
  if (!col) throw new Error(`unknown dimension ${key}`);
  return raw(col);
}

export function valueCond(col: Frag, op: FilterOp, values: string[]): Frag {
  const hasNone = values.includes(NONE);
  const vals = values.filter((v) => v !== NONE);
  const contains = () =>
    join(
      vals.map((v) => sql`instr(lower(${col}), lower(${v})) > 0`),
      " OR ",
    );
  switch (op) {
    case "==": {
      const parts: Frag[] = [];
      if (vals.length) parts.push(sql`${col} IN (${list(vals)})`);
      if (hasNone) parts.push(sql`${col} IS NULL`);
      return sql`(${join(parts, " OR ")})`;
    }
    case "!=": {
      if (!vals.length) return sql`${col} IS NOT NULL`;
      if (hasNone) return sql`(${col} IS NOT NULL AND ${col} NOT IN (${list(vals)}))`;
      return sql`(${col} IS NULL OR ${col} NOT IN (${list(vals)}))`;
    }
    case "~": {
      const parts: Frag[] = [];
      if (vals.length) parts.push(contains());
      if (hasNone) parts.push(sql`${col} IS NULL`);
      return sql`(${join(parts, " OR ")})`;
    }
    case "!~": {
      if (!vals.length) return sql`${col} IS NOT NULL`;
      return sql`(${col} IS NULL OR NOT (${contains()}))`;
    }
  }
}

function filterFrag(f: Filter, ctx: QueryCtx): Frag {
  if (f.key === "goal") {
    // Goal filters are session-level: keep events of sessions that completed the goal(s).
    const nameCol = raw("g.name");
    const converted = sql`SELECT e.session_id FROM events e JOIN goals g ON ${raw(GOAL_MATCH)} WHERE e.ts >= ${ctx.start} AND e.ts < ${ctx.end} AND ${valueCond(
      nameCol,
      f.op === "!=" ? "==" : f.op === "!~" ? "~" : f.op,
      f.values,
    )}`;
    const negate = f.op === "!=" || f.op === "!~";
    return sql`e.session_id ${raw(negate ? "NOT IN" : "IN")} (${converted})`;
  }
  if (f.key === "entry_page" || f.key === "exit_page") {
    const col = raw(f.key === "entry_page" ? "s.entry_page" : "s.exit_page");
    return sql`e.session_id IN (SELECT s.id FROM sessions s WHERE ${valueCond(col, f.op, f.values)})`;
  }
  return valueCond(columnFor(f.key), f.op, f.values);
}

export function whereFrag(ctx: QueryCtx): Frag {
  return join([sql`e.ts >= ${ctx.start} AND e.ts < ${ctx.end}`, ...ctx.filters.map((f) => filterFrag(f, ctx))], " AND ");
}

export const evCte = (ctx: QueryCtx) => sql`ev AS (SELECT e.* FROM events e WHERE ${whereFrag(ctx)})`;

// ---------------------------------------------------------------- metrics

/**
 * Payments (Stripe, POST /payments) are stored as events with origin 'payment' so revenue flows
 * through every breakdown and filter, but they are not activity: they never count as visitors,
 * visits or events (a renewal months later is not a visit).
 */
export const NOT_PAYMENT = "e.origin != 'payment'";
/** Revenue that is a new purchase (not a renewal, not a refund). */
const NEW_PURCHASE = "e.revenue > 0 AND e.revenue_type IS NOT 'renewal' AND e.revenue_type IS NOT 'refund'";

/**
 * Count columns for a group of events `e`. `pv` says which rows are "this group's pageviews"
 * (for session-scoped page rows: pageviews of that page only, not of the whole session).
 */
function countCols(ctx: QueryCtx, pv: Frag = raw("e.name = 'pageview'"), pageScoped = false): Frag {
  const conv = ctx.hasGoals ? conversionCond(ctx) : null;
  const revenue = ctx.hasGoalValues ? sql`COALESCE(e.revenue, ${goalValue})` : raw("e.revenue");
  const pvCount = sql`COALESCE(SUM(CASE WHEN ${pv} THEN 1 ELSE 0 END), 0)`;
  return sql`COUNT(DISTINCT CASE WHEN ${raw(NOT_PAYMENT)} THEN e.visitor_id END) AS visitors,
    COUNT(DISTINCT CASE WHEN ${raw(NOT_PAYMENT)} THEN e.session_id END) AS visits,
    ${pvCount} AS pageviews,
    ${pageScoped ? pvCount : raw(`COALESCE(SUM(${NOT_PAYMENT}), 0)`)} AS events,
    ${conv ? sql`COALESCE(SUM(CASE WHEN ${conv} THEN 1 ELSE 0 END), 0)` : raw("0")} AS conversions,
    ${conv ? sql`COUNT(DISTINCT CASE WHEN ${conv} THEN e.visitor_id END)` : raw("0")} AS converted_visitors,
    COALESCE(SUM(${revenue}), 0) AS revenue,
    COALESCE(SUM(CASE WHEN e.revenue_type = 'renewal' THEN e.revenue END), 0) AS renewal_revenue,
    COALESCE(SUM(CASE WHEN e.revenue_type = 'refund' THEN e.revenue END), 0) AS refund_revenue,
    COALESCE(SUM(CASE WHEN ${raw(NEW_PURCHASE)} THEN 1 ELSE 0 END), 0) AS purchases,
    COUNT(DISTINCT CASE WHEN ${raw(NEW_PURCHASE)} THEN e.visitor_id END) AS customers,
    AVG(CASE WHEN ${pv} AND e.engagement_ms > 0 THEN e.engagement_ms END) / 1000.0 AS time_on_page,
    AVG(CASE WHEN ${pv} THEN e.scroll_depth END) AS scroll_depth`;
}

const BOUNCE = "CASE WHEN s.pageviews <= 1 AND s.custom_events = 0 THEN 100.0 ELSE 0.0 END";
/** seconds: first to last activity, or total visible (engaged) time when that is longer */
const DURATION = "MAX(s.last_seen_at - s.started_at, s.engagement_ms) / 1000.0";

export interface GroupOpts {
  /** bounce_rate + visit_duration (sessions table) */
  sessions?: boolean;
  /** returning_visitors (and so new_visitors): a visitor with an earlier session */
  visitorTypes?: boolean;
  /** lcp_p75, inp_p75, cls_p75 over the group's pageviews */
  vitals?: boolean;
}

/** One row of totals for the range + filters. */
export function aggregateQuery(ctx: QueryCtx, withSessions: boolean, opts: GroupOpts = {}): Frag {
  if (opts.visitorTypes || opts.vitals) return groupedQuery(ctx, { key: raw("'all'") }, { ...opts, sessions: withSessions });
  const sessionCols = withSessions
    ? raw(`,
    (SELECT AVG(${BOUNCE}) FROM sessions s WHERE s.id IN (SELECT session_id FROM ev WHERE origin != 'payment')) AS bounce_rate,
    (SELECT AVG(${DURATION}) FROM sessions s WHERE s.id IN (SELECT session_id FROM ev WHERE origin != 'payment')) AS visit_duration`)
    : EMPTY;
  return sql`WITH ${evCte(ctx)}
  SELECT ${countCols(ctx)}${sessionCols}
  FROM ev e`;
}

/** ORDER BY expressions for the metrics a breakdown can be sorted by (over `top`'s columns). */
const SORT_SQL: Record<string, string> = {
  visitors: "{p}visitors",
  visits: "{p}visits",
  pageviews: "{p}pageviews",
  events: "{p}events",
  conversions: "{p}conversions",
  conversion_rate: "{p}converted_visitors * 1.0 / MAX({p}visitors, 1)",
  revenue: "{p}revenue",
  revenue_per_visitor: "{p}revenue * 1.0 / MAX({p}visitors, 1)",
  new_revenue: "({p}revenue - {p}renewal_revenue - {p}refund_revenue)",
  renewal_revenue: "{p}renewal_revenue",
  refunds: "(-{p}refund_revenue)",
  purchases: "{p}purchases",
  customers: "{p}customers",
  purchase_rate: "{p}customers * 1.0 / MAX({p}visitors, 1)",
};

export interface GroupSpec {
  /** SQL for the group key (already COALESCEd) */
  key: Frag;
  /** extra grouped columns, e.g. country for region/city */
  extra?: { name: string; expr: Frag }[];
  joinSessions?: boolean;
  /**
   * page rows: a row is every event of the sessions that viewed the page, so revenue and
   * conversions are those of sessions that saw it; pageviews, events, time on page, scroll depth
   * and vitals still count that page's own pageviews.
   */
  sessionScoped?: boolean;
  limit?: number;
  /** order rows by key ascending (timeseries) instead of by visitors */
  orderByKey?: boolean;
  /** order by this metric (desc) instead of visitors; one of SORT_SQL's keys */
  sortBy?: string;
  /**
   * Only these groups (composite keys: value, or value + "\u001f" + extra columns): looks up the
   * comparison period's numbers for exactly the rows already shown. One bound JSON parameter.
   */
  only?: string[];
}

export const KEY_SEP = "\u001f";

export function groupSpecFor(dim: Breakdown): GroupSpec {
  if (dim === "goal") throw new Error("use goalBreakdownQuery");
  const col = columnFor(dim);
  const spec: GroupSpec = { key: sql`COALESCE(${col}, ${NONE})` };
  if (dim === "entry_page" || dim === "exit_page") spec.joinSessions = true;
  if (dim === "page") spec.sessionScoped = true;
  if (dim === "region" || dim === "city") spec.extra = [{ name: "country", expr: sql`COALESCE(e.country, ${NONE})` }];
  return spec;
}

/** Rows grouped by a key, with session metrics, visitor types and vitals per group when asked. */
export function groupedQuery(ctx: QueryCtx, g: GroupSpec, optsIn: GroupOpts | boolean = {}): Frag {
  const opts: GroupOpts = typeof optsIn === "boolean" ? { sessions: optsIn } : optsIn;
  const extras = g.extra ?? [];
  const ctes: Frag[] = [evCte(ctx)];
  let from: Frag;
  let key: Frag;
  let pv: Frag;
  if (g.sessionScoped) {
    ctes.push(
      sql`src AS (SELECT p.gk, x.* FROM (SELECT DISTINCT ${g.key} AS gk, e.session_id AS sid FROM ev e WHERE e.name = 'pageview') p JOIN ev x ON x.session_id = p.sid)`,
    );
    from = raw("FROM src e");
    key = raw("e.gk");
    pv = sql`(e.name = 'pageview' AND ${g.key} = e.gk)`;
  } else {
    from = raw(`FROM ev e${g.joinSessions ? " JOIN sessions s ON s.id = e.session_id" : ""}`);
    key = g.key;
    pv = raw("e.name = 'pageview'");
  }
  const composite = extras.length ? join([key, ...extras.map((x) => x.expr)], " || char(31) || ") : key;
  const base: Frag[] = g.only ? [sql`${composite} IN (SELECT value FROM json_each(${JSON.stringify(g.only)}))`] : [];
  const where = (more: Frag[] = []) => {
    const parts = [...base, ...more];
    return parts.length ? sql` WHERE ${join(parts, " AND ")}` : EMPTY;
  };
  const extraSel = join(
    extras.map((x) => sql`, ${x.expr} AS ${raw(x.name)}`),
    "",
  );
  const extraNames = extras.map((x) => `, ${x.name}`).join("");
  const groupBy = raw(`value${extraNames}`);
  const order = (p: string) => {
    if (g.orderByKey) return raw(`${p}value`);
    const tie = `${p}visitors DESC, ${p}events DESC, ${p}value${extras.map((x) => `, ${p}${x.name}`).join("")}`;
    const by = g.sortBy && g.sortBy !== "visitors" ? SORT_SQL[g.sortBy] : null;
    return raw(by ? `${by.replaceAll("{p}", p)} DESC, ${tie}` : tie);
  };
  const limit = g.limit != null ? sql` LIMIT ${g.limit}` : EMPTY;
  ctes.push(sql`top AS (
    SELECT ${key} AS value${extraSel}, ${countCols(ctx, pv, !!g.sessionScoped)}
    ${from}${where()}
    GROUP BY ${groupBy}
    ORDER BY ${order("")}${limit})`);
  if (!opts.sessions && !opts.visitorTypes && !opts.vitals) {
    return sql`WITH ${join(ctes, ",\n")}
    SELECT * FROM top ORDER BY ${order("")}`;
  }
  /** `a` matches the top row with the same key (and extra columns). */
  const matchTop = (a: string, t = "top") =>
    raw([`${t}.value = ${a}.value`, ...extras.map((x) => `${t}.${x.name} = ${a}.${x.name}`)].join(" AND "));
  const inTop = sql`EXISTS (SELECT 1 FROM top WHERE ${join(
    [sql`top.value = ${key}`, ...extras.map((x) => sql`top.${raw(x.name)} = ${x.expr}`)],
    " AND ",
  )})`;
  const aExtra = (a: string) => raw(extras.map((x) => `, ${a}.${x.name}`).join(""));
  const cols: string[] = ["top.*"];
  const joins: Frag[] = [];
  if (opts.sessions) {
    ctes.push(sql`grp AS (
    SELECT DISTINCT ${key} AS value${extraSel}, e.session_id AS sid
    ${from}${where([raw(NOT_PAYMENT), inTop])})`);
    ctes.push(sql`sm AS (
    SELECT g.value${aExtra("g")}, AVG(${raw(BOUNCE)}) AS bounce_rate, AVG(${raw(DURATION)}) AS visit_duration
    FROM grp g JOIN sessions s ON s.id = g.sid
    GROUP BY g.value${aExtra("g")})`);
    cols.push("sm.bounce_rate", "sm.visit_duration");
    joins.push(sql` LEFT JOIN sm ON ${matchTop("sm")}`);
  }
  if (opts.visitorTypes) {
    // Returning = the visitor (or their user_id) has a session that ended before their first
    // event in this group. Cookieless ids rotate daily, so for anonymous visitors that is same-day only.
    ctes.push(sql`vtg AS (
    SELECT ${key} AS value${extraSel}, e.visitor_id AS vid, MIN(e.ts) AS t, MAX(e.user_id) AS uid
    ${from}${where([raw(NOT_PAYMENT), inTop])}
    GROUP BY ${groupBy}, e.visitor_id)`);
    ctes.push(sql`vt AS (
    SELECT g.value${aExtra("g")},
      SUM(CASE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.visitor_id = g.vid AND s.last_seen_at < g.t)
        OR (g.uid IS NOT NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = g.uid AND s.last_seen_at < g.t))
        THEN 1 ELSE 0 END) AS returning_visitors
    FROM vtg g GROUP BY g.value${aExtra("g")})`);
    cols.push("COALESCE(vt.returning_visitors, 0) AS returning_visitors");
    joins.push(sql` LEFT JOIN vt ON ${matchTop("vt")}`);
  }
  if (opts.vitals) {
    ctes.push(sql`vs AS (
    SELECT ${key} AS value${extraSel}, e.lcp, e.inp, e.cls
    ${from}${where([pv, raw("(e.lcp IS NOT NULL OR e.inp IS NOT NULL OR e.cls IS NOT NULL)"), inTop])})`);
    for (const m of ["lcp", "inp", "cls"]) {
      ctes.push(
        raw(`v_${m} AS (SELECT value${extraNames}, ${m} AS m, ROW_NUMBER() OVER (PARTITION BY value${extraNames} ORDER BY ${m}) AS rn,
      COUNT(*) OVER (PARTITION BY value${extraNames}) AS n FROM vs WHERE ${m} IS NOT NULL)`),
      );
    }
    // p75 by nearest rank: the ceil(0.75 n)-th value = row (3n + 3) / 4 in integer division.
    const p75 = (m: string) => `(SELECT v.m FROM v_${m} v WHERE ${matchTop("v", "t").sql} AND v.rn = (3 * v.n + 3) / 4) AS ${m}_p75`;
    ctes.push(raw(`vit AS (SELECT t.value${extraNames.replaceAll(", ", ", t.")}, ${p75("lcp")}, ${p75("inp")}, ${p75("cls")} FROM top t)`));
    cols.push("vit.lcp_p75", "vit.inp_p75", "vit.cls_p75");
    joins.push(sql` LEFT JOIN vit ON ${matchTop("vit")}`);
  }
  return sql`WITH ${join(ctes, ",\n")}
  SELECT ${raw(cols.join(", "))}
  FROM top${join(joins, "")}
  ORDER BY ${order("top.")}`;
}

/** Per-goal conversions (every goal, including ones with zero conversions). */
export function goalBreakdownQuery(ctx: QueryCtx, limit: number): Frag {
  const names = goalFilterNames(ctx.filters);
  return sql`WITH ${evCte(ctx)}
  SELECT g.name AS value, g.type AS goal_type, g.match AS goal_match,
    COUNT(DISTINCT e.visitor_id) AS visitors,
    COUNT(e.id) AS conversions,
    COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN COALESCE(e.revenue, g.value) END), 0) AS revenue,
    (SELECT COUNT(DISTINCT visitor_id) FROM ev WHERE origin != 'payment') AS total_visitors
  FROM goals g LEFT JOIN ev e ON ${raw(GOAL_MATCH)}
  ${names ? sql`WHERE g.name IN (${list(names)})` : EMPTY}
  GROUP BY g.name
  ORDER BY visitors DESC, conversions DESC, g.name
  LIMIT ${limit}`;
}

// ---------------------------------------------------------------- timeseries

export interface OffsetSegment {
  /** segment applies from this instant (ms) */
  from: number;
  /** local - UTC, ms */
  offset: number;
}

/** Local wall-clock ms for e.ts, as SQL, given the timezone's offset segments over the range. */
export function localTsExpr(segments: OffsetSegment[]): Frag {
  if (!segments.length) return raw("e.ts");
  if (segments.length === 1) return sql`(e.ts + ${int(segments[0]!.offset)})`;
  const whens = segments.slice(1).map((s, i) => sql`WHEN e.ts < ${int(s.from)} THEN ${int(segments[i]!.offset)}`);
  return sql`(e.ts + CASE ${join(whens, " ")} ELSE ${int(segments[segments.length - 1]!.offset)} END)`;
}

export function bucketKey(interval: "hour" | "day" | "week" | "month", segments: OffsetSegment[]): Frag {
  const secs = sql`${localTsExpr(segments)} / 1000`;
  switch (interval) {
    case "hour":
      return sql`strftime('%Y-%m-%d %H:00', ${secs}, 'unixepoch')`;
    case "day":
      return sql`strftime('%Y-%m-%d', ${secs}, 'unixepoch')`;
    case "week":
      return sql`date(${secs}, 'unixepoch', '-6 days', 'weekday 1')`;
    case "month":
      return sql`strftime('%Y-%m', ${secs}, 'unixepoch')`;
  }
}

// ---------------------------------------------------------------- funnel

export type FunnelStep = { type: "page"; pattern: string } | { type: "event"; name: string } | { type: "goal"; name: string };

export class FunnelError extends Error {}

/** "/pricing, event:signup, goal:Purchase, page:/thanks*" (or an array of those) -> steps */
export function parseFunnelSteps(input: string | string[]): FunnelStep[] {
  const parts = (Array.isArray(input) ? input : input.split(",")).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) throw new FunnelError("A funnel needs at least 2 steps.");
  if (parts.length > 8) throw new FunnelError("A funnel can have at most 8 steps.");
  return parts.map((p) => {
    if (p.startsWith("/")) return { type: "page", pattern: p };
    const m = /^(page|event|goal):(.+)$/s.exec(p);
    if (!m) throw new FunnelError(`Bad funnel step "${p}". Use /path (with * wildcards), page:/path, event:<name> or goal:<goal name>.`);
    const v = m[2]!.trim();
    if (m[1] === "page") return { type: "page", pattern: v.startsWith("/") ? v : `/${v}` };
    return { type: m[1] as "event" | "goal", name: v };
  });
}

function stepCond(step: FunnelStep): Frag {
  switch (step.type) {
    case "page":
      return sql`(e.name = 'pageview' AND e.pathname GLOB ${toGlob(step.pattern)})`;
    case "event":
      return sql`e.name = ${step.name}`;
    case "goal":
      return sql`EXISTS (SELECT 1 FROM goals g WHERE g.name = ${step.name} AND ${raw(GOAL_MATCH)})`;
  }
}

/** Ordered steps within one session; each step must happen after the previous one. */
export function funnelQuery(ctx: QueryCtx, steps: FunnelStep[]): Frag {
  const ctes: Frag[] = [evCte(ctx)];
  steps.forEach((step, i) => {
    if (i === 0) {
      ctes.push(
        sql`s1 AS (SELECT e.session_id AS sid, e.visitor_id AS vid, MIN(e.ts) AS t, e.id AS eid FROM ev e WHERE ${stepCond(step)} GROUP BY e.session_id)`,
      );
    } else {
      ctes.push(
        sql`${raw(`s${i + 1}`)} AS (SELECT p.sid, p.vid, MIN(e.ts) AS t, e.id AS eid FROM ${raw(`s${i}`)} p JOIN ev e ON e.session_id = p.sid AND (e.ts > p.t OR (e.ts = p.t AND e.id > p.eid)) WHERE ${stepCond(step)} GROUP BY p.sid)`,
      );
    }
  });
  const selects = steps.map((_, i) => raw(`SELECT ${i + 1} AS step, COUNT(*) AS sessions, COUNT(DISTINCT vid) AS visitors FROM s${i + 1}`));
  return sql`WITH ${join(ctes, ",\n")}
  ${join(selects, " UNION ALL ")}`;
}
