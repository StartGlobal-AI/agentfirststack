/**
 * Deterministic text themes for free-text survey answers (no model): words and two-word phrases
 * that recur across responses, each with how many responses use it, example response and session
 * ids and a couple of quotes. Same input, same output; the calling agent reads the quotes.
 */

const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can
  cannot could did do does doing down during each few for from further get got had has have having he her here hers him his how i
  if in into is it its itself just let me more most my no nor not now of off on once only or other our ours out over own really same
  she should so some such than that the their theirs them then there these they this those through to too under until up very was
  we were what when where which while who whom why will with would you your yours yes ok okay thanks thank please would like much
  many lot lots thing things one get im ive dont cant didnt doesnt isnt wasnt its youre thats theres page site website`
    .split(/\s+/)
    .filter(Boolean),
);

const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Lowercased words of 3+ letters, stop words removed, plural "s" stripped. */
export function tokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/['’]/g, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w))
    .map(stem)
    .filter((w) => !STOP.has(w));
}

export interface ThemeInput {
  id: string;
  session_id: string | null;
  text: string;
}

export interface Theme {
  theme: string;
  responses: number;
  share: number;
  example_response_ids: string[];
  example_session_ids: string[];
  quotes: string[];
}

export function textThemes(items: readonly ThemeInput[], top = 8): { themes: Theme[]; unthemed: number; responses: number } {
  const docs = items.map((it) => {
    const t = tokens(it.text);
    const grams = new Set<string>(t);
    for (let i = 0; i + 1 < t.length; i++) if (t[i] !== t[i + 1]) grams.add(`${t[i]} ${t[i + 1]}`);
    return { it, grams };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const g of d.grams) df.set(g, (df.get(g) ?? 0) + 1);
  const min = docs.length >= 5 ? 2 : 1;
  const ranked = [...df.entries()]
    .filter(([, n]) => n >= min)
    .map(([g, n]) => ({ g, n, score: n * (g.includes(" ") ? 1.5 : 1) }))
    .sort((a, b) => b.score - a.score || b.n - a.n || a.g.localeCompare(b.g));
  const chosen: { g: string; n: number }[] = [];
  for (const c of ranked) {
    if (chosen.length >= top) break;
    // a word inside a chosen phrase that occurs no more often than the phrase says nothing new
    if (!c.g.includes(" ") && chosen.some((x) => x.g.includes(" ") && x.g.split(" ").includes(c.g) && x.n >= c.n)) continue;
    if (c.g.includes(" ") && chosen.some((x) => !x.g.includes(" ") && c.g.split(" ").includes(x.g) && x.n === c.n)) continue;
    chosen.push(c);
  }
  const themed = new Set<string>();
  const themes = chosen.map((c) => {
    const hits = docs.filter((d) => d.grams.has(c.g));
    for (const h of hits) themed.add(h.it.id);
    return {
      theme: c.g,
      responses: hits.length,
      share: docs.length ? Math.round((hits.length / docs.length) * 1000) / 1000 : 0,
      example_response_ids: hits.slice(0, 3).map((h) => h.it.id),
      example_session_ids: [...new Set(hits.map((h) => h.it.session_id).filter((s): s is string => !!s))].slice(0, 3),
      quotes: hits.slice(0, 2).map((h) => (h.it.text.length > 200 ? `${h.it.text.slice(0, 199)}…` : h.it.text)),
    };
  });
  return { themes, unthemed: docs.length - themed.size, responses: docs.length };
}
