/**
 * Masking and scrubbing rules shared by the browser recorder (src/recorder) and the Worker. Pure
 * and DOM-free, so the same code masks in the browser and is unit-tested in Node.
 *
 * Modes (per site, `mask_mode`):
 *   strict    (default, Clarity "Strict"): every text node and text attribute is masked; only
 *             elements matching unmask_selectors (or [data-afsr-unmask]) are shown as is.
 *   balanced  (Clarity "Balanced"): text is shown, but digits and email addresses are masked;
 *             unmask_selectors show text fully, mask_selectors mask it fully.
 *   relaxed   text is shown except inside mask_selectors (or [data-afsr-mask]).
 * Inputs (values typed, selected options) are masked in every mode. unmask_selectors can show an
 * input's value, except passwords, payment-card, one-time-code and hidden fields, which are
 * always masked.
 */

export type MaskMode = "strict" | "balanced" | "relaxed";
export const MASK_MODES = ["strict", "balanced", "relaxed"] as const;

/** Built-in attribute selectors a page can use without any site setting. */
export const BUILTIN_UNMASK = "[data-afsr-unmask]";
export const BUILTIN_MASK = "[data-afsr-mask]";
export const BUILTIN_BLOCK = "[data-afsr-block]";
export const BUILTIN_IGNORE = "[data-afsr-ignore]";

/** Every non-whitespace character becomes "*", so length and word shape survive, content doesn't. */
export const maskAll = (s: string): string => s.replace(/\S/g, "*");

const EMAIL = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/gi;

/** Balanced mode: email addresses and every digit masked, other text kept. */
export const maskPartial = (s: string): string => s.replace(EMAIL, (m) => maskAll(m)).replace(/\d/g, "*");

/** Which masking applies to some text, given where it sits. */
export type TextRule = "mask" | "partial" | "show";

export function textRule(mode: MaskMode, inUnmask: boolean, inMask: boolean): TextRule {
  if (inMask) return "mask";
  if (inUnmask) return "show";
  if (mode === "strict") return "mask";
  if (mode === "balanced") return "partial";
  return "show";
}

export function applyRule(rule: TextRule, s: string): string {
  return rule === "mask" ? maskAll(s) : rule === "partial" ? maskPartial(s) : s;
}

/** Input types (and autocomplete tokens) whose values are never shown, whatever the settings. */
const ALWAYS_MASKED_TYPES = new Set(["password", "hidden"]);
const ALWAYS_MASKED_AUTOCOMPLETE = /\b(cc-|one-time-code|current-password|new-password)/i;

export function inputAlwaysMasked(
  type: string | null | undefined,
  autocomplete: string | null | undefined,
  name: string | null | undefined,
): boolean {
  if (type && ALWAYS_MASKED_TYPES.has(type.toLowerCase())) return true;
  if (autocomplete && ALWAYS_MASKED_AUTOCOMPLETE.test(autocomplete)) return true;
  // Names developers use for secrets and card data, even without autocomplete hints.
  if (name && /(pass(word)?|pwd|secret|token|otp|cvc|cvv|card.?num|ccnum|iban|ssn)/i.test(name)) return true;
  return false;
}

/** Remove the query string and fragment of a URL (they can carry emails, tokens, ids). */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Free text that isn't page content but may still carry personal data (error messages, stack
 * traces, console output): emails, long digit runs and URL query strings are replaced, and the
 * result is cut to `max` characters.
 */
export function scrubText(s: string, max: number): string {
  const out = s
    .replace(EMAIL, "[email]")
    .replace(/(https?:\/\/[^\s?#"'()]+)[?#][^\s"'()]*/gi, "$1")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]")
    .replace(/\d[\d\s-]{7,}\d/g, "[number]");
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * Path glob match: `*` matches anything (including "/"), everything else is literal. Used for
 * exclude_paths in the browser and page filters on the server.
 */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export const pathMatches = (path: string, globs: readonly string[]): boolean => globs.some((g) => globToRegExp(g).test(path));
