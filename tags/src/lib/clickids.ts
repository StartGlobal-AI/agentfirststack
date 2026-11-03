/** URL click identifiers captured on landing (lowercase key -> canonical name). */
export const CLICK_IDS = [
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "li_fat_id",
  "twclid",
  "rdt_cid",
  "epik",
  "ScCid",
] as const;
export type ClickIdName = (typeof CLICK_IDS)[number];

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"] as const;

/** Days a click id cookie lives (Google Ads accepts conversions up to 90 days after the click). */
export const CLICK_ID_DAYS = 90;
export const VISITOR_COOKIE = "_afst_vid";
export const CONSENT_COOKIE = "_afst_consent";
export const FIRST_TOUCH_COOKIE = "_afst_ft";
export const clickCookieName = (id: string) => `_afst_${id.toLowerCase()}`;
