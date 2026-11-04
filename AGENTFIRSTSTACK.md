# AgentFirstStack on agentfirststack.com

What the setup agent configured for this website (the `site/` app) on the hosted platform. Read
this first on every later run and update it instead of starting over. Never write key values here.

## Project and keys

- Project: `agentfirststack.com` (account `acct_gdvn0k6j90rzkcpz`), already claimed by its owner.
- Key: `AGENTFIRSTSTACK_API_KEY` in the repo root `.env` (git-ignored). Full access (`*`); it works on
  every service. It is not in the site's production secrets: nothing in the site needs it (the site
  Worker talks to the services over service bindings with `INTERNAL_TOKEN`).
- Dashboard: https://agentfirststack.com/dashboard (the owner signs in with Google).

| Service | Resource | Id |
|---|---|---|
| Analytics | site `agentfirststack.com` | `site_6hmh1a6dbbn8mdfp` |
| Tags | container `agentfirststack.com`, version 1 live | `ctr_6znmv02cawfa9pb9` |
| Replay | site `agentfirststack.com`, linked to the analytics site | `rsite_szw52yv28by1qy3b` |
| Mail | inbox `agentfirststack-signups@agentfirststack.com` | `inb_kn2pyr0nsx1zem8p` |

## The site map

- Pages (all static, `site/public/`): home `/`, `/guides` and four guides under `/guides/*`, the
  comparison pages (`/google-analytics-mcp`, `/google-tag-manager-mcp`, `/posthog-mcp`,
  `/mixpanel-mcp`, `/gmail-mcp`, `/agentmail-alternative`, `/microsoft-clarity-mcp`), `/mcp`,
  `/privacy`, `/terms`. The manual `/llms.txt` is plain text (no snippet).
- Private pages (`site/src/`: `/signin`, `/claim/*`, `/dashboard`) run no tracking, as the privacy page says.
- Forms: none on public pages. No thank-you pages. No checkout: the business takes no payments and
  runs no ads (no Stripe, no ad platforms).
- Conversions: the main one in the browser is copying the setup prompt. The sign-up is an agent
  creating a project with `POST /v1/signup` and the activation is a person claiming it with a
  claim link: only the backend sees those two.

## What is on every public page

In `<head>`, after the analytics snippet:

```html
<script>window.afsa=window.afsa||function(){(afsa.q=afsa.q||[]).push(arguments)}</script>
<script defer src="https://analytics.agentfirststack.com/s.js" data-site="site_6hmh1a6dbbn8mdfp"></script>
<script>if(!navigator.globalPrivacyControl&&navigator.doNotTrack!=="1")document.head.appendChild(Object.assign(document.createElement("script"),{async:true,src:"https://tags.agentfirststack.com/c/ctr_6znmv02cawfa9pb9.js"}))</script>
```

The tag container is loaded by that one-line loader instead of a plain `<script src>` because the
tags runtime doesn't honour Global Privacy Control / Do Not Track, and the privacy page promises
that nothing is recorded for those browsers (analytics and replay drop them themselves). The
replay recorder needs no snippet: the analytics tracker loads it (linked sites).

`app.js` and `content.js` no longer call `afsa("event","copy_prompt")`: the tag container sends
it, so a copy counts once. The two home copy buttons carry `data-cta="hero"` / `data-cta="closing"`.

## Events and goals

Every browser event is a click trigger in the tag container, sent to analytics by the container's
analytics tag (`send_to.analytics`, `server: false`: there are no destinations). Each has an
analytics goal of the same event name.

| Event (analytics name) | Fires on (CSS selector) | Props | Analytics goal |
|---|---|---|---|
| `copy_prompt` | `[data-copy], [data-copy-from]`: "Copy prompt for your agent" (home hero, home closing) and "Copy prompt" on every guide and comparison page | `location`: `hero`, `closing` or `page` | Copied setup prompt |
| `manual_click` | `a[href$='/llms.txt']`: Manual (nav, footer), Read the manual, service manuals | `link_url` (the link's href) | Opened the manual |
| `github_click` | `a[href^='https://github.com/']` (nav, footer) | | Clicked GitHub |
| `sign_in_click` | `a[href='/signin']` (nav) | | Clicked Sign in |
| `setup_prompt_click` | `a[href='/#setup']`: "Get the setup prompt" in guide sidebars | | Clicked Get the setup prompt |
| `guide_click` | `a[href^='/guides'], a[href$='-mcp'], a[href='/mcp'], a[href='/agentmail-alternative']` | `link_url` | Clicked a guide link |
| `nav_section_click` | `.nav-links a[href*='#']`: How it works, Services | `link_url` | Clicked a home section link |
| `show_prompt` | `[data-show-prompt]`: "Pasted prompt" in the home demo chat | | Showed the pasted prompt |
| `replay_demo` | `[data-replay]`: Replay button of the demo chat | | Replayed the demo |
| `email_click` | `a[href^='mailto:']`: Security, Report abuse, privacy@ | `link_text` | Clicked an email link |
| `signup` (server) | `POST /v1/signup` on agentfirststack.com answered 201 (`site/src/index.ts`) | `user_id` = the new project's id | Created a project (server) |
| `project_claimed` (server) | a claim link was used (`POST /claim/:token`, `site/src/claims.ts`); joined to the claimer's cookieless visit by IP + user agent; skipped for GPC / DNT browsers | `user_id` = project id, `role` | Claimed a project (server) |

Goals from earlier runs, kept: Read a guide (pageview `/guides/*`), Read an MCP comparison
(pageview `/*-mcp`), Scrolled the home page (scroll 75% of `/`).

Analytics also records `outbound_click` and `file_download` (llms.txt) on its own, and replay
forwards `rage_click`, `dead_click`, `error_click`, `js_error`, `quick_back` and `excessive_scroll`.

The two server events are sent by `site/src/own-analytics.ts` over the ANALYTICS service binding
(internal auth, no key) and are **off until the deployment sets** `OWN_ANALYTICS_ACCOUNT_ID` and
`OWN_ANALYTICS_SITE_ID` (see "Waiting on the owner"). Signups made on the service hosts
(`analytics.`, `tags.`, `mail.`, `replay.agentfirststack.com/v1/signup`) aren't counted.

## Tags container settings

- Consent: `mode: opt_in` with every storage type denied by default, so the runtime sets no
  cookies (`_afst_*`) and keeps no visitor profile; the analytics tag needs no consent. If an ad
  platform is added later, it needs a consent banner calling `afst('consent','update',...)`.
- `report_tag_fires: true` (tag-stats, coverage), `send_page_views: false` (no landing identity
  hit: nothing to attribute without ad platforms).
- Variables: `cta` (`data-cta` attribute), `link_href` (the clicked link's `href` as written, so a
  page's own query string never lands in a prop).
- Its event log keeps each click with the visitor's IP, user agent and location for 7 days.

## Replay settings

`mask_mode: strict` (all text and inputs masked in the browser), unmasked: `nav, button, a, h1, h2,
h3, label, summary`. `require_consent: "eea"`: visitors from the EU, EEA, UK and Switzerland are
recorded only after `afsr('consent', true)`, which these pages never call (no banner), so they
aren't recorded. Retention 14 days. To turn replay off:
`PATCH https://replay.agentfirststack.com/v1/sites/rsite_szw52yv28by1qy3b {"enabled": false}`.

## For the owner (analytics)

- Email destination `dst_kmjapbretcwcs87h` (every member of the project).
- Weekly report `rpt_faxabbmqsx8hqmvc`: Mondays 08:00 UTC, the previous 7 days.
- Alerts: Traffic drop `alr_sdzwk2t5gr7tbeer`, Tracking stopped (no data for 12 h)
  `alr_p8xnvvgmgnj9kwv3`, Traffic spike `alr_4yaaeamdd3vqd3sf`.

## Waiting on the owner

- Turn on the server events: add to `deploy/hosted.json` under `vars.site`
  `"OWN_ANALYTICS_ACCOUNT_ID": "acct_gdvn0k6j90rzkcpz"` and `"OWN_ANALYTICS_SITE_ID": "site_6hmh1a6dbbn8mdfp"`,
  then `pnpm afs deploy hosted site`.
- Ad platforms: none today. If ads start, give the IDs and tokens in llms.txt section 5 and add
  a consent banner.

## Checking it

- Analytics: `POST /v1/sites/site_6hmh1a6dbbn8mdfp/verify`; goals with
  `GET /v1/sites/site_6hmh1a6dbbn8mdfp/stats?period=7d&breakdown=goal`.
- Tags: `GET /v1/containers/ctr_6znmv02cawfa9pb9/events?since=1h`, `/tag-stats?since=7d`.
- Replay: `POST /v1/sites/rsite_szw52yv28by1qy3b/verify`; test sessions are labelled `agent-setup-test`.
- Test clicks in a browser: run `afsa('debug')` first, so they stay out of reports.
