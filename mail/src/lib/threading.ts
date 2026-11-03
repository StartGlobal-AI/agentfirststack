/**
 * Threading helpers (pure). How a message finds its thread:
 *   1. In-Reply-To / References name a message we already hold in the same inbox -> that thread.
 *   2. Otherwise, if the subject carries a reply/forward prefix ("Re:", "Fwd:", "AW:", ...) and
 *      an earlier message in the inbox has the same normalised subject with the same
 *      counterparty within 30 days -> that thread. (For clients that drop the headers.)
 *   3. Otherwise a new thread.
 * Fresh mail with a plain subject never joins a thread by subject alone, so two unrelated
 * "Your verification code" emails stay separate unless their headers link them.
 */

const MSGID_RE = /<[^<>\s]+>/g;

/** All Message-IDs in a header value, in order, deduplicated, each as "<id>". */
export function parseMessageIds(header: string | null | undefined): string[] {
  if (!header) return [];
  const found: string[] = [...(header.match(MSGID_RE) ?? [])];
  // Some senders omit the brackets; accept a single bare id@host as a fallback.
  if (!found.length) {
    const bare = header.trim();
    if (/^[^\s<>@]+@[^\s<>@]+$/.test(bare)) found.push(`<${bare}>`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of found) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Make sure a Message-ID has angle brackets. */
export function bracketMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const t = id.trim();
  if (!t) return null;
  return t.startsWith("<") ? t : `<${t}>`;
}

/**
 * Ids to look up, most specific first: In-Reply-To, then References from the newest end.
 */
export function threadLookupIds(inReplyTo: string | null | undefined, references: string | null | undefined): string[] {
  const ids = [...parseMessageIds(inReplyTo), ...parseMessageIds(references).reverse()];
  return [...new Set(ids)].slice(0, 50);
}

const PREFIX_RE = /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw|rif|r|tr|odp|res|enc)\s*(?:\[\d+\])?\s*[:：]\s*)+/i;
const LIST_TAG_RE = /^\s*\[[^\]]{1,40}\]\s*/;

export function hasReplyPrefix(subject: string | null | undefined): boolean {
  return !!subject && PREFIX_RE.test(subject.replace(LIST_TAG_RE, ""));
}

/** Subject without reply/forward prefixes or a leading [list] tag, whitespace collapsed, lowercase. */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (let i = 0; i < 5; i++) {
    const next = s.replace(LIST_TAG_RE, "").replace(PREFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").toLowerCase();
}

/** "Re: <subject>", without stacking prefixes. */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  if (!s) return "Re:";
  return /^\s*re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * The References header for a reply: the parent's References plus the parent's Message-ID.
 * Email Service caps header values at 2,048 bytes, so long chains keep the root id and the most
 * recent ids (RFC 5322 section 3.6.4 allows trimming the middle).
 */
export function buildReferences(
  parentReferences: string | null | undefined,
  parentMessageId: string | null | undefined,
  maxBytes = 1900,
): string | null {
  const ids = parseMessageIds(parentReferences);
  const parent = bracketMessageId(parentMessageId);
  if (parent && !ids.includes(parent)) ids.push(parent);
  if (!ids.length) return null;
  let out = ids.join(" ");
  if (out.length <= maxBytes) return out;
  const root = ids[0]!;
  const tail: string[] = [];
  let len = root.length;
  for (let i = ids.length - 1; i > 0; i--) {
    const id = ids[i]!;
    if (len + 1 + id.length > maxBytes) break;
    tail.unshift(id);
    len += 1 + id.length;
  }
  out = [root, ...tail].join(" ");
  return out;
}
