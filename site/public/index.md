# AgentFirstStack

Analytics, tag manager, email and session replay, set up by your AI agent. Like Google Analytics,
Google Tag Manager and Hotjar, plus email inboxes your agent can use. Paste one prompt and your coding
agent creates the account, adds everything to your site and checks it works. No signup form, no
verification email, no dashboard to click through. Free to use, and open source (MIT).

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

## What each service includes

All of it over REST and MCP, with the same key.

### Analytics (instead of GA4, Plausible or DataFast)

- **Tracking:** Cookieless by default, single-page and hash routing, custom events and properties (also from HTML attributes), outbound clicks, downloads, forms, 404s, scroll depth, engaged time, Core Web Vitals, site search, UTMs and ad click IDs, consent gating, cross-domain linking.
- **Server events:** An events API with a dry run, joined to browser visitors, with user properties.
- **Reports:** Stats, timeseries and comparisons, breakdowns by up to three dimensions, custom metrics, channel groups, realtime with a map, engagement rate, average order value, top movers, insights, CSV, one rollup across all your sites.
- **Filters:** Wildcards, nested and/or groups, saved segments, new or returning, did or didn't do an event, user properties, timezones.
- **Goals and funnels:** Goals that apply to past data, funnels in order or any order, with time windows and revenue per step.
- **People:** Visitors, a session list linked to replay, journeys, first touch, retention cohorts, path exploration, six attribution models.
- **Revenue:** Stripe in one call with 90 days of history, Polar, Paddle and LemonSqueezy, a payments API, one reporting currency, new and renewal revenue by source, page and campaign.
- **Subscriptions:** MRR, ARR and ARPU; new, expansion, contraction and churned MRR; churn and trial conversion, by channel, campaign, country or plan.
- **Ad spend:** Import costs per campaign for ROAS, CPA and CAC.
- **Ecommerce:** Items in each purchase, with revenue and quantity per product.
- **AI crawlers:** Which AI bots read which pages, never counted as visitors.
- **Querying:** Read-only SQL with cost limits, and a schema call that lists every event and property.
- **Import and export:** GA4 and Plausible CSV imports, raw events as NDJSON, CSV or JSON.
- **Sharing:** Public dashboards with a password, an expiry and a saved segment.
- **Alerts:** Spikes, drops, no data, goals and payments, plus weekly or monthly reports, by webhook, Slack or email.
- **Privacy:** Delete a visitor, purge with a dry run, email and phone redaction, path rules, exclusions, a referral-spam filter, Do Not Track and GPC.

### Tags (instead of Google Tag Manager)

- **Workflow:** A draft you edit item by item, diffs between versions, GTM import, a preview log, environments, versions and rollback.
- **Triggers:** Pageview, DOM ready, window loaded, consent initialization, clicks, forms, history changes, element visibility, scroll depth, timers, JavaScript errors, video, custom events, trigger groups.
- **Variables:** Data layer, URL parts, cookies, element attributes, lookup and regex tables, formatting, about 30 built-ins.
- **Tag options:** Priority, scheduling, sequencing, firing limits, consent per tag.
- **Browser tags:** GA4, Google Ads, Meta, TikTok, Snap, image pixels, custom HTML on verified domains.
- **Conversion APIs:** GA4, Google Ads, Meta, TikTok, LinkedIn, Pinterest, Reddit, Snap, X and webhooks, each counted once with the browser pixel.
- **Routing:** Per-platform conditions and parameter rules, test sends.
- **Consent and identity:** Consent Mode v2, TCF v2, hashed user data, cross-domain linking, a lookup store for values like margin by SKU.
- **Monitoring:** An event and delivery log, tag-fire stats, page coverage, retries and a circuit breaker.

### Mail (instead of AgentMail or a Gmail account)

- **Inboxes:** Instant inboxes on our domain or yours, plus-address tags, labels, usage limits you can read.
- **Waiting:** Wait for an email and get the verification code or link back, from authenticated senders only.
- **Reading:** Threads, search, raw email, attachments and their text, calendar invites, replies without the quoted history.
- **Sending:** Send, reply and forward, safe to retry, scheduled sending, delivery status per recipient.
- **Safety:** Inboxes on the shared domain reply only to people who wrote first; allow and block lists.
- **Domains:** Custom domains with DNS checks, send-only domains, a zone file to import.
- **Events:** Signed webhooks, and an event feed an agent can poll without a public URL.
- **Checks:** A deliverability report for any message: SPF, DKIM and DMARC.

### Replay (instead of Hotjar or Clarity)

- **Recording:** Text and inputs masked in the browser by default, selectors to unmask, mask or block, sampling.
- **Consent:** Consent only where the law asks (EEA, UK, Switzerland), Google Consent Mode, TCF v2, Do Not Track and GPC, IP exclusion.
- **Sessions:** Search, readable transcripts, summaries across many sessions, raw events, exports, a share-link player and clips.
- **Signals:** Rage, dead and error clicks, quick backs, excessive scrolling, JavaScript and console errors, failed requests, a frustration score.
- **Analysis:** Tags and identify, saved segments, trends, funnel drop-offs, events defined after the fact.
- **Heatmaps:** Click, scroll and attention maps by element or zone, comparisons, conversion share, PNG images.
- **Surveys:** Popovers, embedded surveys and a feedback tab: NPS, CSAT, CES, product-market fit and text, triggered on exit intent or after a rage click, each answer linked to its session.
- **Workflow:** Notes, labels, stars, signed webhooks, signals sent on to analytics and your tag container.
- **Privacy:** Delete or look up one visitor's data, recordings kept 14 days.

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
