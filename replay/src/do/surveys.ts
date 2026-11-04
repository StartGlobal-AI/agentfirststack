/**
 * Survey responses in the site's Durable Object (schema v3): one row per response, daily counters
 * per survey and per client network, and the question texts of each survey version a response
 * answered. Responses linked to a session (link_session) also become a line in its transcript and
 * are deleted with it (privacy requests, retention); a response's user_id (the session's, when
 * linked) lets delete_visitor_data find it after its session is gone.
 *
 * Every write is bounded: at most one row per response id, the site's, network's and test daily
 * caps, the survey's max_responses, and the account's and deployment's daily byte/derived budgets
 * (a response counts 1 derived row and its bytes, like a chunk's facts).
 */

import type { Budget, Totals } from "../lib/limits";
import type { CleanAnswers } from "../lib/survey-def";
import { type ResultRow, surveyResults } from "../lib/survey-results";
import type { Question } from "../lib/survey";
import { type Db, DAY, IN_JSON, num, type SqlValue, strOrNull, utcDay } from "./db";
import { overBudget, type UsageSnapshot } from "./engine";

export interface RespondRequest {
  now: number;
  account_id: string;
  survey_id: string;
  survey_name: string;
  version: number;
  questions: Question[];
  /** rsr_... (from the browser's random id: retries and the completing post update the same row) */
  id: string;
  session_id: string | null;
  answers: CleanAnswers;
  answered: number;
  completed: boolean;
  test: boolean;
  path: string | null;
  device: string | null;
  country: string | null;
  element: { selector: string; top_pct: number | null } | null;
  /** hashed client network */
  net: string;
  bytes: number;
  /** transcript line for a linked session */
  summary: string;
  limits: {
    site_daily: number | null;
    net_daily: number | null;
    test_daily: number | null;
    max_responses: number | null;
    derived_per_session: number;
    account?: Budget;
    platform?: Budget;
  };
  usage?: UsageSnapshot | null;
}

export type RespondResult =
  | { status: "stored"; id: string; new: boolean; completed_now: boolean; completed_total: number; session_linked: boolean; test: boolean }
  | { status: "duplicate"; id: string }
  | { status: "rejected"; reason: string };

const today = (db: Db, day: string) => {
  const r = db.all("SELECT COALESCE(SUM(responses), 0) AS n, COALESCE(SUM(test_responses), 0) AS t FROM survey_daily WHERE day = ?", [
    day,
  ])[0];
  return { responses: num(r?.n), test: num(r?.t) };
};

export function respond(db: Db, q: RespondRequest): RespondResult {
  return db.transaction(() => {
    const day = utcDay(q.now);
    const existing = db.all("SELECT survey_id, completed, session_id, test FROM survey_responses WHERE id = ?", [q.id])[0];
    if (existing) {
      if (String(existing.survey_id) !== q.survey_id) return { status: "rejected", reason: "response_id_taken" };
      if (!!num(existing.test) !== q.test) return { status: "rejected", reason: "response_id_taken" };
      if (num(existing.completed)) return { status: "duplicate", id: q.id };
    }
    const add: Totals = { sessions: 0, chunks: 0, bytes: q.bytes, derived: existing ? 0 : 1 };
    const over = overBudget(db, day, add, q.limits.account, q.limits.platform, q.usage);
    if (over) return { status: "rejected", reason: over };
    let session = q.session_id;
    if (!existing) {
      const t = today(db, day);
      if (q.test) {
        if (q.limits.test_daily !== null && t.test >= q.limits.test_daily) return { status: "rejected", reason: "test_daily_limit" };
      } else {
        if (q.limits.site_daily !== null && t.responses >= q.limits.site_daily)
          return { status: "rejected", reason: "daily_response_limit" };
        const n = num(db.all("SELECT responses FROM survey_net_daily WHERE day = ? AND net = ?", [day, q.net])[0]?.responses);
        if (q.limits.net_daily !== null && n >= q.limits.net_daily) return { status: "rejected", reason: "network_daily_limit" };
        if (q.limits.max_responses !== null) {
          const done = num(
            db.all("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ? AND completed = 1 AND test = 0", [q.survey_id])[0]?.n,
          );
          if (done >= q.limits.max_responses) return { status: "rejected", reason: "max_responses" };
        }
      }
      // A session answers a survey once.
      if (session && db.all("SELECT 1 FROM survey_responses WHERE survey_id = ? AND session_id = ? LIMIT 1", [q.survey_id, session]).length)
        return { status: "rejected", reason: "already_answered" };
      // Link only to a session this site recorded (an unrecorded tab's id means nothing here).
      if (session && !db.all("SELECT 1 FROM sessions WHERE id = ?", [session]).length) session = null;
    } else session = strOrNull(existing.session_id);
    const uid = session ? strOrNull(db.all("SELECT user_id FROM sessions WHERE id = ?", [session])[0]?.user_id) : null;
    db.run("INSERT OR IGNORE INTO survey_versions (survey_id, version, questions) VALUES (?, ?, ?)", [
      q.survey_id,
      q.version,
      JSON.stringify(q.questions.map((x) => ({ id: x.id, type: x.type, text: x.text }))),
    ]);
    const element = q.element ? JSON.stringify(q.element) : null;
    if (existing)
      db.run(
        "UPDATE survey_responses SET answers = ?, answered = ?, completed = ?, updated_at = ?, element = COALESCE(?, element), bytes = bytes + ? WHERE id = ?",
        [JSON.stringify(q.answers), q.answered, q.completed ? 1 : 0, q.now, element, q.bytes, q.id],
      );
    else
      db.run(
        `INSERT INTO survey_responses (id, survey_id, version, session_id, user_id, created_at, updated_at, path, device, country, answers, answered,
           completed, test, element, net, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          q.id,
          q.survey_id,
          q.version,
          session,
          uid,
          q.now,
          q.now,
          q.path,
          q.device,
          q.country,
          JSON.stringify(q.answers),
          q.answered,
          q.completed ? 1 : 0,
          q.test ? 1 : 0,
          element,
          q.net,
          q.bytes,
        ],
      );
    const col = q.test ? "test_responses" : "responses";
    db.run(
      `INSERT INTO survey_daily (day, survey_id, ${col}, completed) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, survey_id) DO UPDATE SET ${col} = ${col} + excluded.${col}, completed = completed + excluded.completed`,
      [day, q.survey_id, existing ? 0 : 1, q.completed && !q.test ? 1 : 0],
    );
    if (!existing && !q.test)
      db.run(
        "INSERT INTO survey_net_daily (day, net, responses, impressions) VALUES (?, ?, 1, 0) ON CONFLICT(day, net) DO UPDATE SET responses = responses + 1",
        [day, q.net],
      );
    // The site's daily counters: a response is one derived row plus its bytes (account/deployment budgets).
    db.run(
      `INSERT INTO daily (day, bytes, derived) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET bytes = bytes + excluded.bytes, derived = derived + excluded.derived`,
      [day, q.bytes, add.derived],
    );
    // The linked session's transcript gets one line when the response completes.
    if (session && q.completed) {
      const s = db.all("SELECT derived FROM sessions WHERE id = ?", [session])[0];
      if (s && num(s.derived) < q.limits.derived_per_session) {
        db.run(
          `INSERT INTO events (session_id, seq, ts, pv, kind, path, label, message, detail) VALUES (?, -1, ?, NULL, 'survey', ?, ?, ?, ?)`,
          [session, q.now, q.path, q.survey_name, q.summary, JSON.stringify({ survey_id: q.survey_id, response_id: q.id, test: q.test })],
        );
        db.run("UPDATE sessions SET derived = derived + 1 WHERE id = ?", [session]);
      }
    }
    const total = num(
      db.all("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ? AND completed = 1 AND test = 0", [q.survey_id])[0]?.n,
    );
    // the stored row decides whether this is a test response (a later post can't change it)
    const test = existing ? !!num(existing.test) : q.test;
    return {
      status: "stored",
      id: q.id,
      new: !existing,
      completed_now: q.completed,
      completed_total: total,
      session_linked: !!session,
      test,
    };
  });
}

/** A widget showed the survey (counted per survey and day; per network capped). */
export function impression(
  db: Db,
  q: { now: number; survey_id: string; test: boolean; net: string; net_daily: number | null; test_daily?: number | null },
) {
  const day = utcDay(q.now);
  if (q.test && q.test_daily !== null && q.test_daily !== undefined) {
    const n = num(db.all("SELECT COALESCE(SUM(test_impressions), 0) AS n FROM survey_daily WHERE day = ?", [day])[0]?.n);
    if (n >= q.test_daily) return { ok: false as const, reason: "test_daily_limit" };
  }
  if (!q.test && q.net_daily !== null) {
    const n = num(db.all("SELECT impressions FROM survey_net_daily WHERE day = ? AND net = ?", [day, q.net])[0]?.impressions);
    if (n >= q.net_daily) return { ok: false as const, reason: "network_daily_limit" };
  }
  const col = q.test ? "test_impressions" : "impressions";
  db.run(
    `INSERT INTO survey_daily (day, survey_id, ${col}) VALUES (?, ?, 1) ON CONFLICT(day, survey_id) DO UPDATE SET ${col} = ${col} + 1`,
    [day, q.survey_id],
  );
  if (!q.test)
    db.run(
      "INSERT INTO survey_net_daily (day, net, responses, impressions) VALUES (?, ?, 0, 1) ON CONFLICT(day, net) DO UPDATE SET impressions = impressions + 1",
      [day, q.net],
    );
  return { ok: true as const };
}

export function stats(db: Db, surveyId: string, now: number) {
  const d = db.all(
    `SELECT COALESCE(SUM(impressions), 0) AS imp, COALESCE(SUM(test_impressions), 0) AS timp FROM survey_daily WHERE survey_id = ?`,
    [surveyId],
  )[0];
  const r = db.all(
    `SELECT COUNT(*) AS started, COALESCE(SUM(completed), 0) AS completed, MAX(created_at) AS last FROM survey_responses
     WHERE survey_id = ? AND test = 0 AND answered > 0`,
    [surveyId],
  )[0];
  const t = db.all(
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM survey_responses WHERE survey_id = ? AND test = 1 AND created_at > ?`,
    [surveyId, now - DAY],
  )[0];
  const timp = num(
    db.all("SELECT COALESCE(SUM(test_impressions), 0) AS n FROM survey_daily WHERE survey_id = ? AND day >= ?", [
      surveyId,
      utcDay(now - DAY),
    ])[0]?.n,
  );
  const started = num(r?.started);
  const completed = num(r?.completed);
  return {
    impressions: num(d?.imp),
    started,
    completed,
    completion_rate: started ? Math.round((completed / started) * 1000) / 1000 : 0,
    last_response_at: r?.last == null ? null : num(r.last),
    test_last_24h: { impressions: timp, responses: num(t?.n), last_response_at: t?.last == null ? null : num(t.last) },
  };
}

export interface ResponsesQuery {
  survey_id: string;
  start: number;
  end: number;
  test?: boolean;
  completed?: boolean;
  question?: string;
  answer?: string;
  nps?: "promoter" | "passive" | "detractor";
  page?: string;
  device?: string;
  session_id?: string;
  /** the survey's nps question ids (for nps=) */
  nps_questions?: string[];
  limit: number;
  /** [created_at, id] of the last row of the previous page */
  cursor?: [number, string] | null;
}

function responsesWhere(q: Omit<ResponsesQuery, "limit" | "cursor">): { sql: string; args: SqlValue[] } {
  const w = ["survey_id = ?", "created_at >= ?", "created_at <= ?"];
  const a: SqlValue[] = [q.survey_id, q.start, q.end];
  if (q.test !== undefined) {
    w.push("test = ?");
    a.push(q.test ? 1 : 0);
  }
  if (q.completed !== undefined) {
    w.push("completed = ?");
    a.push(q.completed ? 1 : 0);
  }
  if (q.page) {
    w.push("path GLOB ?");
    a.push(q.page.replace(/[[?]/g, (c) => `[${c}]`));
  }
  if (q.device) {
    w.push("device = ?");
    a.push(q.device.toLowerCase());
  }
  if (q.session_id) {
    w.push("session_id = ?");
    a.push(q.session_id);
  }
  if (q.question && /^[a-z0-9_]{1,20}$/i.test(q.question)) {
    const path = `$.${q.question}`;
    if (q.answer !== undefined) {
      w.push("EXISTS (SELECT 1 FROM json_each(answers, ?) j WHERE CAST(j.value AS TEXT) = ?)");
      a.push(path, q.answer);
    } else {
      w.push("json_extract(answers, ?) IS NOT NULL");
      a.push(path);
    }
  }
  if (q.nps) {
    const range = q.nps === "promoter" ? [9, 10] : q.nps === "passive" ? [7, 8] : [0, 6];
    w.push(
      "EXISTS (SELECT 1 FROM json_each(answers) j WHERE j.key IN (SELECT value FROM json_each(?)) AND j.type = 'integer' AND j.value BETWEEN ? AND ?)",
    );
    a.push(JSON.stringify(q.nps_questions ?? []), range[0]!, range[1]!);
  }
  return { sql: w.join(" AND "), args: a };
}

export interface ResponseRowOut {
  id: string;
  survey_id: string;
  version: number;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  path: string | null;
  device: string | null;
  country: string | null;
  answers: CleanAnswers;
  answered: number;
  completed: boolean;
  test: boolean;
  element: { selector: string; top_pct: number | null } | null;
}

const rowOut = (r: Record<string, SqlValue>): ResponseRowOut => ({
  id: String(r.id),
  survey_id: String(r.survey_id),
  version: num(r.version),
  session_id: strOrNull(r.session_id),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at),
  path: strOrNull(r.path),
  device: strOrNull(r.device),
  country: strOrNull(r.country),
  answers: JSON.parse(String(r.answers)) as CleanAnswers,
  answered: num(r.answered),
  completed: !!num(r.completed),
  test: !!num(r.test),
  element: r.element ? (JSON.parse(String(r.element)) as ResponseRowOut["element"]) : null,
});

export function listResponses(db: Db, q: ResponsesQuery) {
  const w = responsesWhere(q);
  const args = w.args;
  const total = num(db.all(`SELECT COUNT(*) AS n FROM survey_responses WHERE ${w.sql}`, args)[0]?.n);
  let page = w.sql;
  const pargs = [...args];
  if (q.cursor) {
    page += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    pargs.push(q.cursor[0], q.cursor[0], q.cursor[1]);
  }
  const rows = db.all(`SELECT * FROM survey_responses WHERE ${page} ORDER BY created_at DESC, id DESC LIMIT ?`, [...pargs, q.limit + 1]);
  const list = rows.slice(0, q.limit).map(rowOut);
  const last = list[list.length - 1];
  const versions = new Map<number, { id: string; text: string }[]>();
  for (const v of new Set(list.map((r) => r.version)))
    versions.set(
      v,
      JSON.parse(
        String(db.all("SELECT questions FROM survey_versions WHERE survey_id = ? AND version = ?", [q.survey_id, v])[0]?.questions ?? "[]"),
      ),
    );
  return {
    total,
    responses: list,
    /** the question texts each version had (responses keep the wording they answered) */
    versions: Object.fromEntries(versions),
    next_cursor: rows.length > q.limit && last ? ([last.created_at, last.id] as [number, string]) : null,
  };
}

export function results(
  db: Db,
  q: { survey_id: string; questions: Question[]; start: number; end: number; test?: boolean; page?: string; device?: string },
) {
  const w = responsesWhere({ ...q, test: q.test ?? false });
  const rows: ResultRow[] = db
    .all(`SELECT id, session_id, answers, completed FROM survey_responses WHERE ${w.sql} ORDER BY created_at DESC LIMIT 5000`, w.args)
    .map((r) => ({
      id: String(r.id),
      session_id: strOrNull(r.session_id),
      answers: JSON.parse(String(r.answers)) as CleanAnswers,
      completed: !!num(r.completed),
    }));
  const col = q.test ? "test_impressions" : "impressions";
  const imp = num(
    db.all(`SELECT COALESCE(SUM(${col}), 0) AS n FROM survey_daily WHERE survey_id = ? AND day >= ? AND day <= ?`, [
      q.survey_id,
      utcDay(Math.max(0, q.start)),
      utcDay(Math.min(q.end, Date.now() + 366 * DAY)),
    ])[0]?.n,
  );
  return { responses_considered: rows.length, ...surveyResults(q.questions, rows, imp) };
}

export function deleteResponse(db: Db, surveyId: string, id: string): boolean {
  const found = db.all("SELECT session_id FROM survey_responses WHERE id = ? AND survey_id = ?", [id, surveyId])[0];
  if (!found) return false;
  db.transaction(() => {
    db.run("DELETE FROM survey_responses WHERE id = ?", [id]);
    if (found.session_id)
      db.run("DELETE FROM events WHERE session_id = ? AND kind = 'survey' AND json_extract(detail, '$.response_id') = ?", [
        String(found.session_id),
        id,
      ]);
  });
  return true;
}

/** A survey was deleted: its responses, counters and versions go too. */
export function deleteSurveyData(db: Db, surveyId: string): number {
  return db.transaction(() => {
    const n = num(db.all("SELECT COUNT(*) AS n FROM survey_responses WHERE survey_id = ?", [surveyId])[0]?.n);
    db.run(
      "DELETE FROM events WHERE kind = 'survey' AND json_extract(detail, '$.survey_id') = ? AND session_id IN (SELECT session_id FROM survey_responses WHERE survey_id = ? AND session_id IS NOT NULL)",
      [surveyId, surveyId],
    );
    for (const t of ["survey_responses", "survey_daily", "survey_versions"]) db.run(`DELETE FROM ${t} WHERE survey_id = ?`, [surveyId]);
    return n;
  });
}

/** delete_visitor_data: responses by the visitor's user id (also those whose session is gone). */
export function deleteVisitorResponses(db: Db, userIds: string[]): number {
  if (!userIds.length) return 0;
  const list = JSON.stringify(userIds);
  const n = num(db.all(`SELECT COUNT(*) AS n FROM survey_responses WHERE user_id IN ${IN_JSON}`, [list])[0]?.n);
  if (n) db.run(`DELETE FROM survey_responses WHERE user_id IN ${IN_JSON}`, [list]);
  return n;
}

export function visitorResponses(db: Db, sessionIds: string[], userIds: string[]): ResponseRowOut[] {
  return db
    .all(`SELECT * FROM survey_responses WHERE session_id IN ${IN_JSON} OR user_id IN ${IN_JSON} ORDER BY created_at DESC LIMIT 200`, [
      JSON.stringify(sessionIds),
      JSON.stringify(userIds),
    ])
    .map(rowOut);
}

/** Retention: responses older than the cutoff; old daily counters. */
export function surveyHousekeeping(db: Db, now: number, cutoff: number | null) {
  if (cutoff !== null)
    db.run("DELETE FROM survey_responses WHERE rowid IN (SELECT rowid FROM survey_responses WHERE created_at < ? LIMIT 5000)", [cutoff]);
  db.run("DELETE FROM survey_daily WHERE day < ?", [utcDay(now - 400 * DAY)]);
  db.run("DELETE FROM survey_net_daily WHERE day < ?", [utcDay(now - DAY)]);
}
