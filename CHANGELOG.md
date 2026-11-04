# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Security

- **Pre-launch review** (two independent reviews of the whole codebase before the repo went public). Identity and control plane:
  - Creating a project while connecting an app over OAuth goes through the signup gate (`SIGNUP_MODE`, network and deployment-wide counts) plus `PROJECTS_PER_USER_DAILY_LIMIT` (default 5).
  - Keys made with a person's dashboard key are revoked when that person leaves; a connected app's token revokes only its own tokens; each OAuth refresh revokes the access tokens issued before it.
  - Signup refuses cross-site browser requests; claim links die with the key that asked for them; Google sign-in state is a `__Host-` cookie; OAuth redirect URIs can't point at the platform's own hosts.
  - Auth and account standing no longer fail open on database errors; internal calls can't change a suspended account.
  - Deploys turn off `workers.dev` and preview URLs (they'd skip the zone's WAF) and give `ADMIN_TOKEN` only to the site and mail. `deploy/hosted.json` is no longer in the repo.
- **Abuse and cost controls across the platform**, after a full audit of the free hosted service.
  - Account suspension (`pnpm afs suspend`), and lower `UNCLAIMED_*` caps for accounts no person has claimed.
  - Signup limits per network per day (IPv6 grouped by /48) and a deployment-wide hourly breaker; caps on API keys.
  - Daily budgets that never reset for analytics events, tags deliveries and events, replay sessions, chunks, bytes and derived rows, and mail inbound per sender; Workers rate-limit bindings in every app; Cloudflare edge rules on the hosted zone.
  - Replay requires a browser Origin and the page host, verifies domain ownership (snippet on the homepage or a `_afs-verify` TXT record) before more than a trial, purges through per-site alarms, masks more, and quotes transcript fields.
  - Tags: webhooks get matched conversions only, a circuit breaker per destination, the analytics destination is locked to the deployment's analytics, custom code needs a verified domain and a claimed account, and browser hits can no longer claim users or consent.
  - Tags: daily event budgets per account (`MAX_EVENTS_PER_ACCOUNT_PER_DAY`) and deployment-wide (`MAX_EVENTS_PER_DAY`, lower `UNCLAIMED_` value on the same counter), reported to D1 by each container's Durable Object at most once a minute (migration `tags/0007_event_budgets.sql`); past them `/collect` and backend events answer `429 quota_exceeded` until 00:00 UTC.
  - Tags: webhooks can't call any host of the platform (the apex the deployment's hosts share and every subdomain, IP literals and local names too) and their answers are summarized with anything key-like redacted; OAuth access tokens can't add destinations or change their URL or credentials (`403 temporary_credential`); domain proof counts only a real `<script src>` tag on the bare homepage; the Google Ads token cache is keyed by a hash of the full credentials.
  - Analytics: a stricter SQL guard with a query-plan cost bound, hostnames default to the site's domain, storage and retention bounds, opt-in browser revenue.
  - Replay: domain proof counts only a parsed `<script src>` tag (the loader, or the linked analytics tracker) on exactly `https://<domain>/`, which verify fetches itself; a `url` with a query string, fragment or other path never counts, and a loader URL in inline code or echoed text is reported, not accepted (a search page repeating `?s=/r/<id>.js` verified someone else's domain).
  - Analytics: payments, API and signed Stripe webhooks alike, count against the site's, account's and deployment's daily event budgets (an account picks its own signing secret; past them Stripe gets `429` and retries), and the Stripe delivery status is written at most every 5 seconds per site.
  - Analytics: `replay_site_id` is set only by the replay service over internal auth (`403 replay_link_from_replay` for API keys), so a site can't load another account's recorder.
  - Analytics and replay: OAuth access tokens can't create share links or connect Stripe (`403 temporary_credential`), since those outlive the token.
  - Analytics: share links need a verified domain: verify now proves it (the tracker in a `<script src>` tag on exactly `https://<domain>/`, or DNS TXT `_afs-verify.<domain>` = `afs-analytics-site=<id>`; migration `analytics/0009_domain_verification.sql`). Share pages name the verified domain, never the site's free-form name, say the numbers come from the site's own tracker, and show "Unverified site" after a domain change.
  - Mail: waits hibernate and are capped, attachments can't leak in R2, per-sender caps, `latest-code` trusts only authenticated mail from the exact domain, forged `Authentication-Results` and mailing lists no longer unlock replies.
  - Mail: extraction is linear on hostile HTML and text (no backtracking regex; at most 512 KB of each body is read), the per-sender cap runs on the headers before the body is parsed, the daily inbound quota counts only stored mail (in the commit, so killed or concurrent deliveries can't use it up), and unauthenticated mail shares one per-sender allowance; a stored-bytes cap per account (`MAX_BLOB_BYTES_PER_ACCOUNT`, default 1 GiB / 256 MiB unclaimed, `"0"` = off; `Mailbox full` at SMTP; `storage` in `GET /v1/inboxes`) with received attachments kept once and served from the raw MIME (migration `mail/0010_blob_storage.sql`); webhooks can't call the platform's own domain or subdomains and use `http://localhost` only with `DEV_MODE=true` (re-checked before each delivery); OAuth access tokens can't create webhooks (`403 temporary_credential`).
  - Site: removing a member revokes their keys and invites, OAuth tokens can't mint permanent keys, gateway batches are capped, an open redirect is fixed, and the session cookie is now `__Host-` prefixed (everyone signs in again once).

### Added

- **Guides and comparisons on the site** (`/guides`): how-to guides for analytics with Claude Code, server-side conversion tracking, agent inboxes and session replay, plus honest comparisons with the Google Analytics, PostHog, Mixpanel, Google Tag Manager, Gmail and Microsoft Clarity MCP servers and with AgentMail, each citing the other product's own docs. `/mcp` serves a page to browsers and stays the MCP endpoint for clients.
- **Technical SEO:** titles, descriptions, Open Graph and Twitter cards (generated by `scripts/og.mjs`), JSON-LD (Organization, WebSite, SoftwareApplication, SoftwareSourceCode, TechArticle, FAQPage, BreadcrumbList), `/.well-known/security.txt`, a generated sitemap (`scripts/sitemap.mjs`) and IndexNow (`scripts/indexnow.mjs`). Listed in the official MCP registry as `com.agentfirststack/*` (`site/mcp-registry/`).
- **Dogfooding:** agentfirststack.com runs its own analytics (cookieless, honours GPC/DNT) and session replay, disclosed on the privacy page.

- **Replay** ([replay/README.md](replay/README.md)), the fourth service: headless session replay at `replay.<domain>`.
  - A recorder (rrweb, lazy-loaded, about 29 KB gzipped) that masks all text, attributes and inputs in the browser by default, drops query strings, honours GPC and DNT and sets no cookies.
  - Sessions as readable transcripts, frustration signals (rage, dead and error clicks, quick backs, excessive scrolling, JS errors) with a 0-100 score, heatmaps, grouped JS errors and funnel drop-offs, all as data over REST and 19 MCP tools (`replay_` on the gateway).
  - Expiring share links to a human player; per-visitor deletion; retention purge by hourly cron.
  - The deploy tool creates its D1 database and R2 bucket (`<prefix>-replay`, `<prefix>-replay-chunks`) and maps R2 buckets per app.
  - No second snippet on analytics sites: linking a replay site to an analytics site (`analytics_site_id`) sets that site's new `replay_site_id`, and the analytics tracker loads the replay loader by itself (`r` in the `/e` answer, with the analytics var `REPLAY_BASE_URL`). Replay sites show `loads_with_analytics`; re-sending the same `analytics_site_id` repairs the link; verify accepts the linked analytics tracker on the homepage as domain proof. Migrations: analytics `0008_replay_link`, replay `0007_analytics_link`.
  - The dashboard lists replay sites next to sites, containers and inboxes, and offers a fourth build prompt: a session review screen (most frustrated sessions first, transcripts, JS errors, heatmaps, a Watch button through a share link).

- **Accounts for people, optional** ([docs/accounts.md](docs/accounts.md)). Agents still get a key with one request; nothing changes for them.
  - Sign in with Google (OIDC with PKCE, state and nonce) and sessions with CSRF-protected forms.
  - Claim links: `POST /v1/claim-link` and the MCP gateway tool `afs_create_claim_link` give the owner a single-use, 7-day link to claim the project an agent created.
  - Dashboard at `/dashboard`: projects with their sites, tag containers and inboxes, "Open analytics dashboard", API keys (create, revoke), members (invite, remove), rename, connected apps, import a project by key, delete my account.
  - OAuth 2.1 authorization server for MCP connectors (claude.ai, ChatGPT): RFC 8414 metadata, RFC 7591 dynamic registration, consent with a project picker, PKCE S256, rotating refresh tokens, RFC 7009 revocation. Access tokens are API keys that expire after 8 hours.
  - `/privacy` and `/terms` pages, and a "Sign in" link on the landing page.
- RFC 9728 metadata on every service host now lists the authorization server (`AUTH_ISSUER`), and every `/mcp` 401 sends `WWW-Authenticate: Bearer resource_metadata="..."`.
- Internal auth between a deployment's Workers (`INTERNAL_TOKEN`), used by the dashboard over service bindings.
- API keys can expire (`expires_at`); `GET /v1/keys` shows it. A daily cron on the site deletes expired keys, codes, sessions and claim links.
- `pnpm afs`: `init` generates `INTERNAL_TOKEN`, `deploy` sets it on every app and `GOOGLE_*` on the site, `config` sets `AUTH_ISSUER`, and `check` covers the OAuth metadata and claim links.
- Site integration tests.
- **Analytics, batch 1** (everything as REST and MCP, documented in `/llms.txt`):
  - Revenue attribution. A signed Stripe webhook per site (`POST /webhooks/stripe/:site_id`; `Stripe-Signature` verified with a 5 minute tolerance, event ids deduped, refunds subtracted, renewals marked) connected with `POST /v1/sites/:id/integrations/stripe` (signing secret sealed with `ENCRYPTION_KEY`), and `POST /v1/sites/:id/payments` for any other provider. Payments link to the visitor through `afsa.visitorId()` in checkout metadata or `client_reference_id`, a user id, or the customer's earlier payment. New metrics: `revenue_per_visitor`, `new_revenue`, `renewal_revenue`, `refunds`, `purchases`, `customers`, `purchase_rate`; `sort=revenue` (or any countable metric) on breakdowns. MCP: `connect_stripe`, `get_stripe_integration`, `disconnect_stripe`, `record_payments`, `list_payments`, `delete_payment`.
  - Visitors, sessions and journeys: `GET /v1/sites/:id/visitors`, `/visitors/:visitor`, `/sessions/:session_id`, `/journeys` (MCP `list_visitors`, `get_visitor`, `get_session`, `get_journeys`), with generated visitor names and an explicit note on cookieless identity limits.
  - Insights: `GET /v1/sites/:id/insights` (MCP `get_insights`): revenue share by device/OS/browser, daily averages, top revenue and converting sources and countries, days- and visits-to-convert histograms, first-visit conversion rate, median time to convert, top converting events, weekday x hour heatmap.
  - Comparisons: `compare=previous|year|custom` with `compare_from`/`compare_to` and `match_weekday` on stats, breakdown rows and timeseries buckets; `sort=change`; `GET /v1/sites/:id/movers` (MCP `get_top_movers`).
  - Annotations: CRUD (`/v1/sites/:id/annotations`, MCP `create_annotation`, `list_annotations`, `update_annotation`, `delete_annotation`), returned with every timeseries, plus automatic "Traffic spike from <source>" notes written by the daily alarm.
  - Ingest exclusions: IPs and CIDR ranges (v4 and v6, compared in memory, never stored), path globs, hostnames and countries (`exclusions` on the site), counted as `excluded_*` drops; `GET /v1/sites/:id/exclusions` (MCP `get_exclusions`) shows them and dry-runs an IP, URL or country.
  - Saved funnels: `/v1/sites/:id/funnels` CRUD (MCP `create_funnel`, `list_funnels`, `update_funnel`, `delete_funnel`; `get_funnel` takes `funnel_id`).
  - Tracker: max scroll depth and Core Web Vitals (LCP, INP, CLS) on the engagement beacon, opt-in `data-404="true"` and `data-forms="true"` events. Metrics `scroll_depth`, `time_on_page`, `lcp_p75`, `inp_p75`, `cls_p75`; scroll goals (`type: "scroll"`, `threshold`).
  - New vs returning visitors (`new_visitors`, `returning_visitors`) where identity allows.
  - verify reports exclusion drops, Stripe webhook delivery and unlinked payments.
  - Optional config: `ENCRYPTION_KEY` (secret), `MAX_ANNOTATIONS_PER_SITE`, `MAX_FUNNELS_PER_SITE`.

### Changed

- The setup prompt, `llms.txt`, `auth.md` and the setup skill now end with giving the owner a claim link.
- Analytics: stats and breakdowns return `revenue_per_visitor` by default; the new metrics are opt-in. `page` breakdown rows count revenue and conversions of the sessions that viewed the page. The tracker grew from 2.2 KB to 3.3 KB minified (1.8 KB gzip).
- In each service's `wrangler.jsonc`, `AUTH_DB` has its own placeholder database id, so local dev and tests keep the app DB and the identity DB apart, as deployments do. Run `pnpm db:migrate:local` again after pulling.

### Migrations

- Analytics `0008_replay_link.sql`, `0009_domain_verification.sql`; replay `0007_analytics_link.sql`; tags `0007_event_budgets.sql`; mail `0010_blob_storage.sql`.
- Identity DB (`site/migrations`): `0003_api_key_metadata.sql` (`api_keys.expires_at`, `oauth_grant_id`, `created_by_user_id`), `0004_users_oauth.sql` (users, memberships, sessions, claim links, OAuth clients, grants, codes, refresh tokens).
- App DBs: `analytics/0004`, `tags/0004`, `mail/0007` `_api_key_expiry.sql` (`api_keys.expires_at`, for standalone mode).
- Analytics D1: `0005_revenue_funnels_exclusions.sql` (`sites.exclusions`, `goals.threshold`, `funnels`, `integrations`).
- Analytics Durable Objects: schema version 2, applied by each site's DO on its next start (`events.revenue_type, scroll_depth, lcp, inp, cls`, `goals.threshold`, `payments`, `payment_links`, `provider_events`, `annotations`).

## [0.1.0] - 2026-11-03

First public release.

### Added

- **Analytics:**
  - Cookieless tracker (`/s.js`); edge enrichment (country, region, city, device, channel including AI assistants, UTM, click ids).
  - Server-side events, goals, revenue, funnels, realtime, read-only SQL, share dashboards, install verification.
- **Tags:**
  - Containers with draft, validate, preview, publish and rollback, and a GTM-compatible `dataLayer` runtime.
  - Conversions sent from the browser and from the server to GA4, Google Ads, Meta and TikTok with a shared event id.
  - Click id capture, site scan, conversion setup recipe, per-destination test events and event log.
- **Mail:**
  - Instant inboxes and wait-for-email with code and link extraction.
  - Read, search, reply and send; custom domains with DNS checks and webhooks.
- **MCP gateway:** one MCP endpoint, `agentfirststack.com/mcp`, exposing every service's tools (prefixed `analytics_`, `tags_`, `mail_`) with one key.
- **Agent discovery:**
  - robots.txt with AI crawler rules and Content Signals, plus a sitemap.
  - RFC 8288 Link headers, and Markdown for `Accept: text/markdown`.
  - `auth.md` and RFC 9728 protected resource metadata.
  - RFC 9727 API catalog, ARD `ai-catalog.json`, MCP server cards, an agent-skills index, and WebMCP tools on the landing page.
- **Platform:**
  - One-request signup with one key for every service; REST and stateless MCP for everything; `/llms.txt` manuals.
  - Fair-use controls for public deployments.
  - `pnpm afs` deployment tool.
