import type { ContainerConfig, Conversion } from "../config/schema";
import type { DispatchEvent, Item } from "../destinations/types";
import { CLICK_IDS } from "../lib/clickids";
import { hashUserData, type HashedUserData } from "../lib/pii";
import { sendToForEvent } from "./dispatch-plan";
import { activeClickIds, type VisitorData, type VisitorUpdate } from "./identity";
import type { CollectPayload, ServerEvent } from "./ingest-schema";

/** Server-side facts about the request, never taken from the client. */
export interface Enrichment {
  ip?: string;
  user_agent?: string;
  geo?: { country?: string; region?: string; region_code?: string; city?: string; postal_code?: string };
  device?: DispatchEvent["device"];
  origin_host?: string;
  received_at: number;
}

export interface CollectHit {
  payload: CollectPayload;
  enrich: Enrichment;
  /** Preview traffic: the draft config to use instead of the live one. */
  preview_config?: ContainerConfig;
}

const CLICK_ID_SET = new Set<string>(CLICK_IDS);

export function cleanClickIds(raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = CLICK_IDS.find((c) => c.toLowerCase() === k.toLowerCase());
    if (key && CLICK_ID_SET.has(key) && typeof v === "string" && /^[A-Za-z0-9._~\-]{4,500}$/.test(v)) out[key] = v;
  }
  return out;
}

export function findConversion(config: ContainerConfig | null | undefined, name: string | undefined): Conversion | undefined {
  if (!config || !name) return undefined;
  return (config.conversions ?? []).find((c) => c.name === name);
}

const consentOf = (c: Record<string, "granted" | "denied"> | undefined) => (c ?? {}) as DispatchEvent["consent"];

function items(raw: unknown): Item[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .slice(0, 100)
    .map((i) => {
      const out: Item = {};
      if (i.item_id != null || i.id != null) out.item_id = String(i.item_id ?? i.id).slice(0, 100);
      if (i.item_name != null || i.name != null) out.item_name = String(i.item_name ?? i.name).slice(0, 200);
      const price = Number(i.price);
      if (Number.isFinite(price)) out.price = price;
      const q = Number(i.quantity);
      if (Number.isFinite(q)) out.quantity = q;
      return out;
    });
}

/** Visitor update from a browser hit. */
export function visitorUpdateFromHit(hit: CollectHit): VisitorUpdate {
  const p = hit.payload;
  const e = hit.enrich;
  const click = cleanClickIds(p.click_ids);
  const touch: Record<string, unknown> = { ...(p.utm ?? {}) };
  if (Object.keys(click).length) Object.assign(touch, click);
  if (Object.keys(touch).length) {
    touch.landing_page = p.page_url;
    touch.referrer = p.referrer;
    touch.ts = e.received_at;
  }
  return {
    click_ids: click,
    fbp: p.fbp,
    fbc: p.fbc,
    ttp: p.ttp,
    ga_client_id: p.ga_client_id,
    ga_session_id: p.ga_session_id,
    analytics_visitor_id: p.analytics_visitor_id,
    first_touch: p.first_touch && Object.keys(p.first_touch).length ? p.first_touch : Object.keys(touch).length ? touch : undefined,
    last_touch: Object.keys(touch).length ? touch : undefined,
    user: p.user_data as HashedUserData | undefined,
    user_id: p.user_id,
    ip: e.ip,
    user_agent: e.user_agent,
    geo: e.geo,
    device: e.device as Record<string, string | undefined> | undefined,
    consent: p.consent,
    visit: p.type === "visit",
    conversion: p.type === "conversion",
  };
}

/** The dispatch event for a browser conversion, joined with the (already merged) visitor. */
export function browserDispatchEvent(
  hit: CollectHit,
  visitor: VisitorData | null,
  conversion: Conversion | undefined,
  eventId: string,
): DispatchEvent {
  const p = hit.payload;
  const e = hit.enrich;
  const now = e.received_at;
  const ts = typeof p.ts === "number" && Math.abs(now - p.ts) < 3_600_000 ? p.ts : now;
  return {
    event_id: eventId,
    name: p.name ?? conversion?.name ?? "event",
    ts,
    source: "browser",
    test: !!hit.preview_config,
    value: p.value,
    currency: p.currency,
    transaction_id: p.transaction_id,
    items: items(p.items),
    params: p.params,
    page_url: p.page_url,
    page_title: p.page_title,
    referrer: p.referrer,
    ip: e.ip,
    user_agent: e.user_agent,
    device: e.device,
    geo: e.geo,
    visitor_id: p.visitor_id,
    user_id: p.user_id ?? visitor?.user_id,
    ga_client_id: p.ga_client_id ?? visitor?.ga_client_id,
    ga_session_id: p.ga_session_id ?? visitor?.ga_session_id,
    analytics_visitor_id: p.analytics_visitor_id ?? visitor?.analytics_visitor_id,
    click_ids: { ...activeClickIds(visitor, now), ...cleanClickIds(p.click_ids) },
    fbp: p.fbp ?? visitor?.fbp,
    fbc: p.fbc ?? visitor?.fbc,
    ttp: p.ttp ?? visitor?.ttp,
    user: { ...(visitor?.user ?? {}), ...((p.user_data as HashedUserData) ?? {}) },
    consent: consentOf(p.consent ?? visitor?.consent),
    send_to: sendToForEvent(conversion),
    fired: p.fired,
    first_touch: visitor?.first_touch,
  };
}

export function parseTimestamp(t: number | string | undefined, now: number): number {
  if (t === undefined) return now;
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t; // seconds or ms
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : now;
}

/** Deterministic id for retried backend calls: same name + order id = same event. */
export function serverEventId(ev: ServerEvent, random: () => string): string {
  if (ev.event_id) return ev.event_id;
  if (ev.order_id) return `${ev.name}.${ev.order_id}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100);
  return `srv_${random()}`;
}

/** Hash whatever PII a backend sent. Plaintext never leaves this function. */
export function serverUserData(ev: ServerEvent, phoneCountryCode?: string): HashedUserData {
  return hashUserData(
    {
      email: ev.email_sha256 ?? ev.email,
      phone: ev.phone_sha256 ?? ev.phone,
      first_name: ev.first_name,
      last_name: ev.last_name,
      city: ev.city,
      state: ev.state,
      zip: ev.zip,
      country: ev.country,
      external_id: ev.user_id,
    },
    { phoneCountryCode },
  );
}

export function serverDispatchEvent(
  ev: ServerEvent,
  ctx: {
    eventId: string;
    visitor: VisitorData | null;
    visitorId?: string;
    user: HashedUserData;
    conversion?: Conversion;
    test: boolean;
    now: number;
  },
): DispatchEvent {
  const v = ctx.visitor;
  return {
    event_id: ctx.eventId,
    name: ev.name,
    ts: parseTimestamp(ev.timestamp, ctx.now),
    source: "server",
    test: ctx.test,
    value: ev.value,
    currency: ev.currency,
    transaction_id: ev.order_id,
    items: items(ev.items),
    params: ev.params,
    page_url: ev.page_url ?? (v?.last_touch?.landing_page as string | undefined) ?? (v?.first_touch?.landing_page as string | undefined),
    referrer: ev.referrer,
    ip: ev.ip ?? v?.ip,
    user_agent: ev.user_agent ?? v?.user_agent,
    device: v?.device as DispatchEvent["device"],
    geo: v?.geo,
    visitor_id: ctx.visitorId,
    user_id: ev.user_id ?? v?.user_id,
    ga_client_id: v?.ga_client_id,
    ga_session_id: v?.ga_session_id,
    analytics_visitor_id: v?.analytics_visitor_id,
    click_ids: { ...activeClickIds(v, ctx.now), ...cleanClickIds(ev.click_ids) },
    fbp: ev.fbp ?? v?.fbp,
    fbc: ev.fbc ?? v?.fbc,
    ttp: v?.ttp,
    user: { ...(v?.user ?? {}), ...ctx.user },
    consent: consentOf(ev.consent ?? v?.consent),
    send_to: sendToForEvent(ctx.conversion, ev.send_to),
    action_source: ev.action_source,
    first_touch: v?.first_touch,
  };
}

/** Short, non-sensitive description of what identity an event carries (for the event log). */
export function identitySummary(e: DispatchEvent) {
  return {
    visitor_id: e.visitor_id ?? null,
    user_id: e.user_id ? true : false,
    click_ids: Object.keys(e.click_ids),
    email_hash: !!e.user.em,
    phone_hash: !!e.user.ph,
    fbp: !!e.fbp,
    fbc: !!e.fbc,
    ga_client_id: !!e.ga_client_id,
    ip: !!e.ip,
    user_agent: !!e.user_agent,
    country: e.geo?.country ?? null,
  };
}
