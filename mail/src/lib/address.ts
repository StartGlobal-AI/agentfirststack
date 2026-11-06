import { randomString } from "@afs/shared";

/**
 * Address rules. Pure functions, heavily tested (test/unit/address.test.ts).
 *
 *   username  1-64 chars of a-z 0-9 . _ - ; starts and ends with a letter or digit; no "..".
 *             "+" is not allowed in usernames because it is the sub-address separator:
 *             mail to "acme+meta@domain" is delivered to the inbox "acme@domain".
 *   domain    lowercase ASCII hostname (IDNs are converted to punycode), at least one dot.
 */

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/**
 * Local parts that must never be handed out on a shared domain.
 *
 *   - CA domain validation: certificate authorities send domain-validation mail to admin@,
 *     administrator@, hostmaster@, postmaster@ and webmaster@ (CA/B Baseline Requirements
 *     3.2.2.4.4). Giving them to an arbitrary account would let it obtain TLS certificates for the
 *     operator's domain.
 *   - RFC 2142 role mailboxes (abuse, noc, security, info, sales, ...), mail-system addresses
 *     (mailer-daemon, bounces, dmarc reports) and the names a platform uses for itself (support,
 *     billing, legal, privacy, notifications, verify, ...): mail from them reads as the operator's
 *     own, so an account holding one could phish the operator's users or receive mail meant for it.
 *
 * Matching ignores ".", "_" and "-" (reservedKey): no-reply, no.reply and noreply are one name. The
 * deployment's own brand names belong in EXTRA_RESERVED_USERNAMES (matched the same way). Inboxes
 * created before a name became reserved keep working; src/service/reserved.ts lists them.
 */
export const RESERVED_USERNAMES = new Set([
  // CA validation (BR 3.2.2.4.4) and RFC 2142
  "admin",
  "administrator",
  "hostmaster",
  "postmaster",
  "webmaster",
  "abuse",
  "noc",
  "security",
  "info",
  "marketing",
  "sales",
  "support",
  "usenet",
  "news",
  "uucp",
  "ftp",
  "www",
  "root",
  "ssl-admin",
  // the mail system: senders, bounces, reports
  "mailer-daemon",
  "mailer",
  "mail",
  "email",
  "daemon",
  "nobody",
  "system",
  "sysadmin",
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "bounce",
  "bounces",
  "dmarc",
  "dmarc-reports",
  "rua",
  "ruf",
  "tls-reports",
  "tlsrpt",
  // what a platform uses for itself
  "hello",
  "help",
  "helpdesk",
  "contact",
  "team",
  "staff",
  "owner",
  "official",
  "operator",
  "operations",
  "ops",
  "billing",
  "payments",
  "invoices",
  "receipts",
  "legal",
  "privacy",
  "conduct",
  "compliance",
  "dpo",
  "gdpr",
  "trust",
  "safety",
  "notifications",
  "notification",
  "notify",
  "alerts",
  "alert",
  "status",
  "updates",
  "newsletter",
  "press",
  "media",
  "feedback",
  "careers",
  "jobs",
  "verify",
  "verification",
  "confirm",
  "account",
  "accounts",
  "login",
  "signin",
  "signup",
  "signups",
  "register",
  "registration",
  "password",
  "reset",
  "recovery",
  "auth",
]);

/** The form usernames are compared in against the reserved lists: lowercase, without ".", "_" and "-". Pure. */
export function reservedKey(username: string): string {
  return username.trim().toLowerCase().replace(/[._-]/g, "");
}

const BUILT_IN_RESERVED_KEYS = new Set([...RESERVED_USERNAMES].map(reservedKey));

/** EXTRA_RESERVED_USERNAMES (comma-separated) as reserved keys. Pure. */
export function extraReservedKeys(extra: string | undefined | null): string[] {
  return (extra ?? "").split(",").map(reservedKey).filter(Boolean);
}

/** Every reserved key on the shared domain (built-in + extra), sorted and unique. Pure. */
export function reservedKeys(extra: string | undefined | null): string[] {
  return [...new Set([...BUILT_IN_RESERVED_KEYS, ...extraReservedKeys(extra)])].sort();
}

/** Why a username is reserved on the shared domain: "built_in", "extra", or null when it is not. Pure. */
export function reservedReason(username: string, extra?: string | null): "built_in" | "extra" | null {
  const k = reservedKey(username);
  if (BUILT_IN_RESERVED_KEYS.has(k)) return "built_in";
  if (extraReservedKeys(extra).includes(k)) return "extra";
  return null;
}

export type UsernameCheck = { ok: true; username: string } | { ok: false; reason: string; reserved?: true; username?: string };

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function checkUsername(input: string, opts: { sharedDomain: boolean; extraReserved?: string }): UsernameCheck {
  const username = normalizeUsername(input);
  if (!username) return { ok: false, reason: "Username is empty." };
  if (username.length > 64) return { ok: false, reason: "Username is longer than 64 characters." };
  if (username.includes("+")) {
    return { ok: false, reason: "Usernames cannot contain '+': it is the sub-address separator (acme+tag@ delivers to acme@)." };
  }
  if (!USERNAME_RE.test(username)) {
    return { ok: false, reason: "Use a-z, 0-9, '.', '_' or '-', starting and ending with a letter or digit." };
  }
  if (username.includes("..")) return { ok: false, reason: "Username cannot contain '..'." };
  const reserved = opts.sharedDomain ? reservedReason(username, opts.extraReserved) : null;
  if (reserved === "built_in")
    return { ok: false, reserved: true, username, reason: `"${username}" is a reserved role address on the shared domain.` };
  if (reserved === "extra") return { ok: false, reserved: true, username, reason: `"${username}" is reserved on the shared domain.` };
  return { ok: true, username };
}

/** A random, readable username: 10 chars from the lowercase base32 alphabet (50 bits). */
export function randomUsername(): string {
  // randomString's alphabet is digits + lowercase letters, which satisfies USERNAME_RE.
  return randomString(10);
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lowercase, punycode, strip a trailing dot. Returns null if it is not a valid hostname. */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253 || /[\s/@:?#]/.test(d)) return null;
  if (/[^\x00-\x7f]/.test(d)) {
    try {
      d = new URL(`http://${d}`).hostname; // IDN -> punycode
    } catch {
      return null;
    }
  }
  const labels = d.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null; // IP addresses are not domains
  return d;
}

/** Split "local@domain". Returns null for anything that is not a single, plausible address. */
export function splitAddress(input: string): { local: string; domain: string } | null {
  const s = stripAngle(input.trim());
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  const local = s.slice(0, at);
  const domain = normalizeDomain(s.slice(at + 1));
  if (!domain || local.length > 64 || /[\s<>()\[\],;:"\\]/.test(local)) return null;
  return { local, domain };
}

function stripAngle(s: string): string {
  const m = /<([^<>]+)>\s*$/.exec(s);
  return m ? m[1]!.trim() : s;
}

/**
 * The inbox address an incoming RCPT TO maps to: lowercase, angle brackets stripped, the
 * "+tag" sub-address removed. Returns the tag separately so it can be recorded.
 */
export function normalizeRecipient(input: string): { address: string; tag: string | null } | null {
  const parts = splitAddress(input);
  if (!parts) return null;
  const local = parts.local.toLowerCase();
  const plus = local.indexOf("+");
  const base = plus >= 0 ? local.slice(0, plus) : local;
  const tag = plus >= 0 ? local.slice(plus + 1) : null;
  if (!base) return null;
  return { address: `${base}@${parts.domain}`, tag: tag || null };
}

/** Plus-address tags we record and filter on: a-z 0-9 . _ - = (lowercase), 1-64 characters. */
export const TAG_RE = /^[a-z0-9._=-]{1,64}$/;

/** The tag of a recipient as stored on a message (`me+github@` -> "github"), or null if absent or unusual. Pure. */
export function cleanTag(tag: string | null | undefined): string | null {
  const t = (tag ?? "").trim().toLowerCase();
  return TAG_RE.test(t) ? t : null;
}

/** Validation for outgoing recipients: a conservative subset of RFC 5321 mailboxes. */
const OUT_LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

export function normalizeOutgoingAddress(input: string): string | null {
  const parts = splitAddress(input);
  if (!parts) return null;
  if (!OUT_LOCAL_RE.test(parts.local)) return null;
  const addr = `${parts.local}@${parts.domain}`;
  return addr.length <= 254 ? addr : null;
}

/** Display form "Name <addr>" with the name quoted when needed. */
export function formatAddress(address: string, name?: string | null): string {
  if (!name) return address;
  const safe = name.replace(/[\r\n]/g, " ").trim();
  return /^[\w .'-]+$/.test(safe) ? `${safe} <${address}>` : `"${safe.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}
