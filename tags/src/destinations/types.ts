import type { z } from "zod";
import type { ClickIdName } from "../lib/clickids";
import type { ConsentType, ConsentValue } from "../lib/consent";
import { MAX_RESPONSE_BYTES, readTextBounded } from "../lib/http";
import type { HashedUserData } from "../lib/pii";

/**
 * One event as delivered to a destination: the conversion (or server event) joined with the
 * stored visitor identity. Contains hashes only, never plaintext email/phone.
 */
export interface DispatchEvent {
  event_id: string;
  name: string;
  /** Unix ms when it happened. */
  ts: number;
  source: "browser" | "server";
  /** Preview / test traffic: connectors use the platform's test mode. */
  test?: boolean;
  value?: number;
  currency?: string;
  transaction_id?: string;
  items?: Item[];
  params?: Record<string, unknown>;
  page_url?: string;
  page_title?: string;
  referrer?: string;
  ip?: string;
  user_agent?: string;
  device?: {
    category?: string;
    browser?: string;
    browser_version?: string;
    os?: string;
    os_version?: string;
    model?: string;
    brand?: string;
    language?: string;
  };
  geo?: { country?: string; region?: string; region_code?: string; city?: string; postal_code?: string };
  visitor_id?: string;
  user_id?: string;
  ga_client_id?: string;
  ga_session_id?: string;
  analytics_visitor_id?: string;
  click_ids: Partial<Record<ClickIdName, string>>;
  fbp?: string;
  fbc?: string;
  ttp?: string;
  user: HashedUserData;
  consent: Partial<Record<ConsentType, ConsentValue>>;
  /** Per-platform mapping from the conversion definition (or the server event body). */
  send_to: {
    ga4?: { event_name: string; params?: Record<string, unknown> };
    google_ads?: { conversion_action_id?: string };
    meta?: { event_name: string; custom_data?: Record<string, unknown> };
    tiktok?: { event_name: string };
    analytics?: { event_name?: string };
  };
  /** Client tags that already fired this conversion in the browser (for dedupe rules). */
  fired?: string[];
  action_source?: string;
  first_touch?: Record<string, unknown>;
}

export interface Item {
  item_id?: string;
  item_name?: string;
  price?: number;
  quantity?: number;
  [k: string]: unknown;
}

export interface HttpRequestSpec {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: unknown;
  /** Form-encoded body instead of JSON. */
  form?: Record<string, string>;
}

export interface DeliveryResult {
  ok: boolean;
  /** Transient (network, 429, 5xx): the queue retries with backoff. */
  retryable: boolean;
  http_status?: number;
  /** The platform's answer (parsed JSON when possible), truncated. */
  response?: unknown;
  error?: string;
  /** What was sent, with secrets redacted. */
  request?: { url: string; body?: unknown };
}

export interface SendContext {
  test: boolean;
  fetch: typeof fetch;
  env: { DEV_MODE?: string; ANALYTICS_BASE_URL?: string; PUBLIC_BASE_URL?: string; AUTH_ISSUER?: string };
  /** Destination id + container id, for webhooks and token caching. */
  destinationId: string;
  containerId: string;
}

export interface Connector<C extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  label: string;
  api: string;
  credentials: z.ZodType<C>;
  /** Credential fields safe to show back (ids, not secrets). */
  publicFields: string[];
  /** Fields of `credentials` that identify the destination (for idempotent create). */
  naturalKey: (c: C) => string;
  /** Consent the event must carry, else it's skipped with status `skipped`. */
  requiredConsent: ConsentType[];
  /**
   * Platforms that don't dedupe server hits against their own browser tag by event_id (GA4,
   * analytics): when a browser conversion's own hit says this tag already fired it, skip that
   * hit's server copy. Never applied to backend (server-origin) events. The value is the client
   * tag type to look for in `fired`.
   */
  skipIfFiredBy?: string;
  /** true: only events with send_to[type] are delivered. false: every server event. */
  needsMapping: boolean;
  /**
   * Deliver only events that matched a conversion in the config (unless the destination's
   * settings.all_events is true). Used by webhooks, which point anywhere the account chooses.
   */
  matchedOnly?: boolean;
  /** Delivery attempts before a failure is final (default MAX_ATTEMPTS in dispatch.ts). */
  maxAttempts?: number;
  testMode: string;
  example: C;
  docs: string;
  /** Reason to skip this event (missing click id, ...), or null to send. */
  skipReason?(e: DispatchEvent): string | null;
  /**
   * Validate credentials beyond the schema (env-dependent rules). Throws. `origins` are the URLs
   * this deployment is reached on (PUBLIC_BASE_URL is added from env).
   */
  check?(c: C, env: SendContext["env"], origins?: string[]): void;
  send(e: DispatchEvent, c: C, ctx: SendContext): Promise<DeliveryResult>;
}

export const MAX_RESPONSE_CHARS = 4000;

/** Parse a destination's answer, reading at most MAX_RESPONSE_BYTES of it. */
export async function readResponse(res: Response): Promise<unknown> {
  const { text, truncated } = await readTextBounded(res, MAX_RESPONSE_BYTES);
  const clipped = text.length > MAX_RESPONSE_CHARS || truncated ? `${text.slice(0, MAX_RESPONSE_CHARS)}...(truncated)` : text;
  if (truncated) return clipped;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return clipped;
  }
}

export function redactUrl(url: string, secretParams: string[]): string {
  try {
    const u = new URL(url);
    for (const p of secretParams) if (u.searchParams.has(p)) u.searchParams.set(p, "REDACTED");
    return u.toString();
  } catch {
    return url;
  }
}

/** Execute a request spec; classify transient failures as retryable. */
export async function execute(
  spec: HttpRequestSpec,
  ctx: SendContext,
  redactParams: string[] = [],
): Promise<DeliveryResult & { json?: unknown }> {
  const headers = { ...spec.headers };
  let body: string | undefined;
  if (spec.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(spec.form).toString();
  } else if (spec.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(spec.body);
  }
  const request = { url: redactUrl(spec.url, redactParams), body: spec.body };
  try {
    // Platform APIs answer directly; a redirect is a failure, never followed.
    const res = await ctx.fetch(spec.url, { method: spec.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const response = await readResponse(res);
    return {
      ok: res.ok,
      retryable: res.status === 429 || res.status >= 500,
      http_status: res.status,
      response,
      json: response,
      request,
    };
  } catch (e) {
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e), request };
  }
}

export const isoSeconds = (ms: number) => Math.floor(ms / 1000);

/** Strip undefined/null/empty-string fields (platforms reject empty strings for some fields). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out[k] = v;
  }
  return out as T;
}
