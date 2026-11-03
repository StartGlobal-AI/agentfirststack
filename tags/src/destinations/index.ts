import { analytics } from "./analytics";
import { ga4 } from "./ga4";
import { googleAds } from "./google-ads";
import { meta } from "./meta";
import { tiktok } from "./tiktok";
import type { Connector } from "./types";
import { webhook } from "./webhook";

/** Every server-side connector. Add a new platform by writing a Connector and listing it here. */
export const CONNECTORS = {
  ga4,
  meta,
  google_ads: googleAds,
  tiktok,
  analytics,
  webhook,
} as unknown as Record<string, Connector>;

export const DESTINATION_TYPES = Object.keys(CONNECTORS) as ("ga4" | "meta" | "google_ads" | "tiktok" | "analytics" | "webhook")[];

export function getConnector(type: string): Connector | undefined {
  return CONNECTORS[type];
}
