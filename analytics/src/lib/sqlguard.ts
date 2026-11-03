/**
 * Read-only SQL guard for /v1/sites/:id/sql. Accepts one SELECT or WITH statement over the site's
 * own SQLite. Comments and quoted strings are stripped before checking, so keywords inside
 * literals are fine and keywords hidden in comments are not. The DO additionally runs the query
 * inside a transaction that is rolled back if any row was written (defence in depth).
 *
 * The query runs synchronously inside the site's Durable Object, so shapes that can run away are
 * refused up front: recursive CTEs (SQLite treats a CTE that names itself as recursive even
 * without the RECURSIVE keyword), comma joins, more than MAX_SQL_JOINS joins, and joins without an
 * ON / USING condition (table-valued functions such as json_each are exempt).
 */

export const MAX_SQL_LENGTH = 10_000;
export const MAX_SQL_JOINS = 2;

const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "load_extension",
];

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/** Replace comments with a space and string/identifier literals with placeholders. */
export function skeleton(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const endIdx = sql.indexOf("*/", i + 2);
      i = endIdx < 0 ? sql.length : endIdx + 2;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            j += 2; // doubled quote escape
            continue;
          }
          break;
        }
        j++;
      }
      // Strings vanish; quoted identifiers keep their (sanitised) name so "_cf_KV" is still caught.
      out += ch === "'" ? "''" : ` ${sql.slice(i + 1, j).replace(/[^A-Za-z0-9_]/g, "_")} `;
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function guardSql(input: string): GuardResult {
  if (!input || !input.trim()) return { ok: false, reason: "Empty query." };
  if (input.length > MAX_SQL_LENGTH) return { ok: false, reason: `Query is longer than ${MAX_SQL_LENGTH} characters.` };
  let sql = input.trim();
  // One trailing semicolon is harmless.
  const sk0 = skeleton(sql).trimEnd();
  if (sk0.endsWith(";")) sql = sql.replace(/;\s*$/, "");
  const sk = skeleton(sql).toLowerCase();
  if (sk.includes(";")) return { ok: false, reason: "Only a single statement is allowed (remove the ';')." };
  const first = /^\s*(\w+)/.exec(sk)?.[1];
  if (first !== "select" && first !== "with") return { ok: false, reason: "Only SELECT or WITH queries are allowed." };
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(sk)) return { ok: false, reason: `Read-only: "${kw.toUpperCase()}" is not allowed.` };
  }
  if (/\breplace\s+into\b/.test(sk)) return { ok: false, reason: 'Read-only: "REPLACE INTO" is not allowed.' };
  if (/\b_cf_\w*/.test(sk)) return { ok: false, reason: "Internal _cf_ tables are not queryable." };
  const shape = checkShape(tokenize(sk));
  if (shape) return { ok: false, reason: shape };
  return { ok: true, sql };
}

/** Tokens of a lowercased skeleton: words, numbers, the '' string placeholder, single symbols. */
function tokenize(sk: string): string[] {
  return sk.match(/[a-z_][a-z0-9_$]*|\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+|''|[?:@$][a-z0-9_]*|\S/g) ?? [];
}

/** Index of the ")" matching the "(" at `open` (or the end when unbalanced; SQLite rejects that). */
function closing(t: string[], open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")" && --depth === 0) return i;
  }
  return t.length;
}

const isWord = (s: string | undefined) => !!s && /^[a-z_]/.test(s);
/** Words that end a FROM list at the same nesting depth. */
const FROM_END = new Set(["where", "group", "having", "order", "limit", "window", "union", "intersect", "except", "select", "values"]);
/** Words that can follow a join's table without being its alias. */
const NOT_ALIAS = new Set([
  "on",
  "using",
  "where",
  "group",
  "having",
  "order",
  "limit",
  "window",
  "join",
  "left",
  "right",
  "full",
  "inner",
  "cross",
  "natural",
  "outer",
  "union",
  "intersect",
  "except",
  "indexed",
  "not",
]);

/** Reason the query has a runaway-prone shape, or null. `t` are tokens of the lowercased skeleton. */
function checkShape(t: string[]): string | null {
  if (t.includes("recursive")) return 'Recursive queries are not allowed: remove "RECURSIVE".';

  const joins = t.filter((x) => x === "join").length;
  if (joins > MAX_SQL_JOINS) return `At most ${MAX_SQL_JOINS} JOINs per query (found ${joins}).`;

  // Comma joins: a "," directly inside a FROM list, at the FROM's own parenthesis depth.
  // ("IS [NOT] DISTINCT FROM" is a comparison, not a FROM clause.)
  const inFrom: boolean[] = [false];
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    if (x === "(") inFrom.push(false);
    else if (x === ")") inFrom.length > 1 && inFrom.pop();
    else if (x === "from" && t[i - 1] !== "distinct") inFrom[inFrom.length - 1] = true;
    else if (FROM_END.has(x)) inFrom[inFrom.length - 1] = false;
    else if (x === "," && inFrom[inFrom.length - 1]) return "Comma joins (FROM a, b) are not allowed: use JOIN ... ON ....";
  }

  // Every JOIN needs ON or USING, except NATURAL joins and table-valued functions (json_each(...)).
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "join") continue;
    if (t.slice(Math.max(0, i - 3), i).includes("natural")) continue;
    let j = i + 1;
    let tableFn = false;
    if (t[j] === "(") j = closing(t, j) + 1;
    else {
      j++;
      if (t[j] === "." && isWord(t[j + 1])) j += 2;
      if (t[j] === "(") {
        tableFn = true;
        j = closing(t, j) + 1;
      }
    }
    if (t[j] === "as") j += 2;
    else if (isWord(t[j]) && !NOT_ALIAS.has(t[j]!)) j++;
    if (t[j] === "indexed") j += 3;
    else if (t[j] === "not" && t[j + 1] === "indexed") j += 2;
    if (!tableFn && t[j] !== "on" && t[j] !== "using")
      return "Every JOIN needs an ON or USING condition (cartesian joins are not allowed).";
  }

  // Recursive CTEs without the keyword: a CTE whose body selects FROM / JOINs its own name.
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "with") continue;
    let j = i + 1;
    for (;;) {
      const name = t[j];
      if (!isWord(name)) break;
      j++;
      if (t[j] === "(") j = closing(t, j) + 1; // column list
      if (t[j] !== "as") break;
      j++;
      if (t[j] === "not") j++;
      if (t[j] === "materialized") j++;
      if (t[j] !== "(") break;
      const end = closing(t, j);
      for (let k = j + 1; k < end; k++) {
        if (t[k] !== name) continue;
        let p = k - 1;
        while (t[p] === "(") p--; // FROM (x), FROM ((x)) and JOIN (x) name a table too
        if ((t[p] === "from" && t[p - 1] !== "distinct") || t[p] === "join") {
          return `CTE "${name}" refers to itself, which makes it recursive; recursive queries are not allowed.`;
        }
      }
      j = end + 1;
      if (t[j] !== ",") break;
      j++;
    }
  }
  return null;
}
