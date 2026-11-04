/** Consent model shared by the runtime (gating tags) and the server (gating destinations). */
export const CONSENT_TYPES = [
  "ad_storage",
  "analytics_storage",
  "ad_user_data",
  "ad_personalization",
  "functionality_storage",
  "personalization_storage",
  "security_storage",
] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];
export type ConsentValue = "granted" | "denied";
export type ConsentState = Partial<Record<ConsentType, ConsentValue>>;

/** EU 27 + Iceland, Liechtenstein, Norway. */
export const EEA = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
];

export interface ConsentConfigLike {
  mode?: "none" | "opt_in" | "opt_out";
  default?: ConsentState;
  regions?: Record<string, ConsentState>;
}

/** Tag types -> consent required when the tag doesn't say (`consent` omitted). */
export const DEFAULT_TAG_CONSENT: Record<string, ConsentType[]> = {
  ga4: ["analytics_storage"],
  google_ads: ["ad_storage"],
  meta_pixel: ["ad_storage"],
  tiktok_pixel: ["ad_storage"],
  linkedin_insight: ["ad_storage"],
  microsoft_uet: ["ad_storage"],
  reddit_pixel: ["ad_storage"],
  x_pixel: ["ad_storage"],
  pinterest_tag: ["ad_storage"],
  snap_pixel: ["ad_storage"],
  image_pixel: ["ad_storage"],
  analytics: [],
  custom_html: [],
  custom_js: [],
};

/**
 * Effective consent for a visitor before they choose: mode baseline, then `default`, then the
 * most specific matching region ("US-CA" > "US" > "EEA").
 */
export function initialConsent(
  cfg: ConsentConfigLike | undefined,
  country?: string | null,
  region?: string | null,
): Record<ConsentType, ConsentValue> {
  const mode = cfg?.mode ?? "none";
  const base: ConsentValue = mode === "opt_in" ? "denied" : "granted";
  const state = {} as Record<ConsentType, ConsentValue>;
  for (const t of CONSENT_TYPES) state[t] = base;
  state.security_storage = "granted";
  Object.assign(state, cfg?.default ?? {});
  const regions = cfg?.regions ?? {};
  const cc = (country ?? "").toUpperCase();
  const candidates: string[] = [];
  if (cc && region) candidates.push(`${cc}-${String(region).toUpperCase()}`);
  if (cc) candidates.push(cc);
  if (cc && EEA.indexOf(cc) !== -1) candidates.push("EEA");
  for (const key of candidates) {
    if (regions[key]) {
      Object.assign(state, regions[key]);
      break;
    }
  }
  return state;
}

/**
 * Apply a consent update. Consent Mode v1 CMPs only send ad_storage; then ad_user_data and
 * ad_personalization follow ad_storage so server-side ad destinations aren't stuck at denied.
 */
export function applyConsentUpdate(state: Record<ConsentType, ConsentValue>, update: ConsentState): Record<ConsentType, ConsentValue> {
  const next = { ...state };
  for (const k of Object.keys(update) as ConsentType[]) {
    const v = update[k];
    if (v === "granted" || v === "denied") next[k] = v;
  }
  if (update.ad_storage && update.ad_user_data === undefined) next.ad_user_data = update.ad_storage;
  if (update.ad_storage && update.ad_personalization === undefined) next.ad_personalization = update.ad_storage;
  return next;
}

export const isGranted = (state: Partial<Record<ConsentType, ConsentValue>> | undefined, types: readonly ConsentType[]) =>
  types.every((t) => (state?.[t] ?? "granted") === "granted");

/**
 * Consent from a TCF v2 CMP (__tcfapi): ad_storage <- purpose 1; analytics_storage <- purposes
 * 1 and 8; ad_user_data <- purposes 1 and 7; ad_personalization <- purposes 3 and 4. Where GDPR
 * doesn't apply (gdprApplies false) consent is left as configured. The TC string rides along with
 * /collect hits (tcf.tc_string) for server destinations and webhooks.
 */
export function tcfConsent(td: { purpose?: { consents?: Record<string, boolean> } }) {
  const p = (n: number) => !!td.purpose?.consents?.[n];
  const g = (b: boolean) => (b ? ("granted" as const) : ("denied" as const));
  return { ad_storage: g(p(1)), analytics_storage: g(p(1) && p(8)), ad_user_data: g(p(1) && p(7)), ad_personalization: g(p(3) && p(4)) };
}
