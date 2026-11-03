# Architecture

AgentFirstStack is four Cloudflare Workers that share one identity database. Each service is
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
  signup        (events,          ContainerDO    inbox (wait)  │
                sessions, SQL)    per container                │
                                  (identities,                 │
                                  event log)                   │
                                     │ Queue                   │ Queue (webhooks)
                                     ▼                         ▼
                       GA4 · Meta · Google Ads ·        customer webhooks,
                       TikTok · webhook · analytics     Email Sending (send_email)
     │              │              │              │
     └──── AUTH_DB: one D1 identity database (accounts, api_keys, signup_log) ────┘
           each app also has its own D1 (config) and mirrors account rows into it
```

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

Code: `shared/src/auth.ts`.

## One service layer, two interfaces

Every capability is a function in `<app>/src/service/`. REST routes (`src/routes/`) and MCP tools
(`src/mcp.ts`) are thin wrappers that parse input with zod and call it, so the two can't drift.
MCP is stateless Streamable HTTP (`handleMcp()` in `shared/src/mcp.ts`): a fresh server per
request, no sessions, no Durable Object. Tools that change state are registered with
`tools.write()` and are invisible to read-only keys.

Errors are always `{"error":{"code","message","hint","details"}}`. The hint tells the agent how to
recover.

The site also runs an **MCP gateway** at `/mcp` (`site/src/mcp-gateway.ts`): a stateless JSON-RPC
router that merges every service's tools with an `analytics_` / `tags_` / `mail_` prefix and
forwards each call over a service binding with the caller's own key, so one connector covers the
whole platform with the same scoping and errors as the services themselves.

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

## Tags

- **Browser side.** A container is a draft config (variables, triggers, tags, conversions,
  consent) plus immutable published versions. `/c/:id.js` serves the browser runtime with the
  live config inlined. Conversions fire client pixels with an `event_id`.
- **Server side.** The runtime posts to `/collect`. The per-container Durable Object stores the
  visitor's click ids and identity, dedupes events, keeps a seven-day event log, and enqueues
  delivery. The queue consumer calls each platform's conversion API with the same `event_id`, so
  platforms count the conversion once, and writes each platform's answer back to the log.
- **Credentials** for destinations are sealed with AES-GCM (`ENCRYPTION_KEY`) and never returned.

## Mail

- **Receiving.** Email Routing sends every address on the mail domain to the Worker's `email()`
  handler. It parses the message, keeps the raw MIME and attachments in R2, stores the message and
  its extracted codes, links and authentication results in D1 (with FTS5 for search), and wakes
  any waiter parked on the inbox's Durable Object. `wait_for_email` therefore returns the moment
  mail lands, with no polling.
- **Sending** goes through the Email Service binding, from verified domains only. Shared-domain
  inboxes can be limited to replies.
- **Webhooks** are signed and delivered through a queue with retries.

## Why this storage

| Need | Choice | Why |
|---|---|---|
| Accounts, config, small relational data | D1 | SQL, migrations, cheap, global reads |
| A site's events, a container's identities | Durable Object with SQLite | Strong consistency per entity, queries run next to the data, no shared hot spot |
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

See [SECURITY.md](../SECURITY.md) to report a vulnerability.
