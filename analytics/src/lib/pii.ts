/**
 * Redaction of personal data that leaks into analytics by accident: an email address in a path
 * (/unsubscribe/jane@example.com), a phone number in a prop. Applied at ingest (in the site's
 * Durable Object, before anything is stored) to paths, URLs, referrers, UTM tags, titles, search
 * terms and prop values when the site has redact_pii on (the default). user_id is never changed.
 * Pure, and linear: every pattern is a single pass of character classes, no nested quantifiers.
 *
 * Phone numbers are recognised only with formatting cues (a leading "+", or the (415) 555-0123 /
 * 415-555-0123 shape): plain digit runs are kept, because order ids, timestamps and product codes
 * look the same.
 */

export const EMAIL_TOKEN = "[email]";
export const PHONE_TOKEN = "[phone]";

const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// "+" (or %2B) then 8-15 digits with spaces, dots, dashes or parentheses between them.
const INTL_PHONE = /(?<![\w+])(?:\+|%2[Bb])\d[\d ().-]{6,20}\d(?!\d)/g;
// (415) 555-0123, 415-555-0123, 415.555.0123, 415 555 0123
const NANP_PHONE = /(?<![\w(])(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\w])/g;

const digits = (s: string) => s.replace(/\D/g, "").length;

export function redactText(s: string): string {
  if (!s) return s;
  let out = s.replace(EMAIL, EMAIL_TOKEN);
  out = out.replace(INTL_PHONE, (m) => {
    const n = digits(m.replace(/^%2[Bb]/, "+"));
    return n >= 8 && n <= 15 ? PHONE_TOKEN : m;
  });
  return out.replace(NANP_PHONE, PHONE_TOKEN);
}

export const redactNullable = (s: string | null | undefined): string | null => (s == null ? null : redactText(s));

/** Props JSON (string values, as stored) with every value redacted; keys can't hold an address. */
export function redactProps(json: string | null): string | null {
  if (!json) return json;
  if (!/[@%+(]|\d{3}/.test(json)) return json; // nothing that could match: skip the parse
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    let changed = false;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== "string") continue;
      const r = redactText(v);
      if (r !== v) {
        o[k] = r;
        changed = true;
      }
    }
    return changed ? JSON.stringify(o) : json;
  } catch {
    return json;
  }
}
