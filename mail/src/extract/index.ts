import { type AuthResults, type HeaderLike, extractAuth } from "./auth";
import { extractCodes } from "./codes";
import { type ExtractedLink, extractLinks, primaryActionLink } from "./links";
import { htmlToText, makePreview, tidyText } from "./text";

export type { AuthResults } from "./auth";
export type { ExtractedLink, LinkKind } from "./links";

export interface Extracted {
  /** Plain-text body: the text/plain part, or text derived from the HTML when there is none. */
  text: string;
  preview: string;
  codes: string[];
  links: ExtractedLink[];
  auth: AuthResults;
  /** codes[0] */
  code: string | null;
  /** First verify / magic_login / password_reset link. */
  verify_link: string | null;
}

export interface ExtractInput {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  headers: HeaderLike[];
  fromAddress?: string | null;
  otpHeader?: string | null;
  /** extractAuth(headers, fromAddress), when the caller already has it. */
  auth?: AuthResults;
}

const MIN_TEXT = 20;

/**
 * Characters of the text part and of the HTML that extraction reads (each). Codes, action links
 * and the stored text excerpt all come from the start of a message; the cap keeps the work on a
 * sender-controlled body bounded whatever its size. The raw MIME in R2 keeps everything.
 */
export const MAX_EXTRACT_CHARS = 512 * 1024;

const capped = (s: string | null | undefined) => (s && s.length > MAX_EXTRACT_CHARS ? s.slice(0, MAX_EXTRACT_CHARS) : s);

/** Everything we derive from a message at ingest. Pure; linear in its (capped) input. */
export function extractAll(input: ExtractInput): Extracted {
  const rawText = capped(input.text);
  const html = capped(input.html);
  const textPart = rawText ? tidyText(rawText) : "";
  const htmlText = html ? htmlToText(html) : "";
  // Prefer the sender's own plain text unless it is a stub ("View this email in your browser").
  const text = textPart.length >= MIN_TEXT || !htmlText ? textPart || htmlText : htmlText;
  const header = (k: string) => input.headers.find((h) => h.key.toLowerCase() === k)?.value ?? null;

  const codes = extractCodes({ subject: input.subject, text: rawText, html, htmlText, otpHeader: input.otpHeader });
  const links = extractLinks({ subject: input.subject, text: rawText, html, htmlText, listUnsubscribe: header("list-unsubscribe") });
  const auth = input.auth ?? extractAuth(input.headers, input.fromAddress);
  return {
    text,
    preview: makePreview(text || input.subject || ""),
    codes,
    links,
    auth,
    code: codes[0] ?? null,
    verify_link: primaryActionLink(links)?.url ?? null,
  };
}
