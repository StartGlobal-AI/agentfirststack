<p align="center">
  <img src="site/public/favicon.svg" width="56" height="56" alt="">
</p>

<h1 align="center">AgentFirstStack</h1>

<p align="center">
  Analytics, tag management, email inboxes and session replay that an AI agent sets up by itself.<br>
  No signup form, no verification email, no dashboard to click through. Free to use, and open source.
</p>

<p align="center">
  <a href="https://agentfirststack.com">agentfirststack.com</a> ·
  <a href="https://agentfirststack.com/llms.txt">Manual</a> ·
  <a href="docs/self-hosting.md">Self-host</a> ·
  <a href="docs/architecture.md">Architecture</a>
</p>

<p align="center">
  <a href="https://github.com/StartGlobal-AI/agentfirststack/actions/workflows/ci.yml"><img src="https://github.com/StartGlobal-AI/agentfirststack/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSING.md"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0 license"></a>
</p>

---

Every new website needs the same infrastructure: analytics, a tag manager with conversion
tracking, and an email address to sign up for everything else. The usual tools all start with a
signup form, a verification email and a dashboard. Coding agents can't get past those steps alone.

AgentFirstStack is that infrastructure, rebuilt so an agent can do the whole job:

- **One request gets an account.** `POST /v1/signup` returns a key that works on every service.
- **Everything is an API call and an MCP tool.** Nothing is hidden behind a settings page.
- **The manual is a text file.** Each service serves `/llms.txt` with every endpoint, tool and field.
- **Every step can be verified.** The agent checks its own work instead of guessing.
- **Humans optional.** When it's done, the agent hands its person a claim link. They sign in with
  Google to see the project in a dashboard, manage keys and teammates, and connect Claude or
  ChatGPT over OAuth ([docs/accounts.md](docs/accounts.md)).

## Services

| | What it does | Instead of |
|---|---|---|
| **[Analytics](analytics/README.md)** | Cookieless web analytics. Country, region and city from Cloudflare's edge; channels including AI assistants; UTM and ad click ids; goals, revenue, funnels, realtime; server-side events; read-only SQL | Google Analytics, Plausible |
| **[Tags](tags/README.md)** | A tag manager and server-side conversion router. Define a conversion once; the browser pixel and the server both send it to GA4, Google Ads, Meta and TikTok with one event id, so each platform counts it once. Scan, validate, preview, test and publish | Google Tag Manager, server-side GTM |
| **[Mail](mail/README.md)** | Inboxes in one request. `wait_for_email` returns the moment a message arrives, with verification codes and links already extracted. Read, reply, send, custom domains, webhooks | A Gmail account per project, AgentMail |
| **[Replay](replay/README.md)** | Session recordings masked in the browser by default. Sessions come back as readable transcripts; rage, dead and error clicks, heatmaps and JS errors as data; a share link opens a player for people | Hotjar, Microsoft Clarity |

## Quick start

### Hosted (free)

Copy the prompt from [agentfirststack.com](https://agentfirststack.com) into Claude Code, Cursor,
Codex or any agent that can make HTTP requests. Or do it by hand:

```sh
curl -X POST https://agentfirststack.com/v1/signup
# { "api_key": "afs_...", "mcp": { ... }, "next_steps": [ ... ] }

curl -X POST https://analytics.agentfirststack.com/v1/sites \
  -H "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY" -H 'content-type: application/json' \
  -d '{"domain":"example.com"}'
```

Add one MCP server for every service (tools prefixed `analytics_`, `tags_`, `mail_`, `replay_`):

```sh
claude mcp add --transport http afs https://agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"
```

Or one per service:

```sh
claude mcp add --transport http afs-analytics https://analytics.agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"
claude mcp add --transport http afs-tags https://tags.agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"
claude mcp add --transport http afs-mail https://mail.agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"
claude mcp add --transport http afs-replay https://replay.agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"
```

The hosted version has fair-use limits, listed in the [manual](https://agentfirststack.com/llms.txt).

### Self-hosted

Everything runs on Cloudflare Workers in your own account:

```sh
git clone https://github.com/StartGlobal-AI/agentfirststack && cd agentfirststack
pnpm install
pnpm afs init mystack --domain example.com --account <cloudflare-account-id>
pnpm afs deploy mystack
CLOUDFLARE_API_TOKEN=... pnpm afs email mystack     # inbound + outbound mail
pnpm afs check mystack
```

See [docs/self-hosting.md](docs/self-hosting.md) for requirements, signup modes, limits and updates.

## How it's built

TypeScript on Cloudflare Workers with Hono and zod. Storage:

- **D1:** configuration and the shared identity database.
- **SQLite Durable Objects:** hot per-entity data (a site's events, a container's visitors, an inbox's waiters).
- **R2:** mail blobs and replay recording chunks.
- **Queues:** retried delivery to ad platforms and webhooks.
- **Email Routing and Email Sending:** mail in and out.

```
site/        landing page, platform manual, platform signup      agentfirststack.com
analytics/   web analytics                                        analytics.agentfirststack.com
tags/        tag manager + conversion APIs                        tags.agentfirststack.com
mail/        inboxes, sending, domains, webhooks                  mail.agentfirststack.com
replay/      session replay, signals, heatmaps, share player          replay.agentfirststack.com
shared/      @afs/shared: auth, signup, errors, MCP handler
scripts/     pnpm afs: the deployment tool
deploy/      deployment profiles (yours; the agentfirststack.com one is kept private)
docs/        architecture, self-hosting, operations, development
```

More in [docs/architecture.md](docs/architecture.md).

## Development

```sh
pnpm install
pnpm typecheck && pnpm test          # every package; integration tests run inside workerd
cd mail && pnpm db:migrate:local && pnpm dev
```

[docs/development.md](docs/development.md) covers running services locally, tests, and adding
endpoints, migrations and tag destinations. [docs/operations.md](docs/operations.md) covers
releases, migrations, secrets, monitoring and abuse handling for a running deployment.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it's short.
Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

The services are [AGPL-3.0](LICENSE); the browser scripts websites load (the analytics tracker, the tag manager runtime, the replay recorder and survey widget) are [MIT](LICENSE-MIT), so adding them to a site puts no obligations on it. Self-hosting is free either way; if you offer a changed version as a service, publish your changes. Details: [LICENSING.md](LICENSING.md). Built and hosted by [StartGlobal](https://startglobal.co).
