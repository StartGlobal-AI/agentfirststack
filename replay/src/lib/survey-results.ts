/**
 * Survey results from stored responses, deterministic: the funnel (shown -> started -> completed),
 * per question how many answered and dropped, distributions per choice and score, NPS (promoters -
 * detractors), CSAT (share in the top two of the scale), CES and rating means, PMF (share "very
 * disappointed"), and text themes. Pure: the site's Durable Object runs it over at most the 5,000
 * newest responses.
 */

import { type Answer, isAnswered, npsGroup, pathOf, type Question } from "./survey";
import type { CleanAnswers } from "./survey-def";
import { textThemes } from "./themes";

export interface ResultRow {
  id: string;
  session_id: string | null;
  answers: CleanAnswers;
  completed: boolean;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const share = (a: number, b: number) => (b ? r3(a / b) : 0);

export function surveyResults(qs: readonly Question[], rows: readonly ResultRow[], impressions: number) {
  const started = rows.filter((r) => Object.keys(r.answers).length > 0).length;
  const completed = rows.filter((r) => r.completed).length;
  const questions = qs.map((q) => {
    // shown = respondents whose path (from their answers) reached this question
    let shown = 0;
    let answered = 0;
    const values: Answer[] = [];
    for (const r of rows) {
      if (!Object.keys(r.answers).length) continue;
      if (pathOf(qs, r.answers).includes(q.id)) shown++;
      const a = r.answers[q.id];
      if (isAnswered(a as Answer)) {
        answered++;
        values.push(a as Answer);
      }
    }
    const base = { id: q.id, type: q.type, text: q.text, shown, answered, skipped: Math.max(0, shown - answered) };
    const nums = values.filter((v): v is number => typeof v === "number");
    const dist = (keys: (string | number)[]) =>
      keys.map((k) => {
        const n = values.filter((v) => (Array.isArray(v) ? v.includes(String(k)) : String(v) === String(k))).length;
        return { value: k, count: n, share: share(n, answered) };
      });
    const mean = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
    switch (q.type) {
      case "nps": {
        const g = { promoter: 0, passive: 0, detractor: 0 };
        for (const n of nums) g[npsGroup(n)]++;
        return {
          ...base,
          distribution: dist([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
          nps: nums.length ? Math.round(((g.promoter - g.detractor) / nums.length) * 100) : null,
          promoters: g.promoter,
          passives: g.passive,
          detractors: g.detractor,
        };
      }
      case "rating": {
        const max = q.scale?.max ?? 5;
        const top2 = nums.filter((n) => n >= max - 1).length;
        return {
          ...base,
          distribution: dist(Array.from({ length: max }, (_, i) => i + 1)),
          mean,
          // CSAT-style: the top two of the scale; for a CES (easy = high) scale, the same reading
          satisfied_share: share(top2, nums.length),
        };
      }
      case "reaction":
        return { ...base, distribution: dist([1, 2, 3, 4, 5]), mean };
      case "single_choice":
      case "multi_choice": {
        const known = q.choices ?? [];
        const other = values.filter((v) => (Array.isArray(v) ? v.some((x) => !known.includes(x)) : !known.includes(String(v)))).length;
        const d = dist(known);
        const first = d[0];
        return {
          ...base,
          distribution: q.other ? [...d, { value: "other", count: other, share: share(other, answered) }] : d,
          // PMF (Sean Ellis): the share answering the first choice ("Very disappointed")
          ...(q.type === "single_choice" && /disappointed/i.test(known[0] ?? "") && first ? { pmf_share: first.share } : {}),
        };
      }
      case "email":
        // how many gave an address; the addresses stay in the responses
        return { ...base, emails_given: answered };
      case "short_text":
      case "long_text": {
        const items = rows
          .filter((r) => typeof r.answers[q.id] === "string")
          .map((r) => ({ id: r.id, session_id: r.session_id, text: r.answers[q.id] as string }));
        return { ...base, text_themes: textThemes(items) };
      }
      default:
        return base;
    }
  });
  return {
    funnel: {
      shown: impressions,
      started,
      completed,
      start_rate: share(started, impressions),
      completion_rate: share(completed, started),
    },
    questions,
  };
}
