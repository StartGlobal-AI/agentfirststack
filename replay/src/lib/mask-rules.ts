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

/**
 * Is a typed value shown in the recording? Only inside [data-afsr-unmask] on the page itself (a
 * site setting such as unmask_selectors never reveals values: anyone with the site's API key
 * could change it), never inside a mask selector, never for always-masked fields.
 */
export function inputValueVisible(
  type: string | null | undefined,
  autocomplete: string | null | undefined,
  name: string | null | undefined,
  inPageUnmask: boolean,
  inMask: boolean,
): boolean {
  return inPageUnmask && !inMask && !inputAlwaysMasked(type, autocomplete, name);
}

/** Remove the query string and fragment of a URL (they can carry emails, tokens, ids). */
export function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

// Built from escape sequences on purpose: raw U+2028/U+2029 inside a regex literal end the line.
const INVISIBLE = new RegExp("[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]", "g");
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
const CONTROL_KEEP_NL = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

/**
 * Control characters, line and paragraph separators, bidi overrides and zero-width characters
 * become a space / disappear: recorded strings are printed one per line for agents, and these
 * could fake a line, close a quote visually or hide text. `keepNewlines` for stack traces.
 */
export function cleanText(s: string, keepNewlines = false): string {
  const t = s.replace(INVISIBLE, "");
  return keepNewlines ? t.replace(/\r\n?/g, "\n").replace(CONTROL_KEEP_NL, " ") : t.replace(CONTROL, " ");
}

/** A path segment that identifies a person or a record: an email, a long number, a uuid, a hash or token. */
export function idLikeSegment(seg: string): boolean {
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {
    /* keep it raw */
  }
  if (s.includes("@")) return true;
  if (/^\d{3,}$/.test(s) || /\d{5,}/.test(s)) return true;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  // a token: one run of 12+ letters and digits mixed (slugs like "iphone-15-pro-256gb" are words)
  return s.split(/[-_.~]/).some((p) => p.length >= 12 && /\d.*\d/.test(p) && /[a-z].*[a-z]/i.test(p));
}

/** "/orders/12345/jane@x.test" -> "/orders/:id/:id": id-like segments of a path are never stored. */
export const scrubPath = (path: string): string =>
  path
    .split("/")
    .map((seg) => (seg && idLikeSegment(seg) ? ":id" : seg))
    .join("/");

/** Origin kept, path scrubbed: "https://x.test/u/123" -> "https://x.test/u/:id". */
function scrubUrlPath(url: string, segments: (path: string) => string): string {
  const m = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*)(\/.*)?$/i.exec(url);
  if (m) return m[1]! + segments(m[2] ?? "");
  return segments(url);
}

/**
 * A link target (href, form action) as recorded: no query string or fragment (fragment-only
 * in-page anchors stay), id-like path segments as ":id", mailto:/tel:/other schemes reduced to the
 * scheme ("mailto:"), never the address.
 */
export function scrubLink(url: string): string {
  const s = url.trim();
  if (!s) return s;
  if (s[0] === "#") return /^#[A-Za-z][\w-]{0,80}$/.test(s) ? s : "#";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return `${scheme}:`;
  return scrubUrlPath(stripQuery(s), scrubPath);
}

/**
 * A resource URL (img src, srcset entries, CSS url(), iframe src, poster): no query string, emails
 * and 16+ hex-character segments (gravatar-style hashes) replaced, so the player can still load
 * ordinary assets. data:image and blob: URLs stay; other schemes become the bare scheme.
 */
export function scrubResource(url: string): string {
  const s = url.trim();
  if (!s || s[0] === "#") return s;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme === "data") return /^data:image\//i.test(s) ? s : "data:";
  if (scheme === "blob") return s;
  if (scheme && scheme !== "http" && scheme !== "https") return `${scheme}:`;
  return scrubUrlPath(stripQuery(s), (p) =>
    p
      .split("/")
      .map((seg) => (seg.includes("@") || seg.includes("%40") || /^[0-9a-f]{16,}$/i.test(seg) ? ":id" : seg))
      .join("/"),
  );
}

/** "a.png 1x, b.png?sig=x 2x" -> each URL scrubbed as a resource. */
export const scrubSrcset = (v: string): string =>
  v
    .split(",")
    .map((part) => {
      const m = /^(\s*)(\S+)(.*)$/.exec(part);
      return m ? m[1]! + scrubResource(m[2]!) + m[3]! : part;
    })
    .join(",");

/** url(...) references inside CSS text (style attributes, inlined stylesheets) scrubbed as resources. */
export const scrubCss = (css: string): string =>
  css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${scrubResource(u)}${q})`);

/**
 * exclude_paths travel hashed in the public loader config, so the script on every page doesn't
 * list the site's private paths: FNV-1a of site id + "=" + exact path, or "^" + prefix (globs with
 * only a trailing *). Other globs are sent as they are. Obfuscation, not secrecy: the API returns them.
 */
export function pathHash(site: string, s: string): string {
  let h = 0x811c9dc5;
  const t = site + s;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function pathExcluded(path: string, site: string, globs: readonly string[], hashes: readonly string[] | undefined): boolean {
  if (pathMatches(path, globs)) return true;
  if (!hashes || !hashes.length) return false;
  const p = path.slice(0, 300);
  if (hashes.includes(pathHash(site, `=${p}`))) return true;
  for (let i = 0; i <= p.length; i++) if (hashes.includes(pathHash(site, `^${p.slice(0, i)}`))) return true;
  return false;
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
