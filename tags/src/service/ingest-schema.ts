import { z } from "zod";
import { sendToSchema } from "../config/schema";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex");

export const hashedUserDataSchema = z.object({
  em: hex64.optional(),
  em_ga4: hex64.optional(),
  em_gads: hex64.optional(),
  ph: hex64.optional(),
  ph_e164: hex64.optional(),
  fn: hex64.optional(),
  ln: hex64.optional(),
  ct: z.string().max(100).optional(),
  st: z.string().max(100).optional(),
  zp: z.string().max(20).optional(),
  country: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  external_id: z.string().max(200).optional(),
});

const consentRecord = z.record(z.string().max(40), z.enum(["granted", "denied"]));
const short = (n: number) => z.string().max(n);

/** One preview log entry (src/runtime/types.ts TraceEntry), bounded. */
export const traceEntrySchema = z.object({
  ts: z.number(),
  event: short(64),
  page: short(500).optional(),
  triggers: z.array(z.object({ id: short(64), matched: z.boolean(), reason: short(300).optional() })).max(100),
  tags: z
    .array(z.object({ id: short(64), type: short(40), status: short(20), reason: short(300).optional(), trigger: short(64).optional() }))
    .max(200),
  conversions: z
    .array(
      z.object({ name: short(64), status: short(20), reason: short(300).optional(), platforms: z.array(short(40)).max(20).optional() }),
    )
    .max(100),
});
export type TraceEntryPayload = z.infer<typeof traceEntrySchema>;

/** test_skipped: an ad or vendor pixel that would have fired, on test traffic (it doesn't run there). */
export const TAG_FIRE_STATUSES = ["fired", "blocked", "error", "skipped", "excluded", "test_skipped"] as const;

/** What the browser runtime POSTs to /collect (text/plain JSON, no preflight). */
export const collectSchema = z.object({
  container_id: z.string().regex(/^ctr_[a-z0-9]{8,32}$/),
  /** visit / conversion; debug = preview log entries; tags = settings.report_tag_fires counts. */
  type: z.enum(["visit", "conversion", "debug", "tags"]),
  entries: z.array(traceEntrySchema).max(50).optional(),
  fires: z
    .array(
      z.object({
        tag_id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/),
        status: z.enum(TAG_FIRE_STATUSES),
        n: z.number().int().min(1).max(10_000),
      }),
    )
    .max(200)
    .optional(),
  tcf: z.object({ gdpr_applies: z.boolean().optional(), tc_string: z.string().max(2000).optional() }).optional(),
  scid: z.string().max(200).optional(),
  rdt_uuid: z.string().max(200).optional(),
  env: z.string().max(100).optional(),
  event_id: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{6,100}$/)
    .optional(),
  // The runtime only sends conversion names from the config (letters, digits, _), so anything else
  // is forged; the charset also keeps free text out of the event log.
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "A conversion name from the config.")
    .optional(),
  ts: z.number().optional(),
  version: z.union([z.number(), z.string()]).optional(),
  visitor_id: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{6,64}$/)
    .optional(),
  new_visitor: z.boolean().optional(),
  page_url: z.string().max(2048).optional(),
  page_title: z.string().max(300).optional(),
  referrer: z.string().max(2048).optional(),
  click_ids: z.record(z.string().max(20), z.string().max(500)).optional(),
  fbp: z.string().max(200).optional(),
  fbc: z.string().max(600).optional(),
  ttp: z.string().max(200).optional(),
  ga_client_id: z.string().max(100).optional(),
  ga_session_id: z.string().max(40).optional(),
  analytics_visitor_id: z.string().max(100).optional(),
  utm: z.record(z.string().max(20), z.string().max(300)).optional(),
  first_touch: z.record(z.string().max(30), z.union([z.string().max(2048), z.number()])).optional(),
  user_data: hashedUserDataSchema.optional(),
  user_id: z.string().max(200).optional(),
  value: z.number().finite().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  transaction_id: z.string().max(200).optional(),
  items: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  params: z.record(z.string().max(40), z.unknown()).optional(),
  consent: consentRecord.optional(),
  fired: z
    .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
    .max(20)
    .optional(),
  first_party: z.boolean().optional(),
  cookie_domain: z.string().max(253).optional(),
  preview: z.string().max(100).optional(),
  /** Test traffic (?afsa_debug=1 for the tab, afst('test', true), preview): delivered in test mode, never stored as a visitor. */
  test: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});
export type CollectPayload = z.infer<typeof collectSchema>;

const ACTION_SOURCES = [
  "website",
  "app",
  "email",
  "phone_call",
  "chat",
  "physical_store",
  "system_generated",
  "business_messaging",
  "other",
] as const;

/** One server-side event from a backend (POST /v1/containers/:id/events). */
export const serverEventSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "Letters, digits, _ (max 40). Use the conversion name from the config, e.g. purchase."),
  event_id: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{6,100}$/)
    .optional()
    .describe(
      "Pass the browser's afst('get','event_id') so Meta/TikTok dedupe this against the pixel; default <name>.<order_id>, else random.",
    ),
  timestamp: z.union([z.number(), z.string()]).optional().describe("Unix ms or ISO 8601; default now."),
  visitor_id: z.string().max(64).optional().describe("The _afst_vid cookie / afst('get','visitor_id') from the browser."),
  user_id: z.string().max(200).optional(),
  email: z.string().max(320).optional().describe("Plaintext; hashed immediately, never stored."),
  phone: z.string().max(40).optional().describe("Plaintext; normalised to E.164 and hashed."),
  email_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  phone_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
  country: z.string().max(2).optional(),
  order_id: z
    .string()
    .max(200)
    .optional()
    .describe("Dedupes backend retries (same name + order_id). Never joins a browser event or visitor."),
  value: z.number().finite().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  items: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  params: z.record(z.string().max(40), z.unknown()).optional(),
  ip: z.string().max(64).optional(),
  user_agent: z.string().max(1000).optional(),
  page_url: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  click_ids: z.record(z.string().max(20), z.string().max(500)).optional().describe("e.g. { gclid } if your backend stored it."),
  fbc: z.string().max(600).optional(),
  fbp: z.string().max(200).optional(),
  consent: consentRecord
    .optional()
    .describe(
      "Default: the visitor's last known consent when joined by visitor_id, else granted. Never inherited through a user_id/email/phone join: pass it.",
    ),
  send_to: sendToSchema.optional().describe("Platform mapping when no conversion in the live config has this name."),
  action_source: z.enum(ACTION_SOURCES).optional().describe("Meta action_source; default website."),
  destinations: z.array(z.string()).max(20).optional().describe("Only deliver to these destination ids."),
});
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const serverEventsBody = z.strictObject({
  events: z.array(serverEventSchema).min(1).max(100),
  test: z.boolean().optional().describe("Deliver using each destination's test mode."),
});
