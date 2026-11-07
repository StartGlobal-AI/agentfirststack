# AgentFirstStack: The Agent Infrastructure for GTM Teams

Analytics, a tag manager with server-side conversion tracking, email inboxes, AI search, page speed and
session replay. Your coding agent sets it all up from one prompt, checks every part works, and hands you
a dashboard. No signup form, no verification email, no dashboard to click through. Free to use, served
from your own domain, and open source (AGPL-3.0; the browser scripts are MIT).

- Live demo, our own analytics: https://agentfirststack.com/#live
- Manual for agents: https://agentfirststack.com/llms.txt
- As an agent skill: `npx skills add StartGlobal-AI/agentfirststack`
- Registration and credentials: https://agentfirststack.com/auth.md
- Source: https://github.com/StartGlobal-AI/agentfirststack

## How it works

1. **Paste one prompt.** It tells your agent where the manual is.
2. **Your agent does the setup.** One request (`POST https://agentfirststack.com/v1/signup`) gets
   a key that works on every service. No email, password or verification.
3. **You approve what only you can.** Your ad accounts stay yours; the agent asks for the exact
   IDs and tokens it needs from Google Ads, Meta or TikTok, and tells you where to find them.
4. **Claim it when you like.** The agent gives you a claim link. Sign in with Google to see the
   project's analytics, tags, replay and mail in a dashboard, manage keys, invite teammates and
   connect Claude or ChatGPT (https://agentfirststack.com/mcp as a custom connector, over OAuth).

## Services

| Service | What it does | Replaces | Manual |
|---|---|---|---|
| Web analytics | Countries, regions and cities from the edge; pages, sources and campaigns including AI assistants; goals, revenue, MRR, funnels, realtime; server-side events; no cookies | Google Analytics, Plausible, DataFast, Fathom | https://analytics.agentfirststack.com/llms.txt |
| Revenue and MRR | Payments from Stripe, Paddle, Polar and LemonSqueezy joined to the visit that brought them; MRR, ARR, churn and trial conversion by channel, campaign, country or plan (part of Analytics) | ChartMogul, Baremetrics, ProfitWell | https://analytics.agentfirststack.com/llms.txt |
| Tag manager | One snippet for every pixel and click event; triggers, variables, preview, versions and rollback; consent banner and Consent Mode v2 | Google Tag Manager, Cookiebot, CookieYes | https://tags.agentfirststack.com/llms.txt |
| Conversion tracking | Conversions sent from the browser and your server to GA4, Google Ads, Meta, TikTok, LinkedIn and more with one event id, so each counts it once; click IDs kept (part of Tags) | Server-side GTM, Stape, Meta CAPI Gateway | https://tags.agentfirststack.com/llms.txt |
| Email inboxes | Inboxes in one request; verification codes and links extracted; read, reply, send; your own domain; webhooks | A Gmail account per project, AgentMail, Mailinator | https://mail.agentfirststack.com/llms.txt |
| Session replay | Session recordings masked in the browser by default; sessions as readable transcripts; rage, dead and error clicks; heatmaps and JS errors as data | Hotjar, Microsoft Clarity, FullStory | https://replay.agentfirststack.com/llms.txt |
| Page speed | Core Web Vitals from real visitors, by page, device, country and browser, slowest pages first (part of Analytics) | PageSpeed Insights, Vercel Speed Insights, SpeedCurve | https://analytics.agentfirststack.com/llms.txt |
| AI search | Which AI bots read which pages, which assistants send visitors, and what to change so they cite you (part of Analytics) | AI crawler log digging, AI visibility trackers | https://analytics.agentfirststack.com/llms.txt |

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
- **Import and export:** History from GA4, Plausible, DataFast or any other tool (their CSV exports or API reports), a check that the numbers match, raw events as NDJSON, CSV or JSON.
- **Sharing:** Public dashboards with a password, an expiry and a saved segment.
- **Alerts:** Spikes, drops, no data, goals and payments, plus weekly or monthly reports, by webhook, Slack or email.
- **Privacy:** Delete a visitor, purge with a dry run, email and phone redaction, path rules, exclusions, a referral-spam filter, Do Not Track and GPC.

### Tags (instead of Google Tag Manager)

- **Workflow:** A site scan that finds the tags and tools already there, GTM import (an export or the GTM API), a draft you edit item by item, diffs between versions, a preview log, environments, versions and rollback.
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
- **Forwarding:** Each email, or a daily digest, to the people who claimed the project.
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
Set up AgentFirstStack for this project, completely, and verify it yourself. It's free, open-source infrastructure built for agents: web analytics, a tag manager with server-side conversion tracking, email inboxes and session replay. There is no signup form: one request gets a key, and you can do every step without me.

First, look at what this site uses today (Google Analytics, Google Tag Manager, Plausible, DataFast, ad pixels, any other analytics or replay tool) without changing anything. Then ask me once and wait for my answer: should email that reaches the project's inbox be forwarded to me as each one arrives, or as one daily digest (and at what time, in my time zone)? And if you found other tools: shall you bring their setup and history over, and if you need it to export their data, may you use my browser where I'm signed in? If I can't answer, forward each one as it arrives and bring over whatever needs no help from me.

1. Read https://agentfirststack.com/llms.txt and the Acceptable Use Policy (https://agentfirststack.com/acceptable-use), then follow the manual's "Full setup" section from start to finish. Read each service's manual before you use that service.

2. Key: if this project's .env already has AGENTFIRSTSTACK_API_KEY, use it, read AGENTFIRSTSTACK.md, and run the setup check (step 4) to see what earlier runs set up and what's missing. Otherwise run curl -X POST https://agentfirststack.com/v1/signup and save api_key in .env as AGENTFIRSTSTACK_API_KEY and in the production secrets. One key works for every service. If you support MCP, add the server the manual lists.

3. The full setup, in this order:
   - Map the site first: its main pages, every main button, link and form, and what counts as a sign-up, lead or purchase here.
   - Email: an inbox for the project, for any third-party signups the setup needs, forwarded to me the way I chose.
   - Analytics: the site, a goal for each conversion and main action, server events for what only the backend knows, AI crawler and search bot visits reported from the server (if the site has one), payments if the business takes them, and a weekly email report and alerts for me.
   - Tags: one container snippet on every page, an event for every main button, link and form (sent to analytics), and the conversions (also sent to the ad platforms this business uses). Preview, then publish.
   - Replay: linked to analytics, masked by default, asking for consent where the law requires it.
   - Serve all of it first-party, from the site's own domain, because ad blockers block third-party analytics hosts: a first-party domain (one DNS record: add it yourself if you can change the DNS, otherwise give it to me) or, until then or instead, the path proxy. The direct snippets only as a last resort.

4. Deploy, then test it end to end (the manual's step 8): run the setup test (POST https://agentfirststack.com/v1/setup/test, or afs_test_setup), do its browser plan in a real browser and check that visit (afs_check_test_visit), then run the setup check (GET https://agentfirststack.com/v1/setup, or afs_check_setup) until it says ready. Fix what fails and test again.

5. Apart from that first message, don't stop to ask me things. For ad accounts (Google Ads, Meta, GA4, TikTok): if you have tools for them, use them to find the IDs; otherwise finish everything else and list exactly which IDs and tokens you need from me, and where I find each.

6. Write what you set up in AGENTFIRSTSTACK.md at the repo root (ids, env var names, every goal and event and what triggers it; never key values), add the AgentFirstStack block from the manual to AGENTS.md (so later agent sessions see new features), and commit both.

7. Create a claim link with POST https://agentfirststack.com/v1/claim-link (or the afs_create_claim_link MCP tool) so I can see everything in a dashboard.

When you're done, show me the setup check's table of what's set up and the test results table, then what's waiting on me, and give me the claim link. If the site used other tools, say what you brought over from each, and leave them installed until I agree to remove them.
```

## Free and open source

- Hosted: free at any size within the fair-use limits: https://agentfirststack.com/limits
- Self-host: `pnpm afs init <name> --domain example.com --account <id>` then `pnpm afs deploy <name>`.

## Guides and comparisons (for people)

All of them: https://agentfirststack.com/guides

- Add analytics with Claude Code: https://agentfirststack.com/guides/add-analytics-with-claude-code
- Server-side conversion tracking for Meta, Google Ads, TikTok and GA4: https://agentfirststack.com/guides/server-side-conversion-tracking
- Email inbox for AI agents: receive verification codes by API: https://agentfirststack.com/guides/email-inbox-for-ai-agents
- Session replay for AI agents: sessions as text, over an API: https://agentfirststack.com/guides/session-replay-for-ai-agents
- Agent-first analytics: what it is, and what to ask of any tool: https://agentfirststack.com/agent-first-analytics
- The easiest way to add analytics to your app with an AI agent: https://agentfirststack.com/add-analytics-with-ai-agent
- The easiest platform for AI agents to use, measured: https://agentfirststack.com/easiest-platform-for-ai-agents
- Add analytics with Cursor: https://agentfirststack.com/guides/add-analytics-with-cursor
- Add analytics with OpenAI Codex: https://agentfirststack.com/guides/add-analytics-with-codex
- Add analytics with Windsurf (now Devin Desktop): https://agentfirststack.com/guides/add-analytics-with-windsurf
- Add analytics to a Lovable app with its AI agent: https://agentfirststack.com/guides/add-analytics-with-lovable
- Add analytics to a Replit app with Replit Agent: https://agentfirststack.com/guides/add-analytics-with-replit
- Add analytics to a v0 app with its AI agent: https://agentfirststack.com/guides/add-analytics-with-v0
- Add analytics to a Bolt app with its AI agent: https://agentfirststack.com/guides/add-analytics-with-bolt
- Next.js analytics in one prompt: https://agentfirststack.com/guides/nextjs-analytics
- Astro analytics in one prompt: https://agentfirststack.com/guides/astro-analytics
- WordPress analytics in one prompt: https://agentfirststack.com/guides/wordpress-analytics
- Shopify analytics in one prompt: https://agentfirststack.com/guides/shopify-analytics
- Webflow analytics in one prompt: https://agentfirststack.com/guides/webflow-analytics
- Google Ads conversion tracking with AgentFirstStack: https://agentfirststack.com/guides/google-ads-conversion-tracking
- Meta Conversions API with AgentFirstStack: https://agentfirststack.com/guides/meta-conversions-api
- Stape alternative: server-side conversion APIs without hosting server-side GTM: https://agentfirststack.com/stape-alternative
- Hotjar alternative: Contentsquare (formerly Hotjar) and AgentFirstStack Replay: https://agentfirststack.com/hotjar-alternative
- Umami alternative: open-source analytics an AI agent sets up: https://agentfirststack.com/umami-alternative
- AgentFirstStack MCP servers and tools: https://agentfirststack.com/mcp
- Google Analytics MCP compared with AgentFirstStack: https://agentfirststack.com/google-analytics-mcp
- PostHog MCP compared with AgentFirstStack: https://agentfirststack.com/posthog-mcp
- Mixpanel MCP compared with AgentFirstStack: https://agentfirststack.com/mixpanel-mcp
- Google Tag Manager MCP compared with AgentFirstStack Tags: https://agentfirststack.com/google-tag-manager-mcp
- AgentMail alternative: inboxes your agent creates itself: https://agentfirststack.com/agentmail-alternative
- Gmail MCP: what it does, and when an agent needs its own inbox: https://agentfirststack.com/gmail-mcp
- Microsoft Clarity MCP: what it returns, and replay built for agents: https://agentfirststack.com/microsoft-clarity-mcp
