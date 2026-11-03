/**
 * Error grouping. Two occurrences are the same error when their kind, normalised message and
 * source file match: numbers, quoted values, hex ids and URLs are replaced, and content hashes in
 * bundle file names are dropped (app.3f9a2b1c.js and app.77e01d2a.js are the same file).
 */

/** FNV-1a 64-bit, hex. Sync and dependency-free (fingerprints are computed while deriving a chunk). */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * p) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export function normaliseMessage(m: string): string {
  return m
    .replace(/https?:\/\/[^\s'"()]+/g, "<url>")
    .replace(/(['"`])(?:(?!\1).){0,200}\1/g, "$1?$1")
    .replace(/\b0x[0-9a-f]+\b/gi, "N")
    .replace(/\b[0-9a-f]{8,}\b/gi, "X")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** "https://cdn.example.com/assets/app.3f9a2b1c.js" -> "app.js" */
export function normaliseSource(src: string | null | undefined): string {
  if (!src) return "";
  const file = src.split(/[?#]/)[0]!.split("/").pop() ?? "";
  return file
    .replace(/[.-][0-9a-f]{6,}(?=\.)/gi, "")
    .replace(/[.-][A-Za-z0-9_]{8,}(?=\.m?js$)/, "")
    .slice(0, 120);
}

/** The source file of the first stack frame, when the event itself names none. */
export function stackSource(stack: string | null | undefined): string | null {
  if (!stack) return null;
  const m = /(https?:\/\/[^\s)]+?|\/[^\s):]+?\.m?js)(?::\d+){1,2}/.exec(stack);
  return m ? m[1]! : null;
}

export function errorFingerprint(kind: string, message: string, source: string | null | undefined, stack?: string | null): string {
  return fnv1a64(
    `${kind === "rejection" ? "rejection" : "error"}|${normaliseMessage(message)}|${normaliseSource(source || stackSource(stack))}`,
  );
}
