# AgentFirstStack on agentfirststack.com

What the setup agent configured for this website (the `site/` app) on the hosted platform. Read
this first on every later run and update it instead of starting over. Never write key values here.

## Project and keys

- Project: `agentfirststack.com` (account `acct_gdvn0k6j90rzkcpz`), already claimed by its owner.
- Key: `AGENTFIRSTSTACK_API_KEY` in the repo root `.env` (git-ignored). Full access (`*`); it works on
  every service. It is not in the site's production secrets: nothing in the site needs it (the site
  Worker talks to the services over service bindings with `INTERNAL_TOKEN`).
- Dashboard: https://agentfirststack.com/dashboard (the owner signs in with Google).
- MCP: one server for every service, `https://agentfirststack.com/mcp` (238 tools on 2026-11-05).
  The setup agent uses REST and has not added it to any MCP client config; to add it to Claude
  Code: `claude mcp add --transport http afs https://agentfirststack.com/mcp --header "Authorization: Bearer $AGENTFIRSTSTACK_API_KEY"`.

| Service | Resource | Id |
|---|---|---|
| Analytics | site `agentfirststack.com` | `site_6hmh1a6dbbn8mdfp` |
| Tags | container `agentfirststack.com`, version 2 live | `ctr_6znmv02cawfa9pb9` |
| Replay | site `agentfirststack.com`, linked to the analytics site | `rsite_szw52yv28by1qy3b` |
| Mail | inbox `agentfirststack-signups@agentfirststack.com` | `inb_kn2pyr0nsx1zem8p` |

## The site map

- Pages (all static, `site/public/`): home `/`, `/guides` and four guides under `/guides/*`, the
  comparison pages (`/google-analytics-mcp`, `/google-tag-manager-mcp`, `/posthog-mcp`,
  `/mixpanel-mcp`, `/gmail-mcp`, `/agentmail-alternative`, `/microsoft-clarity-mcp`), `/mcp`,
  `/privacy`, `/terms`. The manual `/llms.txt` is plain text (no snippet).
- Private pages (`site/src/`: `/signin`, `/claim/*`, `/dashboard`) run no tracking, as the privacy page says.
- Links out: the nav and footer GitHub links (repo, license) are this project's; the comparison
  pages and one guide also link to other GitHub repos and to vendor docs, which analytics counts as
  `outbound_click` only. In-page contents links on guides (`#faq`, `#related`, ...) aren't events.
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
<script async src="https://tags.agentfirststack.com/c/ctr_6znmv02cawfa9pb9.js"></script>
```

The tag container is the plain snippet: with its `settings.respect_dnt` (the default) the runtime
does nothing in a browser that sends Global Privacy Control or Do Not Track, as the privacy page
promises (analytics and replay drop those browsers too). New pages built from
`site/templates/page.html` get both snippets. The replay recorder needs no snippet: the analytics
tracker loads it (linked sites).

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
| `github_click` | `a[href^='https://github.com/StartGlobal-AI/']`: this project's repo (nav, footer) and license (footer) | `link_url` | Clicked GitHub |
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
(internal auth, no key). They are on: `deploy/hosted.json` sets `OWN_ANALYTICS_ACCOUNT_ID` and
`OWN_ANALYTICS_SITE_ID` under `vars.site`, live since the site deploy of 2026-11-05 (Worker version
`9be8241c`). The first real ones arrive with the next project created or claimed on agentfirststack.com. Signups made on the service hosts
(`analytics.`, `tags.`, `mail.`, `replay.agentfirststack.com/v1/signup`) aren't counted.

## Tags container settings

- Consent: `mode: opt_in` with every storage type denied by default, so the runtime sets no
  cookies (`_afst_*`) and keeps no visitor profile; the analytics tag needs no consent. If an ad
  platform is added later, it needs a consent banner calling `afst('consent','update',...)`.
- `report_tag_fires: true` (tag-stats, coverage), `send_page_views: false` (no landing identity
  hit: nothing to attribute without ad platforms).
- Variables: `cta` (`data-cta` attribute), `link_href` (the clicked link's `href` as written, so a
  page's own query string never lands in a prop).
- Its event log keeps each click for 7 days with a shortened network (/24 or /48), country, region
  and device type, never the raw IP, user agent or city.

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

- Nothing is required. Optional: a backup key in the owner's password manager (the setup agent was
  told not to create keys; the owner can make one in the dashboard).
- Ad platforms: none today. If ads start, give the IDs and tokens in llms.txt section 5 and add
  a consent banner.

## Checking it

- Everything at once: `GET https://agentfirststack.com/v1/setup` (MCP `afs_check_setup`) lists each
  part of the full setup with its status and the fix; run it first on every later run.
- Analytics: `POST /v1/sites/site_6hmh1a6dbbn8mdfp/verify`; goals with
  `GET /v1/sites/site_6hmh1a6dbbn8mdfp/stats?period=7d&breakdown=goal`.
- Tags: `GET /v1/containers/ctr_6znmv02cawfa9pb9/events?since=1h`, `/tag-stats?since=7d`.
- Replay: `POST /v1/sites/rsite_szw52yv28by1qy3b/verify`; test sessions are labelled `agent-setup-test`.
- Test clicks in a browser: open the first page with `?afsa_debug=1&afsr=1`, so the visit stays out
  of reports and its replay is forced and marked as a test. Headless Chrome is dropped as a bot by
  analytics; use a real browser. Don't click the footer email links in a browser with a mail app
  set up: a `mailto:` click opens a draft there.
- Server events: `GET .../stats?period=7d&breakdown=goal` shows "Created a project (server)" and
  "Claimed a project (server)"; dry run the same shape with `POST .../events?validate_only=true`.

## Tags versions

- v1 (2026-11-04): the analytics tag and the ten click conversions.
- v2 (2026-11-05): `github_click` only on this project's GitHub links, with `link_url`; other
  GitHub links on the comparison pages had been counted as "Clicked GitHub".

## Last full check (2026-11-05, real Chrome, test traffic)

- Analytics: verify ok (installed, receiving events, domain verified). One visit, 6 pageviews:
  each of the 13 browser goals counted (copy_prompt 3: hero, closing, guide page). The two server
  goals had 0 (no project created or claimed since the deploy); the dry run accepted both.
- Tags: the event log had all 10 conversions (13 in the run), each `fired_in_browser: analytics`;
  tag-stats: the analytics tag fired 7 times in an hour, 0 blocked or failing. Preview checked first.
- Replay: verify ok; session `rs_07p84z5s2sqysjja` (forced) shows the 13 clicks with labels and 5
  pages. Its 3 dead clicks were links whose navigation the test blocked. Verify's one failing
  check is old local-dev chunks from `127.0.0.1` (nothing to change).
- Mail: a message from the inbox to `agentfirststack-signups+setupcheck@` arrived in 115 ms and
  `latest-code` extracted its code.
- Setup check (`GET /v1/setup`): ready, 22 of 22, after one test (`debug`) `signup` and
  `project_claimed` server event each: the two server goals had never counted.
