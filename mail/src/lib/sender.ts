/**
 * Who sent a message, for fair-use accounting (pure).
 *
 * A sender key is something one party cannot multiply for free: the registrable domain of the
 * authenticated sender ("github.com" for noreply@github.com and bounces@mail.github.com), or the
 * full address on shared mailbox providers, where one domain holds millions of unrelated people
 * (gmail.com, outlook.com, the operator's own shared MAIL_DOMAIN, ...). Random local parts on your
 * own domain all count as that domain; random subdomains count as the registrable domain.
 *
 * The registrable domain is an approximation of the Public Suffix List: the last two labels, or
 * three when the second-level label is a common public second level under a two-letter ccTLD
 * (co.uk, com.au, co.jp, ...). Good enough for caps; never used for authorisation.
 */

const PUBLIC_SECOND_LEVEL = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gob",
  "gov",
  "gv",
  "ltd",
  "me",
  "mil",
  "ne",
  "net",
  "nic",
  "nom",
  "or",
  "org",
  "plc",
  "sch",
]);

/** Shared mailbox providers: the key is the whole address there, not the domain. */
export const SHARED_MAILBOX_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "hotmail.co.uk",
  "outlook.co.uk",
  "live.co.uk",
  "yahoo.com",
  "ymail.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "yandex.ru",
  "yandex.com",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tuta.io",
]);

export function registrableDomain(domain: string): string {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const labels = d.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1]!;
  const sld = labels[labels.length - 2]!;
  if (tld.length === 2 && PUBLIC_SECOND_LEVEL.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

/** local@domain lowercased, "+tag" removed; Gmail ignores dots in the local part, so drop them there. */
function canonicalAddress(local: string, domain: string): string {
  let l = local.toLowerCase();
  const plus = l.indexOf("+");
  if (plus > 0) l = l.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") l = l.replaceAll(".", "");
  return `${l}@${domain}`;
}

/** The sender key of one address (see the file comment). `sharedDomains` adds the operator's MAIL_DOMAIN. */
export function senderKeyOf(address: string | null | undefined, sharedDomains: string[] = []): string {
  const a = (address ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0 || at === a.length - 1) return a ? `invalid:${a.slice(0, 100)}` : "<>";
  const domain = a.slice(at + 1).replace(/\.$/, "");
  const reg = registrableDomain(domain);
  if (SHARED_MAILBOX_DOMAINS.has(domain) || SHARED_MAILBOX_DOMAINS.has(reg) || sharedDomains.includes(domain)) {
    return canonicalAddress(a.slice(0, at), domain);
  }
  return reg;
}

/**
 * Pick the address that identifies the sender, from what authentication vouches for:
 *   - auth verdict "pass": the From address (its domain is authenticated);
 *   - else, Cloudflare saw SPF pass: the envelope sender (SMTP MAIL FROM);
 *   - else a passing DKIM signature: its domain (the signer controls it);
 *   - else the envelope sender as given.
 */
export function senderIdentity(input: {
  fromAddress: string | null;
  envelopeFrom: string | null;
  auth: { verdict: string; trusted: boolean; spf: string | null; dkim_domains: string[] };
}): string | null {
  if (input.auth.verdict === "pass" && input.fromAddress) return input.fromAddress;
  if (input.auth.trusted && input.auth.spf === "pass" && input.envelopeFrom) return input.envelopeFrom;
  if (input.auth.trusted && input.auth.dkim_domains[0]) return `dkim@${input.auth.dkim_domains[0]}`;
  return input.envelopeFrom || input.fromAddress;
}

export interface HeaderLike {
  key: string;
  value: string;
}

/**
 * Mailing-list, bulk or machine-generated mail (pure): List-Id / List-Unsubscribe / List-Post,
 * Precedence bulk|list|junk, Auto-Submitted other than "no" (RFC 3834 auto-replies, which support
 * desks send to anyone who writes in), X-Autoreply / X-Autorespond, delivery reports and
 * bounces (empty envelope sender). Such mail never unlocks SHARED_SEND_POLICY=reply_only: anyone
 * can get a list or a helpdesk to mail an inbox.
 */
export function isAutomated(headers: HeaderLike[], envelopeFrom: string | null | undefined): boolean {
  const env = (envelopeFrom ?? "").trim();
  if (!env || env === "<>") return true;
  for (const h of headers) {
    const k = h.key.toLowerCase();
    const v = h.value.trim().toLowerCase();
    if (k === "list-id" || k === "list-unsubscribe" || k === "list-post" || k === "list-help") return true;
    if (k === "precedence" && /^(bulk|list|junk|auto_reply)\b/.test(v)) return true;
    if (k === "auto-submitted" && v && !v.startsWith("no")) return true;
    if (k === "x-autoreply" || k === "x-autorespond" || k === "x-autogenerated") return true;
    if (k === "content-type" && v.startsWith("multipart/report")) return true;
  }
  return false;
}
