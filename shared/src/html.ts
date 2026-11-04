/**
 * The start tags of the <script> elements of an HTML page, as a browser's tokenizer finds them.
 * Text that only looks like a tag is skipped: inside comments, attribute values, raw-text and
 * RCDATA elements (style, textarea, title, iframe, noscript, ...) and an inline script's own code
 * (with the HTML spec's `<!-- <script>` escape rules). Domain proofs use it, so a page that
 * repeats a query string or a comment can't count as having the tag. Attribute names are
 * lowercased, values are as written (character references are not decoded), and the first of
 * duplicate attributes wins, as in the browser. Pure.
 *
 * Shared by analytics, replay and tags (their domain proofs), so all three read pages the same way.
 */
export function scriptStartTags(html: string, max = 100): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  const n = html.length;
  let i = 0;
  // Inside <template>, a <script> is parsed but never runs: tokenize it as usual (so its code and
  // strings are skipped properly) but don't count it. Depth follows real start and end tags only.
  let template = 0;
  while (i < n && out.length < max) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const c = html[lt + 1];
    if (c === "!") {
      if (html.startsWith("<!--", lt)) i = commentEnd(html, lt + 4);
      // CDATA is real only in svg/math; skipping to "]]>" can only hide a tag, never invent one.
      else if (html.startsWith("[CDATA[", lt + 2)) i = after(html, "]]>", lt + 9);
      else i = after(html, ">", lt + 2); // doctype, bogus comment
    } else if (c === "?") {
      i = after(html, ">", lt + 2); // bogus comment
    } else if (c === "/") {
      const d = html[lt + 2];
      if (d !== undefined && isAlpha(d)) {
        const end = readTag(html, lt + 2);
        if (!end) break; // cut off by the end of the page
        i = end.end;
        if (end.name === "template" && template > 0) template--;
      } else if (d === ">") i = lt + 3;
      else i = after(html, ">", lt + 2); // bogus comment
    } else if (c !== undefined && isAlpha(c)) {
      const tag = readTag(html, lt + 1);
      if (!tag) break;
      i = tag.end;
      if (tag.name === "script") {
        if (!template) out.push(tag.attrs);
        i = scriptDataEnd(html, i);
      } else if (tag.name === "template") template++;
      else if (tag.name === "plaintext")
        break; // the rest of the page is text
      else if (RAW_TEXT.has(tag.name)) i = rawTextEnd(html, i, tag.name);
    } else i = lt + 1; // a "<" that starts no tag is text
  }
  return out;
}

/** Elements whose content is text up to their own end tag (RAWTEXT and RCDATA; noscript with scripting on). */
const RAW_TEXT = new Set(["style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title"]);

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

/** Index just after the next `s` at or after `from`, or the end of the page. */
function after(html: string, s: string, from: number): number {
  const e = html.indexOf(s, from);
  return e < 0 ? html.length : e + s.length;
}

/** Does the tag name `name` (lowercase) start at `i`, followed by whitespace, "/" or ">"? */
function nameAt(html: string, i: number, name: string): boolean {
  if (html.slice(i, i + name.length).toLowerCase() !== name) return false;
  const c = html[i + name.length];
  return isWs(c) || c === "/" || c === ">";
}

/**
 * A start or end tag from its name (at `i`) to its ">", attributes parsed as the spec's tokenizer
 * does (quoted values may hold ">" and "<"). null when the page ends inside the tag (the browser
 * drops such a tag too).
 */
function readTag(html: string, i: number): { name: string; attrs: Map<string, string>; end: number } | null {
  const n = html.length;
  let j = i;
  while (j < n && !isWs(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
  const name = html.slice(i, j).toLowerCase();
  const attrs = new Map<string, string>();
  for (;;) {
    while (j < n && (isWs(html[j]) || html[j] === "/")) j++;
    if (j >= n) return null;
    if (html[j] === ">") return { name, attrs, end: j + 1 };
    const start = j++; // the first character is part of the name, even "="
    while (j < n && !isWs(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
    const key = html.slice(start, j).toLowerCase();
    while (j < n && isWs(html[j])) j++;
    let value = "";
    if (html[j] === "=") {
      j++;
      while (j < n && isWs(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close < 0) return null;
        value = html.slice(j + 1, close);
        j = close + 1;
      } else {
        const s = j;
        while (j < n && !isWs(html[j]) && html[j] !== ">") j++;
        value = html.slice(s, j);
      }
    }
    if (!attrs.has(key)) attrs.set(key, value);
  }
}

/** Where a comment whose text starts at `from` ends: after "-->" or "--!>" ("<!-->" and "<!--->" are empty comments). */
function commentEnd(html: string, from: number): number {
  if (html[from] === ">") return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  let k = from;
  for (;;) {
    const d = html.indexOf("--", k);
    if (d < 0) return html.length;
    let e = d + 2;
    while (html[e] === "-") e++;
    if (html[e] === ">") return e + 1;
    if (html[e] === "!" && html[e + 1] === ">") return e + 2;
    k = d + 1;
  }
}

/** The "<" of the end tag closing a RAWTEXT / RCDATA element, or the end of the page. */
function rawTextEnd(html: string, from: number, name: string): number {
  let k = from;
  for (;;) {
    const e = html.indexOf("</", k);
    if (e < 0) return html.length;
    if (nameAt(html, e + 2, name)) return e;
    k = e + 2;
  }
}

/**
 * The "<" of the `</script>` that ends an inline script's code, or the end of the page. Follows the
 * spec's script data states: after "<!--" the code is "escaped", where "<script" makes a
 * "</script>" not end it ("double escaped") until "-->".
 */
function scriptDataEnd(html: string, from: number): number {
  const n = html.length;
  let mode = 0; // 0 script data, 1 escaped, 2 double escaped
  let i = from;
  while (i < n) {
    const c = html[i];
    if (c === "<") {
      if (html[i + 1] === "/" && nameAt(html, i + 2, "script")) {
        if (mode !== 2) return i;
        mode = 1;
        i += 8;
        continue;
      }
      if (mode === 0 && html.startsWith("<!--", i)) {
        mode = 1;
        i += 2; // look at the "--" again: "<!-->" leaves the escape at once
        continue;
      }
      if (mode === 1 && nameAt(html, i + 1, "script")) {
        mode = 2;
        i += 7;
        continue;
      }
    } else if (c === "-" && mode !== 0 && html.startsWith("-->", i)) {
      mode = 0;
      i += 3;
      continue;
    }
    i++;
  }
  return n;
}
