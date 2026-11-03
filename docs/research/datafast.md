# DataFast: feature walkthrough (2026-11-03)

Reviewed in a live account (startglobal.co site) and against https://datafa.st/docs. Purpose:
make sure AgentFirstStack Analytics can answer every question DataFast answers, headless (API/MCP)
first, and with a comparable human view where it helps. "AFS" = AgentFirstStack Analytics today.

## Account home

- **Site cards:** one card per site, each with a 24h bar chart, visitors and revenue, plus an
  "all websites" aggregate card. Actions: Share, Order and Add website.
  - AFS: projects in the dashboard; no per-site sparkline cards or cross-site aggregate yet.

## Site dashboard

| Area | DataFast | AFS today |
|---|---|---|
| Controls | Site switcher, date range with prev/next, Compare, granularity, filter, refresh | Periods, compare=previous, interval, filters (API) |
| KPIs | Visitors, Revenue, Conversion rate, Revenue/visitor, Bounce rate, Session time, Online now; each with % delta | visitors, visits, pageviews, bounce, duration, conversions, conversion rate, revenue, realtime (no revenue/visitor yet) |
| Main chart | Visitor area plus revenue bars split new and renewal; today projected (dashed); tooltip with new vs returning visitors, revenue split, rev/visitor, conversion rate | Timeseries API; no new vs returning, no new vs renewal |
| Annotations | Auto "Traffic spike from Facebook" markers with source; manual notes; social mentions (X, Reddit); GitHub commits; X post attribution | None |
| Acquisition panel | Channel, Referrer, Campaign, Keyword (from GSC); donut; channel drill-down (for example Organic search); sort by visitors or revenue | Channel, source, referrer, UTM, click IDs; no keywords; no revenue sort per row |
| Content panel | Hostname, Page, Entry page, Exit link, with visitor and revenue bars | page, entry, exit, hostname, outbound_click events; no revenue per page |
| Geo panel | Map, Country, Region, City | country, region, city, continent (no map view) |
| Tech panel | Browser, OS, Device | browser, version, os, device |
| Goals | Multi-line goal chart, searchable goal list with counts, compare | goals (event/pageview), conversions, goal breakdown |
| Funnels | Flow visual with step drop-offs, conversion rate, multiple saved funnels | funnel query by steps (not saved) |
| Users | Visitor list: generated names and avatars, identified customers (name, "Customer" badge), country/device/OS/browser, source, spent, last seen, activity dots, search, load more | user_id on events; no visitor list API |
| Visitor profile | Location to city, screen size, custom parameters; timeline (arrived via, page views, events with params); pageviews, spent, time to completion; activity calendar | Raw events reachable via SQL only |
| Journeys | Visitors who completed a goal: source, spent, time to complete, touchpoint dots | None |
| AI crawlers | AI answers / Indexing / Training counts over time per provider (ChatGPT, Claude, Gemini, DuckDuckGo, Mistral, Amazon); requested pages; needs server-side bot logging (token) | Bots dropped and counted by reason only; no server-side bot ingestion |
| Realtime globe | 3D globe with live visitors; summary (visitors, est. value, referrers, countries, devices); live activity feed; sound; share | realtime API (visitors, pages, countries, recent events); no map coordinates endpoint |
| Insights (bento) | Revenue share by device/OS/browser; avg daily visitors and revenue; top revenue and conversion sources and countries; days-to-purchase and visits-to-purchase histograms; % buying on first visit; median hours to purchase; conversion rate; rev/visitor growth; top converting events; day x hour heatmap | None of these derived insights |

## Settings (per site)

- **General:**
  - Install tabs: script, npm, Shopify, WordPress.
  - Cookieless/privacy mode toggle.
  - Domain, with subdomains tracked automatically.
  - **Managed proxy** on your own subdomain (for example `a.startglobal.co`).
  - Timezone and **#1 KPI** (Revenue, MRR or a Goal).
  - Chart colour scheme, nickname and icon, public dashboard toggle, delete.
- **Dashboard:** optional cards (bot traffic).
- **Revenue:** payment provider connect (Stripe, LemonSqueezy, Polar, Paddle, Dodo, Shopify,
  WooCommerce, Payment API), currency, "include renewal revenue in KPIs".
- **Team:** invite by email with a role (Viewer and others).
- **Import:** from Plausible (zip).
- **Reports:** weekly summary email and traffic spike email.
- **Alerts:** notify when visitors complete goals (200 a month on this plan); alert history.
- **Widgets:** public widgets with aggregated metrics.
- **Integrations:** Google Search Console (keywords); X and Reddit mentions (Growth plan).
- **API / MCP:** website keys (create, roll, delete, last used); MCP server with OAuth.
- **Exclusions:** IPs (shows your current IP), paths with wildcards, hostnames, countries (also
  hides past data).
- **Security:** "attack mode", which switches on automatically on traffic spikes.

## Developer surface (docs)

- **Tooling:** CLI (websites, tokens, analytics, visitors, goals, alerts, funnels), MCP with a tool
  reference and OAuth, ChatGPT app, mobile app.
- **SDKs and guides:** npm SDK, React Native/Expo, and install guides for 20+ platforms (Next.js,
  Astro, Webflow, Framer, Lovable, Bolt, v0, Replit, Shopify, WordPress, GTM and others).
- **Proxy guides** for 12 stacks, plus a managed reverse proxy.
- **Tracking:** across subdomains, across domains, hashed paths, scroll events, user identification,
  web-to-app funnels.
- **API:**
  - account, access tokens, websites, website keys
  - goals: list, customise, analyse, properties, create, delete
  - funnels CRUD, manual notes CRUD, alerts CRUD with history, team
  - integrations: connect Stripe, LemonSqueezy, Polar and Paddle; Shopify and WooCommerce
  - visitors: list, get; social mentions
  - analytics: time series, overview, metadata, realtime, realtime map
  - bot traffic: summary, requested pages, usage, settings, token
  - breakdowns: pages, exit clicks, referrers, countries, regions, cities, devices, browsers, OSs,
    campaigns, hostnames
  - funnel analytics, identify, payments create and delete

## What AFS needs for parity (ranked by how often an owner asks)

1. **Revenue attribution from payment providers** (Stripe first: webhook plus visitor id in
   checkout metadata; then Paddle, LemonSqueezy, Polar, Shopify), new vs renewal, MRR, currency,
   revenue per visitor, revenue per source/page/country.
2. **Visitors and journeys API:** list visitors (anonymous names, identified customers, spent, last
   seen), a visitor timeline, journeys to a goal with time to complete.
3. **Derived insights endpoint:** the DataFast bento set (first-visit purchase rate, days and visits
   to purchase, median time to purchase, top converting events, day x hour heatmap, revenue share by
   device/OS/browser).
4. **AI crawler analytics:** server-side bot hit ingestion (proxy/middleware snippet or log push),
   classified AI answers / indexing / training, per provider and per page.
5. **Annotations:** manual notes API, plus automatic traffic-spike detection naming the source.
6. **Alerts and reports:** goal alerts, weekly summary, traffic spike, delivered by AFS Mail and webhooks.
7. **Exclusions:** IPs, path wildcards, hostnames, countries.
8. **Saved funnels** (CRUD) with drop-off per step.
9. **Realtime map:** coarse coordinates per live visitor, plus a live activity feed.
10. **Search Console keywords** (OAuth to GSC).
11. **New vs returning visitors** in timeseries and KPIs.
12. **Imports** (Plausible zip, GA4), cross-domain tracking, scroll depth events, hashed paths.
13. **Human views:** a site dashboard comparable to the above (KPI row, combined chart, four panels,
    goals/funnels/users/journeys, insights bento, globe).
