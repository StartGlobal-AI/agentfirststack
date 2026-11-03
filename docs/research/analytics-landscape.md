# Analytics landscape: feature inventory (2026-11-03)

What the leading web analytics and behaviour analytics products do, compared with AgentFirstStack
Analytics ("AFS") as built today, so we can decide what to build. AFS facts come from
`analytics/README.md`, `analytics/src/llms.ts`, `analytics/src/service/`, `analytics/src/do/engine.ts`,
`analytics/src/share-page.ts`, `docs/accounts.md` and `tags/README.md`. Competitor facts come from
official docs and pricing pages (sources at the end, per product). Where a doc was ambiguous,
missing, or only reachable through search snippets, the cell or note says so.

**Status changes worth knowing before reading the matrix**

- **Hotjar is no longer a standalone product.** hotjar.com/pricing redirects to Contentsquare
  pricing, and contentsquare.com/hotjar says "Hotjar is now part of Contentsquare" and that new
  Hotjar accounts can't be created. The Hotjar column describes Hotjar's documented features
  (help.hotjar.com) plus the Contentsquare plan that now sells them. help.hotjar.com returns 403
  to direct fetches, so Hotjar facts come from search snippets of those help articles.
- **Umami 3.2+ ships session replays, click and scroll heatmaps, web vitals, error tracking and an
  official MCP server**, so it is no longer a "simple" analytics tool.
- **GA4 added an "AI Assistant" default channel in May 2026** (secondary sources; reports say
  Perplexity still lands in Referral). AFS's AI Assistants channel is not unique anymore.
- **Clarity cut retention in 2026:** playback 30 days, heatmaps and favourited sessions 9 months
  (older pages and the FAQ still say 13 months in places).

**Legend:** `yes` · `partial (why)` · `no` · `tags` = covered by our tags service
(`tags/`: pixels, server-side conversion APIs, Consent Mode) · `?` = not documented in the pages
reviewed, or the docs are ambiguous. In the third column F = Fathom, U = Umami, P = PostHog web
analytics. "n/a" = doesn't apply to that kind of product.

---

## 1. Feature matrix

### Collection

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Script tag, automatic pageviews incl. SPA navigation | yes | yes | yes (all three) | yes | yes | yes (2.2 KB tracker, pushState/popstate) |
| Cookieless by default | no (cookies; cookieless pings only when consent is denied in advanced Consent Mode) | yes | F yes; U yes; P partial (`cookieless_mode` opt-in, also a project setting) | no (first-party cookies; consent enforced in EEA/UK/CH) | no | yes (daily-salted hash; optional `persistent` localStorage id) |
| Data streams (web + iOS + Android in one property) | yes | no | P yes; F, U no | partial (one project per site; mobile SDKs) | no | partial (one site per domain, extra hostnames, server events) |
| Custom events | yes | yes | yes (all three) | partial (API events, custom tags; used as filters) | partial (events API; used as filters) | yes |
| Event properties | yes (params; register custom dimensions to report on them) | yes (Business plan) | F no (event value only); U yes; P yes | partial (custom tags) | partial (user attributes) | yes (up to 30 string keys; `prop:<key>` breakdown, no registration) |
| Custom dimensions and metrics | yes (50 event, 25 user, 10 item dims; 50 metrics; 5 calculated) | partial (props are dimensions; no numeric metrics) | P yes; U partial; F no | no | no | partial (props are dimensions; no numeric custom metrics besides revenue) |
| Server-side ingestion | yes (Measurement Protocol) | yes (Events API) | U yes; P yes; F ? (API page says "track events from your own code", no ingest endpoint listed) | no | no | yes (batch of 100; lands on the browser visitor and session) |
| User ID / identify | yes (User-ID) | no (by design) | U yes (distinct IDs); P yes; F no | yes (Identify API) | yes (Identify API) | yes (`afsa('identify')`, `user_id`) |
| Outbound link and file download clicks, automatic | yes (enhanced measurement) | yes | P yes (autocapture); F, U ? | n/a (every click is recorded) | n/a | yes |
| Form submissions, automatic | yes (`form_start`, `form_submit`) | yes | P yes (autocapture); F, U ? | partial ("Submit Form" smart event) | ? | no (tags' `form_submit` trigger can forward a conversion) |
| 404 pages | partial (manual, usually via page title) | yes | ? | no | no | no |
| Scroll depth | partial (one `scroll` event at 90%) | yes (1-100% per page, scroll-depth goals) | P yes (scrollmaps); U partial (scroll heatmap) | yes | yes | no (tags' `scroll_depth` trigger can forward an event) |
| Site search terms | yes (`view_search_results` from `q`, `s`, ... params) | no | ? | no | no | no (query strings are dropped by design) |
| Engagement / active time | yes | yes (time on page) | yes (all three) | yes (active time) | yes | yes (visible time via sendBeacon) |
| Core Web Vitals | no (not built in) | no | P yes (p75/p90/p99, per page); U yes (Performance); F no | yes (performance widget, p75 LCP/INP/CLS) | yes on Contentsquare plans (performance monitoring) | no |
| Bot filtering | yes (known bots, automatic, not configurable) | yes | P yes (crawlers, AI agents, automation classified at query time); F, U yes | yes (bot detection setting) | ? | yes (UA, headless, webdriver, verified bots; drops counted per reason) |
| First-party proxy / ad-block resistance | partial (server-side tagging, Google tag gateway) | yes (proxy guides; managed proxy on Enterprise) | U yes; P yes (reverse proxy); F ? | no | no | yes (Worker, Next.js, Vercel, Netlify, nginx snippets; signed proxy key) |
| Install verification | partial (Tag Assistant, realtime) | partial (onboarding check) | ? | partial (Live extension, verify step) | partial | yes (`verify`: snippet, script, CSP, events, proxy key, with fixes) |
| Cross-domain measurement | yes (linker across configured domains) | ? | ? | no (one project per domain recommended) | no | partial (one site can span hostnames; same-day cookieless hash links them; persistent ids are per origin) |
| Mobile app SDKs | yes (Firebase) | no (Events API only) | P yes; F, U no | yes (Android, iOS, Flutter, React Native, Cordova) | no (Contentsquare has) | partial (server events only) |

### Attribution and acquisition

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Traffic acquisition (session source, medium, campaign) | yes | yes | yes (all three) | yes (source, medium, campaign, channel) | partial (referrer and UTM filters) | yes |
| User acquisition (first touch per user) | yes | no | P yes; F no; U ? | no | no | no (session-level only; tags keeps first touch per visitor for ad platforms) |
| Default channel grouping | yes (custom channel groups too) | yes | P yes; U partial (UTM, attribution reports); F no | yes (Channel dimension) | no | yes (11 channels incl. AI Assistants, Paid Other) |
| AI assistant referrals as a channel | yes (since May 2026; Perplexity reportedly still Referral) | partial (visible as referrer sources) | ? | no (separate Bot activity for crawlers) | no | yes (ChatGPT, Perplexity, Claude, Gemini, Copilot, DeepSeek, Grok, ...) |
| UTM tags | yes | yes | yes (all three) | yes | partial | yes (all five) |
| Ad click IDs | yes (gclid auto-tagging) | no | P yes (used for channel); F, U no | no | no | yes (12 click-id types) |
| Attribution models | yes (data-driven, paid and organic last click, Google paid last click; others removed Nov 2023) | no (source of the converting visit) | U yes (first or last click); F no; P ? | no | partial (Contentsquare Pro "attribution") | partial (session's first source; no model choice, no multi-touch) |
| Ad cost, CPC, ROAS | yes (Google Ads automatic; cost data import for others) | no (blend in Looker Studio) | P yes (beta: Google, Meta, LinkedIn, TikTok, Reddit, Bing spend); F, U no | partial (Advertising dashboard, ad campaign insights; which networks is unclear) | no | no |
| Conversions sent to ad platforms | yes (key events to Google Ads) | no | P partial (CDP destinations) | no | no | tags (GA4 MP, Meta CAPI, Google Ads, TikTok, webhook, plus pixels) |
| Google Ads link | yes | no | no | ? | no | tags |
| Search Console integration | yes | yes | F yes; U no; P ? | no | no | no |

### Content

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Pages and screens (top pages) | yes | yes | yes (all three) | yes (popular pages) | partial | yes |
| Landing (entry) and exit pages | yes | yes | U, P yes; F partial | partial | no | yes (`entry_page`, `exit_page`) |
| Events report (all events with counts) | yes | partial (custom events show once they are goals) | yes (all three) | partial (smart events) | no | yes (`breakdown=event_name`) |
| Page titles | yes | no | ? | yes (page title in export) | ? | no |
| Hostname | yes | yes | yes | yes (URL) | ? | yes |
| Content groups / path grouping | yes (`content_group`) | partial (wildcard goals and filters) | P yes (path cleaning); F, U partial | partial (URL groups with regex) | partial | partial (`~` filters, `*` goal globs) |
| Time on page, per page | yes | yes | yes | partial | partial | partial (per-session `visit_duration`; per page only via SQL on `engagement_ms`) |

### Audience and geo

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Country, region, city | yes | yes | yes (all three) | yes (country, state, city) | partial (country) | yes (+ continent, timezone, 0.1° lat/long, ASN) |
| Demographics (age, gender, interests) | yes (needs Google signals; thresholded; kept 2 months) | no | no | no | no | no |
| Language | yes | no | U, P yes; F no | ? | ? | no |
| New vs returning visitors | yes | no | P yes; F no; U ? | yes | ? | no (cookieless ids reset daily) |
| Audiences (build, export to ads) | yes (incl. predictive audiences, to Google Ads) | no | P partial (cohorts); F, U no | no | no | no |

### Tech

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Browser, OS, device | yes | yes | yes (all three) | yes | yes | yes (+ browser and OS versions) |
| Screen resolution | yes | partial (device class from screen width) | U, P yes; F ? | ? | ? | no |
| Network / ASN | no | no | no | no | no | yes (`asn`, `as_org` via SQL) |

### Conversions and revenue

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Goals / key events | yes (30 key events standard, 50 on 360) | yes (pageview, custom event, scroll-depth goals) | yes (all three) | partial (smart events: 9 automatic types, 20 custom) | partial (events for filtering, funnels) | yes (event or pageview glob, optional value, applied retroactively) |
| Conversion rate by source, page, country | yes | yes | yes | partial | no | yes (`filters=goal==X` + any breakdown) |
| Revenue | yes (ecommerce events; currencies converted) | yes (Business; converted to the goal's base currency) | F yes (event values with currency); U yes; P yes (revenue analytics) | partial (e-commerce insights) | no | partial (summed as sent, no FX conversion) |
| Ecommerce detail (items, checkout journey, promotions) | yes (monetisation reports) | no | P partial; F, U no | partial (e-commerce insights, checkout abandonment) | partial | no (props only) |
| Backend conversion joined to the web visit | yes (MP with client_id) | partial (Events API, no join to a browser visitor) | P yes | no | no | yes (server events land on the browser visitor/session) |

### Funnels and paths

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Funnels | yes (open/closed, "within" time windows, elapsed time, trended) | yes (2-8 steps, Business) | U, P yes; F no | yes (no-code, median time to convert, links to recordings) | yes (all Contentsquare plans) | partial (2-8 ordered steps within one session; ad hoc, not saved) |
| Path / journey analysis | yes (forward and backward path exploration) | yes (user journeys, up to 20 steps, Business) | U, P yes; F no | no (per session only) | partial (journey analysis, Contentsquare Growth+) | no (SQL only) |
| Segment overlap | yes | no | no | no | no | no |
| Free-form pivot / report builder | yes (free form exploration, report Library) | no | P yes (insights, SQL); U partial (boards); F no | no | partial (dashboards) | partial (read-only SQL) |

### Retention and cohorts

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Retention / cohort reports | yes (retention report, cohort exploration) | no | U yes (retention, cohorts); P yes; F no | no | no | no (v2; cookieless ids can't link days) |
| User lifetime, LTV, predictive metrics | yes (user lifetime; purchase and churn probability) | no | P partial; F, U no | no | no | no |
| Individual user / session explorer | yes (user explorer) | no | U yes (sessions); P yes (persons); F no | yes (visitor profile, recordings) | yes | partial (SQL over `events` and `sessions`) |

### Segments and comparisons

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Filters | yes | yes (is, is not, contains, does not contain; multi-value) | yes (all three) | yes (incl. regex, smart events, frustration signals) | yes | yes (`==`, `!=`, `~`, `!~`, OR lists, `(none)`) |
| Saved segments | yes (in explorations; saved comparisons in reports) | yes (personal and site segments) | F yes (saved views); U yes; P yes (cohorts) | yes | yes | no |
| Period comparison | yes | yes (previous, year over year, custom; match weekday; per-row in tooltips) | F yes (week, month, year, custom); U yes; P yes (previous period) | ? | ? | partial (`compare=previous`, totals only; v2 lists per-row) |
| Side-by-side segment comparison | yes (up to 200 saved comparisons) | no | P yes; F, U ? | yes (heatmap compare) | ? | no (run separate queries) |

### Realtime

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Realtime view | yes (last 30 min, Realtime pages; "best effort", no SLO) | yes | yes (all three) | yes (live users; up to 100 live recordings) | ? | partial (API/MCP: 5 and 30 min, top pages/countries/sources, last 50 events; not on the share page) |

### Alerts and insights

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Traffic spike / drop alerts | yes (custom insights, "has anomaly", email; up to 50) | yes (spike and drop thresholds, email; max 2 per day) | P yes (alerts; "self-driving" anomaly reports); F no; U ? | partial (automatic email when page views drop over 50% week on week) | ? | no |
| Automated / AI insights | yes (Analytics Intelligence) | no | P yes (PostHog AI); F, U no | yes (Copilot chat, session, grouped session and heatmap insights) | yes (Sense chat and summaries, Growth+) | no (agents do this over the API) |
| Annotations | yes (up to 1000 per property; Admin API; Google system annotations) | yes | F yes (milestones, with API); U yes; P yes | no | no | no |

### Reports and sharing

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Human dashboard | yes | yes | yes (all three) | yes | yes | partial (share page: totals with % change, visitors chart, top 10 pages/sources/countries/devices; no filters, goals, funnels or revenue) |
| Shared / public link | partial (needs Google account access; Looker Studio for public) | yes (password option; can be locked to a segment) | F yes (public or password); U yes (share URL); P yes | yes (share recordings, heatmaps) | yes | yes (token link, revocable; no password, expiry or segment lock) |
| Embeddable dashboard | no (via Looker Studio) | yes (iframe, unbranded) | P yes; F, U ? | no | no | partial (share page isn't frame-blocked; no documented embed) |
| Scheduled email reports | yes (admins; up to 50 reports; daily to quarterly) | yes (weekly, monthly) | F yes (weekly, monthly, several sites per email); P yes (weekly digest, subscriptions); U ? | no | ? | no (v2, via `mail/`) |
| Slack reports | no | yes (weekly, monthly; spike alerts via channel email) | P yes | no | partial (Slack integration) | no |
| Custom dashboards | yes | no | U yes (boards); P yes; F no | partial (several dashboards, rearrangeable cards) | yes | no |
| Multi-site roll-up | partial (roll-up properties are a 360 feature) | yes (consolidated view, Business) | F yes (all-sites view); U, P ? | no | no | no (v2) |
| Team and roles | yes | yes (roles; SSO on Enterprise) | yes (all three) | yes (admin and member; unlimited members) | yes | partial (project owner/member in the dashboard; full vs read keys; no per-site roles) |

### Integrations

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Google Ads, Merchant Center, other Google products | yes | no | no | no | no | tags (Google Ads conversions) |
| CMS / ecommerce plugins (WordPress, Shopify) | yes | yes (WordPress plugin, guides) | P yes (one-click Webflow, Framer, Shopify, WordPress, GTM); U partial | yes (Shopify, WordPress, Wix, Squarespace) | yes | partial (install snippets: html, nextjs, astro, react, wordpress, gtm, tags) |
| Google Analytics integration | n/a | n/a | n/a | yes (GA dashboard, GA segments) | yes (send Hotjar user IDs to GA; filter by GA events) | no (tags can run GA4) |
| BI connectors | yes (Looker Studio, BigQuery) | yes (official Looker Studio connector) | P yes (data warehouse); F, U no | no | no | no |
| Webhooks, Zapier, Slack, Jira | no | no | P yes | no | yes (Slack, Jira, HubSpot, Zapier, webhooks, Linear, Teams, ...) | no (tags has signed webhooks for conversions) |

### Data access and export

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Reporting API | yes (Data API) | yes (Stats API v2, Business) | yes (all three) | partial (export API: 10 requests/day, last 1-3 days only, 3 dimensions, 1000 rows) | partial (survey responses, user lookup and deletion; Pro/Enterprise) | yes (stats, breakdown, timeseries, realtime, funnel) |
| Admin / sites API | yes (Admin API) | partial (Sites API, Enterprise only) | yes (all three) | no | no | yes (every setting over REST and MCP) |
| MCP server | partial (official open-source server, runs locally, labelled experimental) | no official (docs point to a community server) | U yes (official, read-only, 23 tools); P yes; F no (has `/api/llms.txt`) | yes (official, uses the export token, so same limits) | yes (Contentsquare MCP; 300 tool calls/month on Free) | yes (remote Streamable HTTP, read and write tools, OAuth) |
| SQL | partial (on the BigQuery export) | no | P yes (HogQL); F, U no | no | no | yes (read-only SQLite, 1000 rows, cost guards) |
| Raw event export | yes (BigQuery daily, 1M events/day on standard; streaming) | partial (daily raw export to S3, Enterprise only) | P yes (batch exports); F partial (export); U ? | no (recordings can't be downloaded) | no | partial (SQL only; no bulk export) |
| CSV export | yes | yes (300 rows quick export; full export in settings) | F yes; U, P ? | yes (download dashboard, heatmaps) | partial | no |
| Import from GA / CSV | n/a | yes (GA4, UA, CSV) | F yes (GA4 importer); U, P ? | no | no | no |

### Privacy and compliance

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Needs a consent banner in the EU (vendor's position) | yes | no | F, U no; P depends on mode | yes (consent signal enforced for EEA/UK/CH) | yes (cookies) | no in cookieless mode; persistent mode stores an id in localStorage |
| Consent Mode / CMP integration | yes (Consent Mode v2, basic/advanced, behavioural modelling) | n/a | P yes | yes (Consent API v2, CMPs; Google Consent Mode "coming soon") | ? | tags (Consent Mode v2 for GA4 and ad tags) |
| Honours GPC / DNT | no | ? | ? | no (FAQ: doesn't respond to DNT) | ? | yes (`respect_dnt` drops GPC/DNT events) |
| Data retention setting | yes (2 or 14 months; up to 50 on 360; affects explorations, not standard reports) | ? | ? | no (fixed: playback 30 days; heatmaps and favourites 9 months) | no (fixed: 365 days per Hotjar help; Contentsquare 1 month Free, 13 months paid) | yes (1-3650 days, default 400) |
| Internal traffic exclusion | yes (IP rules + data filters, up to 10) | yes (exclude IPs, pages) | ? | yes (IP blocking) | ? | partial (`localStorage.afsa_ignore`, hostname allow-list; no IP rules) |
| URL / PII stripping | partial (redaction of emails and chosen query params) | yes (no personal data stored) | ? | yes (masking) | yes (suppression) | yes (query strings never stored, only UTMs and the first click id) |
| Per-user deletion | yes (user deletion API) | n/a | P yes | no (FAQ: delete the whole project) | yes (API deletion request) | no (whole site only) |
| EU data residency | no | yes (EU hosted) | F yes (EU isolation); P yes (EU cloud); U ? | partial (EU customers contract with Microsoft Ireland; stored in Azure, region unstated) | ? | no (no jurisdiction setting) |

### Behaviour analytics: recordings, heatmaps and frustration signals

| Capability | GA4 | Plausible | Fathom / Umami / PostHog | Clarity | Hotjar | AFS today |
|---|---|---|---|---|---|---|
| Session recordings | no | no | U yes (3.2+, 15% default sample, 5 min default cap, 30 days); P yes; F no | yes (free; up to 100k recorded sessions per project per day; 30 days) | yes (Contentsquare: 5% capture Free, 15% Growth, up to 100% Pro) | no |
| Click / tap heatmaps | no | no | U, P yes | yes | yes | no |
| Scroll heatmaps | no | no | U, P yes | yes | yes | no |
| Move heatmaps | no | no | P yes (heatmap includes mouse moves); U no | no | yes | no |
| Area / zone heatmaps | no | no | no | yes (area maps) | yes (engagement zones, Growth+) | no |
| Conversion / revenue maps | no | no | no | yes (conversion maps) | partial (impact quantification) | no |
| Rage clicks | no | no | P yes (3 clicks within ~1 s); U no | yes | yes (5 clicks on one element within 500 ms) | no |
| Dead clicks | no | no | U yes (in click heatmap); P yes | yes | ? (frustration filters on Growth+) | no |
| Quick backs / U-turns | no | no | no | yes (quick backs) | yes (U-turn: back to previous URL within 7 s) | no |
| Excessive scrolling | no | no | no | yes | no | no |
| JavaScript errors | no | no | U yes (error tracking); P yes | yes (+ "click errors" after a click) | yes (console in player; error analysis on Pro) | no |
| Session scoring | no | no | no | partial (ML insights) | yes (relevance, frustration, engagement scores) | no |
| Surveys and feedback widgets | no | no | P yes (surveys) | no | yes | no |
| User interviews | no | no | no | no | yes (Engage, now run in Contentsquare) | no |
| AI summaries of sessions and heatmaps | no | no | P yes | yes (Copilot) | yes (Sense, Growth+) | no |
| Masking controls | n/a | n/a | U yes (moderate: inputs); P yes (inputs by default) | yes (Balanced default; Strict, Relaxed; selectors, attributes) | yes (inputs, numbers, emails suppressed by default) | n/a |
| AI crawler activity from server logs | no | no | P partial (bot classification) | yes (Bot activity via CDN logs, AI citations) | no | partial (bots dropped and counted per reason, incl. AI crawlers) |

**Where AFS is already ahead or unusual:** agent setup in two requests with idempotent sites, an
install verifier that returns fixes, signed first-party proxy snippets for five platforms,
server-side events that join the browser visit, read-only SQL, a remote read/write MCP with
OAuth, ASN and coarse lat/long, GPC/DNT handling, a per-site retention setting, and bot drop
counts by reason. The tags service covers what GA4 does for ad platforms (conversions, Consent
Mode), which the privacy-first tools don't do at all.

---

## 2. Gaps for AgentFirstStack Analytics, ranked

Ranked by how often a small-business or SaaS owner would ask about it ("how did last week go?"
comes up far more than "show me segment overlap"). The ranking is our judgement, not data.
Headless shapes follow the existing conventions: REST under `/v1/sites/:id/...`, the same filter
grammar, and one MCP tool per verb.

| # | Gap | Who has it |
|---|---|---|
| 1 | Scheduled email and Slack reports | GA4, Plausible, Fathom, PostHog |
| 2 | Alerts: spike, drop, tracking stopped, goal drop | GA4, Plausible, PostHog, Clarity (drop only) |
| 3 | A real human dashboard (filters, goals, funnels, revenue, channels) | everyone |
| 4 | Comparisons per row, year over year and custom | GA4, Plausible, Fathom, Umami |
| 5 | Search Console keywords | GA4, Plausible, Fathom |
| 6 | Paths / user journeys | GA4, Plausible, Umami, PostHog |
| 7 | Scroll depth and time on page per page | GA4 (90% only), Plausible, PostHog |
| 8 | Returning visitors, retention and cohorts | GA4, Umami, PostHog |
| 9 | Ad spend import and ROAS / CAC per campaign | GA4, PostHog |
| 10 | Annotations | GA4, Plausible, Fathom, Umami, PostHog |
| 11 | 404 and form-submission auto-tracking | Plausible (both), GA4 (forms) |
| 12 | Saved segments and richer share links (password, segment lock, embed, expiry) | Plausible, Fathom |
| 13 | Import from GA4 / Plausible / CSV | Plausible, Fathom |
| 14 | CSV and bulk raw export | GA4, Plausible, Fathom, PostHog |
| 15 | Core Web Vitals per page | Umami, PostHog, Clarity |
| 16 | Site search terms | GA4 |
| 17 | Multi-site roll-up | Plausible, Fathom |
| 18 | Revenue currency conversion | GA4, Plausible |
| 19 | IP / internal-traffic rules | GA4, Plausible, Clarity |
| 20 | Visitor / session explorer | GA4, Umami, PostHog, Clarity |

### 1. Scheduled email and Slack reports

- **What:** a weekly or monthly digest (visitors, top sources, top pages, conversions, revenue,
  change vs the previous period) sent to people, a Slack channel or a webhook.
- **Why:** this is how most owners consume analytics; many never open a dashboard. Already listed
  as v2 (`mail/`).
- **Headless:** `POST /v1/sites/:id/reports {cadence: weekly|monthly, channel: email|slack|webhook,
  to, metrics?, breakdowns?, filters?, send_at?}`, `GET/DELETE`, `POST /reports/:rid/send` for a
  test. MCP `create_report`, `list_reports`, `send_report_now`. Also `get_digest {period}`: the same
  content as JSON plus a short plain-English summary, so an agent can post it wherever it likes.
- **Human:** the email itself (inline numbers, no attachments), plus a "Reports" settings page
  listing schedules and recipients, with an unsubscribe link in every mail.

### 2. Alerts

- **What:** notify when traffic spikes or drops, when no events arrived for N hours (tracking
  broke), when a goal's conversions fall, or when bot or proxy-key warnings jump.
- **Why:** "tell me if something breaks" is the second thing owners ask for, and "tracking
  silently stopped" is the most expensive failure for an agent-installed setup. Plausible and GA4
  have it; Clarity only sends a fixed "traffic dropped 50%" mail.
- **Headless:** `POST /v1/sites/:id/alerts {metric, filters?, condition: above|below|change_pct|
  anomaly|no_data, threshold?, window: 1h|12h|1d, channels: [email|slack|webhook], cooldown?}`;
  `GET /alerts/:aid/history`. MCP `create_alert`, `list_alerts`, `get_alert_history`. Evaluated by
  the per-site DO alarm that already purges data daily (hourly for `no_data`). Webhook payload signed
  like tags' webhooks. Firing an alert writes an annotation (gap 10).
- **Human:** alert list with last fired time; fired alerts drawn on the chart.

### 3. A real human dashboard

- **What:** today's share page has totals, one chart and four top-10 tables. Owners expect
  click-to-filter, channel/source/UTM tabs, entry and exit pages, region and city, goals with
  conversion rate, revenue, funnels, realtime, and period compare.
- **Why:** the API answers all of this, but a person handed a link can't. Every competitor's
  baseline is the Plausible-style single page.
- **Headless:** nothing new: the page should only call public `share/:token/data` endpoints that
  mirror `stats`, `breakdown`, `timeseries`, `funnel` and `realtime` (aggregates only, the share
  token's scope), so the dashboard and agents stay one code path.
- **Human:** one page: KPI row (visitors, visits, pageviews, bounce, duration, conversions,
  revenue, live now), chart with compare overlay and annotations, then panels Sources
  (channel/source/UTM/campaign), Pages (top/entry/exit), Locations (country/region/city), Devices
  (browser/OS/device), Goals (conversions, CR, revenue), Funnels (saved). Clicking any row adds a
  filter pill; the URL keeps the state.

### 4. Comparisons per row, year over year, custom

- **What:** `compare` on breakdown rows and timeseries, with `previous`, `year` and custom ranges
  and a "match weekday" option.
- **Why:** "which sources dropped vs last month?" needs row-level deltas; the totals-only compare
  can't answer it. Already in the v2 list.
- **Headless:** `compare=previous|year|custom&compare_from=&compare_to=&match_weekday=true` on
  `stats`, `breakdown`, `timeseries`; each row gets `comparison: {metrics, change_percent}`; a
  `sort=change` option to surface the biggest movers. MCP: same params on the existing tools, plus
  `get_top_movers {metric, breakdown}`.
- **Human:** delta column in every table, dashed previous-period line on the chart.

### 5. Search Console keywords

- **What:** Google search queries, impressions, clicks, CTR and position per page, via the Search
  Console API.
- **Why:** "what are people searching to find me?" is the most common SEO question; GA4, Plausible
  and Fathom all integrate. Analytics can't see keywords otherwise.
- **Headless:** `POST /v1/sites/:id/integrations/search-console` (OAuth link the human approves,
  or an agent-provided refresh token), then `breakdown=search_query` and `breakdown=search_page`
  with `impressions, clicks, ctr, position` metrics, cached daily in the DO. MCP
  `connect_search_console`, `get_search_queries {period, page?}`.
- **Human:** a "Search terms" tab in the Sources panel; per-page query list when a page filter is
  applied.

### 6. Paths / user journeys

- **What:** what visitors did next from a page or event, or what led to a goal (backwards).
- **Why:** "what do people do after /pricing?" and "which pages lead to signups?" are frequent;
  funnels only answer it when you already know the steps.
- **Headless:** `GET /v1/sites/:id/paths?start=/pricing|event:x&direction=forward|backward&
  steps=5&group=dir&limit=10` (or `end=goal:Signup`), within a session; returns a tree of
  `{step, value, visitors, dropoff}`. MCP `get_paths`.
- **Human:** column view (Plausible's journeys) or a Sankey, with "no further action" per column.

### 7. Scroll depth and time on page per page

- **What:** max scroll % per pageview and per-page engagement time, as page-breakdown metrics and
  as goals ("reached 75% of /blog/*").
- **Why:** "do people read my posts / see my CTA?" Plausible made this a headline feature; GA4 only
  has a 90% event.
- **Headless:** tracker adds max scroll % to the engagement beacon it already sends; new metrics
  `scroll_depth` and `time_on_page` valid with `breakdown=page`; goal type
  `{type: "scroll", match: "/blog/*", threshold: 75}`.
- **Human:** two columns in the Pages panel; scroll goals in Goals.

### 8. Returning visitors, retention and cohorts

- **What:** new vs returning, and week-N retention of visitors or users who did X.
- **Why:** SaaS owners ask "do signups come back?"; content sites ask "do readers return?". In v2.
- **Constraint:** cookieless ids reset daily, so cross-day retention is impossible by design for
  anonymous visitors. Be explicit: retention works on `user_id` (identified users, the SaaS case)
  and on `persistent` mode; cookieless sites get same-day returning visits only.
- **Headless:** `GET /v1/sites/:id/retention?cohort=first_seen|goal:Signup&return=any|event:x&
  interval=week&periods=8&identity=user_id|visitor`; metric `returning_visitors` where identity
  allows. MCP `get_retention`. The response says which identity it used and why.
- **Human:** cohort triangle; a new/returning split on the chart when available.

### 9. Ad spend import and ROAS / CAC

- **What:** cost, clicks and impressions per campaign joined to conversions and revenue.
- **Why:** owners running ads ask "is my spend paying off?". PostHog now pulls six ad networks;
  GA4 does it for Google Ads. Tags already sends conversions out, but nothing brings cost in.
- **Headless:** `POST /v1/sites/:id/costs` (rows `{date, source, medium?, campaign, cost, currency,
  clicks?, impressions?}`) for agents that already hold ad-platform MCPs, then connectors later;
  metrics `cost, cpc, cpa, roas` valid with `breakdown=utm_campaign|source|channel`. MCP
  `import_costs`, and `get_stats` gains the metrics.
- **Human:** a Campaigns table: spend, visitors, conversions, revenue, CPA, ROAS.

### 10. Annotations

- **What:** dated notes on the chart (deploys, launches, campaigns, outages).
- **Why:** every competitor but Clarity has them, and they are unusually valuable here: the agent
  that deploys a change or starts a campaign can write the note itself, and alerts can write them
  too.
- **Headless:** `POST /v1/sites/:id/annotations {date|from,to, title, description?, source?}`,
  `GET`, `DELETE`; MCP `add_annotation`, `list_annotations`. Returned alongside `timeseries`.
- **Human:** markers on the chart with hover text.

### 11. 404 and form-submission auto-tracking

- **What:** a `404` event (path + referrer) and a `form_submit` event (form id/action), automatic.
- **Why:** "which links are broken?" and "are my contact forms used?" are common for small
  business sites; Plausible tracks both, GA4 tracks forms.
- **Headless:** tracker option `data-404="true"` or a `<meta name="afsa-404">` hint, or
  `afsa('404')`; `form_submit` behind `data-auto`. They show up as events and can be goals; verify
  can check that a test 404 page sends the hint.
- **Human:** a "Broken pages" list (404 path, referrer, count) and forms in the Goals panel.

### 12. Saved segments and richer share links

- **What:** named filter sets, and share links with password, expiry, a locked segment, and an
  official embed mode.
- **Why:** agencies and founders share dashboards with clients and investors, often only a slice.
- **Headless:** `POST /v1/sites/:id/segments {name, filters}`, `segment=<id>` on every query;
  `POST /share {password?, expires_at?, segment_id?, embed?: true}`. MCP `create_segment`,
  `list_segments`; `create_share_link` gains the options.
- **Human:** segment picker; password prompt; embed snippet with an explicit `frame-ancestors`
  allow-list.

### 13. Imports

- **What:** historical data from GA4 (Data API), Plausible (CSV export) or a generic CSV, stored as
  daily aggregates and merged into reports.
- **Why:** owners won't switch if they lose history; Plausible and Fathom both import GA4.
- **Headless:** `POST /v1/sites/:id/imports {source: ga4|plausible_csv|csv, ...}` returning a job;
  `GET /imports/:jid`. MCP `start_import`, `get_import`. Imported ranges are flagged in responses
  (aggregates can't be filtered like raw events).
- **Human:** import status and the imported range shaded on the chart.

### 14. CSV and bulk raw export

- **What:** CSV for any breakdown, and scheduled raw event export (for example to R2) beyond the
  1000-row SQL cap.
- **Why:** accountants, spreadsheets, warehouses; lower frequency for small businesses.
- **Headless:** `format=csv` on `stats`/`breakdown`/`timeseries`/`sql`; `POST /exports
  {destination: r2|s3|url, schedule: daily, format: ndjson|parquet}`. MCP `create_export`.
- **Human:** "Download CSV" on each panel.

### 15. Core Web Vitals per page

- **What:** LCP, INP, CLS (p75) per page and device.
- **Why:** "is my site slow?" Umami, PostHog and Clarity have it; it is a small tracker addition and
  pairs with frustration signals if we build behaviour analytics.
- **Headless:** tracker reports vitals in the engagement beacon; metrics `lcp_p75, inp_p75,
  cls_p75` with `breakdown=page|device`. MCP via `get_stats`.
- **Human:** a Performance panel with good / needs improvement / poor per page.

### 16. Site search terms

- **What:** capture the value of configured search parameters (`q`, `s`, `search`) as a
  `site_search` event with a `term` prop.
- **Why:** "what are visitors looking for?" Useful for content and ecommerce. Needs an explicit,
  per-site opt-in because AFS drops query strings by design.
- **Headless:** site setting `site_search_params: ["q"]`; `breakdown=prop:term&filters=event_name==site_search`.
- **Human:** a "Site search" panel.

### 17. Multi-site roll-up

- **What:** one view summing several sites. In v2.
- **Headless:** `GET /v1/stats?sites=a,b,c` (or `site_id=all`) with per-site rows. MCP `get_stats`
  accepts several site ids.
- **Human:** the project page shows each site's 7-day visitors and conversions with a total.

### 18. Revenue currency conversion

- **What:** a site reporting currency; revenue converted at the event's date rate. In v2.
- **Headless:** site field `currency`; `revenue` returned converted, with `revenue_by_currency` raw.
- **Human:** totals in one currency with a tooltip of the originals.

### 19. IP / internal-traffic rules

- **What:** exclude IPs or CIDR ranges (offices, the owner's agents and CI) at ingest.
- **Headless:** site field `exclude_ips: ["203.0.113.0/24"]`; drops counted as reason `excluded_ip`.
- **Human:** a settings field; drop counts in the site summary.

### 20. Visitor / session explorer

- **What:** list sessions matching filters and show one session's timeline.
- **Why:** support and debugging ("what did this customer do?"); also the backbone of a future
  behaviour product (section 3).
- **Headless:** `GET /v1/sites/:id/sessions?filters=goal==Signup&limit=` and `GET /sessions/:sid`
  (events in order with page, source, device, props). MCP `list_sessions`, `get_session`. Cookieless
  ids keep this same-day and anonymous unless `user_id` is set.
- **Human:** a session list and a timeline view.

**Deliberately not recommended:** demographics (needs ad-network identity data, against the
product's privacy stance), predictive audiences, segment overlap, and data-driven attribution (needs
volume small sites don't have). Multi-touch attribution for ad platforms stays in tags.

---

## 3. Behaviour analytics product notes (a possible "headless Clarity")

### How Clarity and Hotjar collect

- **Not video.** Both reconstruct sessions from the DOM. Clarity: it "records all the page
  information a user sees (the DOM content) and the actions they take"; the capture code is open
  source (`github.com/microsoft/clarity`). Hotjar: recordings are "a reconstruction of events",
  built in three steps (capture, reconstruction, playback), starting from the initial HTML and DOM
  tree, with event listeners on DOM elements.
- **The common pattern (rrweb):** one full snapshot of the serialised DOM, then incremental
  snapshots for DOM mutations (MutationObserver), pointer moves, clicks, scrolls, input changes
  and viewport changes, each timestamped. PostHog uses rrweb directly ("full snapshots (complete
  DOM state) + incremental snapshots (mutations/interactions)"), batches them, compresses each
  session block with Snappy and writes them to S3. Datadog's replay also uses rrweb and compresses
  in a web worker before sending.
- **Assets:** Clarity and Hotjar don't store page CSS and images with the recording; the player
  loads them from the live site, so Clarity warns that CSS must be "available externally without
  the need for authentication". Datadog says CSS is captured in the snapshot. A redesign can
  therefore break old recordings in Clarity and Hotjar.
- **Heatmaps** are aggregates of click coordinates/element selectors and scroll reach per URL and
  device width, overlaid on a captured page state. Clarity picks "a random playback" as the
  background; Umami loads the live page in an iframe (which needs `frame-ancestors` to allow it);
  Hotjar builds heatmaps from recordings data on demand (deleting recordings removes them from
  heatmaps).
- **Not captured:** canvas content, video player state (Hotjar), third-party iframes (Clarity
  captures only same-domain iframes), closed shadow roots (Hotjar), dynamic hover/open states in
  heatmap screenshots (Clarity), content inside `<div>` scroll containers for scroll maps (Clarity
  scroll maps are for `<body>`, up to 65,535 px tall).
- **Frustration signals** are derived from the event stream: rage clicks (Hotjar: 5 clicks on one
  element within 500 ms; PostHog: 3 within about 1 s; Clarity: "multiple times in a clustered area in
  rapid succession", no number given), dead clicks (no DOM change or navigation "in a reasonable
  amount of time"), quick backs (Clarity: return within the page's dwell-time threshold) or
  U-turns (Hotjar: back to the previous URL within 7 s), excessive scrolling (more vertical
  scrolling than the expected average), JS errors and "click errors" (an error right after a
  click).

### Privacy defaults and masking

| | Clarity | Hotjar | PostHog | Umami |
|---|---|---|---|---|
| Default | Balanced: numbers and email addresses masked | Inputs suppressed; numeric characters and email-like text suppressed | Inputs masked; page text not masked | Moderate: all inputs masked |
| Always masked | Input boxes and dropdowns, in every mode | Numbers of 9+ digits; fields named like email, phone, username can't be unmasked | Password inputs | ? |
| Stricter option | Strict: all text masked | Suppress all text | `maskTextSelector: "*"` | Strict: all text masked |
| Looser option | Relaxed: no text masked (inputs still are) | `data-hj-allow` on inputs only, plus a site setting | `maskInputFn`, unmask tokens | ? |
| Per element | `data-clarity-mask` / `data-clarity-unmask`, CSS selectors in settings | `data-hj-suppress`, `data-hj-allow` | `ph-no-capture` (block) | Block selector |
| Where | Client side, "never uploaded"; changes not retroactive, up to 1 h to apply | Client side | Client side; network bodies need a callback | Client side |
| Gaps | Content in style sheets isn't masked | Inline SVGs can't be suppressed | Page URL query strings not redacted by default | not documented |
| Consent | Explicit consent signal required for EEA/UK/CH visitors; without it sessions fragment and full replays are unavailable | Uses cookies | `cookieless_mode` option | ? |
| Other | Doesn't honour DNT; per-user deletion means deleting the project; not for sites aimed at under-18s | API user lookup and deletion | | Sample rate 15% default |

For our version: mask all text and inputs by default (Strict), unmask by selector, do it in the
browser before anything leaves, reuse AFS's cookieless visitor id (no new cookies), drop query
strings as analytics already does, and honour GPC/DNT and `respect_dnt`.

### Storage size per session

No vendor publishes an average stored size. What exists:

- Datadog: replay network impact "less than 100 kB/min" (compressed, on the wire).
- rrweb Cloud (vendor marketing): a 5-minute recording is "~200 KB instead of ~1,000 KB
  uncompressed"; its fair-use policy caps the average at 5 MB compressed per session.
- A third-party write-up: 100-500 KB for a typical 5-minute session, compressed.
- Clarity says it processes "more than 1 petabyte of data from over 100 million users per month",
  about 10 MB per monthly user. That is processed volume across everything, not stored size per
  session, so treat it as an order of magnitude only.

**Planning figure: 20-100 KB per minute compressed**, driven by DOM size and mutation rate
(SPAs, carousels and live counters are the expensive cases). A small site with 10,000 recorded
sessions a month at a 2-minute median is about 0.4-2 GB a month; with 30-day retention that is
roughly the stored total. Storage is cheap; ingest requests, server-side processing (signals,
heatmap aggregation) and player bandwidth cost more. Heatmaps don't need full recordings: click
and scroll aggregates are well under 1 KB per pageview, plus one background snapshot per URL and
width.

### Limits and retention (for reference)

| | Clarity | Hotjar / Contentsquare |
|---|---|---|
| Price | Free, "no traffic limits" | Free tier, then from $39/month (Growth); Pro and Enterprise custom |
| Recording volume | Up to 100,000 recorded sessions per project per day ("all sessions tracked", but not all have recordings); the FAQ also says "no sampling", which conflicts | Capture rate by plan: 5% Free, 15% Growth, up to 100% Pro/Enterprise; Free up to 200k sessions/month |
| Retention | Playback 30 days; heatmaps, favourites and a random sample 9 months | Hotjar help: 365 days for recordings and heatmaps; Contentsquare pricing: 1 month Free, 13 months paid (these conflict; the Contentsquare plan probably governs new accounts) |
| Heatmap cap | 100,000 page views per heatmap | ? |
| API | Export API: 10 requests/project/day, last 1-3 days, 1000 rows, no pagination; recordings can't be downloaded | API on Pro/Enterprise only: survey responses, user lookup, deletion |
| MCP | Official, built on the export token (same limits) | Contentsquare MCP, 300 tool calls/month on Free |

The thin Clarity export API is the opening: Clarity is free and good for humans, but an agent can
barely get data out of it.

### Questions these tools answer

1. Why do visitors drop off at this step (pricing, signup, checkout)?
2. Is something broken? (dead clicks, rage clicks, JS errors, click errors on a page)
3. Do visitors see the CTA or the content below the fold? (scroll reach)
4. What do people click that isn't clickable, and what do they ignore?
5. How does mobile behaviour differ from desktop on this page?
6. Which JS errors hit real users, on which pages and browsers?
7. What happened in this customer's session? (identify plus a support ticket)
8. Did the redesign or release change behaviour? (heatmap compare, before/after)
9. Where are people confused? (quick backs, U-turns, excessive scrolling)
10. What do users say and why? (Hotjar only: surveys, feedback widgets, interviews)

### The 10 capabilities that matter most for a headless version

1. **Masked-by-default capture in the existing snippet.** rrweb-style full snapshot plus
   mutations and interactions, Strict masking, sampling rate, maximum duration, page block list,
   consent-aware, opt-in per site, sharing AFS's visitor and session ids so every recording joins
   analytics (channel, goals, funnels) for free.
2. **Server-side frustration signals as analytics events.** Rage clicks, dead clicks, error clicks,
   quick backs/U-turns and excessive scrolling, emitted as events into the site's DO, so existing
   `stats`, `breakdown`, `funnel` and filters work on them (`filters=event_name==rage_click&
   breakdown=page`).
3. **JS errors and Web Vitals.** Message, stack, page, browser and the triggering click, grouped by
   fingerprint; LCP/INP/CLS per page. Cheap to collect, and the most actionable output.
4. **Session search API.** `GET /sessions?filters=page~/checkout;signal==rage_click;goal!=Purchase&
   sort=frustration` returning ids with scores (relevance, frustration), duration, pages and
   signals.
5. **An agent-readable session.** `GET /sessions/:sid/timeline`: a compact JSON or text
   transcript (pages, clicked element labels and selectors, masked inputs, scrolls, errors,
   signals, timestamps). This, not video, is the headless primitive; an agent can read 50 of these
   where a person can watch two. Add `summarize_sessions {session_ids | filters}` for grouped
   summaries.
6. **Heatmap aggregates as data.** `GET /heatmaps?url=/pricing*&device=mobile&type=click|scroll`:
   clicks per element (selector, text label, count, rage/dead share) and a scroll-reach curve, with
   an optional rendered PNG for humans (headless browser over the stored snapshot).
7. **Funnel step to sessions.** From `get_funnel`, return a link or ids of sessions that dropped at
   each step (Clarity and Hotjar both do this), so "why do 60% drop at /signup?" is one call.
8. **A human replay player behind a share link.** Token-scoped, expiring, with skip-inactivity, an
   event timeline, console errors and the masked page; no account needed.
9. **Privacy and governance controls.** Masking mode and selectors, URL/network scrubbing, consent
   API, retention setting, per-visitor deletion (Clarity can't), and audit of who viewed what.
10. **Alerts and digests on behaviour.** New JS error type, a rage-click spike on a page, a funnel
    step regressing after a deploy (with an annotation), delivered through the same report and
    alert channels as gaps 1 and 2.

Surveys, feedback widgets and interviews (Hotjar's "Ask" and "Engage") are a separate product
shape and can wait.

---

## Sources

**AgentFirstStack:** `analytics/README.md`, `analytics/src/llms.ts`, `analytics/src/do/engine.ts`,
`analytics/src/service/*.ts`, `analytics/src/lib/{filters,channel,time}.ts`,
`analytics/src/share-page.ts`, `analytics/src/routes/share.ts`, `docs/accounts.md`, `tags/README.md`.

**Google Analytics 4**
- Explorations: https://support.google.com/analytics/answer/7579450
- Funnel exploration: https://support.google.com/analytics/answer/9327974
- Data retention: https://support.google.com/analytics/answer/7667196
- BigQuery export: https://support.google.com/analytics/answer/9358801
- Custom dimension and metric limits: https://support.google.com/analytics/answer/10075209
- Key events: https://support.google.com/analytics/answer/13128484
- Insights: https://support.google.com/analytics/answer/9443595
- Enhanced measurement: https://support.google.com/analytics/answer/9216061
- Realtime pages: https://support.google.com/analytics/answer/15315925
- Annotations: https://support.google.com/analytics/answer/15884203
- Scheduled emails: https://support.google.com/analytics/answer/13722168
- Comparisons: https://support.google.com/analytics/answer/9269518
- Internal traffic: https://support.google.com/analytics/answer/10104470
- Consent mode: https://support.google.com/analytics/answer/9976101
- Attribution (models; first click, linear, time decay, position-based removed Nov 2023): https://support.google.com/analytics/topic/10597959
- AI Assistant channel (secondary source): https://www.searchenginejournal.com/google-analytics-adds-ai-assistant-as-default-channel-group/574974/
- MCP server (repository, not fetched): https://github.com/googleanalytics/google-analytics-mcp

**Plausible:** https://plausible.io/docs and its pages `/docs/subscription-plans`,
`/docs/goal-conversions`, `/docs/funnel-analysis`, `/docs/user-journeys`,
`/docs/ecommerce-revenue-tracking`, `/docs/scroll-depth`, `/docs/filters-segments`,
`/docs/compare-stats`, `/docs/shared-links`, `/docs/traffic-spikes`, `/docs/slack-reports`,
`/docs/data-access`. (plausible.io/pricing returned 404; plan facts are from subscription-plans.)

**Fathom:** https://usefathom.com/features, https://usefathom.com/docs,
https://usefathom.com/api, https://usefathom.com/docs/features/milestones,
https://usefathom.com/changelog/oct2023-uptime-monitoring (uptime monitoring removed).

**Umami:** https://docs.umami.is/docs/ and `/docs/replays`, `/docs/heatmaps`, `/docs/mcp`,
`/docs/attribution`, `/docs/links`.

**PostHog:** https://posthog.com/docs/web-analytics, https://posthog.com/docs/web-analytics/start-here,
https://posthog.com/docs/web-analytics/web-vitals, https://posthog.com/docs/toolbar/heatmaps,
https://posthog.com/docs/session-replay/privacy, https://posthog.com/docs/privacy/cookieless-tracking,
https://posthog.com/handbook/engineering/session-replay/session-replay-architecture.

**Microsoft Clarity:** https://learn.microsoft.com/en-us/clarity/ and `faq`,
`setup-and-installation/data-retention`, `setup-and-installation/clarity-masking`,
`setup-and-installation/clarity-data-export-api`, `setup-and-installation/funnels`,
`setup-and-installation/smart-events`, `heatmaps/heatmaps-features`, `insights/semantic-metrics`,
`insights/dashboard-features`, `insights/performance-widget`, `copilot/overview`,
`ai-visibility/bot-activity-overview`, `third-party-integrations/clarity-mcp-server`; capture code
https://github.com/microsoft/clarity.

**Hotjar / Contentsquare:** https://contentsquare.com/hotjar, https://contentsquare.com/pricing/
(hotjar.com/pricing redirects here), https://www.hotjar.com/product/engage, and Hotjar help
articles (read through search snippets; direct fetch returned 403):
suppression https://help.hotjar.com/hc/en-us/articles/36819956605329,
how recordings work https://help.hotjar.com/hc/en-us/articles/36820006445585,
types of heatmaps https://help.hotjar.com/hc/en-us/articles/36820020346385,
recordings list and scores https://help.hotjar.com/hc/en-us/articles/36820005706385,
data retention https://help.hotjar.com/hc/en-us/articles/36819991007505,
API https://help.hotjar.com/hc/en-us/articles/36820005914001,
integrations https://help.hotjar.com/hc/en-us/articles/36819973021457.

**Session size:** https://docs.datadoghq.com/real_user_monitoring/session_replay/browser/,
https://rrweb.com/product/cloud, https://rrweb.com/fup.
