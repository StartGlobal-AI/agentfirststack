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
browser ── /s.js (tracker, 3.3 KB min / 1.8 KB gzip) ──► POST /e ─┐
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
D1: accounts, api_keys, sites (+ exclusions), goals, share_links, funnels, integrations
    (control plane, never on the ingest hot path)
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
  `provider_events` and `annotations` tables.
- **Visitor identity.** Default `cookieless`: `visitor_id = sha256(daily_salt | site_id | ip | ua)`
  truncated to 16 hex chars, where `daily_salt = HMAC(SALT_SECRET, YYYY-MM-DD)` (UTC date of the
  event). No cookies, no storage, no cross-day linking. Optional per-site `persistent` mode: the
  `/e` response tells the tracker to keep the id in localStorage, so returning visitors are
  linkable; nothing in the snippet changes, and switching back to cookieless clears it.
- **Sessions**: 30 minutes of inactivity ends a session. Computed in the DO at ingest. Attribution
  is session-level: the session's first source, except that a Direct session adopts the first real
  source it sees (and earlier events of that session are re-attributed). Geo and device are
  inherited from the session by events that lack them (typical for server events).
- **Enrichment** (server side, never trusted from the client): `country`, `region`,
  `region_code`, `city`, `continent`, `timezone`, `latitude/longitude` (rounded to 0.1°),
  `asn`/`as_org` from `request.cf`; browser, version, OS, device type from the UA (ua-parser-js
  v1, MIT). Bots are dropped and counted per reason: UA patterns (crawlers, HTTP libraries, uptime
  monitors, preview fetchers, AI crawlers), headless signatures, `navigator.webdriver`,
  `cf.botManagement.verifiedBot` / `cf.verifiedBotCategory` when present. Query strings are never
  stored; only the UTM tags and the first click id.
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

## Tracker (`/s.js`)

```html
<script defer src="https://ANALYTICS_HOST/s.js" data-site="site_xxx"></script>
```

Source: `src/tracker/index.ts` (own tsconfig with the DOM lib), bundled + minified by esbuild
(`scripts/build-tracker.mjs`) into `dist/tracker.txt`, which wrangler imports as a Text module
(`build.command` + `rules` in `wrangler.jsonc`). Served with a 1 h cache and an ETag.

- pageviews, including SPA navigations (history.pushState/replaceState/popstate, deduped by
  path+query)
- `afsa('event', 'signup', { plan: 'pro' })`, `afsa('revenue', 'purchase', 49.00, 'USD', props)`,
  `afsa('identify', 'user_123')`, `afsa('pageview')`; a queue stub so calls before load aren't lost
  (queued `identify` calls are applied before the first pageview)
- engagement time (visible time) sent with `sendBeacon` when the page is hidden or left, and
  before each SPA navigation; it feeds `visit_duration`
- outbound link clicks (`outbound_click`) and file downloads (`file_download`), `{url}` prop
  without query string; opt-out via `data-auto="false"`
- max scroll depth per page and, for the page load (not SPA navigations), Core Web Vitals: LCP,
  INP (slowest interaction) and CLS (largest 5 s session window), on the engagement beacon
- opt-in `data-404="true"`: a `404` event (`props.from` = linking page, no query) on pages served
  with HTTP 404 (Navigation Timing) or carrying `<meta name="afsa-404">`; `afsa('404')` for
  client-rendered 404s
- opt-in `data-forms="true"`: `form_submit` with `props.form` = the form's id, name or action
  path; field values are never read
- `afsa.visitorId()` returns the id the server echoed for the last event (so after the first
  pageview response), for a backend to send as `visitor_id`
- sends a GPC / DNT flag; the server drops those events when the site enables `respect_dnt`
  (the `Sec-GPC` / `DNT` headers count too)
- `data-api` overrides the collect URL; `localStorage.afsa_ignore = 1` excludes your own visits
  (no cookies; the only other storage key is `afsa_vid`, in persistent mode)
- `text/plain` body so there is no CORS preflight; `POST /e` bodies are limited to 16 KB (`413
  payload_too_large`, refused by `content-length` and never read past 16 KB)

## API (all under `/v1`, `Authorization: Bearer <key>`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (no auth); `/me`, `/keys` from `@afs/shared` |
| POST | `/sites` | `{ domain, name?, timezone?, visitor_id_mode?, retention_days?, allowed_hostnames?, respect_dnt? }` -> site + install snippets + next_steps. Same domain again returns the existing site (`200`, `existing: true`) |
| GET | `/sites`, `/sites/:id` | `/sites/:id` adds a data summary (event counts, last event, hostnames, drops by reason, `warnings_last_7d`) |
| PATCH | `/sites/:id` | settings (any subset, including domain) |
| DELETE | `/sites/:id` | deletes site, goals, share links and the DO's data |
| GET | `/sites/:id/install?framework=html\|nextjs\|astro\|react\|wordpress\|gtm\|tags` | file + code, tracker API, proxy snippets, server-side curl |
| POST | `/sites/:id/verify` | `{url?}`: fetches the page, checks the snippet + site id, that the script URL serves the tracker (catches broken proxies), CSP, that events arrived, hostname rejections and proxied events without the proxy key; returns `checks`, `fixes`, `next_steps`. Full key only. Redirects: at most 3, each hop on the domain, a subdomain or `allowed_hostnames`; reads at most 1 MB of the page; fetches the script (at most 256 KB) only from this deployment's host or those site hosts |
| POST | `/sites/:id/events` | server-side ingestion, batch up to 100 (see below) |
| GET | `/sites/:id/stats` | aggregate metrics, optional `breakdown`, `compare=previous\|year\|custom` |
| GET | `/sites/:id/breakdown?breakdown=` | top values of one property; `sort`, comparison per row |
| GET | `/sites/:id/timeseries` | metrics by `interval=hour\|day\|week\|month`; every bucket up to now; comparison per bucket; annotations |
| GET | `/sites/:id/movers?breakdown=` | gainers and losers of a metric vs the comparison period |
| GET | `/sites/:id/insights` | revenue share, top sources/countries, time-to-convert histograms, top converting events, heatmap |
| GET | `/sites/:id/realtime` | visitors in last 5 / 30 min, top pages/countries/sources (30 min), last 50 events |
| GET | `/sites/:id/funnel?steps=...` | ordered steps within a session (or `funnel_id=`) |
| GET | `/sites/:id/sql?q=SELECT...` | read-only SQL over the site's own SQLite (SELECT/WITH only; limits below) |
| POST/GET/DELETE | `/sites/:id/goals[/:goal_id]` | `{ name, type: event\|pageview\|scroll, match, value?, threshold? }`, idempotent by name |
| GET | `/sites/:id/visitors`, `/sites/:id/visitors/:visitor` | visitor list (generated names, user_id, location, device, source, spent, last seen) and one visitor's timeline |
| GET | `/sites/:id/sessions/:session_id` | one session and its events |
| GET | `/sites/:id/journeys` | visitors who completed a goal (or a first purchase): source, time, visits, touchpoints |
| GET/POST/DELETE | `/sites/:id/integrations/stripe` | webhook URL + status / connect `{webhook_secret}` / disconnect |
| POST | `/webhooks/stripe/:site_id` | Stripe webhook (public; `Stripe-Signature` verified) |
| POST/GET/DELETE | `/sites/:id/payments[/:payment_id]` | payments from any provider, idempotent by (provider, id) |
| GET | `/sites/:id/exclusions` | rules, drops, `your_ip`, dry run `?ip=&url=&country=` |
| POST/GET/PATCH/DELETE | `/sites/:id/annotations[/:annotation_id]` | dated notes; automatic traffic spikes |
| POST/GET/PATCH/DELETE | `/sites/:id/funnels[/:funnel_id]` | saved funnels; GET one = drop-off per step |
| POST | `/sites/:id/share` | public read-only dashboard URL (returns the existing link unless `{"new": true}`) |
| DELETE | `/sites/:id/share` | revoke the site's share links |

Public: `GET /s.js`, `POST /e` (both under any prefix), `GET /share/:token`,
`GET /share/:token/data`, `GET /llms.txt`, `POST /mcp`, `POST /webhooks/stripe/:site_id` (signed).

Query params for stats/timeseries/breakdowns/funnel:
- `period`: `today`, `yesterday`, `24h`, `7d`, `30d` (default), `90d`, `12mo`, `mtd`, `ytd`, `all`, or `from`/`to` (YYYY-MM-DD inclusive, site timezone). `7d`/`30d`/`90d` include today.
- `metrics`: `visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration, events, conversions, conversion_rate, revenue`
  (the default set, plus `revenue_per_visitor`), and opt-in `new_revenue, renewal_revenue, refunds,
  purchases, customers, purchase_rate, new_visitors, returning_visitors, scroll_depth, time_on_page,
  lcp_p75, inp_p75, cls_p75`
  (`events` includes pageviews; `bounce_rate` = % of sessions with <= 1 pageview and no custom
  event; `visit_duration` = mean seconds, the larger of first-to-last activity and visible time;
  `conversions` = goal-matching events; `conversion_rate` = % of visitors who converted;
  `revenue` = event revenue plus payments, refunds subtracted, or the goal's `value` for a matching
  event without revenue; currencies are summed as sent, no FX; `purchase_rate` = visitors with a
  new purchase / visitors; returning = an earlier session of the visitor or its user_id, so
  same-day only for anonymous cookieless visitors; vitals are p75 by nearest rank over pageviews.
  Payments never count as visitors, visits or events)
- `breakdown`: `page, entry_page, exit_page, hostname, source, referrer, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, click_id_type, country, region, city, continent, browser, browser_version, os, device, event_name, goal, prop:<key>`
  (missing values show as `(none)`; region/city rows include `country`; `goal` lists every goal)
- `filters`: `country==US;page~/blog;channel!=Direct` (`==`, `!=`, `~` contains case-insensitive,
  `!~`; `|` for OR; `(none)` for missing; `\;` escapes). `goal==X` keeps sessions that converted
  on X and counts only X as conversions; `entry_page`/`exit_page` filter sessions; the rest filter
  events.
- `compare=previous|year|custom` (+ `compare_from`, `compare_to`, `match_weekday=true`) on stats,
  breakdown and timeseries: same-length previous range, the same dates a year earlier, or a custom
  range; for an in-progress period only the elapsed part (today so far vs yesterday up to the same
  time). Totals, every breakdown row and every timeseries bucket get
  `comparison: {metrics, change_percent}`.
- `sort` (breakdowns): a countable metric (`revenue`, `purchase_rate`, `revenue_per_visitor`, ...),
  applied before `limit`, or `change` / `change:<metric>` for the biggest absolute movers.
- `page` rows count revenue and conversions of the sessions that viewed the page.
- `limit` (default 20, max 1000)

All user values are bound SQL parameters; the only text spliced into SQL comes from fixed tables
or integers the code computed (timezone offsets for bucketing).

SQL endpoint limits (it runs synchronously inside the site's Durable Object, next to ingest):
- refused up front (`sql_rejected`): recursive CTEs (`RECURSIVE`, or a CTE that selects from
  itself, which SQLite runs as recursive without the keyword), comma joins (`FROM a, b`), more than
  2 JOINs, and JOINs without ON / USING (NATURAL joins and table-valued functions such as
  `JOIN json_each(e.props)` are fine);
- at most 1000 rows come back, whatever the query's own LIMIT: the cursor is never stepped further;
- a query that keeps reading while it returns rows (a subquery scanning events per row) is stopped
  (`sql_too_expensive`) once it has read `SQL_MAX_ROWS_READ` rows after its first row. Work SQLite
  does before a row comes back (an aggregate, a sort) can't be interrupted, since the DO SQL API has
  no timeout or interrupt; the shape checks above are what bound it.

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
  "revenue": { "amount": 49.0, "currency": "USD" }
}] }
```

- Only `name` is required. A single event object without the `events` wrapper is accepted too.
- `timestamp`: unix ms or ISO 8601, default now, at most 31 days old and 5 minutes ahead (else that
  event is rejected; the rest of the batch still lands).
- Visitor: `visitor_id` if given; else `ip` + `user_agent` hashed exactly like the browser, so the
  event lands on the same visitor and (within 30 min) the same session; else derived from
  `user_id`; else a new random visitor.
- Geo: explicit fields always win; else inherited from the visitor's session; else unknown. No
  IP->geo lookup (Workers have none for arbitrary IPs), and the request's own `request.cf` is never
  used for server events (it would be the backend's location).
- Response `202`: `{ accepted, rejected, results: [{ index, ok, visitor_id, session_id } | { index, ok: false, reason }] }`.
- Events with a bot `user_agent` are rejected per event.

## Revenue attribution

Payments are stored in the site's DO twice: as events (origin `payment`, names `payment`,
`renewal`, `refund` with negative revenue) carrying the linked session's attribution, geo and
device, so revenue works in every breakdown, filter, timeseries and funnel; and in a `payments`
ledger keyed by `provider:external_id` for idempotency, refunds, renewals and deletes.

- **Linking:** `afsa.visitorId()` goes into the Stripe Checkout Session's `metadata.afs_visitor_id`
  (subscriptions: also `subscription_data.metadata`) or `client_reference_id` (Payment Links:
  `?client_reference_id=`). Order: session id, the visitor's latest session at or before the
  payment, the user id's latest session, the customer's earlier payment (renewals keep the
  original source), the refunded payment. Unlinked payments show as channel `Unattributed` and are
  re-attributed when the customer's checkout arrives. Metadata is untrusted: only those keys are
  read and validated, nothing else is stored, and customer ids are kept as a per-site salted hash.
- **Stripe:** `GET /sites/:id/integrations/stripe` gives the webhook URL and events
  (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`,
  `charge.refunded`; optional `payment_intent.succeeded`). `POST` stores the signing secret sealed
  with `ENCRYPTION_KEY` (never returned). Each delivery: `Stripe-Signature` verified (any v1, 5 min
  tolerance), event id deduped for 30 days, body capped at 1 MB, test-mode events acknowledged but
  counted only with `record_test_events`. invoice `subscription_create` = new, `subscription_cycle`
  / `subscription_update` / `subscription_threshold` = renewal; `charge.refunded` sets the
  cumulative refunded amount. Status: `events_received`, `last_result`, `last_error`, unlinked
  payments; verify reports `stripe_webhook` and `payment_linking`.
- **Any provider:** `POST /sites/:id/payments` `{payments: [{id, provider?, amount, currency, type?,
  timestamp?, visitor_id?, session_id?, user_id?, customer_id?, refunded_payment_id?, livemode?}]}`.

## Visitors, journeys, insights, annotations, exclusions, funnels

- **Visitors** are identities: `user:<user_id>` when identified (earlier anonymous sessions of the
  same visitor id join it), else the visitor id; names are generated from the id (FNV-1a over 64
  adjectives x 64 animals). Cookieless ids rotate daily, so anonymous history is same-day; every
  response says so in `identity.note`.
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
- **Saved funnels** live in D1 (`funnels`); reading one runs the same query as `funnel?steps=`.

## MCP tools (`/mcp`)

`create_site`, `list_sites`, `get_site`, `update_site`, `delete_site`, `get_install_instructions`,
`verify_install`, `get_stats`, `get_timeseries`, `get_breakdown`, `get_top_movers`, `get_insights`,
`get_realtime`, `get_funnel`, `track_events`, `create_goal`, `list_goals`, `delete_goal`,
`query_sql`, `create_share_link`, `revoke_share_links`, `list_visitors`, `get_visitor`,
`get_session`, `get_journeys`, `get_stripe_integration`, `connect_stripe`, `disconnect_stripe`,
`record_payments`, `list_payments`, `delete_payment`, `list_annotations`, `create_annotation`,
`update_annotation`, `delete_annotation`, `get_exclusions`, `list_funnels`, `create_funnel`,
`update_funnel`, `delete_funnel`. Write tools are hidden from read-only keys; `verify_install` is a write tool
(like `POST /sites/:id/verify`, it makes outbound fetches). `verify_install` returns values copied
from the fetched page under `found_scripts_untrusted` and says so in its description. Tools that
return visitor-sent values (`list_visitors`, `get_visitor`, `get_session`) say they are data.

## Dashboard

`GET /share/:token`: a single self-contained HTML page (no framework, no external assets) with the
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
| `ENCRYPTION_KEY` | optional secret; 32 bytes base64 (`openssl rand -base64 32`). Seals the Stripe webhook signing secret. Unset: connecting Stripe returns 503 `not_configured` with a hint (the payments API still works). Changing it makes stored secrets unreadable: connect Stripe again |
| `MAX_ANNOTATIONS_PER_SITE` | optional var; manual annotations per site (403 `quota_exceeded` beyond). Unset = no cap |
| `MAX_FUNNELS_PER_SITE` | optional var; saved funnels per site (403 `quota_exceeded` beyond). Unset = no cap |
| `DEV_MODE` | `"true"` only in local `.dev.vars`: honours `x-dev-geo-{country,region,region-code,city,continent,timezone,lat,lon}` headers, lets verify fetch localhost, falls back to an insecure salt. Empty in `wrangler.jsonc` |

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

Long-term rollups beyond raw retention, cohort/retention reports, email reports via `mail/`,
IP->geo for server events without explicit geo, multi-site roll-up views, rate limiting on the
public `/e` endpoint, currency conversion for revenue. Next batch: alerts and scheduled reports, AI
crawler ingestion, realtime map, paths, CSV export, ad spend import, segments and richer share
links, imports, Search Console.
