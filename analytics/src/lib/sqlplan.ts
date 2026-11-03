/**
 * A cost bound for user SQL, from SQLite's own plan (EXPLAIN QUERY PLAN), checked before the
 * query runs. The DO SQL API can't interrupt a statement, and work SQLite does before the first
 * row (an aggregate over a join, a sort) isn't visible to the cursor's rowsRead, so the plan is
 * where a nested-loop blowup has to be caught.
 *
 * Each loop of the plan gets a row estimate: a full SCAN or a non-selective SEARCH (a ts range,
 * name=?, an automatic index) reads up to the whole table; a lookup by primary key reads 1; one by
 * session_id / visitor_id / user_id / customer reads a few; a table-valued function reads what
 * the guard bounded. Loops nested in one SELECT multiply, correlated subqueries multiply by the
 * loops around them, everything else adds. Table sizes are upper bounds from rowids (max - min + 1,
 * O(log n)), so the estimate is conservative.
 */

export interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

export interface PlanInput {
  rows: PlanRow[];
  /** alias -> base table (null: CTE, subquery or table function), from the guard */
  aliases: Record<string, string | null>;
  /** upper bound of a base table's rows */
  tableRows: (table: string) => number;
  /** rows of the biggest table (what an unknown CTE / subquery is assumed to produce) */
  maxRows: number;
  /** bound of the query's table-valued function, if any */
  tableFunctionRows: number | null;
}

/** Index lookups that return a handful of rows: one session's, visitor's, user's or customer's. */
const SELECTIVE_INDEXES = new Set(["events_session", "events_visitor", "sessions_visitor", "sessions_user", "payments_customer"]);
export const SELECTIVE_ROWS = 5;
const CAP = 1e18;
const mul = (a: number, b: number) => Math.min(CAP, a * b);

/** Rows one loop of the plan reads per pass. */
export function loopRows(detail: string, p: PlanInput): number {
  const m = /^(SCAN|SEARCH) (.+?)(?: (USING .*|VIRTUAL TABLE.*))?$/.exec(detail);
  if (!m) return p.maxRows;
  const [, op, subject = "", how = ""] = m;
  const values = /^(\d+)-ROW VALUES CLAUSE$/.exec(subject);
  if (values) return Number(values[1]);
  if (/^CONSTANT ROW/.test(subject)) return 1;
  if (how.startsWith("VIRTUAL TABLE")) return p.tableFunctionRows ?? p.maxRows;
  const alias = subject.toLowerCase();
  const table = alias in p.aliases ? p.aliases[alias] : alias;
  const size = table ? p.tableRows(table) : p.maxRows;
  if (op === "SCAN") return size;
  // SEARCH: how selective is the lookup?
  const constraint = /\(([^()]*)\)\s*$/.exec(how)?.[1] ?? "";
  const firstEq = /^\w+=\?/.test(constraint);
  const allEq = constraint !== "" && constraint.split(" AND ").every((c) => /^\w+=\?$/.test(c));
  if (/AUTOMATIC/.test(how)) return size;
  if (/INTEGER PRIMARY KEY|USING PRIMARY KEY/.test(how) && allEq) return 1;
  const index = /INDEX (\S+)/.exec(how)?.[1] ?? "";
  if (index.startsWith("sqlite_autoindex_") && allEq) return 1;
  if (SELECTIVE_INDEXES.has(index) && firstEq) return Math.min(size, SELECTIVE_ROWS);
  return size;
}

/** Estimated rows SQLite reads to run the plan to completion. */
export function estimatePlan(p: PlanInput): number {
  const children = new Map<number, PlanRow[]>();
  for (const r of p.rows) {
    const list = children.get(r.parent) ?? [];
    list.push(r);
    children.set(r.parent, list);
  }
  const kids = (id: number) => children.get(id) ?? [];
  const isLoop = (d: string) => /^(SCAN|SEARCH) /.test(d);
  const ignored = (d: string) => /^(USE TEMP B-TREE|CREATE BLOOM FILTER|BLOOM FILTER|RIGHT-JOIN|LEFT-JOIN)/.test(d);

  const block = (id: number, seen: Set<number>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let product = 1;
    for (const c of kids(id)) {
      if (isLoop(c.detail)) product = mul(product, loopRows(c.detail, p));
      else if (/^MULTI-INDEX OR/.test(c.detail)) {
        let sum = 0;
        for (const ix of kids(c.id)) for (const t of kids(ix.id)) if (isLoop(t.detail)) sum += loopRows(t.detail, p);
        product = mul(product, Math.max(1, sum));
      }
    }
    let extra = 0;
    for (const c of kids(id)) {
      if (isLoop(c.detail) || ignored(c.detail) || /^MULTI-INDEX OR/.test(c.detail)) continue;
      const inner = block(c.id, seen);
      // Correlated subqueries run once per row of the loops around them; the rest run once.
      extra = Math.min(CAP, extra + (/^CORRELATED /.test(c.detail) ? mul(product, inner) : inner));
    }
    return Math.min(CAP, product + extra);
  };
  return block(0, new Set());
}

/** Fixed part of the plan budget: any plan this small runs in well under a second. */
export const PLAN_MIN_BUDGET = 1_000_000;
/** A plan may read the biggest table at most this many times over (a join on ids, json_each over props). */
export const PLAN_TABLE_FACTOR = 100;

/** The most rows a plan may be estimated to read. */
export const planBudget = (maxRows: number) => Math.max(PLAN_MIN_BUDGET, PLAN_TABLE_FACTOR * maxRows);
