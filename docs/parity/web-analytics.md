# Feature parity: privacy-first and revenue-first web analytics vs AgentFirstStack Analytics

Audited 2026-11-04 against `analytics/src` (llms.ts, mcp.ts, service/*, do/engine.ts, tracker/index.ts,
share-page.ts, lib/filters.ts) and each product's own docs and feature pages (links per row, list at the
end). Products: DataFast (DF), Plausible (PL), Umami (UM), Fathom (FA), PostHog web analytics (PH), plus
Simple Analytics (SA) and Pirsch (PI) where they have something the others don't. GA4 is audited
separately and left out here. Evidence paths are relative to `analytics/src/` unless they start with
another directory.

`docs/research/analytics-landscape.md` (2026-11-03) has an "AFS today" column that is now out of date.
Since it was written we've built annotations with automatic spike notes, comparisons per row with movers,
scroll depth and time on page, Web Vitals, 404 and form tracking, exclusions, visitors, journeys,
insights, saved funnels and new vs returning visitors. This document supersedes that column.

## Summary

| Bucket | Count | Meaning |
|---|---|---|
| Have | 40 | We have an equivalent (it may work differently but covers the same need) |
| Partial | 31 | Part of it exists; we build or adapt the rest |
| Missing | 42 | Doesn't exist; we build or adapt it |
| Skip | 8 | Partial or missing, and we don't plan to build it (the row gives the reason) |
| **Total** | **121** | |

| Area | Have | Partial | Missing | Skip |
|---|---|---|---|---|
| 1. Revenue | 7 | 3 | 7 | 2 |
| 2. Collection and tracking | 16 | 6 | 19 | 1 |
| 3. Querying and API | 12 | 14 | 4 | 1 |
| 4. Reports, alerts, sharing | 2 | 7 | 7 | 2 |
| 5. Integrations and imports | 3 | 1 | 5 | 2 |

Decisions on the 81 Partial, Missing and Skip rows: **Build 62, Adapt 11, Skip 8**. Effort of the 73 we'd
build or adapt: **S 43, M 26, L 4**.

How to read it:

- **Revenue:** ahead of Plausible and Fathom, behind DataFast and PostHog. Missing: subscription state
  (trials, MRR, churn), one-call connects with history backfill, native connectors beyond Stripe,
  currency conversion and ad spend.
- **Collection:** mostly small tracker gaps (hash routing, attribute events, element visibility, global
  props, beforeSend) and privacy operations (per-visitor erasure, purge, path rules). Nearly all are S.
- **Querying:** the core is there, often ahead (per-row compare, movers, SQL, MCP). The partial rows
  are Plausible v2's expressiveness: several dimensions at once, nested boolean filters, did/didn't-do
  filters, segments, pagination. Also missing: paths, funnel modes and retention.
- **Notifications:** the biggest product gap. We detect traffic spikes but tell nobody, and have no
  email reports, alerts or CSV export.
- **Integrations:** no Search Console and no imports, where every privacy-first competitor has both.

How rows are counted: Have = status Have. Skip = decision Skip, whatever the status. Partial and Missing
= that status with decision Build or Adapt.

Legend for the grid: `Y` yes · `P` partial · `N` not in the docs or feature pages reviewed · `?` docs
ambiguous or silent · `n/a` doesn't apply.

Effort: S = under a day, including tests, llms.txt and the MCP tool. M = 2 to 5 days. L = more than a week.

Conventions in "Proposed API": REST under `/v1/sites/:id/...`, snake_case JSON, list endpoints return
`{ "<things>": [...] }`, creates are idempotent by natural key (`existing: true`), errors carry hints, and
each mutating MCP tool is registered with `tools.write()` and calls the same service function as the REST
route. Every new cost gets a fair-use var (an `UNCLAIMED_` form included), and every route goes into
llms.txt.

---

## Comparison grid

### 1. Revenue

| Feature | DF | PL | UM | FA | PH | Us |
|---|---|---|---|---|---|---|
| Stripe payments attributed to the visit | Y | N | Y | N | P | **Have**: `POST /webhooks/stripe/:site_id`, `connect_stripe` |
| One-call Stripe connect, history backfill | Y | N | Y | N | Y | **Partial** (R1) |
| Paddle, LemonSqueezy, Polar, Dodo connectors | Y | N | Y | N | ? | **Partial** (R2) |
| Shopify, WooCommerce stores | Y | N | P | N | ? | **Missing** (R2b), Skip |
| Payments API from any provider, idempotent | Y | P | P | P | Y | **Have**: `POST /payments`, `record_payments` |
| New vs renewal revenue, refunds | Y | N | P | N | Y | **Have**: metrics `new_revenue`, `renewal_revenue`, `refunds` |
| Trials and subscription lifecycle | Y | N | N | N | P | **Missing** (R3) |
| MRR, ARR, churn, ARPU, LTV | P | N | N | N | Y | **Missing** (R4) |
| Revenue per visitor, purchase rate, customers | Y | P | ? | N | ? | **Have**: metrics in `lib/filters.ts` |
| Revenue by channel, source, campaign, page, country | Y | Y | Y | P | Y | **Have**: any `breakdown` + `metrics=revenue` |
| Reporting-currency conversion | ? | Y | P | P | Y | **Missing** (R5) |
| Attribution model choice (first or last touch) | N | N | Y | N | ? | **Partial** (R6) |
| Ad spend, CPC, ROAS | Y | N | N | N | Y | **Missing** (R7) |
| Revenue per funnel step | ? | Y | ? | N | ? | **Missing** (R8) |
| Revenue per search keyword | Y | N | N | N | N | **Missing** (R9) |
| Attribution to an X post or link-in-bio | Y | N | N | N | N | **Missing** (R10), Skip |
| Conversion prediction per visitor | Y | N | N | N | N | **Missing** (R11) |
| Time to convert, first-visit purchase rate | Y | N | N | N | ? | **Have**: `GET /insights` `time_to_convert` |
| Customer list with spend and journey | Y | N | P | N | Y | **Have**: `GET /visitors?type=customers`, `GET /journeys` |

### 2. Collection and tracking

| Feature | DF | PL | UM | FA | PH | Us |
|---|---|---|---|---|---|---|
| Cookieless by default | P | Y | Y | Y | P | **Have**: daily-salted hash; `persistent` opt-in |
| Pageviews incl. SPA navigation | Y | Y | Y | Y | Y | **Have** |
| Hash-based routing | Y | Y | ? | ? | ? | **Missing** (C1) |
| Custom events with props | Y | Y | Y | P | Y | **Have**: `afsa('event', ...)` |
| Click events from attributes or CSS classes | Y | Y | Y | ? | Y | **Missing** (C2) |
| Event when an element becomes visible | Y | N | N | N | N | **Missing** (C3) |
| Props on pageviews, global props, A/B tags | ? | Y | Y | N | Y | **Partial** (C4) |
| beforeSend hook, custom page URL | N | Y | Y | ? | Y | **Missing** (C5) |
| Outbound clicks, downloads, 404s, form submits, automatic | P | Y | P | ? | Y | **Have**: tracker `data-auto`, `data-404`, `data-forms` |
| Custom download extensions, cloaked-link clicks | N | Y | N | N | N | **Partial** (C6) |
| Scroll depth per page, scroll goals | P | Y | P | N | P | **Have**: `scroll_depth`, goal `type: scroll` |
| Time on page | ? | Y | Y | ? | Y | **Have**: `time_on_page` |
| Core Web Vitals | N | N | Y | N | Y | **Partial** (C7) |
| Page title | ? | N | Y | ? | Y | **Missing** (C8) |
| Screen or viewport size | Y | P | Y | ? | Y | **Missing** (C9) |
| Browser language | ? | N | Y | N | Y | **Missing** (C10) |
| Site search terms | N | N | P | N | P | **Missing** (C11) |
| Non-interactive events (excluded from bounce) | N | Y | N | N | ? | **Missing** (C12) |
| Identify with traits (name, plan, ...) | Y | N | Y | N | Y | **Partial** (C13) |
| Path cleaning rules (`/users/42` -> `/users/:id`) | N | N | N | N | Y | **Missing** (C14) |
| Cross-domain visitor linking | Y | ? | ? | P | ? | **Missing** (C15) |
| npm package | Y | Y | ? | ? | Y | **Missing** (C16) |
| Mobile SDK | Y | N | N | N | Y | **Missing** (C26) |
| Server-side events joined to the browser visit | Y | P | Y | ? | Y | **Have**: `POST /events`, `track_events` |
| First-party proxy | Y | Y | Y | ? | Y | **Have** (ahead): signed `x-afs-proxy-key` snippets |
| Managed proxy hostname | Y | P | N | ? | Y | **Partial** (C24), Skip |
| Install verification that returns fixes | ? | P | ? | ? | ? | **Have** (ahead): `POST /verify`, `verify_install` |
| Bot filtering | Y | Y | Y | Y | Y | **Have**: UA, headless, webdriver, verified bots |
| AI crawler analytics | Y | N | N | N | P | **Partial** (C17) |
| Referral spam filter (SA) | ? | ? | ? | ? | ? | **Missing** (C18) |
| Exclusions: IP, path, hostname, country | Y | Y | P | P | ? | **Have**: `exclusions`, `GET /exclusions` dry run |
| GPC / DNT | ? | ? | P | Y | Y | **Have**: `respect_dnt` |
| No-JS tracking pixel (SA) | N | N | Y | N | N | **Missing** (C19) |
| Tracked short links (PI) | N | N | Y | N | N | **Missing** (C20) |
| Per-visitor data deletion | ? | n/a | Y | ? | Y | **Missing** (C21) |
| Purge events by filter, reset site | Y | ? | Y | ? | ? | **Missing** (C22) |
| EU data residency | ? | Y | ? | Y | Y | **Missing** (C23) |
| Per-site localhost opt-in | Y | Y | ? | ? | ? | **Partial** (C25) |
| JS errors, session replay, heatmaps | N | N | Y | N | Y | **Have**: replay app, auto-loaded via `replay_site_id` |
| AI Assistants channel, 12 click-id types | P | P | ? | ? | Y | **Have**: `lib/channel.ts` |
| Geo to city, ASN, coarse lat/long | Y | Y | Y | Y | Y | **Have**: `request.cf` enrichment |
| Exclude own visits | Y | Y | Y | Y | Y | **Have**: `localStorage.afsa_ignore` |

### 3. Querying and API

| Feature | DF | PL | UM | FA | PH | Us |
|---|---|---|---|---|---|---|
| Aggregates, timeseries, one-dimension breakdown | Y | Y | Y | Y | Y | **Have**: `/stats`, `/timeseries`, `/breakdown` |
| Breakdown by several dimensions at once | N | Y | P | ? | Y | **Partial** (Q1) |
| Filters is / is not / contains, OR values | Y | Y | Y | Y | Y | **Have**: `lib/filters.ts` |
| Wildcards or regex, nested and / or / not | N | Y | ? | ? | Y | **Partial** (Q2) |
| Behavioral filters (did / didn't do) | N | Y | P | N | Y | **Partial** (Q3) |
| Saved segments (FA saved views, PI views) | N | Y | Y | Y | Y | **Missing** (Q4) |
| Breakdown pagination, total rows | Y | Y | ? | ? | Y | **Partial** (Q5) |
| Timestamp ranges, per-query timezone | Y | Y | Y | ? | Y | **Partial** (Q6) |
| `percentage` metric | N | Y | ? | ? | ? | **Missing** (Q7) |
| Compare previous / year / custom, match weekday, per row | P | Y | Y | Y | P | **Have** (ahead): plus `/movers`, `sort=change` |
| Custom-prop discovery | Y | Y | Y | N | Y | **Partial** (Q8) |
| Numeric prop sum / average (PI) | N | N | Y | N | Y | **Missing** (Q9) |
| Goals: update, prop conditions | P | Y | Y | P | Y | **Partial** (Q10) |
| Saved funnels CRUD | Y | Y | Y | N | Y | **Have**: `/funnels`, `create_funnel` |
| Funnel modes, comparison, window across sessions | N | Y | ? | N | Y | **Partial** (Q11) |
| Path exploration (next / previous steps) | N | Y | Y | N | Y | **Partial** (Q12) |
| Retention and cohorts | N | N | Y | N | Y | **Missing** (Q13) |
| Visitor list, profile, timeline | Y | N | Y | N | Y | **Have**: `/visitors`, `/visitors/:visitor` |
| Journeys to a goal with touchpoints | Y | N | ? | N | ? | **Have**: `/journeys` |
| Session list with filters | N | N | Y | N | Y | **Partial** (Q14) |
| Realtime counts, live feed | Y | Y | Y | Y | Y | **Have**: `/realtime` |
| Realtime map (coordinates, current page, payments) | Y | N | ? | N | P | **Partial** (Q15) |
| Derived insights (weekday x hour, top converting events, revenue share) | Y | N | P | N | P | **Have**: `/insights` |
| Anomaly findings (drops, attribution breakage, 404 spikes) | P | N | N | N | Y | **Partial** (Q16) |
| Annotations, automatic spike notes | Y | ? | Y | Y | Y | **Have** (ahead): spike notes name the source |
| Read-only SQL | N | N | N | N | Y | **Have**: `/sql`, `query_sql` |
| MCP with read and write tools | Y | N | P | N | Y | **Have**: 40 tools, OAuth via site app |
| Site, goal, funnel admin API | Y | Y | Y | Y | Y | **Have** |
| Visit-count or new / returning filter | Y | N | ? | N | ? | **Partial** (Q17) |
| API keys scoped to one site | Y | N | ? | ? | Y | **Partial** (Q18) |
| CLI | Y | N | N | N | ? | **Missing** (Q19), Skip |

### 4. Reports, alerts, sharing

| Feature | DF | PL | UM | FA | PH | Us |
|---|---|---|---|---|---|---|
| Scheduled email reports | Y | Y | Y | Y | Y | **Missing** (D1) |
| Slack delivery | ? | Y | N | N | ? | **Missing** (D3) |
| Traffic spike / drop alerts | Y | Y | N | N | Y | **Partial** (D2) |
| Goal and payment alerts | Y | N | N | N | P | **Missing** (D2b) |
| Tracking-stopped warning (PI zero-traffic) | ? | Y | N | N | ? | **Partial** (D2c) |
| Outbound webhooks (PI) | N | N | N | N | Y | **Missing** (D4) |
| Public share link | Y | Y | Y | Y | Y | **Have**: `POST /share`, `create_share_link` |
| Password, segment lock, named links | ? | Y | ? | P | ? | **Partial** (D5) |
| Embeddable dashboard (SA embed chart) | Y | Y | Y | ? | Y | **Partial** (D6) |
| Share page with filters, goals, revenue | Y | Y | Y | Y | Y | **Partial** (D7) |
| Multi-site roll-up | P | Y | ? | Y | ? | **Missing** (D8) |
| Team and guest roles via API | Y | Y | Y | ? | Y | **Partial** (D9) |
| CSV export | ? | Y | Y | Y | Y | **Missing** (D10) |
| Bulk raw export | N | P | Y | N | Y | **Partial** (D11) |
| Custom dashboards / boards | N | N | Y | N | Y | **Partial** (D12), Skip |
| White label (PI) | N | P | Y | N | ? | **Missing** (D13), Skip |
| Headline KPI setting | Y | N | N | N | N | **Missing** (D14) |
| AI chat over the data (SA) | Y | N | N | N | Y | **Have**: MCP; the agent is the chat |

### 5. Integrations and imports

| Feature | DF | PL | UM | FA | PH | Us |
|---|---|---|---|---|---|---|
| Google Search Console | Y | Y | Y | Y | ? | **Missing** (I1) |
| GA4 history import | N | Y | N | Y | ? | **Missing** (I2) |
| Plausible / CSV import (PI: GA, Plausible, Fathom) | Y | Y | Y | ? | ? | **Missing** (I3) |
| Ad-platform cost connectors | Y | N | N | N | Y | **Missing** (I4) |
| GitHub commits on the chart | Y | N | N | N | N | **Missing** (I5) |
| X / Reddit mentions | Y | N | N | N | N | **Missing** (I6), Skip |
| Install guides for site builders | Y | Y | Y | Y | Y | **Partial** (I7) |
| BI connectors (SA Data Studio, Power BI) | N | Y | N | N | Y | **Missing** (I8), Skip |
| Google Tag Manager install | Y | Y | Y | ? | Y | **Have**: `install?framework=gtm` |
| Session replay from the same snippet | N | N | Y | N | Y | **Have**: replay app link |
| Conversions sent to ad platforms (CAPI) | N | N | N | N | P | **Have**: tags app |

Every grid row with an ID has one row in the gap tables below.

---

## Gap tables

### 1. Revenue

| ID | Feature | Who has it | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|---|
| R1 | One-call Stripe connect, history backfill | [DF restricted key][df-stripe] (`rk_`); [UM][um-pay] read-only import, hourly, re-checks 7 days; [PH][ph-revenue] Stripe source | **Partial**: `POST /integrations/stripe {webhook_secret}` needs the endpoint created in Stripe first and sees only later events (`service/payments.ts`, `connect_stripe`) | Build: we create the endpoint and import history; keep the `webhook_secret` path | M | `POST /v1/sites/:id/integrations/stripe {restricted_key:"rk_...", backfill_days?:90, record_test_events?}` -> `{webhook_endpoint_id, signing_secret:{configured:true}, backfill:{status, payments_imported, unlinked}}`; `POST .../integrations/stripe/backfill {days}`. Key sealed with `encryptSecret()`, permanent key only (`assertPermanentKey`), needs `webhook_endpoints: write` + read on checkout sessions, invoices, charges, subscriptions. MCP: `connect_stripe` gains `restricted_key`; new `backfill_stripe` |
| R2 | Paddle, LemonSqueezy, Polar, Dodo signed webhooks | [DF][df-revenue], [UM][um-pay] | **Partial**: only `/webhooks/stripe/:site_id` (`routes/webhooks.ts`); other providers need the customer's backend to call `POST /payments` | Build on the Stripe pattern: verify signature, dedupe ids, same 400 `webhook_rejected` | M first, S each after | `POST /webhooks/:provider/:site_id`; `GET\|POST\|DELETE /v1/sites/:id/integrations/:provider {webhook_secret}`, provider = `paddle\|lemonsqueezy\|polar\|dodo`; visitor link from `custom_data.afs_visitor_id` / `metadata.afs_visitor_id`. MCP `get_payment_integration`, `connect_payment_provider`, `disconnect_payment_provider` {provider} |
| R2b | Shopify, WooCommerce | [DF][df-revenue], [UM][um-pay] (Woo) | **Missing** | Skip: needs store apps and plugins with their own review; custom stores can already use `POST /payments` | L | - |
| R3 | Trials and subscription lifecycle | [DF reserved goals][df-goals] (`trial_started` ... `subscription_ended`), [DF `is_free_trial`][df-pay]; [PH][ph-revenue] | **Missing**: `payments.type` is `new\|renewal\|refund` (`do/engine.ts` SCHEMA_DOC) | Build | M | Stripe `customer.subscription.created\|updated\|deleted` -> zero-revenue events `trial_started, trial_converted, subscription_started, subscription_upgraded, subscription_downgraded, subscription_cancel_scheduled, subscription_reactivated, subscription_ended` (origin payment; usable as goals and funnel steps); `POST /payments` gains `type: "trial"`; `POST /v1/sites/:id/subscriptions {subscriptions:[{id, provider, customer_id, status, plan?, amount, currency, interval, ts, visitor_id?, user_id?}]}` for other providers; metrics `trials, trial_conversion_rate, churned_customers`. MCP `record_subscriptions` |
| R4 | MRR, ARR, churn, ARPU, LTV by acquisition source | [PH revenue metrics][ph-revenue]; DF MRR as #1 KPI ([live walkthrough][df-live]) | **Missing** | Build on R3. Our angle: MRR split by first-touch channel, source and campaign, which neither DF's API nor PL has | L | `GET /v1/sites/:id/mrr?period=12mo&interval=month&breakdown=channel\|source\|utm_campaign\|country` -> buckets `{mrr, new_mrr, expansion_mrr, contraction_mrr, churned_mrr, reactivation_mrr, active_subscriptions, customers, arpu}` + totals `{arr, churn_rate, ltv}`. MCP `get_mrr` |
| R5 | Reporting currency | [PL][pl-revenue] (converted to the goal's currency), [PH][ph-revenue] | **Missing**: "currencies are not converted" (`llms.ts` metrics; README v2); goal `value` has no currency (`service/goals.ts`) | Build | M | site field `currency` (ISO 4217; null = sum as sent); daily ECB reference rates fetched by cron into D1 and pushed to each SiteDO; each row converted at its day's rate; responses add `currency`, `fx:{source:"ecb", as_of}`, `revenue_by_currency`; goals take `{value, currency}`; unknown codes excluded with warning `unknown_currency` |
| R6 | Attribution model choice | [UM][um-attribution] first or last click | **Partial**: session first source; payments link to the latest session; `/journeys` shows first and last touch per converter | Adapt: a model parameter over the visitor's or user's history | M | `attribution=session (default)\|first_touch\|last_touch\|last_non_direct` on `/stats`, `/breakdown`, `/timeseries`, `/insights`; response `attribution:{model, identity:{mode, note}}` (anonymous cookieless visitors: same day only) |
| R7 | Ad spend, CPC, CPA, ROAS, CAC | [DF Meta ads][df-meta], [PH marketing analytics][ph-marketing] (6 networks) | **Missing**: the tags app sends conversions out; nothing brings cost in | Build the costs API first (agents already hold ads MCPs); native connectors are I4 | M | `POST /v1/sites/:id/costs {costs:[{date, source, medium?, campaign, campaign_id?, ad_id?, cost, currency, clicks?, impressions?}]}`, idempotent by (date, source, campaign_id or campaign, ad_id), replaces; `GET\|DELETE /v1/sites/:id/costs?from&to&source`; metrics `cost, cpc, cpa, roas, cac` with `breakdown=utm_campaign\|utm_content\|source\|channel`; match `utm_campaign` to campaign id or name (DF's rule). MCP `record_costs`, `list_costs`, `delete_costs` |
| R8 | Revenue per funnel step | [PL funnels][pl-funnels] | **Missing**: funnel returns visitors, sessions, conversion_rate, dropoff (`do/engine.ts` funnel) | Build | S | `/funnel` and `/funnels/:id` with `metrics=revenue` -> per step `revenue, revenue_per_visitor` (sessions that reached the step) |
| R9 | Revenue per search keyword | [DF GSC][df-gsc] (estimates) | **Missing** | Adapt after I1: page revenue x the query's share of that page's clicks, flagged `estimated` | S | `GET /v1/sites/:id/search?breakdown=query&metrics=clicks,impressions,ctr,position,estimated_revenue` |
| R10 | Attribution to an X post or link-in-bio | [DF][df-xlink] | **Missing** | Skip: needs the paid X search API, and t.co hides the post; UTM-tagged links (C20) cover it | L | - |
| R11 | Conversion prediction per visitor | [DF visitor `prediction`][df-visitor], [DF realtime map][df-rtmap] | **Missing** | Build later: a labelled heuristic from segment rates, not a model | M | `predicted:{purchase_probability, expected_value, basis:"channel x device x country, 90d", sample}` on `/visitors` rows and realtime visitors (Q15); left out below a minimum sample |

### 2. Collection and tracking

| ID | Feature | Who has it | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|---|
| C1 | Hash-based routing | [DF `script.hash.js`][df-script], [PL `hashBasedRouting`][pl-script], SA hash mode | **Missing**: pageview key is `pathname + search`, no `hashchange` listener (`tracker/index.ts`) | Build | S | `data-hash="true"`: listen to `hashchange`, include the hash in the key, send `h:1`; the server keeps `#/route` in `pathname` (query strings still dropped) |
| C2 | Click events from attributes | [DF `data-fast-goal-*`][df-script], [PL `plausible-event-name=`][pl-custom], [UM `data-umami-event-*`][um-eventdata] | **Missing**: only `afsa('event', ...)` | Build | S | `<button data-afsa-event="signup" data-afsa-prop-plan="pro">`: click delegation (a parent covers its children), kebab-case to snake_case, same 30-key limits |
| C3 | Event when an element becomes visible | [DF `data-fast-scroll`][df-script] (threshold, delay) | **Missing**: whole-page scroll depth only | Build | S | `data-afsa-view="pricing_table"` (+ `data-afsa-view-threshold` 0-1, default 0.5): IntersectionObserver, once per pageview -> `element_view {name}`; goal via Q10 props |
| C4 | Props on pageviews, global props, A/B tags | [PL `customProperties`][pl-script], [UM `data-tag`][um-tags], [PI tags][pi-features] | **Partial**: `/e` stores `p` on any event (`service/ingest.ts`), but `afsa('pageview')` takes no arguments and there are no global props | Build | S | `afsa('pageview', {url?, props?})`; `afsa('props', {variant:'b'})` merged into every later event on the page; `data-props='{"variant":"b"}'` on the script tag; read with `breakdown=prop:variant` |
| C5 | beforeSend hook, custom URL | [PL `transformRequest`][pl-script], [UM `data-before-send`][um-tracker] | **Missing** | Build | S | `data-before-send="fnName"`: a window function gets `(name, payload)` and returns the payload or null to drop it; `afsa('pageview', {url:'/users/:id'})` for redaction |
| C6 | Custom download extensions, cloaked-link clicks | [PL file extensions][pl-script], [PL pretty URLs][pl-pretty] | **Partial**: fixed extension regex; outbound means another host only (`tracker/index.ts`) | Build | S | `data-downloads="pdf,zip,..."` replaces the list; `data-link-paths="/go/*,/out/*"` sends `outbound_click {url}` for same-host redirect paths |
| C7 | Web Vitals depth | [PH][ph-vitals] FCP, p75 / p90 / p99, good / poor table; [UM][um-perf] | **Partial**: LCP, INP, CLS at p75 (`lib/filters.ts`) | Build | S | tracker adds FCP and TTFB to `v`; metrics `fcp_p75, ttfb_p75`, `lcp_p90, lcp_p99` (and for each vital), `vitals_good, vitals_needs_improvement, vitals_poor` per page |
| C8 | Page title | [UM][um-tracker], PH | **Missing**: no column (`do/engine.ts` SCHEMA_DOC) | Build, opt-in (titles on account pages can contain names) | S | `data-title="true"` sends `t` (200 chars) on pageviews; column `title`; breakdown and filter `page_title` |
| C9 | Screen size | [DF viewport][df-visitor], UM, PH | **Missing** | Build with coarse buckets only | S | tracker sends viewport width; stored as class `xs <576, sm 576-991, md 992-1439, lg >=1440`; breakdown and filter `screen` |
| C10 | Browser language | UM, PH | **Missing** | Build from `Accept-Language` (no tracker change) | S | column `language` (primary subtag); breakdown and filter `language` |
| C11 | Site search terms | [SA "Allow URL parameters"][sa-docs]; UM keeps the query | **Missing** by design: query strings are never stored (`llms.ts`) | Adapt: opt-in allow-list, value moved into a prop | S | site field `search_params: ["q","s"]` (max 5); a pageview carrying one also writes `site_search {term}` (lowercased, 100 chars); the rest of the query is still dropped; `breakdown=prop:term&filters=event_name==site_search` |
| C12 | Non-interactive events | [PL `interactive:false`][pl-custom], [PL Events API][pl-events] | **Missing**: any custom event un-bounces the session (`llms.ts` bounce_rate) | Build | S | `afsa('event', name, props, {interactive:false})` (`ni:1` on `/e`); `interactive:false` on `POST /events`; such events don't count for bounce or `custom_events` |
| C13 | Identify with traits | [DF identify][df-identify] (name, image, 10 props; server endpoint); UM session data; PH | **Partial**: `afsa('identify', id)` and server `user_id` only; names are generated (`lib/names.ts`) | Adapt: traits per user (not per event); server-sent traits trusted, browser ones flagged | S | `afsa('identify', id, {name?, plan?, ...})` (<= 10 traits, 255 chars); `POST /v1/sites/:id/identify {user_id, visitor_id?, traits}`; traits on `/visitors`, filter `trait:plan==pro`; browser traits `source: "browser"`; erased by C21. MCP `identify_user` |
| C14 | Path cleaning rules | [PH][ph-web] | **Missing** | Build | S | site field `path_rules: [{match:"/users/*", replace:"/users/:id"}]` (glob, ordered, <= 50) applied at ingest to page, entry and exit; dry run `GET /v1/sites/:id/path-rules?path=/users/42` |
| C15 | Cross-domain visitor linking | [DF `_df_vid`, `_df_sid`][df-xdomain] | **Missing**: persistent ids are per origin; the cookieless hash links hosts only within a day | Build | M | `data-cross-domain="app.example.io"` (hosts must be in `allowed_hostnames`): the tracker adds `_afs=<vid>.<sid>.<ts>` to links to those hosts and strips it on arrival with `replaceState`; the server accepts it up to 2 minutes old; cookieless mode only continues the same-day session |
| C16 | npm package | [DF][df-npm], [PL][pl-npm], PH | **Missing**: script tag only | Build | S | `@agentfirststack/analytics`: `init({site, api?})`, `track`, `revenue`, `identify`, `pageview`, `visitorId`, same bundle as `/s.js`; `install?framework=npm` |
| C17 | AI crawler analytics | [DF bot traffic][df-bots] (`@datafast/ai-crawl`, answer / indexing / training, IP-verified); [PH][ph-bots] classification | **Partial**: bots are dropped and counted by reason only (`drops`, `GET /v1/sites/:id` `dropped_last_7d`) | Build | M | `POST /v1/sites/:id/crawls {hits:[{ts, path, user_agent, ip, status?}]}` (server only: the proxy key from `install.first_party_proxy.proxy_key`, or a full key); classify provider and category `ai_answer\|indexing\|training\|other`, verified against published IP ranges; `GET /v1/sites/:id/crawls?period&breakdown=provider\|category\|page\|status&verified=true`; Worker wrapper, Next.js `proxy.ts` and Hono middleware snippets in `GET /install`; own daily budget `MAX_CRAWLS_PER_SITE_PER_DAY`. MCP `get_crawls` |
| C18 | Referral spam filter | [SA "Hide referral SPAM"][sa-docs] | **Missing** | Build | S | vendored public spam-referrer list -> drop reason `referrer_spam`; `exclusions.referrers: ["spam.example"]` |
| C19 | No-JS tracking pixel | [UM pixels][um-pixels], [SA "Collect without JavaScript"][sa-docs] | **Missing** | Adapt: `<noscript>` and AMP pageviews only; no email-open tracking | S | `GET /e.gif?s=site_xxx&u=<url>&r=<referrer>` -> 1x1 GIF, `origin: pixel`, hostname checked against `Referer`, same budgets |
| C20 | Tracked short links | [UM links][um-links], [PI URL shortener][pi-features] | **Missing** | Build later; to avoid an open redirect, the destination must be on the site's verified domain | M | `POST /v1/sites/:id/links {slug?, destination, utm_*}` -> `https://<host>/l/<slug>` (302 with UTMs, records `link_click`); `GET\|PATCH\|DELETE /links/:link_id`. MCP `create_link`, `list_links` |
| C21 | Per-visitor data deletion | [UM][um-index] delete session, PH | **Missing**: only `DELETE /v1/sites/:id` | Build: identified users make this a GDPR erasure need | S | `DELETE /v1/sites/:id/visitors/:visitor` (id or `user:<id>`): events, sessions, traits; payments kept but unlinked. MCP `delete_visitor` |
| C22 | Purge events by filter | DF `goals_delete_events` ([MCP][df-mcp]), [UM][um-index] reset website | **Missing** | Build (test traffic, bad deploys) | S | `POST /v1/sites/:id/purge {filters, from, to, dry_run?: true}` -> `{matched, deleted}`; usage counters unchanged (fair use). MCP `purge_events` |
| C23 | EU data residency | [PL][pl-overview] EU-hosted, [FA EU isolation][fa-features], PH EU cloud | **Missing** | Adapt: Durable Object jurisdiction | M | `POST /v1/sites {..., jurisdiction:"eu"}` (fixed at create) -> SiteDO from `env.SITE.jurisdiction("eu")`; D1 holds no visitor data; `get_site` shows `jurisdiction` |
| C24 | Managed proxy hostname | [DF managed proxy][df-proxy] | **Partial**: snippets for a Worker route, Next.js, Vercel, Netlify, nginx (`service/install.ts`) | Skip for now: snippets plus `verify` cover the agent case; Cloudflare for SaaS custom hostnames cost per hostname | M | - |
| C25 | Per-site localhost opt-in | [DF `data-allow-localhost`][df-script], [PL `captureOnLocalhost`][pl-script] | **Partial**: localhost only under deployment-wide `DEV_MODE` | Build | S | site field `allow_localhost: true` (stored as `hostname=localhost`, filterable) |
| C26 | Mobile SDK | [DF React Native][df-rn], PH | **Missing**: `POST /events` needs an API key, which can't ship in an app | Build later | M | public app ingest on `/e` with `origin: app` + `app_id` (no hostname check, rate limited per app); React Native wrapper of C16 |

### 3. Querying and API

| ID | Feature | Who has it | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|---|
| Q1 | Breakdown by several dimensions | [PL v2 `dimensions`][pl-stats] incl. `time:*`; [UM breakdown][um-breakdown]; PH | **Partial**: one `breakdown` (`service/stats.ts`), otherwise SQL | Build | M | `breakdown=channel,country` (<= 3, incl. `time:day\|week\|month`) on `/breakdown`; rows `{dimensions:{channel, country}, metrics, comparison?}`; MCP `get_breakdown` takes an array |
| Q2 | Wildcards, nested and / or / not | [PL v2][pl-stats] `matches` (RE2), `and`, `or`, `not` | **Partial**: `== != ~ !~`; `\|` = OR within a key, `;` = AND (`lib/filters.ts`) | Adapt: no regex (DO SQLite has no REGEXP and no user-defined functions); globs plus groups instead | M | `*` in `==` / `!=` values = glob (`page==/blog/*`); `filters_json=["or",[["==","country",["US"]],["and",[["~","page",["/blog"]],["!=","device",["mobile"]]]]]]` with the same keys |
| Q3 | Behavioral filters | [PL v2 `has_done`, `has_not_done`][pl-stats]; UM cohorts | **Partial**: `goal==X` keeps sessions that converted (`llms.ts` filters) | Build | M | keys `did` / `did_not` with values `event:x\|goal:X\|page:/p`, plus `scope=session\|visitor` (visitor = identity over the range): `filters=did==goal:Signup;did_not==goal:Purchase` |
| Q4 | Saved segments | [PL][pl-segments] personal and site segments; [UM][um-segments]; FA saved views; PI views | **Missing** | Build | S | `POST /v1/sites/:id/segments {name, filters}` (idempotent by name); `GET`, `PATCH`, `DELETE /segments/:segment_id`; `segment=seg_...` on every query, ANDed with `filters`. MCP `create_segment`, `list_segments`, `update_segment`, `delete_segment` |
| Q5 | Breakdown pagination | [PL `pagination`, `include.total_rows`][pl-stats]; [DF `limit/offset`][df-timeseries] | **Partial**: `limit` up to 1000 and no offset on `/breakdown`; `/visitors`, `/journeys`, `/payments` already page | Build | S | `/breakdown?offset=` + `total_rows`, `next_offset` |
| Q6 | Timestamp ranges, timezone override | [PL datetime `date_range`][pl-stats]; [DF `startAt` / `timezone`][df-overview] | **Partial**: `from` / `to` are dates; always the site timezone | Build | S | `from` / `to` accept ISO timestamps (minute precision); `timezone=` (IANA) on every query |
| Q7 | `percentage` metric | [PL][pl-stats] | **Missing** | Build | S | metric `percentage` = row visitors / total visitors, on breakdowns |
| Q8 | Custom-prop discovery | [PL custom-props API][pl-sites], [UM event-data fields][um-index], [DF goal properties][df-mcp] | **Partial**: `breakdown=prop:<key>` needs the key; keys only via SQL `json_each` | Build | S | `GET /v1/sites/:id/props?period&event_name=` -> `{props:[{key, events, sample_values}]}`. MCP `list_props` |
| Q9 | Numeric prop sum / average | [UM numeric stats][um-index], [PI custom event metrics][pi-features], PH | **Missing**: props are strings; revenue is the only number | Build | S | metrics `sum:prop:<key>`, `avg:prop:<key>` (CAST of `json_extract`; non-numeric ignored) on `/stats`, `/breakdown`, `/timeseries` |
| Q10 | Goal update, prop conditions | [PL Sites API goals `custom_props`][pl-sites]; [UM update goal][um-index] | **Partial**: create, list and delete only (`routes/sites.ts`); match on event name or path only | Build | S | `PATCH /v1/sites/:id/goals/:goal_id {name?, match?, value?, currency?, threshold?, props?}`; event goals take `props: {"plan":"pro"}` (all must match). MCP `update_goal` |
| Q11 | Funnel modes, comparison, window | [PL][pl-funnels] sequential / flexible / strict + compare; PH | **Partial**: ordered steps within one session, no compare (`llms.ts` Funnel steps) | Build | M | `mode=sequential\|strict\|flexible`, `window=session\|1d\|7d\|30d` (beyond a session needs user_id or persistent mode, else 400 with a hint), `compare=previous\|year\|custom` per step; saved funnels store `mode` and `window` |
| Q12 | Path exploration | [PL user journeys][pl-journeys] (20 steps, backwards from a goal); UM journey; PH paths | **Partial**: `/journeys` lists converters with touchpoint sessions, not page-to-page flow | Build | M | `GET /v1/sites/:id/paths?start=/pricing\|event:x\|goal:X` (or `end=goal:X`), `steps=1-10`, `group=dir`, `limit=10` -> `{columns:[{step, rows:[{value, visitors, no_further_action}]}], conversion_rate}`. MCP `get_paths` |
| Q13 | Retention and cohorts | [UM retention][um-retention], [UM cohorts][um-cohorts], PH | **Missing** (README v2) | Build, honest about identity | M | `GET /v1/sites/:id/retention?cohort=first_seen\|did:goal:Signup&return=any\|event:x&interval=day\|week\|month&periods=8` -> `{cohorts:[{cohort, size, returned:[...], rate:[...]}], identity}`; uses user_id or persistent ids; cookieless-only sites get 422 `identity_required` (hint: identify users or switch to persistent mode); saved cohorts = Q4 segments with Q3 filters. MCP `get_retention` |
| Q14 | Session list | [UM sessions][um-index], PH | **Partial**: `GET /sessions/:session_id` only; `/visitors` lists identities | Build | S | `GET /v1/sites/:id/sessions?period&filters&sort=started_at\|duration\|pageviews\|revenue&limit&offset`. MCP `list_sessions` |
| Q15 | Realtime map | [DF realtime map][df-rtmap] | **Partial**: lat/long are stored per event, but `/realtime` returns counts, top lists and 50 events without coordinates (`do/engine.ts` realtime) | Build | S | `/realtime?include=visitors` -> `visitors:[{name, lat, lon (0.1 deg), city, country, current_page, channel, source, device, session_started_at, visits, customer}]`, `recent_payments`; MCP `get_realtime {include}` |
| Q16 | Anomaly findings | [PH self-driving reports][ph-app] | **Partial**: `traffic_spike` annotations (`do/annotations.ts`), `/movers` | Build with D2 (same evaluator) | M | `GET /v1/sites/:id/findings?period` -> `{findings:[{kind: traffic_drop\|channel_shift_to_direct\|404_spike\|vitals_regression\|tracking_stopped\|conversion_drop, day, details}]}`; any kind can fire an alert. MCP `get_findings` |
| Q17 | New / returning filter | [DF `filter_visit_count`][df-overview] | **Partial**: `new_visitors` / `returning_visitors` metrics, no filter | Build | S | filter key `visitor_type==new\|returning`; `visit_number` on sessions |
| Q18 | API keys scoped to one site | [DF website keys][df-mcp] (create, roll) | **Partial**: account keys with scope `*` or `read` (`@afs/shared` `accountRoutes`) | Adapt in `@afs/shared` | M | `POST /v1/keys {scope, site_ids?: [...]}`; `requireAuth()` checks `:id` against `site_ids`; MCP lists only those sites |
| Q19 | CLI | [DF CLI][df-docs] | **Missing** | Skip: curl, MCP and llms.txt cover agents; `pnpm afs` is for operators | - | - |

### 4. Reports, alerts, sharing

| ID | Feature | Who has it | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|---|
| D1 | Scheduled reports and digest | DF weekly summary ([walkthrough][df-live]), [PL][pl-email], [UM][um-email], [FA][fa-features], [PH weekly digest][ph-web] | **Missing** (README v2: "email reports via mail/") | Build: JSON digest first, delivered through the `mail/` service binding | M | `GET /v1/sites/:id/digest?period=7d\|30d` (KPIs with change, top sources, pages and countries, goals, revenue, annotations, findings); `POST /v1/sites/:id/reports {cadence: weekly\|monthly, channel: email\|slack\|webhook, to, day?, segment_id?}`; `GET`, `PATCH`, `DELETE /reports/:report_id`; `POST /reports/:report_id/send`. Email recipients confirm by link before the first send (mail's `SHARED_SEND_POLICY` and `SEND_DAILY_LIMIT` block cold sends), unsubscribe link in every mail. MCP `get_digest`, `create_report`, `list_reports`, `delete_report`, `send_report_now` |
| D2 | Traffic spike / drop alerts | [PL][pl-spikes] (spike on current visitors, drop over 12 h, at most 2 a day), DF spike email, PI | **Partial**: spike detection exists but only writes a `traffic_spike` annotation, a day late, and notifies nobody (`do/annotations.ts`) | Build | M | `POST /v1/sites/:id/alerts {type: traffic_spike\|traffic_drop\|no_data\|goal\|payment\|metric, goal?, metric?, filters?, threshold?, window: 1h\|12h\|1d, channel: email\|slack\|webhook, to, cooldown_minutes?: 720}`; `GET`, `PATCH`, `DELETE /alerts/:alert_id`; `GET /alerts/:alert_id/history`; evaluated by the SiteDO alarm (hourly while alerts exist); a firing writes an annotation; `MAX_ALERTS_PER_SITE`. MCP `create_alert`, `list_alerts`, `update_alert`, `delete_alert`, `get_alert_history` |
| D2b | Goal and payment alerts | [DF alerts][df-alerts] (goal, email, 25 per site, history) | **Missing** | Build in D2 (`type: goal\|payment`), checked at ingest, capped per hour | S | as D2 |
| D2c | Tracking-stopped warning | [PL drop alert][pl-spikes], [PI zero-traffic warning][pi-features] | **Partial**: `GET /v1/sites/:id` `status` and `verify` show it when asked; nothing is pushed | Build in D2 (`type: no_data`, hourly) | S | as D2 |
| D3 | Slack delivery | [PL][pl-slack] | **Missing** | Build as a D1 / D2 channel | S | `channel: "slack"`, `to` = incoming-webhook URL sealed with `encryptSecret()`, returned as `configured: true` |
| D4 | Outbound webhooks | [PI][pi-features], PH destinations | **Missing** | Build as a D1 / D2 channel | S | `channel: "webhook"`, HMAC-signed body (the tags app scheme), retried through a queue; events `alert.fired`, `report.ready` |
| D5 | Share links with password, segment, name, expiry | [PL shared links][pl-shared]; FA password | **Partial**: token link, verified domain, never expires, at most 10, body `{new}` only (`service/share.ts`) | Build | S | `POST /v1/sites/:id/share {name?, password?, segment_id?, expires_at?, embed?}`; `GET /v1/sites/:id/share` (list); `PATCH\|DELETE /v1/sites/:id/share/:link_id`; password hashed with PBKDF2; unlocking sets a short-lived signed cookie scoped to `/share/<token>`; the segment always applies |
| D6 | Embed mode | [PL embed][pl-embed] (iframe, theme, transparent background), SA embed chart, UM guide | **Partial**: the share page sends no `frame-ancestors` or `X-Frame-Options` (`routes/share.ts`), so any site can frame it, undocumented | Build (this also closes a clickjacking gap) | S | links without embed: `frame-ancestors 'none'`; `embed: true` links: `/share/:token?embed=1&theme=light\|dark\|system&background=transparent` with `frame-ancestors https://<verified domain> <embed_origins>` |
| D7 | Full share dashboard | PL, FA, UM, DF dashboards | **Partial**: totals, a chart and the top 10 pages, sources, countries and devices; no filters (`service/share.ts` `shareData`) | Build | M | `/share/:token/data` mirrors `stats\|breakdown\|timeseries\|funnel\|realtime` (aggregates only; the link's segment always applies); panels for channels, UTM, entry, exit, region, city, goals and funnels; revenue only with the link option `show_revenue` |
| D8 | Multi-site roll-up | [PL consolidated view][pl-consolidated], FA all-sites view | **Missing** (README v2) | Build | S | `GET /v1/stats?site_ids=a,b\|all&period&metrics` -> `{sites:[{site_id, domain, metrics}], total}` (fan-out to the SiteDOs, <= `MAX_SITES_PER_ACCOUNT`). MCP `get_stats_all_sites` |
| D9 | Team and guest roles via API | [PL guests][pl-sites], [PL roles][pl-roles], DF team API ([MCP][df-mcp]) | **Partial**: project owner and member, invite links in the `site/` dashboard, `POST /v1/claim-link` (`docs/accounts.md`) | Adapt in `site/` (platform-wide, not per app): a viewer role that only gets read keys | M | `POST /v1/invites {role: member\|viewer}` on the site app; the dashboard shows the role |
| D10 | CSV export | [PL][pl-data], FA, [UM][um-export], PI | **Missing** | Build | S | `format=csv` (or `Accept: text/csv`) on `/stats` with breakdown, `/breakdown`, `/timeseries`, `/visitors`, `/payments`, `/sql`; same limits |
| D11 | Bulk raw export | PL (Enterprise, S3), [UM][um-export], [SA Export API][sa-docs], PH | **Partial**: SQL up to 1000 rows / 1 MB (`llms.ts` SQL) | Build | M | `POST /v1/sites/:id/exports {from, to, tables:[events, sessions, payments], format: ndjson\|csv}` -> job; the DO writes one file per day to R2; `GET /exports/:export_id` -> `{status, files:[{url (signed, 24 h)}]}`. MCP `create_export`, `get_export` |
| D12 | Custom dashboards / boards | [UM boards][um-boards], PH | **Partial**: an agent builds the screen from a prompt (`site/src/dashboard-prompt.ts`) | Skip: agents compose views from the API | - | - |
| D13 | White label | [UM][um-whitelabel], PI | **Missing** | Skip: the share page already names only the verified domain; branding isn't an agent need | - | - |
| D14 | Headline KPI | [DF #1 KPI][df-kpi] | **Missing** | Adapt, with D1 and D7 | S | site field `primary_kpi: revenue\|mrr\|goal:<name>\|visitors`, used as the headline of the digest, the share page and default alerts |

### 5. Integrations and imports

| ID | Feature | Who has it | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|---|
| I1 | Google Search Console | [DF][df-gsc], [PL][pl-gsc], [FA][fa-features] (terms, clicks, impressions, position, country, device, page), [UM][um-gsc], PI | **Missing** | Build | L (Google verification of the `webmasters.readonly` scope) | `POST /v1/sites/:id/integrations/search-console` -> `{authorize_url}` for a person (Google sign-in already exists in `site/`), or `{refresh_token}`; daily sync (GSC lags 1-2 days) into a DO table `search(date, query, page, country, device, clicks, impressions, position)`; `GET /v1/sites/:id/search?period&breakdown=query\|page\|country\|device&filters=page~/blog` with metrics `clicks, impressions, ctr, position`. MCP `connect_search_console`, `get_search` |
| I2 | GA4 history import | [PL][pl-ga], FA importer, PI (UA) | **Missing** (README v2) | Build after I1 (same Google OAuth) | L | `POST /v1/sites/:id/imports {source:"ga4", property_id}` -> job reading the GA4 Data API into `imported_daily(table, date, dimension, value, visitors, visits, pageviews, bounces, duration_s, events)`, up to the first native day; queries take `include_imports=true` and return `imports_skip_reason` when a filter or breakdown can't use them; `GET\|DELETE /imports/:import_id`. MCP `start_import`, `get_import`, `delete_import` |
| I3 | Plausible / CSV import | [DF Plausible zip][df-import], [PL CSV][pl-csv], [UM CSV][um-import], PI (Plausible, Fathom) | **Missing** | Build on I2's storage | M | `POST /v1/sites/:id/imports {source:"plausible_csv"}`; `PUT /imports/:import_id/files/:name` for Plausible's 10 tables (visitors, sources, pages, entry pages, exit pages, custom events, locations, devices, browsers, OS); `POST /imports/:import_id/complete` |
| I4 | Ad-platform cost connectors | [DF Meta OAuth][df-meta], [PH][ph-marketing] (Google, Meta, LinkedIn, TikTok, Reddit, Bing) | **Missing** | Build later: the R7 costs API first (agents push from their ads MCPs), native Meta and Google Ads after | L | `POST /v1/sites/:id/integrations/meta-ads\|google-ads` -> OAuth; daily sync into the R7 `costs` |
| I5 | GitHub commits on the chart | [DF][df-github] | **Missing** | Adapt: a push webhook that writes annotations | S | `POST /v1/sites/:id/integrations/github {webhook_secret}`; `POST /webhooks/github/:site_id` (HMAC `X-Hub-Signature-256`, pushes to the default branch) -> annotations `kind: "commit"` (title = first line, `details:{sha, author}`); `annotations?kind=commit` |
| I6 | X / Reddit mentions | [DF][df-mentions] | **Missing** | Skip: paid, rate-limited APIs outside analytics; agents can write annotations | - | - |
| I7 | Install guides for site builders | DF (24 guides, [index][df-docs]), PL, UM | **Partial**: `install?framework=html\|nextjs\|astro\|react\|wordpress\|gtm\|tags` (`service/install.ts` FRAMEWORKS) | Build | S | add `webflow, framer, shopify (theme.liquid), ghost, wix, squarespace, vue, nuxt, sveltekit, remix, laravel, django, rails` |
| I8 | BI connectors | [PL Looker Studio][pl-data], [SA Data Studio, Power BI][sa-docs], PH warehouse | **Missing** | Skip: REST + CSV (D10) + exports (D11) | - | - |

---

## Where we already go beyond these products (keep)

- **Setup and verification.** Account and site in two requests (`POST /v1/signup`, idempotent
  `POST /v1/sites`). `verify` fetches the page and checks the snippet, script, CSP, proxy key, Stripe
  webhook and payment linking, then returns fixes. Retention can be set per site, from 1 to 3650 days.
- **Proxy.** Signed first-party proxy snippets for five platforms; forwarded IP and geo are trusted only
  with the site's proxy key.
- **Revenue integrity.** Browser revenue and browser user ids don't count until the site opts in. Payment
  linking goes session, then visitor, then user, then customer, then refund chain, so renewals keep their
  original source. Unlinked payments stay as "Unattributed" and get linked later. None of the products
  above document guards like these.
- **Querying.** Comparisons per row and per bucket, `match_weekday`, `/movers` and `sort=change`. Spike
  annotations that name the source. Read-only SQL with cost guards. An insights call that returns
  DataFast's whole bento in one request.
- **Agent surface.** A remote read/write MCP with OAuth connectors. Untrusted-content marking on
  every visitor-sent string. A fair-use budget on every write path.
- **Platform.** Session replay loaded from the same snippet; conversions out to ad platforms through tags.

## Prioritised build list

Ranked by value to an owner and their agent ("tell me when something breaks", "what made money")
divided by effort. Each item ships REST + MCP + llms.txt + tests.

**P1: close the loud gaps (roughly 8 engineer-weeks)**

1. **Alerts with delivery** (D2, D2b, D2c, D3, D4): spike, drop, no data, goal, payment; email, Slack,
   webhook; history; each firing writes an annotation. M. The detector already exists (spike annotations)
   but tells nobody.
2. **Digest and scheduled reports** (D1, D14): `GET /digest` first, then weekly or monthly sends through
   `mail/` with recipient confirmation. M.
3. **Stripe connect in one call** (R1): restricted key, we create the endpoint, backfill 90 days. M.
   Removes the only manual step in revenue setup and gives day-one history.
4. **Subscription lifecycle and trials** (R3), then **MRR, ARR and churn by acquisition source** (R4).
   M + L. This is the revenue-first differentiator: neither Plausible nor DataFast's API reports MRR by
   source.
5. **Query quick wins** (Q4 segments, Q5 pagination, Q6 timestamps and timezone, Q7 percentage,
   Q8 prop discovery, Q10 goal update and props, D10 CSV): S each, about a week together.
6. **Tracker pack** (C1 hash routing, C2 attribute events, C3 element visible, C4 pageview and global
   props, C5 beforeSend, C6 downloads and cloaked links, C12 non-interactive): S each, about a week
   together. Covers the install patterns DataFast and Plausible users bring with them.
7. **Privacy operations** (C21 visitor erasure, C22 purge, C14 path rules, C18 referral spam) and
   **D6 frame-ancestors** on share pages: S each. Erasure matters as soon as sites identify users; D6
   closes a clickjacking gap.

**P2: revenue depth and the next layer of analysis**

8. **Native Polar, Paddle and LemonSqueezy webhooks** (R2), then Dodo. M, then S each.
9. **Currency conversion** (R5), with goal currency. M.
10. **Costs API with ROAS, CPA and CAC** (R7). M. Agents push spend from the Google and Meta ads MCPs
    they already use.
11. **Funnels**: revenue per step (R8, S), then modes, window and comparison (Q11, M).
12. **Share links** (D5 password, segment, name, expiry; S) and **full share dashboard** (D7, M).
13. **Paths** (Q12), **did / didn't-do filters** (Q3), **retention** (Q13): M each.
14. **AI crawler analytics** (C17). M. A natural partner to the AI Assistants channel.
15. **Search Console** (I1, L), then revenue per keyword (R9, S).
16. **Several dimensions at once** (Q1) and **globs with nested boolean filters** (Q2): M each.
17. **Small reads**: realtime map (Q15), session list (Q14), numeric props (Q9), new / returning filter
    (Q17), roll-up across sites (D8): S each.
18. **Collection extras**: vitals depth (C7), page title (C8), screen class (C9), language (C10), site
    search terms (C11), identify traits (C13), npm package (C16), pixel (C19), localhost opt-in (C25),
    GitHub commit annotations (I5), more install guides (I7): S each.

**P3: later**

19. Imports: GA4 (I2, L) and Plausible CSV (I3, M), on shared `imported_daily` storage.
20. Bulk export to R2 (D11), API keys scoped to one site (Q18), viewer role (D9), cross-domain linking
    (C15), EU jurisdiction (C23), attribution models (R6), anomaly findings (Q16, reuses the D2
    evaluator): M each.
21. Tracked short links (C20), mobile app ingest and a React Native SDK (C26), native ad-cost
    connectors (I4), conversion prediction (R11): M to L.

**Skipped on purpose:** Shopify and WooCommerce apps (R2b), X post attribution (R10), managed proxy
hostnames (C24), CLI (Q19), custom boards (D12), white label (D13), social mentions (I6), BI connectors
(I8).

---

## Sources

AgentFirstStack: `analytics/src/llms.ts`, `mcp.ts`, `service/{payments,share,goals,stats,ingest,install,people}.ts`,
`do/{engine,annotations,payments,people}.ts`, `tracker/index.ts`, `share-page.ts`, `routes/{sites,share,webhooks}.ts`,
`lib/filters.ts`, `analytics/README.md` ("Not yet (v2)"), `docs/accounts.md`, `site/src/dashboard.ts`.

Competitors: the links below, plus the [Fathom API][fa-api] operation list. A `?` in the grid means the
pages linked here didn't settle it.

[df-docs]: https://datafa.st/docs
[df-script]: https://datafa.st/docs/script-configuration
[df-mcp]: https://datafa.st/docs/mcp-tools
[df-overview]: https://datafa.st/docs/api/website/analytics/overview
[df-timeseries]: https://datafa.st/docs/api/website/analytics/timeseries
[df-rtmap]: https://datafa.st/docs/api/website/analytics/realtime-map
[df-pay]: https://datafa.st/docs/api/website/payments/create
[df-visitor]: https://datafa.st/docs/api/website/visitors/retrieve
[df-alerts]: https://datafa.st/docs/api/account/alerts/create
[df-stripe]: https://datafa.st/docs/api/account/integrations/stripe/connect
[df-revenue]: https://datafa.st/docs/revenue-attribution-guide
[df-goals]: https://datafa.st/docs/custom-goals
[df-identify]: https://datafa.st/docs/user-identification
[df-xdomain]: https://datafa.st/docs/cross-domain-tracking
[df-xlink]: https://datafa.st/docs/twitter-link-attribution
[df-mentions]: https://datafa.st/docs/twitter-mentions
[df-meta]: https://datafa.st/docs/meta-ads-attribution
[df-github]: https://datafa.st/docs/github-integration
[df-bots]: https://datafa.st/docs/bot-traffic-tracking
[df-gsc]: https://datafa.st/docs/google-search-console
[df-kpi]: https://datafa.st/docs/set-number-one-kpi
[df-import]: https://datafa.st/docs/import-from-plausible
[df-proxy]: https://datafa.st/docs/managed-proxy
[df-npm]: https://datafa.st/docs/npm
[df-rn]: https://datafa.st/docs/react-native
[df-live]: ../research/datafast.md
[pl-stats]: https://plausible.io/docs/stats-api
[pl-sites]: https://plausible.io/docs/sites-api
[pl-events]: https://plausible.io/docs/events-api
[pl-script]: https://plausible.io/docs/script-extensions
[pl-custom]: https://plausible.io/docs/custom-event-goals
[pl-revenue]: https://plausible.io/docs/ecommerce-revenue-tracking
[pl-funnels]: https://plausible.io/docs/funnel-analysis
[pl-journeys]: https://plausible.io/docs/user-journeys
[pl-segments]: https://plausible.io/docs/filters-segments
[pl-shared]: https://plausible.io/docs/shared-links
[pl-embed]: https://plausible.io/docs/embed-dashboard
[pl-spikes]: https://plausible.io/docs/traffic-spikes
[pl-email]: https://plausible.io/docs/email-reports
[pl-slack]: https://plausible.io/docs/slack-reports
[pl-gsc]: https://plausible.io/docs/google-search-console-integration
[pl-ga]: https://plausible.io/docs/google-analytics-import
[pl-csv]: https://plausible.io/docs/csv-import
[pl-data]: https://plausible.io/docs/data-access
[pl-consolidated]: https://plausible.io/docs/consolidated-views
[pl-roles]: https://plausible.io/docs/users-roles
[pl-pretty]: https://plausible.io/docs/custom-automatic-link-tracking
[pl-overview]: https://plausible.io/docs/your-plausible-experience
[pl-npm]: https://plausible.io/docs/npm-package
[um-index]: https://docs.umami.is/llms.txt
[um-tracker]: https://docs.umami.is/docs/tracker-configuration.md
[um-attribution]: https://docs.umami.is/docs/attribution.md
[um-retention]: https://docs.umami.is/docs/retention.md
[um-cohorts]: https://docs.umami.is/docs/cohorts.md
[um-segments]: https://docs.umami.is/docs/segments.md
[um-links]: https://docs.umami.is/docs/links.md
[um-pixels]: https://docs.umami.is/docs/pixels.md
[um-tags]: https://docs.umami.is/docs/tags.md
[um-breakdown]: https://docs.umami.is/docs/breakdown.md
[um-eventdata]: https://docs.umami.is/docs/event-data.md
[um-perf]: https://docs.umami.is/docs/performance.md
[um-boards]: https://docs.umami.is/docs/using-boards.md
[um-pay]: https://docs.umami.is/docs/cloud/payment-providers.md
[um-email]: https://docs.umami.is/docs/cloud/email-reports.md
[um-import]: https://docs.umami.is/docs/cloud/import-data.md
[um-export]: https://docs.umami.is/docs/cloud/export-data.md
[um-gsc]: https://docs.umami.is/docs/cloud/google-search-console.md
[um-whitelabel]: https://docs.umami.is/docs/cloud/white-label.md
[fa-features]: https://usefathom.com/features
[fa-api]: https://usefathom.com/api
[sa-docs]: https://docs.simpleanalytics.com
[pi-features]: https://pirsch.io/features
[ph-web]: https://posthog.com/docs/web-analytics
[ph-app]: https://posthog.com/docs/web-analytics/surfaces/web-app.md
[ph-vitals]: https://posthog.com/docs/web-analytics/web-vitals
[ph-marketing]: https://posthog.com/docs/web-analytics/marketing-analytics.md
[ph-revenue]: https://posthog.com/docs/revenue-analytics/revenue-metrics
[ph-bots]: https://posthog.com/docs/web-analytics/bot-detection.md
