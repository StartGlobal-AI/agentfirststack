import { analytics } from "./analytics";
import { ga4 } from "./ga4";
import { googleAds } from "./google-ads";
import { linkedin } from "./linkedin";
import { meta } from "./meta";
import { pinterest } from "./pinterest";
import { reddit } from "./reddit";
import { snap } from "./snap";
import { tiktok } from "./tiktok";
import type { Connector } from "./types";
import { webhook } from "./webhook";
import { x } from "./x";

/** Every server-side connector. Add a new platform by writing a Connector and listing it here. */
export const CONNECTORS = {
  ga4,
  meta,
  google_ads: googleAds,
  tiktok,
  linkedin,
  pinterest,
  reddit,
  snap,
  x,
  analytics,
  webhook,
} as unknown as Record<string, Connector>;

export const DESTINATION_TYPES = Object.keys(CONNECTORS) as (
  | "ga4"
  | "meta"
  | "google_ads"
  | "tiktok"
  | "linkedin"
  | "pinterest"
  | "reddit"
  | "snap"
  | "x"
  | "analytics"
  | "webhook"
)[];

export function getConnector(type: string): Connector | undefined {
  return CONNECTORS[type];
}
