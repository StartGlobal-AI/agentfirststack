/**
 * Survey definitions on the server: the schema agents write (zod), templates, the checks a
 * definition must pass, the public config the widget is served with, answer validation and the
 * session-transcript summary of a response. Survey text is the site owner's; answers are typed by
 * visitors: both are untrusted, cleaned of control and bidi characters, size-capped, and the
 * widget renders every string with textContent only.
 */

import { z } from "zod";
import { cleanText, scrubText } from "./mask-rules";
import { selectorProblem } from "./selectors";
import { type Answer, isAnswered, npsGroup, pathOf, QUESTION_TYPES, type Question } from "./survey";

export const SURVEY_KINDS = ["popover", "embedded", "feedback"] as const;
export type SurveyKind = (typeof SURVEY_KINDS)[number];
export const SURVEY_STATUSES = ["draft", "active", "paused", "closed"] as const;
export const TEMPLATES = ["nps", "csat", "ces", "pmf", "free_text"] as const;
export const TRIGGERS = ["load", "delay", "scroll", "exit_intent", "frustration", "manual"] as const;
export const FREQUENCIES = ["once_per_tab", "once_per_visitor", "until_answered"] as const;
export const LINK_SESSION = ["auto", "ask", "never"] as const;
export const POSITIONS = ["bottom_right", "bottom_left", "center"] as const;
export const SIDES = ["right", "left"] as const;
export const STRING_KEYS = ["next", "submit", "thanks", "close", "feedback", "share_session", "other", "pick", "picked", "skip"] as const;

/** Built-in hard limits (fair-use vars can only lower the count caps). */
export const SURVEY_LIMITS = {
  QUESTIONS: 20,
  TEXT: 500,
  CHOICE: 200,
  CHOICES: 20,
  ANSWER_CHARS: 2000,
  /** bytes of one POST /f body (a keepalive fetch carries at most 64 KB) */
  BODY_BYTES: 60 * 1024,
  NAME: 120,
} as const;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max * 2)
    .transform((s) => cleanText(s).trim().slice(0, max))
    .refine((s) => s.length > 0, "must not be empty");

const RESERVED_IDS = new Set([
  "constructor",
  "prototype",
  "tostring",
  "valueof",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
  "tolocalestring",
]);
const qid = z
  .string()
  .regex(/^(?!__)[a-z0-9_]{1,20}$/i, "question ids are letters, digits and _ (at most 20, not starting with __)")
  .refine((v) => !RESERVED_IDS.has(v.toLowerCase()), "that question id is reserved; use q1, q2, ...");
const scalar = z.union([z.string().max(SURVEY_LIMITS.CHOICE), z.number().finite()]);

const condition = z
  .object({
    equals: scalar.optional(),
    in: z.array(scalar).max(SURVEY_LIMITS.CHOICES).optional(),
    lte: z.number().finite().optional(),
    gte: z.number().finite().optional(),
    answered: z.boolean().optional(),
  })
  .strict();

export const questionSchema = z
  .object({
    id: qid.optional().describe("Stable id (q1, q2, ... by default); answers and logic refer to it."),
    type: z.enum(QUESTION_TYPES),
    text: text(SURVEY_LIMITS.TEXT),
    choices: z.array(text(SURVEY_LIMITS.CHOICE)).min(2).max(SURVEY_LIMITS.CHOICES).nullable().optional(),
    scale: z
      .object({
        max: z.union([z.literal(5), z.literal(7), z.literal(10)]),
        min_label: text(60).optional(),
        max_label: text(60).optional(),
        style: z.enum(["numbers", "stars", "emoji"]).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    required: z.boolean().optional(),
    randomize: z.boolean().optional(),
    other: z.boolean().optional(),
    placeholder: text(120).optional(),
    logic: z
      .array(z.object({ if: condition.optional(), goto: z.string().min(1).max(20) }).strict())
      .max(10)
      .optional(),
  })
  .strict();

const glob = z.string().min(1).max(300).regex(/^[/*]/, 'path globs start with "/" or "*"');

export const targetingSchema = z
  .object({
    pages: z.array(glob).max(20).optional().describe('Path globs where it may show (default every page): ["/checkout*"].'),
    exclude_pages: z.array(glob).max(20).optional(),
    devices: z
      .array(z.enum(["desktop", "mobile", "tablet"]))
      .max(3)
      .optional(),
    countries: z
      .array(z.string().regex(/^[A-Za-z]{2}$/))
      .max(50)
      .optional()
      .describe("ISO alpha-2; checked on the server when the widget is served."),
    tags: z
      .record(z.string().regex(/^[A-Za-z0-9_.-]{1,50}$/), z.string().max(100))
      .optional()
      .describe('Custom tags the page set with afsr(\'set\') that must all hold, e.g. {"plan":"pro"}.'),
    identified: z.boolean().optional().describe("true: only after afsr('identify'); false: only anonymous visitors."),
    segment_id: z
      .string()
      .max(40)
      .optional()
      .describe("A saved segment whose filters a browser can check before showing (page, device, country, tag; others are refused)."),
    sample_rate: z.number().min(0).max(1).optional().describe("Share of eligible tabs that see it (default 1)."),
  })
  .strict();

export const triggerSchema = z
  .object({
    on: z.enum(TRIGGERS),
    seconds: z
      .number()
      .int()
      .min(0)
      .max(600)
      .optional()
      .describe("delay: seconds after load (also exit_intent's fallback on touch devices; default 10)."),
    pct: z.number().int().min(1).max(100).optional().describe("scroll: % of the page."),
    signals: z
      .array(z.enum(["rage_click", "error_click"]))
      .max(2)
      .optional()
      .describe("frustration: after a rage click (3 clicks in 1 s) or a click followed by a JS error within 1 s, detected in the browser."),
  })
  .strict();

const accent = z.string().regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/, "a #rgb or #rrggbb colour");

export const appearanceSchema = z
  .object({
    position: z.enum(POSITIONS).optional(),
    side: z.enum(SIDES).optional().describe("feedback: the tab's side (default right)."),
    theme: z.enum(["light", "dark", "auto"]).optional(),
    accent: accent.optional(),
    strings: z
      .record(z.enum(STRING_KEYS), text(80))
      .optional()
      .describe(`Button and label texts (${STRING_KEYS.join(", ")}); your language here.`),
  })
  .strict();

const surveyFields = {
  kind: z.enum(SURVEY_KINDS).describe("popover (corner widget) | embedded (inside a page element, `selector`) | feedback (side tab)."),
  template: z.enum(TEMPLATES).optional().describe("Expands into questions when none are given: nps | csat | ces | pmf | free_text."),
  status: z.enum(SURVEY_STATUSES).optional().describe("draft (default) | active | paused | closed. active needs a verified domain."),
  questions: z.array(questionSchema).min(1).max(SURVEY_LIMITS.QUESTIONS).optional(),
  targeting: targetingSchema.optional(),
  trigger: triggerSchema.optional().describe("When it shows (default load). Embedded and feedback surveys show at once."),
  frequency: z
    .enum(FREQUENCIES)
    .optional()
    .describe("once_per_visitor (default, localStorage), once_per_tab (sessionStorage), until_answered."),
  limits: z
    .object({
      max_responses: z.number().int().min(1).max(1_000_000).optional().describe("Closes itself after this many completed responses."),
      ends_at: z.union([z.string(), z.number()]).nullable().optional().describe("Stops showing after this time (ISO 8601 or unix ms)."),
    })
    .strict()
    .optional(),
  appearance: appearanceSchema.optional(),
  link_session: z
    .enum(LINK_SESSION)
    .optional()
    .describe("auto (default): a response from a recorded tab carries its session id; ask: only if the respondent ticks a box; never."),
  scrub_pii: z.boolean().optional().describe("Mask emails, long numbers and tokens in text answers (default true)."),
  show_with_gpc: z.boolean().optional().describe("Also show to browsers sending Global Privacy Control / Do Not Track (default false)."),
  selector: z.string().max(400).optional().describe("embedded: CSS selector of the element it is rendered into (the first match)."),
  allow_element: z
    .boolean()
    .optional()
    .describe("feedback: let the visitor point at the part of the page they mean (stores its stable selector)."),
};

export const createSurveyInput = z.object({
  name: text(SURVEY_LIMITS.NAME).describe("Natural key per site: the same name again returns the existing survey."),
  ...surveyFields,
});
export const updateSurveyInput = z.object({
  name: text(SURVEY_LIMITS.NAME).optional(),
  ...surveyFields,
  kind: surveyFields.kind.optional(),
});

/** What is stored (D1 surveys.definition) and checked. */
export interface SurveyDef {
  kind: SurveyKind;
  template?: (typeof TEMPLATES)[number];
  questions: Question[];
  targeting: z.infer<typeof targetingSchema>;
  trigger: z.infer<typeof triggerSchema>;
  frequency: (typeof FREQUENCIES)[number];
  limits: { max_responses?: number; ends_at?: number | null };
  appearance: z.infer<typeof appearanceSchema>;
  link_session: (typeof LINK_SESSION)[number];
  scrub_pii: boolean;
  show_with_gpc: boolean;
  selector?: string;
  allow_element?: boolean;
}

type Q = z.infer<typeof questionSchema>;

/** Templates: editable questions. Hotjar has no separate CSAT/CES types: they are presets over rating. */
export function template(name: (typeof TEMPLATES)[number] | "feedback"): Q[] {
  switch (name) {
    case "nps":
      return [
        { id: "q1", type: "nps", text: "How likely are you to recommend us to a friend or colleague?", required: true },
        { id: "q2", type: "long_text", text: "What is the main reason for your score?" },
      ];
    case "csat":
      return [
        {
          id: "q1",
          type: "rating",
          text: "How satisfied are you with your experience today?",
          scale: { max: 5, style: "stars", min_label: "Very dissatisfied", max_label: "Very satisfied" },
          required: true,
          logic: [{ if: { gte: 4 }, goto: "end" }],
        },
        { id: "q2", type: "long_text", text: "What could we do better?" },
      ];
    case "ces":
      return [
        {
          id: "q1",
          type: "rating",
          text: "How easy was it to do what you came here for today?",
          scale: { max: 7, style: "numbers", min_label: "Very difficult", max_label: "Very easy" },
          required: true,
          logic: [{ if: { gte: 6 }, goto: "end" }],
        },
        { id: "q2", type: "long_text", text: "What made it difficult?" },
      ];
    case "pmf":
      return [
        {
          id: "q1",
          type: "single_choice",
          text: "How would you feel if you could no longer use this product?",
          choices: ["Very disappointed", "Somewhat disappointed", "Not disappointed"],
          required: true,
        },
        { id: "q2", type: "long_text", text: "What is the main benefit you get from it?" },
      ];
    case "free_text":
      return [{ id: "q1", type: "long_text", text: "Is there anything we could do better on this page?", required: true }];
    case "feedback":
      return [
        { id: "q1", type: "reaction", text: "How was your experience on this page?", required: true },
        { id: "q2", type: "long_text", text: "Tell us more (optional)" },
      ];
  }
}

/**
 * Questions as stored: ids filled in (q1, q2, ...), unique, choices only on choice types, a scale
 * on rating questions, logic pointing only forward (no loops) to existing questions or "end".
 * Returns problems (with the path of each) instead of throwing.
 */
export function normalizeQuestions(input: Q[], maxQuestions: number): { questions: Question[]; problems: string[] } {
  const problems: string[] = [];
  if (input.length > maxQuestions) problems.push(`questions: at most ${maxQuestions} per survey here.`);
  const qs: Question[] = input.map((q, i) => ({ ...q, id: q.id ?? `q${i + 1}` }) as Question);
  const seen = new Set<string>();
  qs.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (seen.has(q.id)) problems.push(`${at}.id ${JSON.stringify(q.id)} is used twice.`);
    seen.add(q.id);
    const choiceType = q.type === "single_choice" || q.type === "multi_choice";
    if (choiceType && !q.choices?.length) problems.push(`${at}: ${q.type} needs choices (2-${SURVEY_LIMITS.CHOICES}).`);
    if (!choiceType && q.choices) delete q.choices;
    if (!choiceType) delete q.other;
    if (q.type === "rating") q.scale = q.scale ?? { max: 5, style: "stars" };
    else delete q.scale;
    if (q.type === "statement") delete q.required;
    for (const [k, r] of (q.logic ?? []).entries()) {
      if (r.goto === "end") continue;
      const j = qs.findIndex((x) => (x.id ?? "") === r.goto);
      if (j === -1) problems.push(`${at}.logic[${k}].goto ${JSON.stringify(r.goto)} is not a question id (or "end").`);
      else if (j <= i) problems.push(`${at}.logic[${k}].goto must point to a later question (no loops).`);
    }
  });
  return { questions: qs, problems };
}

export function definitionProblems(d: SurveyDef): string[] {
  const p: string[] = [];
  if (d.kind === "embedded") {
    if (!d.selector) p.push("selector: an embedded survey needs the CSS selector of the element it goes into.");
    else {
      const bad = selectorProblem(d.selector);
      if (bad) p.push(`selector: ${bad}`);
    }
  }
  if (d.trigger.on === "scroll" && !d.trigger.pct) p.push("trigger.pct: a scroll trigger needs the % of the page (1-100).");
  return p;
}

// ---------------------------------------------------------------------------------- the public config

/** What the widget is served with (survey text is the owner's, shown with textContent only). */
export interface PublicSurvey {
  id: string;
  v: number;
  kind: SurveyKind;
  q: Question[];
  tg: { p?: string[]; xp?: string[]; d?: string[]; t?: Record<string, string>; id?: boolean; sr?: number };
  tr: { on: string; s?: number; pct?: number; sig?: string[] };
  fr: string;
  ap: { pos?: string; side?: string; theme?: string; accent?: string; str?: Record<string, string> };
  ls: string;
  gpc?: 1;
  sel?: string;
  el?: 1;
  test?: 1;
  /** the preview token test posts carry */
  pt?: string;
}

export function publicSurvey(
  id: string,
  version: number,
  d: SurveyDef,
  extra: { test?: boolean; pages?: string[]; pt?: string } = {},
): PublicSurvey {
  const t = d.targeting;
  return {
    id,
    v: version,
    kind: d.kind,
    q: d.questions,
    tg: {
      ...((extra.pages ?? t.pages)?.length ? { p: extra.pages ?? t.pages } : {}),
      ...(t.exclude_pages?.length ? { xp: t.exclude_pages } : {}),
      ...(t.devices?.length ? { d: t.devices } : {}),
      ...(t.tags && Object.keys(t.tags).length ? { t: t.tags } : {}),
      ...(t.identified !== undefined ? { id: t.identified } : {}),
      ...(t.sample_rate !== undefined && t.sample_rate < 1 ? { sr: t.sample_rate } : {}),
    },
    tr: {
      on: d.trigger.on,
      ...(d.trigger.seconds !== undefined ? { s: d.trigger.seconds } : {}),
      ...(d.trigger.pct ? { pct: d.trigger.pct } : {}),
      ...(d.trigger.signals?.length ? { sig: d.trigger.signals } : {}),
    },
    fr: d.frequency,
    ap: {
      ...(d.appearance.position ? { pos: d.appearance.position } : {}),
      ...(d.appearance.side ? { side: d.appearance.side } : {}),
      ...(d.appearance.theme ? { theme: d.appearance.theme } : {}),
      ...(d.appearance.accent ? { accent: d.appearance.accent } : {}),
      ...(d.appearance.strings ? { str: d.appearance.strings } : {}),
    },
    ls: d.link_session,
    ...(d.show_with_gpc ? { gpc: 1 as const } : {}),
    ...(d.kind === "embedded" && d.selector ? { sel: d.selector } : {}),
    ...(d.kind === "feedback" && d.allow_element ? { el: 1 as const } : {}),
    ...(extra.test ? { test: 1 as const } : {}),
    ...(extra.pt ? { pt: extra.pt } : {}),
  };
}

// ---------------------------------------------------------------------------------- answers

export type CleanAnswers = Record<string, string | number | string[]>;

/**
 * Answers as stored: only questions of this survey, values of the right type and range, text
 * cleaned, capped at `maxChars` and (scrub) emails, long numbers and tokens masked. With
 * `complete`, every required question on the respondent's path must be answered.
 */
export function validateAnswers(
  qs: readonly Question[],
  raw: unknown,
  opts: { maxChars: number; scrub: boolean; complete: boolean },
): { answers: CleanAnswers; answered: number } | { error: string; hint: string } {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid_answers", hint: "a must be an object {question_id: value}." };
  // no prototype, and only the answers' own keys: a question id like "constructor" reads nothing inherited
  const out: CleanAnswers = Object.create(null);
  const own = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
  const txt = (v: unknown) => {
    if (typeof v !== "string") return null;
    let s = cleanText(v.slice(0, opts.maxChars * 2), true)
      .trim()
      .slice(0, opts.maxChars);
    if (opts.scrub) s = scrubText(s, opts.maxChars);
    return s || null;
  };
  for (const q of qs) {
    const v = own(q.id) ? (raw as Record<string, unknown>)[q.id] : undefined;
    if (v === undefined || v === null || v === "") continue;
    const int = (min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
    let a: string | number | string[] | null = null;
    switch (q.type) {
      case "reaction":
        a = int(1, 5);
        break;
      case "nps":
        a = int(0, 10);
        break;
      case "rating":
        a = int(1, q.scale?.max ?? 5);
        break;
      case "short_text":
        a = txt(v);
        if (a) a = a.slice(0, Math.min(opts.maxChars, 200));
        break;
      case "long_text":
        a = txt(v);
        break;
      case "single_choice": {
        const s = typeof v === "string" ? v : null;
        a = s && q.choices?.includes(s) ? s : q.other ? txt(s) : null;
        break;
      }
      case "multi_choice": {
        if (!Array.isArray(v)) break;
        const picked = [...new Set(v.filter((x): x is string => typeof x === "string"))].slice(0, SURVEY_LIMITS.CHOICES);
        const kept = picked.map((x) => (q.choices?.includes(x) ? x : q.other ? txt(x) : null)).filter((x): x is string => !!x);
        a = kept.length ? kept : null;
        break;
      }
      case "statement":
        break;
    }
    if (a === null) return { error: "invalid_answer", hint: `The answer to ${q.id} (${q.type}) is not a valid value.` };
    out[q.id] = a;
  }
  if (opts.complete) {
    for (const id of pathOf(qs, out)) {
      const q = qs.find((x) => x.id === id)!;
      if (q.required && !isAnswered(out[id] as Answer)) return { error: "required_unanswered", hint: `Question ${id} is required.` };
    }
  }
  // a plain object again (Durable Object calls can't carry a prototype-less one); ids can't be __proto__
  return { answers: { ...out }, answered: Object.keys(out).length };
}

/** One line for the session transcript: `q1=3 (detractor), q2="..."` (answers are visitor-typed: untrusted). */
export function answerSummary(qs: readonly Question[], answers: CleanAnswers, max = 300): string {
  const parts: string[] = [];
  for (const q of qs) {
    const a = answers[q.id];
    if (a === undefined) continue;
    const v = typeof a === "number" ? String(a) : JSON.stringify(a);
    parts.push(`${q.id}=${v}${q.type === "nps" && typeof a === "number" ? ` (${npsGroup(a)})` : ""}`);
  }
  const s = parts.join(", ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "q1<=6", "q1>=9", "q1=Yes", "q1!=No": a survey_answer filter. */
export function parseAnswerFilter(s: string): { qid: string; op: "<=" | ">=" | "=" | "!="; value: string } | null {
  const m = /^([a-z0-9_]{1,20})(<=|>=|!=|=)(.{1,200})$/i.exec(s.trim());
  return m ? { qid: m[1]!, op: m[2] as "<=" | ">=" | "=" | "!=", value: m[3]! } : null;
}
