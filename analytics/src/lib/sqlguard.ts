/**
 * Read-only SQL guard for /v1/sites/:id/sql. Accepts one SELECT or WITH statement over the site's
 * own SQLite. Comments and quoted strings are stripped before checking, so keywords inside
 * literals are fine and keywords hidden in comments are not. The DO additionally runs the query
 * inside a transaction that is rolled back if any row was written (defence in depth).
 *
 * The query runs synchronously inside the site's Durable Object, and SQLite can't be interrupted
 * there, so shapes that can run away are refused up front:
 *   - recursive CTEs (SQLite treats a CTE that names itself as recursive even without RECURSIVE),
 *     comma joins, more than MAX_SQL_JOINS joins, joins without ON / USING, joins ON a constant;
 *   - functions outside an allowlist: no generators or size amplifiers (zeroblob, randomblob,
 *     replace, json_pretty, printf/format with `*` or wide fields), string aggregates used as window
 *     functions, deep nesting of hex/quote, more than MAX_AMPLIFIERS concatenations;
 *   - more than one table-valued function, and table-valued functions over anything but a column
 *     or a literal.
 * The engine then bounds the plan itself (lib/sqlplan.ts, EXPLAIN QUERY PLAN) before running it.
 */

export const MAX_SQL_LENGTH = 10_000;
export const MAX_SQL_JOINS = 2;
export const MAX_TABLE_FUNCTIONS = 1;
/** `||` operators plus calls of functions that make strings longer (concat, hex, quote, printf, ...). */
export const MAX_AMPLIFIERS = 32;
/** hex(quote(x)) is fine; hex(hex(hex(x))) is not. */
export const MAX_AMPLIFIER_NESTING = 2;
/** Largest printf()/format() width or precision. */
export const MAX_PRINTF_WIDTH = 100;
/** Rows a table-valued function over a column may produce (props hold at most 30 keys). */
export const COLUMN_TABLE_FUNCTION_ROWS = 32;

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

const AGGREGATES = ["avg", "count", "group_concat", "string_agg", "max", "min", "sum", "total", "json_group_array", "json_group_object"];
const WINDOW = [
  "row_number",
  "rank",
  "dense_rank",
  "percent_rank",
  "cume_dist",
  "ntile",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "nth_value",
];
const SCALAR = [
  "abs",
  "char",
  "coalesce",
  "concat",
  "concat_ws",
  "format",
  "glob",
  "hex",
  "if",
  "ifnull",
  "iif",
  "instr",
  "length",
  "like",
  "likelihood",
  "likely",
  "lower",
  "ltrim",
  "nullif",
  "octet_length",
  "printf",
  "quote",
  "random",
  "round",
  "rtrim",
  "sign",
  "substr",
  "substring",
  "trim",
  "typeof",
  "unhex",
  "unicode",
  "unlikely",
  "upper",
  "date",
  "time",
  "datetime",
  "julianday",
  "strftime",
  "unixepoch",
  "timediff",
  "acos",
  "acosh",
  "asin",
  "asinh",
  "atan",
  "atan2",
  "atanh",
  "ceil",
  "ceiling",
  "cos",
  "cosh",
  "degrees",
  "exp",
  "floor",
  "ln",
  "log",
  "log10",
  "log2",
  "mod",
  "pi",
  "pow",
  "power",
  "radians",
  "sin",
  "sinh",
  "sqrt",
  "tan",
  "tanh",
  "trunc",
  "json",
  "json_array",
  "json_array_length",
  "json_error_position",
  "json_extract",
  "json_insert",
  "json_object",
  "json_patch",
  "json_quote",
  "json_remove",
  "json_replace",
  "json_set",
  "json_type",
  "json_valid",
];
export const TABLE_FUNCTIONS = new Set(["json_each", "json_tree"]);
/** Every function a query may call. Anything else is refused by name. */
export const ALLOWED_FUNCTIONS = new Set([...AGGREGATES, ...WINDOW, ...SCALAR, ...TABLE_FUNCTIONS]);
/** Refused with a specific reason (they generate or blow up data, or reveal nothing useful). */
const DENIED: Record<string, string> = {
  zeroblob: "generates data",
  randomblob: "generates data",
  replace: "can multiply a string's size (use substr / instr / trim instead)",
  json_pretty: "can multiply a value's size",
  generate_series: "generates rows",
};
/** Functions that make their output longer than their input. */
const AMPLIFIERS = new Set(["concat", "concat_ws", "hex", "quote", "json_quote", "char", "printf", "format"]);
const MULTIPLIERS = new Set(["hex", "quote", "json_quote"]);
const STRING_AGGREGATES = new Set(["group_concat", "string_agg", "json_group_array", "json_group_object"]);

/** Keywords that can stand right before "(" without being a function call. */
const PAREN_KEYWORDS = new Set([
  "in",
  "exists",
  "as",
  "values",
  "over",
  "filter",
  "using",
  "on",
  "and",
  "or",
  "not",
  "when",
  "then",
  "else",
  "select",
  "from",
  "join",
  "where",
  "having",
  "by",
  "is",
  "cast",
  "case",
  "distinct",
  "all",
  "union",
  "intersect",
  "except",
  "between",
  "escape",
  "limit",
  "offset",
  "materialized",
  "with",
  "partition",
  "order",
  "group",
  "rows",
  "range",
  "groups",
  "preceding",
  "following",
  "current",
  "nulls",
  "exclude",
  "end",
  "collate",
  "like",
  "glob",
]);
/** Words that are not column references (for the "JOIN ... ON <constant>" check). */
const CONSTANT_WORDS = new Set([
  ...PAREN_KEYWORDS,
  ...ALLOWED_FUNCTIONS,
  "true",
  "false",
  "null",
  "isnull",
  "notnull",
  "current_date",
  "current_time",
  "current_timestamp",
]);

export interface GuardInfo {
  /** alias (or table name) -> the base table it reads, or null for a CTE, subquery or table-valued function */
  aliases: Record<string, string | null>;
  /** at most this many rows from the (single) table-valued function, or null when there is none */
  tableFunctionRows: number | null;
}

export type GuardResult = { ok: true; sql: string; info: GuardInfo } | { ok: false; reason: string };

/** Replace comments with a space and string/identifier literals with placeholders. */
export function skeleton(sql: string): string {
  return scan(sql).sk;
}

/** skeleton() plus the contents of each string literal, in order (one per '' placeholder). */
function scan(sql: string): { sk: string; literals: string[] } {
  let out = "";
  const literals: string[] = [];
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
      if (ch === "'") {
        literals.push(sql.slice(i + 1, j).replaceAll("''", "'"));
        out += " '' ";
      } else out += ` ${sql.slice(i + 1, j).replace(/[^A-Za-z0-9_]/g, "_")} `;
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return { sk: out, literals };
}

export function guardSql(input: string): GuardResult {
  if (!input || !input.trim()) return { ok: false, reason: "Empty query." };
  if (input.length > MAX_SQL_LENGTH) return { ok: false, reason: `Query is longer than ${MAX_SQL_LENGTH} characters.` };
  let sql = input.trim();
  // One trailing semicolon is harmless.
  const sk0 = skeleton(sql).trimEnd();
  if (sk0.endsWith(";")) sql = sql.replace(/;\s*$/, "");
  const scanned = scan(sql);
  const sk = scanned.sk.toLowerCase();
  if (sk.includes(";")) return { ok: false, reason: "Only a single statement is allowed (remove the ';')." };
  const first = /^\s*(\w+)/.exec(sk)?.[1];
  if (first !== "select" && first !== "with") return { ok: false, reason: "Only SELECT or WITH queries are allowed." };
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(sk)) return { ok: false, reason: `Read-only: "${kw.toUpperCase()}" is not allowed.` };
  }
  if (/\breplace\s+into\b/.test(sk)) return { ok: false, reason: 'Read-only: "REPLACE INTO" is not allowed.' };
  if (/\b_cf_\w*/.test(sk)) return { ok: false, reason: "Internal _cf_ tables are not queryable." };
  const t = tokenize(sk);
  const shape = checkShape(t);
  if (shape) return { ok: false, reason: shape };
  const fns = checkFunctions(t, scanned.literals);
  if (typeof fns === "string") return { ok: false, reason: fns };
  return { ok: true, sql, info: { aliases: aliasesOf(t), tableFunctionRows: fns.tableFunctionRows } };
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
/** Words that end a JOIN's ON condition at the same nesting depth. */
const ON_END = new Set([...NOT_ALIAS, "select", "from", "values"].filter((w) => w !== "not"));

/** Names declared by WITH clauses (CTEs), wherever they appear. */
function cteNames(t: string[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "with") continue;
    let j = i + 1;
    for (;;) {
      const name = t[j];
      if (!isWord(name)) break;
      j++;
      if (t[j] === "(") j = closing(t, j) + 1;
      if (t[j] !== "as") break;
      names.add(name!);
      j++;
      if (t[j] === "not") j++;
      if (t[j] === "materialized") j++;
      if (t[j] !== "(") break;
      j = closing(t, j) + 1;
      if (t[j] !== ",") break;
      j++;
    }
  }
  return names;
}

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
  const onAt: number[] = [];
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
    if (t[j] === "on") onAt.push(j);
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

  // JOIN ... ON 1 / ON true / ON 'a' = 'a': a cartesian join in disguise.
  for (const at of onAt) {
    let depth = 0;
    let column = false;
    for (let k = at + 1; k < t.length; k++) {
      const x = t[k]!;
      if (x === "(") depth++;
      else if (x === ")") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && ON_END.has(x)) break;
      else if (isWord(x) && !CONSTANT_WORDS.has(x)) {
        column = true;
        break;
      }
    }
    if (!column) return "A JOIN's ON condition must compare columns (ON 1, ON true and other constants make a cartesian join).";
  }
  return null;
}

/** printf()/format() format strings: no `*` width or precision, none wider than MAX_PRINTF_WIDTH. */
function printfProblem(fmt: string): string | null {
  let n = 0;
  for (const m of fmt.matchAll(/%([-+ 0#,!]*)(\*|\d+)?(?:\.(\*|\d+))?([a-zA-Z%])?/g)) {
    if (++n > 20) return "printf()/format(): at most 20 conversions.";
    if (m[2] === "*" || m[3] === "*") return "printf()/format(): a * width or precision is not allowed.";
    if (Number(m[2] ?? 0) > MAX_PRINTF_WIDTH || Number(m[3] ?? 0) > MAX_PRINTF_WIDTH)
      return `printf()/format(): widths and precisions are limited to ${MAX_PRINTF_WIDTH}.`;
  }
  return null;
}

/** Check every function call; returns the table-valued function bound, or the reason to refuse. */
function checkFunctions(t: string[], literals: string[]): { tableFunctionRows: number | null } | string {
  const ctes = cteNames(t);
  // The k-th '' token is literals[k].
  const literalAt = new Map<number, string>();
  let lit = 0;
  for (let i = 0; i < t.length; i++) if (t[i] === "''") literalAt.set(i, literals[lit++] ?? "");

  let tableFns = 0;
  let tableFunctionRows: number | null = null;
  let amplifiers = 0;
  for (let i = 0; i + 1 < t.length; i++) if (t[i] === "|" && t[i + 1] === "|") amplifiers++, i++;
  const multiplierEnds: number[] = [];

  for (let i = 0; i + 1 < t.length; i++) {
    const w = t[i]!;
    if (!isWord(w) || t[i + 1] !== "(") continue;
    if (PAREN_KEYWORDS.has(w) && t[i - 1] !== ".") continue;
    const close = closing(t, i + 1);
    // WITH name(col, ...) AS (...): a CTE's column list, not a call.
    if (ctes.has(w) && t[close + 1] === "as") continue;
    if (w in DENIED) return `Function ${w}() is not allowed here: it ${DENIED[w]}.`;
    if (!ALLOWED_FUNCTIONS.has(w)) {
      return `Function ${w}() is not allowed here. Allowed: aggregates (${AGGREGATES.join(", ")}), window functions, string, date, math and JSON functions (see the docs), json_each / json_tree.`;
    }
    if (AMPLIFIERS.has(w)) amplifiers++;
    if (w === "printf" || w === "format") {
      const fmt = t[i + 2] === "''" && (t[i + 3] === "," || t[i + 3] === ")") ? literalAt.get(i + 2) : undefined;
      if (fmt === undefined) return `${w}() needs a literal format string as its first argument.`;
      const p = printfProblem(fmt);
      if (p) return p;
    }
    if (STRING_AGGREGATES.has(w)) {
      let after = close + 1;
      if (t[after] === "filter" && t[after + 1] === "(") after = closing(t, after + 1) + 1;
      if (t[after] === "over") return `${w}() can't be used as a window function (OVER): it would rebuild a growing string for every row.`;
    }
    if (MULTIPLIERS.has(w)) {
      while (multiplierEnds.length && multiplierEnds[multiplierEnds.length - 1]! < i) multiplierEnds.pop();
      multiplierEnds.push(close);
      if (multiplierEnds.length > MAX_AMPLIFIER_NESTING)
        return `hex(), quote() and json_quote() can be nested at most ${MAX_AMPLIFIER_NESTING} deep.`;
    }
    if (TABLE_FUNCTIONS.has(w)) {
      if (++tableFns > MAX_TABLE_FUNCTIONS)
        return `At most ${MAX_TABLE_FUNCTIONS} table-valued function (json_each / json_tree) per query.`;
      const args = t.slice(i + 2, close);
      // json_each(e.props), json_each(props, '$.x'), or json_each('[1,2,3]'): nothing computed.
      const parts = splitArgs(args);
      const column = (p: string[]) => (p.length === 1 && isWord(p[0])) || (p.length === 3 && isWord(p[0]) && p[1] === "." && isWord(p[2]));
      const literal = (p: string[]) => p.length === 1 && p[0] === "''";
      const first = parts[0] ?? [];
      if (!(column(first) || literal(first)) || parts.slice(1).some((p) => !literal(p)) || parts.length > 2)
        return `${w}() takes a column (json_each(e.props)) or a literal, optionally with a literal path.`;
      if (column(first)) tableFunctionRows = COLUMN_TABLE_FUNCTION_ROWS;
      else {
        const text = literalAt.get(i + 2) ?? "";
        tableFunctionRows = Math.floor(text.length / 2) + 1;
      }
    }
  }
  if (amplifiers > MAX_AMPLIFIERS)
    return `At most ${MAX_AMPLIFIERS} concatenations (||, concat, printf, hex, quote, char ...) per query (found ${amplifiers}).`;
  return { tableFunctionRows };
}

/** Top-level comma-separated argument token lists. */
function splitArgs(args: string[]): string[][] {
  const out: string[][] = [[]];
  let depth = 0;
  for (const x of args) {
    if (x === "(") depth++;
    else if (x === ")") depth--;
    if (x === "," && depth === 0) out.push([]);
    else out[out.length - 1]!.push(x);
  }
  return out.filter((p, i) => p.length || i === 0);
}

/** alias -> base table for every FROM / JOIN item (null for CTEs, subqueries, table functions). */
function aliasesOf(t: string[]): Record<string, string | null> {
  const ctes = cteNames(t);
  const out: Record<string, string | null> = {};
  for (let i = 0; i < t.length; i++) {
    if (!(t[i] === "join" || (t[i] === "from" && t[i - 1] !== "distinct"))) continue;
    let j = i + 1;
    let table: string | null = null;
    if (t[j] === "(") j = closing(t, j) + 1;
    else if (isWord(t[j])) {
      table = t[j]!;
      j++;
      if (t[j] === "." && isWord(t[j + 1])) {
        table = t[j + 1]!;
        j += 2;
      }
      if (t[j] === "(") {
        table = null; // table-valued function
        j = closing(t, j) + 1;
      } else {
        if (ctes.has(table)) table = null;
        out[t[j - 1]!] = table;
      }
    } else continue;
    let alias: string | undefined;
    if (t[j] === "as") alias = t[j + 1];
    else if (isWord(t[j]) && !NOT_ALIAS.has(t[j]!) && !FROM_END.has(t[j]!)) alias = t[j];
    if (alias && isWord(alias)) out[alias] = table;
  }
  return out;
}
