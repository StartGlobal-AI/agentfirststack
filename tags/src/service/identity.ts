import type { HashedUserData } from "../lib/pii";

/**
 * A visitor's stored identity (ContainerDO.visitors.data). Hashes only. Kept so a server
 * conversion reported later (a Stripe webhook a week on) still carries the original click ids,
 * fbp/fbc, first-touch UTM, IP and user agent.
 */
export interface VisitorData {
  click_ids: Record<string, { v: string; ts: number }>;
  fbp?: string;
  fbc?: string;
  ttp?: string;
  ga_client_id?: string;
  ga_session_id?: string;
  analytics_visitor_id?: string;
  first_touch?: Record<string, unknown>;
  last_touch?: Record<string, unknown>;
  user: HashedUserData;
  user_id?: string;
  ip?: string;
  user_agent?: string;
  geo?: { country?: string; region?: string; region_code?: string; city?: string; postal_code?: string };
  device?: Record<string, string | undefined>;
  consent?: Record<string, "granted" | "denied">;
  /**
   * Identities your backend tied to this visitor (a server event carrying this visitor_id plus a
   * user_id / email / phone). Only these feed the user_id/email/phone join; user ids and hashes a
   * browser posts to /collect (which anyone can) never do.
   */
  linked?: { user_id?: string; em?: string; ph?: string };
  visits: number;
  conversions: number;
}

export interface VisitorUpdate {
  click_ids?: Record<string, string>;
  fbp?: string;
  fbc?: string;
  ttp?: string;
  ga_client_id?: string;
  ga_session_id?: string;
  analytics_visitor_id?: string;
  first_touch?: Record<string, unknown>;
  last_touch?: Record<string, unknown>;
  user?: HashedUserData;
  user_id?: string;
  ip?: string;
  user_agent?: string;
  geo?: VisitorData["geo"];
  device?: VisitorData["device"];
  consent?: Record<string, "granted" | "denied">;
  /** Server-side only: identities the backend asserted for this visitor. */
  link?: { user_id?: string; em?: string; ph?: string };
  visit?: boolean;
  conversion?: boolean;
}

export const emptyVisitor = (): VisitorData => ({ click_ids: {}, user: {}, visits: 0, conversions: 0 });

const set = <T>(v: T | undefined | null | "", prev: T | undefined) => (v === undefined || v === null || v === "" ? prev : v);

/** Merge: newer click ids and identifiers win, first touch is kept, hashes accumulate. */
export function mergeVisitor(prev: VisitorData | null, u: VisitorUpdate, now = Date.now()): VisitorData {
  const v: VisitorData = prev ? { ...prev, click_ids: { ...prev.click_ids }, user: { ...prev.user } } : emptyVisitor();
  for (const [k, val] of Object.entries(u.click_ids ?? {})) {
    if (val && v.click_ids[k]?.v !== val) v.click_ids[k] = { v: val, ts: now };
  }
  v.fbp = set(u.fbp, v.fbp);
  v.fbc = set(u.fbc, v.fbc);
  v.ttp = set(u.ttp, v.ttp);
  v.ga_client_id = set(u.ga_client_id, v.ga_client_id);
  v.ga_session_id = set(u.ga_session_id, v.ga_session_id);
  v.analytics_visitor_id = set(u.analytics_visitor_id, v.analytics_visitor_id);
  if (!v.first_touch && u.first_touch && Object.keys(u.first_touch).length) v.first_touch = u.first_touch;
  if (u.last_touch && Object.keys(u.last_touch).length) v.last_touch = u.last_touch;
  for (const [k, val] of Object.entries(u.user ?? {})) if (val) (v.user as Record<string, string>)[k] = val as string;
  v.user_id = set(u.user_id, v.user_id);
  v.ip = set(u.ip, v.ip);
  v.user_agent = set(u.user_agent, v.user_agent);
  if (u.geo && u.geo.country) v.geo = u.geo;
  if (u.device && Object.keys(u.device).length) v.device = u.device;
  if (u.consent && Object.keys(u.consent).length) v.consent = { ...(v.consent ?? {}), ...u.consent };
  if (u.link) {
    const linked = { ...(v.linked ?? {}) };
    for (const k of ["user_id", "em", "ph"] as const) if (u.link[k]) linked[k] = u.link[k];
    if (Object.keys(linked).length) v.linked = linked;
  }
  if (u.visit) v.visits++;
  if (u.conversion) v.conversions++;
  return v;
}

/** Click ids older than this aren't sent (Google Ads accepts conversions up to 90 days after the click). */
export const CLICK_ID_MAX_AGE_MS = 90 * 86_400_000;

export function activeClickIds(v: VisitorData | null, now = Date.now()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, { v: val, ts }] of Object.entries(v?.click_ids ?? {})) if (now - ts <= CLICK_ID_MAX_AGE_MS) out[k] = val;
  return out;
}
