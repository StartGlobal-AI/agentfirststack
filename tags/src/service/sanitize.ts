import { CLICK_IDS, UTM_KEYS } from "../lib/clickids";
import { CONSENT_TYPES } from "../lib/consent";

/**
 * Bounds on what public ingest (/collect, which anyone can post to) and backend events may store.
 * Everything here is pure: the ContainerDO stores only the cleaned payload, so a stranger can't
 * fill a container's database with unbounded maps or long strings.
 */

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

/** One line of visible text: tags and control characters removed, whitespace collapsed, cut to `max`. */
export function sanitizeText(s: string, max = 200): string {
  const t = s
    .replace(/<[^>]*>/g, " ")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

const clip = (s: string, max: number) => s.replace(CONTROL, " ").slice(0, max);

/** Browser event params: at most this many, scalars only. GA4 takes 25 per event. */
export const MAX_BROWSER_PARAMS = 25;
export const MAX_BROWSER_PARAM_CHARS = 500;
/** Backend event params: more keys, small JSON values allowed (webhooks get them as sent). */
export const MAX_SERVER_PARAMS = 50;
export const MAX_SERVER_PARAM_JSON = 1000;
const PARAM_KEY = /^[A-Za-z0-9_.:-]{1,40}$/;

export function cleanParams(raw: Record<string, unknown> | undefined, source: "browser" | "server"): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const out: Record<string, unknown> = {};
  const max = source === "browser" ? MAX_BROWSER_PARAMS : MAX_SERVER_PARAMS;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= max) break;
    if (!PARAM_KEY.test(k)) continue;
    if (typeof v === "string") out[k] = clip(v, MAX_BROWSER_PARAM_CHARS);
    else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = v;
    else if (source === "server" && v !== null && typeof v === "object") {
      const json = JSON.stringify(v);
      if (json.length <= MAX_SERVER_PARAM_JSON) out[k] = JSON.parse(json);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Only the seven consent types, granted or denied. */
export function cleanConsent(raw: Record<string, string> | undefined): Record<string, "granted" | "denied"> | undefined {
  if (!raw) return undefined;
  const out: Record<string, "granted" | "denied"> = {};
  for (const t of CONSENT_TYPES) {
    const v = raw[t];
    if (v === "granted" || v === "denied") out[t] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** utm_* keys only. */
export function cleanUtm(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const k of UTM_KEYS) if (typeof raw[k] === "string" && raw[k]) out[k] = clip(raw[k]!, 300);
  return Object.keys(out).length ? out : undefined;
}

const TOUCH_TEXT: Record<string, number> = { landing_page: 2048, referrer: 2048, click_ids: 300 };
const CLICK_ID_KEYS = new Set<string>(CLICK_IDS);

/** First touch as the runtime records it: utm_*, landing_page, referrer, ts, click_ids (and the click id values the server adds). */
export function cleanTouch(raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "ts") {
      if (typeof v === "number" && Number.isFinite(v)) out.ts = v;
    } else if (typeof v !== "string" || !v) continue;
    else if ((UTM_KEYS as readonly string[]).includes(k)) out[k] = clip(v, 300);
    else if (TOUCH_TEXT[k]) out[k] = clip(v, TOUCH_TEXT[k]!);
    else if (CLICK_ID_KEYS.has(k) && /^[A-Za-z0-9._~-]{4,500}$/.test(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Click id keys out of a touch record (a join that must not carry click ids). */
export function withoutClickIds(touch: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!touch) return undefined;
  const out = Object.fromEntries(Object.entries(touch).filter(([k]) => !CLICK_ID_KEYS.has(k) && k !== "click_ids"));
  return Object.keys(out).length ? out : undefined;
}

/** Identifier-like values (fbp, fbc, _ttp, GA ids): an id charset or nothing. */
export function cleanId(v: string | undefined, max = 200): string | undefined {
  return typeof v === "string" && v.length <= max && /^[A-Za-z0-9._~:|=-]+$/.test(v) ? v : undefined;
}

export const MAX_USER_AGENT = 512;

/** Strings parsed out of the User-Agent header, bounded. */
export function cleanDevice<T extends Record<string, unknown> | undefined>(d: T): T {
  if (!d) return d;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" && v) out[k] = clip(v, 64);
  return out as T;
}

/**
 * A short, sanitized summary of an answer from a URL the account chose (webhook, analytics
 * base_url): the status is reported separately; this keeps at most 8 scalar top-level JSON fields
 * (strings cut to 80) or 200 characters of text. It never relays an arbitrary body, so a
 * destination can't be used to read pages through this service.
 */
export function summarizeResponse(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, unknown> = {};
    let omitted = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (Object.keys(out).length >= 8 || !PARAM_KEY.test(k)) {
        omitted++;
        continue;
      }
      if (typeof val === "string") out[k] = sanitizeText(val, 80);
      else if ((typeof val === "number" && Number.isFinite(val)) || typeof val === "boolean" || val === null) out[k] = val;
      else omitted++;
    }
    return omitted ? { ...out, _omitted_fields: omitted } : out;
  }
  return sanitizeText(typeof v === "string" ? v : JSON.stringify(v), 200);
}
