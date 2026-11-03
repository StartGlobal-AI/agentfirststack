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
}

const MIN_TEXT = 20;

/** Everything we derive from a message at ingest. Pure. */
export function extractAll(input: ExtractInput): Extracted {
  const textPart = input.text ? tidyText(input.text) : "";
  const htmlText = input.html ? htmlToText(input.html) : "";
  // Prefer the sender's own plain text unless it is a stub ("View this email in your browser").
  const text = textPart.length >= MIN_TEXT || !htmlText ? textPart || htmlText : htmlText;
  const header = (k: string) => input.headers.find((h) => h.key.toLowerCase() === k)?.value ?? null;

  const codes = extractCodes({ subject: input.subject, text: input.text, html: input.html, otpHeader: input.otpHeader });
  const links = extractLinks({ subject: input.subject, text: input.text, html: input.html, listUnsubscribe: header("list-unsubscribe") });
  const auth = extractAuth(input.headers, input.fromAddress);
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
