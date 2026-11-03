import type { Breakdown, Filter, Metric } from "./filters";
import type { FunnelStep } from "./query";
import type { Interval, Period } from "./time";
import type { Geo } from "./geo";
import type { DeviceInfo } from "./ua";
import type { Channel, ClickIdType } from "./channel";

export type VisitorIdMode = "cookieless" | "persistent";
export type GoalType = "event" | "pageview";

export interface Goal {
  id: string;
  name: string;
  type: GoalType;
  match: string;
  value: number | null;
  created_at: number;
}

/** The copy of a site's settings that lives in its Durable Object (pushed on every change). */
export interface SiteSettings {
  id: string;
  domain: string;
  name: string | null;
  timezone: string;
  visitor_id_mode: VisitorIdMode;
  retention_days: number;
  allowed_hostnames: string[] | null;
  respect_dnt: boolean;
  created_at: number;
  goals: Goal[];
}

export interface Attribution {
  referrer: string | null;
  referrer_host: string | null;
  source: string | null;
  channel: Channel;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  click_id_type: ClickIdType | null;
  click_id: string | null;
}

/** An event after Worker-side enrichment, as handed to SiteDO.ingest(). */
export interface EnrichedEvent extends Attribution, Geo, DeviceInfo {
  ts: number;
  name: string;
  origin: "browser" | "server";
  hostname: string | null;
  /** null for server events sent without a url */
  pathname: string | null;
  url: string | null;
  user_id: string | null;
  props: string | null;
  revenue: number | null;
  currency: string | null;
  engagement_ms: number;
  /** cookieless daily hash (always present) */
  visitor_hash: string;
  /** browser: id the tracker kept in localStorage (used only when the site is in persistent mode) */
  client_visitor_id: string | null;
  /** server: explicit visitor_id (e.g. from afsa.visitorId()); wins over everything */
  explicit_visitor_id: string | null;
  /** GPC / DNT signalled by the browser */
  dnt: boolean;
  /** browser: came through a first-party proxy without a valid x-afs-proxy-key (counted as a warning) */
  proxy_warning?: "proxy_key_missing" | "proxy_key_invalid" | null;
}

export interface IngestOutcome {
  ok: boolean;
  visitor_id?: string;
  session_id?: string;
  reason?: string;
}

export interface IngestResponse {
  /** false when the DO has no settings: the site id is unknown or was deleted */
  known_site: boolean;
  persistent: boolean;
  results: IngestOutcome[];
}

export interface PeriodParams {
  period?: Period;
  from?: string;
  to?: string;
}

export interface StatsRequest extends PeriodParams {
  metrics: Metric[];
  filters: Filter[];
  breakdown?: Breakdown;
  breakdown_metrics?: Metric[];
  compare?: boolean;
  limit?: number;
}

export interface TimeseriesRequest extends PeriodParams {
  metrics: Metric[];
  filters: Filter[];
  interval?: Interval;
}

export interface FunnelRequest extends PeriodParams {
  filters: Filter[];
  steps: FunnelStep[];
}

/** Errors the DO returns as values (thrown errors lose their shape across RPC). */
export interface DoError {
  error: { code: string; message: string; hint?: string };
}

export const isDoError = (v: unknown): v is DoError => typeof v === "object" && v !== null && "error" in v;
