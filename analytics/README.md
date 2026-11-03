# analytics

Cookieless, privacy-friendly web analytics that an agent can set up in two requests, with
server-side enrichment (every country, region and city from Cloudflare's edge, not from the
browser), server-side event ingestion for backends, goals, revenue, funnels and an
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
browser ── /s.js (tracker, 2.2 KB min / 1.3 KB gzip) ──► POST /e ─┐
backend ── POST /v1/sites/:id/events ─────────────────────────────┼─► Worker: enrich (geo, UA,
tags app (server-side forward) ───────────────────────────────────┘    bot filter, channel, visitor hash)
                                                      │
                                                      ▼
                                       SiteDO (one Durable Object per site, SQLite)
                                       events + sessions + goals copy, queries run here
D1: accounts, api_keys, sites, goals, share_links (control plane, never on the ingest hot path)
```

- **Per-site Durable Object (`SiteDO`, SQLite, `idFromName(site_id)`)** stores that site's events
  and sessions and runs its queries. It holds a copy of the site's settings and goals (pushed on
  every create/update/goal change) so ingest never touches D1. If the copy is ever missing, the
  Worker re-pushes it from D1 and retries. A DO for an unknown site id writes no storage. A daily
  DO alarm purges raw events and sessions older than `retention_days`.
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
| GET | `/sites/:id/stats` | aggregate metrics, optional `breakdown`, `compare=previous` |
| GET | `/sites/:id/breakdown?breakdown=` | top values of one property (same as stats' breakdown) |
| GET | `/sites/:id/timeseries` | metrics by `interval=hour\|day\|week\|month`; every bucket up to now |
| GET | `/sites/:id/realtime` | visitors in last 5 / 30 min, top pages/countries/sources (30 min), last 50 events |
| GET | `/sites/:id/funnel?steps=...` | ordered steps within a session |
| GET | `/sites/:id/sql?q=SELECT...` | read-only SQL over the site's own SQLite (SELECT/WITH only; limits below) |
| POST/GET/DELETE | `/sites/:id/goals[/:goal_id]` | `{ name, type: event\|pageview, match, value? }`, idempotent by name |
| POST | `/sites/:id/share` | public read-only dashboard URL (returns the existing link unless `{"new": true}`) |
| DELETE | `/sites/:id/share` | revoke the site's share links |

Public: `GET /s.js`, `POST /e` (both under any prefix), `GET /share/:token`,
`GET /share/:token/data`, `GET /llms.txt`, `POST /mcp`.

Query params for stats/timeseries/breakdowns/funnel:
- `period`: `today`, `yesterday`, `24h`, `7d`, `30d` (default), `90d`, `12mo`, `mtd`, `ytd`, `all`, or `from`/`to` (YYYY-MM-DD inclusive, site timezone). `7d`/`30d`/`90d` include today.
- `metrics`: `visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration, events, conversions, conversion_rate, revenue`
  (`events` includes pageviews; `bounce_rate` = % of sessions with <= 1 pageview and no custom
  event; `visit_duration` = mean seconds, the larger of first-to-last activity and visible time;
  `conversions` = goal-matching events; `conversion_rate` = % of visitors who converted;
  `revenue` = event revenue, or the goal's `value` for a matching event without revenue; currencies
  are summed as sent, no FX)
- `breakdown`: `page, entry_page, exit_page, hostname, source, referrer, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, click_id_type, country, region, city, continent, browser, browser_version, os, device, event_name, goal, prop:<key>`
  (missing values show as `(none)`; region/city rows include `country`; `goal` lists every goal)
- `filters`: `country==US;page~/blog;channel!=Direct` (`==`, `!=`, `~` contains case-insensitive,
  `!~`; `|` for OR; `(none)` for missing; `\;` escapes). `goal==X` keeps sessions that converted
  on X and counts only X as conversions; `entry_page`/`exit_page` filter sessions; the rest filter
  events.
- `compare=previous` (stats): same-length previous range; for an in-progress period only the
  elapsed part (today so far vs yesterday up to the same time). Applies to the totals, not to
  breakdown rows.
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

## MCP tools (`/mcp`)

`create_site`, `list_sites`, `get_site`, `update_site`, `delete_site`, `get_install_instructions`,
`verify_install`, `get_stats`, `get_timeseries`, `get_breakdown`, `get_realtime`, `get_funnel`,
`track_events`, `create_goal`, `list_goals`, `delete_goal`, `query_sql`, `create_share_link`,
`revoke_share_links`. Write tools are hidden from read-only keys; `verify_install` is a write tool
(like `POST /sites/:id/verify`, it makes outbound fetches). `verify_install` returns values copied
from the fetched page under `found_scripts_untrusted` and says so in its description.

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
public `/e` endpoint, comparison per breakdown row, currency conversion for revenue.
