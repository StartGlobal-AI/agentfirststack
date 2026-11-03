/**
 * Names that people and agents choose (a project name at signup, a key name, a rename in the
 * dashboard) end up in pages and in prompts people paste into their agent. One rule for all of
 * them: a single line of visible text. Line breaks, tabs and other control characters (C0, DEL,
 * C1, line and paragraph separators) become spaces; zero-width characters and bidi controls are
 * removed; runs of whitespace become one space; the result is trimmed and cut to `max`
 * characters. Empty -> null.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export function cleanName(raw: unknown, max = 200): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(CONTROL, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  // Cut by code point, so a cut never leaves half a surrogate pair.
  const chars = Array.from(name);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : name;
}
