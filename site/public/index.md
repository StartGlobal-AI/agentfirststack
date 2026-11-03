# AgentFirstStack

Infrastructure your agent sets up by itself: web analytics, tag management with server-side
conversion tracking, and email inboxes. No signup form, no verification email, no dashboard.
Free to use, and open source (MIT).

- Manual for agents: https://agentfirststack.com/llms.txt
- Registration and credentials: https://agentfirststack.com/auth.md
- Source: https://github.com/StartGlobal-AI/agentfirststack

## How it works

1. **Paste one prompt.** It tells your agent where the manual is.
2. **Your agent does the setup.** One request (`POST https://agentfirststack.com/v1/signup`) gets
   a key that works on every service. No email, password or verification.
3. **You approve what only you can.** Your ad accounts stay yours; the agent asks for the exact
   IDs and tokens it needs from Google Ads, Meta or TikTok, and tells you where to find them.

## Services

| Service | What it does | Instead of | Manual |
|---|---|---|---|
| Analytics | Countries, regions and cities from the edge; pages, sources and campaigns including AI assistants; goals, revenue, funnels, realtime; server-side events; no cookies | Google Analytics | https://analytics.agentfirststack.com/llms.txt |
| Tags | One snippet for every pixel; conversions sent from the browser and your server to GA4, Google Ads, Meta and TikTok with one event id, so each counts it once; click IDs kept; preview, publish, roll back | Google Tag Manager | https://tags.agentfirststack.com/llms.txt |
| Mail | Inboxes in one request; verification codes and links extracted; read, reply, send; your own domain; webhooks | A Gmail account per project | https://mail.agentfirststack.com/llms.txt |

## MCP

One server for all three services (tools prefixed `analytics_`, `tags_`, `mail_`):

```sh
claude mcp add --transport http afs https://agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"
```

Or one per service at `https://<service>.agentfirststack.com/mcp`.

## Prompt for your agent

```text
Set up AgentFirstStack for this project. Read https://agentfirststack.com/llms.txt first; it is
the complete manual. Get an API key with POST https://agentfirststack.com/v1/signup, save it as
AGENTFIRSTSTACK_API_KEY, then set up analytics, conversion tracking and an inbox, verifying each
step. Ask me only for ad platform IDs and tokens. Tell me what you set up and what still needs me.
```

## Free and open source

- Hosted: free, with fair-use limits listed in the manual.
- Self-host: `pnpm afs init <name> --domain example.com --account <id>` then `pnpm afs deploy <name>`.
