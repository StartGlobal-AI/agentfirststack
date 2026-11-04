# AgentFirstStack

Infrastructure your agent sets up by itself: web analytics, tag management with server-side
conversion tracking, email inboxes and session replay. No signup form, no verification email, no dashboard to
click through. Free to use, and open source (MIT).

- Manual for agents: https://agentfirststack.com/llms.txt
- Registration and credentials: https://agentfirststack.com/auth.md
- Source: https://github.com/StartGlobal-AI/agentfirststack

## How it works

1. **Paste one prompt.** It tells your agent where the manual is.
2. **Your agent does the setup.** One request (`POST https://agentfirststack.com/v1/signup`) gets
   a key that works on every service. No email, password or verification.
3. **You approve what only you can.** Your ad accounts stay yours; the agent asks for the exact
   IDs and tokens it needs from Google Ads, Meta or TikTok, and tells you where to find them.
4. **Claim it when you like.** The agent gives you a claim link. Sign in with Google to see the
   project's sites, containers and inboxes in a dashboard, manage keys, invite teammates and
   connect Claude or ChatGPT (https://agentfirststack.com/mcp as a custom connector, over OAuth).

## Services

| Service | What it does | Instead of | Manual |
|---|---|---|---|
| Analytics | Countries, regions and cities from the edge; pages, sources and campaigns including AI assistants; goals, revenue, funnels, realtime; server-side events; no cookies | Google Analytics | https://analytics.agentfirststack.com/llms.txt |
| Tags | One snippet for every pixel; conversions sent from the browser and your server to GA4, Google Ads, Meta and TikTok with one event id, so each counts it once; click IDs kept; preview, publish, roll back | Google Tag Manager | https://tags.agentfirststack.com/llms.txt |
| Mail | Inboxes in one request; verification codes and links extracted; read, reply, send; your own domain; webhooks | A Gmail account per project | https://mail.agentfirststack.com/llms.txt |
| Replay | Session recordings masked in the browser by default; sessions as readable transcripts; rage, dead and error clicks; heatmaps and JS errors as data | Hotjar, Microsoft Clarity | https://replay.agentfirststack.com/llms.txt |

## MCP

One server for every service (tools prefixed `analytics_`, `tags_`, `mail_`, `replay_`):

```sh
claude mcp add --transport http afs https://agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"
```

Or one per service at `https://<service>.agentfirststack.com/mcp`.

## Prompt for your agent

```text
Set up AgentFirstStack for this project. Read https://agentfirststack.com/llms.txt first; it is
the complete manual. If .env already has AGENTFIRSTSTACK_API_KEY, use it; otherwise get a key with
POST https://agentfirststack.com/v1/signup and save it there. Then set up analytics, conversion
tracking and an inbox, verifying each step, and note what you set up in AGENTFIRSTSTACK.md (ids and
env var names, never key values). Ask me only for ad platform IDs and tokens. Finish with POST
https://agentfirststack.com/v1/claim-link and give me the claim link it returns. Tell me what you
set up and what still needs me.
```

## Free and open source

- Hosted: free, with fair-use limits listed in the manual.
- Self-host: `pnpm afs init <name> --domain example.com --account <id>` then `pnpm afs deploy <name>`.

## Guides and comparisons (for people)

All of them: https://agentfirststack.com/guides

- Add analytics with Claude Code: https://agentfirststack.com/guides/add-analytics-with-claude-code
- Server-side conversion tracking for Meta, Google Ads, TikTok and GA4: https://agentfirststack.com/guides/server-side-conversion-tracking
- Email inbox for AI agents: receive verification codes by API: https://agentfirststack.com/guides/email-inbox-for-ai-agents
- Session replay for AI agents: sessions as text, over an API: https://agentfirststack.com/guides/session-replay-for-ai-agents
- AgentFirstStack MCP servers and tools: https://agentfirststack.com/mcp
- Google Analytics MCP compared with AgentFirstStack: https://agentfirststack.com/google-analytics-mcp
- PostHog MCP compared with AgentFirstStack: https://agentfirststack.com/posthog-mcp
- Mixpanel MCP compared with AgentFirstStack: https://agentfirststack.com/mixpanel-mcp
- Google Tag Manager MCP compared with AgentFirstStack Tags: https://agentfirststack.com/google-tag-manager-mcp
- AgentMail alternative: inboxes your agent creates itself: https://agentfirststack.com/agentmail-alternative
- Gmail MCP: what it does, and when an agent needs its own inbox: https://agentfirststack.com/gmail-mcp
- Microsoft Clarity MCP: what it returns, and replay built for agents: https://agentfirststack.com/microsoft-clarity-mcp
