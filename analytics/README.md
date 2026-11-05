# analytics

Cookieless, privacy-friendly web analytics that an agent can set up in two requests, with
server-side enrichment (every country, region and city from Cloudflare's edge, not from the
browser), server-side event ingestion for backends, goals, revenue attribution (Stripe webhook or
any provider), visitors and journeys, derived insights, comparisons, annotations with automatic
traffic-spike notes, saved funnels, ingest exclusions, scroll depth and Core Web Vitals, and an
agent-queryable stats API.

Sections marked (v2) are deliberately not built yet. `GET /llms.txt` is the complete manual.

## Agent quickstart

```sh
# 1. account + key (one request, no verification)
curl -X POST $BASE/v1/signup
# 2. a site; the response includes the exact <script> to paste and how to proxy it first-party
curl -X POST $BASE/v1/sites -H "Authorization: Bearer $KEY" -d '{"domain":"example.com"}'
# 3. after installing (and opening the site once in a browser), confirm it works
curl -X POST $BASE/v1/sites/$SITE/verify -H "Authorization: Bearer $KEY"
# 4. read numbers
curl "$BASE/v1/sites/$SITE/stats?period=7d&breakdown=country" -H "Authorization: Bearer $KEY"
```

## Architecture

```
browser ── /s.js (tracker, 5.3 KB min / 2.8 KB gzip) ──► POST /e ─┐
backend ── POST /v1/sites/:id/events ─────────────────────────────┤
billing ── POST /v1/sites/:id/payments ───────────────────────────┼─► Worker: enrich (geo, UA,
Stripe ─── POST /webhooks/stripe/:site_id (signed) ───────────────┤    bot filter, channel, visitor hash),
tags app (server-side forward) ───────────────────────────────────┘    verify Stripe-Signature
                                                      │
                                                      ▼
                                       SiteDO (one Durable Object per site, SQLite)
                                       events + sessions + goals copy, payments ledger,
                                       annotations; exclusions applied; queries run here;
                                       daily alarm: retention purge + traffic-spike notes
D1: accounts, api_keys, sites (+ exclusions), goals, share_links, funnels, integrations,
    alert_destinations, alerts, reports, alert_events (history), alert_usage
    (control plane, never on the ingest hot path)
cron (every 5 min): due alerts -> SiteDO numbers -> decide -> deliver (signed webhook, Slack,
    email to members); due reports -> digest -> deliver; retries; history purge
```

- **Per-site Durable Object (`SiteDO`, SQLite, `idFromName(site_id)`)** stores that site's events
  and sessions and runs its queries. It holds a copy of the site's settings and goals (pushed on
  every create/update/goal change) so ingest never touches D1. If the copy is ever missing, the
  Worker re-pushes it from D1 and retries. A DO for an unknown site id writes no storage. A daily
  DO alarm purges raw events and sessions older than `retention_days`, then writes
  traffic-spike annotations for the days since its last run.
- **DO schema migrations.** Each DO keeps `meta.schema_version`. Version 1 is the first release's
  schema (`SCHEMA_V1` in `src/do/engine.ts`, never edited); later versions are `MIGRATIONS`, each
  run in a transaction that also bumps the version, the first time the DO is instantiated after a
  deploy (`ALTER TABLE ... ADD COLUMN` guarded by a column check, new tables and indexes). A new DO
  runs the same steps. Version 2 adds `events.revenue_type, scroll_depth, lcp, inp, cls`,
  `goals.threshold`, `sessions(user_id)` index, and the `payments`, `payment_links`,
  `provider_events` and `annotations` tables. Version 3 adds `sessions.user_source` (`server` |
  `browser`: who sent the session's user id; backfilled from each session's events) and the
  `usage` table (per-UTC-day accepted events, bytes and refusals; purges never lower it).
  Version 4 adds `events.debug` (test traffic) with a partial index; 5 adds `goals.props` and
  `goals.counting`; 6 adds `utm_id`, `utm_source_platform`, `utm_creative_format`,
  `utm_marketing_tactic`, `language`, `screen` (events and sessions), `events.title` and
  `events.non_interactive`; 7 adds the `identities` table (first touch per visitor id and user,
  backfilled from the stored sessions in the migration); 8 adds subscriptions, costs, items, user
  properties, crawler hits, imports and exports; 9 adds `events.no_visit` (server events sent with
  `visit: false` that found no live visit: no sessions row, never counted as visitors or visits);
  10 rebuilds `imports` with a `tool` column (source other's tool slug) in its natural key, keeping
  its ids and rows.
- **Visitor identity.** Default `cookieless`: `visitor_id = sha256(daily_salt | site_id | ip | ua)`
  truncated to 16 hex chars, where `daily_salt = HMAC(SALT_SECRET, YYYY-MM-DD)` (UTC date of the
  event). No cookies, no storage, no cross-day linking. Optional per-site `persistent` mode: the
  `/e` response tells the tracker to keep the id in localStorage, so returning visitors are
  linkable; nothing in the snippet changes, and switching back to cookieless clears it.
- **Sessions**: 30 minutes of inactivity ends a session. Computed in the DO at ingest. Attribution
  is session-level: the session's first source, except that a Direct session adopts the first real
  source it sees (and earlier events of that session are re-attributed). Geo and device are
  inherited from the session by events that lack them (typical for server events).
- **Ignored referrers** (`src/lib/referrers.ts`): hosted checkouts, payment pages, 3-D Secure and
  sign-in hosts (Stripe Checkout / Payment Links / portal, PayPal, Paddle, Lemon Squeezy, Polar,
  Shopify checkout, Dodo, Razorpay, Klarna, Mollie, Adyen, Square, Chargebee, Google / Apple /
  Microsoft sign-in, ...) plus the site's own `ignored_referrers` count as no referrer, so a visitor
  back from paying keeps their source and the payment linked to that session isn't credited to
  Referral. A return after the session timeout opens a session that continues the visitor's
  latest attribution (within 24 h). Applied in the DO, which holds the site's list.
- **Enrichment** (server side, never trusted from the client): `country`, `region`,
  `region_code`, `city`, `continent`, `timezone`, `latitude/longitude` (rounded to 0.1°),
  `asn`/`as_org` from `request.cf`; browser, version, OS, device type from the UA (ua-parser-js
  v1, MIT). Bots are dropped and counted per reason: UA patterns (crawlers, HTTP libraries, uptime
  monitors, preview fetchers, AI crawlers), headless signatures, `navigator.webdriver`,
  `cf.botManagement.verifiedBot` / `cf.verifiedBotCategory` when present. Query strings are never
  stored; only the UTM tags and the first click id. The same goes for props, from every source
  (tracker, server events, the tags app's analytics destination): a value that starts with an
  http(s) URL or a path is cut at its first `?` or `#` (`stripUrlQuery` in `src/service/ingest.ts`),
  before PII redaction runs on what is left.
- **Channel classification** from referrer + UTM + click IDs: Direct, Organic Search, Paid Search,
  Organic Social, Paid Social, Email, Referral, Display, Affiliates, **AI Assistants**
  (chatgpt.com, perplexity.ai, claude.ai, gemini.google.com, copilot.microsoft.com, deepseek,
  meta.ai, grok, mistral, ...), and Paid Other (a paid utm_medium from an unknown source).
  Click IDs captured: gclid, gbraid, wbraid, dclid, msclkid, fbclid, ttclid, li_fat_id, twclid,
  rdt_cid, epik, sccid. `fbclid` alone is Organic Social (Meta adds it to organic clicks too).
- **First-party proxying.** The tracker posts to the origin and path prefix it was loaded from
  (`/_a/s.js` -> `/_a/e`), so serving it through the customer's own domain makes collection
  first-party and ad-block resistant. The Worker accepts `/s.js` and `/<any-prefix>/s.js` (same for
  `/e`). The install response includes snippets for a Cloudflare Worker route, Next.js `proxy.ts`
  (`middleware.ts` before Next.js 16), vercel.json (a route with a request-header transform),
  `netlify.toml` and nginx. Forwarded headers are trusted only from a request carrying the site's
  **proxy key**, `x-afs-proxy-key: hex(HMAC-SHA256(SALT_SECRET, site_id))`, which every snippet
  sends from the customer's server (it is returned as `install.first_party_proxy.proxy_key`; never
  put it in browser code; rotating `SALT_SECRET` changes it). With the key, the visitor IP is the
  first `X-Forwarded-For` hop and geo comes from `x-afs-geo-*` headers (the Worker snippet forwards
  `request.cf`, the Next.js one maps Vercel's) or Vercel's `x-vercel-ip-*`, else Cloudflare's view
  of the request (the proxy's location). Without it, `X-Forwarded-For`, `x-afs-geo-*` and
  `x-vercel-ip-*` are ignored: the IP is `cf-connecting-ip` and geo is `request.cf`, so nobody can
  spoof another visitor's hash or geo by sending headers. A request under a path prefix without a
  valid key is still stored but counted as a `proxy_key_missing` / `proxy_key_invalid` warning,
  which `GET /sites/:id` (`data.warnings_last_7d`) and verify (`proxy_key` check) report.
- **Hostnames.** Without `allowed_hostnames`, browser events are accepted only from the site's
  domain and its subdomains (plus localhost in `DEV_MODE`), so a public site id can't be used to
  fill a site from anywhere; others are dropped as `hostname_not_allowed`. `allowed_hostnames`
  refuses public-suffix wildcards (`*.com`, `*.co.uk`, `*.vercel.app`: a compact built-in list,
  no dependency), and a stored one never matches. A site's domain can't be a public suffix.

## Tracker (`/s.js`)

```html
<script defer src="https://ANALYTICS_HOST/s.js" data-site="site_xxx"></script>
```

Source: `src/tracker/index.ts` (own tsconfig with the DOM lib), bundled + minified by esbuild
(`scripts/build-tracker.mjs`) into `dist/tracker.txt` and, with the cross-domain linker compiled
in (`__LINKER__`), `dist/tracker-linker.txt` (`/s.js?linker=1`); wrangler imports both as Text
modules (`build.command` + `rules` in `wrangler.jsonc`). Served with a 1 h cache and an ETag each.
Size budget of the default build (tested): 5,265 bytes minified, 2,810 gzip (it is 5,260 / 2,808;
the `?afsa_debug=1` flag took it from 5,096 / 2,745).

- pageviews, including SPA navigations (history.pushState/replaceState/popstate, deduped by
  path+query)
- `afsa('identify', 'user_1', { plan: 'pro' })`: user properties, sent once with the next event.
- `data-require-consent="true"`: nothing is sent or stored until `afsa('consent', true)` (which sends
  the page's pageview once, on the change only); `afsa('consent', false)` stops sending and removes
  the stored id.
- `/s.js?linker=1` + `data-cross-domain="a.com,b.com"`: the build with the cross-domain linker
  (`_afsa=<visitor id>.<minute>.<check>` on links to those hosts, check = FNV-1a of user agent, id and
  minute; adopted only by the same browser within 2 minutes, then removed from the URL with
  `history.replaceState`). Built from the same source with `__LINKER__` (scripts/build-tracker.mjs),
  so the default `/s.js` stays within its size budget.
- `afsa('event', 'add_to_cart', { items: [{ item_id, item_name, item_category, price, quantity }] })`:
  a GA4-style `items` array in the props of an ecommerce event is stored as items (no tracker code).
- `afsa('event', 'signup', { plan: 'pro' })`, `afsa('revenue', 'purchase', 49.00, 'USD', props)`,
  `afsa('identify', 'user_123')`, `afsa('pageview')`; a queue stub so calls before load aren't lost
  (queued `identify` calls are applied before the first pageview). Anyone can send browser events,
  so browser revenue counts only with the site setting `browser_revenue: true` (otherwise the event
  is kept without revenue and counted as the warning `browser_revenue_ignored`), and a browser user
  id links payments only with `trust_browser_user_id: true`
- engagement time (visible time) sent with `sendBeacon` when the page is hidden or left, and
  before each SPA navigation; it feeds `visit_duration`
- outbound link clicks (`outbound_click`) and file downloads (`file_download`), `{url}` prop
  without query string; opt-out via `data-auto="false"`
- max scroll depth per page and, for the page load (not SPA navigations), Core Web Vitals: LCP,
  INP (slowest interaction) and CLS (largest 5 s session window), on the engagement beacon
- opt-in `data-404="true"`: a `404` event (`props.from` = linking page, no query) on pages served
  with HTTP 404 (Navigation Timing) or carrying `<meta name="afsa-404">`; `afsa('404')` for
  client-rendered 404s
- opt-in `data-forms="true"`: `form_start` (first input, once per form per page) and
  `form_submit` with `props.form` = the form's id, name or action path; field values are never read
- click events from attributes (`data-afsa-event`, `data-afsa-prop-*`), `element_view` for
  `[data-afsa-view]` elements (IntersectionObserver, once per pageview, per-element threshold),
  props on every event (`data-props`, `afsa('props')`), a manual pageview with its own URL and
  props (`afsa('pageview', {url, props})`), a `data-before-send` hook that can rewrite or drop
  any payload, `data-downloads` extensions, `data-link-paths` redirect links counted as outbound,
  non-interactive events (`{interactive: false}`: they don't un-bounce), hash routing
  (`data-hash`), page titles (`data-title`, opt-in), the viewport width (stored as a class),
  test traffic (`afsa('debug')`, or `?afsa_debug=1` in the page URL, which covers the page load's
  own pageview; both last for the tab in sessionStorage `afsa_debug` until `?afsa_debug=0` or
  `afsa('debug', false)`)
- read on the server, no tracker bytes: the browser language (Accept-Language), utm_id,
  utm_source_platform, utm_creative_format, utm_marketing_tactic, site search terms
  (`search_params`: a `site_search` event, the rest of the query still dropped) and content
  groups (`content_groups`, path patterns evaluated at query time)
- `afsa.visitorId()` returns the id the server echoed for the last event (so after the first
  pageview response), for a backend to send as `visitor_id`
- sends a GPC / DNT flag; the server drops those events when the site enables `respect_dnt`
  (the `Sec-GPC` / `DNT` headers count too)
- `data-api` overrides the collect URL; `localStorage.afsa_ignore = 1` excludes your own visits
  (no cookies; the only other storage key is `afsa_vid`, in persistent mode)
- session replay with no second snippet: when the site has `replay_site_id` (only the replay app
  sets it, over internal auth, when one of its sites links this one as `analytics_site_id`; API
  keys get `403 replay_link_from_replay`) and the deployment has
  `REPLAY_BASE_URL`, every `/e` answer for the site carries `r` (the replay loader URL, also on
  drops and daily-budget refusals) and the tracker adds `<script async src=r>` once per page load,
  not on SPA navigations. Only `https://` URLs (`http://localhost` and `127.0.0.1` for local dev),
  and not when `window.afsr.sessionId` exists (the replay snippet is on the page). The replay loader
  makes its own sampling, bot, DNT and consent decisions. It is fetched from the replay host
  directly, not through a first-party proxy, so a strict CSP needs `script-src` and `connect-src`
  for that host
- `text/plain` body so there is no CORS preflight; `POST /e` bodies are limited to 16 KB (`413
  payload_too_large`, refused by `content-length` and never read past 16 KB); props keep 30 keys of
  64 characters, values of 500 and 2 KB in all; `429` when rate limited or over a daily budget, `403`
  for a suspended account, `507` when the site's storage budget is used up (see Fair use)

## API (all under `/v1`, `Authorization: Bearer <key>`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (no auth); `/me`, `/keys` from `@afs/shared` |
| POST | `/sites` | `{ domain, name?, timezone?, visitor_id_mode?, retention_days?, allowed_hostnames?, respect_dnt?, browser_revenue?, trust_browser_user_id?, exclusions?, ignored_referrers?, path_rules?, redact_pii?, search_params?, content_groups?, currency? }` -> site + install snippets + next_steps. Same domain again returns the existing site (`200`, `existing: true`) |
| GET | `/sites`, `/sites/:id` | `/sites/:id` adds a data summary (event counts, drops by reason, `warnings_last_7d`, `usage_today`, `database_bytes`; visitor-sent strings such as bot user agents, dropped hostnames and the last event only under `untrusted`), `limits` and `status` |
| PATCH | `/sites/:id` | settings (any subset, including domain; a new domain clears its verification). `replay_site_id` (`rsite_` + 16 characters, or `null`) is accepted only from the replay service (internal auth): with an API key, REST or MCP, changing it is `403 replay_link_from_replay` (link from the replay site's `analytics_site_id`). Every site response returns `replay_site_id` (null when unset) and `verification` |
| DELETE | `/sites/:id` | deletes site, goals, share links and the DO's data |
| GET | `/sites/:id/install?framework=html\|nextjs\|astro\|react\|wordpress\|gtm\|tags` | file + code, tracker API, proxy snippets, server-side curl |
| POST | `/sites/:id/verify` | `{url?}`: fetches the page, checks the snippet + site id, that the script URL serves the tracker (catches broken proxies; a src on this service's own host is checked in-process, since a Worker fetching its own host or zone gets 522), CSP, that events arrived, hostname rejections, proxied events without the proxy key, ignored browser revenue, storage and daily limits, and verifies the domain (the tracker in a parsed `<script src>` tag on exactly `https://<domain>/`, or DNS TXT `_afs-verify.<domain>` = `afs-analytics-site=<id>`; share links need it); returns `checks`, `fixes`, `domain_verified`, `verification`, `limits`, `status`, `untrusted` (page-copied and visitor-sent strings), `next_steps`. Full key only, rate limited per account and per domain. Fetches only https on port 443 on the domain or a subdomain (never `allowed_hostnames`, IP literals or single-label hosts); redirects: at most 3, each hop under the same rule; reads at most 1 MB of the page; fetches the script (at most 256 KB) only from this deployment's host or the site's own hosts |
| POST | `/sites/:id/events` | server-side ingestion, batch up to 100 (see below); `?validate_only=true` runs every check and returns the exact row each event would store, storing and counting nothing |
| GET | `/sites/:id/stats` | aggregate metrics (`metrics`), optional `breakdown` (its rows in `breakdown.results`; shapes in llms.txt "Response shapes"), `compare=previous\|year\|custom` |
| GET | `/sites/:id/breakdown?breakdown=` | top values of one property; `sort`, comparison per row |
| GET | `/sites/:id/timeseries` | metrics by `interval=hour\|day\|week\|month`; every bucket up to now; comparison per bucket; annotations |
| GET | `/sites/:id/movers?breakdown=` | gainers and losers of a metric vs the comparison period |
| GET | `/sites/:id/insights` | revenue share, top sources/countries, time-to-convert histograms, top converting events, heatmap |
| GET | `/sites/:id/schema` | metric and breakdown definitions, filter grammar, goals, funnels, and the site's event names and prop keys with counts and sample values (under `untrusted`) |
| GET | `/sites/:id/props?event_name=` | custom prop keys with counts, event names and common values (`untrusted`) |
| GET | `/sites/:id/sessions` | session list: period, filters (incl. `did==event` / `did!=event`), segment, sort, paging; `replay` link when the session's events carry `replay_session_id` |
| GET | `/sites/:id/realtime/map` | visitors of the last 1-60 minutes by city with latitude / longitude |
| GET | `/sites/:id/export` | raw events of a range as NDJSON (default), CSV or JSON, cursor-paged (`x-afs-next-cursor`, up to 10,000 rows a page), within a daily export budget |
| POST/GET/DELETE | `/sites/:id/imports[/:import_id]` | history from GA4 (report CSV or Data API runReport JSON), Plausible (export CSV or Stats API v2 JSON) or any other tool (`source: other` + `tool`, generic CSV or JSON rows) as daily aggregates (pages, sources, countries, devices, totals), idempotent per (source, tool, kind, date range); `imported=true` adds them to stats, breakdowns and timeseries |
| GET | `/sites/:id/imports/compare?source=&tool=` | live daily visitors vs the old tool's imported ones on the complete days both cover: `days`, `ratio`, `verdict` (close / lower / higher / not_enough_overlap), `note`, `next_steps` |
| POST | `/sites/:id/crawls` | bot requests the site's server saw `{hits: [{user_agent, path, status?, timestamp?}]}`: classified by user agent, counted per bot / page / day, never as visitors or events |
| GET | `/sites/:id/crawlers` | crawler hits by bot, operator, category, page or status; daily series per category |
| GET | `/crawlers` | the maintained crawler list and a prefilter regex (no key) |
| GET | `/rollup` | every site of the account: per-site totals for a period (optional compare) and sums |
| GET | `/sites/:id/realtime` | visitors in last 5 / 30 min, top pages/countries/sources (30 min), a 1-60 minute `window` (`minutes`, `breakdown`), recent events (`since`, `limit`); `filters` and `debug=only` (the debug view) apply to all of it |
| GET | `/sites/:id/funnel?steps=...` | funnel (or `funnel_id=`): `mode=ordered\|any`, `window=session\|1h\|1d\|7d\|30d` (by person across sessions), revenue per step, `compare`, `compare_segments` |
| GET | `/sites/:id/attribution` | conversions and revenue credited by `model` (`last_non_direct`, `last_touch`, `first_touch`, `linear`, `position_based`, `time_decay`) over the person's sessions in `lookback_days`, by `breakdown`; `paths=true` for conversion paths |
| GET | `/sites/:id/paths?start=\|end=` | path exploration within sessions: next (or previous) pages / events per step with shares and exits, top full paths |
| GET | `/sites/:id/sql?q=SELECT...` | read-only SQL over the site's own SQLite (SELECT/WITH only; limits below) |
| POST/GET/PATCH/DELETE | `/sites/:id/goals[/:goal_id]` | `{ name, type: event\|pageview\|scroll, match, value?, threshold?, props?, counting? }`, idempotent by name; `props` = conditions on the event's props (all must match), `counting` = `every` \| `once_per_visit`; PATCH changes any field, retroactively |
| POST/GET/PATCH/DELETE | `/sites/:id/segments[/:segment_id]` | saved segments `{ name, filters?, filters_json? }`, used as `segment=<id or name>` wherever filters go |
| GET | `/sites/:id/visitors`, `/sites/:id/visitors/:visitor` | visitor list (generated names, user_id, location, device, source, spent, last seen) and one visitor's timeline |
| DELETE | `/sites/:id/visitors/:visitor` | erase one person: visitor id, `user:<id>` (with pre-identify sessions) or `customer:<provider>:<id>`; payments kept unlinked or `?payments=delete` |
| POST | `/sites/:id/purge` | delete events matching filters in a period; `dry_run` (default true) counts first; 50,000 events per call |
| GET | `/sites/:id/sessions/:session_id` | one session and its events |
| GET | `/sites/:id/journeys` | visitors who completed a goal (or a first purchase): source, time, visits, touchpoints |
| GET | `/sites/:id/retention` | cohorts by first-seen day / week / month with returns per later period, optionally split or filtered by first touch; identified users only in cookieless mode |
| GET/POST/DELETE | `/sites/:id/integrations/stripe` | webhook URL + status / connect `{webhook_secret}` (the project's own key: an OAuth access token gets `403 temporary_credential`) / disconnect (deletes the endpoint we created) |
| POST | `/sites/:id/integrations/stripe/connect`, `.../backfill` | one call with a restricted key (Webhook Endpoints Write, Checkout Sessions / Invoices / Charges / Subscriptions Read): we create the endpoint (API version pinned), seal key and signing secret, and import 90 days of history; resumable, budgeted, idempotent |
| POST | `/webhooks/stripe/:site_id` | Stripe webhook (public; `Stripe-Signature` verified) |
| GET/POST/DELETE | `/sites/:id/integrations/polar\|paddle\|lemonsqueezy` | webhook URL, events and status / connect `{webhook_secret, sandbox?, record_test_events?}` (project key only) / disconnect |
| POST | `/webhooks/polar\|paddle\|lemonsqueezy/:site_id` | provider webhooks (public; Standard Webhooks / `Paddle-Signature` / `X-Signature` verified) |
| POST/GET/DELETE | `/sites/:id/payments[/:payment_id]` | payments from any provider, idempotent by (provider, id) |
| POST/GET | `/sites/:id/subscriptions` | subscription states from any provider (natural key provider + id; older states ignored) / list with status, plan, MRR, attribution |
| GET | `/fx/rates?date=&base=` | the ECB reference rates conversion to a site currency uses for a day |
| POST/GET/DELETE | `/sites/:id/costs` | daily ad spend `{costs: [{date, source, campaign?, cost, currency?, medium?, clicks?, impressions?}]}` or CSV (text/csv or `{csv}`), idempotent by (date, source, campaign), converted to the site currency; list; delete a date range |
| GET | `/sites/:id/user-props` | user property keys (last value per user, from server `user_props` or identify traits) with user counts and top values |
| GET | `/sites/:id/items` | ecommerce items (GA4-style `items` on view_item_list ... refund events): listed, viewed, added, removed, checked out, purchased, item revenue, cart-to-purchase rate by item id / name / category / brand / variant / list |
| GET | `/sites/:id/mrr` | MRR, ARR, ARPU; new / expansion / contraction / churned / reactivation MRR, customer and revenue churn, trial conversion; series per day / week / month; `breakdown` by channel, source, utm_*, referrer, country or plan |
| GET | `/sites/:id/exclusions` | rules, drops, `your_ip`, dry run of every ingest rule `?ip=&url=&country=&referrer=` (stored path after redaction and path rules, referrer ignored or spam) |
| POST/GET/PATCH/DELETE | `/sites/:id/annotations[/:annotation_id]` | dated notes; automatic traffic spikes |
| POST/GET/PATCH/DELETE | `/sites/:id/funnels[/:funnel_id]` | saved funnels; GET one = drop-off per step |
| POST | `/sites/:id/share` | public read-only dashboard URL, options `{password?, expires_in_days?, segment?, label?}` (password: PBKDF2 hash, a form and a 12-hour HttpOnly cookie; segment: only its traffic; label: the natural key of a link with options; the page adds goals) (without options returns the existing link unless `{"new": true}`; at most `MAX_SHARE_LINKS_PER_SITE` active). Needs a verified domain (`403 domain_not_verified`) and the project's own key (`403 temporary_credential` for an OAuth access token: the URL never expires). The page names the verified domain, never the site's name, says the numbers come from the site's own tracker, and is `noindex`; a site no longer verified shows "Unverified site" |
| DELETE | `/sites/:id/share?token=` | revoke (and delete) one share link, or all |
| GET | `/sites/:id/share` | share links with their options (password configured, expires_at, segment_id, label) |
| POST/GET/DELETE | `/sites/:id/destinations[/:destination_id]`, `POST .../:destination_id/test` | alert and report destinations: signed webhook (secret shown once), Slack incoming webhook, or email to the project's members (with the optional `EMAIL` binding + `ALERT_EMAIL_FROM`). URLs sealed with `ENCRYPTION_KEY`, never returned; https on 443, public hostnames only, never the platform's own domain (checked at create and before every delivery), no redirects. Project key only (`403 temporary_credential` for an OAuth token) |
| POST/GET/PATCH/DELETE | `/sites/:id/alerts[/:alert_id]`, `POST .../test`, `GET .../history`, `GET /sites/:id/alerts/:alert_id?evaluate=true` | `traffic_spike`, `traffic_drop`, `no_data`, `goal`, `payment` rules checked by the cron; evaluate computes one now without sending; test sends a sample |
| GET | `/sites/:id/deliveries` | every firing, report and test with per-destination results (90 days) |
| GET | `/sites/:id/digest` | period summary: kpis and revenue with change, goals, channels, alerts fired; top sources / pages / countries, movers and annotations under `untrusted` |
| POST/GET/PATCH/DELETE | `/sites/:id/reports[/:report_id]`, `POST .../send` | the digest weekly or monthly at an hour of the site timezone, through the destinations |

Public: `GET /s.js`, `POST /e` (both under any prefix), `GET /share/:token`,
`GET /share/:token/data`, `GET /llms.txt`, `POST /mcp`, `POST /webhooks/stripe/:site_id` (signed).

Query params for stats/timeseries/breakdowns/funnel:
- `period`: `today`, `yesterday`, `24h`, `7d`, `30d` (default), `90d`, `12mo`, `mtd`, `ytd`, `all`, or `from`/`to` (YYYY-MM-DD inclusive, site timezone, or ISO timestamps for an exact `[from, to)` range). `7d`/`30d`/`90d` include today. `timezone=` (IANA) overrides the site's for one query.
- `metrics`: `visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration, events, conversions, conversion_rate, revenue`
  (the default set, plus `revenue_per_visitor`), and opt-in `new_revenue, renewal_revenue, refunds,
  purchases, customers, purchase_rate, new_visitors, returning_visitors, scroll_depth, time_on_page,
  lcp_p75, inp_p75, cls_p75`, and GA4's vocabulary: `engaged_visits` (>= 10 s visible, 2+
  pageviews or a conversion), `engagement_rate`, `engagement_time` (total visible seconds),
  `visits_per_visitor`, `events_per_visit`, `visit_conversion_rate`, `average_order_value`
  (new-purchase revenue / purchases), `revenue_per_customer`, `percentage` (a row's share of the
  period's visitors), and ad spend from `POST /sites/:id/costs`: `cost`, `roas` (revenue / cost),
  `cpa` (cost / conversions), `cac` (cost / customers), `cost_per_visit` (by utm_source,
  utm_campaign and source only; null elsewhere)
  (`events` includes pageviews; `bounce_rate` = % of sessions with <= 1 pageview and no custom
  event; `visit_duration` = mean seconds, the larger of first-to-last activity and visible time;
  `conversions` = goal-matching events; `conversion_rate` = % of visitors who converted;
  `revenue` = event revenue plus payments, refunds subtracted, or the goal's `value` for a matching
  event without revenue; currencies are summed as sent, no FX; `purchase_rate` = visitors with a
  new purchase / visitors; returning = an earlier session of the visitor or its user_id, so
  same-day only for anonymous cookieless visitors; vitals are p75 by nearest rank over pageviews.
  Payments never count as visitors, visits or events)
- `breakdown`: `page, entry_page, exit_page, hostname, source, referrer, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id, utm_source_platform, utm_creative_format, utm_marketing_tactic, click_id_type, country, region, city, continent, browser, browser_version, os, os_version, device, language, screen, page_title, content_group, event_name, goal, prop:<key>`
  (missing values show as `(none)`; region/city rows include `country`; `goal` lists every goal);
  up to 3 at once (`country,device`: each row carries every dimension by name; the first is the
  group key, the others extra GROUP BY columns with fixed SQL aliases; a page dimension goes first
  so it stays session-scoped). `offset` pages through rows (`total_rows`, `next_offset`, from
  `COUNT(*) OVER ()` on the grouped rows).
- `filters`: `country==US;page~/blog;channel!=Direct` (`==`, `!=`, `~` contains case-insensitive,
  `!~`; `|` for OR; `(none)` for missing; `\;` escapes; `*` in an `==` / `!=` value is a wildcard,
  compiled to a bound SQLite `GLOB` pattern with `[` and `?` escaped, `\*` literal: the DO's SQLite
  has no REGEXP). `goal==X` keeps sessions that converted on X and counts only X as conversions;
  `entry_page`/`exit_page` filter sessions; the rest filter events. `filters_json` takes nested
  `and` / `or` / `not` groups of the same leaves (4 levels, 20 leaves); `segment=` a saved one.
- `format=csv` (or `Accept: text/csv`) on stats, breakdown and timeseries (REST): RFC 4180, with
  comparisons flattened and formula-looking text cells prefixed with `'`.
- `compare=previous|year|custom` (+ `compare_from`, `compare_to`, `match_weekday=true`) on stats,
  breakdown and timeseries: same-length previous range, the same dates a year earlier, or a custom
  range; for an in-progress period only the elapsed part (today so far vs yesterday up to the same
  time). Totals, every breakdown row and every timeseries bucket get
  `comparison: {metrics, change_percent}`.
- `sort` (breakdowns): a countable metric (`revenue`, `purchase_rate`, `revenue_per_visitor`, ...)
  with `:desc` (default) or `:asc`, applied before `limit`; `value` / `value:desc`; or `change` /
  `change:<metric>` for the biggest absolute movers.
- `page` rows count revenue and conversions of the sessions that viewed the page.
- `limit` (default 20, max 1000)
- `debug`: events marked as test traffic (`afsa('debug')` / `data-debug="true"` / `?afsa_debug=1`,
  `debug: true` on server events, replay's signals from forced `?afsr=1` sessions and debug pages,
  DO column `events.debug`, schema version 4) are left out of every read unless
  `debug=include|only`; they still count against budgets and are purged after 7 days

All user values are bound SQL parameters; the only text spliced into SQL comes from fixed tables
or integers the code computed (timezone offsets for bucketing).

SQL endpoint limits (it runs synchronously inside the site's Durable Object, next to ingest, and the
DO SQL API has no timeout or interrupt, so the work has to be bounded before and while it runs):
- refused up front (`sql_rejected`, `src/lib/sqlguard.ts`): recursive CTEs (`RECURSIVE`, or a CTE
  that selects from itself, which SQLite runs as recursive without the keyword), comma joins
  (`FROM a, b`), more than 2 JOINs, JOINs without ON / USING (NATURAL joins and one table-valued
  function are fine) and JOINs ON a constant (`ON 1`, `ON true`); more than one table-valued
  function, or one over anything but a column (`json_each(e.props)`) or a literal; any function
  outside an allowlist (aggregates, window, string, date, math and JSON functions), so no
  generators or amplifiers (`zeroblob`, `randomblob`, `replace`, `json_pretty`,
  `generate_series`, `pragma_*`); `printf` / `format` without a literal format, with a `*` width or
  precision or one over 100; string aggregates as window functions; `hex` / `quote` nested more
  than 2 deep; more than 32 concatenations;
- refused before running (`sql_too_expensive`, `src/lib/sqlplan.ts`): the plan from `EXPLAIN QUERY
  PLAN` is estimated loop by loop (a full scan or a non-selective search reads the whole table, a
  primary-key lookup 1, a session / visitor / user / customer index lookup a few; table sizes are
  rowid bounds, O(log n)); nested loops multiply, correlated subqueries multiply by the loops
  around them. More than max(1,000,000, 100 x the biggest table) is refused: that is a big table
  scanned once per row of another, i.e. what would otherwise run for minutes before its first row;
- at most 1000 rows and about 1 MB come back, whatever the query's own LIMIT: the cursor is never
  stepped further (`truncated`, `truncated_by: "bytes"`);
- a query that keeps reading while it returns rows (a subquery scanning events per row) is stopped
  (`sql_too_expensive`) once it has read `SQL_MAX_ROWS_READ` rows after its first row;
- `SQL_LIMITER` (30 a minute per account) and a per-site time budget: the Worker measures each
  query's wall time around the DO call and charges it to the site (`meta.sql_time`, refilling
  continuously); past `SQL_TIME_BUDGET_MS` per 10 minutes (default 60 s) SQL answers `429
  sql_budget_exhausted`. What is left (per-row expression cost over a very large table) is bounded
  by that budget and the Durable Object's CPU limit.

Server-side event body (`POST /v1/sites/:id/events`, also the MCP `track_events` tool):

```json
{ "events": [{
  "name": "purchase", "timestamp": 1793686207976, "url": "https://example.com/checkout",
  "visitor_id": "optional, from afsa.visitorId()", "user_id": "optional",
  "ip": "203.0.113.7", "user_agent": "Mozilla/5.0 ...",
  "country": "optional ISO override", "region": "...", "region_code": "...", "city": "...", "continent": "EU",
  "referrer": "...", "utm_source": "...", "utm_medium": "...", "utm_campaign": "...", "utm_term": "...", "utm_content": "...",
  "click_id_type": "gclid", "click_id": "...",
  "props": { "plan": "pro" },
  "revenue": { "amount": 49.0, "currency": "USD" },
  "debug": false, "visit": true
}] }
```

- Only `name` is required. A single event object without the `events` wrapper is accepted too.
  Bodies are capped at 1 MB (every `/v1` JSON body is); props keep 30 keys / 500-character values /
  2 KB in all; a stored event over 8 KB is refused (`event_too_large`).
- `timestamp`: unix ms or ISO 8601, default now, at most 31 days old and 5 minutes ahead (else that
  event is rejected; the rest of the batch still lands).
- Visitor: `visitor_id` if given; else `ip` + `user_agent` hashed exactly like the browser, so the
  event lands on the same visitor and (within 30 min) the same session; else derived from
  `user_id`; else a new random visitor.
- Geo: explicit fields always win; else inherited from the visitor's session; else unknown. No
  IP->geo lookup (Workers have none for arbitrary IPs), and the request's own `request.cf` is never
  used for server events (it would be the backend's location).
- Response `202`: `{ accepted, rejected, results: [{ index, ok, visitor_id, session_id } | { index, ok, visitor_id: null, session_id: null, visit: false } | { index, ok: false, reason }] }`.
- `debug: true` (or a `url` carrying `afsa_debug=1`) marks the event as test traffic.
- `visit: false`: a backend event that is not a visit (an agent signing up with curl, a webhook).
  It joins the visitor's live session if it names one; otherwise it creates no visitor and no
  session: it is stored with `events.no_visit = 1` and a session id of its own (no sessions row),
  and counts as an event, a conversion and revenue, never as a visitor or a visit (so never in
  conversion_rate, bounce_rate, visit_duration, entry/exit pages, paths, session funnels or
  realtime/insights visitors). Person funnels (a 1h-30d window) and attribution follow its
  `user_id`; erasure deletes it by user id or visitor id.
- Events with a bot `user_agent` are rejected per event; so are events past a daily cap (`reason:
  daily_limit`). A batch refused as a whole is `429 daily_limit` / `over_capacity`, `403
  account_suspended` or `507 storage_full`. Requests are rate limited per account.
- A `user_id` here is trusted for payment linking and replaces a browser-sent one on the session.

## Revenue attribution

Payments are stored in the site's DO twice: as events (origin `payment`, names `payment`,
`renewal`, `refund` with negative revenue) carrying the linked session's attribution, geo and
device, so revenue works in every breakdown, filter, timeseries and funnel; and in a `payments`
ledger keyed by `provider:external_id` for idempotency, refunds, renewals and deletes.

- **Linking:** `afsa.visitorId()` goes into the Stripe Checkout Session's `metadata.afs_visitor_id`
  (subscriptions: also `subscription_data.metadata`) or `client_reference_id` (Payment Links:
  `?client_reference_id=`). Order: session id, the visitor's latest session at or before the
  payment, the user id's latest session (one a server event identified, unless the site sets
  `trust_browser_user_id`: anyone can call `afsa('identify', ...)` with someone else's user id from
  their own campaign), the customer's earlier payment (renewals keep the original source), the
  refunded payment. Unlinked payments show as channel `Unattributed` and are
  re-attributed when the customer's checkout arrives. Metadata is untrusted: only those keys are
  read and validated, nothing else is stored, and customer ids are kept as a per-site salted hash.
- **Stripe:** `GET /sites/:id/integrations/stripe` gives the webhook URL and events
  (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`,
  `charge.refunded`; optional `payment_intent.succeeded`). `POST` stores the signing secret sealed
  with `ENCRYPTION_KEY` (never returned). Each delivery: `Stripe-Signature` verified (any v1, 5 min
  tolerance), event id deduped for 30 days, body capped at 1 MB, test-mode events acknowledged but
  counted only with `record_test_events`. Every unauthenticated failure (unknown site, no Stripe
  connected, missing or wrong signature, stale timestamp) gets one identical `400 webhook_rejected`
  and writes nothing, so nobody can tell which sites use Stripe or plant a misleading `last_error`;
  deliveries are rate limited per site and, like every payment, count against the daily event
  budgets (the account picks its own signing secret): past them `429` and Stripe retries later.
  The delivery status row is written at most every 5 s per site (and isolate); deliveries in
  between are added by the next write. invoice `subscription_create` = new, `subscription_cycle`
  / `subscription_update` / `subscription_threshold` = renewal; `charge.refunded` sets the
  cumulative refunded amount. Status: `events_received`, `last_result`, `last_error`, unlinked
  payments; verify reports `stripe_webhook` and `payment_linking`.
- **Stripe in one call** (`src/service/stripe-connect.ts`, `src/lib/stripe-api.ts`): the
  restricted key is sealed and used only to create the endpoint (`api_version` 2024-06-20, so the
  event shapes we read stay fixed) and to backfill: checkout sessions, paid invoices, charges with
  refunds and subscriptions, newest first, `starting_after` paging, progress in
  `integrations.backfill`, two pages in the call and five per cron run (ten sites per run). Listed
  objects go through the same normaliser as webhook events; payments are idempotent by
  (provider, id), so re-runs only fill gaps. A refused page (daily budget) pauses until 00:00 UTC
  and resumes at the first refused object.
- **Any provider:** `POST /sites/:id/payments` `{payments: [{id, provider?, amount, currency, type?,
  timestamp?, visitor_id?, session_id?, user_id?, customer_id?, refunded_payment_id?, livemode?}]}`.

- **Polar, Paddle, LemonSqueezy** (`src/lib/billing.ts`, `src/service/billing-webhooks.ts`): one
  signed webhook per site and provider into the same payments and subscriptions. Signatures as
  each documents them: Polar is Standard Webhooks (`webhook-id.webhook-timestamp.body`, base64
  HMAC; the key is the base64 after `whsec_`, or the UTF-8 bytes of the whole secret for secrets
  issued before 2026-09-08, both tried); Paddle `ts=..;h1=..` (hex HMAC of `ts:body`, any `h1`);
  LemonSqueezy `X-Signature` (hex HMAC of the body). 5 minute tolerance and event-id dedup for
  Polar and Paddle; LemonSqueezy has neither, so its records rely on natural keys. Merchant of
  record amounts are after discounts and before tax. Paddle MRR is before discounts (its
  subscription has no discount amount); LemonSqueezy subscriptions carry no price, so MRR comes
  from paid invoices (amount per period, period from the gap between invoices or to `renews_at`,
  snapped to day / week / 1-11 months / year).

- **Currency conversion** (`src/lib/fx.ts`, `src/service/fx.ts`, D1 `fx_rates`, `fx_meta`,
  migration 0016): a site's `currency` makes the Worker convert every payment at ingest with the
  ECB euro reference rates of the payment's UTC day (the latest earlier publication on weekends
  and holidays; `fx_fallback` when the nearest rate is more than 5 days off or later). The DO keeps
  `original_amount`, `original_currency`, `fx_rate`, `fx_day`, `fx_fallback` on each payment.
  Subscriptions get the day's rate attached and the DO converts them, keeping each on the rate it
  was first converted at. The cron fetches rates (90-day file when empty or behind, else the
  daily file) once a new publication is due, at most every 2 hours, and only while some site has a
  currency. `GET /v1/fx/rates?date=&base=` shows what a day converts with.

- **Raw export** (`src/do/export.ts`, `src/service/export.ts`, DO table `export_usage`): `id >
  cursor AND ts in range ORDER BY id LIMIT n` (the rowid order, so pages never skip or repeat),
  columns read from the table's DDL, rows held to `MAX_EXPORT_ROWS_PER_SITE_PER_DAY` (default
  1,000,000, UNCLAIMED_ variant).
- **Imports** (`src/lib/imports.ts` parses, `src/do/imports.ts` stores and merges; DO tables
  `imports`, `imported_rows`): rows (day, value, visitors, visits, pageviews, bounces,
  visit_duration) keyed by file; the same (source, tool, kind, from, to) replaces its rows. CSV,
  generic JSON rows and API reports go through one row mapper per format (a GA4 runReport is mapped
  onto the GA4 CSV's columns, a Plausible v2 response onto the generic ones), so the same data gives
  the same rows. With `imported=true` and no filters, reports add imported numbers for days before
  the first live event (totals, page / source / country / device breakdowns, day / week / month
  buckets). Caps: `MAX_IMPORTED_ROWS_PER_SITE` (500,000) and `MAX_IMPORTS_PER_SITE` (100),
  UNCLAIMED_ variants. Compare (`src/do/import-compare.ts`): imported daily visitors against the
  live daily visitors of `timeseries` (debug traffic left out) on complete days after the first day
  of live visitors and before today; ratio live / imported, close within 0.75 to 1.25, at least 3 days.
- **AI crawlers** (`src/lib/crawlers.ts` is the maintained list; `src/do/crawlers.ts`, DO tables
  `crawler_hits`, `crawl_usage`): hits classified by user agent (first match wins; generic bot
  words make "Other bot"; unknown user agents are ignored), counted per (day, bot, path, status
  class) with at most 2000 paths per bot and day (the rest under "(other)"), purged with retention,
  and held to `MAX_CRAWL_HITS_PER_SITE_PER_DAY` (default 100,000, UNCLAIMED_ variant) in a
  counter of their own, plus account-wide and deployment-wide budgets (`MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY`,
  `MAX_CRAWL_HITS_PER_DAY`) from a D1 aggregate. Imports, cost rows and crawler hits are refused on a
  full site (507 `storage_full`) like events. Middleware snippets for Workers, Next.js and Express are in llms.txt.
- **Reads** (`src/do/sessions-list.ts`, `src/service/reads.ts`): the session list joins sessions to
  the events that match the filters and links replay through `props.replay_session_id`; the
  realtime map groups the window's located events by city; `/v1/rollup` calls each of the
  account's sites (up to 100, ten at a time) for its totals. `visitor_type` (new | returning per
  session) is a dimension (`DIMENSION_SQL`); `did==<event>` / `did!=<event>` is a filter-only key:
  visitors (or identified users) with / without that event in the range.
- **User properties** (`src/do/user-props.ts`, DO table `user_props`): last value per (user, key),
  older timestamps ignored, a browser value never replaces a server one, null unsets; 30 keys per
  user, `MAX_USER_PROP_KEYS_PER_SITE` server keys (default 50) and `MAX_BROWSER_USER_PROP_KEYS_PER_SITE`
  keys only browsers created (default 20), both with UNCLAIMED_ variants. Browser-sent properties
  are kept only with the site setting `browser_user_props`; purged after `retention_days`. `user:<key>`
  is a dimension everywhere: a correlated lookup on the event's user id (`columnFor` in
  `lib/query.ts`). **Custom metrics** `sum|avg|min|max:prop:<key>` (up to 5) are extra aggregate
  columns over the numeric text of a prop (non-numbers skipped), aliased by `customAlias`.
- **Ecommerce items** (`src/lib/items.ts`, `src/do/items.ts`, DO table `event_items`): the Worker
  reads up to 200 items off an ecommerce event (browser `props.items`, server `items`); the DO keeps
  `MAX_ITEMS_PER_EVENT` (default 25, UNCLAIMED_ variant; warning `items_truncated`) and nulls
  browser purchase / refund prices unless `browser_revenue`. An `AFTER DELETE` trigger on events
  removes their items, so retention, erasure and purges need no extra code.
- **Session timeout and channel groups**: `session_timeout_minutes` (5-240, default 30) is the
  session gap in `findSession`; `channel_groups` (D1 column, migration 0018) compile to a CASE over
  source / utm_medium / utm_campaign / channel with lower-case GLOBs at query time
  (`channelGroupFrag` in `lib/query.ts`), so `channel_group` is a dimension and filter over stored
  data. Alert firings write an `alert` annotation (once per alert and minute).
- **Ad spend** (`src/do/costs.ts`, `src/service/costs.ts`, DO table `costs`): rows keyed by
  (day, source, campaign), lowercased, in the site timezone; capped by `MAX_COST_ROWS_PER_SITE`
  (default 50,000, UNCLAIMED_ variant). Reports ask for the base metrics too (revenue,
  conversions, customers, visits), then fill cost metrics from the cost rows of the same days: the
  total (filtered by utm_source / utm_campaign == / != only), per breakdown value for utm_source,
  utm_campaign and source, per day / week / month bucket (by each day's local noon). Anything else
  is null with a note.

### Subscriptions and MRR

`src/lib/subscriptions.ts` (pure: provider objects to states, MRR, movements),
`src/do/subscriptions.ts` (storage and reports), `src/service/subscriptions.ts` (API, Stripe).

- **Sources:** Stripe `customer.subscription.*` events (the one-call endpoint subscribes to them;
  by hand, add them) and the backfill's subscriptions stage (every subscription not ended before
  the window, however old: an active one from years ago is MRR today); the Polar, Paddle and
  LemonSqueezy webhooks; `POST /sites/:id/subscriptions` for anything else.
- **State, not events:** the DO keeps each subscription's latest state (`subscriptions`) and every
  movement (`subscription_changes`: new, expansion, contraction, churn, reactivation,
  trial_start, trial_converted, trial_canceled with MRR before and after). A state older than
  the stored one is ignored (`state_ts`; Stripe's `event.created`), an identical one changes
  nothing, so retries and out-of-order deliveries are safe. A subscription seen for the first
  time gets its history from its own dates at today's price. Only changing states count against
  the daily event budgets.
- **MRR:** only `active` and `past_due` count (not trialing, incomplete, unpaid, paused, canceled,
  or collection paused). Items: unit amount x quantity per month (year / 12, week x 52 / 12, day x
  365 / 12, divided by interval_count); the discount in effect (percent_off, or amount_off spread
  over the interval; not `once`, not ended); no tax; metered / tiered prices count 0. ARR = MRR x
  12. MRR at time t = the sum of each subscription's last movement before t, so the series and
  `mrr_at_start` come from the movement log. Rates: customer churn = churned / paying at start,
  revenue churn = churned MRR / MRR at start, net revenue churn adds contraction and subtracts
  expansion, trial conversion = converted / trials ended in the period.
- **Attribution:** each subscription is linked once like a payment (metadata `afs_visitor_id` /
  `afs_user_id`, session, visitor, user, or the customer's earlier checkout), and carries that
  session's channel, source, UTM tags, referrer and country for breakdowns.
- **Privacy:** erasing a person unlinks their subscriptions (MRR stays true) or deletes them with
  their movements (`payments=delete`).

## Visitors, journeys, insights, annotations, exclusions, funnels

- **Visitors** are identities: `user:<user_id>` when identified (earlier anonymous sessions of the
  same visitor id join it), else the visitor id; names are generated from the id (FNV-1a over 64
  adjectives x 64 animals). Cookieless ids rotate daily, so anonymous history is same-day; every
  response says so in `identity.note`.
- **First touch** (`src/do/identities.ts`, DO table `identities`, schema version 7, backfilled
  from stored sessions): one row per visitor id and per `user:<id>` with its first session's
  channel, source, referrer, UTM source / medium / campaign and landing page, written when a
  session starts (a backdated server event replaces it, a Direct session that adopts a source
  updates it). When a visitor id is identified, the user row keeps the earlier first touch and the
  visitor row points at it (`canonical`). `first_*` dimensions are a primary-key lookup per event.
  Cookieless anonymous ids rotate daily, so their first touch is that day's; responses say so.
  Rows of identities not seen within retention are purged; erasure deletes them.
- **Retention** (`src/do/retention.ts`): cohorts from `identities.first_seen`, activity from
  sessions mapped to the canonical identity; persistent mode counts every visitor, cookieless
  identified users only.
- **Journeys** to a goal or a first purchase: first touch, last touch, time to complete, visits,
  touchpoints (up to 20 sessions), revenue; summary medians and first-visit rate.
- **Insights:** one call with the DataFast bento set (see llms.txt).
- **Annotations** live in the DO (`annotations` table), are returned with every timeseries, and
  are idempotent by time + title. The daily alarm adds `traffic_spike` notes: a complete day with
  >= 20 visitors and >= 2.5x the median of the previous 14 days (>= 7 days of history), naming the
  source with the largest gain when it explains at least a third of the jump. Each day is checked
  once (`meta.spikes_through`, up to 7 days of catch-up) under the key `spike:<day>`.
- **Exclusions** (`sites.exclusions` in D1, copied to the DO): IPs and CIDR ranges (v4 and v6),
  path globs, hostnames, countries, applied to browser and server events at ingest. The IP is passed
  to the DO only to compare in memory; it is never stored or logged, and a drop's sample is the
  rule that matched. Reasons: `excluded_ip`, `excluded_path`, `excluded_hostname`,
  `excluded_country`.
- **Saved funnels** live in D1 (`funnels`, with `mode` and `window`); reading one runs the same query as `funnel?steps=`.
  Funnels are evaluated per actor: a session, or (window 1h-30d) a person = user id, an
  identified visitor's user, or the visitor id, with each step after the previous one and
  within the window of step 1; any-order mode intersects the actors of each step.
- **Attribution** (`src/do/attribution.ts`): the latest 5,000 conversions in the period, each
  joined to the same person's sessions (user id, an identified visitor's user, or the visitor id)
  started in the lookback window (at most 20 per conversion), credited in code by the model.
  Cookieless anonymous ids rotate daily, so their touchpoints are same-day only; identified users
  and persistent mode see the whole window. Responses say so in `identity.note`.
- **Paths** (`src/do/paths.ts`): window functions over the period's pageviews (and custom events
  with `node=any`) per session, consecutive repeats collapsed, anchored at the first match of
  `start` (forward) or `end` (backward); per-step counts, exits and the top 10 full paths.
- **Alerts and reports** (`src/lib/alerts.ts`, `src/do/alerts.ts`, `src/service/{alerts,notify,
  destinations,reports,cron}.ts`): rules live in D1; the cron (every 5 minutes) picks due ones
  (at most 100 alerts, 50 reports and 50 retries per run, and no new work after 40 s), asks the
  site's DO for a few read-only aggregates (the window now and the same window on each of the 7
  days before; conversions; payments after a cursor), decides in pure code, and delivers to each
  destination in parallel with a 10 s timeout and no redirects. Each message is one
  `alert_events` row with per-destination results; failures are retried twice (5 and 30 min).
  Slack text escapes `<`, `>` and `&` so a visitor-sent referrer can't become a mention or link;
  visitor-sent context is labelled in every channel and kept under `untrusted` in webhooks.
- **Privacy** (`src/lib/pii.ts`, `src/lib/pathrules.ts`, `src/lib/ingest-rules.ts`, `src/do/privacy.ts`):
  at ingest, in the DO, every event (engagement beacons too, so they still find their pageview)
  has emails and formatted phone numbers replaced in paths, URLs, referrers, UTM tags, titles,
  search terms and prop values (`redact_pii`, default on; linear regexes, no backtracking), then
  `path_rules` (`*` = one segment, `**` = anything, first match wins) rewrite the path. Referrer
  spam (a built-in list, plus `exclusions.referrers`) is dropped. Erasure deletes an identity's
  events and sessions and strips its payments of every link to the person (or deletes them);
  purges delete by filter after a dry run, 50,000 events per call, and recount the sessions they
  touched. Neither lowers the daily usage counters.

## MCP tools (`/mcp`)

`create_site`, `list_sites`, `get_site`, `get_schema`, `list_props`, `create_segment`, `list_segments`, `update_segment`, `delete_segment`, `update_goal`, `update_site`, `delete_site`, `delete_visitor`, `purge_events`, `get_install_instructions`,
`verify_install`, `get_stats`, `get_timeseries`, `get_breakdown`, `get_top_movers`, `get_insights`,
`get_realtime`, `get_funnel`, `get_paths`, `get_attribution`, `track_events`, `create_goal`, `list_goals`, `delete_goal`,
`query_sql`, `create_share_link`, `revoke_share_links`, `list_share_links`, `list_visitors`, `get_visitor`,
`get_session`, `get_journeys`, `get_retention`, `get_stripe_integration`, `connect_stripe`, `connect_stripe_key`, `backfill_stripe`, `disconnect_stripe`,
`get_fx_rates`, `get_billing_integration`, `connect_billing_provider`, `disconnect_billing_provider`, `record_payments`, `list_payments`, `delete_payment`, `record_subscriptions`, `list_subscriptions`, `get_mrr`, `record_costs`, `list_costs`, `delete_costs`, `get_items`, `list_user_props`, `list_sessions`, `get_realtime_map`, `get_account_rollup`, `record_crawls`, `get_crawlers`, `import_csv`, `list_imports`, `compare_import`, `delete_import`, `export_events`, `list_annotations`, `create_annotation`,
`update_annotation`, `delete_annotation`, `get_exclusions`, `list_funnels`, `create_funnel`,
`update_funnel`, `delete_funnel`, `create_destination`, `list_destinations`, `test_destination`,
`delete_destination`, `create_alert`, `list_alerts`, `get_alert`, `update_alert`, `delete_alert`,
`test_alert`, `get_alert_history`, `get_digest`, `create_report`, `list_reports`, `update_report`,
`delete_report`, `send_report`. Write tools are hidden from read-only keys; `verify_install` is a write tool
(like `POST /sites/:id/verify`, it makes outbound fetches). `get_site` and `verify_install` return
third-party strings (bot user agents, dropped hostnames, the last event, anything copied from the
fetched page) only under an `untrusted` key with a notice, like the mail tools, and say so in
their descriptions. Tools that return visitor-sent values (stats and breakdowns, realtime,
visitors, sessions, journeys, insights, SQL) say they are data.

## Fair use

A free deployment with one-request signup needs a budget on every write path. Everything is a var
(optional: off, or the default named) and every account-level one has an `UNCLAIMED_<NAME>` form
for accounts no person has claimed (`capFor` in `@afs/shared`); `GET /sites/:id` shows the ones
that apply (`limits`) and whether the site is refusing events now (`status`). Code:
`src/lib/limits.ts`, `SiteDO` (`src/do/site-do.ts`).

- **Rate limits** (Workers rate-limit bindings, per Cloudflare location, `wrangler.jsonc`
  namespaces 42001-42007): `/e` per client network (the shared `networkKey`; the visitor's IP behind
  a proxy with the proxy key) and per site, before any storage or bot check; server events and
  payments per account; SQL per account; verify per account and per domain; Stripe deliveries per
  site; share dashboards per link. `429 rate_limited`. A missing binding is no limit; a failing one
  fails open.
- **Daily caps** (UTC): the site's DO counts accepted events, engagement beacons and payments in its
  `usage` table (purges and deletes never lower it). `MAX_EVENTS_PER_SITE_PER_DAY` is checked there.
  For `MAX_EVENTS_PER_ACCOUNT_PER_DAY` and `DAILY_EVENT_BUDGET` the DO reports its count to D1
  (`usage_daily`, absolute and idempotent; `usage_global`, by delta) at most once a minute or per 1%
  of the cap (at most 1,000 events) and reads back the account's and the platform's totals in the
  same batch, so the cost is one small D1 batch (2 rows written, about as many rows read as the
  account has sites) per active site per minute at most, and nothing when neither var is set. A
  deleted site's count stays in the account's total for the day. Payments (the API and signed
  Stripe deliveries alike) are held to all three; a batch records what fits. `429 daily_limit` /
  `over_capacity`.
- **Storage budget**: once the DO's database (`ctx.storage.sql.databaseSize`) passes
  `MAX_SITE_STORAGE_MB`, events and payments are refused (`507 storage_full`) and get_site / verify
  say so. Lowering `retention_days` purges at once and frees it.
- **Retention**: `MIN_RETENTION_DAYS` (so a 1-day retention can't churn fill-and-purge under the
  storage budget) and `MAX_RETENTION_DAYS`; the daily purge clamps existing sites to them too.
- **Counts**: `MAX_SITES_PER_ACCOUNT`, `MAX_GOALS_PER_SITE` (default 100: goals ride in the DO's
  settings copy), `MAX_SHARE_LINKS_PER_SITE` (default 10; revoking deletes them),
  `MAX_FUNNELS_PER_SITE`, `MAX_ANNOTATIONS_PER_SITE`: `403 quota_exceeded`.
- **SQL**: see the SQL endpoint limits above (`SQL_TIME_BUDGET_MS`).
- **Alerts and reports**: `MAX_ALERT_DESTINATIONS_PER_SITE` (default 5), `MAX_ALERTS_PER_SITE`
  (default 20), `MAX_REPORTS_PER_SITE` (default 5); `MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY`
  (default 100, every attempt counted, in `alert_usage`, never lowered) of which
  `MAX_ALERT_EMAILS_PER_SITE_PER_DAY` (default 10); the cron is bounded per run.
- **Suspension** (`accounts.suspended_at`, cached a minute per isolate): keys stop
  (`@afs/shared`), `/e` answers 403 (checked in the DO, which knows the site's account), payments are
  refused, share pages go dark.
- **Writes under a flood** of junk (dropped hostnames, bots) are coalesced: the DO writes its drop
  and warning counters at most every 10 seconds.

## Dashboard

`GET /share/:token`: a single self-contained HTML page (no framework, no external assets; it can't
be framed: `frame-ancestors 'none'` + `X-Frame-Options: DENY`, and its inline code runs under a
per-response CSP nonce) with the
headline numbers and % change, a visitors chart (inline SVG, hover tooltip, table view), and top
pages/sources/countries/devices tables, light and dark. It reads `GET /share/:token/data`
(aggregates only, no filters or SQL). For humans; agents use the API.

## Config

| Var / secret | |
|---|---|
| `PUBLIC_BASE_URL` | var; the URL agents and snippets use (empty = request origin) |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | see `@afs/shared` auth |
| `AUTH_ISSUER`, `INTERNAL_TOKEN` | `@afs/shared`: the OAuth server named in `/.well-known/oauth-protected-resource` (var; set by `pnpm afs`, unset = none listed), and the secret the site's dashboard uses for internal auth (unset = off) |
| `SALT_SECRET` | secret, required; derives the daily visitor salt and each site's proxy key (`/e` returns 503 without it) |
| `SQL_MAX_ROWS_READ` | optional var; rows a SQL query may read after its first result row before it is stopped. Default 1000000 |
| `SQL_TIME_BUDGET_MS` | optional var; SQL wall time (ms) a site may use per 10 minutes, then `429 sql_budget_exhausted`. Default 60000; `0` = off |
| `MAX_EVENTS_PER_SITE_PER_DAY` | optional var; accepted events + engagement beacons per site per UTC day (`429 daily_limit`). Unset = no cap |
| `MAX_EVENTS_PER_ACCOUNT_PER_DAY` | optional var; the same over all the account's sites (D1 aggregate). Unset = no cap |
| `DAILY_EVENT_BUDGET` | optional var; events per UTC day for the whole deployment (`429 over_capacity`). `UNCLAIMED_DAILY_EVENT_BUDGET` = the lower level at which unclaimed accounts are refused first. Unset = no budget |
| `MAX_SITE_STORAGE_MB` | optional var; stop storing a site's data once its DO database passes this size (`507 storage_full`). Unset = no budget (the DO's own limit is 10 GB) |
| `MIN_RETENTION_DAYS`, `MAX_RETENTION_DAYS` | optional vars; bounds for `retention_days` (default 1..3650); the daily purge clamps to them |
| `MAX_SITES_PER_ACCOUNT` | optional var; sites per account (`403 quota_exceeded`). Unset = no cap |
| `REPLAY_BASE_URL` | optional var; the replay app's public URL. With it, `/e` answers for sites with `replay_site_id` carry `r` and the tracker loads the replay recorder. Unset = off. `pnpm afs config` derives it from the profile's replay host |
| `MAX_GOALS_PER_SITE` | optional var; goals per site. Default 100 |
| `MAX_SHARE_LINKS_PER_SITE` | optional var; active share links per site. Default 10 |
| `UNCLAIMED_<NAME>` | optional; for every cap and budget above (and the annotation / funnel caps): the value for accounts no person has claimed. Unset = the plain var. `0` means "no cap" for count caps (sites, goals, share links, funnels, annotations) and "nothing" for daily budgets and storage |
| `INGEST_IP_LIMITER`, `INGEST_SITE_LIMITER`, `API_INGEST_LIMITER`, `SQL_LIMITER`, `VERIFY_LIMITER`, `WEBHOOK_LIMITER`, `SHARE_LIMITER` | rate-limit bindings in `wrangler.jsonc` (namespaces 42001-42007); remove one and that limit is off |
| `ENCRYPTION_KEY` | optional secret; 32 bytes base64 (`openssl rand -base64 32`). Seals the Stripe webhook signing secret. Unset: connecting Stripe returns 503 `not_configured` with a hint (the payments API still works). Changing it makes stored secrets unreadable: connect Stripe again |
| `MAX_ANNOTATIONS_PER_SITE` | optional var; manual annotations per site (403 `quota_exceeded` beyond). Unset = no cap |
| `MAX_EXPORT_ROWS_PER_SITE_PER_DAY` | optional var; raw events exported per site per UTC day (default 1000000) |
| `MAX_IMPORTED_ROWS_PER_SITE` / `MAX_IMPORTS_PER_SITE` | optional vars; imported rows (default 500000) and imports (default 100) per site |
| `MAX_CRAWL_HITS_PER_SITE_PER_DAY` | optional var; crawler hits counted per site per UTC day (default 100000) |
| `MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY` / `MAX_CRAWL_HITS_PER_DAY` | optional vars; crawler hits per account (all its sites) and for the whole deployment per UTC day, from a D1 aggregate (`crawl_usage_daily`, `crawl_usage_global`). Unset = none |
| `MAX_BROWSER_USER_PROP_KEYS_PER_SITE` | optional var; user property keys only browsers created (`browser_user_props`), apart from server keys (default 20) |
| `MAX_USER_PROP_KEYS_PER_SITE` | optional var; distinct user property keys per site (default 50) |
| `MAX_ITEMS_PER_EVENT` | optional var; ecommerce items kept per event (default 25, max 200) |
| `MAX_COST_ROWS_PER_SITE` | optional var; ad spend rows (date x source x campaign) per site, default 50000; rows past it are refused with `cost_rows_limit` |
| `MAX_FUNNELS_PER_SITE` | optional var; saved funnels per site (403 `quota_exceeded` beyond). Unset = no cap |
| `MAX_SEGMENTS_PER_SITE` | optional var; saved segments per site. Default 50 |
| `MAX_ALERTS_PER_SITE`, `MAX_ALERT_DESTINATIONS_PER_SITE`, `MAX_REPORTS_PER_SITE` | optional vars; defaults 20, 5, 5 |
| `MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY`, `MAX_ALERT_EMAILS_PER_SITE_PER_DAY` | optional vars; defaults 100 and 10 |
| `EMAIL`, `ALERT_EMAIL_FROM` | `send_email` binding (in the template) and the sender address (a var; a domain onboarded for Cloudflare Email Sending). Both needed for email destinations; unset `ALERT_EMAIL_FROM` = email off |
| `triggers.crons` | `*/5 * * * *`: alerts, reports, retries, history purge |
| `DEV_MODE` | `"true"` only in local `.dev.vars`: honours `x-dev-geo-{country,region,region-code,city,continent,timezone,lat,lon}` headers, lets verify fetch http://localhost, accepts browser events from localhost, falls back to an insecure salt. Empty in `wrangler.jsonc` |

## Develop and test

```sh
cp .dev.vars.example .dev.vars   # SALT_SECRET + DEV_MODE=true
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787 (runs the tracker build first)
pnpm smoke                        # in another shell: end-to-end curl run (BASE=... to target another host)
pnpm test                         # unit (pure logic, engine over node:sqlite, tracker in a fake DOM) + integration (workerd)
pnpm typecheck                    # Worker + tests, and the tracker with the DOM lib
```

## Not yet (v2)

Long-term rollups beyond raw retention, IP->geo for server events without explicit geo,
multi-site roll-up views, currency conversion for revenue, AI crawler ingestion, a realtime
map, ad spend import, richer share links, imports, Search Console, ecommerce items, user
properties. Feature parity status: `docs/parity/ga4.md` and `docs/parity/web-analytics.md`.
