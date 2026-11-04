import type { ChannelGroup } from "./types";
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

import {
  CUSTOM_METRIC_RE,
  DIMENSION_SQL,
  type Breakdown,
  type Filter,
  type FilterExpr,
  type FilterOp,
  NONE,
  PROP_KEY_RE,
  customAlias,
  isLeaf,
} from "./filters";

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

/**
 * A goal matches an event `a`: by name, by page path, or by page path once scrolled past its
 * threshold; and when the goal has props, every one of them equals the event's prop (keys are
 * validated [A-Za-z0-9_.-], values compared as the strings props are stored as).
 */
export const goalMatch = (a: string) =>
  `(((g.type = 'event' AND ${a}.name = g.match) OR (g.type = 'pageview' AND ${a}.name = 'pageview' AND ${a}.pathname GLOB g.glob) OR (g.type = 'scroll' AND ${a}.name = 'pageview' AND ${a}.pathname GLOB g.glob AND ${a}.scroll_depth >= g.threshold))` +
  ` AND (g.props IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(g.props) gp WHERE json_extract(${a}.props, '$."' || gp.key || '"') IS NOT gp.value)))`;
export const GOAL_MATCH = goalMatch("e");

/**
 * Goals counted once per visit: an event counts only if no earlier event of its session matched
 * the same goal (events_session index; only added when the site has such goals).
 */
const ONCE_FIRST = `(g.counting IS NOT 'once_per_visit' OR NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.session_id = e.session_id AND (e2.ts < e.ts OR (e2.ts = e.ts AND e2.id < e.id)) AND ${goalMatch("e2")}))`;

const goalValueFrag = (ctx: QueryCtx) =>
  raw(
    `(SELECT g.value FROM goals g WHERE ${GOAL_MATCH} AND g.value IS NOT NULL${ctx.hasOnceGoals ? ` AND ${ONCE_FIRST}` : ""} ORDER BY g.created_at LIMIT 1)`,
  );

/** Events marked debug (afsa('debug'), debug: true on server events): left out unless asked for. */
export type DebugMode = "exclude" | "include" | "only";

export interface QueryCtx {
  start: number;
  end: number;
  filters: Filter[];
  /** debug events: exclude (default), include, or only them (the debug view) */
  debug?: DebugMode;
  /** a nested and / or / not group (filters_json, a segment's groups), ANDed with `filters` */
  where?: FilterExpr | null;
  /** the site's content groups, for the content_group dimension */
  contentGroups?: { name: string; match: string }[];
  /** the site's custom channel groups, for the channel_group dimension */
  channelGroups?: ChannelGroup[];
  /** site has at least one goal / at least one goal with a value (lets us skip subqueries) */
  hasGoals: boolean;
  hasGoalValues: boolean;
  /** some goal counts once per visit (conversions then skip a session's repeat matches) */
  hasOnceGoals?: boolean;
  /** numeric custom metrics to aggregate (sum|avg|min|max:prop:<key>) */
  customMetrics?: string[];
}

/** Goal names named by `goal==...` filters: conversions then count only those goals. */
export function goalFilterNames(filters: Filter[]): string[] | null {
  const f = filters.filter((x) => x.key === "goal" && x.op === "==");
  if (!f.length) return null;
  return f.flatMap((x) => x.values);
}

export function conversionCond(ctx: QueryCtx): Frag {
  const names = goalFilterNames(ctx.filters);
  return sql`EXISTS (SELECT 1 FROM goals g WHERE ${raw(GOAL_MATCH)}${names ? sql` AND ${valueCond(raw("g.name"), "==", names)}` : EMPTY}${
    ctx.hasOnceGoals ? raw(` AND ${ONCE_FIRST}`) : EMPTY
  })`;
}

// ---------------------------------------------------------------- filters

/**
 * content_group: the site's content_groups (path patterns, first match wins) as a CASE over the
 * page path, every pattern and name a bound parameter. Evaluated at query time, so a new group
 * applies to stored data too.
 */
function contentGroupFrag(ctx: Pick<QueryCtx, "contentGroups"> | undefined): Frag {
  const groups = ctx?.contentGroups ?? [];
  if (!groups.length) return raw("NULL");
  return sql`(CASE ${join(
    groups.map((g) => sql`WHEN e.pathname GLOB ${toGlob(g.match)} THEN ${g.name}`),
    " ",
  )} END)`;
}

/**
 * channel_group: the site's channel_groups as a CASE (first match wins; within a rule every
 * condition given must match one of its patterns, case-insensitive GLOB), else the built-in channel.
 */
function channelGroupFrag(ctx: Pick<QueryCtx, "channelGroups"> | undefined): Frag {
  const groups = ctx?.channelGroups ?? [];
  if (!groups.length) return raw("e.channel");
  const COL = { source: "e.source", medium: "e.utm_medium", campaign: "e.utm_campaign", channel: "e.channel" } as const;
  const rules = groups
    .map((g) => {
      const conds = (Object.keys(COL) as (keyof typeof COL)[])
        .filter((k) => g[k]?.length)
        .map(
          (k) =>
            sql`(${join(
              g[k]!.map((p) => sql`lower(${raw(COL[k])}) GLOB ${wildcardGlob(p.toLowerCase())}`),
              " OR ",
            )})`,
        );
      return conds.length ? sql`WHEN ${join(conds, " AND ")} THEN ${g.name}` : null;
    })
    .filter((x): x is Frag => !!x);
  return rules.length ? sql`(CASE ${join(rules, " ")} ELSE e.channel END)` : raw("e.channel");
}

export function columnFor(key: string, ctx?: Pick<QueryCtx, "contentGroups" | "channelGroups">): Frag {
  if (key === "content_group") return contentGroupFrag(ctx);
  if (key === "channel_group") return channelGroupFrag(ctx);
  if (key.startsWith("prop:")) {
    const k = key.slice(5);
    if (!PROP_KEY_RE.test(k)) throw new Error("bad prop key");
    return sql`json_extract(e.props, ${`$."${k}"`})`;
  }
  if (key.startsWith("user:")) {
    // A user property: the identified user's last value (events of anonymous visitors have none).
    const k = key.slice(5);
    if (!PROP_KEY_RE.test(k)) throw new Error("bad user property key");
    return sql`(SELECT up.value FROM user_props up WHERE up.user_id = e.user_id AND up.key = ${k})`;
  }
  const col = DIMENSION_SQL[key as keyof typeof DIMENSION_SQL];
  if (!col) throw new Error(`unknown dimension ${key}`);
  return raw(col);
}

/** Has an unescaped `*` (a wildcard); `\*` is a literal star. */
export const isWildcard = (v: string) => /(^|[^\\])\*/.test(v);

/**
 * A filter value as SQL: an unescaped `*` is a wildcard (SQLite GLOB, so case-sensitive like ==);
 * every other GLOB metacharacter ([, ?) and an escaped \* match themselves. No regex: SQLite in a
 * Durable Object has no REGEXP, and GLOB can't backtrack badly. Values are always bound parameters.
 */
export function wildcardGlob(v: string): string {
  let g = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (ch === "\\" && v[i + 1] === "*") {
      g += "[*]";
      i++;
    } else if (ch === "*") g += "*";
    else if (ch === "[") g += "[[]";
    else if (ch === "?") g += "[?]";
    else g += ch;
  }
  return g;
}

const literal = (v: string) => v.replace(/\\\*/g, "*");

export function valueCond(col: Frag, op: FilterOp, values: string[]): Frag {
  const hasNone = values.includes(NONE);
  const vals = values.filter((v) => v !== NONE);
  const contains = () =>
    join(
      vals.map((v) => sql`instr(lower(${col}), lower(${literal(v)})) > 0`),
      " OR ",
    );
  const lits = vals.filter((v) => !isWildcard(v)).map(literal);
  const globs = vals.filter(isWildcard).map(wildcardGlob);
  /** col equals one of the values (or matches one of the patterns) */
  const anyOf = (): Frag => {
    const parts: Frag[] = [];
    if (lits.length) parts.push(sql`${col} IN (${list(lits)})`);
    for (const g of globs) parts.push(sql`${col} GLOB ${g}`);
    return parts.length === 1 ? parts[0]! : sql`(${join(parts, " OR ")})`;
  };
  switch (op) {
    case "==": {
      const parts: Frag[] = [];
      if (vals.length) parts.push(anyOf());
      if (hasNone) parts.push(sql`${col} IS NULL`);
      return sql`(${join(parts, " OR ")})`;
    }
    case "!=": {
      if (!vals.length) return sql`${col} IS NOT NULL`;
      const none = globs.length ? sql`NOT ${anyOf()}` : sql`${col} NOT IN (${list(lits)})`;
      if (hasNone) return sql`(${col} IS NOT NULL AND ${none})`;
      return sql`(${col} IS NULL OR ${none})`;
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
  if (f.key === "did") {
    // Behaviour: visitors (and identified users) who did / didn't do an event within the range.
    const negate = f.op === "!=" || f.op === "!~";
    const cond = valueCond(raw("x.name"), f.op === "!=" ? "==" : f.op === "!~" ? "~" : f.op, f.values);
    const who = (col: string) =>
      sql`SELECT x.${raw(col)} FROM events x WHERE x.ts >= ${ctx.start} AND x.ts < ${ctx.end} AND x.origin != 'payment' AND x.${raw(col)} IS NOT NULL AND ${cond}`;
    const did = sql`(e.visitor_id IN (${who("visitor_id")}) OR (e.user_id IS NOT NULL AND e.user_id IN (${who("user_id")})))`;
    return negate ? sql`NOT ${did}` : did;
  }
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
  return valueCond(columnFor(f.key, ctx), f.op, f.values);
}

export function debugFrag(mode: DebugMode | undefined, alias = "e"): Frag | null {
  if (mode === "include") return null;
  return raw(`${alias}.debug = ${mode === "only" ? 1 : 0}`);
}

/** A nested and / or / not group (filters_json, segments) as SQL over events e. */
export function exprFrag(e: FilterExpr, ctx: QueryCtx): Frag {
  if (isLeaf(e)) return filterFrag(e, ctx);
  if ("not" in e) return sql`NOT (${exprFrag(e.not, ctx)})`;
  const items = "and" in e ? e.and : e.or;
  return sql`(${join(
    items.map((x) => exprFrag(x, ctx)),
    "and" in e ? " AND " : " OR ",
  )})`;
}

export function whereFrag(ctx: QueryCtx): Frag {
  const dbg = debugFrag(ctx.debug);
  return join(
    [
      sql`e.ts >= ${ctx.start} AND e.ts < ${ctx.end}`,
      ...(dbg ? [dbg] : []),
      ...ctx.filters.map((f) => filterFrag(f, ctx)),
      ...(ctx.where ? [exprFrag(ctx.where, ctx)] : []),
    ],
    " AND ",
  );
}

export const evCte = (ctx: QueryCtx) => sql`ev AS (SELECT e.* FROM events e WHERE ${whereFrag(ctx)})`;

// ---------------------------------------------------------------- metrics

/**
 * Payments (Stripe, POST /payments) are stored as events with origin 'payment' so revenue flows
 * through every breakdown and filter, but they are not activity: they never count as visitors,
 * visits or events (a renewal months later is not a visit).
 */
export const NOT_PAYMENT = "e.origin != 'payment'";
/**
 * Server events sent with visit: false that joined no live session are stored with no visit
 * (no_visit = 1, a session id of their own with no sessions row): they count as events,
 * conversions and revenue, never as visitors or visits (nor converted visitors or sessions).
 */
export const IN_VISIT = "e.no_visit = 0";
/** Rows that count as a visitor's activity: not a payment, not a no-visit event. */
export const VISIT_ACTIVITY = `${NOT_PAYMENT} AND ${IN_VISIT}`;
/** Revenue that is a new purchase (not a renewal, not a refund). */
const NEW_PURCHASE = "e.revenue > 0 AND e.revenue_type IS NOT 'renewal' AND e.revenue_type IS NOT 'refund'";

/**
 * Count columns for a group of events `e`. `pv` says which rows are "this group's pageviews"
 * (for session-scoped page rows: pageviews of that page only, not of the whole session).
 */
function countCols(ctx: QueryCtx, pv: Frag = raw("e.name = 'pageview'"), pageScoped = false): Frag {
  const conv = ctx.hasGoals ? conversionCond(ctx) : null;
  const revenue = ctx.hasGoalValues ? sql`COALESCE(e.revenue, ${goalValueFrag(ctx)})` : raw("e.revenue");
  const pvCount = sql`COALESCE(SUM(CASE WHEN ${pv} THEN 1 ELSE 0 END), 0)`;
  return sql`COUNT(DISTINCT CASE WHEN ${raw(VISIT_ACTIVITY)} THEN e.visitor_id END) AS visitors,
    COUNT(DISTINCT CASE WHEN ${raw(VISIT_ACTIVITY)} THEN e.session_id END) AS visits,
    ${pvCount} AS pageviews,
    ${pageScoped ? pvCount : raw(`COALESCE(SUM(${NOT_PAYMENT}), 0)`)} AS events,
    ${conv ? sql`COALESCE(SUM(CASE WHEN ${conv} THEN 1 ELSE 0 END), 0)` : raw("0")} AS conversions,
    ${conv ? sql`COUNT(DISTINCT CASE WHEN ${conv} AND ${raw(IN_VISIT)} THEN e.visitor_id END)` : raw("0")} AS converted_visitors,
    COALESCE(SUM(${revenue}), 0) AS revenue,
    COALESCE(SUM(CASE WHEN e.revenue_type = 'renewal' THEN e.revenue END), 0) AS renewal_revenue,
    COALESCE(SUM(CASE WHEN e.revenue_type = 'refund' THEN e.revenue END), 0) AS refund_revenue,
    COALESCE(SUM(CASE WHEN ${raw(NEW_PURCHASE)} THEN 1 ELSE 0 END), 0) AS purchases,
    COUNT(DISTINCT CASE WHEN ${raw(NEW_PURCHASE)} THEN e.visitor_id END) AS customers,
    COALESCE(SUM(CASE WHEN ${raw(NEW_PURCHASE)} THEN e.revenue END), 0) AS purchase_revenue,
    ${conv ? sql`COUNT(DISTINCT CASE WHEN ${conv} AND ${raw(IN_VISIT)} THEN e.session_id END)` : raw("0")} AS converted_sessions,
    COALESCE(SUM(CASE WHEN ${pv} THEN e.engagement_ms END), 0) / 1000.0 AS engagement_time,
    AVG(CASE WHEN ${pv} AND e.engagement_ms > 0 THEN e.engagement_ms END) / 1000.0 AS time_on_page,
    AVG(CASE WHEN ${pv} THEN e.scroll_depth END) AS scroll_depth${customCols(ctx)}`;
}

/**
 * Custom metrics over a numeric prop. Props are stored as text: only values made of digits, signs,
 * a point and an exponent count (anything else is not a number and is skipped, not read as 0).
 */
function customCols(ctx: QueryCtx): Frag {
  const list = (ctx.customMetrics ?? []).map((m) => CUSTOM_METRIC_RE.exec(m)).filter((m): m is RegExpExecArray => !!m);
  if (!list.length) return EMPTY;
  return join(
    list.map((m) => {
      const v = sql`json_extract(e.props, ${`$."${m[2]}"`})`;
      const n = sql`CASE WHEN ${v} != '' AND ${v} NOT GLOB '*[^0-9.eE+-]*' THEN CAST(${v} AS REAL) END`;
      const fn = { sum: "SUM", avg: "AVG", min: "MIN", max: "MAX" }[m[1] as "sum"]!;
      return sql`, ${raw(fn)}(CASE WHEN ${raw(NOT_PAYMENT)} THEN ${n} END) AS ${raw(customAlias(m[0]))}`;
    }),
    "",
  );
}

/** Sessions that converted (any goal), for the engaged-session test. Only when the site has goals. */
const convertedCte = (ctx: QueryCtx): Frag | null =>
  ctx.hasGoals ? sql`cvs AS (SELECT DISTINCT e.session_id FROM ev e WHERE ${conversionCond(ctx)})` : null;

const BOUNCE = "CASE WHEN s.pageviews <= 1 AND s.custom_events = 0 THEN 100.0 ELSE 0.0 END";
/** GA4's engaged session: at least 10 s visible, 2+ pageviews, or a conversion (cvs). */
const engaged = (withConversions: boolean) =>
  `CASE WHEN s.engagement_ms >= 10000 OR s.pageviews >= 2${withConversions ? " OR s.id IN (SELECT session_id FROM cvs)" : ""} THEN 1 ELSE 0 END`;
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
  const cvs = withSessions ? convertedCte(ctx) : null;
  const inRange = "FROM sessions s WHERE s.id IN (SELECT session_id FROM ev WHERE origin != 'payment')";
  const sessionCols = withSessions
    ? raw(`,
    (SELECT AVG(${BOUNCE}) ${inRange}) AS bounce_rate,
    (SELECT AVG(${DURATION}) ${inRange}) AS visit_duration,
    (SELECT SUM(${engaged(!!cvs)}) ${inRange}) AS engaged_visits,
    (SELECT AVG(${engaged(!!cvs)}) * 100.0 ${inRange}) AS engagement_rate`)
    : EMPTY;
  return sql`WITH ${evCte(ctx)}${cvs ? sql`, ${cvs}` : EMPTY}
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
  engagement_time: "{p}engagement_time",
  visits_per_visitor: "{p}visits * 1.0 / MAX({p}visitors, 1)",
  events_per_visit: "{p}events * 1.0 / MAX({p}visits, 1)",
  visit_conversion_rate: "{p}converted_sessions * 1.0 / MAX({p}visits, 1)",
  average_order_value: "{p}purchase_revenue * 1.0 / MAX({p}purchases, 1)",
  revenue_per_customer: "{p}revenue * 1.0 / MAX({p}customers, 1)",
  percentage: "{p}visitors",
};

export interface GroupSpec {
  /** SQL for the group key (already COALESCEd) */
  key: Frag;
  /**
   * extra grouped columns, e.g. country for region/city, or the 2nd and 3rd dimension of a
   * multi-dimension breakdown. `name` is the SQL alias (a fixed identifier), `label` the key rows
   * carry it under (default: name).
   */
  extra?: { name: string; expr: Frag; label?: string }[];
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
  /** order by this metric instead of visitors; one of SORT_SQL's keys */
  sortBy?: string;
  /** direction of sortBy (default desc), or of the value when sortByValue */
  sortDir?: "asc" | "desc";
  /** order by the group key (alphabetical) */
  sortByValue?: boolean;
  /** rows to skip (pagination) */
  offset?: number;
  /** add total_rows (the number of groups before LIMIT) to every row */
  withTotal?: boolean;
  /**
   * Only these groups (composite keys: value, or value + "\u001f" + extra columns): looks up the
   * comparison period's numbers for exactly the rows already shown. One bound JSON parameter.
   */
  only?: string[];
}

export const KEY_SEP = "\u001f";

const dimExpr = (dim: Breakdown, ctx?: Pick<QueryCtx, "contentGroups" | "channelGroups">): Frag => {
  if (dim === "entry_page") return raw("s.entry_page");
  if (dim === "exit_page") return raw("s.exit_page");
  return columnFor(dim, ctx);
};

/**
 * The grouping for one dimension, or 2-3 (a multi-dimension breakdown: the first is the key, the
 * others extra columns; a page dimension goes first so it stays session-scoped). region and city
 * rows always carry country.
 */
export function groupSpecFor(dimIn: Breakdown | Breakdown[], ctx?: Pick<QueryCtx, "contentGroups">): GroupSpec {
  const dims = Array.isArray(dimIn) ? [...dimIn] : [dimIn];
  if (dims.includes("goal")) throw new Error("use goalBreakdownQuery");
  if (dims.length > 1 && dims.includes("page")) dims.splice(0, dims.length, "page", ...dims.filter((d) => d !== "page"));
  const [first, ...rest] = dims as [Breakdown, ...Breakdown[]];
  const spec: GroupSpec = { key: sql`COALESCE(${columnFor(first, ctx)}, ${NONE})` };
  if (dims.some((d) => d === "entry_page" || d === "exit_page")) spec.joinSessions = true;
  if (first === "page") spec.sessionScoped = true;
  const extra: NonNullable<GroupSpec["extra"]> = rest.map((d, i) => ({
    name: `d${i + 2}`,
    label: d,
    expr: sql`COALESCE(${dimExpr(d, ctx)}, ${NONE})`,
  }));
  if (dims.some((d) => d === "region" || d === "city") && !dims.includes("country"))
    extra.push({ name: "country", expr: sql`COALESCE(e.country, ${NONE})` });
  if (extra.length) spec.extra = extra;
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
  const dir = g.sortDir === "asc" ? "ASC" : "DESC";
  const order = (p: string) => {
    if (g.orderByKey) return raw(`${p}value`);
    const keys = `${p}value${extras.map((x) => `, ${p}${x.name}`).join("")}`;
    if (g.sortByValue) return raw(`${p}value ${g.sortDir === "desc" ? "DESC" : "ASC"}${extras.map((x) => `, ${p}${x.name}`).join("")}`);
    const tie = `${p}visitors DESC, ${p}events DESC, ${keys}`;
    const by = g.sortBy ? SORT_SQL[g.sortBy] : null;
    if (g.sortBy === "visitors" && dir === "ASC") return raw(`${p}visitors ASC, ${p}events DESC, ${keys}`);
    return raw(by && g.sortBy !== "visitors" ? `${by.replaceAll("{p}", p)} ${dir}, ${tie}` : tie);
  };
  const limit = g.limit != null ? sql` LIMIT ${g.limit}${g.offset ? sql` OFFSET ${g.offset}` : EMPTY}` : EMPTY;
  ctes.push(sql`top AS (
    SELECT ${key} AS value${extraSel}, ${countCols(ctx, pv, !!g.sessionScoped)}${g.withTotal ? raw(", COUNT(*) OVER () AS total_rows") : EMPTY}
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
    const cvs = convertedCte(ctx);
    if (cvs) ctes.push(cvs);
    ctes.push(sql`grp AS (
    SELECT DISTINCT ${key} AS value${extraSel}, e.session_id AS sid
    ${from}${where([raw(NOT_PAYMENT), inTop])})`);
    ctes.push(sql`sm AS (
    SELECT g.value${aExtra("g")}, AVG(${raw(BOUNCE)}) AS bounce_rate, AVG(${raw(DURATION)}) AS visit_duration,
      SUM(${raw(engaged(!!cvs))}) AS engaged_visits, AVG(${raw(engaged(!!cvs))}) * 100.0 AS engagement_rate
    FROM grp g JOIN sessions s ON s.id = g.sid
    GROUP BY g.value${aExtra("g")})`);
    cols.push("sm.bounce_rate", "sm.visit_duration", "sm.engaged_visits", "sm.engagement_rate");
    joins.push(sql` LEFT JOIN sm ON ${matchTop("sm")}`);
  }
  if (opts.visitorTypes) {
    // Returning = the visitor (or their user_id) has a session that ended before their first
    // event in this group. Cookieless ids rotate daily, so for anonymous visitors that is same-day only.
    ctes.push(sql`vtg AS (
    SELECT ${key} AS value${extraSel}, e.visitor_id AS vid, MIN(e.ts) AS t, MAX(e.user_id) AS uid
    ${from}${where([raw(VISIT_ACTIVITY), inTop])}
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

/**
 * Per-goal conversions (every goal, including ones with zero conversions). A goal counted once per
 * visit keeps only the first matching event of each session (its value counts once too).
 */
export function goalBreakdownQuery(ctx: QueryCtx, limit: number): Frag {
  const names = goalFilterNames(ctx.filters);
  return sql`WITH ${evCte(ctx)},
  gm AS (SELECT g.id AS gid, e.id AS eid, e.visitor_id, e.no_visit, COALESCE(e.revenue, g.value) AS rev,
           ${raw(ctx.hasOnceGoals ? "CASE WHEN g.counting = 'once_per_visit' THEN ROW_NUMBER() OVER (PARTITION BY g.id, e.session_id ORDER BY e.ts, e.id) ELSE 1 END" : "1")} AS rn
         FROM goals g JOIN ev e ON ${raw(GOAL_MATCH)})
  SELECT g.name AS value, g.type AS goal_type, g.match AS goal_match, g.counting AS goal_counting,
    COUNT(DISTINCT CASE WHEN m.no_visit = 0 THEN m.visitor_id END) AS visitors,
    COUNT(m.eid) AS conversions,
    COALESCE(SUM(m.rev), 0) AS revenue,
    (SELECT COUNT(DISTINCT visitor_id) FROM ev WHERE origin != 'payment' AND no_visit = 0) AS total_visitors
  FROM goals g LEFT JOIN gm m ON m.gid = g.id AND m.rn = 1
  ${names ? sql`WHERE ${valueCond(raw("g.name"), "==", names)}` : EMPTY}
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
/** `col` is a fixed column expression from this codebase (e.ts, s.started_at), never user input. */
export function localTsExpr(segments: OffsetSegment[], col = "e.ts"): Frag {
  if (!/^[a-z]\.[a-z_]+$/.test(col)) throw new Error("bad column");
  if (!segments.length) return raw(col);
  if (segments.length === 1) return sql`(${raw(col)} + ${int(segments[0]!.offset)})`;
  const whens = segments.slice(1).map((s, i) => sql`WHEN ${raw(col)} < ${int(s.from)} THEN ${int(segments[i]!.offset)}`);
  return sql`(${raw(col)} + CASE ${join(whens, " ")} ELSE ${int(segments[segments.length - 1]!.offset)} END)`;
}

export function bucketKey(interval: "hour" | "day" | "week" | "month", segments: OffsetSegment[], col = "e.ts"): Frag {
  const secs = sql`${localTsExpr(segments, col)} / 1000`;
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
  return parts.map(parseFunnelStep);
}

/** One step: "/pricing" or page:/x (pageview, * wildcard), event:<name>, goal:<goal name>. */
export function parseFunnelStep(raw: string): FunnelStep {
  const p = raw.trim();
  if (p.startsWith("/")) return { type: "page", pattern: p };
  const m = /^(page|event|goal):(.+)$/s.exec(p);
  if (!m) throw new FunnelError(`Bad funnel step "${p}". Use /path (with * wildcards), page:/path, event:<name> or goal:<goal name>.`);
  const v = m[2]!.trim();
  if (m[1] === "page") return { type: "page", pattern: v.startsWith("/") ? v : `/${v}` };
  return { type: m[1] as "event" | "goal", name: v };
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

export const FUNNEL_MODES = ["ordered", "any"] as const;
export type FunnelMode = (typeof FUNNEL_MODES)[number];
/** session: steps within one visit; a duration: steps by the same person within that time of step 1. */
export const FUNNEL_WINDOWS = ["session", "1h", "1d", "7d", "30d"] as const;
export type FunnelWindow = (typeof FUNNEL_WINDOWS)[number];
export const WINDOW_MS: Record<Exclude<FunnelWindow, "session">, number> = {
  "1h": 3_600_000,
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** The identity of an event across sessions: its user, an identified visitor's user, or the visitor id. */
const EVENT_PERSON = "COALESCE('user:' || e.user_id, (SELECT i.canonical FROM identities i WHERE i.ident = e.visitor_id), e.visitor_id)";

export interface FunnelOptions {
  mode?: FunnelMode;
  window?: FunnelWindow;
}

/**
 * Funnel steps per actor (a session, or a person when the window is a duration). Ordered: each
 * step after the previous one (and, with a duration, within it of step 1); any: every step done,
 * in any order, by the actor (in the session, or in the period). Per step: actors, visitors and
 * the revenue of those actors (their events and payments in the period or session).
 */
export function funnelQuery(ctx: QueryCtx, steps: FunnelStep[], o: FunnelOptions = {}): Frag {
  const bySession = !o.window || o.window === "session";
  const w = bySession ? null : WINDOW_MS[o.window as Exclude<FunnelWindow, "session">];
  // A no-visit event (visit: false, no live session) is in no session: it takes part only in person funnels.
  const ctes: Frag[] = [
    evCte(ctx),
    raw(`eva AS (SELECT e.*, ${bySession ? "e.session_id" : EVENT_PERSON} AS aid FROM ev e${bySession ? ` WHERE ${IN_VISIT}` : ""})`),
  ];
  if ((o.mode ?? "ordered") === "any") {
    steps.forEach((step, i) =>
      ctes.push(sql`${raw(`d${i + 1}`)} AS (SELECT DISTINCT e.aid, e.visitor_id AS vid FROM eva e WHERE ${stepCond(step)})`),
    );
    steps.forEach((_, i) =>
      ctes.push(
        raw(
          i === 0
            ? "s1 AS (SELECT aid, MIN(vid) AS vid FROM d1 GROUP BY aid)"
            : `s${i + 1} AS (SELECT aid, vid FROM s${i} WHERE aid IN (SELECT aid FROM d${i + 1}))`,
        ),
      ),
    );
  } else {
    steps.forEach((step, i) => {
      if (i === 0) {
        ctes.push(
          sql`s1 AS (SELECT e.aid, e.visitor_id AS vid, MIN(e.ts) AS t, e.id AS eid, MIN(e.ts) AS t0 FROM eva e WHERE ${stepCond(step)} GROUP BY e.aid)`,
        );
      } else {
        const within = w ? raw(` AND e.ts <= p.t0 + ${w}`) : EMPTY;
        ctes.push(
          sql`${raw(`s${i + 1}`)} AS (SELECT p.aid, p.vid, p.t0, MIN(e.ts) AS t, e.id AS eid FROM ${raw(`s${i}`)} p JOIN eva e ON e.aid = p.aid AND (e.ts > p.t OR (e.ts = p.t AND e.id > p.eid))${within} WHERE ${stepCond(step)} GROUP BY p.aid)`,
        );
      }
    });
  }
  ctes.push(raw("rev AS (SELECT aid, SUM(revenue) AS r FROM eva WHERE revenue IS NOT NULL GROUP BY aid)"));
  const selects = steps.map((_, i) =>
    raw(
      `SELECT ${i + 1} AS step, COUNT(*) AS sessions, COUNT(DISTINCT ${bySession ? "x.vid" : "x.aid"}) AS visitors, COALESCE(SUM(rv.r), 0) AS revenue FROM s${i + 1} x LEFT JOIN rev rv ON rv.aid = x.aid`,
    ),
  );
  return sql`WITH ${join(ctes, ",\n")}
  ${join(selects, " UNION ALL ")}`;
}
