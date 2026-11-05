import { hmacSha256Hex, newId, timingSafeEqual } from "@afs/shared";
import { type Bindings, DAY } from "./env";

/**
 * Emails the platform sends to people (never to agents, never to addresses an agent typed): the
 * signed-in person's own Google address, about their projects. What we send is in
 * email-messages.ts; this is how it goes out.
 *
 *   - Sender: NOTIFY_EMAIL_FROM ("AgentFirstStack <notifications@example.com>", an address on a
 *     domain onboarded for Cloudflare Email Sending) through the EMAIL binding. Without either,
 *     nothing is queued or sent.
 *   - Outbox: every email is a row in email_outbox first, keyed by dedupe_key (one per event and
 *     person), so a retried request or a repeated cron run never sends it twice. It is sent at
 *     once (or by the next hourly run, for bulk), and retried after 15 minutes and 2 hours if
 *     sending failed. Rows are deleted after 30 days, and when the person deletes their account.
 *   - Categories: "account" (claims, members, connected apps, deletion, suspension) always goes
 *     out; "updates" (new setup items) respects users.email_updates and "alerts" (a site stopped
 *     sending data, a project is close to a fair-use limit) users.email_alerts. Both carry a
 *     one-click unsubscribe (List-Unsubscribe, RFC 8058) signed for that person and category.
 *   - At most MAX_EMAILS_PER_PERSON_PER_DAY (default 20) to one address a day; beyond that the
 *     email is recorded as skipped.
 */

export type EmailCategory = "account" | "updates" | "alerts";
/** The categories a person can turn off, and the users column that does. */
export type OptionalCategory = Exclude<EmailCategory, "account">;
export const OPT_OUT_COLUMN: Record<OptionalCategory, "email_updates" | "email_alerts"> = {
  updates: "email_updates",
  alerts: "email_alerts",
};

export interface EmailContent {
  subject: string;
  /** The heading; the subject when unset. */
  title?: string;
  /** Plain-text paragraphs (escaped for HTML). */
  body: string[];
  /** The one thing to do next. */
  action?: { label: string; url: string };
  /** A prompt for the person's agent, shown as a quote. */
  ask?: string;
  /** The prompt before the button (when the body ends by introducing it). Default: after. */
  askFirst?: boolean;
  /** Paragraphs after the button. */
  after?: string[];
}

export interface OutgoingEmail {
  kind: string;
  category: EmailCategory;
  dedupeKey: string;
  to: { userId: string | null; email: string };
  accountId?: string | null;
  content: EmailContent;
}

export const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = [15 * 60_000, 2 * 60 * 60_000];
const DEFAULT_DAILY_CAP = 20;
export const OUTBOX_RETENTION_DAYS = 30;

export const emailEnabled = (env: Bindings) => !!env.EMAIL && !!env.NOTIFY_EMAIL_FROM;

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** "Name <addr>" or "addr" as the binding's sender. */
export function senderOf(raw: string): { email: string; name: string } | string | null {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(raw);
  const email = (m ? m[2] : raw.trim()) ?? "";
  if (!EMAIL_RE.test(email)) return null;
  const name = m?.[1]?.trim();
  return name ? { email, name } : email;
}

const oneLine = (s: string, max = 200) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

// ---------- unsubscribe links ----------

async function unsubscribeSig(env: Bindings, userId: string, category: OptionalCategory): Promise<string | null> {
  if (!env.INTERNAL_TOKEN) return null;
  return hmacSha256Hex(env.INTERNAL_TOKEN, `afs-email-${category}-off:${userId}`);
}

/** The signed link that turns off one category of emails for one person, or null without a secret. */
export async function unsubscribeUrl(
  env: Bindings,
  base: string,
  userId: string,
  category: OptionalCategory = "updates",
): Promise<string | null> {
  const sig = await unsubscribeSig(env, userId, category);
  // Links without c= (the first ones sent) are for updates.
  return sig ? `${base}/email/unsubscribe?u=${encodeURIComponent(userId)}&s=${sig}${category === "updates" ? "" : `&c=${category}`}` : null;
}

export async function validUnsubscribe(
  env: Bindings,
  userId: string,
  sig: string,
  category: OptionalCategory = "updates",
): Promise<boolean> {
  const want = await unsubscribeSig(env, userId, category);
  return !!want && /^usr_[0-9a-z]{1,64}$/.test(userId) && timingSafeEqual(sig, want);
}

/** The c= of an unsubscribe link (none = updates); null when it names no category. */
export function optionalCategory(raw: string | undefined): OptionalCategory | null {
  if (!raw) return "updates";
  return raw === "updates" || raw === "alerts" ? raw : null;
}

// ---------- rendering ----------

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

/** The email as text and HTML: one column, one button, the footer for its category. */
export function renderEmail(content: EmailContent, footer: string[]): Rendered {
  const subject = oneLine(content.subject);
  const title = oneLine(content.title ?? content.subject);
  const actionText = content.action ? [`${content.action.label}: ${content.action.url}`, ""] : [];
  const askText = content.ask ? [...(content.askFirst ? [] : ["Ask your agent:"]), `"${content.ask}"`, ""] : [];
  const text = [
    title,
    "",
    ...content.body.flatMap((p) => [p, ""]),
    ...(content.askFirst ? [...askText, ...actionText] : [...actionText, ...askText]),
    ...(content.after ?? []).flatMap((p) => [p, ""]),
    "--",
    ...footer,
  ].join("\n");
  const p = (s: string) => `<p style="margin:0 0 14px;font:400 15px/1.6 ${FONT};color:#2b3446;">${esc(s)}</p>`;
  const actionHtml = content.action
    ? `<p style="margin:22px 0 22px;"><a href="${esc(content.action.url)}" style="display:inline-block;background:#0f1626;color:#ffffff;text-decoration:none;font:600 15px/1 ${FONT};padding:13px 20px;border-radius:8px;">${esc(content.action.label)}</a></p>`
    : "";
  const askHtml = content.ask
    ? `${content.askFirst ? "" : `<p style="margin:0 0 6px;font:600 13px/1.4 ${FONT};color:#5b6475;">Ask your agent</p>`}<p style="margin:0 0 16px;padding:12px 14px;background:#f4f5f7;border-radius:8px;font:400 14px/1.55 ${FONT};color:#0f1626;">&ldquo;${esc(content.ask)}&rdquo;</p>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(oneLine(content.body[0] ?? "", 140))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:32px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e6eb;border-radius:12px;">
<tr><td style="padding:26px 30px 6px;font:700 15px/1.4 ${FONT};color:#0f1626;letter-spacing:-0.01em;"><span style="color:#ff6a2b;">&#9646;</span><span style="color:#f5b82e;">&#9646;</span><span style="color:#3b7bf6;">&#9646;</span>&nbsp;AgentFirstStack</td></tr>
<tr><td style="padding:10px 30px 4px;">
<h1 style="margin:0 0 14px;font:700 21px/1.3 ${FONT};color:#0f1626;letter-spacing:-0.015em;">${esc(title)}</h1>
${content.body.map(p).join("\n")}
${content.askFirst ? `${askHtml}\n${actionHtml}` : `${actionHtml}\n${askHtml}`}
${(content.after ?? []).map(p).join("\n")}
</td></tr>
<tr><td style="padding:14px 30px 24px;border-top:1px solid #eef0f3;font:400 12.5px/1.6 ${FONT};color:#6b7385;">${footer.map(esc).join("<br>")}</td></tr>
</table></td></tr></table>
</body></html>`;
  return { subject, text, html };
}

async function footerFor(env: Bindings, base: string, e: OutgoingEmail): Promise<{ lines: string[]; unsubscribe: string | null }> {
  // With a Reply-To (NOTIFY_REPLY_TO), a reply reaches a person.
  const reply = env.NOTIFY_REPLY_TO && senderOf(env.NOTIFY_REPLY_TO) ? ["Questions? Reply to this email."] : [];
  if (e.category === "account")
    return {
      lines: [
        ...reply,
        `Sent to ${e.to.email} about your AgentFirstStack account. Account and security emails like this one are always sent.`,
        `Email settings: ${base}/dashboard/account`,
      ],
      unsubscribe: null,
    };
  const unsubscribe = e.to.userId ? await unsubscribeUrl(env, base, e.to.userId, e.category) : null;
  const what = e.category === "alerts" ? "alerts" : "updates";
  return {
    lines: [
      ...reply,
      `Sent to ${e.to.email} because you're a member of a project on AgentFirstStack.`,
      unsubscribe ? `Turn off these ${what}: ${unsubscribe}` : `Turn off these ${what} in ${base}/dashboard/account`,
    ],
    unsubscribe,
  };
}

/** The request's waitUntil, so an email goes out after the response (undefined: send inline). */
export function waitUntilOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return undefined; // no ExecutionContext (some test harnesses)
  }
}

// ---------- queue and send ----------

const capOf = (env: Bindings) => {
  const n = Number(env.MAX_EMAILS_PER_PERSON_PER_DAY);
  return Number.isFinite(n) && n >= 0 && env.MAX_EMAILS_PER_PERSON_PER_DAY !== undefined && env.MAX_EMAILS_PER_PERSON_PER_DAY !== ""
    ? n
    : DEFAULT_DAILY_CAP;
};

export type QueueResult = "queued" | "sent" | "failed" | "duplicate" | "off" | "opted_out" | "skipped";

/**
 * Queue one email and (unless `later`) send it now; with `waitUntil` the send runs after the
 * response. Safe to call again for the same event: the dedupe key makes it a no-op.
 */
export async function queueEmail(
  env: Bindings,
  base: string,
  e: OutgoingEmail,
  opts: { later?: boolean; waitUntil?: (p: Promise<unknown>) => void; now?: number } = {},
): Promise<QueueResult> {
  if (!emailEnabled(env) || !senderOf(env.NOTIFY_EMAIL_FROM ?? "")) return "off";
  if (!EMAIL_RE.test(e.to.email)) return "skipped";
  const db = env.DB;
  const now = opts.now ?? Date.now();
  if (e.category !== "account" && e.to.userId) {
    const col = OPT_OUT_COLUMN[e.category];
    const on = await db.prepare(`SELECT ${col} FROM users WHERE id = ?`).bind(e.to.userId).first<number>(col);
    if (on === 0) return "opted_out";
  }
  const sentToday = await db
    .prepare("SELECT count(*) AS n FROM email_outbox WHERE to_address = ? AND created_at > ? AND status != 'skipped'")
    .bind(e.to.email, now - DAY)
    .first<number>("n");
  const overCap = (sentToday ?? 0) >= capOf(env);
  const footer = await footerFor(env, base, e);
  const r = renderEmail(e.content, footer.lines);
  const id = newId("eml");
  const inserted = await db
    .prepare(
      `INSERT INTO email_outbox (id, dedupe_key, kind, category, user_id, to_address, account_id, subject, text_body, html_body, status, error, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    )
    .bind(
      id,
      e.dedupeKey,
      e.kind,
      e.category,
      e.to.userId,
      e.to.email,
      e.accountId ?? null,
      r.subject,
      r.text,
      r.html,
      overCap ? "skipped" : "pending",
      overCap ? "daily email limit for this address (MAX_EMAILS_PER_PERSON_PER_DAY)" : null,
      now,
      overCap ? null : now,
    )
    .first<string>("id");
  if (!inserted) return "duplicate";
  if (overCap) return "skipped";
  if (opts.later) return "queued";
  const send = deliver(env, id, base, now);
  if (opts.waitUntil) {
    opts.waitUntil(send);
    return "queued";
  }
  return (await send) ? "sent" : "failed";
}

interface OutboxRow {
  id: string;
  kind: string;
  category: EmailCategory;
  user_id: string | null;
  to_address: string;
  subject: string;
  text_body: string;
  html_body: string;
  attempts: number;
  status: string;
}

/** Send one queued email. True when it went out. */
export async function deliver(env: Bindings, id: string, base: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, kind, category, user_id, to_address, subject, text_body, html_body, attempts, status FROM email_outbox WHERE id = ?",
  )
    .bind(id)
    .first<OutboxRow>();
  const from = senderOf(env.NOTIFY_EMAIL_FROM ?? "");
  if (!row || row.status !== "pending" || !env.EMAIL || !from) return false;
  const headers: Record<string, string> = { "X-AFS-Email": "notification" };
  if (row.category !== "account" && row.user_id) {
    const url = await unsubscribeUrl(env, base, row.user_id, row.category);
    if (url) {
      headers["List-Unsubscribe"] = `<${url}>`;
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
  }
  const replyTo = env.NOTIFY_REPLY_TO ? senderOf(env.NOTIFY_REPLY_TO) : null;
  const attempts = row.attempts + 1;
  try {
    const res = await env.EMAIL.send({
      from,
      to: row.to_address,
      subject: row.subject,
      text: row.text_body,
      html: row.html_body,
      ...(replyTo ? { replyTo } : {}),
      headers,
    });
    await env.DB.prepare(
      "UPDATE email_outbox SET status = 'sent', attempts = ?, sent_at = ?, message_id = ?, error = NULL, next_attempt_at = NULL WHERE id = ?",
    )
      .bind(attempts, now, (res as { messageId?: string } | undefined)?.messageId ?? null, row.id)
      .run();
    // The person is gone: the confirmation of that is kept only until it's sent.
    if (row.kind === "account_deleted") await env.DB.prepare("DELETE FROM email_outbox WHERE id = ?").bind(row.id).run();
    return true;
  } catch (err) {
    const error = oneLine(
      String((err as { code?: string; message?: string })?.code ?? "") + " " + String((err as Error)?.message ?? err),
      300,
    );
    const retryIn = RETRY_AFTER_MS[attempts - 1];
    await env.DB.prepare("UPDATE email_outbox SET status = ?, attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?")
      .bind(retryIn === undefined ? "failed" : "pending", attempts, error, retryIn === undefined ? null : now + retryIn, row.id)
      .run();
    console.error(JSON.stringify({ event: "email.failed", id: row.id, attempts, error }));
    return false;
  }
}

/** Hourly cron: send what is due (queued in bulk, or waiting for a retry), within `budgetMs`. */
export async function deliverDue(env: Bindings, base: string, now = Date.now(), budgetMs = 60_000) {
  if (!emailEnabled(env)) return { sent: 0, failed: 0, left: 0 };
  const deadline = Date.now() + budgetMs;
  const { results } = await env.DB.prepare(
    "SELECT id FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 300",
  )
    .bind(now)
    .all<{ id: string }>();
  let sent = 0;
  let failed = 0;
  let left = 0;
  for (const { id } of results) {
    if (Date.now() >= deadline) {
      left++;
      continue;
    }
    if (await deliver(env, id, base, Date.now())) sent++;
    else failed++;
  }
  return { sent, failed, left };
}

/** Daily cron: emails (and their content) are kept 30 days. */
export async function pruneOutbox(db: D1Database, now = Date.now()) {
  const r = await db
    .prepare("DELETE FROM email_outbox WHERE created_at < ?")
    .bind(now - OUTBOX_RETENTION_DAYS * DAY)
    .run();
  return r.meta.changes ?? 0;
}

/** The person's recent emails, for their account page. */
export async function recentEmails(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT subject, status, created_at, sent_at FROM email_outbox WHERE user_id = ? ORDER BY created_at DESC LIMIT 10")
    .bind(userId)
    .all<{ subject: string; status: string; created_at: number; sent_at: number | null }>();
  return results;
}
