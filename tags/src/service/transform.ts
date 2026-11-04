import { z } from "zod";
import type { DispatchEvent } from "../destinations/types";
import { CONDITION_OPS, matchCondition, toComparable } from "../lib/conditions";

/**
 * Per-destination transformations (server-side GTM's "transformations"), applied by the queue
 * consumer right before a destination is sent to, and by test_destination (so its request shows
 * them). Pure.
 *  - settings.conditions: routing; every condition must match or the delivery is skipped (reason logged).
 *  - settings.params: allow / exclude custom params (and exclude standard fields), set params or
 *    value/currency (a literal, another field, or a lookup table), redact query strings.
 *  - settings.template (webhook only): the method, static headers and JSON body to send.
 */

/** Event fields a condition, a set rule or a lookup key can read. */
const FIELD =
  /^(value|currency|name|source|country|region|city|transaction_id|page_url|referrer|user_id|event_id|visitor_id|params\.[A-Za-z0-9_.:-]{1,40}|items\[\]\.[A-Za-z0-9_]{1,40})$/;
const field = z
  .string()
  .regex(
    FIELD,
    "An event field: value, currency, name, source, country, region, city, transaction_id, page_url, referrer, user_id, event_id, visitor_id, params.<key> (or items[].<key> for lookups).",
  );
const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
const paramKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,40}$/);

/** Standard event fields settings.params.exclude can remove (besides custom params). */
export const STRIPPABLE = [
  "page_url",
  "page_title",
  "referrer",
  "ip",
  "user_agent",
  "user_id",
  "items",
  "geo",
  "device",
  "user",
  "click_ids",
] as const;

export const lookupRef = z.strictObject({
  lookup: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/)
    .describe("A lookup table name (PUT /v1/containers/:id/lookups/:name)."),
  key: field.describe('The event field to look up, e.g. "params.sku", or "items[].item_id" to sum the items\' values (times quantity).'),
  default: scalar.optional(),
});

export const paramRules = z.strictObject({
  allow: z.array(paramKey).max(50).optional().describe("Only these custom params are sent."),
  exclude: z
    .array(z.string().max(40))
    .max(50)
    .optional()
    .describe(`Custom params to drop, and/or standard fields: ${STRIPPABLE.join(", ")} (user = all hashed PII).`),
  set: z
    .record(paramKey, z.union([scalar, z.strictObject({ var: field }), lookupRef]))
    .refine((o) => Object.keys(o).length <= 20, "At most 20.")
    .optional()
    .describe(
      'Set params: a literal, { "var": "<field>" }, or { "lookup", "key", "default"? }. The keys "value" and "currency" set the conversion value and currency.',
    ),
  redact_query: z.boolean().optional().describe("Send page_url and referrer without their query string and fragment."),
});
export type ParamRules = z.infer<typeof paramRules>;

export const routingCondition = z.strictObject({
  var: field,
  op: z.enum(CONDITION_OPS.filter((o) => !o.includes("css")) as [string, ...string[]]),
  value: scalar,
  ignore_case: z.boolean().optional(),
});
export type RoutingCondition = z.infer<typeof routingCondition>;

const HEADER_BLOCK =
  /^(authorization|cookie|set-cookie|host|content-length|content-type|transfer-encoding|connection|user-agent|x-signature.*|x-event-id|x-afs-.*|x-forwarded-.*|forwarded|proxy-.*|cf-.*)$/i;
export const webhookTemplate = z
  .strictObject({
    method: z.enum(["POST", "PUT", "PATCH"]).optional(),
    headers: z
      .record(
        z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
        z
          .string()
          .max(200)
          .regex(/^[^\r\n]*$/, "No line breaks."),
      )
      .refine((h) => Object.keys(h).length <= 10, "At most 10 headers.")
      .refine(
        (h) => !Object.keys(h).some((k) => HEADER_BLOCK.test(k)),
        "Auth, cookie, host, content-type, signature and forwarding headers can't be set.",
      )
      .optional()
      .describe("Static, non-secret headers (secrets belong in the signed credentials)."),
    body: z
      .unknown()
      .optional()
      .describe(
        "JSON; strings may use {{event.<path>}} (e.g. {{event.value}}, {{event.params.sku}}), {{container_id}}, {{destination_id}}, {{test}}. A string that is only a placeholder keeps the value's type.",
      ),
  })
  .refine((t) => t.body === undefined || JSON.stringify(t.body).length <= 8192, "The body template is at most 8 KB of JSON.");
export type WebhookTemplate = z.infer<typeof webhookTemplate>;

const get = (o: unknown, path: string): unknown => {
  let cur = o;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

export function eventField(e: DispatchEvent, f: string): unknown {
  if (f === "country") return e.geo?.country;
  if (f === "region") return e.geo?.region_code;
  if (f === "city") return e.geo?.city;
  if (f.startsWith("params.")) return e.params?.[f.slice(7)];
  if (f.startsWith("items[].")) return (e.items ?? []).map((i) => i[f.slice(8)]);
  return (e as unknown as Record<string, unknown>)[f];
}

/** Why the event fails the routing conditions, or null when it matches them all. */
export function routingProblem(e: DispatchEvent, conditions: RoutingCondition[] | undefined): string | null {
  for (const c of conditions ?? []) {
    const v = eventField(e, c.var);
    if (!matchCondition(v, c.op as never, c.value, c.ignore_case))
      return `routing condition: ${c.var} ${JSON.stringify(toComparable(v).slice(0, 60))} fails ${c.op} ${JSON.stringify(c.value)}`;
  }
  return null;
}

export type Lookups = Map<string, Record<string, unknown>>;

/** Lookup table names a destination's rules use (the consumer loads only these). */
export function lookupsUsed(rules: ParamRules | undefined): string[] {
  return [...new Set(Object.values(rules?.set ?? {}).flatMap((v) => (v && typeof v === "object" && "lookup" in v ? [v.lookup] : [])))];
}

function lookupValue(e: DispatchEvent, ref: z.infer<typeof lookupRef>, lookups: Lookups): unknown {
  const table = lookups.get(ref.lookup);
  if (!table) return ref.default;
  if (ref.key.startsWith("items[].")) {
    // Sum over items: the looked-up number times the item's quantity (1 when missing).
    let sum = 0;
    let any = false;
    for (const i of e.items ?? []) {
      const hit = table[toComparable(i[ref.key.slice(8)])];
      const n = typeof hit === "number" ? hit : Number(hit);
      if (hit === undefined || !Number.isFinite(n)) continue;
      const q = Number(i.quantity);
      sum += n * (Number.isFinite(q) && q > 0 ? q : 1);
      any = true;
    }
    return any ? Math.round(sum * 100) / 100 : ref.default;
  }
  const hit = table[toComparable(eventField(e, ref.key))];
  return hit === undefined ? ref.default : hit;
}

const stripQuery = (u: string | undefined) => {
  if (!u) return u;
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return u.replace(/[?#].*$/, "");
  }
};

export function applyParamRules(e: DispatchEvent, rules: ParamRules | undefined, lookups: Lookups = new Map()): DispatchEvent {
  if (!rules) return e;
  const out: DispatchEvent = { ...e, params: { ...(e.params ?? {}) } };
  if (rules.redact_query) {
    out.page_url = stripQuery(out.page_url);
    out.referrer = stripQuery(out.referrer);
  }
  let p = out.params!;
  if (rules.allow) p = Object.fromEntries(Object.entries(p).filter(([k]) => rules.allow!.includes(k)));
  for (const k of rules.exclude ?? []) {
    if ((STRIPPABLE as readonly string[]).includes(k)) {
      if (k === "user") out.user = {};
      else if (k === "click_ids") out.click_ids = {};
      else delete (out as unknown as Record<string, unknown>)[k];
    } else delete p[k];
  }
  for (const [k, rule] of Object.entries(rules.set ?? {})) {
    const v =
      rule && typeof rule === "object" ? ("var" in rule ? eventField(e, rule.var) : lookupValue(e, rule, lookups)) : (rule as unknown);
    if (v === undefined || v === null || (typeof v === "object" && !Array.isArray(v))) continue;
    if (k === "value") {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) out.value = n;
    } else if (k === "currency") {
      if (typeof v === "string" && /^[A-Z]{3}$/.test(v)) out.currency = v;
    } else p[k] = Array.isArray(v) ? v.slice(0, 100) : v;
  }
  out.params = p;
  return out;
}

/** Render a webhook body template: {{event.*}}, {{container_id}}, {{destination_id}}, {{test}}. */
export function renderTemplate(
  body: unknown,
  vars: { event: DispatchEvent; container_id: string; destination_id: string; test: boolean },
): unknown {
  const lookup = (path: string): unknown =>
    path.startsWith("event.") ? get(vars.event, path.slice(6)) : (vars as unknown as Record<string, unknown>)[path];
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return null;
    if (typeof v === "string") {
      const whole = /^\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}$/.exec(v);
      if (whole) return lookup(whole[1]!) ?? null;
      return v.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (_, n: string) => {
        const x = lookup(n);
        return x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x);
      });
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
    return v;
  };
  return walk(body, 0);
}
