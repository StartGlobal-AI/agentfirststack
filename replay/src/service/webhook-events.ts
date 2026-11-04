import type { AuthContext } from "@afs/shared";
import type { NewError } from "../do/engine";
import type { Bindings } from "../env";
import { type CleanAnswers, redactEmails, type SurveyDef } from "../lib/survey-def";
import { UNTRUSTED_NOTICE } from "../lib/untrusted";
import type { Ctx, SiteRow } from "./context";
import { siteStub } from "./context";
import { siteSegments } from "./segments";
import { resolveFilters, sessionListItem } from "./sessions";
import type { SurveyRow } from "./surveys";
import { emitSiteEvent, hooksFor, segmentHookIds } from "./webhooks";

/**
 * Where webhook events come from. Each checks first whether any webhook wants the event (cached
 * per isolate), so a site without webhooks pays nothing. Recorded and visitor-typed content goes
 * under `untrusted` in the payload.
 */

const untrusted = (v: Record<string, unknown>) => ({ untrusted: { notice: UNTRUSTED_NOTICE, ...v } });

/** survey.response, or feedback.created for a feedback survey: a completed response. */
export async function onSurveyResponse(
  env: Bindings,
  site: SiteRow,
  survey: SurveyRow,
  r: {
    id: string;
    session_id: string | null;
    answers: CleanAnswers;
    test: boolean;
    path: string | null;
    element: { selector: string; top_pct: number | null } | null;
    created_at: number;
  },
): Promise<void> {
  const type = survey.kind === "feedback" ? "feedback.created" : "survey.response";
  await emitSiteEvent(env, site, type, {
    survey_id: survey.id,
    response_id: r.id,
    session_id: r.session_id,
    test: r.test,
    created_at: r.created_at,
    // email answers stay in the response (delivery logs keep payloads for 7 days): only "given" here
    ...untrusted({
      survey_name: survey.name,
      path: r.path,
      answers: redactEmails((JSON.parse(survey.definition) as SurveyDef).questions, r.answers),
      element: r.element,
    }),
    next_steps: r.session_id ? [`GET /v1/sites/${site.id}/sessions/${r.session_id}/transcript`] : [],
  });
}

/** error.new: an error group (JS or network) the site hadn't seen. */
export async function onNewErrors(env: Bindings, site: SiteRow, sessionId: string, errors: NewError[]): Promise<void> {
  if (!(await hooksFor(env, site, "error.new")).length) return;
  for (const e of errors)
    await emitSiteEvent(env, site, "error.new", {
      fingerprint: e.fingerprint,
      kind: e.kind,
      session_id: sessionId,
      first_seen: e.ts,
      ...untrusted({ message: e.message, path: e.path }),
      next_steps: [`GET /v1/sites/${site.id}/errors?kind=${e.kind === "network" ? "network" : "js"}&fingerprint=${e.fingerprint}`],
    });
}

/** segment.session: a page of the session ended; tell each subscribed segment it newly matches (once). */
export async function onSessionEnd(env: Bindings, site: SiteRow, sessionId: string): Promise<void> {
  const all = await segmentHookIds(env, site);
  if (!all.size) return;
  const segments = (await siteSegments(env.DB, site.id)).filter((s) => all.has(s.id));
  const ctx: Ctx = {
    env,
    accountId: site.account_id,
    auth: { accountId: site.account_id, keyId: "internal", scopes: ["read"] } as AuthContext,
    baseUrl: "",
    waitUntil: () => {},
  };
  for (const seg of segments) {
    let f: Awaited<ReturnType<typeof resolveFilters>>;
    try {
      f = await resolveFilters(ctx, site, seg.filters);
    } catch {
      continue; // a segment that no longer validates matches nothing
    }
    const hit = await siteStub(env, site.id).segmentHit(seg.id, { ...f, start: 0, end: Number.MAX_SAFE_INTEGER, session_ids: [sessionId] });
    if (!hit) continue;
    const item = sessionListItem(hit as Parameters<typeof sessionListItem>[0]);
    const { untrusted: u, ...facts } = item;
    await emitSiteEvent(
      env,
      site,
      "segment.session",
      {
        segment_id: seg.id,
        session: facts,
        ...untrusted({ segment_name: seg.name, ...u }),
        next_steps: [`GET /v1/sites/${site.id}/sessions/${sessionId}/transcript`],
      },
      { segmentId: seg.id },
    );
  }
}
