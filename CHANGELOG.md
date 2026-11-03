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

### Changed

- The setup prompt, `llms.txt`, `auth.md` and the setup skill now end with giving the owner a claim link.
- In each service's `wrangler.jsonc`, `AUTH_DB` has its own placeholder database id, so local dev and tests keep the app DB and the identity DB apart, as deployments do. Run `pnpm db:migrate:local` again after pulling.

### Migrations

- Identity DB (`site/migrations`): `0003_api_key_metadata.sql` (`api_keys.expires_at`, `oauth_grant_id`, `created_by_user_id`), `0004_users_oauth.sql` (users, memberships, sessions, claim links, OAuth clients, grants, codes, refresh tokens).
- App DBs: `analytics/0004`, `tags/0004`, `mail/0007` `_api_key_expiry.sql` (`api_keys.expires_at`, for standalone mode).

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
