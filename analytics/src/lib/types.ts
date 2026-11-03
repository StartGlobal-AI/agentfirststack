import type { Breakdown, Filter, Metric } from "./filters";
import type { FunnelStep } from "./query";
import type { CompareSpec, Interval, Period } from "./time";
import type { Geo } from "./geo";
import type { DeviceInfo } from "./ua";
import type { Channel, ClickIdType } from "./channel";
import type { Exclusions } from "./exclusions";

export type VisitorIdMode = "cookieless" | "persistent";
export type GoalType = "event" | "pageview" | "scroll";

export interface Goal {
  id: string;
  name: string;
  type: GoalType;
  match: string;
  value: number | null;
  /** scroll goals: minimum max-scroll % of the page (1-100); null for other types */
  threshold?: number | null;
  created_at: number;
}

/** The copy of a site's settings that lives in its Durable Object (pushed on every change). */
export interface SiteSettings {
  id: string;
  /** the owning account (suspension and fair-use caps); missing in copies pushed by older releases */
  account_id?: string;
  domain: string;
  name: string | null;
  timezone: string;
  visitor_id_mode: VisitorIdMode;
  retention_days: number;
  allowed_hostnames: string[] | null;
  respect_dnt: boolean;
  /** ingest exclusions (null = none). Older settings copies have no field: treat as null. */
  exclusions?: Exclusions | null;
  /** count revenue sent by the browser tracker ($ / afsa('revenue')); default false: anyone can send it */
  browser_revenue?: boolean;
  /** let user ids from afsa('identify') link payments that carry only a user id; default false */
  trust_browser_user_id?: boolean;
  /** linked replay site (rsite_...): the tracker loads its recorder. Older copies have no field: null. */
  replay_site_id?: string | null;
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
  /**
   * Visitor IP, only so the DO can test it against exclusions.ips in memory. Never stored, never
   * logged, never used as a drop sample.
   */
  ip?: string | null;
  /** engagement beacon: max scroll depth of the page, 0-100 */
  scroll_depth?: number | null;
  /** engagement beacon: Core Web Vitals of the page load (ms, ms, unitless) */
  lcp?: number | null;
  inp?: number | null;
  cls?: number | null;
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
  /** every event was refused for this one reason (suspended account, storage or daily budget) */
  refused?: "account_suspended" | "storage_full" | "daily_limit" | "account_daily_limit" | "platform_daily_budget";
  /** the site's linked replay site from the settings copy (known sites only, not for suspended accounts) */
  replay_site_id?: string | null;
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
  compare?: CompareSpec;
  /** breakdown order: a metric (desc), or change[:metric] (largest absolute change; needs compare) */
  sort?: SortSpec;
  limit?: number;
}

/** Breakdown order. `change` ranks by the absolute change of `metric` against the comparison. */
export type SortSpec = { by: "metric"; metric: Metric } | { by: "change"; metric: Metric };

export interface TimeseriesRequest extends PeriodParams {
  metrics: Metric[];
  filters: Filter[];
  interval?: Interval;
  compare?: CompareSpec;
}

export interface FunnelRequest extends PeriodParams {
  filters: Filter[];
  steps: FunnelStep[];
}

// ------------------------------------------------------------------ payments

export type PaymentType = "new" | "renewal" | "refund";

/**
 * A normalised payment, from the Stripe webhook or POST /v1/sites/:id/payments, as handed to
 * SiteDO.ingestPayments(). `link` attaches a provider customer to a visitor without money (a
 * subscription checkout: its invoices carry the revenue).
 */
export interface PaymentInput {
  provider: string;
  /** provider's id of the payment; (provider, external_id) is the natural key */
  external_id: string;
  /** provider event id (Stripe evt_...), deduped for 30 days; null for the payments API */
  event_id: string | null;
  type: PaymentType | "link";
  /** major units, >= 0 (refunds: amount refunded so far; stored negative) */
  amount: number;
  currency: string | null;
  ts: number;
  visitor_id: string | null;
  session_id: string | null;
  user_id: string | null;
  /** provider customer id; the Worker replaces it with a salted hash before the DO sees it */
  customer: string | null;
  /** refunds: external ids of the payment that was refunded (tried in order) */
  original_refs: string[];
  livemode: boolean;
}

export interface PaymentOutcome {
  ok: boolean;
  id?: string;
  existing?: boolean;
  duplicate_event?: boolean;
  /** how the payment found its visitor: session | visitor | user | customer | original_payment, or null */
  linked_by?: string | null;
  reason?: string;
}

/** Errors the DO returns as values (thrown errors lose their shape across RPC). */
export interface DoError {
  error: { code: string; message: string; hint?: string };
}

export const isDoError = (v: unknown): v is DoError => typeof v === "object" && v !== null && "error" in v;
