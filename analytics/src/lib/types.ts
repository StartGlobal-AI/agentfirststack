import type { Item } from "./items";
import type { Breakdown, Filter, FilterExpr, Metric } from "./filters";
import type { ProtectionMode } from "@afs/shared";
import type { DebugMode, FunnelMode, FunnelStep, FunnelWindow } from "./query";
import type { CompareSpec, Interval, Period } from "./time";
import type { Geo } from "./geo";
import type { DeviceInfo } from "./ua";
import type { Channel, ClickIdType } from "./channel";
import type { Exclusions } from "./exclusions";

export type VisitorIdMode = "cookieless" | "persistent";

/**
 * Why a browser event was quarantined (stored with debug = 2, out of reports and of the daily event
 * budget): its network passed its daily share, or it came from a data-centre network while the site
 * was under attack (or with protection strict).
 */
export const QUARANTINE_REASONS = ["network_share", "datacenter"] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/** A path cleaning rule: `*` matches one path segment, `**` any run of characters. */
export interface PathRule {
  match: string;
  replace: string;
}
export type GoalType = "event" | "pageview" | "scroll";

export interface Goal {
  id: string;
  name: string;
  type: GoalType;
  match: string;
  value: number | null;
  /** scroll goals: minimum max-scroll % of the page (1-100); null for other types */
  threshold?: number | null;
  /** prop conditions: every key must equal the event's prop (strings); null = none */
  props?: Record<string, string> | null;
  /** every matching event counts (default), or only the first per visit */
  counting?: "every" | "once_per_visit";
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
  /** count user properties sent by afsa('identify', id, props) (older copies: false) */
  browser_user_props?: boolean;
  /** let user ids from afsa('identify') link payments that carry only a user id; default false */
  trust_browser_user_id?: boolean;
  /** linked replay site (rsite_...): the tracker loads its recorder. Older copies have no field: null. */
  replay_site_id?: string | null;
  /** where the site's own replay proxy lives ("/_r"): path-proxy events get the replay loader there (older copies: none) */
  replay_proxy_path?: string | null;
  /** referrer hosts treated as no referrer, on top of DEFAULT_IGNORED_REFERRERS (older copies: none) */
  ignored_referrers?: string[] | null;
  /** path cleaning rules applied at ingest, in order (older copies: none) */
  path_rules?: PathRule[] | null;
  /** replace emails and phone numbers before storing; older copies have no field: treated as true */
  redact_pii?: boolean;
  /** query parameters that carry a site search term (older copies: none) */
  search_params?: string[] | null;
  /** reporting currency (ISO 4217): money in other currencies is converted at ingest (older copies: none) */
  currency?: string | null;
  /** content groups, first match wins, evaluated at query time (older copies: none) */
  content_groups?: { name: string; match: string }[] | null;
  /** minutes of inactivity that end a session (older copies: 30) */
  session_timeout_minutes?: number | null;
  /** custom channel groups, first match wins, evaluated at query time */
  channel_groups?: ChannelGroup[] | null;
  /** attack protection: auto (default; older copies have no field), strict or off */
  protection?: ProtectionMode;
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
  utm_id?: string | null;
  utm_source_platform?: string | null;
  utm_creative_format?: string | null;
  utm_marketing_tactic?: string | null;
  click_id_type: ClickIdType | null;
  click_id: string | null;
}

export type IngestPath = "direct" | "proxy" | "edge";

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
  /** engagement beacon sent as the page unloaded (pagehide, not kept in the back/forward cache) */
  leave?: boolean;
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
   * browser: how it reached the collector, counted per day (usage.via_*): straight to the analytics
   * host (which ad blockers block), through the site's own proxy (a path prefix or its proxy key),
   * or through a first-party domain on the platform's edge (then `edge_host` is that hostname)
   */
  via?: IngestPath;
  edge_host?: string | null;
  /**
   * Visitor IP, only so the DO can test it against exclusions.ips in memory. Never stored, never
   * logged, never used as a drop sample.
   */
  ip?: string | null;
  /** user properties to set on the event's user (server user_props, afsa('identify', id, props)); null = unset */
  user_props?: Record<string, string | null> | null;
  /** ecommerce events: their items (lib/items.ts), capped per site in the DO */
  items?: Item[] | null;
  /** engagement beacon: max scroll depth of the page, 0-100 */
  scroll_depth?: number | null;
  /** test traffic (afsa('debug') / data-debug, debug: true on server events): kept out of reports by default */
  debug?: boolean;
  /** primary language subtag (Accept-Language, or the server event's language) */
  language?: string | null;
  /** viewport class xs | sm | md | lg (browser pageviews) */
  screen?: string | null;
  /** document.title (browser pageviews with data-title="true"), 200 chars */
  title?: string | null;
  /** false: a non-interactive event (doesn't un-bounce a session) */
  interactive?: boolean;
  /**
   * false (server events, visit: false): never opens a visit. It joins the visitor's live session
   * when there is one; otherwise it is stored with no visitor or session (events.no_visit = 1).
   */
  visit?: boolean;
  /** the page URL's query string, only so the DO can read site_search params; never stored */
  search_query?: string | null;
  /** the site_search term the DO extracted (set in the DO, redacted) */
  search_term?: string | null;
  /** engagement beacon: Core Web Vitals of the page load (ms, ms, unitless) */
  lcp?: number | null;
  inp?: number | null;
  cls?: number | null;
  /**
   * Browser events: a keyed hash of the client's network (networkKey: IPv4 address or IPv6 /48)
   * with the daily salt, the site id and the UTC day, for the network's daily share. Never the
   * address or the network itself; it changes every day.
   */
  net_hash?: string | null;
}

export interface IngestOutcome {
  ok: boolean;
  visitor_id?: string;
  session_id?: string;
  reason?: string;
  /** the event opened a new session */
  new_session?: boolean;
  /** visit: false and no live session: stored with no visitor or session (visitor_id / session_id are not returned) */
  no_visit?: boolean;
  /** an engagement beacon (it updates its pageview, it doesn't add a row) */
  engagement?: boolean;
  /** a leave beacon with no visible time: not counted against the daily budget */
  uncounted?: boolean;
  /** validate_only: the row that would have been stored */
  stored?: Record<string, unknown> | null;
  /** validate_only: problems with a kept event (browser_revenue_ignored, ...) */
  warnings?: string[];
  /** events stored along with this one (a site_search event), counted against the daily budget */
  extra_events?: number;
  /** stored as quarantined (debug = 2): out of reports and of the daily event budget, for review */
  quarantined?: QuarantineReason;
}

export interface IngestResponse {
  /** false when the DO has no settings: the site id is unknown or was deleted */
  known_site: boolean;
  persistent: boolean;
  results: IngestOutcome[];
  /** every event was refused for this one reason (suspended account, storage or daily budget) */
  refused?:
    | "account_suspended"
    | "storage_full"
    | "daily_limit"
    | "account_daily_limit"
    | "platform_daily_budget"
    | "server_daily_limit"
    | "account_server_daily_limit"
    | "platform_server_daily_budget";
  /** the site's linked replay site from the settings copy (known sites only, not for suspended accounts) */
  replay_site_id?: string | null;
  /** the site's replay proxy path from the settings copy ("/_r"), or null */
  replay_proxy_path?: string | null;
  /** the (one browser) event's network is past its daily share on this site: the Worker sheds its next events */
  over_share?: boolean;
}

export interface PeriodParams {
  period?: Period;
  from?: string;
  to?: string;
  /** debug events: exclude (default), include, or only them */
  debug?: DebugMode;
  /** a nested and / or / not filter group (filters_json, segments), ANDed with `filters` */
  where?: FilterExpr | null;
  /** IANA timezone for this query's periods and buckets (default: the site's) */
  timezone?: string;
}

/** A custom channel group: every condition given must match one of its patterns (* = anything, case-insensitive). */
export interface ChannelGroup {
  name: string;
  source?: string[];
  medium?: string[];
  campaign?: string[];
  channel?: string[];
}

export interface StatsRequest extends PeriodParams {
  metrics: Metric[];
  filters: Filter[];
  /** one property, or 2-3 for a multi-dimension breakdown */
  breakdown?: Breakdown | Breakdown[];
  breakdown_metrics?: Metric[];
  compare?: CompareSpec;
  /** breakdown order: a metric, the value, or change[:metric] (largest absolute change; needs compare) */
  sort?: SortSpec;
  limit?: number;
  /** breakdown rows to skip (pagination) */
  offset?: number;
  /** add imported (GA4 / Plausible) aggregates for days before live data */
  imported?: boolean;
}

/** Breakdown order. `change` ranks by the absolute change of `metric` against the comparison. */
export type SortSpec =
  | { by: "metric"; metric: Metric; dir?: "asc" | "desc" }
  | { by: "value"; dir?: "asc" | "desc" }
  | { by: "change"; metric: Metric };

export interface TimeseriesRequest extends PeriodParams {
  metrics: Metric[];
  filters: Filter[];
  interval?: Interval;
  compare?: CompareSpec;
  imported?: boolean;
}

export interface FunnelRequest extends PeriodParams {
  filters: Filter[];
  steps: FunnelStep[];
  /** ordered (default) or any order */
  mode?: FunnelMode;
  /** session (default), or a duration from step 1 across sessions (the same person) */
  window?: FunnelWindow;
  /** a comparison period: steps get comparison {visitors, conversion_rate, revenue, change_percent} */
  compare?: CompareSpec;
  /** side by side: the funnel within each saved segment */
  segments?: { id: string; name: string; filters: Filter[]; where: FilterExpr | null }[];
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
  /** before conversion to the site currency (set by the Worker; equal to amount/currency when none) */
  original_amount?: number | null;
  original_currency?: string | null;
  /** original -> site currency, the ECB publication day used, and whether that rate was stale */
  fx_rate?: number | null;
  fx_day?: string | null;
  fx_fallback?: boolean;
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
