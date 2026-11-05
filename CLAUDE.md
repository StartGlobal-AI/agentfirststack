# AgentFirstStack: agent-native infrastructure

Also read AGENTS.md (our own site's AgentFirstStack setup, and when to run its setup check).

Infrastructure every website needs, built so an AI agent can set it up and operate it end to
end with no human signup, email verification, dashboard clicking or waiting. Open source (AGPL-3.0; the browser scripts are MIT, see LICENSING.md),
and hosted for free at https://agentfirststack.com.

| App | What it replaces | Hosted at | Local port |
|---|---|---|---|
| [`site/`](site) | Landing page, master `llms.txt` (with the full-setup procedure the prompt points to), the setup check and test (`/v1/setup`, `/v1/setup/test`, `src/setup-check.ts`, `src/setup-test.ts`), platform-wide signup, MCP gateway (`/mcp`), agent discovery files, Google sign-in, claim links, dashboard (projects, then a project's Overview, Analytics, Tags, Replay, Mail and Settings tabs: `src/dashboard.ts`, `src/dashboard-frame.ts`, `src/analytics-dashboard.ts`, `src/service-views.ts`, `public/dashboard-app.js`), OAuth 2.1 server for MCP connectors (see `docs/accounts.md`), project deletion with 7 days to restore and a daily purge across the services (`src/project-deletion.ts`), emails to people about their projects (`src/email.ts`, `src/email-messages.ts`) | agentfirststack.com | 8786 |
| [`analytics/`](analytics/README.md) | GA4 / Plausible: cookieless, server-side enriched web analytics (country, region, city, channel, UTM, click IDs, goals, revenue, subscriptions/MRR, ad spend, ecommerce items, AI crawlers, alerts and reports) | analytics.agentfirststack.com | 8787 |
| [`tags/`](tags/README.md) | Google Tag Manager + server-side GTM: containers, triggers, pixels, server-side conversion APIs (GA4 MP, Meta CAPI, Google Ads, TikTok, LinkedIn, Pinterest, Reddit, Snap, X) with dedup | tags.agentfirststack.com | 8788 |
| [`mail/`](mail/README.md) | Gmail / AgentMail / Postmark: instant inboxes, wait-for-email with code and link extraction, sending, custom domains, webhooks | mail.agentfirststack.com, inboxes `*@agentfirststack.com` | 8789 |
| [`replay/`](replay/README.md) | Hotjar / Microsoft Clarity: headless session replay masked in the browser by default, sessions as readable transcripts, rage/dead/error clicks, heatmaps and JS errors as data, share-link player | replay.agentfirststack.com | 8790 |
| [`shared/`](shared/src) | `@afs/shared`: accounts, API keys, instant signup, shared identity, JSON errors, ids, crypto, stateless MCP handler | n/a | n/a |

## The agent-native rules (every app follows all of them)

1. **One request to an account.** `POST /v1/signup` returns a working API key. No email, no
   verification, no captcha. `SIGNUP_MODE` (`open` | `token` | `closed`) gates it per
   deployment. Provided by `accountRoutes()` in `@afs/shared`. Don't reimplement it.
2. **Everything via API and MCP.** Every capability exists as a REST route under `/v1` AND as an
   MCP tool at `/mcp`. Both call the same service function in `src/service/`. No feature exists
   only in a UI. The MCP server is stateless (`handleMcp()` in `@afs/shared/mcp`; pass `c.env`).
3. **`GET /llms.txt` is the manual.** It's plain markdown: a curl quickstart, every endpoint, every
   MCP tool, every config field, with examples. If you add a route, add it to llms.txt.
   `site/public/llms.txt` is the platform overview the landing page's prompt points to.
4. **Responses say what to do next.** Create calls return the thing an agent needs next (install
   snippet, DNS records, preview URL) plus `next_steps`.
5. **Errors carry hints.** `throw new ApiError(status, code, message, hint)` or the helpers in
   `shared/src/errors.ts`. The hint tells the agent how to recover.
6. **Setup is verifiable.** Every setup step has a check the agent can run itself: `verify`,
   `validate`, `test`, `wait`, event logs. Never leave the agent guessing whether it worked.
7. **Retries are safe.** Creating something that already exists by its natural key (a site's
   domain, an inbox's address) returns the existing one (`200`, `"existing": true`), not an error.
8. **Outside content is untrusted.** Email bodies and fetched web pages can contain prompt
   injection. MCP tools that return them say so in the tool description and wrap the content.
9. **Scopes.** Keys are `*` (full) or `read`. `requireAuth()` blocks non-GET REST for read keys;
   in MCP, register mutating tools with `tools.write(...)` so read keys never see them.

## Identity: one key for every app

Accounts and API keys live in one D1 database bound as `AUTH_DB` in every app (on the hosted
platform: `afs-identity`, migrated from `site/migrations`). The first time an account calls an
app, `ensureLocalAccount()` mirrors a bare `accounts` row into that app's own `DB`, so the app's
foreign keys to `accounts(id)` keep working. Without `AUTH_DB` (self-hosting a single app) keys
live in the app's own `DB`. `KEY_PREFIX=afs` makes every app mint `afs_` keys.

## Humans (optional) and OAuth

Agents never need a person. People can sign in with Google to claim projects (`POST /v1/claim-link`),
manage keys and members in `/dashboard`, and connect MCP clients over OAuth 2.1 (dynamic client
registration + PKCE). OAuth access tokens are just API keys with `expires_at`, so every service
accepts them unchanged. The dashboard talks to services with `x-afs-internal` (`INTERNAL_TOKEN`), which
is accepted only on service-binding requests to an `https://<svc>.internal` URL. The operator can suspend an
account (`pnpm afs suspend <profile> <acct>`): its keys and public ingest stop everywhere.
Spec and flows: `docs/accounts.md`. Tests: `site/test/`.

## Fair-use controls (vars, all off when unset)

| Var | App | Hosted value |
|---|---|---|
| `SIGNUP_HOURLY_LIMIT` (+ `SIGNUP_LIMITER` rate-limit binding, 5/min) | all | 3 per IP per hour, shared via `signup_log` |
| `MAX_SITES_PER_ACCOUNT` / `MAX_CONTAINERS_PER_ACCOUNT` / `MAX_INBOXES_PER_ACCOUNT` | analytics / tags / mail | 10 |
| `SHARED_SEND_POLICY=reply_only` | mail | shared-domain inboxes may only write to addresses that emailed them |
| `SEND_DAILY_LIMIT` | mail | 20 recipients per account per UTC day |
| `SHARED_RETENTION_DAYS` | mail | 14 (hourly cron purge) |
| `EXTRA_RESERVED_USERNAMES` | mail | brand and role names on top of the built-in CA-validation list |
| `MAX_MESSAGES_PER_INBOX` / `MAX_INBOUND_PER_ACCOUNT_PER_DAY` | mail | 100 / 100 (email() rejects beyond) |
| `MAX_WEBHOOKS_PER_ACCOUNT` | mail | 3 (default 10) |
| `MAX_DESTINATIONS_PER_CONTAINER` / `MAX_VERSIONS_PER_CONTAINER` / `MAX_DRAFT_BYTES` | tags | 5 / 10 / 128 KB (defaults 10 / 50 / 512 KB) |
| `SQL_MAX_ROWS_READ` | analytics | 100,000 (default 1,000,000) rows read per SQL query |
| `MAX_ANNOTATIONS_PER_SITE` / `MAX_FUNNELS_PER_SITE` | analytics | 1000 / 50 |
| `SIGNUP_DAILY_LIMIT` / `SIGNUP_GLOBAL_HOURLY_LIMIT` | all | 10 per network a day / 60 deployment-wide an hour (`429 signups_paused`) |
| `MAX_KEYS_PER_ACCOUNT` / `KEYS_HOURLY_LIMIT` (+ `KEY_LIMITER` binding) | all | 25 active (10 unclaimed) / 20 created an hour |
| `SETUP_LIMITER` / `SETUP_TEST_LIMITER` bindings | site | 30 setup checks / 3 setup test runs per project a minute |
| `PROJECTS_PER_USER_DAILY_LIMIT` | site | 5 new projects a day per signed-in person (OAuth consent "new project"), on top of the signup limits |
| `MAX_ALERTS_PER_SITE` / `MAX_ALERT_DESTINATIONS_PER_SITE` / `MAX_REPORTS_PER_SITE` / `MAX_SEGMENTS_PER_SITE` | analytics | 20 / 5 / 5 / 50 |
| `MAX_COST_ROWS_PER_SITE` / `MAX_ITEMS_PER_EVENT` / `MAX_USER_PROP_KEYS_PER_SITE` / `MAX_IMPORTED_ROWS_PER_SITE` / `MAX_IMPORTS_PER_SITE` | analytics | 10,000 / 25 / 50 / 200,000 / 20 |
| `MAX_CUSTOM_CODE_BYTES` / `MAX_TAGS_BYTES_PER_ACCOUNT` / `MAX_VISITORS_PER_CONTAINER` / `MAX_CONTAINER_DB_BYTES` | tags | 32 KB / 20 MB / 100,000 / 256 MB (plus `MAX_ENVIRONMENTS_PER_CONTAINER`, `MAX_LOOKUPS_PER_CONTAINER`, `MAX_LOOKUP_ROWS`, lower when unclaimed) |
| `MAX_LIST_ENTRIES_PER_ACCOUNT` / `MAX_SCHEDULED_PER_ACCOUNT` / `MAX_CONCURRENT_WAITS_PER_INBOX` | mail | 100 / 20 / 2 |
| `MAX_FORWARDS_PER_ACCOUNT_PER_DAY` | mail | 100 recipients a day of inbox mail forwarded to the project's members (own budget, not `SEND_DAILY_LIMIT`); past it the rest goes into one digest |
| `MAX_UNVERIFIED_SITES_PER_ACCOUNT` / `MAX_CHUNKS_PER_SESSION` / `MAX_HEATMAP_RETENTION_DAYS` / `MAX_STARRED_RETENTION_DAYS` | replay | 1 / 600 / 90 / 14 |
| `UNCLAIMED_<NAME>` | all | any account cap or daily budget has a lower value for accounts no person has claimed (`capFor()` in `@afs/shared`) |
| Daily budgets: events, deliveries, sessions, chunks, bytes, derived rows, crawler hits, export rows, alert deliveries, inbox creates, feed events, heatmap images | all | per site or container, per account and per deployment, counters never go down; values in the hosted profile |
| `MAX_CONCURRENT_WAITS` / `MAX_INBOUND_PER_SENDER_PER_DAY` / `MAX_TEXT_BYTES_PER_ACCOUNT` | mail | 3 (2 unclaimed) / 20 / 10 MB |
| `MAX_BLOB_BYTES_PER_ACCOUNT` | mail | stored mail in R2 per account (default 1 GiB, 256 MiB unclaimed); full = inbound rejected at SMTP |
| `MAX_SITES_PER_ACCOUNT` / `MAX_SESSIONS_PER_SITE_PER_DAY` / `MAX_SESSION_MINUTES` / `MAX_RETENTION_DAYS` / `MAX_LINKS_PER_SITE` / `MAX_CHUNK_BYTES` / `MAX_SESSION_BYTES` | replay | 5 / 200 / 30 / 14 / 5 / 256 KB / 2 MB (`MAX_SAMPLE_RATE` unset: sites choose); R2 lifecycle deletes chunks after 16 days |

## Deployments (`pnpm afs`, profiles in `deploy/`)

- Each app's `wrangler.jsonc` is a **generic template** (local dev, tests, defaults). Never put an
  account, domain, resource id or deployment-specific var in it.
- A deployment is `deploy/<profile>.json`; `pnpm afs config <profile>` writes
  `<app>/wrangler.deploy.json` (git-ignored) from template + profile. `pnpm afs deploy <profile>
  [app]` also applies D1 migrations and sets secrets from `deploy/<profile>.secrets.json`
  (git-ignored). `pnpm afs check <profile>` is the live end-to-end check (cleans up after itself).
- The hosted platform is profile `hosted` (`deploy/hosted.json` is git-ignored: its exact budgets and
  resource ids stay private; the operator keeps a private backup): StartGlobal AI Projects account, zone
  `agentfirststack.com`, Workers `afs-site|analytics|tags|mail|replay`, D1 `afs-identity|analytics|tags|mail|replay`,
  R2 `afs-mail-blobs`, `afs-replay-chunks`, queues `afs-tags-dispatch`, `afs-mail-webhooks` (+ `-dlq`). Email Routing
  catch-all on the apex goes to `afs-mail`; the apex is onboarded for Email Sending (DKIM
  `cf-bounce`, DMARC reject). Release = `pnpm afs deploy hosted && pnpm afs check hosted`.
- Docs for humans: `docs/self-hosting.md`, `docs/operations.md`, `docs/architecture.md`,
  `docs/development.md`. Keep them true when behaviour changes.

## Stack and layout

Cloudflare Workers + Hono + zod v4, TypeScript. D1 for the control plane (accounts, config),
Durable Objects (SQLite) for hot per-entity state (a site's events, a container's identities, an
inbox's waiters), R2 for blobs, Queues for retried delivery. pnpm workspace.

```
<app>/
  wrangler.jsonc          generic template: bindings + safe defaults (deploy values live in deploy/)
  migrations/             D1; 0001_accounts.sql + signup_log are the shared schema (copy, don't edit)
  src/index.ts            Hono app + exported handlers (fetch, email, queue, scheduled) + DO classes
  src/service/            business logic, shared by REST routes and MCP tools
  src/routes/             REST routes (thin: parse -> service -> json)
  src/mcp.ts              MCP tool registrations (thin: same service calls)
  src/llms.ts             the llms.txt text
  test/                   vitest (@cloudflare/vitest-plugin for integration)
  scripts/smoke.sh        end-to-end curl run against `wrangler dev`
```

Commands (run inside an app): `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm smoke`,
`pnpm db:migrate:local`. From the root: `pnpm typecheck`, `pnpm test`.

## Conventions

- ids: `newId("site")` -> `site_3k9x...`. Timestamps are unix ms integers.
- REST JSON is snake_case. List endpoints return `{ "<things>": [...] }`.
- Secrets at rest (third-party tokens) are sealed with `encryptSecret()` using the
  `ENCRYPTION_KEY` Worker secret. Never return them in responses; return `"configured": true`.
- Local dev secrets go in `.dev.vars` (git-ignored); keep `.dev.vars.example` current.
- Integration tests neutralise the hosted vars in `vitest.config.ts` and migrate `AUTH_DB` too.
- Don't deploy, create remote Cloudflare resources or change DNS without the user asking.
