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

Code: `shared/src/auth.ts`, `shared/src/resource.ts` (RFC 9728 metadata).

## People and OAuth (optional)

Agents never need any of this; see [accounts.md](accounts.md) for the full design. It all lives in
the site Worker and the identity database (`site/migrations/0003_*`, `0004_*`).

- **Users** sign in with Google (OIDC, PKCE, state, nonce; the ID token comes from the direct token
  response). A session is a random cookie (`afs_session`, HttpOnly, Secure, SameSite=Lax, apex
  only) of which only the SHA-256 is stored; it lasts 30 days, sliding. CSRF tokens are derived
  from the cookie value, so they're never stored.
- **Memberships** link users to accounts ("projects") as owner or member. Every dashboard route
  looks the membership up first; a non-member gets a 404.
- **Claim links** (`POST /v1/claim-link`, the gateway tool `afs_create_claim_link`) are single-use,
  7-day tokens a full-access key can mint, so the person behind an agent can claim its project.
- **Dashboard** (`/dashboard`): server-rendered HTML without JavaScript, `frame-ancestors 'none'`,
  every form a POST with a CSRF token. Resource lists come from the services over their service
  bindings with internal auth.
- **OAuth 2.1 server** for MCP connectors: RFC 8414 metadata, dynamic registration of public
  clients, consent with a project picker, PKCE S256, exact redirect URIs, single-use 10-minute
  codes, `iss` on the redirect, rotating refresh tokens (reuse revokes the grant). Access tokens
  are API keys with `expires_at`, so no service knows OAuth exists. Every service's RFC 9728
  metadata names the site (`AUTH_ISSUER`) and every `/mcp` 401 points at that metadata.
- A daily cron on the site deletes expired keys, codes, refresh tokens, sessions and claim links.

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
covers the whole platform with the same scoping and errors as the services themselves. It adds two
tools of its own: `afs_check_setup` (`GET /v1/setup`), `afs_test_setup` and `afs_check_test_visit`
(`/v1/setup/test`), `afs_create_claim_link` and `afs_update_project` (`PATCH /v1/me`).

The **setup check** (`site/src/setup-check.ts`, `GET /v1/setup`) is the full setup in `llms.txt` as a
list of checks. It reads each service as the project with internal auth over the bindings (the
same path the dashboard uses), never forwards the caller's key and fetches nothing from the
website: install status comes from what the services received and from the last `verify`. The
dashboard's project page renders the same report.

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
  imported GA4 / Plausible aggregates (`imports`, `imported_rows`, merged into unfiltered reports
  for days before live data), and the raw export's daily counter.
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
  revision it read), diffed against any version, and can be imported from a GTM container
  export.
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
