// Lowercase Crockford-ish base32 (no i, l, o, u): readable, URL-safe, unambiguous when read aloud.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Uniform random string from a 32-char alphabet (256 % 32 === 0, so `& 31` has no bias). */
export function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** Prefixed id, e.g. newId("site") -> "site_3k9x...". 16 chars = 80 bits. */
export function newId(prefix: string, length = 16): string {
  return `${prefix}_${randomString(length)}`;
}
