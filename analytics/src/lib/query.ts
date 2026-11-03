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

const GOAL_MATCH = "((g.type = 'event' AND e.name = g.match) OR (g.type = 'pageview' AND e.name = 'pageview' AND e.pathname GLOB g.glob))";
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

function conversionCond(ctx: QueryCtx): Frag {
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

const evCte = (ctx: QueryCtx) => sql`ev AS (SELECT e.* FROM events e WHERE ${whereFrag(ctx)})`;

// ---------------------------------------------------------------- metrics

function countCols(ctx: QueryCtx): Frag {
  const conv = ctx.hasGoals ? conversionCond(ctx) : null;
  const revenue = ctx.hasGoalValues ? sql`COALESCE(e.revenue, ${goalValue})` : raw("e.revenue");
  return sql`COUNT(DISTINCT e.visitor_id) AS visitors,
    COUNT(DISTINCT e.session_id) AS visits,
    COALESCE(SUM(e.name = 'pageview'), 0) AS pageviews,
    COUNT(*) AS events,
    ${conv ? sql`COALESCE(SUM(CASE WHEN ${conv} THEN 1 ELSE 0 END), 0)` : raw("0")} AS conversions,
    ${conv ? sql`COUNT(DISTINCT CASE WHEN ${conv} THEN e.visitor_id END)` : raw("0")} AS converted_visitors,
    COALESCE(SUM(${revenue}), 0) AS revenue`;
}

const BOUNCE = "CASE WHEN s.pageviews <= 1 AND s.custom_events = 0 THEN 100.0 ELSE 0.0 END";
/** seconds: first to last activity, or total visible (engaged) time when that is longer */
const DURATION = "MAX(s.last_seen_at - s.started_at, s.engagement_ms) / 1000.0";

/** One row of totals for the range + filters. */
export function aggregateQuery(ctx: QueryCtx, withSessions: boolean): Frag {
  const sessionCols = withSessions
    ? raw(`,
    (SELECT AVG(${BOUNCE}) FROM sessions s WHERE s.id IN (SELECT session_id FROM ev)) AS bounce_rate,
    (SELECT AVG(${DURATION}) FROM sessions s WHERE s.id IN (SELECT session_id FROM ev)) AS visit_duration`)
    : EMPTY;
  return sql`WITH ${evCte(ctx)}
  SELECT ${countCols(ctx)}${sessionCols}
  FROM ev e`;
}

export interface GroupSpec {
  /** SQL for the group key (already COALESCEd) */
  key: Frag;
  /** extra grouped columns, e.g. country for region/city */
  extra?: { name: string; expr: Frag }[];
  joinSessions?: boolean;
  pageviewsOnly?: boolean;
  limit?: number;
  /** order rows by key ascending (timeseries) instead of by visitors */
  orderByKey?: boolean;
}

export function groupSpecFor(dim: Breakdown): GroupSpec {
  if (dim === "goal") throw new Error("use goalBreakdownQuery");
  const col = columnFor(dim);
  const spec: GroupSpec = { key: sql`COALESCE(${col}, ${NONE})` };
  if (dim === "entry_page" || dim === "exit_page") spec.joinSessions = true;
  if (dim === "page") spec.pageviewsOnly = true;
  if (dim === "region" || dim === "city") spec.extra = [{ name: "country", expr: sql`COALESCE(e.country, ${NONE})` }];
  return spec;
}

/** Rows grouped by a key, with session metrics (bounce, duration) per group when asked. */
export function groupedQuery(ctx: QueryCtx, g: GroupSpec, withSessions: boolean): Frag {
  const extras = g.extra ?? [];
  const extraSel = join(
    extras.map((x) => sql`, ${x.expr} AS ${raw(x.name)}`),
    "",
  );
  const groupBy = raw(["value", ...extras.map((x) => x.name)].join(", "));
  const from = sql`FROM ev e${g.joinSessions ? raw(" JOIN sessions s ON s.id = e.session_id") : EMPTY}${g.pageviewsOnly ? raw(" WHERE e.name = 'pageview'") : EMPTY}`;
  const extraOrder = extras.map((x) => `, ${x.name}`).join("");
  const order = g.orderByKey ? raw("value") : raw(`visitors DESC, events DESC, value${extraOrder}`);
  const limit = g.limit != null ? sql` LIMIT ${g.limit}` : EMPTY;
  const top = sql`top AS (
    SELECT ${g.key} AS value${extraSel}, ${countCols(ctx)}
    ${from}
    GROUP BY ${groupBy}
    ORDER BY ${order}${limit})`;
  if (!withSessions) {
    return sql`WITH ${evCte(ctx)}, ${top}
    SELECT * FROM top ORDER BY ${order}`;
  }
  const match = raw(["top.value = g.value", ...extras.map((x) => `top.${x.name} = g.${x.name}`)].join(" AND "));
  const smMatch = raw(["sm.value = top.value", ...extras.map((x) => `sm.${x.name} = top.${x.name}`)].join(" AND "));
  const gExtra = raw(extras.map((x) => `, g.${x.name}`).join(""));
  return sql`WITH ${evCte(ctx)}, ${top},
  grp AS (
    SELECT DISTINCT ${g.key} AS value${extraSel}, e.session_id AS sid
    ${from}),
  sm AS (
    SELECT g.value${gExtra}, AVG(${raw(BOUNCE)}) AS bounce_rate, AVG(${raw(DURATION)}) AS visit_duration
    FROM grp g JOIN sessions s ON s.id = g.sid
    WHERE EXISTS (SELECT 1 FROM top WHERE ${match})
    GROUP BY ${raw(["g.value", ...extras.map((x) => `g.${x.name}`)].join(", "))})
  SELECT top.*, sm.bounce_rate, sm.visit_duration
  FROM top LEFT JOIN sm ON ${smMatch}
  ORDER BY ${g.orderByKey ? raw("top.value") : raw(`top.visitors DESC, top.events DESC, top.value${extras.map((x) => `, top.${x.name}`).join("")}`)}`;
}

/** Per-goal conversions (every goal, including ones with zero conversions). */
export function goalBreakdownQuery(ctx: QueryCtx, limit: number): Frag {
  const names = goalFilterNames(ctx.filters);
  return sql`WITH ${evCte(ctx)}
  SELECT g.name AS value, g.type AS goal_type, g.match AS goal_match,
    COUNT(DISTINCT e.visitor_id) AS visitors,
    COUNT(e.id) AS conversions,
    COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN COALESCE(e.revenue, g.value) END), 0) AS revenue,
    (SELECT COUNT(DISTINCT visitor_id) FROM ev) AS total_visitors
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
