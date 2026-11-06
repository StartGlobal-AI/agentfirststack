/**
 * The consent banner's English text (consent_banner.text and .languages override any key). Shared
 * by the banner UI (src/runtime/banner.ts) and the schema catalog. Plain text: the UI sets it with
 * textContent, so markup shows as typed.
 */
export const DEFAULT_BANNER_TEXT = {
  title: "We value your privacy",
  body: "We use cookies and similar technologies to understand how our site is used and to measure and personalize ads. Choose which ones we may use. You can change your choice at any time.",
  accept: "Accept all",
  reject: "Reject all",
  settings: "Customize",
  save: "Save choices",
  settings_title: "Privacy settings",
  privacy: "Privacy policy",
  necessary: "Necessary",
  necessary_desc: "Needed for the site to work and to remember your choice.",
  analytics: "Analytics",
  analytics_desc: "Counts visits and shows how the site is used, so we can improve it.",
  ads: "Advertising",
  ads_desc: "Lets ad platforms measure our ads and receive data about your visit for advertising.",
  personalization: "Personalization",
  personalization_desc: "Remembers your preferences and lets content and ads be personalized for you.",
  always_on: "Always on",
  consent_id: "Your consent ID",
  close: "Close",
  reopen: "Privacy choices",
};
export type BannerText = typeof DEFAULT_BANNER_TEXT;
export const BANNER_TEXT_KEYS = Object.keys(DEFAULT_BANNER_TEXT) as (keyof BannerText)[];
