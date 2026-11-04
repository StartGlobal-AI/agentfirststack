import { randomString, toBase64 } from "@afs/shared";
import { headerSafe } from "./headers";

/**
 * A MIME message (RFC 5322 + 2045-2047 + 2231) for internal delivery: mail one of an account's
 * inboxes sends to another of its inboxes is stored without leaving the Worker, so we write the
 * message ourselves instead of Email Service. Pure apart from the random boundary. Every part is
 * base64 (no line-length or 8-bit issues), header values are control-character free, and
 * non-ASCII header text is RFC 2047 encoded-words.
 */

export interface MimeAttachment {
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
  bytes: Uint8Array;
}

export interface MimeInput {
  from: { address: string; name?: string | null };
  to: string[];
  cc: string[];
  replyTo?: string | null;
  subject: string;
  messageId: string;
  date: number;
  inReplyTo?: string | null;
  references?: string | null;
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
  headers?: Record<string, string>;
}

const enc = new TextEncoder();
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** base64 in 76-character lines. */
function b64Lines(bytes: Uint8Array): string {
  const b = toBase64(bytes);
  const out: string[] = [];
  for (let i = 0; i < b.length; i += 76) out.push(b.slice(i, i + 76));
  return out.join("\r\n");
}

/** RFC 2047 encoded-words (UTF-8, base64), each under ~60 bytes of input, folded. ASCII passes through. */
export function encodeWord(s: string): string {
  const v = headerSafe(s);
  if (isAscii(v)) return v;
  const words: string[] = [];
  let chunk = "";
  for (const ch of v) {
    if (enc.encode(chunk + ch).byteLength > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${toBase64(enc.encode(w))}?=`).join("\r\n ");
}

/** "Name" <addr>, the name quoted or encoded as needed. */
export function mailbox(address: string, name?: string | null): string {
  const n = headerSafe(name);
  if (!n) return address;
  if (!isAscii(n)) return `${encodeWord(n)} <${address}>`;
  return /^[\w .'-]+$/.test(n) ? `${n} <${address}>` : `"${n.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}

/** filename="..." (ASCII) or filename*=UTF-8''... (RFC 2231). */
function fileParam(key: string, name: string): string {
  const n = headerSafe(name);
  if (isAscii(n) && !/["\\]/.test(n)) return `${key}="${n}"`;
  return `${key}*=UTF-8''${encodeURIComponent(n)}`;
}

function textPart(type: "plain" | "html", body: string): string {
  return [`Content-Type: text/${type}; charset=utf-8`, "Content-Transfer-Encoding: base64", "", b64Lines(enc.encode(body))].join("\r\n");
}

function multipart(kind: "mixed" | "alternative", parts: string[]): string {
  const boundary = `afs_${kind}_${randomString(16)}`;
  return [
    `Content-Type: multipart/${kind}; boundary="${boundary}"`,
    "",
    ...parts.flatMap((p) => [`--${boundary}`, p]),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** RFC 5322 date, e.g. "Tue, 03 Nov 2026 10:00:00 +0000". */
export function rfc5322Date(ms: number): string {
  return new Date(ms).toUTCString().replace("GMT", "+0000");
}

export function buildMime(m: MimeInput): Uint8Array {
  const head = [
    `From: ${mailbox(m.from.address, m.from.name)}`,
    ...(m.to.length ? [`To: ${m.to.join(", ")}`] : []),
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${rfc5322Date(m.date)}`,
    `Message-ID: ${m.messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${headerSafe(m.inReplyTo)}`] : []),
    ...(m.references ? [`References: ${headerSafe(m.references)}`] : []),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${headerSafe(v)}`),
    "MIME-Version: 1.0",
  ];
  const bodies: string[] = [];
  if (m.text !== undefined) bodies.push(textPart("plain", m.text));
  if (m.html !== undefined) bodies.push(textPart("html", m.html));
  const body = bodies.length > 1 ? multipart("alternative", bodies) : (bodies[0] ?? textPart("plain", ""));
  const atts = (m.attachments ?? []).map((a) =>
    [
      `Content-Type: ${a.type}; ${fileParam("name", a.filename)}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${a.disposition}; ${fileParam("filename", a.filename)}`,
      ...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
      "",
      b64Lines(a.bytes),
    ].join("\r\n"),
  );
  const content = atts.length ? multipart("mixed", [body, ...atts]) : body;
  return enc.encode(`${head.join("\r\n")}\r\n${content}`);
}
