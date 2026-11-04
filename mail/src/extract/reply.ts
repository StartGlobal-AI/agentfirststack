/**
 * Reply extraction (pure): the part of a message its sender wrote this time, without the quoted
 * history below it. One forward pass over the lines with string tests only (no backtracking regex
 * over sender text), so hostile input costs linear time; each line is looked at a bounded number
 * of times (a quote header looks at most 4 lines ahead, and only from a short line).
 *
 * The cut is the first of:
 *   - an attribution line: "On <date>, <name> wrote:" (also split over two lines, as Gmail wraps
 *     it), and the same in other languages ("Le ... a écrit :", "Am ... schrieb ...:",
 *     "El ... escribió:", "Il ... ha scritto:", "Op ... schreef ...:", "Em ... escreveu:",
 *     "W dniu ... pisze:", "... написал(а):", "在 ... 写道："). It must carry a digit or "@" (a date,
 *     an address), so "On the other hand, she wrote:" in prose is not a cut;
 *   - a separator: "-----Original Message-----" and its translations, "---------- Forwarded
 *     message ---------";
 *   - an Outlook header block: "From:" followed within 4 lines by "Sent:" or "Date:" and by
 *     "To:" or "Subject:" (with the "____" rule above it, when there is one).
 * Then lines quoted with ">" are dropped, and a trailing "Sent from my iPhone"-style line. The
 * signature stays. A bottom-posted reply (quoted history first, answer below) keeps the unquoted
 * lines after the history. When nothing is left, the whole text is the reply.
 */

/** Lines longer than this are never a quote header (attributions are short). */
const MAX_HEADER_LINE = 600;

const ATTRIBUTION_ENDINGS = [
  "wrote:",
  "a écrit :",
  "a écrit:",
  "a écrit :",
  "escribió:",
  "ha scritto:",
  "escreveu:",
  "napisał:",
  "napisała:",
  "napisał(a):",
  "pisze:",
  "написал:",
  "написала:",
  "написал(а):",
  "写道：",
  "写道:",
  "skrev:",
  "kirjoitti:",
  "yazdı:",
  "schreef:",
  "schrieb:",
];

/** German / Dutch / Scandinavian put the name after the verb: "Am 3. Nov. um 10:00 schrieb Jane <j@x>:". */
const ATTRIBUTION_VERBS = [" schrieb ", " schreef ", " skrev ", " wrote "];

const SEPARATOR_WORDS = [
  "original message",
  "forwarded message",
  "ursprüngliche nachricht",
  "weitergeleitete nachricht",
  "message d'origine",
  "message transféré",
  "mensaje original",
  "mensaje reenviado",
  "messaggio originale",
  "oorspronkelijk bericht",
  "mensagem original",
  "oryginalna wiadomość",
  "ursprungligt meddelande",
];

const MOBILE_SIGNATURES = [
  "sent from my iphone",
  "sent from my ipad",
  "sent from my android",
  "sent from my mobile",
  "sent from my phone",
  "sent from my samsung",
  "sent from my galaxy",
  "sent from mail for windows",
  "sent from outlook",
  "get outlook for ios",
  "get outlook for android",
  "sent from yahoo mail",
  "envoyé de mon iphone",
  "von meinem iphone gesendet",
  "enviado desde mi iphone",
  "inviato da iphone",
  "verzonden vanaf mijn iphone",
];

const hasDigitOrAt = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 48 && c <= 57) || c === 64) return true;
  }
  return false;
};

const startsWithAny = (s: string, prefixes: string[]) => prefixes.some((p) => s.startsWith(p));

/** "on ..." / "le ..." / "am ..." / ... wrote-style line (lowercased, trimmed). */
function isAttribution(l: string): boolean {
  if (l.length > MAX_HEADER_LINE || (!l.endsWith(":") && !l.endsWith("："))) return false;
  if (!hasDigitOrAt(l)) return false;
  if (ATTRIBUTION_ENDINGS.some((e) => l.endsWith(e))) return true;
  return l.endsWith(":") && ATTRIBUTION_VERBS.some((v) => l.includes(v));
}

/** A line that may start a wrapped attribution ("On Tue, 3 Nov 2026 at 10:00, Jane Doe <"). */
function startsAttribution(l: string): boolean {
  return (
    l.length <= MAX_HEADER_LINE &&
    startsWithAny(l, ["on ", "le ", "am ", "el ", "il ", "op ", "em ", "w dniu ", "den ", "在"]) &&
    hasDigitOrAt(l)
  );
}

function isSeparator(l: string): boolean {
  if (l.length > 120) return false;
  const t = l.replace(/^[-_=*\s]+/, "").replace(/[-_=*\s]+$/, "");
  if (t.length === l.length) return false; // no rule around it
  return SEPARATOR_WORDS.some((w) => t === w || t === `${w}:`);
}

const isRule = (l: string) => l.length >= 10 && l.length <= 120 && /^_+$/.test(l);

/** Outlook: "From: ..." then, within 4 lines, "Sent:"/"Date:" and "To:"/"Subject:". */
function isOutlookHeader(lower: string[], i: number): boolean {
  const l = lower[i]!;
  if (l.length > MAX_HEADER_LINE || !startsWithAny(l, ["from:", "de:", "von:", "da:", "van:", "från:", "od:"])) return false;
  let date = false;
  let to = false;
  for (let j = i + 1; j < Math.min(lower.length, i + 5); j++) {
    const n = lower[j]!;
    if (n.length > MAX_HEADER_LINE) break;
    if (startsWithAny(n, ["sent:", "date:", "envoyé :", "envoyé:", "gesendet:", "enviado:", "inviato:", "verzonden:", "skickat:", "data:"]))
      date = true;
    if (
      startsWithAny(n, [
        "to:",
        "subject:",
        "à :",
        "à:",
        "an:",
        "para:",
        "a:",
        "aan:",
        "till:",
        "objet :",
        "betreff:",
        "asunto:",
        "oggetto:",
        "onderwerp:",
        "ämne:",
        "do:",
        "temat:",
      ])
    )
      to = true;
  }
  return date && to;
}

const isQuoted = (line: string) => line.startsWith(">");

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

function dropMobileSignature(lines: string[]): string[] {
  const out = trimBlank(lines);
  const last = out[out.length - 1]?.trim().toLowerCase();
  if (last && last.length <= 80 && MOBILE_SIGNATURES.some((s) => last.startsWith(s))) out.pop();
  return trimBlank(out);
}

/** Where the quoted history starts (index of its first line), and how many lines its header has; or null. */
export function findQuoteStart(lines: string[]): { at: number; header: number } | null {
  const lower = lines.map((l) => (l.length <= MAX_HEADER_LINE ? l.trim().toLowerCase() : ""));
  for (let i = 0; i < lower.length; i++) {
    const l = lower[i]!;
    if (!l) continue;
    if (isAttribution(l)) return { at: i, header: 1 };
    // Wrapped over two lines: "On Tue, 3 Nov 2026 at 10:00, Jane Doe <" + "jane@example.com> wrote:".
    if (i + 1 < lower.length && startsAttribution(l)) {
      const next = lower[i + 1]!;
      if (next && next.length <= MAX_HEADER_LINE && isAttribution(`${l} ${next}`)) return { at: i, header: 2 };
    }
    if (isSeparator(l)) return { at: i, header: 1 };
    if (isOutlookHeader(lower, i)) {
      const rule = i > 0 && isRule(lower[i - 1]!);
      return { at: rule ? i - 1 : i, header: rule ? 2 : 1 };
    }
  }
  return null;
}

/** The new text of a plain-text message (see the file comment). Pure, linear. */
export function extractReply(text: string | null | undefined): string {
  if (!text) return "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cut = findQuoteStart(lines);
  const before = (cut ? lines.slice(0, cut.at) : lines).filter((l) => !isQuoted(l.trimStart()));
  let reply = dropMobileSignature(before);
  if (!reply.length && cut) {
    // Bottom-posted: the history came first. Keep what follows it that is not quoted.
    const after = lines.slice(cut.at + cut.header).filter((l) => !isQuoted(l.trimStart()));
    reply = dropMobileSignature(after);
  }
  if (!reply.length) return trimBlank(lines).join("\n");
  return reply.join("\n");
}
