import { isSha256Hex, sha256HexSync } from "./sha256";

/**
 * PII normalisation, per platform, then SHA-256. Shared by the browser runtime (hashes before
 * anything leaves the page) and the Worker (hashes plaintext sent by trusted backends to
 * POST /v1/containers/:id/events). Plaintext is never stored or forwarded.
 *
 * Rules (from each platform's documentation):
 *  - Meta CAPI / TikTok email: trim + lowercase.
 *  - GA4 user-provided data email: trim + lowercase; for gmail.com/googlemail.com remove "." in
 *    the local part.
 *  - Google Ads / Data Manager email: as GA4, and also drop a "+suffix" in the local part.
 *  - Meta phone: digits only incl. country code, no leading zeros, no "+".
 *  - Google (Ads, GA4, Data Manager) and TikTok phone: E.164 ("+" then digits).
 *  - Names: lowercase, trimmed, punctuation/digits/symbols removed (Meta, GA4, Data Manager).
 *  - Meta city: lowercase, no punctuation/spaces. State: lowercase 2-letter code. Zip:
 *    lowercase, no spaces/dashes, US = first 5 digits. Country: lowercase ISO-3166 alpha-2.
 */

export type Platform = "meta" | "tiktok" | "ga4" | "google_ads";

const trimLower = (s: string) => s.trim().toLowerCase();

export function normEmail(raw: unknown, platform: Platform = "meta"): string | null {
  if (typeof raw !== "string") return null;
  let e = trimLower(raw).replace(/\s+/g, "");
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1 || e.indexOf(".", at) === -1) return null;
  if (platform === "ga4" || platform === "google_ads") {
    let local = e.slice(0, at);
    const domain = e.slice(at + 1);
    if (domain === "gmail.com" || domain === "googlemail.com") {
      if (platform === "google_ads") {
        const plus = local.indexOf("+");
        if (plus >= 0) local = local.slice(0, plus);
      }
      local = local.replace(/\./g, "");
      e = `${local}@${domain}`;
    }
  }
  return e;
}

/** Digits with country code (Meta format). `defaultCc` = calling code like "1" or "44". */
export function normPhoneDigits(raw: unknown, defaultCc?: string): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!s) return null;
  let digits = s.replace(/\D/g, "");
  if (!digits) return null;
  let international = false;
  if (s.startsWith("+")) international = true;
  else if (digits.startsWith("00")) {
    digits = digits.replace(/^00/, "");
    international = true;
  }
  if (!international) {
    if (defaultCc) {
      const cc = defaultCc.replace(/\D/g, "");
      digits = digits.replace(/^0+/, "");
      if (!digits.startsWith(cc) || digits.length <= 10) digits = cc + digits;
    } else if (digits.length < 11) {
      return null; // no country code and no default: can't normalise reliably
    }
  }
  digits = digits.replace(/^0+/, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export function normPhoneE164(raw: unknown, defaultCc?: string): string | null {
  const d = normPhoneDigits(raw, defaultCc);
  return d ? `+${d}` : null;
}

/** Names: lowercase, trimmed, letters (any script) and single inner spaces only. */
export function normName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return n || null;
}

export function normCityMeta(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
  return n || null;
}

/** Google (GA4) unhashed city/region: digits and symbols removed, lowercase, trimmed. */
export function normPlaceGoogle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return n || null;
}

export function normStateMeta(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.toLowerCase().replace(/[^\p{L}\p{M}\d]/gu, "");
  return n || null;
}

export function normZip(raw: unknown, country?: string | null): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let z = String(raw).toLowerCase().replace(/[\s-]/g, "");
  if (!z) return null;
  if ((!country || country.toLowerCase() === "us") && /^\d{5,}$/.test(z)) z = z.slice(0, 5);
  return z;
}

export function normCountry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) ? c : null;
}

export const sha256 = (s: string) => sha256HexSync(s);

/** Plain user data, as read from the page or sent by a backend. Never stored. */
export interface RawUserData {
  email?: unknown;
  phone?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
  country?: unknown;
  external_id?: unknown;
}

/**
 * What leaves the browser (and what the server stores): hashes, plus the low-sensitivity address
 * parts Google requires unhashed (city/region/zip/country). Variant hashes (`em_ga4`, `em_gads`)
 * are only present when they differ from `em`.
 */
export interface HashedUserData {
  em?: string;
  em_ga4?: string;
  em_gads?: string;
  ph?: string;
  ph_e164?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  st?: string;
  zp?: string;
  country?: string;
  external_id?: string;
}

/** Accepts either plaintext or an already-hashed (sha256 hex) email/phone. */
export function hashUserData(raw: RawUserData, opts: { phoneCountryCode?: string } = {}): HashedUserData {
  const out: HashedUserData = {};
  const email = raw.email;
  if (isSha256Hex(email)) out.em = email;
  else {
    const m = normEmail(email, "meta");
    if (m) {
      out.em = sha256(m);
      const g = normEmail(email, "ga4");
      const a = normEmail(email, "google_ads");
      if (g && g !== m) out.em_ga4 = sha256(g);
      if (a && a !== m) out.em_gads = sha256(a);
    }
  }
  const phone = raw.phone;
  if (isSha256Hex(phone)) out.ph = phone;
  else {
    const d = normPhoneDigits(phone, opts.phoneCountryCode);
    if (d) {
      out.ph = sha256(d);
      out.ph_e164 = sha256(`+${d}`);
    }
  }
  const fn = isSha256Hex(raw.first_name) ? raw.first_name : normName(raw.first_name);
  if (fn) out.fn = isSha256Hex(fn) ? fn : sha256(fn);
  const ln = isSha256Hex(raw.last_name) ? raw.last_name : normName(raw.last_name);
  if (ln) out.ln = isSha256Hex(ln) ? ln : sha256(ln);
  const ct = normPlaceGoogle(raw.city);
  if (ct) out.ct = ct;
  const st = normPlaceGoogle(raw.state);
  if (st) out.st = st;
  const country = normCountry(raw.country);
  if (country) out.country = country;
  const zp = normZip(raw.zip, country);
  if (zp) out.zp = zp;
  if (raw.external_id != null && raw.external_id !== "") out.external_id = String(raw.external_id).slice(0, 200);
  return out;
}
