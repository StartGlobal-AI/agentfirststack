import { badRequest } from "@afs/shared";
import { headerSafe } from "./headers";
import type { HeaderLike } from "./sender";

/**
 * Forwarding an inbox's mail to the project's members (pure parts; src/service/forward.ts sends).
 *
 *   - The setting: `forward: { mode: each | digest | off, digest_hour: 0-23, timezone: IANA }`.
 *   - What may be forwarded at all (forwardEligibility), decided from the headers at ingest.
 *   - When a digest is due (digestDue), from the inbox's local hour and what is waiting.
 *   - The emails themselves: a forwarded message, and a digest.
 */

export const FORWARD_MODES = ["each", "digest", "off"] as const;
export type ForwardMode = (typeof FORWARD_MODES)[number];
export const DEFAULT_DIGEST_HOUR = 8;
export const DEFAULT_TIMEZONE = "UTC";
/** Header on every forward and digest we send; inbound mail carrying it is never forwarded (loops). */
export const FORWARD_MARKER = "X-AFS-Forwarded";
/** The plus-address tag of the platform's setup test (site/src/setup-test.ts): its mail is never forwarded. */
export const SETUP_TEST_TAG = "afs-test";
/** Messages listed in one digest; the rest are counted ("and N more"). */
export const DIGEST_MAX_LISTED = 50;
export const PREVIEW_CHARS = 300;
const PRODUCT = "AgentFirstStack";

export interface ForwardSetting {
  mode: ForwardMode;
  digest_hour: number;
  timezone: string;
}

export interface ForwardInput {
  mode?: ForwardMode;
  digest_hour?: number;
  timezone?: string;
}

export const DEFAULT_FORWARD: ForwardSetting = { mode: "off", digest_hour: DEFAULT_DIGEST_HOUR, timezone: DEFAULT_TIMEZONE };

// ---------------------------------------------------------------------------------------------
// Time zones

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    if (formatters.size > 500) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

/** The canonical IANA name ("europe/berlin" -> "Europe/Berlin"), or null when it is not one. */
export function canonicalTimezone(tz: string): string | null {
  const t = tz.trim();
  if (!t || t.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(t)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: t }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Wall-clock parts of `ms` in `timeZone`: day "YYYY-MM-DD", hour 0-23, "HH:MM", weekday "Thu". */
export function localParts(ms: number, timeZone: string) {
  const p: Record<string, string> = {};
  for (const x of formatter(timeZone).formatToParts(new Date(ms))) p[x.type] = x.value;
  const hour = Number(p.hour) % 24;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour,
    time: `${String(hour).padStart(2, "0")}:${p.minute}`,
    weekday: p.weekday ?? "",
  };
}

/** "Thu 2026-11-05 09:14 Europe/Berlin". */
export function localTime(ms: number, timeZone: string): string {
  const l = localParts(ms, timeZone);
  return `${l.weekday} ${l.day} ${l.time} ${timeZone}`;
}

// ---------------------------------------------------------------------------------------------
// The setting

/** A partial update merged into the current setting ({mode:"digest"} keeps hour and time zone). 400 on a bad value. */
export function mergeForward(current: ForwardSetting, input: ForwardInput | null | undefined): ForwardSetting {
  if (!input) return current;
  const next = { ...current };
  if (input.mode !== undefined) {
    if (!(FORWARD_MODES as readonly string[]).includes(input.mode))
      throw badRequest(
        `Invalid forward.mode "${input.mode}".`,
        'Use "each" (every email as it arrives), "digest" (one email a day) or "off".',
      );
    next.mode = input.mode;
  }
  if (input.digest_hour !== undefined) {
    if (!Number.isInteger(input.digest_hour) || input.digest_hour < 0 || input.digest_hour > 23)
      throw badRequest(
        "forward.digest_hour must be a whole hour from 0 to 23.",
        'E.g. {"forward":{"mode":"digest","digest_hour":8}} for 08:00.',
      );
    next.digest_hour = input.digest_hour;
  }
  if (input.timezone !== undefined) {
    const tz = canonicalTimezone(input.timezone);
    if (!tz)
      throw badRequest(
        `"${String(input.timezone).slice(0, 64)}" is not a time zone.`,
        'Use an IANA time zone name such as "Europe/Berlin", "America/New_York" or "UTC" (ask the owner which city they are in).',
      );
    next.timezone = tz;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// What may be forwarded

export type SkipReason = "internal" | "forwarded_marker" | "setup_test" | "bounce" | "auto_reply" | "unauthenticated";
/** forward: forwarded on its own (mode each) and listed in digests. list: listed in digests only. */
export type Eligibility = { kind: "forward" | "list" } | { skip: SkipReason };

/**
 * May this received message be forwarded to the project's members? Pure; from the headers.
 * Never: internal deliveries (the account's own inboxes writing to each other), mail carrying our
 * own forwarded marker, the setup test's mail (tag afs-test), bounces and delivery reports (empty
 * envelope sender, mailer-daemon / postmaster, multipart/report, X-Failed-Recipients), auto-replies
 * (Auto-Submitted other than no, X-Autoreply, X-Autorespond, X-Autogenerated, Precedence:
 * auto_reply) and mail whose sender is not authenticated (auth verdict other than "pass").
 * Machine notices (Auto-Submitted: auto-generated or auto-notified) ARE forwarded: verification
 * codes, password resets and service notices carry them, and they're what the owner must not miss.
 * They can't loop: a machine notice never answers mail, and an answer to a forward (an out-of-office
 * reply) is auto-replied, which is skipped. Loops through the account's own inboxes and members are
 * checked when sending (they need the database).
 */
export function forwardEligibility(m: {
  headers: HeaderLike[];
  envelopeFrom: string | null | undefined;
  fromAddress: string | null | undefined;
  authVerdict: string | null | undefined;
  tag: string | null | undefined;
  internal: boolean;
}): Eligibility {
  if (m.internal) return { skip: "internal" };
  let autoReply = false;
  let report = false;
  for (const h of m.headers) {
    const k = h.key.toLowerCase();
    const v = h.value.trim().toLowerCase();
    if (k === FORWARD_MARKER.toLowerCase()) return { skip: "forwarded_marker" };
    if (k === "auto-submitted") {
      const kind = v.split(";")[0]!.trim();
      if (kind && kind !== "no" && kind !== "auto-generated" && kind !== "auto-notified") autoReply = true;
    }
    if (k === "x-autoreply" || k === "x-autorespond" || k === "x-autogenerated") autoReply = true;
    if (k === "precedence" && /^auto_reply\b/.test(v)) autoReply = true;
    if (k === "x-failed-recipients") report = true;
    if (k === "content-type" && v.startsWith("multipart/report")) report = true;
  }
  if ((m.tag ?? "").toLowerCase() === SETUP_TEST_TAG) return { skip: "setup_test" };
  const env = (m.envelopeFrom ?? "").trim();
  const local = (m.fromAddress ?? "").toLowerCase().split("@")[0] ?? "";
  if (!env || env === "<>" || report || local === "mailer-daemon" || local === "postmaster") return { skip: "bounce" };
  if (autoReply) return { skip: "auto_reply" };
  if (m.authVerdict !== "pass") return { skip: "unauthenticated" };
  return { kind: "forward" };
}

// ---------------------------------------------------------------------------------------------
// When the cron sends a digest

export type DigestReason = "digest" | "catch_up" | "leftover";

/**
 * Which digest (if any) the hourly cron sends for an inbox with mail waiting. Pure.
 *   catch_up  nothing was ever forwarded or digested and mail has waited since before the first
 *             member claimed the project: one digest of it, at once, whatever the hour.
 *   digest    mode digest, the local hour is digest_hour and today's digest has not gone out.
 *   leftover  mode each, mail the live forward did not send within `graceMs` (the daily budget ran
 *             out, or a send failed): one digest of it, once the budget allows.
 */
export function digestDue(o: {
  setting: ForwardSetting;
  digestDay: string | null | undefined;
  lastForwardedAt: number | null | undefined;
  lastDigestAt: number | null | undefined;
  oldestWaiting: number | null | undefined;
  claimedAt: number | null | undefined;
  now: number;
  graceMs: number;
}): DigestReason | null {
  const { setting, now } = o;
  if (setting.mode === "off" || o.oldestWaiting === null || o.oldestWaiting === undefined) return null;
  const never = o.lastForwardedAt == null && o.lastDigestAt == null;
  const catchUp = never && o.claimedAt != null && o.oldestWaiting < o.claimedAt;
  if (setting.mode === "each") {
    if (o.oldestWaiting > now - o.graceMs) return null; // the live forward may still be at it
    return catchUp ? "catch_up" : "leftover";
  }
  if (catchUp) return "catch_up";
  const local = localParts(now, setting.timezone);
  return local.hour === setting.digest_hour && o.digestDay !== local.day ? "digest" : null;
}

// ---------------------------------------------------------------------------------------------
// HTML of a forwarded message

/**
 * Removes active content from third-party HTML before it is forwarded: scripts, frames, objects,
 * forms and their controls, base/meta/link tags, event-handler attributes and javascript:/vbscript:
 * URLs (data: URLs in links). Mail clients do this too; this is defence in depth, not a parser.
 */
export function stripActiveHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed|applet|form|frameset|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(
      /<\/?(script|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|base|meta|link|template)\b[^>]*>/gi,
      "",
    )
    .replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\b(href|src|action|formaction|xlink:href|background)\s*=\s*(["']?)\s*(?:javascript|vbscript):/gi, "$1=$2#blocked:")
    .replace(/\b(href|action|formaction|xlink:href)\s*=\s*(["']?)\s*data:/gi, "$1=$2#blocked:");
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ---------------------------------------------------------------------------------------------
// The emails

export interface FooterInput {
  inboxAddress: string;
  /** The project's name, else its account id. */
  project: string;
  /** <site>/dashboard/projects/<account id>, or null when the deployment has no site (AUTH_ISSUER unset). */
  dashboardUrl: string | null;
  mode: "each" | "digest";
}

/** The last paragraph of every forward and digest: where it came from and how to change it. */
export function forwardFooter(f: FooterInput): string {
  const change =
    f.mode === "each" ? "To get a daily digest instead or stop" : "To get each email as it arrives instead, change the time or stop";
  return `Forwarded by ${PRODUCT} from ${f.inboxAddress} (project ${headerSafe(f.project) || "unnamed"}) to the project's members. ${change}: ask your agent${f.dashboardUrl ? `, or open ${f.dashboardUrl}` : ""}.`;
}

/** The From display name of forwards: "<inbox display name or address> via AgentFirstStack". */
export function forwardFromName(inbox: { address: string; display_name: string | null }): string {
  return `${headerSafe(inbox.display_name) || inbox.address} via ${PRODUCT}`.slice(0, 200);
}

/** Subject of a forwarded message: "[<inbox address>] <original subject>". */
export function forwardEachSubject(inboxAddress: string, subject: string | null | undefined): string {
  return `[${inboxAddress}] ${headerSafe(subject).slice(0, 300) || "(no subject)"}`;
}

/** One forwarded message: the original's header block and text (HTML if it has one), then the footer. Pure. */
export function eachForwardEmail(o: {
  inboxAddress: string;
  subject: string | null | undefined;
  headerLines: string[];
  text: string;
  html: string | null;
  footer: string;
  /** e.g. attachments left out. */
  note?: string | null;
}) {
  const note = o.note ? `\n\n[${o.note}]` : "";
  const text = `${o.headerLines.join("\n")}\n\n${o.text}${note}\n\n--\n${o.footer}\n`;
  const html = o.html
    ? `<div style="font:13px/1.5 sans-serif;color:#555;border-left:3px solid #ccc;padding:4px 10px;margin:0 0 12px">${o.headerLines
        .map(escapeHtml)
        .join(
          "<br>",
        )}</div>${stripActiveHtml(o.html)}${o.note ? `<p style="font:13px sans-serif;color:#555">[${escapeHtml(o.note)}]</p>` : ""}<hr style="border:0;border-top:1px solid #ddd;margin:16px 0"><p style="font:12px/1.5 sans-serif;color:#777">${escapeHtml(o.footer)}</p>`
    : undefined;
  return { subject: forwardEachSubject(o.inboxAddress, o.subject), text, html };
}

export interface DigestItem {
  id: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  received_at: number;
  code: string | null;
  verify_link: string | null;
  /** reply_text (else text), any length; cut to PREVIEW_CHARS here. */
  snippet: string | null;
}

/** ~300 characters of plain text on one line. */
export function previewOf(s: string | null | undefined, max = PREVIEW_CHARS): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const sender = (i: Pick<DigestItem, "from_address" | "from_name">) => {
  const n = headerSafe(i.from_name);
  return n ? `${n} <${i.from_address ?? ""}>` : (i.from_address ?? "(unknown sender)");
};

/**
 * The digest email: subject "<N> new emails at <inbox>", every message newest first (at most
 * DIGEST_MAX_LISTED, then "and N more") with sender, subject, time in the inbox's time zone, the
 * extracted code or link and a preview; how many unauthenticated messages were left out; why it
 * was sent now (catch-up, the daily budget); the footer. Pure.
 */
export function digestEmail(o: {
  inboxAddress: string;
  /** Newest first; only the first DIGEST_MAX_LISTED are listed. */
  items: DigestItem[];
  /** How many messages the digest covers (default items.length; more when not all were loaded). */
  total?: number;
  timezone: string;
  reason: DigestReason;
  /** The mode the inbox is in (catch-up digests say what happens from now on). */
  mode: "each" | "digest";
  digestHour: number;
  unauthenticated: number;
  /** When forwarding paused at the daily budget (null = it did not). */
  pausedAt: number | null;
  dailyLimit: number | null;
  footer: string;
}) {
  const n = Math.max(o.total ?? 0, o.items.length);
  const listed = o.items.slice(0, DIGEST_MAX_LISTED);
  const more = n - listed.length;
  const subject = `${n} new email${n === 1 ? "" : "s"} at ${o.inboxAddress}`;
  const intro: string[] = [];
  if (o.reason === "catch_up")
    intro.push(
      `These arrived at ${o.inboxAddress} before anyone claimed the project. From now on ${
        o.mode === "each"
          ? "each email is forwarded as it arrives"
          : `you get one digest a day at ${String(o.digestHour).padStart(2, "0")}:00 (${o.timezone})`
      }.`,
    );
  if (o.pausedAt)
    intro.push(
      `Forwarding paused on ${new Date(o.pausedAt).toISOString().slice(0, 10)} (UTC) at the project's daily limit${
        o.dailyLimit !== null ? ` of ${o.dailyLimit} forwarded emails` : ""
      }; what arrived since is listed here.`,
    );
  const entries = listed.map((i) => {
    const lines = [
      `From: ${sender(i)}`,
      `Subject: ${headerSafe(i.subject) || "(no subject)"}`,
      `Received: ${localTime(i.received_at, o.timezone)}`,
    ];
    if (i.code) lines.push(`Code: ${i.code}`);
    if (i.verify_link) lines.push(`Link: ${i.verify_link}`);
    const p = previewOf(i.snippet);
    if (p) lines.push(p);
    return { i, lines };
  });
  const tail: string[] = [];
  if (more) tail.push(`...and ${more} more. Ask your agent to read them.`);
  if (o.unauthenticated)
    tail.push(
      `Not listed: ${o.unauthenticated} email${o.unauthenticated === 1 ? "" : "s"} that failed sender authentication (possibly forged; your agent can still read ${o.unauthenticated === 1 ? "it" : "them"}).`,
    );
  const text = [
    `${subject}, newest first:`,
    ...intro.map((l) => `\n${l}`),
    "",
    ...entries.map((e, k) => `${k + 1}. ${e.lines.join("\n   ")}\n`),
    ...tail.map((l) => `${l}\n`),
    "--",
    o.footer,
    "",
  ].join("\n");
  const p = (s: string, style = "") => `<p style="font:14px/1.5 sans-serif;margin:0 0 10px;${style}">${s}</p>`;
  const html = [
    p(`<b>${escapeHtml(subject)}</b>, newest first.`),
    ...intro.map((l) => p(escapeHtml(l), "color:#555")),
    `<ol style="font:14px/1.5 sans-serif;padding-left:20px">`,
    ...entries.map(({ i }) => {
      const parts = [
        `<b>${escapeHtml(headerSafe(i.subject) || "(no subject)")}</b>`,
        `<span style="color:#555">${escapeHtml(sender(i))} · ${escapeHtml(localTime(i.received_at, o.timezone))}</span>`,
        ...(i.code ? [`Code: <b style="font-family:monospace;font-size:16px">${escapeHtml(i.code)}</b>`] : []),
        ...(i.verify_link ? [`Link: <a href="${escapeHtml(i.verify_link)}">${escapeHtml(i.verify_link.slice(0, 120))}</a>`] : []),
        ...(previewOf(i.snippet) ? [`<span style="color:#444">${escapeHtml(previewOf(i.snippet))}</span>`] : []),
      ];
      return `<li style="margin:0 0 14px">${parts.join("<br>")}</li>`;
    }),
    "</ol>",
    ...tail.map((l) => p(escapeHtml(l), "color:#555")),
    `<hr style="border:0;border-top:1px solid #ddd;margin:16px 0">`,
    `<p style="font:12px/1.5 sans-serif;color:#777">${escapeHtml(o.footer)}</p>`,
  ].join("\n");
  return { subject, text, html, listed: listed.length, more };
}
