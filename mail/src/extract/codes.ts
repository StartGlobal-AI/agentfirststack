import { decodeEntities, htmlToText } from "./text";

/**
 * Verification-code extraction. Pure and deterministic; tuned against test/fixtures.
 *
 * The rule of thumb: a false positive costs more than a miss. An agent that gets a wrong "code"
 * types it into a form and fails confusingly; an agent that gets no code reads the message text.
 * So a token is only reported when there is positive evidence that it is a one-time code:
 *
 *   1. Candidates: 4-10 digits ("482913"), digit groups ("482 913", "482-913"), or upper-case
 *      alphanumerics with at least one digit and one letter ("7Q9XLD", "K7P-2QX"). URLs, email
 *      addresses, prices, percentages, dates, times, phone numbers and version strings are
 *      masked out first; tokens glued to other characters (#123, SKU-1234, 3.14) never count.
 *   2. Evidence (scored): a code keyword shortly before the token on the same line
 *      ("verification code: 482913"), a "<token> is your ... code" phrase after it, or the token
 *      standing alone on its line under a line that names a code (HTML emails put the code in its
 *      own big table cell). Small bonuses: verification wording in the subject or opening, the
 *      token appearing in the subject, the token being the whole content of an HTML element.
 *   3. Vetoes: a nearer "order / invoice / reference / tracking / phone / zip / promo / price ..."
 *      word, a 4-digit year without an adjacent strong keyword, or promo context for
 *      alphanumerics (which also need a strong keyword: "use code SPRING25" is a coupon).
 *
 * Score >= THRESHOLD is reported. The OTP-Token header (draft-goto-otp-token) wins outright.
 */

export const THRESHOLD = 6;
const MAX_CODES = 5;
/**
 * Candidate tokens scored per document (subject, text part, HTML). Real mail has a handful; the
 * cap bounds the per-token work a sender can make us do with a body full of numbers.
 */
export const MAX_CANDIDATES = 500;
/** Of a line above a standalone code, only this much of its end is read for keywords. */
const PREV_LINE_CHARS = 1000;

export interface CodeInput {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  /** Code from the OTP-Token header (postal-mime `otp.code`), if any. */
  otpHeader?: string | null;
  /** htmlToText(html), when the caller already has it. */
  htmlText?: string;
}

export interface CodeCandidate {
  code: string;
  score: number;
  where: "header" | "subject" | "text" | "html";
  line: string;
}

// ---------------------------------------------------------------------------------------------
// Keyword tables (matched against lowercased, masked text)

const STRONG: RegExp[] = [
  /verification\s*code/g,
  /verify\s*code/g,
  /security\s*code/g,
  /log[\s-]?in\s*code/g,
  /sign[\s-]?in\s*code/g,
  /confirmation\s*code/g,
  /authentication\s*code/g,
  /\bauth\s*code/g,
  /access\s*code/g,
  /approval\s*code/g,
  /one[\s-]?time\s*(?:pass\s*)?(?:code|password|passcode|pin|token)/g,
  /\botp\b/g,
  /\bpass\s*code\b/g,
  /\bpasscode\b/g,
  /\b2fa\b/g,
  /\bmfa\b/g,
  /two[\s-]?factor/g,
  /\b2[\s-]?step\b/g,
  /two[\s-]?step/g,
  /\bpin(?:\s*code)?\b/g,
  /launch\s*code/g,
  /temporary\s*code/g,
  /single[\s-]?use\s*code/g,
  /device\s*verification/g,
  /email\s*verification/g,
  /recovery\s*code/g,
  /identity\s*code/g,
  /activation\s*code/g,
  /validation\s*code/g,
  /sms\s*code/g,
  // other languages
  /c[oó]digo\s*de\s*(?:verificaci[oó]n|verifica[cç][aã]o|seguridad|seguran[cç]a|acceso|acesso|confirmaci[oó]n|confirma[cç][aã]o|activaci[oó]n|ativa[cç][aã]o)/g,
  /code\s*de\s*(?:v[ée]rification|confirmation|s[ée]curit[ée]|connexion|validation|activation)/g,
  /best[aä]tigungs(?:code|schl[uü]ssel)|sicherheitscode|verifizierungscode|anmeldecode|einmalcode/g,
  /codice\s*di\s*(?:verifica|sicurezza|accesso|conferma)/g,
  /verificatiecode|beveiligingscode|inlogcode/g,
  /kod\s*(?:weryfikacyjny|potwierdzaj[aą]cy)/g,
  /do[gğ]rulama\s*kodu/g,
  /verifieringskod|bekr[aä]ftelsekod|bekreftelseskode/g,
  /验证码|驗證碼|校验码|認証コード|確認コード|ワンタイムパスワード|인증\s*코드|인증번호|확인\s*코드/g,
  /код\s*(?:подтверждения|безопасности|доступа|верификации)|одноразов\w*\s*(?:код|пароль)/g,
];

const MEDIUM: RegExp[] = [
  /\byour\s+(?:[\p{L}\p{N}'’-]+\s+){0,2}code\b/gu,
  /\bthe\s+code\b/g,
  /\bthis\s+code\b/g,
  /\bcode\s*(?:is|was)\b/g,
  /\bcode\s*[:：]/g,
  /\bfollowing\s+code\b/g,
  /\bcode\s+below\b/g,
  /\benter\s+(?:the\s+|this\s+)?code\b/g,
  /\bverification\b/g,
  /\bverify\b/g,
  /\bc[oó]digo\b/g,
  /\bcode\b(?=\s*(?:[:：]|is|est|ist|es|é))/g,
];

const WEAK: RegExp[] = [/\bcode\b/g, /\bkod\b/g, /\bcode\s*\(/g];

/**
 * Words that mean "this number is something else". A negative that is NEARER the token than
 * any positive keyword vetoes it.
 */
const NEGATIVE: RegExp[] = [
  /\border\b/g,
  /\borders\b/g,
  /\binvoice\b/g,
  /\breceipt\b/g,
  /\btransaction\b/g,
  /\bnumber\b/g,
  /\bno\.\s*$/g,
  /\bnum\b/g,
  /\bnr\.?\b/g,
  /\baccount\s*(?:no|number|#|id)\b/g,
  /\bacct\b/g,
  /\breference\b/g,
  /\bref\b/g,
  /\bbooking\b/g,
  /\breservation\b/g,
  /\btracking\b/g,
  /\bshipment\b/g,
  /\bparcel\b/g,
  /\bticket\b/g,
  /\bcase\b/g,
  /\bclaim\b/g,
  /\bpolicy\b/g,
  /\bmember(?:ship)?\b/g,
  /\bcustomer\b/g,
  /\bclient\b/g,
  /\bsku\b/g,
  /\bitem\b/g,
  /\bqty\b/g,
  /\bquantity\b/g,
  /\btotal\b/g,
  /\bsubtotal\b/g,
  /\bamount\b/g,
  /\bprice\b/g,
  /\bbalance\b/g,
  /\bpayment\b/g,
  /\btax\b/g,
  /\bvat\b/g,
  /\bzip\b/g,
  /\bpostal\b/g,
  /\bpost\s*code\b/g,
  /\bpostcode\b/g,
  /\barea\s*code\b/g,
  /\bpromo/g,
  /\bcoupon/g,
  /\bdiscount/g,
  /\bvoucher/g,
  /\bgift\b/g,
  /\breferral\b/g,
  /\boffer\b/g,
  /\bsave\b/g,
  /\bsale\b/g,
  /\boff\b/g,
  /\bphone\b/g,
  /\bcall\b/g,
  /\btel\b/g,
  /\bfax\b/g,
  /\bext\b/g,
  /\bsuite\b/g,
  /\bstreet\b/g,
  /\bave(?:nue)?\b/g,
  /\bp\.?\s?o\.?\s*box\b/g,
  /\bissue\b/g,
  /\bvol(?:ume)?\b/g,
  /\bchapter\b/g,
  /\bversion\b/g,
  /\bbuild\b/g,
  /\bmodel\b/g,
  /\bserial\b/g,
  /\bsubscribers?\b/g,
  /\bfollowers\b/g,
  /\busers\b/g,
  /\bcustomers\b/g,
  /\bdownloads\b/g,
  /\bmembers\b/g,
  /\bsource\s*code\b/g,
  /\bqr\s*code\b/g,
  /\bdress\s*code\b/g,
  /\bpoints?\b/g,
  /\bmiles\b/g,
  /\bdate\b/g,
  /\byear\b/g,
  /\bcopyright\b/g,
  /©/g,
  /\bpromotion\b/g,
  /\bdeal\b/g,
  /\bconfirmation\s*(?:#|no|number)\b/g,
  /\bpedido\b/g,
  /\bfactura\b/g,
  /\bbestellung\b/g,
  /\bcommande\b/g,
  /\brechnung\b/g,
];

/** A number followed by a noun is a count ("2048 lines", "25 000 subscribers"), not a code. */
const AFTER_NEG_RE =
  /^\s*(?:lines?|words?|people|persons?|users?|stars?|times|items?|steps?|downloads?|views?|subscribers?|followers?|members?|customers?|employees?|companies|teams?|developers?|files?|commits?|tests?|years?|months?|weeks?|days?|hours?|minutes?|seconds?|mins?|secs?|hrs?|percent|points?|miles?|km|kg|lbs?|units?|pages?|calories|sq|square|feet|ft|meters?|reviews?|votes?|likes?|comments?|shares?|orders?|sold|left|remaining|available|in stock|tickets?|seats?|products?|apps?|sites?|countries|cities|stores?|locations?|pull\s+requests?|prs?|requests?|responses?|issues?|repos?|repositories|projects?|libraries|packages?|tools?|tips|ideas|ways|lessons|examples|resources|articles|posts|stories|episodes|videos)\b/i;

/** Promo context makes an alphanumeric candidate a coupon, never an OTP. */
const PROMO_RE = /\b(?:promo|coupon|discount|voucher|off|sale|save|deal|offer|checkout|shop|redeem|gift|referral|free shipping)\b|%/;

/** "<token> is your Facebook code", "<token> — your verification code". */
const AFTER_RE =
  /^\s*(?:(?:is|was|est|ist|es|é|sera|ser[aá])\s+|[-–—:]\s*)(?:your|the|ton|votre|tu|seu|dein|ihr|il\s+tuo|uw)?\s*(?:[\p{L}\p{N}.'’&-]+\s+){0,3}?(?:verification\s+|security\s+|confirmation\s+|login\s+|log[\s-]in\s+|sign[\s-]?in\s+|one[\s-]?time\s+|access\s+|authentication\s+|2fa\s+|otp\s+)?(?:code|otp|passcode|pin|c[oó]digo|kod|код)\b/iu;

/** Verification wording anywhere in subject or opening raises every candidate a little. */
const CODE_SUBJECT_RE = /\b(?:code|pin|otp|passcode)\b/i;
const GLOBAL_RE =
  /verif|one[\s-]?time|\botp\b|passcode|security code|sign[\s-]?in\b|log[\s-]?in\b|login|\b2fa\b|two[\s-]?factor|confirm (?:your )?(?:email|account|identity|sign)|authenticat|launch code|confirmation code|access code|c[oó]digo|best[aä]tigung|验证码|認証/i;
const PROMO_SUBJECT_RE = /\b(?:sale|off|discount|promo|deal|save|coupon|offer)\b|%/i;

// ---------------------------------------------------------------------------------------------
// Masking: remove things that look like codes but are not, before tokenising.

const MASKS: RegExp[] = [
  /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, // URLs
  // emails (incl. masked a***@x.com). The lookbehind starts the local part only at the start of its
  // run: without it, every character of a long run of letters retries the whole run (quadratic).
  /(?<![A-Za-z0-9._%+*-])[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?:[$€£¥₹₩₽¢]|\b(?:usd|eur|gbp|cad|aud|inr|jpy|chf|sek|nok|dkk|nzd|sgd|hkd|mxn|brl|zar|rs\.?|r\$|us\$|ca\$|a\$)\s?)\s?\d[\d,.]*/gi, // money, symbol first
  // money, unit after. Bounded: "1,1,1,1,..." would otherwise rescan the run from every digit.
  /\b\d[\d,]{0,40}(?:\.\d+)?\s?(?:usd|eur|gbp|cad|aud|inr|jpy|dollars?|euros?|pounds?|cents?)\b/gi,
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, // 1,299 / 25,000
  /\b\d+[.,]\d{1,2}\b(?![.,]?\d)/g, // 12.99 / 4,5
  /\b\d+(?:[.,]\d+)?\s?%/g, // percentages
  /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi, // ISO dates
  /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/g, // 12/31/2024, 31.12.2024
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)?/gi, // times
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/gi,
  /\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){1,4}\d{2,5}/g, // +1 415 555 0100, +44 (20) 7946 0958
  /\(\d{2,4}\)\s?\d{3,4}[\s.-]?\d{3,4}/g, // (415) 555-0100
  /\b1?[\s.-]?\d{3}[.-]\d{3}[.-]\d{4}\b/g, // 1-800-555-0199, 415.555.0100
  /\b\d{3}\s\d{3}\s\d{4}\b/g, // 415 555 0100
  /\bv?\d+(?:\.\d+){2,}\b/gi, // versions, IPs
  /\b\d+(?:px|pt|em|rem|kb|mb|gb|tb|ms|mhz|ghz|mp|k|m|x)\b/gi, // units
];

function maskLine(line: string): string {
  let s = line;
  for (const re of MASKS) s = s.replace(re, " ¤ ");
  return s;
}

// Candidate tokens. Boundaries: nothing glued on either side (no "#123", "SKU-1234", "3.14").
const TOKEN_RE =
  /(?<![\p{L}\p{N}#\-_/.,$€£¥₹+@&=%¤*~^])(\d{3,5}[ -]\d{3,5}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4}|\d{4,10}|[A-Z0-9]{4,10})(?![\p{L}\p{N}\-_/@%¤]|[.,]\d)/gu;
const SPACED_RE = /^(?:[0-9A-Z][ \u00a0]){3,9}[0-9A-Z]$/;

interface Token {
  raw: string;
  code: string;
  alnum: boolean;
  start: number;
}

function tokensIn(masked: string, max = Number.POSITIVE_INFINITY): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(masked); m && out.length < max; m = TOKEN_RE.exec(masked)) {
    const raw = m[1]!;
    const t = normaliseToken(raw);
    if (t) out.push({ ...t, raw, start: m.index });
  }
  return out;
}

function normaliseToken(raw: string): { code: string; alnum: boolean } | null {
  const hasLetter = /[A-Z]/.test(raw);
  const hasDigit = /\d/.test(raw);
  if (!hasDigit) return null;
  const sep = /[ -]/.exec(raw);
  if (sep) {
    const [a, b] = raw.split(/[ -]/) as [string, string];
    if (Math.abs(a.length - b.length) > 1) return null;
    if (!hasLetter) return { code: a + b, alnum: false }; // digit groups are visual only
    if (raw.includes(" ")) return null; // "AB12 CD34": too likely two words
    return { code: raw, alnum: true }; // keep the dash in "K7P-2QX"
  }
  if (hasLetter) {
    if ((raw.match(/\d/g) ?? []).length < 1 || (raw.match(/[A-Z]/g) ?? []).length < 1) return null;
    return { code: raw, alnum: true };
  }
  return { code: raw, alnum: false };
}

// ---------------------------------------------------------------------------------------------
// Scoring

type Tier = "strong" | "medium" | "weak";

/** Distance (in chars) from the END of the nearest match to the end of `s`, or null. */
function nearestEnd(s: string, res: RegExp[]): number | null {
  let best: number | null = null;
  for (const re of res) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const d = s.length - (m.index + m[0].length);
      if (best === null || d < best) best = d;
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return best;
}

function nearestPositive(s: string): { tier: Tier; dist: number } | null {
  const strong = nearestEnd(s, STRONG);
  const medium = nearestEnd(s, MEDIUM);
  const weak = nearestEnd(s, WEAK);
  const opts: { tier: Tier; dist: number }[] = [];
  if (strong !== null) opts.push({ tier: "strong", dist: strong });
  if (medium !== null) opts.push({ tier: "medium", dist: medium });
  if (weak !== null) opts.push({ tier: "weak", dist: weak });
  if (!opts.length) return null;
  // Best = highest score contribution at its distance; ties broken by distance.
  opts.sort((x, y) => sameLinePoints(y) - sameLinePoints(x) || x.dist - y.dist);
  return opts[0]!;
}

function sameLinePoints(p: { tier: Tier; dist: number }): number {
  if (p.tier === "strong") return p.dist <= 40 ? 6 : p.dist <= 100 ? 4 : 0;
  if (p.tier === "medium") return p.dist <= 5 ? 5 : p.dist <= 25 ? 4 : 0;
  return p.dist <= 25 ? 2 : 0;
}

function prevLinePoints(tier: Tier, distance: number): number {
  // distance: 0 = the line right above, 1 = two lines above.
  if (tier === "strong") return distance === 0 ? 5 : 3;
  if (tier === "medium") return distance === 0 ? 4 : 2;
  return distance === 0 ? 2 : 0;
}

function isYearLike(code: string): boolean {
  if (!/^\d{4}$/.test(code)) return false;
  const n = Number(code);
  return n >= 1900 && n <= 2099;
}

interface Doc {
  where: "subject" | "text" | "html";
  lines: string[]; // original lines
}

/** Characters that do not count as content next to a token (a line holding only a code and these is "standalone"). */
const SEPARATORS_RE = /[\s¤:：.,;!?()"'*_\-–—|]+/g;
const contentLength = (s: string) => s.replace(SEPARATORS_RE, "").length;

/**
 * Per-document context for scoring. Everything that depends only on a line (or on the whole HTML)
 * is computed once, not once per token: a long line full of numbers must not cost
 * tokens x line length.
 */
interface ScoreCtx {
  global: boolean;
  /** Trimmed text of every HTML element whose whole content is short text (see `emphasised`). */
  emphasis: Set<string> | null;
}

function scoreDoc(doc: Doc, ctx: ScoreCtx, out: CodeCandidate[]) {
  const masked = doc.lines.map((l) => maskLine(l));
  const lower = masked.map((l) => l.toLowerCase());
  const prevCache = new Map<number, { p: { tier: Tier; dist: number } | null; n: number | null }>();
  const prevKeywords = (j: number, prev: string) => {
    let c = prevCache.get(j);
    if (!c) {
      const tail = prev.slice(-PREV_LINE_CHARS);
      c = { p: nearestPositive(tail), n: nearestEnd(tail, NEGATIVE) };
      prevCache.set(j, c);
    }
    return c;
  };
  let budget = MAX_CANDIDATES;
  for (let i = 0; i < doc.lines.length && budget > 0; i++) {
    const original = doc.lines[i]!;
    if (/^\s*>/.test(original)) continue; // quoted reply text
    let tokens = tokensIn(masked[i]!, budget);
    let standaloneOverride = false;
    const trimmed = original.trim();
    if (!tokens.length && SPACED_RE.test(trimmed)) {
      // "4 8 2 9 1 3": letter-spaced code in its own cell
      const joined = trimmed.replace(/[ \u00a0]/g, "");
      const t = normaliseToken(joined);
      if (t) {
        tokens = [{ ...t, raw: trimmed, start: original.indexOf(trimmed) }];
        standaloneOverride = true;
      }
    }
    if (!tokens.length) continue;
    budget -= tokens.length;
    const lineContent = contentLength(lower[i]!);
    let promo: boolean | null = null; // PROMO_RE over this line and the one above, once per line
    for (const tok of tokens) {
      const before = lower[i]!.slice(Math.max(0, tok.start - 120), tok.start);
      const after = masked[i]!.slice(tok.start + tok.raw.length, tok.start + tok.raw.length + 80);
      const afterMatch = AFTER_RE.test(after);
      // Nothing but separators besides the token on its line.
      const standalone = standaloneOverride || lineContent === contentLength(tok.raw.toLowerCase());

      const pos = nearestPositive(before);
      const neg = nearestEnd(before, NEGATIVE);
      let strongEvidence = afterMatch || (pos?.tier === "strong" && sameLinePoints(pos) > 0);
      let score = 0;

      if (AFTER_NEG_RE.test(after)) continue; // "2048 lines"
      if (neg !== null && neg <= 40 && (!pos || neg < pos.dist) && !afterMatch) continue; // vetoed
      if (pos) score = sameLinePoints(pos);
      if (pos && sameLinePoints(pos) > 0 && /[:：]\s*$/.test(before)) score += 1; // "label: 482913"
      if (neg !== null && neg <= 40) score -= 2; // a positive is nearer, but something else is close
      if (afterMatch) score = Math.max(score, 6);

      if (standalone) {
        score += 2;
        // Look at up to two non-empty lines above.
        let best = 0;
        let seen = 0;
        let vetoed = false;
        for (let j = i - 1; j >= 0 && seen < 2; j--) {
          const prev = lower[j]!.trim();
          if (!prev || prev === "¤") continue;
          const { p, n } = prevKeywords(j, prev);
          if (seen === 0 && n !== null && (!p || n < p.dist)) {
            vetoed = true;
            break;
          }
          if (p) {
            best = Math.max(best, prevLinePoints(p.tier, seen));
            if (p.tier === "strong") strongEvidence = true;
          }
          seen++;
        }
        if (vetoed) continue;
        // The line below sometimes carries the label ("482913" / "is your verification code").
        const next = doc.lines[i + 1]?.slice(0, 200);
        if (
          next &&
          AFTER_RE.test(` is ${next}`) &&
          /code|otp|passcode|pin/i.test(next) &&
          /^\s*(?:is|this|that|that's|-|–|—)/i.test(next)
        ) {
          best = Math.max(best, 4);
          strongEvidence = true;
        }
        score += best;
      }

      if (isYearLike(tok.code) && !(afterMatch || (pos?.tier === "strong" && pos.dist <= 15))) continue;

      promo ??= PROMO_RE.test(`${lower[i]!} ${lower[i - 1] ?? ""}`);
      if (tok.alnum) {
        if (!strongEvidence) continue; // "use code SPRING25" is a coupon
        if (promo) continue;
      } else if (!strongEvidence && promo) {
        continue; // "use code 2468 at checkout"
      }

      if (doc.where === "subject") score += 1;
      if (ctx.global) score += 1;
      if (ctx.emphasis?.has(tok.raw)) score += 1;

      out.push({ code: tok.code, score, where: doc.where, line: original.trim().slice(0, 200) });
    }
  }
}

/** Longest element content kept for `emphasised` (tokens are at most ~20 characters). */
const MAX_EMPHASIS_CHARS = 40;

/**
 * The trimmed text of every element whose entire content is plain text (`<td ...> 482913 </td>`):
 * the runs between a ">" and the next "<". A token is emphasised when it is one of them. One pass
 * over the HTML, instead of one regex search over all of it per token.
 */
export function emphasisSet(html: string): Set<string> {
  const out = new Set<string>();
  let gt = html.indexOf(">");
  while (gt >= 0) {
    const lt = html.indexOf("<", gt + 1);
    if (lt < 0) break;
    const next = html.lastIndexOf(">", lt - 1); // the ">" nearest before this "<"
    const t = html.slice(next + 1, lt).trim();
    if (t && t.length <= MAX_EMPHASIS_CHARS) out.add(t);
    gt = html.indexOf(">", lt + 1);
  }
  return out;
}

/** All scored candidates (for tests and debugging), best first. */
export function scoreCodes(input: CodeInput): CodeCandidate[] {
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const text = input.text ?? "";
  const htmlText = input.htmlText ?? (input.html ? htmlToText(input.html) : "");
  const opening = `${text.slice(0, 1500)}\n${htmlText.slice(0, 1500)}`;
  const promoSubject = PROMO_SUBJECT_RE.test(subject);
  const global = GLOBAL_RE.test(subject) || GLOBAL_RE.test(opening) || (CODE_SUBJECT_RE.test(subject) && !promoSubject);
  const subjectBonus = global && !promoSubject;

  const raw: CodeCandidate[] = [];
  if (input.otpHeader && /^[\x21-\x7e]{4,32}$/.test(input.otpHeader)) {
    raw.push({ code: input.otpHeader, score: 100, where: "header", line: "OTP-Token header" });
  }
  scoreDoc({ where: "subject", lines: [subject] }, { global: subjectBonus, emphasis: null }, raw);
  if (text.trim()) scoreDoc({ where: "text", lines: text.split(/\r?\n/) }, { global, emphasis: null }, raw);
  if (htmlText.trim())
    scoreDoc({ where: "html", lines: htmlText.split("\n") }, { global, emphasis: emphasisSet(decodeEntities(input.html ?? "")) }, raw);

  // Merge by code: best score, +1 when it is corroborated in a second place.
  const byCode = new Map<string, CodeCandidate & { places: Set<string> }>();
  for (const c of raw) {
    const prev = byCode.get(c.code);
    if (!prev) byCode.set(c.code, { ...c, places: new Set([c.where === "html" ? "text" : c.where]) });
    else {
      prev.places.add(c.where === "html" ? "text" : c.where);
      if (c.score > prev.score) Object.assign(prev, { score: c.score, where: c.where, line: c.line });
    }
  }
  const merged = [...byCode.values()].map(({ places, ...c }) => ({ ...c, score: c.score + (places.size > 1 ? 1 : 0) }));
  return merged.sort((a, b) => b.score - a.score);
}

/** Codes worth acting on, best first (at most 5). */
export function extractCodes(input: CodeInput): string[] {
  return scoreCodes(input)
    .filter((c) => c.score >= THRESHOLD)
    .slice(0, MAX_CODES)
    .map((c) => c.code);
}
