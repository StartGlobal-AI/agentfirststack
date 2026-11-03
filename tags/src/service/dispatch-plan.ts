import type { Conversion, SendTo } from "../config/schema";
import { getConnector } from "../destinations";
import type { DispatchEvent } from "../destinations/types";
import { isGranted } from "../lib/consent";

export interface DestinationInfo {
  id: string;
  type: string;
  enabled: boolean;
  settings: { conversions?: string[]; all_events?: boolean };
  /** Circuit breaker (see dispatch.ts): open until this unix ms after too many consecutive failures. */
  circuit_open_until?: number | null;
  consecutive_failures?: number;
}

export interface PlanOptions {
  /** Only these destination ids (a backend event's `destinations`). */
  only?: string[];
  /** The event matched a conversion in the config (false: a backend event with an unknown name). */
  matched?: boolean;
  now?: number;
}

export interface PlannedTarget {
  destination_id: string;
  type: string;
  status: "queued" | "skipped";
  reason?: string;
}

/** The per-platform mapping a server event carries, from the conversion definition. */
export function sendToForEvent(conversion: Conversion | undefined, override?: SendTo): DispatchEvent["send_to"] {
  const s = conversion?.send_to ?? override ?? {};
  const out: DispatchEvent["send_to"] = {};
  if (s.ga4) out.ga4 = { event_name: s.ga4.event_name, params: s.ga4.params };
  if (s.meta) out.meta = { event_name: s.meta.event_name, custom_data: s.meta.custom_data };
  if (s.tiktok) out.tiktok = { event_name: s.tiktok.event_name };
  if (s.google_ads) out.google_ads = { conversion_action_id: s.google_ads.conversion_action_id };
  if (s.analytics) out.analytics = { event_name: s.analytics.event_name };
  return out;
}

/**
 * Decide which destinations get an event and why the others don't. Pure; the decision only uses
 * server-side config (the browser can't route an event to a destination by itself).
 */
export function planDispatch(e: DispatchEvent, destinations: DestinationInfo[], opts: PlanOptions = {}): PlannedTarget[] {
  const out: PlannedTarget[] = [];
  const { only, matched = true, now = Date.now() } = opts;
  for (const d of destinations) {
    if (!d.enabled) continue;
    if (only && only.length && !only.includes(d.id)) continue;
    if (d.settings.conversions && d.settings.conversions.length && !d.settings.conversions.includes(e.name)) continue;
    const connector = getConnector(d.type);
    if (!connector) continue;
    if (connector.needsMapping && !(e.send_to as Record<string, unknown>)[d.type]) continue;
    // Webhooks get conversions the config defines; every event only when the destination opts in.
    if (connector.matchedOnly && !matched && !d.settings.all_events) continue;
    const skip = (reason: string) => out.push({ destination_id: d.id, type: d.type, status: "skipped", reason });
    if (d.circuit_open_until && d.circuit_open_until > now) {
      skip(circuitReason(d.circuit_open_until, d.consecutive_failures));
      continue;
    }
    // `fired` is what this same browser hit says its own tags did, so it may only suppress this
    // hit's own server copy. Backend events never carry it and are never skipped by it: an
    // unauthenticated /collect hit can't block a real server conversion.
    if (connector.skipIfFiredBy && e.source === "browser" && e.fired?.includes(connector.skipIfFiredBy)) {
      skip(`the browser ${connector.skipIfFiredBy} tag already sent this conversion; ${d.type} doesn't dedupe server hits against it`);
      continue;
    }
    if (!isGranted(e.consent, connector.requiredConsent)) {
      skip(`consent: ${connector.requiredConsent.filter((t) => e.consent[t] === "denied").join(", ")} denied`);
      continue;
    }
    const why = connector.skipReason?.(e);
    if (why) {
      skip(why);
      continue;
    }
    out.push({ destination_id: d.id, type: d.type, status: "queued" });
  }
  return out;
}

export function circuitReason(until: number, failures?: number) {
  return `circuit open until ${new Date(until).toISOString()} after ${failures ?? "repeated"} consecutive failed attempts; fix the destination and run its test (a passing test closes the circuit)`;
}

export type EventStatus = "logged" | "pending" | "delivered" | "partial" | "failed" | "skipped";

export interface TargetResult {
  type: string;
  status: "queued" | "retrying" | "delivered" | "failed" | "skipped";
  reason?: string;
  attempts?: number;
  http_status?: number;
  response?: unknown;
  error?: string;
  request?: unknown;
  updated_at: number;
}

export function aggregateStatus(results: Record<string, TargetResult>): EventStatus {
  const vals = Object.values(results);
  if (!vals.length) return "logged";
  if (vals.some((r) => r.status === "queued" || r.status === "retrying")) return "pending";
  const delivered = vals.filter((r) => r.status === "delivered").length;
  const failed = vals.filter((r) => r.status === "failed").length;
  if (failed && delivered) return "partial";
  if (failed) return "failed";
  if (delivered) return "delivered";
  return "skipped";
}
