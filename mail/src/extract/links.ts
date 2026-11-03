import { decodeEntities, htmlToText, stripInvisible } from "./text";

/**
 * Link extraction and classification. Every http(s) link in the message, each with a `kind`:
 *
 *   verify          confirm an email address / activate an account
 *   magic_login     a one-click sign-in link
 *   password_reset  set a new password
 *   unsubscribe     opt out of the list (also from the List-Unsubscribe header)
 *   other           everything else (home page, help, social, tracking, ...)
 *
 * As with codes, precision first: an action kind needs BOTH wording that names the action (in
 * the anchor text, the URL, or the sentence just before a bare link) AND a URL that looks like it
 * carries a one-time token or an action path. A "Log in" link in a newsletter footer that points
 * at https://example.com/login is "other", not "magic_login".
 */

export type LinkKind = "verify" | "magic_login" | "password_reset" | "unsubscribe" | "other";

export interface ExtractedLink {
  url: string;
  kind: LinkKind;
  text: string | null;
}

export interface LinkInput {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  /** Raw List-Unsubscribe header value, if present. */
  listUnsubscribe?: string | null;
}

const MAX_LINKS = 50;
/** Longer URLs are dropped (they would bloat the stored row; real action links are far shorter). */
export const MAX_URL_CHARS = 4096;

const UNSUB_TEXT =
  /unsubscribe|opt[\s-]?out|manage\s+(?:your\s+)?(?:email\s+)?(?:preferences|subscriptions?|notifications)|email\s+preferences|notification\s+settings|stop\s+receiving|update\s+(?:your\s+)?(?:email\s+)?preferences|subscription\s+preferences|no\s+longer\s+(?:wish|want)\s+to\s+receive|(?:don'?t|do\s+not)\s+want\s+(?:to\s+receive|these)|abbestellen|d[ée]sabonner|darse\s+de\s+baja|cancelar\s+suscripci/i;
const UNSUB_URL =
  /unsub|opt[-_]?out|optout|email[-_]?pref|\/preferences|manage[-_]?(?:subscriptions|preferences|notifications)|list-manage\.com\/(?:unsubscribe|profile)|\/subscription[-_]?center/i;

const RESET_TEXT =
  /reset\s+(?:your\s+|my\s+)?password|password\s+reset|change\s+(?:your\s+)?password|(?:set|choose|create)\s+(?:a\s+)?new\s+password|forgot\s+(?:your\s+)?password|recover\s+(?:your\s+)?account|restablecer\s+(?:tu\s+)?contrase|r[ée]initialiser|passwort\s+zur[uü]cksetzen/i;
const RESET_URL =
  /reset[-_]?password|password[-_/]?reset|passwords?\/(?:new|edit|reset)|\/reset\b|\/forgot|\/recover|resetpassword|pwreset|reset[-_]?pw|lostpassword|password[-_]?recovery|mode=resetpassword/i;

const VERIFY_TEXT =
  /\bverify|verification|\bconfirm\b|confirm\s+(?:your\s+)?(?:email|e-mail|account|address|registration|sign[\s-]?up|subscription)|\bactivate|\bvalidate|complete\s+(?:your\s+)?(?:sign[\s-]?up|registration)|finish\s+(?:signing\s+up|setting\s+up|registration)|confirmar|best[aä]tigen|v[ée]rifier|confirmer/i;
const VERIFY_URL =
  /verif|confirm|activat|validat|account_verifications|email[-_]?confirm|registration|signup\/(?:complete|confirm)|double[-_]?opt|opt[-_]?in\/confirm|mode=verifyemail|\/welcome\/confirm/i;

const LOGIN_TEXT =
  /\bsign\s?in\b|\blog\s?in\b|\blogin\b|magic\s+link|sign-in\s+link|login\s+link|\bcontinue\s+to\s+\S+|access\s+your\s+account|open\s+\S+\s+and\s+sign\s+in|iniciar\s+sesi[oó]n|anmelden|se\s+connecter/i;
const LOGIN_EMAIL =
  /\bsign[\s-]?in\b|\blog[\s-]?in\b|\blogin\b|magic\s+link|one[\s-]?click|passwordless|iniciar\s+sesi[oó]n|anmelden|se\s+connecter/i;
const MAGIC_URL =
  /magic|passwordless|\/login\/(?:token|verify|callback|email|link|magic)|\/auth\/(?:callback|email|verify|magic|token|confirm)|\/signin\/(?:token|verify|email|link|callback)|\/sign[-_]?in\/(?:token|verify|email|link)|email[-_]?login|\/z\/|one[-_]?time[-_]?login|login[-_]?link|loginlink|auth\/v1\/verify|mode=signin/i;

/** Anchor text that says nothing about the action ("click here", the URL itself). */
const GENERIC_ANCHOR = /^(?:click\s+here|here|this\s+link|link|open\s+link|button|go|continue|tap\s+here|\S+:\/\/\S+)$/i;

const TOKEN_PARAM =
  /^(?:token|code|key|oobcode|otp|sig|signature|hash|confirmation_token|verification_token|reset_token|login_token|magic|t|k|ticket|nonce|auth|access_token|id_token|jwt|h|s|e|u|uid|link)$/i;

/** Does the URL carry something that looks like a one-time token? */
export function hasToken(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const isRandom = (v: string) => v.length >= 16 && /[a-z]/i.test(v) && /\d/.test(v) && /^[A-Za-z0-9_\-.=%~+]+$/.test(v);
  for (const [k, v] of u.searchParams) {
    if (TOKEN_PARAM.test(k) && v.length >= 6) return true;
    if (isRandom(v)) return true;
  }
  for (const seg of u.pathname.split("/")) if (isRandom(seg)) return true;
  if (u.hash && isRandom(u.hash.slice(1).split(/[&=]/).pop() ?? "")) return true;
  return false;
}

function pathAndQuery(url: string): string {
  try {
    const u = new URL(url);
    let s = `${u.hostname}${u.pathname}${u.search}${u.hash}`;
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep encoded */
    }
    return s.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function classifyLink(url: string, anchor: string, context: string, emailContext: string): LinkKind {
  const where = pathAndQuery(url);
  const text = anchor.trim();
  const generic = !text || GENERIC_ANCHOR.test(text) || text === url;
  // For generic anchors, the sentence before the link names the action ("Click the link below
  // to verify your email: https://..."). Only its tail counts, so a heading three paragraphs up
  // does not leak into a footer link.
  const near = context.slice(-120);
  const label = generic ? `${text} ${near}` : text;
  const token = hasToken(url);
  const verifyish = VERIFY_TEXT.test(label);
  const loginish = LOGIN_TEXT.test(label);

  if (UNSUB_TEXT.test(text) || UNSUB_URL.test(where) || (generic && UNSUB_TEXT.test(near.slice(-80)))) return "unsubscribe";
  if ((RESET_TEXT.test(label) && (token || RESET_URL.test(where))) || (RESET_URL.test(where) && token)) return "password_reset";
  if (verifyish && !loginish && (token || VERIFY_URL.test(where))) return "verify";
  if ((loginish || MAGIC_URL.test(where)) && token && LOGIN_EMAIL.test(`${emailContext} ${label}`)) return "magic_login";
  if ((verifyish && (token || VERIFY_URL.test(where))) || (VERIFY_URL.test(where) && token)) return "verify";
  return "other";
}

const HTTP_RE = /^https?:\/\//i;

function cleanUrl(raw: string): string | null {
  let u = decodeEntities(raw.trim()).replace(/\s+/g, "");
  u = u.replace(/^<|>$/g, "");
  if (!HTTP_RE.test(u)) return null;
  // Trailing punctuation from prose ("...verify: https://x.com/abc.")
  u = u.replace(/[.,;:!?'"”’)\]}>]+$/, (m) => {
    // keep a closing paren if the URL contains an opening one
    if (m.startsWith(")") && u.includes("(")) return ")";
    return "";
  });
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
}

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const TEXT_URL_RE = /<?(https?:\/\/[^\s<>"'\]\[]+)>?/gi;

function anchorText(inner: string): string {
  const alt = /<img\b[^>]*?\balt\s*=\s*(["'])(.*?)\1/i.exec(inner)?.[2] ?? "";
  const t = stripInvisible(decodeEntities(inner.replace(/<[^>]+>/g, " ")))
    .replace(/\s+/g, " ")
    .trim();
  return (t || decodeEntities(alt).trim()).slice(0, 200);
}

function lastSentence(s: string, max = 200): string {
  const tail = s.slice(-max);
  return tail.replace(/\s+/g, " ").trim();
}

interface RawLink {
  url: string;
  text: string;
  context: string;
  pos: number;
}

function linksFromHtml(html: string): RawLink[] {
  const out: RawLink[] = [];
  ANCHOR_RE.lastIndex = 0;
  for (let m = ANCHOR_RE.exec(html); m; m = ANCHOR_RE.exec(html)) {
    const href = HREF_RE.exec(m[1]!);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!raw) continue;
    const url = cleanUrl(raw);
    if (!url) continue;
    const before = htmlToText(html.slice(Math.max(0, m.index - 1500), m.index));
    out.push({ url, text: anchorText(m[2]!), context: lastSentence(before), pos: m.index });
  }
  return out;
}

function linksFromText(text: string): RawLink[] {
  const out: RawLink[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    TEXT_URL_RE.lastIndex = 0;
    for (let m = TEXT_URL_RE.exec(line); m; m = TEXT_URL_RE.exec(line)) {
      const url = cleanUrl(m[1]!);
      if (!url) continue;
      // Context: this line before the URL, plus the nearest non-empty line above.
      let above = "";
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
        if (lines[j]!.trim()) {
          above = lines[j]!.trim();
          break;
        }
      }
      const before = line.slice(0, m.index).replace(/https?:\/\/\S+/gi, " "); // not TEXT_URL_RE: replace() would reset its lastIndex
      // Markdown-ish "[Verify email](https://...)" or "Verify email: https://..."
      const label = /\[([^\]]+)\]\($/.exec(line.slice(0, m.index))?.[1] ?? "";
      out.push({ url, text: label, context: `${above} ${before}`.trim(), pos: offset + m.index });
    }
    offset += line.length + 1;
  }
  return out;
}

const ACTION_ORDER: Record<LinkKind, number> = { verify: 0, magic_login: 1, password_reset: 2, other: 3, unsubscribe: 4 };

export function extractLinks(input: LinkInput): ExtractedLink[] {
  const subject = input.subject ?? "";
  const htmlText = input.html ? htmlToText(input.html) : "";
  const emailContext = `${subject}\n${(input.text ?? "").slice(0, 3000)}\n${htmlText.slice(0, 3000)}`;

  const raw: RawLink[] = [];
  if (input.html) raw.push(...linksFromHtml(input.html));
  if (input.text) raw.push(...linksFromText(input.text).map((l) => ({ ...l, pos: l.pos + 1e7 })));

  const byUrl = new Map<string, ExtractedLink & { pos: number }>();
  for (const l of raw) {
    const kind = classifyLink(l.url, l.text, l.context, emailContext);
    const prev = byUrl.get(l.url);
    if (!prev) byUrl.set(l.url, { url: l.url, kind, text: l.text || null, pos: l.pos });
    else if (ACTION_ORDER[kind] < ACTION_ORDER[prev.kind]) Object.assign(prev, { kind, text: l.text || prev.text });
    else if (!prev.text && l.text) prev.text = l.text;
  }

  // List-Unsubscribe: <https://...>, <mailto:...>
  if (input.listUnsubscribe) {
    for (const m of input.listUnsubscribe.matchAll(/<([^>]+)>/g)) {
      const url = cleanUrl(m[1]!);
      if (url && !byUrl.has(url)) byUrl.set(url, { url, kind: "unsubscribe", text: "List-Unsubscribe", pos: 2e7 });
    }
  }

  return [...byUrl.values()]
    .filter((l) => l.url.length <= MAX_URL_CHARS)
    .sort((a, b) => ACTION_ORDER[a.kind] - ACTION_ORDER[b.kind] || a.pos - b.pos)
    .slice(0, MAX_LINKS)
    .map(({ pos: _pos, ...l }) => l);
}

/** The link an agent most likely wants to open, if any. */
export function primaryActionLink(links: ExtractedLink[]): ExtractedLink | null {
  return links.find((l) => l.kind === "verify" || l.kind === "magic_login" || l.kind === "password_reset") ?? null;
}
