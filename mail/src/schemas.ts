import { z } from "zod";
import { MAX_TTL_DAYS } from "./service/inboxes";
import { MAX_TIMEOUT_S } from "./service/wait";

/**
 * Input shapes shared by REST routes and MCP tools, so the two surfaces cannot drift.
 * REST wraps them in z.object(); MCP passes the raw shape.
 */

const addressList = z.union([z.string().min(3).max(320), z.array(z.string().min(3).max(320)).max(50)]);

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
};

export const updateInboxShape = {
  display_name: z.string().max(200).nullable().optional(),
  ttl_days: z.number().positive().max(MAX_TTL_DAYS).nullable().optional().describe("New lifetime from now; null keeps the inbox forever."),
};

export const waitShape = {
  from: z.string().max(320).optional().describe('Substring of the sender address or name, e.g. "facebookmail.com" or "GitHub".'),
  subject: z.string().max(500).optional().describe("Substring of the subject."),
  contains: z.string().max(500).optional().describe("Substring of the subject or body."),
  after: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "Only mail received after this (unix ms, unix seconds or ISO date). Default: now minus 60 s, so mail that arrived just before the call counts. 0 = any.",
    ),
  timeout: z.coerce.number().min(0).max(MAX_TIMEOUT_S).optional().describe(`Seconds to block (default 30, max ${MAX_TIMEOUT_S}).`),
};

export const listMessagesShape = {
  unread: z.boolean().optional(),
  q: z.string().max(500).optional().describe("Full-text search (subject, sender, body)."),
  from: z.string().max(320).optional(),
  direction: z.enum(["in", "out"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  before: z.union([z.string(), z.number()]).optional().describe("Pagination cursor: next_before from the previous page."),
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
};

export const replyShape = {
  text: z.string().max(5_000_000).optional(),
  html: z.string().max(10_000_000).optional(),
  reply_all: z.boolean().optional().describe("Also reply to the other To/Cc recipients."),
  attachments: z.array(attachmentShape).max(32).optional(),
  headers: z.record(z.string(), z.string()).optional(),
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
};

export const updateDomainShape = {
  catch_all_inbox_id: z
    .string()
    .nullable()
    .optional()
    .describe("Inbox on this domain for unknown addresses; null = reject unknown addresses."),
  auto_configure: z.boolean().optional().describe("Operator only (x-admin-token header)."),
  force: z.boolean().optional().describe("Operator only (x-admin-token header)."),
};

export const createWebhookShape = {
  url: z.string().min(8).max(2000).describe("https:// endpoint that accepts POST (http://localhost allowed for development)."),
  events: z
    .array(z.enum(["message.received"]))
    .optional()
    .describe('Default ["message.received"].'),
  inbox_id: z.string().optional().describe("Only this inbox; omit for every inbox of the account."),
};

export const boolish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");
