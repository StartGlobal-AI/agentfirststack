import { type Metric } from "../../src/lib/filters";
import type { EnrichedEvent, PaymentInput, SiteSettings } from "../../src/lib/types";

/** Shared fixtures for the wave-1 unit suites (the older suites keep their own copies). */

export const NOW = Date.UTC(2026, 10, 3, 15, 0); // Tue 3 Nov 2026, 15:00 UTC
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const settings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  id: "site_test0000000000",
  domain: "example.com",
  name: null,
  timezone: "UTC",
  visitor_id_mode: "cookieless",
  retention_days: 400,
  allowed_hostnames: null,
  respect_dnt: false,
  created_at: NOW,
  goals: [],
  ...over,
});

export function ev(over: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    ts: NOW - MIN,
    name: "pageview",
    origin: "browser",
    hostname: "example.com",
    pathname: "/",
    url: "https://example.com/",
    user_id: null,
    props: null,
    revenue: null,
    currency: null,
    engagement_ms: 0,
    visitor_hash: "v1",
    client_visitor_id: null,
    explicit_visitor_id: null,
    dnt: false,
    referrer: null,
    referrer_host: null,
    source: null,
    channel: "Direct",
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_term: null,
    utm_content: null,
    click_id_type: null,
    click_id: null,
    country: null,
    region: null,
    region_code: null,
    city: null,
    continent: null,
    timezone: null,
    latitude: null,
    longitude: null,
    asn: null,
    as_org: null,
    browser: "Chrome",
    browser_version: "130",
    os: "Mac OS",
    os_version: "10.15",
    device: "desktop",
    ...over,
  };
}

export const pay = (over: Partial<PaymentInput> = {}): PaymentInput => ({
  provider: "stripe",
  external_id: "pi_1",
  event_id: null,
  type: "new",
  amount: 49,
  currency: "USD",
  ts: NOW - MIN,
  visitor_id: null,
  session_id: null,
  user_id: null,
  customer: null,
  original_refs: [],
  livemode: true,
  ...over,
});

export const google = { source: "Google", channel: "Organic Search" as const, referrer_host: "www.google.com", referrer: "google.com" };
/** What the Worker computes for a referrer from a hosted checkout (before the DO ignores it). */
export const stripeCheckout = {
  source: "checkout.stripe.com",
  channel: "Referral" as const,
  referrer_host: "checkout.stripe.com",
  referrer: "checkout.stripe.com/c/pay/cs_live_abc",
};

export type Rows = { results: Record<string, any>[] };
export const q = (over: Record<string, unknown> = {}) => ({
  period: "24h" as const,
  metrics: ["visitors"] as Metric[],
  filters: [],
  ...over,
});
