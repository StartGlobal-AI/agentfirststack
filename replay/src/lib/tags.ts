/**
 * Replay signals as server events for a linked AgentFirstStack tags container
 * (POST https://tags.internal/v1/containers/:id/events, the route backends use), which then
 * routes them to GA4 and ad platforms by its own config. Pure: the DO queues what these build.
 *
 * Event shape (the tags app's serverEventSchema): name, event_id (deterministic, so a retried batch
 * is a duplicate there), timestamp (unix ms), page_url, params, send_to.ga4 (the container's GA4
 * destination gets it under the same name; a conversion of that name in its live config wins, and
 * is the only way to reach ad platforms), and either visitor_id (the tags
 * runtime's afst.visitorId() on the recorded page: tags then applies that visitor's own consent)
 * or, without one, an explicit consent with ad purposes denied (replay never asserts ad consent).
 * Never sent: ip, user agent, user ids, labels, typed values, survey free text.
 */

import type { Question } from "./survey";

export const TAGS_SIGNALS = ["rage_click", "dead_click", "js_error", "api_error", "survey_response"] as const;
export type TagsSignal = (typeof TAGS_SIGNALS)[number];

/** ctr_ + 8-32 lower-case letters and digits (the tags app's container ids). */
export const TAGS_CONTAINER_RE = /^ctr_[0-9a-z]{8,32}$/;

/** Without a tags visitor id: analytics measurement only; ad platforms get nothing personal. */
export const NO_AD_CONSENT = {
  analytics_storage: "granted",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;

/** A signal the DO took from a session (kept in the outbox until tags accepted it). */
export interface TagsItem {
  name: TagsSignal;
  /** unique per signal: the event_id tags dedupes on */
  key: string;
  ts: number;
  path: string | null;
  params: Record<string, string | number | null>;
}

export interface TagsServerEvent {
  name: string;
  event_id: string;
  timestamp: number;
  page_url: string;
  params: Record<string, string | number>;
  visitor_id?: string;
  consent?: Record<string, "granted" | "denied">;
  /** GA4 under the same name unless the container's live config has a conversion of that name (which wins) */
  send_to: { ga4: { event_name: string } };
}

/** the tags runtime's visitor ids (afst.visitorId()) */
const VISITOR_RE = /^[A-Za-z0-9_.-]{6,64}$/;
export const cleanVisitorId = (v: unknown): string | null => (typeof v === "string" && VISITOR_RE.test(v) ? v : null);

/** Param values tags (and GA4: 100 characters) accept; empty values are left out. */
function cleanParams(p: Record<string, string | number | null>): Record<string, string | number> {
  const out: Record<string, string | number> = { source: "afs_replay" };
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === "") continue;
    out[k.slice(0, 40)] = typeof v === "number" ? v : v.slice(0, 100);
  }
  return out;
}

/** The server event for one item; `host` = the replay site's domain (paths are recorded without it). */
export function tagsEvent(i: TagsItem, host: string, visitorId: string | null): TagsServerEvent {
  const path = i.path && i.path.startsWith("/") ? i.path : "/";
  return {
    name: i.name,
    event_id: i.key.slice(0, 100),
    timestamp: i.ts,
    page_url: `https://${host}${path}`.slice(0, 2048),
    params: cleanParams(i.params),
    ...(visitorId ? { visitor_id: visitorId } : { consent: { ...NO_AD_CONSENT } }),
    send_to: { ga4: { event_name: i.name } },
  };
}

/** The signals a site sends (tags_signals; NULL = all). */
export function tagsSignalsOf(raw: string | null | undefined): TagsSignal[] {
  if (!raw) return [...TAGS_SIGNALS];
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) {
      const list = v.filter((x): x is TagsSignal => (TAGS_SIGNALS as readonly string[]).includes(x as string));
      if (list.length) return list;
    }
  } catch {
    /* all */
  }
  return [...TAGS_SIGNALS];
}

/**
 * survey_response params from a completed response: the first NPS answer (nps_score 0-10 and
 * nps_group promoter | passive | detractor) and the first rating answer (rating_score, rating_max;
 * a 5-point rating is CSAT). null when the response has neither: only scores are forwarded.
 */
export function surveyScores(
  questions: Pick<Question, "id" | "type" | "scale">[],
  answers: Record<string, unknown>,
): Record<string, string | number> | null {
  const out: Record<string, string | number> = {};
  for (const q of questions) {
    const a = answers[q.id];
    const n = typeof a === "number" ? a : typeof a === "string" && /^\d{1,2}$/.test(a) ? Number(a) : Number.NaN;
    if (!Number.isInteger(n)) continue;
    if (q.type === "nps" && out.nps_score === undefined && n >= 0 && n <= 10) {
      out.nps_score = n;
      out.nps_group = n >= 9 ? "promoter" : n >= 7 ? "passive" : "detractor";
    }
    const max = q.scale?.max ?? 5;
    if (q.type === "rating" && out.rating_score === undefined && n >= 1 && n <= max) {
      out.rating_score = n;
      out.rating_max = max;
    }
  }
  return Object.keys(out).length ? out : null;
}
