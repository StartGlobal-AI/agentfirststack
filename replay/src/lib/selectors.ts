/**
 * Server-side checks for the CSS selectors a site configures (unmask, mask, block). There is no
 * DOM in a Worker, so this is a syntax sanity check: it refuses what could break out of a selector
 * list or never be a selector (braces, at-rules, "<", unbalanced brackets or quotes).
 * The recorder also drops any selector the browser can't parse, one by one.
 */
export function selectorProblem(sel: string): string | null {
  const s = sel.trim();
  if (!s) return "is empty";
  if (s.length > 200) return "is longer than 200 characters";
  if (/[{}<;@\\\n\r]/.test(s)) return "contains { } < ; @ \\ or a newline";
  if (/^,|,$|,,/.test(s)) return "has an empty item in a comma list (pass separate array entries instead)";
  const stack: string[] = [];
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(") stack.push(ch);
    else if (ch === "]" || ch === ")") {
      const open = stack.pop();
      if ((ch === "]" && open !== "[") || (ch === ")" && open !== "(")) return "has unbalanced brackets";
    }
  }
  if (quote) return "has an unclosed quote";
  if (stack.length) return "has unbalanced brackets";
  return null;
}

/** Problems for a list, as "unmask_selectors[2] (\"...\") has ..." strings. */
export function selectorListProblems(field: string, list: readonly string[]): string[] {
  const out: string[] = [];
  list.forEach((s, i) => {
    const p = selectorProblem(s);
    if (p) out.push(`${field}[${i}] (${JSON.stringify(s.slice(0, 60))}) ${p}.`);
  });
  return out;
}

/** Joined for the recorder, after the built-in data-afsr-* selector. */
export const joinSelectors = (list: readonly string[]) => list.map((s) => s.trim()).join(",");
