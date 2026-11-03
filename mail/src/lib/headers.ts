/**
 * Values that end up inside mail headers (From display name, attachment filename, Content-Type,
 * Content-ID) must not carry CR/LF or other control characters, or they could inject headers.
 * Pure; tested in test/unit/service-pure.test.ts.
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Replace runs of control characters (CR, LF, TAB, NUL, C1, line separators) with a space and trim. */
export function headerSafe(s: string | null | undefined): string {
  return (s ?? "").replace(CONTROL, " ").trim();
}

export function hasControlChars(s: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s);
}

const TOKEN = "[A-Za-z0-9!#$&^_.+-]+";
const MIME_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:\\s*;\\s*${TOKEN}=(?:${TOKEN}|"[^"\\\\\\u0000-\\u001f]*"))*$`);

/** `type/subtype` with optional `; key=value` parameters, nothing else. */
export function isMimeType(s: string): boolean {
  return s.length <= 255 && MIME_TYPE.test(s.trim());
}
