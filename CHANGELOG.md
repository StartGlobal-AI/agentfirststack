# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

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
