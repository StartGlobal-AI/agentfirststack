# Architecture

AgentFirstStack is five Cloudflare Workers that share one identity database. Each service is
usable on its own, and each is built the same way: Hono routes and MCP tools on top of one service
layer, D1 for configuration, a Durable Object per hot entity, R2 for blobs and Queues for delivery
that has to be retried.

```
                 agents (REST or MCP, Bearer afs_ key)        browsers and backends (public)
                                   │                                     │
     ┌──────────────┬──────────────┼──────────────┬────────────┐        │
     ▼              ▼              ▼              ▼            │        │
  site          analytics         tags           mail          │        │
  apex          analytics.*       tags.*         mail.*  ◄─────┼── MX ── Email Routing (catch-all)
  landing,      /s.js, /e         /c/:id.js,     inboxes,      │
  llms.txt,     SiteDO per site   /collect       InboxDO per   │
  signup, MCP   (events,          ContainerDO    inbox (wait)  │
  gateway,      sessions, SQL)    per container                │
  dashboard,                      (identities,                 │
  OAuth server                    event log)                   │
                                     │ Queue                   │ Queue (webhooks)
                                     ▼                         ▼
                       GA4 · Meta · Google Ads ·        customer webhooks,
                       TikTok · webhook · analytics     Email Sending (send_email)
     │              │              │              │
     └── AUTH_DB: one D1 identity database (accounts, api_keys, signup_log, users, OAuth) ──┘
           each app also has its own D1 (config) and mirrors account rows into it
```

Tags reaches analytics two ways: the browser runtime's `analytics` tag loads the tracker, and its
`analytics` destination sends server-side copies. Without an API key in the destination, those go
over the `ANALYTICS` service binding with internal auth as the container's account, so analytics
refuses a site of another account. The runtime does nothing in a browser that sends Global
Privacy Control or Do Not Track (`settings.respect_dnt`, on by default), and its event log keeps a
/24 or /48 network and coarse location instead of raw IPs and user agents.

Replay (`replay.*`) sits beside them: the browser recorder (`/r/:id.js`, masked before anything is
sent) posts gzip chunks to `/i`; they're stored in R2 (`<site>/<session>/<seq>`) and a
`ReplaySiteDO` per site keeps the session index, derived events, signals, error groups and heatmap
rollups. Signals can be forwarded to analytics as events over its service binding, and to a
tags container as server events over the `TAGS` binding (queued in the site DO, sent in batches by
its alarm, routed on to GA4 and ad platforms by the container). Heatmap images are drawn by
Browser Rendering (`BROWSER`) from a stored snapshot and cached in R2 (`heatmaps/<site>/`). Linking a
replay site to an analytics site also sets that site's `replay_site_id` over the binding, so the
analytics tracker loads the replay loader by itself (`r` in the `/e` answer, with `REPLAY_BASE_URL`).
The same loader lazy-loads replay's on-site survey widget (`/sv/<site>.<rev>.js`, closed Shadow DOM,
never recorded) when the site has active surveys; answers go to `/f` and into the site's DO next to
the sessions they are linked to. Replay's signed webhooks (survey responses, segment entries, new
error groups, signal spikes) are D1 delivery rows sent right away and retried by the site DO's own
alarm, so replay needs no queue. Saved segments, event definitions, surveys and webhooks are D1
config; tags, labels, notes, responses and attention data live in the DO with the session.

## First-party collection

Ad blockers block requests to `analytics.*` hosts, so every install answer leads with `first_party`
(analytics, tags and replay alike): a first-party domain, then the path proxy, then the direct
snippet as a last resort. Collection reaches the services three ways, and analytics counts each
day's browser events by which one (`via_direct`, `via_proxy`, `via_edge` in the DO's `usage` row,
in the same upsert as the daily budget), which the setup check's `analytics.first_party` reads:

- **Direct**: the browser calls `analytics.<apex>/e`, `tags.<apex>/collect`, `replay.<apex>/i`.
  IP and geo are Cloudflare's view of the request.
- **Path proxy**: the customer's own server or edge forwards `/_a/*`, `/_t/*` or `/_r/*` unchanged
  (the services serve their browser endpoints under any prefix) with the resource's proxy key
  (`x-afs-proxy-key`, an HMAC of the site or container id). Only with a valid key do analytics and
  tags trust its X-Forwarded-For and `x-afs-geo-*`.
- **First-party domain** (Cloudflare for SaaS): `edge.shop.com` is a custom hostname on the
  platform's zone with a Worker route to the site Worker (`site/src/first-party-domains.ts` creates
  both and stores them in `first_party_domains` in the identity DB). The site Worker's edge
  (`firstPartyEdge` in `site/src/first-party.ts`, before every other route) looks the Host up
  (cached a minute per isolate) and forwards `/_a/*`, `/_t/*`, `/_r/*` over the service bindings to
  `https://<svc>.internal`, with cookies and visitor-sent `x-afs-*` removed, the visitor's IP and
  geo added, and `x-afs-internal` (INTERNAL_TOKEN) plus `x-afs-edge-host`. `edgeHost()` in
  `@afs/shared` accepts that only over a binding (the `.internal` host) with a constant-time token
  match, and the services trust it like a valid proxy key; analytics then hands the tracker a
  replay loader on the same hostname. No account is involved: the edge only forwards public
  collection, and `x-afs-internal` without `x-afs-account` is refused everywhere else. Every other
  path on such a host is a small 404, except the platform's own static files (images, CSS, JS),
  which the assets binding serves before the Worker runs (`run_worker_first` skips them).

## Identity

- `POST /v1/signup` on any service (or the site) creates an account and an API key. Nothing else
  is needed: no email, no verification.
- Keys are 40 random base32 characters after the prefix (200 bits). Only their SHA-256 is stored.
  Scopes are `*` (full) or `read` (GET routes and read-only MCP tools).
- Accounts and keys live in the identity database, bound as `AUTH_DB` in every app. The first
  time an account calls an app, `ensureLocalAccount()` writes a bare `accounts` row into that
  app's own database, so the app's foreign keys and cascades keep working without cross-database
  joins.
- Without `AUTH_DB` an app keeps keys in its own database and runs fully standalone.
- Keys may carry an `expires_at`. `authenticate()` rejects a key once it passes; OAuth access
  tokens use it (8 hours). Every app's own `api_keys` table has the column too, for standalone mode.
- **Internal auth.** A request with `x-afs-internal: <INTERNAL_TOKEN>` (constant-time compare) and
  `x-afs-account: acct_...` (an existing account) is a full-access caller for that account in
  `requireAuth()`. The site's dashboard uses it over service bindings. A wrong token is a `401`;
  without the secret the headers are ignored.
- **Project notices.** When the platform has something new for a project (a row in the identity
  DB's `project_notices`, which the site writes and deletes), every service tells the project's
  agent in its answers: `requireAuth()` adds `AFS-Notice: <notice>` to every answer, and at most
  once a day a top-level `"notice"` field to a 2xx JSON object answer to a GET (under 256 KB; never
  arrays, NDJSON, CSV, downloads or errors); `handleMcp()` adds one text item to a successful
  `tools/call` result at most once a day. "Once a day" is the row's `shown_at`, set by an atomic
  `UPDATE ... RETURNING`, shared by every service and channel. API keys and OAuth tokens only (never
  internal auth, `/v1/signup` or the site's `/v1/setup`). A per-isolate cache (10 minutes) keeps
  most requests free of any query; errors, a missing table or a slow lookup mean no notice.

Code: `shared/src/auth.ts`, `shared/src/notices.ts`, `shared/src/resource.ts` (RFC 9728 metadata).

## People and OAuth (optional)

Agents never need any of this; see [accounts.md](accounts.md) for the full design. It all lives in
the site Worker and the identity database (`site/migrations/0003_*` to `0008_*`).

- **Users** sign in with Google (OIDC, PKCE, state, nonce; the ID token comes from the direct token
  response). A session is a random cookie (`afs_session`, HttpOnly, Secure, SameSite=Lax, apex
  only) of which only the SHA-256 is stored; it lasts 30 days, sliding. CSRF tokens are derived
  from the cookie value, so they're never stored.
- **Memberships** link users to accounts ("projects") as owner or member. Every dashboard route
  looks the membership up first; a non-member gets a 404.
- **Claim links** (`POST /v1/claim-link`, the gateway tool `afs_create_claim_link`) are single-use,
  7-day tokens a full-access key can mint, so the person behind an agent can claim its project.
- **Dashboard** (`/dashboard`): server-rendered HTML, `frame-ancestors 'none'`, every form a POST
  with a CSRF token, scripts from its own origin only. Resource lists come from the services over
  their service bindings with internal auth. A project's tabs (Overview, Analytics, Tags, Replay,
  Mail, Settings) and the projects page's cards are drawn in the browser by
  `public/dashboard-app.js` from the services' own answers, read through a read-only proxy on the
  site (`/dashboard/projects/:id/data/<service>/...`, GET and listed report paths only); the one
  write there is a one-hour replay player link (Watch, with the page's CSRF token). Forms do the
  rest: the owner chooses where each inbox's email goes (the mail service's `PATCH
  /v1/inboxes/:id`, as the project), manages keys and members, and deletes or restores the project.
- **Deleting a project** (`site/src/project-deletion.ts`): its owner in Settings, General, or an
  unclaimed project's own agent (`DELETE /v1/me {confirm}`, MCP `afs_delete_project`). It stops at
  once: keys and OAuth tokens answer `403 project_deleted`, and `accountStanding()` reads it as
  suspended, so tracking, recording, inbound mail and forwarding stop. For 7 days the owner can
  restore it; then the site's daily cron calls each service's `DELETE /v1/account` (internal auth
  only) until each answers `done: true`, then erases its identity rows, keeping only the id and
  the dates. Mail keeps the project's shared-domain addresses that received mail reserved for good.
- **Emails to people** (`site/src/email.ts`, `email-messages.ts`; optional: the `EMAIL` binding
  and `NOTIFY_EMAIL_FROM`): the site emails signed-in people at their Google address about their
  projects (claims, members, connected apps, deletion, suspension, new setup items). Each email
  is an `email_outbox` row first, keyed per event and person, so nothing is sent twice; the hourly
  cron sends the queued ones and retries.
- **Usage and alerts** (`site/src/project-health.ts`): every service answers `GET /v1/usage` with
  its fair-use caps in one shape (`label`, `used`, `limit`, `resets_at`, `per` resource,
  `drops_data`), and the site's `GET /v1/usage` (MCP `afs_get_usage`) merges the four. Hourly, the
  site reads it for every claimed project and emails its people when a cap that drops data is at
  80% or reached; daily, it reads each analytics site's page views and emails them when a site
  that had steady traffic has had none for two days.
- **OAuth 2.1 server** for MCP connectors: RFC 8414 metadata, dynamic registration of public
  clients, consent with a project picker, PKCE S256, exact redirect URIs, single-use 10-minute
  codes, `iss` on the redirect, rotating refresh tokens (reuse revokes the grant). Access tokens
  are API keys with `expires_at`, so no service knows OAuth exists. Every service's RFC 9728
  metadata names the site (`AUTH_ISSUER`) and every `/mcp` 401 points at that metadata.
- A daily cron on the site (03:17 UTC) deletes expired keys, codes, refresh tokens, sessions,
  claim links and emails older than 30 days, writes setup notices and erases deleted projects
  whose 7 days have passed. An hourly one (:47) sends emails, including the reminder the day
  before a project is erased.

## One service layer, two interfaces

Every capability is a function in `<app>/src/service/`. REST routes (`src/routes/`) and MCP tools
(`src/mcp.ts`) are thin wrappers that parse input with zod and call it, so the two can't drift.
MCP is stateless Streamable HTTP (`handleMcp()` in `shared/src/mcp.ts`): a fresh server per
request, no sessions, no Durable Object. Tools that change state are registered with
`tools.write()` and are invisible to read-only keys.

Errors are always `{"error":{"code","message","hint","details"}}`. The hint tells the agent how to
recover.

The site also runs an **MCP gateway** at `/mcp` (`site/src/mcp-gateway.ts`): a stateless JSON-RPC
router that merges every service's tools with an `analytics_` / `tags_` / `mail_` / `replay_`
prefix and forwards each call over a service binding with the caller's own key, so one connector
covers the whole platform with the same scoping and errors as the services themselves. It adds seven
tools of its own: `afs_check_setup` (`GET /v1/setup`), `afs_test_setup` and `afs_check_test_visit`
(`/v1/setup/test`), `afs_get_usage` (`GET /v1/usage`), `afs_create_claim_link`, `afs_update_project`
(`PATCH /v1/me`) and `afs_delete_project` (`DELETE /v1/me`).

The **setup check** (`site/src/setup-check.ts`, `GET /v1/setup`) is the full setup in `llms.txt` as a
list of checks. It reads each service as the project with internal auth over the bindings (the
same path the dashboard uses), never forwards the caller's key and fetches nothing from the
website: install status comes from what the services received and from the last `verify`. The
dashboard's project page renders the same report.

**New features reach projects that are already set up** through the setup catalog
(`site/src/setup-catalog.ts`): each setup item with the catalog version it arrived in. The setup
check records what the project's agent saw (`setup_state` in the identity DB) and says what's new
since its last run. The site's daily cron writes a short notice (`project_notices`) for each active
project that hasn't seen the current catalog; every service adds it to that project's next API or
MCP answer at most once a day (`@afs/shared` notices), and the analytics weekly report shows it to
the owner. Running the check clears it. Server behaviour and the hosted browser scripts need none
of this: they change for everyone on deploy.

The **setup test** (`site/src/setup-test.ts`, `/v1/setup/test`) sends test traffic through the same
bindings: mail sends from the project's inbox to its own `+afs-test` address (delivered internally)
and reads the code back; analytics gets a debug event; tags gets a `test: true` event no conversion
uses (so it reaches analytics only) and the live conversions with `destinations` limited to the ad
platforms, which deliver in their test modes. Test events never match a goal, so they can't stand in
for the browser visit, which the second call checks from realtime, the tags event log and replay.

## Discovery

The apex serves what agents and crawlers look for, from `site/public/`:

- **Manuals and crawling:** `llms.txt`, `robots.txt` (with Content Signals), `sitemap.xml`.
- **Homepage formats:** `index.md`, which `/` returns for `Accept: text/markdown`.
- **Registration:** `auth.md`, with agent registration and credential use.
- **Catalogs:**
  - `/.well-known/api-catalog` (RFC 9727)
  - `/.well-known/ai-catalog.json` (ARD)
  - `/.well-known/mcp/*.json` (MCP server cards)
  - `/.well-known/agent-skills/index.json`, whose digests `scripts/build-discovery.mjs` recomputes on every build
- **Link headers:** `/` returns RFC 8288 `Link` headers pointing at all of the above.
- **WebMCP:** the landing page registers browser tools (`get_setup_prompt`, `read_manual`, `create_api_key`).

## Analytics

- **Ingest.** `/s.js` posts to `/e` (also served under any path prefix, for first-party proxying).
  The Worker enriches each event at the edge (geo from `request.cf`, browser and device from the
  user agent, bot filtering, channel and source classification, UTM and click ids) and hashes a
  cookieless visitor id from a daily salt.
- **Storage.** It then forwards the event to the site's own SQLite Durable Object (`SiteDO`),
  which stores events and sessions and runs every query. The site's settings are copied into the
  DO, so ingest never touches D1.
- **Protection.** Each site's DO counts browser events per network a day (a keyed hash that rotates
  daily, never the address) and watches 15-minute windows for spikes (`src/do/protection.ts`). Past a
  network's share, or from a data-centre network while the site is under attack, events are stored
  quarantined (`debug = 2`): out of reports and the budget, kept 7 days for review (`/quarantine`,
  release or purge). Tags does the same per container and holds browser conversions during an attack.
  The site's hourly check emails the people from `attacks` in each service's usage answer.
- **Live.** The same DO holds the site's live streams (`GET /v1/sites/:id/realtime/stream`, and
  the dashboard's `/dashboard/projects/:id/live/analytics/:site`, which the site Worker checks and
  hands over a service binding). They are hibernating WebSockets: an idle stream costs nothing, and
  after stored events the DO sends one message a second at most, while it is awake for the ingest
  anyway. `online` counts visitors of the last 5 minutes minus those whose latest page is the one
  they closed (the tracker's leave beacon, kept in `live_leaves` for 10 minutes).
- **Backends** send events with `POST /v1/sites/:id/events` using a key. The tags service uses this
  path to forward conversions.
- **Revenue.** Stripe posts to `/webhooks/stripe/:site_id` (no key; `Stripe-Signature` verified
  against the signing secret, which D1 `integrations` keeps sealed with `ENCRYPTION_KEY`); any
  other provider uses `POST /v1/sites/:id/payments`. The DO stores each payment as an event
  (origin `payment`, linked to the visitor's session, so revenue flows through every breakdown)
  and in a `payments` ledger keyed by `provider:external_id`; Stripe event ids are deduped in
  `provider_events`, and `payment_links` maps a hashed customer to its first session so renewals
  keep the original source. Polar, Paddle and LemonSqueezy post to `/webhooks/<provider>/:site_id`
  (each provider's signature scheme, secrets sealed in the same `integrations` table). One-call
  Stripe connect seals a restricted key too, creates the endpoint and backfills history from the
  cron. Subscription states land in the DO's `subscriptions` (latest state) and
  `subscription_changes` (every MRR movement), so MRR at any moment is a query over the movements.
  With a site currency the Worker converts money at ingest using ECB rates kept per day in D1
  (`fx_rates`, refreshed by the cron).
- **More per-site data in the DO**, each in its own table and never mixed into events: ad spend
  (`costs`, joined into cost metrics by source and campaign), ecommerce items (`event_items`,
  removed with their event by a trigger), user properties (`user_props`, the `user:<key>`
  dimension), crawler hits reported by the site's server (`crawler_hits`, own daily budget),
  imported daily aggregates from GA4, Plausible or any other tool (`imports`, keyed by source, tool,
  kind and date range; `imported_rows`, merged into unfiltered reports for days before live data,
  and compared with live visitors for the days both ran: `imports/compare`), and the raw export's
  daily counter.
- **Exclusions** (IPs and CIDR ranges, paths, hostnames, countries) live on the D1 site row and in
  the DO's settings copy. The Worker hands the visitor IP to the DO only to compare it in memory;
  it is never stored.
- **Ingest rules in the DO**, before anything is stored: referrer spam is dropped, ignored
  referrers (hosted checkouts, sign-in pages, the site's own list) count as no referrer so a
  visitor back from paying keeps their source, emails and formatted phone numbers are redacted,
  path rules rewrite paths, site search terms become `site_search` events, and each new session
  updates its identity's first touch (DO `identities` table: first-touch dimensions, retention
  cohorts, attribution). `validate_only` runs the same path in a transaction that is rolled back.
- **The DO's daily alarm** purges data past retention and writes traffic-spike annotations
  (DO `annotations` table, next to manual notes) for the days since its last run.
- **Alerts and scheduled reports** (each alert firing also writes an `alert` annotation in the DO) live in D1 (`alerts`, `reports`, `alert_destinations` with
  webhook and Slack URLs sealed by `ENCRYPTION_KEY`, history in `alert_events`). A cron every
  5 minutes evaluates due alerts (a few read-only aggregates from each site's DO), sends due
  reports (the digest), continues Stripe backfills (5 pages per site, 10 sites per run), fetches
  ECB exchange rates when a publication is due and some site has a currency, retries failed
  deliveries and purges old history, bounded per run.
  Deliveries are signed webhooks, Slack incoming webhooks, or email to the project's members
  through an optional `send_email` binding.
- **DO schema migrations.** `meta.schema_version` per DO: version 1 is the first release's schema
  (frozen); later versions run once, in a transaction, when a DO is next instantiated (columns added
  only if missing, new tables and indexes). D1 changes stay forward-only migrations.

## Tags

- **Browser side.** A container is a draft config (variables, triggers, tags, conversions,
  consent) plus immutable versions (published, or saved for later and for environments).
  `/c/:id.js` serves the browser runtime with the live config inlined (`?env=` an environment's
  pinned version, `?preview=` the draft or a version). The runtime comes in two bundles: the core
  one, and one with rarely used features (video and error triggers, wait-for-tags, cross-domain
  linking, TCF) that only containers using them get. Conversions fire client pixels with an
  `event_id`. The draft is edited whole or one item at a time (each write guarded by the
  revision it read), diffed against any version, and can be imported from Google Tag Manager
  (an export file, or the lists from the GTM API or its MCP server).
- **Scan.** `POST /v1/containers/:id/scan` fetches a few of the site's pages and reports the
  tags, pixels and other analytics and replay tools they load (only from scripts, never page
  text). The container keeps the last scan and the last import (`last_scan`, `last_import`),
  which the setup check's "Other tools" row reads.
- **Server side.** The runtime posts to `/collect`. The per-container Durable Object stores the
  visitor's click ids and identity, dedupes events, keeps a seven-day event log, and enqueues
  delivery. The queue consumer calls each platform's conversion API with the same `event_id`, so
  platforms count the conversion once, and writes each platform's answer back to the log. Just
  before sending, each destination's own transformations run (routing conditions, parameter
  allow/exclude/set, lookup tables kept in D1, webhook body templates). The Durable Object also
  keeps the preview log (what preview builds report: triggers matched, tags fired or not, and
  why), per-tag fire counts and page coverage.
- **Credentials** for destinations are sealed with AES-GCM (`ENCRYPTION_KEY`) and never returned.

## Mail

- **Receiving.** Email Routing sends every address on the mail domain to the Worker's `email()`
  handler. It parses the message, keeps the raw MIME and attachments in R2, stores the message and
  its extracted codes, links and authentication results in D1 (with FTS5 for search), and wakes
  any waiter parked on the inbox's Durable Object. `wait_for_email` therefore returns the moment
  mail lands, with no polling.
- **Sending** goes through the Email Service binding, from verified domains only. Shared-domain
  inboxes can be limited to replies (the account's own inboxes and its members' verified emails
  are always allowed). Mail to the account's own inboxes never leaves the Worker: it is written
  and stored directly. Sends take an `Idempotency-Key`; `send_at` schedules them on the inbox's
  Durable Object alarm.
- **Delivery status** comes from Cloudflare Email Sending events: a Queues event subscription per
  sending domain publishes delivered / deferred / bounced / failed / rejected / complained events,
  which the Worker's queue consumer matches to the sent message, per recipient.
- **Webhooks** are signed (own scheme and Standard Webhooks) and delivered through a queue with
  retries. The same events are kept for 7 days in an event feed (`GET /v1/events`, long-poll on a
  per-account Durable Object) for agents without a public URL.
- **Allow / block lists** are checked as soon as the headers are parsed, so refused mail is
  rejected during the SMTP session, before its body is read.
- **Forwarding to the project's people.** An inbox's `forward` setting (each email, a daily
  digest at a local hour, or off) sends its mail on to the Google-verified emails of the people who
  claimed the project, read from the identity database. Only mail from an authenticated sender is
  forwarded (no bounces, auto-replies or test mail). Each email goes right after the SMTP answer;
  the hourly cron sends digests and anything a daily budget held back. It has its own budget
  (`MAX_FORWARDS_PER_ACCOUNT_PER_DAY`), never the send limit, and the agent's key never sees the
  people's addresses.

## Why this storage

| Need | Choice | Why |
|---|---|---|
| Accounts, config, small relational data | D1 | SQL, migrations, cheap, global reads |
| A site's events, payments and annotations, a container's identities | Durable Object with SQLite | Strong consistency per entity, queries run next to the data, no shared hot spot |
| Raw mail, attachments, large bodies | R2 | Blobs, no egress fees |
| Delivery to third parties | Queues + dead-letter queue | Retries with backoff without blocking the request |
| Waking a waiting agent | Durable Object | Parks requests and resolves them when mail arrives |

## Limits to know about

- A Durable Object's SQLite store holds up to 10 GB. That's per site for analytics (raw events are
  kept `retention_days`, 400 by default) and per container for tags (a seven-day event log, visitor records kept 180 days after last seen).
- A D1 database holds up to 10 GB. Mail metadata and text bodies (capped per message) share one
  database per deployment; shared-domain retention and per-inbox caps keep it bounded.
- Email Routing accepts messages up to 25 MB, and Email Sending has per-account rate limits.
- The tags edge cache for `/c/:id.js` is 60 seconds, so a publish reaches every data center
  within a minute.

## Security model

- Everything outside a request's own account is invisible to it. Every query is scoped by
  `account_id` or an owned parent.
- Content from outside (email bodies, fetched web pages) is untrusted. MCP tools that return it
  say so, and the mail UI renders HTML in a sandboxed iframe with remote content blocked.
- Role addresses certificate authorities use (admin@, postmaster@, ...) can never be claimed.
- Public deployments turn on the fair-use vars (see [self-hosting.md](self-hosting.md)).
- Tokens of every kind (API keys, OAuth access and refresh tokens, codes, sessions, claim links)
  are stored as SHA-256 hashes only.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.
