/**
 * HTML -> plain text and previews. Pure, dependency-free (runs in Workers and in Node tests).
 * Not a sanitiser: the HTML itself is only ever rendered inside a sandboxed iframe (see /ui).
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  lrm: "",
  rlm: "",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  deg: "°",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
      if (cp === 0xa0) return " ";
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    const v = NAMED[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Zero-width and invisible padding characters that preheaders use to pad the inbox preview. */
const INVISIBLE_RE = /[\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff\u034f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u3164]/g;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, "");
}

const BLOCK_END_RE =
  /<\/(p|div|tr|table|tbody|thead|h[1-6]|li|ul|ol|blockquote|section|article|header|footer|center|pre|dt|dd|title)\s*>/gi;
const BLOCK_START_RE = /<(p|div|tr|table|h[1-6]|li|ul|ol|blockquote|section|article|header|footer|center|pre|hr|dt|dd)\b[^>]*>/gi;

/**
 * Plain text from HTML. Table cells and blocks become separate lines so a code sitting alone
 * in a big table cell ends up alone on its own line (extraction relies on that).
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(head|style|script|noscript|template|svg|object)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<!doctype[^>]*>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(td|th)\s*>/gi, "\n");
  s = s.replace(BLOCK_END_RE, "\n");
  s = s.replace(BLOCK_START_RE, "\n");
  // Images: keep alt text, it often carries the only label of a button.
  s = s.replace(/<img\b[^>]*?\balt\s*=\s*(["'])(.*?)\1[^>]*>/gi, " $2 ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return tidyText(s);
}

/** Collapse runs of spaces, trim lines, keep at most one blank line between paragraphs. */
export function tidyText(s: string): string {
  const lines = stripInvisible(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .split("\n")
    .map((l) => l.trim());
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    if (!l) {
      blank++;
      if (blank === 1 && out.length) out.push("");
      continue;
    }
    blank = 0;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n");
}

const URL_ONLY_RE = /^(?:<?https?:\/\/\S+>?|\[[^\]]*\]|view (?:this email )?in (?:your )?browser\.?)$/i;

/** A short single-line preview: the first meaningful text, URLs dropped, ~160 chars. */
export function makePreview(text: string, max = 160): string {
  const parts: string[] = [];
  let len = 0;
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line || URL_ONLY_RE.test(raw.trim()) || /^>/.test(raw.trim())) continue;
    parts.push(line);
    len += line.length + 1;
    if (len >= max) break;
  }
  const joined = parts.join(" ");
  return joined.length > max ? `${joined.slice(0, max - 1).trimEnd()}…` : joined;
}
