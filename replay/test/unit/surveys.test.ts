import { describe, expect, it } from "vitest";
import { searchSessions, transcriptData } from "../../src/do/queries";
import { deleteVisitorResponses, impression, listResponses, type RespondRequest, respond, results, stats } from "../../src/do/surveys";
import { deleteSessions } from "../../src/do/engine";
import { csvCell, toCsv } from "../../src/lib/csv";
import { conditionHolds, nextIndex, pathOf, type Question } from "../../src/lib/survey";
import { answerSummary, normalizeQuestions, parseAnswerFilter, template, TEMPLATES, validateAnswers } from "../../src/lib/survey-def";
import { type ResultRow, surveyResults } from "../../src/lib/survey-results";
import { textThemes, tokens } from "../../src/lib/themes";
import { buildTimeline, entryLine } from "../../src/lib/transcript";
import { meta, page, snapshot, T0 } from "../fixtures/rrweb";
import { feed, NOW, sid } from "./engine-helpers";
import { memoryDb } from "./sqlite";

const NPS: Question[] = normalizeQuestions(template("nps") as Parameters<typeof normalizeQuestions>[0], 20).questions;
const LOGIC: Question[] = [
  { id: "q1", type: "nps", text: "?", required: true, logic: [{ if: { lte: 6 }, goto: "q2" }, { goto: "q3" }] },
  { id: "q2", type: "long_text", text: "What went wrong?", logic: [{ goto: "end" }] },
  { id: "q3", type: "multi_choice", text: "What do you like?", choices: ["Speed", "Price"], other: true },
];

describe("survey logic (shared with the widget)", () => {
  it("conditions, skip logic forward to a question or the end, and the respondent's path", () => {
    expect(conditionHolds({ lte: 6 }, 3)).toBe(true);
    expect(conditionHolds({ lte: 6 }, 9)).toBe(false);
    expect(conditionHolds({ equals: "Price" }, ["Speed", "Price"])).toBe(true);
    expect(conditionHolds({ in: ["a", "b"] }, "c")).toBe(false);
    expect(conditionHolds({ answered: false }, "")).toBe(true);
    expect(nextIndex(LOGIC, 0, 3)).toBe(1);
    expect(nextIndex(LOGIC, 0, 10)).toBe(2);
    expect(nextIndex(LOGIC, 1, "x")).toBe(-1);
    expect(nextIndex(LOGIC, 2, ["Speed"])).toBe(-1);
    expect(pathOf(LOGIC, { q1: 2 })).toEqual(["q1", "q2"]);
    expect(pathOf(LOGIC, { q1: 9 })).toEqual(["q1", "q3"]);
  });

  it("definitions: ids, duplicate ids, missing choices and backward gotos are refused with their path", () => {
    for (const t of TEMPLATES) expect(normalizeQuestions(template(t) as Parameters<typeof normalizeQuestions>[0], 20).problems).toEqual([]);
    const bad = normalizeQuestions(
      [
        { id: "a", type: "single_choice", text: "x" },
        { id: "a", type: "nps", text: "y", logic: [{ goto: "a" }] },
        { type: "rating", text: "z", logic: [{ goto: "nope" }] },
      ] as Parameters<typeof normalizeQuestions>[0],
      2,
    );
    expect(bad.problems.join(" ")).toMatch(/at most 2/);
    expect(bad.problems.join(" ")).toMatch(/questions\[0\]: single_choice needs choices/);
    expect(bad.problems.join(" ")).toMatch(/questions\[1\]\.id "a" is used twice/);
    expect(bad.problems.join(" ")).toMatch(/questions\[1\]\.logic\[0\]\.goto must point to a later question/);
    expect(bad.problems.join(" ")).toMatch(/questions\[2\]\.logic\[0\]\.goto "nope"/);
    expect(bad.questions[2]).toMatchObject({ id: "q3", scale: { max: 5 } });
  });

  it("answers: types and ranges checked, text cleaned, capped and scrubbed, required on the path only", () => {
    const opts = { maxChars: 50, scrub: true, complete: true };
    expect(validateAnswers(LOGIC, { q1: 11 }, opts)).toMatchObject({ error: "invalid_answer" });
    expect(validateAnswers(LOGIC, { q1: 4.5 }, opts)).toMatchObject({ error: "invalid_answer" });
    expect(validateAnswers(LOGIC, {}, opts)).toMatchObject({ error: "required_unanswered" });
    const ok = validateAnswers(LOGIC, { q1: 2, q2: `mail me at jane@x.test ‮${"y".repeat(80)}`, nope: 1 }, opts);
    expect("answers" in ok && ok.answers).toEqual({ q1: 2, q2: `mail me at [email] ${"y".repeat(27)}` });
    const multi = validateAnswers(LOGIC, { q1: 9, q3: ["Speed", "my own <b>thing</b>", 4] }, opts);
    expect("answers" in multi && multi.answers.q3).toEqual(["Speed", "my own <b>thing</b>"]);
    expect(validateAnswers(LOGIC, { q1: 9 }, { ...opts, complete: false })).toMatchObject({ answered: 1 });
    expect(answerSummary(LOGIC, { q1: 3, q2: "slow" })).toBe('q1=3 (detractor), q2="slow"');
    expect(parseAnswerFilter("q1<=6")).toEqual({ qid: "q1", op: "<=", value: "6" });
    expect(parseAnswerFilter("q2!=Price")).toEqual({ qid: "q2", op: "!=", value: "Price" });
    expect(parseAnswerFilter("<=6")).toBeNull();
  });

  it("results: NPS, distributions, top-two share, PMF, drop-off and deterministic text themes", () => {
    const rows: ResultRow[] = [
      { id: "r1", session_id: "s1", answers: { q1: 10, q2: "Checkout was fast and easy" }, completed: true },
      { id: "r2", session_id: null, answers: { q1: 3, q2: "The checkout button did nothing" }, completed: true },
      { id: "r3", session_id: "s3", answers: { q1: 0, q2: "checkout button broken again" }, completed: true },
      { id: "r4", session_id: null, answers: { q1: 8 }, completed: false },
      { id: "r5", session_id: null, answers: {}, completed: false },
    ];
    const r = surveyResults(NPS, rows, 10);
    expect(r.funnel).toEqual({ shown: 10, started: 4, completed: 3, start_rate: 0.4, completion_rate: 0.75 });
    expect(r.questions[0]).toMatchObject({ nps: -25, promoters: 1, passives: 1, detractors: 2, answered: 4 });
    const q2 = r.questions[1] as { text_themes: ReturnType<typeof textThemes>; shown: number; skipped: number };
    expect(q2).toMatchObject({ shown: 4, skipped: 1 });
    expect(q2.text_themes.themes.slice(0, 2)).toMatchObject([
      { theme: "checkout", responses: 3, example_session_ids: ["s1", "s3"] },
      { theme: "checkout button", responses: 2, example_session_ids: ["s3"] },
    ]);
    // "button" adds nothing to "checkout button" (same responses): not a theme of its own
    expect(q2.text_themes.themes.some((t) => t.theme === "button")).toBe(false);
    expect(surveyResults(NPS, rows, 10)).toEqual(r); // deterministic
    const csat = normalizeQuestions(template("csat") as Parameters<typeof normalizeQuestions>[0], 20).questions;
    const c = surveyResults(
      csat,
      [5, 4, 2, 1].map((n, i) => ({ id: `c${i}`, session_id: null, answers: { q1: n }, completed: true })),
      4,
    );
    expect(c.questions[0]).toMatchObject({ mean: 3, satisfied_share: 0.5 });
    const pmf = normalizeQuestions(template("pmf") as Parameters<typeof normalizeQuestions>[0], 20).questions;
    const p = surveyResults(pmf, [{ id: "p", session_id: null, answers: { q1: "Very disappointed" }, completed: true }], 1);
    expect(p.questions[0]).toMatchObject({ pmf_share: 1 });
    expect(tokens("The users' Pages were SLOW!!")).toEqual(["user", "slow"]);
  });

  it("CSV cells are quoted and never start a formula", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("-1+2")).toBe("'-1+2");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(["a", "b,c"])).toBe('"a; b,c"');
    expect(toCsv(["a"], [["x\ny"]])).toBe('a\r\n"x\ny"\r\n');
  });
});

const base = (over: Partial<RespondRequest> = {}): RespondRequest => ({
  now: NOW,
  account_id: "acct",
  survey_id: "rsv_0000000000000001",
  survey_name: "Checkout NPS",
  version: 1,
  questions: NPS,
  id: "rsr_0000000000000001",
  session_id: null,
  answers: { q1: 3 },
  answered: 1,
  completed: true,
  test: false,
  path: "/checkout",
  device: "desktop",
  country: "DE",
  element: null,
  net: "n1",
  bytes: 200,
  summary: "q1=3 (detractor)",
  limits: { site_daily: null, net_daily: null, test_daily: null, max_responses: null, derived_per_session: 1500 },
  ...over,
});

describe("survey responses in the site's Durable Object", () => {
  it("links to a recorded session (transcript line, survey filters), counts derived rows, and is deleted with it", () => {
    const db = memoryDb();
    const s = sid(1);
    feed(db, s, 0, [meta(T0), snapshot(T0 + 1), page(T0 + 5, 1, "/checkout")], { meta: { user_id: "u1" } });
    const before = db.all("SELECT derived FROM daily")[0]!.derived;
    expect(respond(db, base({ session_id: s }))).toMatchObject({ status: "stored", new: true, session_linked: true, completed_total: 1 });
    expect(Number(db.all("SELECT derived FROM daily")[0]!.derived)).toBe(Number(before) + 1);
    // an unrecorded tab's id is not kept
    expect(respond(db, base({ id: "rsr_0000000000000002", session_id: sid(99) }))).toMatchObject({ session_linked: false });
    const q = (f: object) => searchSessions(db, { start: 0, end: Number.MAX_SAFE_INTEGER, sort: "recent", limit: 5, ...f }).total;
    expect(q({ survey_id: "rsv_0000000000000001" })).toBe(1);
    expect(q({ survey_id: "rsv_0000000000000001", survey_answer: { qid: "q1", op: "<=", value: "6" } })).toBe(1);
    expect(q({ survey_id: "rsv_0000000000000001", survey_answer: { qid: "q1", op: ">=", value: "9" } })).toBe(0);
    expect(q({ survey_id: "rsv_0000000000000001", survey_answer: { qid: "q1", op: "!=", value: "3" } })).toBe(0);
    const t = transcriptData(db, s, { maxEvents: 50 })!;
    expect(buildTimeline(t.session, t.pages, t.events).map(entryLine).join("\n")).toContain(
      'survey "Checkout NPS" answered: q1=3 (detractor)',
    );
    expect(
      listResponses(db, {
        survey_id: "rsv_0000000000000001",
        start: 0,
        end: Number.MAX_SAFE_INTEGER,
        limit: 10,
        nps: "detractor",
        nps_questions: ["q1"],
      }).total,
    ).toBe(2);
    expect(
      listResponses(db, {
        survey_id: "rsv_0000000000000001",
        start: 0,
        end: Number.MAX_SAFE_INTEGER,
        limit: 10,
        nps: "promoter",
        nps_questions: ["q1"],
      }).total,
    ).toBe(0);
    deleteSessions(db, [s]);
    expect(db.all("SELECT id FROM survey_responses").map((r) => r.id)).toEqual(["rsr_0000000000000002"]);
  });

  it("caps: one response per session, partial then complete, duplicates, daily, network, test and max_responses", () => {
    const db = memoryDb();
    const s = sid(2);
    feed(db, s, 0, [meta(T0), page(T0 + 5, 1, "/")]);
    expect(respond(db, base({ session_id: s, completed: false }))).toMatchObject({ status: "stored", completed_now: false });
    expect(respond(db, base({ session_id: s, answers: { q1: 9, q2: "ok" } }))).toMatchObject({
      status: "stored",
      new: false,
      completed_total: 1,
    });
    expect(respond(db, base({ session_id: s }))).toEqual({ status: "duplicate", id: "rsr_0000000000000001" });
    expect(respond(db, base({ id: "rsr_0000000000000009", session_id: s }))).toEqual({ status: "rejected", reason: "already_answered" });
    expect(respond(db, base({ id: "rsr_0000000000000001", survey_id: "rsv_0000000000000002" }))).toEqual({
      status: "rejected",
      reason: "response_id_taken",
    });
    const lim = (l: Partial<RespondRequest["limits"]>) => ({ ...base().limits, ...l });
    expect(respond(db, base({ id: "rsr_000000000000000a", net: "n1", limits: lim({ net_daily: 1 }) }))).toEqual({
      status: "rejected",
      reason: "network_daily_limit",
    });
    expect(respond(db, base({ id: "rsr_000000000000000b", net: "n2", limits: lim({ site_daily: 1 }) }))).toEqual({
      status: "rejected",
      reason: "daily_response_limit",
    });
    expect(respond(db, base({ id: "rsr_000000000000000c", net: "n2", limits: lim({ max_responses: 1 }) }))).toEqual({
      status: "rejected",
      reason: "max_responses",
    });
    expect(respond(db, base({ id: "rsr_000000000000000d", test: true, limits: lim({ test_daily: 0 }) }))).toEqual({
      status: "rejected",
      reason: "test_daily_limit",
    });
    expect(
      respond(
        db,
        base({
          id: "rsr_000000000000000e",
          net: "n3",
          limits: lim({ account: { sessions: null, chunks: null, bytes: 100, derived: null } }),
        }),
      ),
    ).toEqual({
      status: "rejected",
      reason: "account_daily_limit",
    });
    expect(impression(db, { now: NOW, survey_id: "rsv_0000000000000001", test: false, net: "n9", net_daily: 1 })).toEqual({ ok: true });
    expect(impression(db, { now: NOW, survey_id: "rsv_0000000000000001", test: false, net: "n9", net_daily: 1 })).toMatchObject({
      ok: false,
    });
    impression(db, { now: NOW, survey_id: "rsv_0000000000000001", test: true, net: "n9", net_daily: 1 });
    expect(stats(db, "rsv_0000000000000001", NOW)).toMatchObject({
      impressions: 1,
      started: 1,
      completed: 1,
      test_last_24h: { impressions: 1 },
    });
    const res = results(db, { survey_id: "rsv_0000000000000001", questions: NPS, start: 0, end: Number.MAX_SAFE_INTEGER });
    expect(res).toMatchObject({ responses_considered: 1, funnel: { shown: 1, completed: 1 } });
  });

  it("delete_visitor_data finds responses by user id after their session is gone", () => {
    const db = memoryDb();
    const s = sid(3);
    feed(db, s, 0, [meta(T0), page(T0 + 5, 1, "/")], { meta: { user_id: "u9" } });
    respond(db, base({ session_id: s }));
    db.run("UPDATE survey_responses SET session_id = NULL");
    expect(deleteVisitorResponses(db, ["u9"])).toBe(1);
    expect(db.all("SELECT COUNT(*) AS n FROM survey_responses")[0]!.n).toBe(0);
  });
});
