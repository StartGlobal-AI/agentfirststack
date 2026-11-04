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

/** Elements whose content is never text: dropped together with their content. */
const SKIP_CONTENT = ["head", "style", "script", "noscript", "template", "svg", "object"];
/** Closers of SKIP_CONTENT elements; each search scans forward once (linear). */
const SKIP_CLOSER = new Map(SKIP_CONTENT.map((n) => [n, new RegExp(`<\\/${n}\\s*>`, "gi")]));
/** Closing tags that end a line (table cells too, so a code alone in a cell is alone on its line). */
const BLOCK_END = new Set(
  "p div tr table tbody thead h1 h2 h3 h4 h5 h6 li ul ol blockquote section article header footer center pre dt dd title td th".split(" "),
);
/** Opening tags that start a line. */
const BLOCK_START = new Set(
  "p div tr table h1 h2 h3 h4 h5 h6 li ul ol blockquote section article header footer center pre hr dt dd br".split(" "),
);
const TAG_NAME_RE = /^\/?(\w*)/;
const ALT_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** The alt text of one tag's source (`img src=... alt="..."`), or null. Linear in the tag. */
export function altOf(tag: string): string | null {
  const m = ALT_RE.exec(tag);
  return m ? (m[1] ?? m[2] ?? "") : null;
}

/**
 * Plain text from HTML. Table cells and blocks become separate lines so a code sitting alone
 * in a big table cell ends up alone on its own line (extraction relies on that).
 *
 * One forward pass with indexOf, no backtracking regex over the document: sender-controlled HTML
 * full of unclosed openers ("<style <style ...", "<!--<!--", "<p<p<p") costs linear time. A tag
 * runs from "<" to the next ">"; comments, and head/style/script/noscript/template/svg/object
 * elements, go with their content; an opener whose closer never comes is just a tag (its content
 * stays text), and is not searched for again.
 */
export function htmlToText(html: string): string {
  const s = html;
  const n = s.length;
  const out: string[] = [];
  const unclosed = new Set<string>();
  let commentsClose = true;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out.push(s.slice(i));
      break;
    }
    if (lt > i) out.push(s.slice(i, lt));
    if (commentsClose && s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end >= 0) {
        out.push(" ");
        i = end + 3;
        continue;
      }
      commentsClose = false; // no "-->" anywhere after: later "<!--" are plain tags
    }
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) {
      out.push(s.slice(lt)); // no tag can close after this point: the rest is text
      break;
    }
    if (gt === lt + 1) {
      out.push("<>");
      i = gt + 1;
      continue;
    }
    const tag = s.slice(lt + 1, gt);
    const closing = tag.charCodeAt(0) === 47; // "/"
    const name = (TAG_NAME_RE.exec(tag)?.[1] ?? "").toLowerCase();
    i = gt + 1;
    if (!closing && SKIP_CLOSER.has(name) && !unclosed.has(name)) {
      const re = SKIP_CLOSER.get(name)!;
      re.lastIndex = i;
      const m = re.exec(s);
      if (m) {
        out.push(" ");
        i = m.index + m[0].length;
        continue;
      }
      unclosed.add(name); // never closed: strip just the opener, now and for later ones
    }
    if (closing) out.push(BLOCK_END.has(name) ? "\n" : " ");
    else if (BLOCK_START.has(name)) out.push("\n");
    else if (name === "img") {
      // Keep alt text, it often carries the only label of a button.
      const alt = altOf(tag);
      out.push(alt === null ? " " : ` ${alt} `);
    } else out.push(" ");
  }
  return tidyText(decodeEntities(out.join("")));
}

/** Every tag replaced by a space (like `s.replace(/<[^>]+>/g, " ")`), in linear time. */
export function stripTags(s: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const gt = lt < 0 ? -1 : s.indexOf(">", lt + 1);
    if (gt < 0) {
      out.push(s.slice(i));
      break;
    }
    if (gt === lt + 1) {
      out.push(s.slice(i, gt + 1)); // "<>" is not a tag
    } else {
      out.push(s.slice(i, lt), " ");
    }
    i = gt + 1;
  }
  return out.join("");
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
