# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

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
