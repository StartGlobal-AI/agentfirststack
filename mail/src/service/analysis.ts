import { badRequest, notFound } from "@afs/shared";
import PostalMime from "postal-mime";
import type { AppEnv } from "../env";
import type { AuthResults, ExtractedLink } from "../extract";
import { altOf } from "../extract/text";
import { registrableDomain } from "../lib/sender";
import type { MessageRow } from "./format";
import { headerBlock } from "./ingest";
import { getMessageRow } from "./messages";

/**
 * GET /v1/messages/:id/analysis: a deliverability checklist for a RECEIVED message, so an agent
 * testing its own site's mail (send it to an inbox here, then analyze) sees what mailbox
 * providers will judge: aligned SPF / DKIM / DMARC (the auth results already parsed at ingest,
 * from Cloudflare's own Authentication-Results header), one-click List-Unsubscribe, a real text
 * part, size (Gmail clips HTML past 102 KB), images without alt text, scripts / iframes / forms,
 * link domains against the From domain, URL shorteners and plain-http links.
 *
 * No spam score: there is no SpamAssassin or DNSBL on Workers (and DNSBLs refuse shared
 * resolvers). Every check is linear in the message; only the stored raw MIME is read.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

const GMAIL_CLIP_BYTES = 102 * 1024;
const SHORTENERS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "tiny.cc",
  "rb.gy",
  "lnkd.in",
  "bl.ink",
]);
const RISKY_TAGS = new Set(["script", "iframe", "form", "object", "embed", "applet"]);

/**
 * Tags in HTML (name and source, up to 2,000 characters of it), at most `max` tags. A "<" not
 * followed by a letter is text, and scanning goes on right after it. Pure and linear: the next
 * ">" is searched for only once each time scanning passes the previous one.
 */
export function scanTags(html: string, max = 20_000): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  let i = 0;
  let gt = -1;
  while (out.length < max) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (gt <= lt) gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    const c = html.charCodeAt(lt + 1);
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!letter) {
      i = lt + 1;
      continue;
    }
    const src = html.slice(lt + 1, Math.min(gt, lt + 2001));
    const name = (/^([a-zA-Z][a-zA-Z0-9]*)/.exec(src)?.[1] ?? "").toLowerCase();
    out.push({ name, src });
    i = gt + 1;
  }
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** The checklist (pure, given the parsed parts). */
export function analyze(input: {
  row: Pick<MessageRow, "from_address" | "size" | "html_size" | "auth_json" | "links_json" | "message_id_header" | "sent_at">;
  headers: { key: string; value: string }[];
  text: string | null | undefined;
  html: string | null | undefined;
}): { checks: Check[]; summary: Record<CheckStatus, number> } {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail });
  const header = (k: string) => input.headers.filter((h) => h.key.toLowerCase() === k).map((h) => h.value);
  const auth = input.row.auth_json ? (JSON.parse(input.row.auth_json) as AuthResults) : null;
  const fromDomain = (input.row.from_address ?? "").split("@")[1]?.toLowerCase() ?? "";
  const fromReg = fromDomain ? registrableDomain(fromDomain) : "";

  // Authentication (Cloudflare's own Authentication-Results; see src/extract/auth.ts).
  if (!auth?.trusted)
    add("auth_trusted", "warn", "No Authentication-Results header from Cloudflare Email Routing; the results below are unverified.");
  add("spf", auth?.spf === "pass" ? "pass" : auth?.spf ? "fail" : "warn", `SPF: ${auth?.spf ?? "none"}.`);
  const aligned = (auth?.dkim_domains ?? []).some((d) => d === fromDomain || registrableDomain(d) === fromReg);
  add(
    "dkim",
    auth?.dkim === "pass" && aligned ? "pass" : auth?.dkim === "pass" ? "warn" : "fail",
    auth?.dkim === "pass"
      ? aligned
        ? `DKIM pass, signed by ${auth.dkim_domains.join(", ")} (aligned with ${fromDomain}).`
        : `DKIM pass, but signed by ${auth.dkim_domains.join(", ") || "another domain"}, not ${fromDomain}: sign with the From domain.`
      : `DKIM: ${auth?.dkim ?? "none"}. Sign outgoing mail with a key published for ${fromDomain || "the From domain"}.`,
  );
  add(
    "dmarc",
    auth?.dmarc === "pass" ? "pass" : auth?.dmarc === "fail" ? "fail" : "warn",
    auth?.dmarc === "pass"
      ? "DMARC pass."
      : `DMARC: ${auth?.dmarc ?? "none"}. Publish TXT _dmarc.${fromReg || "<domain>"} (start with p=none) and align SPF or DKIM with the From domain.`,
  );
  if (auth?.arc) add("arc", auth.arc === "pass" ? "pass" : "info", `ARC: ${auth.arc} (set by forwarders).`);
  add(
    "auth_verdict",
    auth?.verdict === "pass" ? "pass" : "fail",
    `Overall: the From domain is ${auth?.verdict === "pass" ? "" : "not "}authenticated (verdict ${auth?.verdict ?? "unknown"}).`,
  );

  // Unsubscribe (Gmail and Yahoo require one-click for bulk senders).
  const lu = header("list-unsubscribe")[0];
  const lup = header("list-unsubscribe-post")[0];
  if (!lu)
    add(
      "list_unsubscribe",
      "info",
      "No List-Unsubscribe header (needed for marketing / bulk mail, not for one-to-one transactional mail).",
    );
  else {
    const https = /<https:\/\/[^>]+>/i.test(lu);
    const oneClick = (lup ?? "").replace(/\s+/g, "").toLowerCase() === "list-unsubscribe=one-click";
    add(
      "list_unsubscribe",
      https && oneClick ? "pass" : "warn",
      https && oneClick
        ? "List-Unsubscribe with an https URL and List-Unsubscribe-Post: List-Unsubscribe=One-Click."
        : `List-Unsubscribe is present but ${!https ? "has no https URL" : ""}${!https && !oneClick ? " and " : ""}${!oneClick ? "lacks List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058)" : ""}.`,
    );
  }

  // Structure and size.
  add(
    "text_part",
    input.text?.trim() ? "pass" : input.html ? "warn" : "fail",
    input.text?.trim() ? "Has a text/plain part." : "No text/plain part: add one (some clients and filters only read text).",
  );
  const htmlBytes = input.html ? new TextEncoder().encode(input.html).byteLength : 0;
  if (input.html)
    add(
      "html_size",
      htmlBytes > GMAIL_CLIP_BYTES ? "warn" : "pass",
      `HTML is ${Math.round(htmlBytes / 1024)} KB${htmlBytes > GMAIL_CLIP_BYTES ? ": Gmail clips messages past 102 KB." : "."}`,
    );
  add("size", (input.row.size ?? 0) > 10 * 1024 * 1024 ? "warn" : "pass", `Message is ${Math.round((input.row.size ?? 0) / 1024)} KB.`);
  add(
    "message_id",
    input.row.message_id_header ? "pass" : "fail",
    input.row.message_id_header ? "Has a Message-ID." : "No Message-ID header.",
  );
  add("date", header("date").length ? "pass" : "warn", header("date").length ? "Has a Date header." : "No Date header.");

  // HTML content.
  if (input.html) {
    const tags = scanTags(input.html);
    const imgs = tags.filter((t) => t.name === "img");
    const noAlt = imgs.filter((t) => altOf(t.src) === null).length;
    add("images_alt", noAlt ? "warn" : "pass", imgs.length ? `${imgs.length} images, ${noAlt} without alt text.` : "No images.");
    const risky = [...new Set(tags.filter((t) => RISKY_TAGS.has(t.name)).map((t) => t.name))];
    add(
      "risky_html",
      risky.length ? "fail" : "pass",
      risky.length
        ? `Contains <${risky.join(">, <")}>: mail clients strip these and filters penalise them.`
        : "No scripts, iframes, forms or embeds.",
    );
  }

  // Links.
  const links = input.row.links_json ? (JSON.parse(input.row.links_json) as ExtractedLink[]) : [];
  const hosts = links.map((l) => hostOf(l.url)).filter((h): h is string => !!h);
  const foreign = [...new Set(hosts.filter((h) => fromReg && registrableDomain(h) !== fromReg).map(registrableDomain))];
  const short = [...new Set(hosts.filter((h) => SHORTENERS.has(h)))];
  const plain = links.filter((l) => l.url.startsWith("http://")).length;
  add(
    "links",
    "info",
    `${links.length} links; domains other than ${fromReg || "the From domain"}: ${foreign.slice(0, 10).join(", ") || "none"}.`,
  );
  add(
    "shorteners",
    short.length ? "fail" : "pass",
    short.length ? `URL shorteners (${short.join(", ")}) are a common spam signal: link to your own domain.` : "No URL shorteners.",
  );
  add("https_links", plain ? "warn" : "pass", plain ? `${plain} links use plain http.` : "All links use https.");

  const summary = { pass: 0, warn: 0, fail: 0, info: 0 } as Record<CheckStatus, number>;
  for (const c of checks) summary[c.status]++;
  return { checks, summary };
}

export async function analyzeMessage(env: AppEnv, accountId: string, id: string) {
  const row = await getMessageRow(env, accountId, id);
  if (row.direction !== "in" || !row.raw_key)
    throw badRequest(
      "The deliverability report is for received messages.",
      "Send the mail you want to check to one of your inboxes (from your site or app), then GET /v1/messages/<that message>/analysis.",
    );
  const raw = await env.BLOBS.get(row.raw_key);
  if (!raw) throw notFound("Raw MIME for this message");
  const bytes = new Uint8Array(await raw.arrayBuffer());
  const head = await PostalMime.parse(headerBlock(bytes));
  const parsed = await PostalMime.parse(bytes, { attachmentEncoding: "arraybuffer" });
  const r = analyze({ row, headers: head.headers, text: parsed.text, html: parsed.html });
  return {
    message_id: row.id,
    from: row.from_address,
    ...r,
    next_steps: r.summary.fail ? ["Fix the failed checks first: authentication and risky content weigh most with mailbox providers."] : [],
  };
}
