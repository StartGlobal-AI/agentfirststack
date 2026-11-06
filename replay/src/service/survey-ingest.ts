import { accountStanding, networkKey, sha256Hex } from "@afs/shared";
import SURVEY from "../../dist/survey.txt";
import { type Bindings, isDev } from "../env";
import { readCapped } from "../lib/body";
import { cleanPath } from "../lib/derive";
import { ingestCaps } from "../lib/limits";
import { cleanText } from "../lib/mask-rules";
import { SESSION_ID_RE, SITE_ID_RE } from "../lib/protocol";
import { answerSummary, SURVEY_LIMITS, validateAnswers } from "../lib/survey-def";
import { parseUserAgent } from "../lib/ua";
import { secureOriginHost, siteHostAllowed } from "../lib/url";
import { isVerified, jsonList, siteById, siteStub } from "./context";
import { allowed, geo, visitorIp } from "./ingest";
import { PROXY_KEY_HEADER, proxyTrust } from "./proxy";
import { cleanVisitorId, surveyScores, tagsEvent, tagsSignalsOf } from "../lib/tags";
import { tagsAvailable } from "./tags";
import { JS, safeJson } from "./scripts";
import { bumpSurveysRev, defOf, PREVIEW_TOKEN_RE, previewOk, surveyById, surveyCaps, widgetSurveys } from "./surveys";
import { onSurveyResponse } from "./webhook-events";

/**
 * The public survey routes, on the site's own pages:
 *   GET /sv/<site_id>.<rev>.js  the widget with the site's active surveys inlined (lazy, from the loader);
 *                               ?preview=rsv_... serves one survey of any status as a test (never cached)
 *   POST /f                     impressions and answers (text/plain JSON, no preflight)
 * Checked like chunk ingest: edge rate limits per network and per site + network, the site exists,
 * is enabled and verified, its account isn't suspended, an Origin on the site's hosts, sizes, a
 * strict body; answers are validated against the survey and scrubbed; the site's Durable Object
 * enforces the daily, per-network, test and max_responses caps and the account budgets.
 */

const js = (body: string, status: number, cache: string) =>
  new Response(body, { status, headers: { ...JS, "cache-control": cache, "x-robots-tag": "noindex" } });

export async function serveSurveyScript(env: Bindings, req: Request, siteId: string, base: string): Promise<Response> {
  const trust = await proxyTrust(env, req, siteId);
  if (!(await allowed(env.INGEST_IP_LIMITER, `l:${networkKey(visitorIp(req, env, trust))}`)))
    return js("/* afs-replay: too many requests */\n", 429, "no-store");
  if (!SITE_ID_RE.test(siteId)) return js("/* afs-replay: bad site id */\n", 404, "no-store");
  const site = await siteById(env, siteId);
  if (!site) return js(`/* afs-replay: unknown replay site ${siteId} */\n`, 404, "no-store");
  if ((await accountStanding(env, site.account_id)).suspended) return js("/* afs-replay: not available */\n", 403, "public, max-age=300");
  const u = new URL(req.url).searchParams;
  const p = u.get("preview");
  const pt = u.get("pt");
  const preview = p && /^rsv_[0-9a-z]{16}$/.test(p) && pt && PREVIEW_TOKEN_RE.test(pt) ? { id: p, token: pt } : null;
  // Unverified or disabled sites show no surveys (a draft can't be previewed either).
  const surveys = isVerified(site) && site.enabled ? await widgetSurveys(env, site, geo(req, isDev(env), env, trust).country, preview) : [];
  const tags =
    isVerified(site) && !!site.tags_container_id && tagsAvailable(env) && tagsSignalsOf(site.tags_signals).includes("survey_response");
  const cfg = { site: site.id, base, s: surveys, ...(tags ? { tg: 1 } : {}) };
  return js(
    `/*! afs-replay surveys ${site.id} */\n(function(){var __AFSV__=${safeJson(cfg)};\n${SURVEY}\n})();\n`,
    200,
    // country targeting is decided here: private, and a preview never caches
    preview ? "no-store" : "private, max-age=300",
  );
}

export interface SurveyIngestResponse {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string, hint: string): SurveyIngestResponse => ({ status, body: { ok: false, error, hint } });

const KEYS = new Set(["v", "s", "sv", "ver", "r", "sid", "a", "d", "p", "t", "el", "imp", "tv"]);

const HINTS: Record<string, [number, string]> = {
  daily_response_limit: [429, "This site received the most survey responses allowed per day here (MAX_RESPONSES_PER_SITE_PER_DAY)."],
  network_daily_limit: [429, "This network sent the most survey responses allowed per site and day."],
  test_daily_limit: [429, "This site used its daily quota of test responses (MAX_TEST_RESPONSES_PER_SITE_PER_DAY)."],
  max_responses: [403, "The survey reached its max_responses and is closed."],
  already_answered: [409, "This session already answered this survey."],
  response_id_taken: [409, "This response id belongs to another survey."],
  account_daily_limit: [429, "The account used its daily budget here."],
  platform_budget: [429, "The service is at its daily capacity."],
  unknown_site: [404, "This replay site was deleted."],
};

export async function submitSurvey(env: Bindings, req: Request, waitUntil: (p: Promise<unknown>) => void): Promise<SurveyIngestResponse> {
  // The site id (whose proxy key a path proxy sends) is in the body: without a key, a flood from one
  // network stops before any parsing; with one, the visitor's network is limited once it is known.
  const keyed = req.headers.has(PROXY_KEY_HEADER);
  if (!keyed && !(await allowed(env.INGEST_IP_LIMITER, `f:${networkKey(visitorIp(req, env))}`)))
    return fail(429, "rate_limited", "Too many survey requests from this network.");
  const { bytes, truncated } = await readCapped(req.body, SURVEY_LIMITS.BODY_BYTES);
  if (truncated) return fail(413, "body_too_large", `A survey post is at most ${SURVEY_LIMITS.BODY_BYTES} bytes.`);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return fail(400, "invalid_json", "The body is a JSON object (the survey widget sends it).");
  }
  if (!b || typeof b !== "object" || Array.isArray(b) || b.v !== 1)
    return fail(400, "invalid_body", "Reload the page to get the current widget.");
  const extra = Object.keys(b).find((k) => !KEYS.has(k));
  if (extra !== undefined) return fail(400, "invalid_body", `Unknown field ${JSON.stringify(extra.slice(0, 40))}.`);
  const siteId = typeof b.s === "string" ? b.s : "";
  if (!SITE_ID_RE.test(siteId)) return fail(400, "bad_site_id", "s must be a replay site id.");
  const trust = await proxyTrust(env, req, siteId);
  const net = networkKey(visitorIp(req, env, trust));
  if (keyed && !(await allowed(env.INGEST_IP_LIMITER, `f:${net}`)))
    return fail(429, "rate_limited", "Too many survey requests from this network.");
  const site = await siteById(env, siteId);
  if (!site) return fail(404, "unknown_site", "This replay site does not exist.");
  const standing = await accountStanding(env, site.account_id);
  if (standing.suspended) return fail(403, "account_suspended", "The account that owns this site is suspended.");
  if (!site.enabled) return fail(403, "disabled", "The site is disabled.");
  if (!isVerified(site)) return fail(403, "domain_not_verified", "Surveys need the site's domain verified (POST /v1/sites/:id/verify).");
  if (!(await allowed(env.INGEST_SITE_IP_LIMITER, `${site.id}:f:${net}`))) return fail(429, "rate_limited", "Too many survey requests.");
  const dev = isDev(env);
  const origin = req.headers.get("origin");
  // https pages only (http://localhost in local development)
  const host = secureOriginHost(origin, dev);
  if (!host || !siteHostAllowed(host, site.domain, site.allowed_hostnames ? jsonList(site.allowed_hostnames) : null, dev))
    return fail(
      403,
      "origin_not_allowed",
      `Survey posts are accepted from https pages on ${site.domain}, its subdomains and allowed_hostnames only.`,
    );
  const survey = typeof b.sv === "string" ? await surveyById(env, site.id, b.sv) : null;
  if (!survey) return fail(404, "unknown_survey", "This survey does not exist (deleted?).");
  const def = defOf(survey);
  // A test post carries the preview token test_survey minted (24 h): drafts and closed surveys take nothing else.
  if (b.t !== undefined && !(typeof b.t === "string" && previewOk(survey, b.t)))
    return fail(403, "preview_expired", "This preview link expired or was replaced; call test_survey for a new one.");
  const test = b.t !== undefined;
  const now = Date.now();
  if (!test && (survey.status !== "active" || (def.limits.ends_at ?? Number.POSITIVE_INFINITY) <= now))
    return fail(403, "survey_closed", "The survey isn't active any more.");
  const netHash = (await sha256Hex(`replay-net:${net}`)).slice(0, 16);
  const caps = surveyCaps(env, standing);
  const stub = siteStub(env, site.id);
  if (b.imp === 1) {
    const ib = ingestCaps(env, standing, true);
    const r = await stub.surveyImpression({
      now,
      account_id: site.account_id,
      survey_id: survey.id,
      test,
      net: netHash,
      net_daily: caps.impressions_net_daily,
      test_daily: caps.test_daily === null ? null : caps.test_daily * 5,
      account: ib.account,
      platform: ib.platform,
    });
    if (r.ok) return { status: 202, body: { ok: true } };
    const [st, hint] = HINTS[r.reason] ?? [429, "Impressions from this network are capped per day."];
    return fail(st, r.reason, r.reason === "network_daily_limit" ? "Impressions from this network are capped per day." : hint);
  }
  const r = typeof b.r === "string" && /^[0-9a-z]{16}$/.test(b.r) ? b.r : null;
  if (!r) return fail(400, "bad_response_id", "r is the response id the widget generates (16 base32 characters).");
  const complete = b.d === 1;
  const v = validateAnswers(def.questions, b.a, { maxChars: caps.answer_chars, scrub: def.scrub_pii, complete });
  if ("error" in v) return fail(400, v.error, v.hint);
  const el =
    def.allow_element && b.el && typeof b.el === "object" && typeof (b.el as { s?: unknown }).s === "string"
      ? {
          selector: cleanText(String((b.el as { s: string }).s).slice(0, 300)),
          top_pct:
            typeof (b.el as { top?: unknown }).top === "number"
              ? Math.max(0, Math.min(100, Math.round((b.el as { top: number }).top)))
              : null,
        }
      : null;
  const sid = def.link_session !== "never" && typeof b.sid === "string" && SESSION_ID_RE.test(b.sid) ? b.sid : null;
  const ic = ingestCaps(env, standing, true);
  // A completed answer with an NPS or rating score goes to the linked tags container (scores only, never text).
  const scores = complete && !test ? surveyScores(def.questions, v.answers) : null;
  const tags =
    scores && site.tags_container_id && tagsAvailable(env) && tagsSignalsOf(site.tags_signals).includes("survey_response")
      ? {
          container_id: site.tags_container_id,
          daily: ic.tags_daily,
          event: tagsEvent(
            {
              name: "survey_response" as const,
              key: `rp.rsr_${r}`,
              ts: now,
              path: cleanPath(b.p),
              params: { survey_id: survey.id, replay_session_id: sid, ...scores },
            },
            site.domain,
            cleanVisitorId(b.tv),
          ),
        }
      : null;
  const res = await stub.surveyRespond({
    tags,
    now,
    account_id: site.account_id,
    survey_id: survey.id,
    survey_name: survey.name,
    version: survey.version,
    questions: def.questions,
    id: `rsr_${r}`,
    session_id: sid,
    answers: v.answers,
    answered: v.answered,
    completed: complete,
    test,
    path: cleanPath(b.p),
    device: parseUserAgent(req.headers.get("user-agent")).device,
    country: geo(req, dev, env, trust).country,
    element: el,
    net: netHash,
    bytes: bytes.byteLength,
    summary: answerSummary(def.questions, v.answers),
    limits: {
      site_daily: caps.responses_daily,
      net_daily: caps.net_daily,
      test_daily: caps.test_daily,
      max_responses: def.limits.max_responses ?? null,
      derived_per_session: ic.derived_per_session,
      account: ic.account,
      platform: ic.platform,
    },
  });
  if (res.status === "duplicate") return { status: 200, body: { ok: true, duplicate: true, id: res.id } };
  if (res.status === "rejected") {
    const [st, hint] = HINTS[res.reason] ?? [403, "Not accepted."];
    return fail(st, res.reason, hint);
  }
  if (res.completed_now && !test && def.limits.max_responses && res.completed_total >= def.limits.max_responses)
    waitUntil(
      env.DB.prepare(
        "UPDATE surveys SET status = 'closed', closed_reason = 'max_responses', updated_at = ? WHERE id = ? AND status = 'active'",
      )
        .bind(now, survey.id)
        .run()
        .then(() => bumpSurveysRev(env, site.id))
        .catch((e) => console.error("replay survey close failed", e)),
    );
  if (res.completed_now)
    waitUntil(
      onSurveyResponse(env, site, survey, {
        id: res.id,
        session_id: res.session_linked ? sid : null,
        answers: v.answers,
        test: res.test,
        path: cleanPath(b.p),
        element: el,
        created_at: now,
      }).catch((e) => console.error("replay survey webhook failed", e)),
    );
  return { status: 202, body: { ok: true, id: res.id } };
}
