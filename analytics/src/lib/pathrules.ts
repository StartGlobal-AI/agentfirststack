import type { PathRule } from "./types";

/**
 * Path cleaning rules, applied at ingest to every event's path (so pages, entry and exit pages and
 * URLs are stored clean): `/users/42/settings` -> `/users/:id/settings`. Pure.
 *
 * A rule's `match` is a pattern over the whole path: `*` matches one path segment (no "/"), `**`
 * any run of characters (including "/"); everything else is literal. `replace` is the literal
 * path stored instead. Rules run in order and the first that matches wins.
 */

export const MAX_PATH_RULES = 50;

export interface CompiledPathRule {
  match: string;
  replace: string;
  re: RegExp;
}

export function pathPatternToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]+";
    } else out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function normalizePathRules(input: readonly PathRule[]): { value: PathRule[]; problems: string[] } {
  const value: PathRule[] = [];
  const problems: string[] = [];
  for (const r of input) {
    const match = r.match.trim();
    const replace = r.replace.trim();
    if (!match.startsWith("/")) problems.push(`path_rules: match "${r.match}" must start with "/".`);
    else if (!replace.startsWith("/")) problems.push(`path_rules: replace "${r.replace}" must start with "/".`);
    else if (!value.some((v) => v.match === match)) value.push({ match, replace });
  }
  return { value, problems };
}

export function compilePathRules(rules: readonly PathRule[] | null | undefined): CompiledPathRule[] {
  return (rules ?? []).map((r) => ({ ...r, re: pathPatternToRegExp(r.match) }));
}

/** The cleaned path and the rule that matched (null: unchanged). */
export function cleanPath(path: string, rules: readonly CompiledPathRule[]): { path: string; rule: string | null } {
  for (const r of rules) if (r.re.test(path)) return { path: r.replace, rule: r.match };
  return { path, rule: null };
}
