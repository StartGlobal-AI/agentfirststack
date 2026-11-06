import { z } from "zod";
import { FORWARD_MODES } from "./lib/forwarding";
import { MAX_TTL_DAYS } from "./service/inboxes";
import { MAX_TIMEOUT_S } from "./service/wait";

/**
 * Input shapes shared by REST routes and MCP tools, so the two surfaces cannot drift.
 * REST wraps them in z.object(); MCP passes the raw shape.
 */

const addressList = z.union([z.string().min(3).max(320), z.array(z.string().min(3).max(320)).max(50)]);

/** An inbox's forward setting (src/lib/forwarding.ts); every field optional, so updates merge. */
export const forwardSettingShape = z.object({
  mode: z
    .enum(FORWARD_MODES)
    .optional()
    .describe('"each": every email as it arrives; "digest": one email a day at digest_hour; "off": none (default).'),
  digest_hour: z.number().int().min(0).max(23).optional().describe("Hour of the daily digest, 0-23, in timezone (default 8)."),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('IANA time zone of digest_hour and the times in digests, e.g. "Europe/Berlin" (default "UTC").'),
});

export const createInboxShape = {
  username: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Local part, e.g. \"acme-signups\". Omit for a random one. a-z 0-9 . _ - ; no '+'."),
  domain: z.string().max(253).optional().describe("Omit for the shared MAIL_DOMAIN, or a custom domain added with add_domain."),
  display_name: z
    .string()
    .max(200)
    .optional()
    .describe("Name shown on mail sent from this inbox (control characters such as line breaks are removed)."),
  ttl_days: z.number().positive().max(MAX_TTL_DAYS).optional().describe("Delete the inbox and its mail after this many days."),
  forward: forwardSettingShape
    .optional()
    .describe(
      "Forward this inbox's mail to the project's members (the people who claimed it): each email as it arrives, or one daily digest. Ask the owner which. Default off. Applied when the inbox is created (an existing inbox keeps its setting: use update_inbox).",
    ),
};

export const updateInboxShape = {
  display_name: z.string().max(200).nullable().optional(),
  ttl_days: z.number().positive().max(MAX_TTL_DAYS).nullable().optional().describe("New lifetime from now; null keeps the inbox forever."),
  forward: forwardSettingShape
    .optional()
    .describe('Partial update, merged: {"mode":"digest"} keeps digest_hour and timezone. {"mode":"off"} stops forwarding.'),
};

export const waitShape = {
  from: z
    .string()
    .max(320)
    .optional()
    .describe(
      'Loose filter: substring of the sender address or name, e.g. "facebookmail.com" or "GitHub" (a display name is easy to fake; get_latest_code matches the sender domain exactly).',
    ),
  subject: z.string().max(500).optional().describe("Substring of the subject."),
  contains: z.string().max(500).optional().describe("Substring of the subject or body."),
  after: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Only mail received after this (unix ms, unix seconds or ISO date). Default: now minus 60 s, so mail that arrived just before the call counts. 0 = any.",
    ),
  timeout: z.coerce.number().min(0).max(MAX_TIMEOUT_S).optional().describe(`Seconds to block (default 30, max ${MAX_TIMEOUT_S}).`),
  tag: z
    .string()
    .max(64)
    .optional()
    .describe('Only mail sent to this plus-address tag: "github" matches mail to <username>+github@<domain>. Exact, case-insensitive.'),
};

export const latestCodeShape = {
  ...waitShape,
  from: z
    .string()
    .max(320)
    .optional()
    .describe(
      'Strongly recommended: the domain of the site you are signing up to, e.g. "github.com" (mail from its subdomains matches too; "github.com.evil.example" and display names never do), or its full sender address. Not a bare word. Without it any sender\'s code counts: the result then carries a warning, and two or more sender domains in the window are refused (ambiguous_sender).',
    ),
  allow_unauthenticated: z
    .boolean()
    .optional()
    .describe(
      'Default false: only mail whose sender domain is authenticated (auth_verdict "pass") counts, so a forged sender cannot feed you a code. true also accepts unauthenticated mail.',
    ),
};

/** Filters shared by list_messages and search_messages (REST: the same names as query parameters). */
export const messageFilterShape = {
  unread: z.boolean().optional(),
  from: z.string().max(320).optional().describe("Substring of the sender address or name."),
  to: z.string().max(320).optional().describe("Substring of a To/Cc address or name (or the envelope recipient)."),
  subject: z.string().max(500).optional().describe("Substring of the subject."),
  direction: z.enum(["in", "out"]).optional(),
  tag: z.string().max(64).optional().describe("Plus-address tag, exact (me+github@ -> github)."),
  has: z
    .string()
    .max(40)
    .optional()
    .describe('Comma-separated, all must hold: "code" (an extracted code), "link" (an action link), "attachments".'),
  auth: z
    .enum(["pass", "fail", "unknown"])
    .optional()
    .describe('Sender authentication verdict; "pass" = the From domain is authenticated.'),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .describe("desc (default, newest first; page with before=next_before) or asc (page with after=next_after)."),
  after: z.union([z.string(), z.number()]).optional().describe("Only messages after this: next_after cursor, unix ms or ISO date."),
  labels: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Comma-separated labels, all must be on the message: custom ones, or system labels unread, read, received, sent, automated, unauthenticated, has-code, has-link, has-attachments.",
    ),
  status: z.enum(["sent", "failed", "scheduled"]).optional().describe("Sent mail by status; scheduled = waiting to go out."),
  limit: z.number().int().min(1).max(200).optional(),
  before: z.union([z.string(), z.number()]).optional().describe("Only messages before this: next_before cursor, unix ms or ISO date."),
};

export const listMessagesShape = {
  ...messageFilterShape,
  q: z.string().max(500).optional().describe("Full-text search (subject, sender, body)."),
};

export const idempotencyKeyShape = {
  idempotency_key: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Same as the Idempotency-Key header: retrying with the same key and the same arguments within 24 h returns the first result instead of sending again. 1-256 of A-Z a-z 0-9 . _ ~ -",
    ),
};

export const attachmentShape = z.object({
  filename: z.string().min(1).max(255).describe("Control characters such as line breaks are removed."),
  content: z.string().describe("base64"),
  content_type: z.string().max(255).optional().describe("MIME type, e.g. application/pdf (default application/octet-stream)."),
  disposition: z.enum(["attachment", "inline"]).optional(),
  content_id: z.string().max(255).optional(),
});

export const sendShape = {
  to: addressList.optional().describe("Recipient address or list."),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().min(1).max(998),
  text: z.string().max(5_000_000).optional(),
  html: z.string().max(10_000_000).optional(),
  reply_to: z.string().max(320).optional(),
  attachments: z.array(attachmentShape).max(32).optional(),
  headers: z.record(z.string(), z.string()).optional().describe("Custom X-* headers only."),
  send_at: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'Send later: ISO 8601 time or unix ms, at most 7 days ahead (status "scheduled"; delete the message to cancel). Omit to send now.',
    ),
};

export const replyShape = {
  text: z.string().max(5_000_000).optional(),
  html: z.string().max(10_000_000).optional(),
  reply_all: z.boolean().optional().describe("Also reply to the other To/Cc recipients."),
  attachments: z.array(attachmentShape).max(32).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  send_at: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'Send later: ISO 8601 time or unix ms, at most 7 days ahead (status "scheduled"; delete the message to cancel). Omit to send now.',
    ),
};

export const forwardShape = {
  to: addressList.optional().describe("Recipient address or list."),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  text: z.string().max(5_000_000).optional().describe("Your note, above the forwarded message."),
  html: z.string().max(10_000_000).optional(),
  include_attachments: z.boolean().optional().describe("Default true: the original's attachments go along (max 32, 25 MiB in all)."),
  headers: z.record(z.string(), z.string()).optional().describe("Custom X-* headers only."),
  send_at: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'Send later: ISO 8601 time or unix ms, at most 7 days ahead (status "scheduled"; delete the message to cancel). Omit to send now.',
    ),
};

export const addDomainShape = {
  domain: z.string().min(3).max(253).describe("e.g. example.com or mail.example.com"),
  auto_configure: z
    .boolean()
    .optional()
    .describe(
      "Operator only (x-admin-token header): use the operator's Cloudflare API token to enable Email Routing, point the catch-all at this Worker and onboard Email Sending. Zone must be in the operator's account.",
    ),
  force: z
    .boolean()
    .optional()
    .describe("Operator only (x-admin-token header). With auto_configure: overwrite an existing catch-all rule that routes elsewhere."),
  catch_all_inbox_id: z.string().optional().describe("Inbox (on this domain) that receives mail for unknown addresses."),
  receiving: z
    .boolean()
    .optional()
    .describe(
      "Default true. false = send-only: keep the domain's existing MX (Google Workspace, Microsoft 365, ...); no receiving records, status verified once ownership and sending pass.",
    ),
};

export const updateDomainShape = {
  receiving: z.boolean().optional().describe("false = send-only: the domain keeps its own MX, sends from here, receives nothing here."),
  catch_all_inbox_id: z
    .string()
    .nullable()
    .optional()
    .describe("Inbox on this domain for unknown addresses; null = reject unknown addresses."),
  auto_configure: z.boolean().optional().describe("Operator only (x-admin-token header)."),
  force: z.boolean().optional().describe("Operator only (x-admin-token header)."),
};

const webhookEvents = z.enum([
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.failed",
  "message.forwarded",
  "domain.verified",
]);

const webhookHeaders = z
  .record(z.string(), z.string().max(1024))
  .describe(
    "Up to 5 custom headers sent with every delivery (e.g. Authorization). Sealed at rest and never shown again (only their names).",
  );

export const createWebhookShape = {
  url: z.string().min(8).max(2000).describe("https:// endpoint that accepts POST (http://localhost allowed for development)."),
  events: z.array(webhookEvents).optional().describe('Default ["message.received"].'),
  inbox_id: z.string().optional().describe("Only this inbox; omit for every inbox of the account."),
  inbox_ids: z.array(z.string()).max(50).optional().describe("Only these inboxes (instead of inbox_id)."),
  headers: webhookHeaders.optional(),
};

export const updateWebhookShape = {
  url: z.string().min(8).max(2000).optional(),
  events: z.array(webhookEvents).optional(),
  inbox_id: z.string().nullable().optional(),
  inbox_ids: z.array(z.string()).max(50).nullable().optional().describe("[] or null = every inbox."),
  enabled: z.boolean().optional(),
  headers: webhookHeaders.nullable().optional().describe("Replaces all custom headers; null or {} removes them."),
};

const labelList = z.array(z.string().max(64)).max(20);

export const updateMessageShape = {
  read: z.boolean().optional(),
  add_labels: labelList
    .optional()
    .describe("Custom labels to add: 1-64 of a-z 0-9 : _ - (e.g. handled, needs-human); at most 20 per message."),
  remove_labels: labelList.optional(),
};

export const batchMessagesShape = {
  ids: z.array(z.string()).min(1).max(100),
  ...updateMessageShape,
  delete: z.boolean().optional().describe("Delete the messages instead (alone, without read or labels)."),
};

export const listEntryShape = {
  entry: z.string().min(3).max(320).describe('An address ("noreply@github.com") or a domain ("github.com"; its subdomains match too).'),
  inbox_id: z.string().optional().describe("Only this inbox; omit for every inbox of the account."),
  reason: z.string().max(200).optional(),
};

export const eventsShape = {
  after: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'next_after of the previous call; "latest" = from now on (returns at once with the cursor); omit = everything kept (7 days).',
    ),
  types: z.string().max(300).optional().describe("Comma-separated event types, e.g. message.received,message.bounced."),
  inbox_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  timeout: z.coerce
    .number()
    .min(0)
    .max(MAX_TIMEOUT_S)
    .optional()
    .describe(`Seconds to block when nothing is new (default 0, max ${MAX_TIMEOUT_S}).`),
};

export const boolish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");
