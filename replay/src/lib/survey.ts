/**
 * Survey logic shared by the survey widget (src/survey, in the visitor's browser) and the Worker:
 * question types, skip logic and answer checks. Pure and DOM-free; the Worker validates every
 * answer again with the same rules (anyone can POST /f).
 */

export const QUESTION_TYPES = [
  "reaction",
  "short_text",
  "long_text",
  "single_choice",
  "multi_choice",
  "rating",
  "nps",
  "statement",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** A skip-logic condition on the answer to the question it belongs to. */
export interface Condition {
  equals?: string | number;
  in?: (string | number)[];
  lte?: number;
  gte?: number;
  /** true: any answer; false: skipped / empty */
  answered?: boolean;
}

/** In order, the first rule whose `if` holds (or that has none: the "else") decides where to go. */
export interface LogicRule {
  if?: Condition;
  /** a later question's id, or "end" */
  goto: string;
}

export interface Scale {
  /** 5, 7 or 10 */
  max: number;
  min_label?: string;
  max_label?: string;
  style?: "numbers" | "stars" | "emoji";
}

export interface Question {
  id: string;
  type: QuestionType;
  text: string;
  choices?: string[] | null;
  scale?: Scale | null;
  required?: boolean;
  randomize?: boolean;
  /** single/multi choice: an "Other" free-text answer is allowed */
  other?: boolean;
  placeholder?: string;
  logic?: LogicRule[];
}

export type Answer = string | number | string[] | null | undefined;

export const isAnswered = (a: Answer): boolean => a !== null && a !== undefined && a !== "" && !(Array.isArray(a) && a.length === 0);

/** Does the condition hold for this answer? Arrays (multi choice) match when any value does. */
export function conditionHolds(c: Condition, a: Answer): boolean {
  if (c.answered !== undefined && c.answered !== isAnswered(a)) return false;
  const vals: (string | number)[] = Array.isArray(a) ? a : isAnswered(a) ? [a as string | number] : [];
  const eq = (x: string | number, y: string | number) => String(x) === String(y);
  if (c.equals !== undefined && !vals.some((v) => eq(v, c.equals!))) return false;
  if (c.in !== undefined && !vals.some((v) => c.in!.some((w) => eq(v, w)))) return false;
  const n = typeof a === "number" ? a : typeof a === "string" && a.trim() !== "" ? Number(a) : Number.NaN;
  if (c.lte !== undefined && !(n <= c.lte)) return false;
  if (c.gte !== undefined && !(n >= c.gte)) return false;
  return true;
}

/** The index of the question after `i` given its answer; -1 = the end. */
export function nextIndex(qs: readonly Question[], i: number, a: Answer): number {
  const q = qs[i];
  if (!q) return -1;
  for (const r of q.logic ?? []) {
    if (r.if && !conditionHolds(r.if, a)) continue;
    if (r.goto === "end") return -1;
    const j = qs.findIndex((x) => x.id === r.goto);
    if (j > i) return j;
  }
  return i + 1 < qs.length ? i + 1 : -1;
}

/** The question ids a respondent with these answers was shown, in order. */
export function pathOf(qs: readonly Question[], answers: Record<string, Answer>): string[] {
  const out: string[] = [];
  for (let i = 0; i >= 0 && i < qs.length && out.length <= qs.length; i = nextIndex(qs, i, answers[qs[i]!.id])) out.push(qs[i]!.id);
  return out;
}

/** NPS bucket of a 0-10 answer. */
export const npsGroup = (n: number): "promoter" | "passive" | "detractor" => (n >= 9 ? "promoter" : n >= 7 ? "passive" : "detractor");
