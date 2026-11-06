import { BREAKDOWNS, type Breakdown, DEFAULT_METRICS, METRICS, type Metric, SORTABLE_METRICS } from "./filters";

/**
 * What every metric and breakdown means, in one place: get_schema returns it, so an agent can pick
 * metrics without reading the manual. Typed against METRICS, so a new metric can't ship undocumented.
 */
export const METRIC_DOCS: Record<Metric, string> = {
  visitors: "Unique visitors (cookieless: a multi-day count adds up daily uniques).",
  visits: "Sessions (30 minutes of inactivity ends one).",
  pageviews: "Pageview events.",
  views_per_visit: "pageviews / visits.",
  bounce_rate: "% of sessions with at most 1 pageview and no interactive custom event.",
  visit_duration: "Mean session length in seconds (first to last activity, or visible time when longer).",
  events: "All events except payments, pageviews included.",
  conversions: "Events matching a goal (goals with counting once_per_visit count once per session).",
  conversion_rate: "% of visitors with a conversion.",
  revenue:
    "Event revenue plus payments, refunds subtracted (money that was paid; goal values are goal_value, never added here). Currencies are summed as sent.",
  goal_value:
    "Sum of the goal values of conversions (each matching event counts its goal's value): what the owner says conversions are worth, reported apart from revenue.",
  revenue_per_visitor: "revenue / visitors.",
  new_revenue: "Revenue that is not a renewal (refunds aside).",
  renewal_revenue: "Subscription renewals.",
  refunds: "Amount refunded (positive).",
  purchases: "New purchases (payments or revenue events, not renewals or refunds).",
  customers: "Distinct visitors with a new purchase.",
  purchase_rate: "% of visitors with a new purchase.",
  new_visitors: "Visitors without an earlier session (same-day only for anonymous cookieless visitors).",
  returning_visitors: "Visitors with an earlier session.",
  scroll_depth: "Mean max scroll % per pageview.",
  time_on_page: "Mean visible seconds per pageview that reported engagement.",
  lcp_p75: "Largest Contentful Paint, 75th percentile, ms.",
  inp_p75: "Interaction to Next Paint, 75th percentile, ms.",
  cls_p75: "Cumulative Layout Shift, 75th percentile.",
  engaged_visits:
    "Sessions with at least 10 s of visible time, 2 or more pageviews, or a conversion (GA4's engaged sessions; bounce_rate is a different, stricter test).",
  engagement_rate: "engaged_visits / visits, %.",
  engagement_time: "Total visible seconds on pages (divide by visitors for a per-visitor average).",
  visits_per_visitor: "visits / visitors (cookieless: within a day for anonymous visitors).",
  events_per_visit: "events / visits.",
  visit_conversion_rate: "% of sessions with a conversion.",
  average_order_value: "Revenue of new purchases / purchases.",
  revenue_per_customer: "revenue / customers.",
  percentage: "A row's share of all visitors in the period and filters, % (breakdowns; totals are 100).",
  cost: "Ad spend from POST /costs in the period (site currency). Splits by utm_source, utm_campaign and source only; null under other filters / breakdowns and in hourly series.",
  roas: "Return on ad spend: revenue / cost.",
  cpa: "Cost per acquisition: cost / conversions (goal completions).",
  cac: "Customer acquisition cost: cost / customers (visitors with a first purchase in the period).",
  cost_per_visit: "cost / visits.",
};

export const BREAKDOWN_DOCS: Record<(typeof BREAKDOWNS)[number], string> = {
  page: "Page path (rows count revenue and conversions of the sessions that viewed it).",
  entry_page: "First page of the session.",
  exit_page: "Last page of the session.",
  hostname: "Page hostname.",
  source: "Session source (Google, ChatGPT, a referring host, utm_source).",
  referrer: "Referring host + path (no query string).",
  channel: "Session channel (Direct, Organic Search, Paid Search, AI Assistants, ...).",
  utm_source: "utm_source (or ref / source query parameters).",
  utm_medium: "utm_medium.",
  utm_campaign: "utm_campaign.",
  utm_term: "utm_term.",
  utm_content: "utm_content.",
  utm_id: "utm_id (campaign id).",
  utm_source_platform: "utm_source_platform.",
  utm_creative_format: "utm_creative_format.",
  utm_marketing_tactic: "utm_marketing_tactic.",
  click_id_type: "Ad click id parameter (gclid, fbclid, msclkid, ...).",
  country: "ISO country code.",
  region: "Region (rows include country).",
  city: "City (rows include country).",
  continent: "Continent code.",
  browser: "Browser name.",
  browser_version: "Browser major version.",
  os: "Operating system.",
  os_version: "Operating system version.",
  device: "desktop, mobile, tablet, ...",
  language: "Browser language (primary subtag from Accept-Language: en, de, ...).",
  screen: "Viewport class: xs (< 576 px), sm (< 992), md (< 1440), lg.",
  page_title: 'Page title (sites with data-title="true" on the tracker).',
  content_group: "The site's content_groups (path patterns), evaluated at query time.",
  first_channel:
    "First touch: the channel of the visitor's (or identified user's) first session. Cookieless anonymous visitors: that day's first session.",
  first_source: "First touch: the source of the first session.",
  first_referrer: "First touch: the referrer of the first session.",
  first_utm_source: "First touch: utm_source of the first session.",
  first_utm_medium: "First touch: utm_medium of the first session.",
  first_utm_campaign: "First touch: utm_campaign of the first session.",
  first_entry_page: "First touch: the landing page of the first session.",
  event_name: "Event name.",
  channel_group:
    "The site's custom channel groups (channel_groups rules over source, medium, campaign, channel; first match wins), else the built-in channel. Evaluated at query time.",
  visitor_type:
    "new (the visitor's first session) or returning (they had a session that ended before this one began; cookieless ids rotate daily, so same day only for anonymous visitors).",
  goal: "Goals (every goal, with conversions).",
};

export function metricCatalog() {
  return METRICS.map((name) => ({
    name,
    description: METRIC_DOCS[name],
    default: DEFAULT_METRICS.includes(name),
    sortable: SORTABLE_METRICS.includes(name),
  }));
}

export function breakdownCatalog(): { name: Breakdown | "prop:<key>" | "user:<key>"; description: string }[] {
  return [
    ...BREAKDOWNS.map((name) => ({ name, description: BREAKDOWN_DOCS[name] })),
    { name: "prop:<key>" as const, description: "A custom event prop (keys are listed under untrusted.props)." },
    {
      name: "user:<key>" as const,
      description:
        "A user property (last value per identified user; GET /v1/sites/:id/user-props lists keys). Events of anonymous visitors have none.",
    },
  ];
}

/** Numeric custom metrics over a prop: any of these with a prop key, e.g. sum:prop:amount. */
export const CUSTOM_METRIC_DOCS = {
  "sum:prop:<key>": "Sum of a numeric prop over the events that carry it (values that aren't numbers are skipped).",
  "avg:prop:<key>": "Mean of a numeric prop.",
  "min:prop:<key>": "Smallest value of a numeric prop.",
  "max:prop:<key>": "Largest value of a numeric prop.",
};
