/** Trigger condition matching. Shared by the browser runtime and the validator/tests. */
export const CONDITION_OPS = [
  "equals",
  "contains",
  "starts_with",
  "ends_with",
  "matches_regex",
  "not_equals",
  "not_contains",
  "not_starts_with",
  "not_ends_with",
  "not_matches_regex",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

const regexCache: Record<string, RegExp | null> = {};

export function compileRegex(pattern: string, ignoreCase?: boolean): RegExp | null {
  const key = (ignoreCase ? "i:" : "s:") + pattern;
  if (key in regexCache) return regexCache[key]!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch {
    re = null;
  }
  regexCache[key] = re;
  return re;
}

export function toComparable(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function matchCondition(actual: unknown, op: ConditionOp, expected: unknown, ignoreCase?: boolean): boolean {
  const negate = op.startsWith("not_");
  const base = (negate ? op.slice(4) : op) as ConditionOp;
  let a = toComparable(actual);
  let e = toComparable(expected);
  if (ignoreCase && base !== "matches_regex") {
    a = a.toLowerCase();
    e = e.toLowerCase();
  }
  let r: boolean;
  switch (base) {
    case "equals":
      r = a === e;
      break;
    case "contains":
      r = a.indexOf(e) !== -1;
      break;
    case "starts_with":
      r = a.slice(0, e.length) === e;
      break;
    case "ends_with":
      r = e.length === 0 || a.slice(-e.length) === e;
      break;
    case "matches_regex": {
      const re = compileRegex(e, ignoreCase);
      r = re ? re.test(a) : false;
      break;
    }
    default:
      r = false;
  }
  return negate ? !r : r;
}
