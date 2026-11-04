# Replay parity: Microsoft Clarity and Hotjar vs AgentFirstStack Replay (2026-11-04)

What Clarity and Hotjar (now sold as part of Contentsquare) document, what `replay/` has, and what
to build. Ours comes from `replay/src/llms.ts`, `src/mcp.ts`, `src/service/*`, `src/lib/*`,
`src/do/*`, `src/recorder/*`, `src/player/*` and `deploy/hosted.json`. Clarity facts come from
learn.microsoft.com/clarity and github.com/microsoft/clarity{,-mcp-server} (every page fetched
directly). Hotjar facts: help.hotjar.com sits behind a Cloudflare challenge (403 to WebFetch, curl
and its Zendesk API), so Hotjar articles were read through Internet Archive snapshots (mostly
Jan-Apr 2025, some to Oct 2026) and a reader proxy that follows each old link to its current article
id; the Contentsquare help center was read live. Hotjar is being folded into Contentsquare: from 26
Aug 2026 accounts move to Contentsquare Growth, Hotjar turns read-only for 12 months, Observe data
(recordings, heatmaps, funnels) does not migrate, surveys and feedback do ([CS
FAQ](https://support.contentsquare.com/hc/en-us/articles/46690997637137)). Rows describe documented
Hotjar behaviour. Where vendor pages contradict themselves the cell says so.

**Legend.** Status: **Have** (parity or better), **Partial**, **Missing**. Decision: keep, build
(as they do), adapt (agent-first or privacy-first shape), skip (why given). Effort: S (days),
M (1-2 weeks), L (more). Proposed APIs follow the repo rules: REST under `/v1/sites/:id/...`,
snake_case, an MCP tool for every route (read tools vs `t.write`), idempotent creates, `next_steps`,
recorded or visitor-typed values under `untrusted`. C = Clarity doc, H = Hotjar doc.

## Summary

110 features across both products. Each row counts once: Skip = not built by decision, whatever we
have today; Partial and Missing rows are all build or adapt. Surveys and feedback are 14 of the 26
missing rows.

| Area | Have | Partial | Missing | Skip | Rows |
|---|---|---|---|---|---|
| Recording and playback | 10 | 4 | 4 | 1 | 19 |
| Signals and metrics | 8 | 3 | 0 | 3 | 14 |
| Heatmaps | 4 | 4 | 3 | 2 | 13 |
| Analysis: funnels, segments, trends, insights | 2 | 3 | 0 | 3 | 8 |
| JS APIs | 3 | 3 | 1 | 1 | 8 |
| Privacy, masking, consent | 10 | 3 | 0 | 0 | 13 |
| Surveys and feedback | 0 | 0 | 14 | 2 | 16 |
| Data API and export | 2 | 3 | 1 | 1 | 7 |
| Integrations | 5 | 2 | 3 | 2 | 12 |
| **Total** | **44** | **25** | **26** | **15** | **110** |

Where we are already ahead: masked in the browser with **strict** as the default (Clarity defaults
to Balanced), query strings and id-like path segments stripped from every URL, an attribute
allowlist, no cookies, GPC **and** DNT honoured (Clarity ignores DNT), per-visitor deletion (Clarity
can only delete a whole project), per-site retention, domain verification, `exclude_paths`, a
readable transcript per session, deterministic cross-session summaries with example sessions,
funnel drop-off sessions with what they had in common, and every read over REST and a remote MCP
with no daily request cap (Clarity's export API: 10 requests a day, last 1-3 days, 1,000 rows).

Biggest gaps: no surveys or feedback (all of Hotjar "Ask"), no custom tags / identify attributes,
no segments, no trends over time, no failed-request capture, no attention / first-click / compare
heatmaps, no notes, labels or favourites, no smart events, no webhooks.

## Built in the parity release (2026-11-04)

Items 1-13 of the prioritised list below are built in `replay/` (see `replay/llms.txt` sections and
the CHANGELOG): custom tags and identify attributes with optional browser-side hashing; more
filters, `!` negation and saved segments on every read; `get_replay_metrics` and active time;
failed network requests (`api_error`, opt-in); on-site surveys and feedback (popover, embedded,
feedback tab; templates, logic, targeting, triggers incl. exit intent and frustration, limits,
responses with CSV, deterministic results and themes, session linking, `test_survey`); the heatmap
bundle (session filters, first/last click, compare, sort, conversion share, findings, CSV); notes,
labels, stars and clips; consent by region, Google Consent Mode, IP-range exclusion,
`afsr('upgrade')` / `afsr('start')`; signed webhooks; event definitions and automatic
`form_submit` / `outbound_click` / `download`; attention map and zones; exports, raw events,
`get_visitor`, `get_manual`, funnel time to convert, more sorts, in-progress sessions, opt-in
console.warn; Shopify, Webflow, Wix, Squarespace, Framer and Segment / Mixpanel / Amplitude install
notes. Wave 2 added item 15 (IAB TCF v2 consent, signals and survey scores to a tags container for GA4
and ad platforms, heatmap PNGs through Browser Rendering), the opt-in email question type, playback
for starred sessions past the R2 lifecycle rule, https-only uploads and impression budgets. Still
not built, on purpose: link surveys on our domain (item 14, until user content has a separate
domain) and the Skip rows. The tables below are the audit as written before the build.

## 1. Recording and playback

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| DOM recording (not video) | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/recordings-overview) [H](https://help.hotjar.com/hc/en-us/articles/36820006445585) | **Have**: rrweb in `recorder/recorder.ts`, gzip chunks `POST /i` -> R2; canvas and cross-origin iframes not captured (same as Clarity) | keep | - | - |
| Daily cap, sampling | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api) (100k/day, then sampled) [H](https://help.hotjar.com/hc/en-us/articles/36820043374865) (plan daily cap, sampled over 24 h) | **Have**: `sample_rate`, MAX_SESSIONS_PER_SITE_PER_DAY (hosted 200), forced `?afsr=1` quota | keep (hosted caps are an ops call) | - | - |
| Session list fields and sort | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/session-list) [H](https://help.hotjar.com/hc/en-us/articles/36820005706385) | **Have**: `search_sessions` (`GET /sessions`): duration, pageviews, clicks, inputs, errors, signal counts, frustration, device, geo; sort frustration, recent, duration | build sort by clicks, pageviews | S | `sort=clicks\|pageviews` |
| Recording filters | [C](https://learn.microsoft.com/en-us/clarity/filters/clarity-filters) (30+), [C excl.](https://learn.microsoft.com/en-us/clarity/filters/exclusion-filters) [H](https://help.hotjar.com/hc/en-us/articles/36819988557329) | **Partial**: 20 filters (`service/schemas.ts` `filtersShape`). Missing: referrer, region/city, page count, scroll depth, custom tags, labels, user attributes, negation, regex. Entered text and new vs returning: impossible by design (values never leave the browser; no cookies) | build the rest | S | add `referrer`, `region`, `city`, `min_pageviews`, `min_scroll_pct`, `tag=key:value`, `label`, `starred`, `survey_id`/`survey_answer`; leading `!` negates (`country=!US`, `page=!/admin*`) |
| Segments (saved filters) | [C](https://learn.microsoft.com/en-us/clarity/filters/clarity-segments) [H](https://help.hotjar.com/hc/en-us/articles/36819966071825) (can fire Slack/Teams/webhook) | **Missing** | build | S | `POST /segments {name, filters}` (idempotent by name), `GET /segments`, `DELETE /segments/:seg_id`; `segment_id=` on sessions, summary, heatmap, errors, funnel, metrics. MCP `create_segment` (w), `list_segments` (r), `delete_segment` (w) |
| Playback speed, skip inactivity | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/inline-player) (0.25x-12x) [H](https://help.hotjar.com/hc/en-us/articles/36820025895697) (0.5x-4x) | **Have**: `/play/<token>`, rrweb-player controller (1-8x), `skipInactive: true` (`player/player.ts`) | keep | - | - |
| Event timeline, click to seek | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/inline-player) | **Have**: player timeline with signals and errors; `get_session_transcript` | keep | - | - |
| Session as text | none (closest: C Session Insights, AI) | **Have** (ahead): transcript, one line per event, labels masked as recorded, stable selectors | keep | - | - |
| Highlights, clips, collections | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/inline-player) [H](https://help.hotjar.com/hc/en-us/articles/36820034118289) (clips, labels, collections) | **Partial**: transcript `kinds=` gives key moments; no clip or collection | adapt: a clip is a share link with a window; a collection is a label | S | `POST /links {session_id, start_ms?, end_ms?, note?}`; labels below |
| Notes on a recording | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/inline-player) [H](https://help.hotjar.com/hc/en-us/articles/36820034118289) (highlight comments) | **Missing** | build (agents leave findings for people) | S | `POST /sessions/:sid/notes {t_ms, text}` -> transcript line `note "..."` and player timeline; `GET`, `DELETE /sessions/:sid/notes/:note_id`. MCP `add_session_note` (w) |
| Favourites, labels | [C fav.](https://learn.microsoft.com/en-us/clarity/session-recordings/session-list) [C labels](https://learn.microsoft.com/en-us/clarity/session-recordings/clarity-labels) (1,000/project, 5/recording; 9 months, labels page says 90 days) | **Missing** | build; starred sessions outlive `retention_days` (Clarity keeps favourites 9 months vs 30 days) | S | `PATCH /sessions/:sid {starred?, labels?}`; MAX_STARRED_SESSIONS_PER_SITE, MAX_STARRED_RETENTION_DAYS; filters `starred`, `label`. MCP `label_session` (w) |
| Live sessions | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/clarity-real-time) (up to 100) | **Partial**: `sort=recent`, `ended` flag | adapt: list in-progress sessions; skip live playback (agents read transcripts) | S | `GET /sessions?active=true` (last chunk < 2 min, not ended) |
| Visitor profile, cross-session history | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/visitor-profile) [H](https://help.hotjar.com/hc/en-us/articles/36820022769425) (user lookup) | **Partial**: `user_id`, `analytics_visitor_id` filters; cookieless, so anonymous visitors don't span days | adapt: one call per identified visitor (also the DSAR "access" answer) | S | `GET /visitors?user_id=\|analytics_visitor_id=` -> sessions, tags, survey responses. MCP `get_visitor` (r) |
| Console errors | [H](https://help.hotjar.com/hc/en-us/articles/36819965895953) (Scale; uncaught errors and rejections) | **Have** (ahead): uncaught errors, rejections and `console.error` (`capture_console_errors`), scrubbed, in transcript and player | keep; optional warn, never log/info (PII-heavy) | S | `capture_console: ["error","warn"]`; `list_errors?kind=console_warn` |
| Failed network requests | none in C or H; [Contentsquare](https://support.contentsquare.com/hc/en-us/articles/37271834510097) has it | **Missing** | build (ahead of both: the top "what is broken" signal after JS errors) | M | `capture_network_errors: true`: recorder wraps fetch/XHR, sends `afs.net {method, path (:id, no query), status, ms}` for status >= 400 or network failure, no headers or bodies; new signal `api_error` (+ error click analogue: request failed within 1 s after a click); `list_errors?kind=network`; transcript line |
| Retention | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/data-retention) (30 d playback, 9 mo heatmaps) [H](https://help.hotjar.com/hc/en-us/articles/36819991007505) (365 d) | **Have**: `retention_days` (hosted max 14), `heatmap_retention_days` (hosted max 90) | keep | - | - |
| Share a recording | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/share-clarity) [H](https://help.hotjar.com/hc/en-us/articles/36820033667729) | **Have**: `create_replay_link` (expiring <= 30 d, revocable, views, byte budget, verified domain) | keep (+ window, above) | - | - |
| Frustration / relevance score | [H](https://help.hotjar.com/hc/en-us/articles/36820005706385) (relevance, frustration, engagement) | **Have**: `frustration` 0-100, `sort=frustration`, `min_frustration` | keep | - | - |
| Mobile app SDKs | [C](https://learn.microsoft.com/en-us/clarity/mobile-sdk/mobile-sdk-overview) | **Missing** | skip: web recorder only; native capture is a separate product | L | - |

## 2. Signals and metrics

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Rage clicks | [C](https://learn.microsoft.com/en-us/clarity/insights/semantic-metrics) (no threshold published) [H](https://help.hotjar.com/hc/en-us/articles/36819988557329) (6 clicks in 600 ms; the heatmap page says 5 in 500 ms) | **Have**: >= 3 clicks in 1 s, same selector or 30 px, burst counted once (`lib/signals.ts`) | keep | - | - |
| Dead clicks | [C](https://learn.microsoft.com/en-us/clarity/insights/semantic-metrics) | **Have**: no DOM change, scroll, input, navigation or hide in 1 s; `dead_clicks_interactive` split | keep | - | - |
| Excessive scrolling | [C](https://learn.microsoft.com/en-us/clarity/insights/semantic-metrics) | **Have**: >= 4 reversals and >= 2.5x scrollable height | keep | - | - |
| Quick backs / U-turns | [C](https://learn.microsoft.com/en-us/clarity/insights/semantic-metrics) [H](https://help.hotjar.com/hc/en-us/articles/36819988557329) (U-turn: back within 7 s) | **Have**: A -> B -> A within 7 s, flagged on B | keep | - | - |
| JS errors, script errors | [C](https://learn.microsoft.com/en-us/clarity/insights/semantic-metrics) | **Have**: `list_errors`, grouped by fingerprint, stack, first/last seen, triggering click | keep | - | - |
| Error clicks | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/click-maps) | **Have**: JS error within 1 s of a click | keep | - | - |
| Scroll depth | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api) | **Have**: `max_scroll_pct` per pageview, heatmap reach curve, fold | keep | - | - |
| Engagement / active time | [C](https://learn.microsoft.com/en-us/clarity/third-party-integrations/clarity-mcp-server) (total, active, active %) | **Partial**: `duration_ms`, per page `stayed_ms`; `afs.idle`/`afs.hide` stored but no active time | build | S | `active_ms` per session and page (visible and input within the idle window) in search, get_session, summary; filter `min_active` |
| User intent (low/medium/high) | [C](https://learn.microsoft.com/en-us/clarity/insights/user-intent-metrics) | **Missing** | skip: a fixed bucketing of duration + interaction; agents derive it from `active_ms`, clicks, events | - | - |
| Smart events (auto + no-code) | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/smart-events) (9 auto, <= 20 defined) | **Partial**: API events only (`afsr('event')`) | adapt: retroactive event definitions (like analytics goals); auto only what masking allows (`form_submit`, `outbound_click`, `download` from href); no text-based auto events (labels are masked in strict) | M | `POST /event-definitions {name, match: {click: selector-contains \| label, page: glob}}` (<= 20, idempotent by name), `GET`, `DELETE`; usable as `event=` filter and funnel step `event:<name>`. MCP `define_event` (w), `list_event_definitions` (r) |
| Popular pages, referrers | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api) | **Partial**: summary `entry_pages`, `exit_pages`; `pages.referrer` stored, not aggregated | build (in metrics, section 4) | S | `GET /metrics?by=page\|referrer` |
| Core Web Vitals | [C](https://learn.microsoft.com/en-us/clarity/insights/performance-widget) | **Missing** in replay; analytics has LCP/INP/CLS p75 | skip: analytics owns it, joined by `analytics_visitor_id` | - | - |
| Bot detection | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup) | **Have**: webdriver + bot UA dropped, drops by reason in `get_replay_site` | keep | - | - |
| E-commerce, conversion and content insights | [C](https://learn.microsoft.com/en-us/clarity/insights/e-commerce-insights) [C](https://learn.microsoft.com/en-us/clarity/insights/content-insights) | **Missing** | skip: revenue, goals and content reports live in analytics; replay keeps funnel drop-offs | - | - |

## 3. Heatmaps

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Click map, element level | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/click-maps) [H](https://help.hotjar.com/hc/en-us/articles/36820020346385) | **Have**: `get_heatmap`: per selector clicks, share, sessions, position, `reached_by_share` (as data, not a picture) | keep | - | - |
| Rage, dead, error click maps | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/click-maps) [H](https://help.hotjar.com/hc/en-us/articles/36820020346385) | **Have**: rage/dead/error shares per element; summary `not_clickable_but_clicked` | build sort | S | `sort=clicks\|rage\|dead\|error` |
| First / last click | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/click-maps) | **Missing** (clicks are stored per pageview with ts, so derivable) | build | S | `click=all\|first\|last` |
| Scroll map | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/scroll-maps) (5% steps) | **Have**: reach 10..100%, median reach, average fold | keep | - | - |
| Area map | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/area-maps) | **Partial**: per exact selector only | adapt: zones the recorder tags at click time (nearest ancestor matching site `zones` selectors, else landmark header/nav/main/footer/section[id]/form) | M | setting `zones: [css]`; `GET /heatmap?group_by=zone` -> `{zone, clicks, ctr}` |
| Attention map / engagement zones | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/attention-maps) [H](https://help.hotjar.com/hc/en-us/articles/36820020346385) | **Missing** (`afs.scroll {y, vh, dh}` + timestamps are recorded) | build | M | `type=attention` -> `attention: [{pct, avg_visible_ms, time_share, clicks}]` per 10% band; rolled into `scroll_daily` |
| Move map | [H](https://help.hotjar.com/hc/en-us/articles/36820020346385) | **Missing** (moves are in the rrweb stream, not derived) | skip: weak signal, derive cost per chunk; attention answers "what is looked at" | - | - |
| Conversion map | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/conversion-maps) (purchases) | **Missing** | adapt: per element, share of clicking sessions that later fired an event | S | `converted_event=<name>` -> `conversion_share` per element |
| Per device | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/click-maps) | **Have**: `device=` | keep | - | - |
| Compare | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/heatmaps-compare) (H: date range only) | **Partial**: two calls | build | S | `compare=previous\|<from>..<to>` or `compare_device=` -> per element `click_share_delta`, reach deltas |
| Heatmap from filters / segment | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/heatmaps-features) | **Partial**: page, device, period only | build | S | accept every session filter + `segment_id` |
| Download CSV / PNG | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/download-heatmaps) [H](https://help.hotjar.com/hc/en-us/articles/36819988774545) (JPG, CSV) | **Partial**: JSON | adapt: CSV now; PNG later through Browser Rendering (live page + overlay) | S / M | `format=csv`; later `GET /heatmap.png` |
| Change screenshot, dynamic states | [C](https://learn.microsoft.com/en-us/clarity/heatmaps/heatmaps-screenshots) [H](https://help.hotjar.com/hc/en-us/articles/36819965623569) | n/a (no screenshot) | skip | - | - |

## 4. Analysis: funnels, segments, trends, insights

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Funnels | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/funnels) [H](https://help.hotjar.com/hc/en-us/articles/36820004382609) (<= 10 steps, time to convert, Scale) | **Partial**: `get_funnel_dropoffs`: 2-8 steps, saved analytics funnels via `analytics_funnel_id`, dropped sessions with common signals (ahead); no time to convert | build | S | per step `median_ms_from_previous`; `funnel=`+`drop_step=` as a session filter |
| Trends, dashboard over time, watchlist | [C](https://learn.microsoft.com/en-us/clarity/insights/dashboard-features) [H](https://help.hotjar.com/hc/en-us/articles/36820004530705) (session counts per filter set, Scale) | **Partial**: `get_replay_site` counts, summary totals; no time series | build | S | `GET /metrics?period&interval=hour\|day\|week&by=page\|referrer\|device\|browser\|country\|tag:<key>` + filters/`segment_id` -> per bucket sessions, pageviews, avg duration, active_ms, share with each signal, js_errors, median scroll. MCP `get_replay_metrics` (r) |
| Custom dashboards | [C](https://learn.microsoft.com/en-us/clarity/insights/dashboard-features) [H](https://help.hotjar.com/hc/en-us/articles/36819965007633) | **Partial**: dashboard prompts have the owner's agent build screens from the API (`docs/accounts.md`) | skip: agents build them | - | - |
| Grouped session insights | [C](https://learn.microsoft.com/en-us/clarity/copilot/grouped-session-insights) | **Have** (deterministic): `summarize_sessions` findings, top targets, journeys, example ids | keep | - | - |
| Session summary (AI) | [C](https://learn.microsoft.com/en-us/clarity/copilot/session-insights) [H](https://help.hotjar.com/hc/en-us/articles/36820006275857) [CS Sense](https://support.contentsquare.com/hc/en-us/articles/37271686342801) | **Have** (different): the transcript is the input; no model | skip hosted LLM: the caller's model reads it; no model cost, reproducible | - | - |
| Heatmap insights (AI) | [C](https://learn.microsoft.com/en-us/clarity/copilot/heatmaps-insights) | **Partial**: data only | adapt: deterministic sentences ("CTA seen by 38%", "most dead-clicked element") | S | `untrusted.findings` in `get_heatmap` |
| Copilot chat / AI chat | [C](https://learn.microsoft.com/en-us/clarity/copilot/clarity-copilot-chat) [H](https://help.hotjar.com/hc/en-us/articles/36820006275857) [CS Sense](https://support.contentsquare.com/hc/en-us/articles/37271686342801) | n/a | skip: MCP is the chat surface | - | - |
| Common journeys | none | **Have**: summary `common_journeys`; analytics `journeys` | keep | - | - |

## 5. JS APIs

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Custom events | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api) [H](https://help.hotjar.com/hc/en-us/articles/36819965075473) (name only, 250 chars) | **Have**: `afsr('event', name, props)` (<= 20 props; Clarity: name only); filter `event`, funnel step `event:<name>` | keep | - | - |
| Custom tags | [C](https://learn.microsoft.com/en-us/clarity/filters/custom-tags) (`clarity("set")`, 128/page, 255 chars) | **Missing** | build (unlocks segments, experiments, survey targeting) | S | `afsr('set', key, value \| value[])`: <= 20 keys per session, 100 chars, scrubbed like errors; filter `tag=key:value`; `by=tag:<key>` in metrics and summary |
| Identify (+ attributes) | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/identify-api) (hashed in the browser) [H](https://help.hotjar.com/hc/en-us/articles/36820006120721) (attributes: 100 per site) | **Partial**: `afsr('identify', id)`, stored as sent (<= 200 chars) | build | S | `afsr('identify', id, attrs)`: attrs become tags; site setting `hash_user_ids` (SHA-256 with the site salt in the browser; `delete_visitor_data` and `user_id=` hash the same way) |
| Upgrade / start | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api) | **Partial**: `?afsr=1` forces a tab; `afsr('stop')` has no counterpart | build | S | `afsr('upgrade', reason)`: a tab not sampled in starts recording now (new snapshot), own cap MAX_UPGRADED_SESSIONS_PER_SITE_PER_DAY, `upgraded: reason`, filter `upgraded`; `afsr('start')` after a stop |
| Consent API, CMPs, Google Consent Mode | [C v2](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2) [C CMPs](https://learn.microsoft.com/en-us/clarity/setup-and-installation/cookie-cmps) [C GCM](https://learn.microsoft.com/en-us/clarity/setup-and-installation/cookie-gcm) H: none built in, block via the CMP ([H](https://help.hotjar.com/hc/en-us/articles/36819973371409)) | **Partial**: `require_consent` + `afsr('consent', bool)`; no cookies, so no ad/analytics storage split | build | S (GCM) / M (TCF) | `consent_source: "api" \| "gcm" \| "tcf"`: loader follows Google Consent Mode `analytics_storage` or IAB TCF v2.2 purposes instead of waiting for `afsr('consent')` |
| Session metadata | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2) (`metadata`) | **Have**: `afsr.sessionId()`, `afsr.status()` | keep | - | - |
| SPA page changes | [H](https://help.hotjar.com/hc/en-us/articles/36820006944657) (`hj('stateChange')`, auto by default) | **Have**: pushState, replaceState, popstate patched; hash routes are one page (fragments stripped by design) | keep | - | - |
| npm package | [C](https://www.npmjs.com/package/@microsoft/clarity) [H](https://help.hotjar.com/hc/en-us/articles/36820006944657) (`@hotjar/browser`) | **Missing** | skip: snippet + queue stub works in every framework; `get_install_snippet` covers nextjs/react/astro | - | - |

## 6. Privacy, masking, consent

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Masking modes | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking) (Balanced default) [H](https://help.hotjar.com/hc/en-us/articles/36819956605329) | **Have** (ahead): strict default, balanced, relaxed, in the browser (`lib/mask-rules.ts`); unverified domains forced strict | keep | - | - |
| Element masking attributes, selectors | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking) [H](https://help.hotjar.com/hc/en-us/articles/36819956605329) | **Have**: `data-afsr-unmask/mask/block/ignore`; `unmask/mask/block_selectors` | keep | - | - |
| Inputs and keystrokes | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking) [H](https://help.hotjar.com/hc/en-us/articles/36819956605329) | **Have**: every value masked in every mode; never shown for password, card, OTP fields | keep | - | - |
| URL parameter masking | [C](https://learn.microsoft.com/en-us/clarity/faq) (support request, page URL only) | **Have** (ahead): query and fragment stripped from every URL, id-like segments -> `:id` | keep | - | - |
| IP exclusion | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/ip-exclusion) (IPv4 CIDR) [H](https://help.hotjar.com/hc/en-us/articles/36819956605329) (IPv4 or regex, not surveys) | **Partial**: `localStorage.afsr_ignore`; IPs never stored | build | S | `exclude_ip_ranges` (IPv4 + IPv6 CIDR, <= 20): checked at ingest, never stored, answer `stop: true` |
| Excluded pages | [C](https://learn.microsoft.com/en-us/clarity/faq) (none: remove the code) | **Have** (ahead): `exclude_paths`, salted hashes in the loader | keep | - | - |
| Consent required by region (EEA/UK/CH) | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/consent-mode) (enforced since 31 Oct 2025) | **Partial**: `require_consent` applies everywhere | build | S | `require_consent: true \| false \| "eea"`: loader served with the flag set from the request's country (EEA, UK, CH), `Vary` on country |
| GPC / DNT | [C](https://learn.microsoft.com/en-us/clarity/faq) (GPC yes, DNT no) [H](https://help.hotjar.com/hc/en-us/articles/36819956524177) (DNT yes, surveys still shown) | **Have** (ahead): both stop recording | keep | - | - |
| Cookies | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-cookies) (`_clck` 365 d, `_clsk`, MUID) [H](https://help.hotjar.com/hc/en-us/articles/36819973371409) (`_hjSessionUser` 365 d, `_hjSession`) | **Have** (ahead): none; sessionStorage per tab | keep | - | - |
| Per-visitor deletion | [C](https://learn.microsoft.com/en-us/clarity/faq) (whole project only) [H](https://help.hotjar.com/hc/en-us/articles/36819965163537) (within 30 days) | **Have** (ahead): `delete_session`, `delete_visitor_data {user_id \| analytics_visitor_id \| session_ids}`, ids tombstoned 2 days | keep (+ survey responses) | - | - |
| Data access request | [H](https://help.hotjar.com/hc/en-us/articles/36820022769425) (user lookup, emailed in 24 h) | **Partial**: `search_sessions?user_id=` | build: `get_visitor` (section 1) | S | see section 1 |
| CSP guidance | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-csp) (`*.clarity.ms`) [H](https://help.hotjar.com/hc/en-us/articles/36820026388881) (needs `'unsafe-inline'`) | **Have** (ahead): path-scoped sources; `verify_install` checks the page CSP | keep | - | - |
| Domain ownership | none | **Have** (ahead): `verify_install` (homepage tag or DNS TXT) gates quotas, unmasking, links | keep | - | - |

## 7. Surveys and feedback

All Hotjar "Ask"; Clarity has none. Proposed as one feature set below the table.

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| On-site survey (popover, embedded) | [H](https://help.hotjar.com/hc/en-us/articles/36820033378065) (popover, button, bubble, embedded, full screen) | **Missing** | build; skip full screen | M | `create_survey {kind: "popover" \| "embedded", selector?}` |
| Link survey (hosted page) | [H](https://help.hotjar.com/hc/en-us/articles/36820033378065) (never linked to recordings) | **Missing** | build after on-site (phishing guard needed) | M | `kind: "link"` -> `share_url` `/f/<token>`, `?ref=` |
| Question types | [H](https://help.hotjar.com/hc/en-us/articles/36820042122513) | **Missing** | build: reaction, short/long text, single/multi choice, rating (1-5, 1-7, 1-10), nps, statement, email (opt-in, not in link surveys) | S | `questions[].type` |
| Templates (NPS, CSAT, CES, PMF, exit intent) | [H](https://help.hotjar.com/hc/en-us/articles/36819957597585) (NPS, CSAT, exit intent named, "40+"; PMF and CES unconfirmed) | **Missing** | build | S | `template: "nps" \| "csat" \| "ces" \| "pmf" \| "exit_intent" \| "feature_request" \| "bug_report"` |
| Targeting (pages, device, users, % of visitors) | [H](https://help.hotjar.com/hc/en-us/articles/36819957597585) [H attrs](https://help.hotjar.com/hc/en-us/articles/36820025646609) | **Missing** | build (user attributes via custom tags) | S | `targeting {pages, exclude_pages, devices, countries, tags, identified, sample_rate}` |
| Triggers (load, delay, scroll, exit intent, JS) | [H](https://help.hotjar.com/hc/en-us/articles/36819957597585) [H events](https://help.hotjar.com/hc/en-us/articles/36820043474321) | **Missing** | build, + `frustration` trigger (after a rage or error click in the browser: unique) | S | `trigger {on: load \| delay \| scroll \| exit_intent \| event \| frustration \| manual}`; `afsr('survey', id)` |
| Skip logic | [H](https://help.hotjar.com/hc/en-us/articles/36820058569617) | **Missing** | build | S | `questions[].logic [{if: {equals \| in \| lte \| gte \| answered}, goto}]` |
| Frequency, response limits, end date | [H](https://help.hotjar.com/hc/en-us/articles/36819957597585) [H allowance](https://help.hotjar.com/hc/en-us/articles/36819956672401) (monthly per site; per-survey cap unconfirmed) | **Missing** | build | S | `frequency`, `limits {max_responses, ends_at}` |
| Appearance, language | [H](https://help.hotjar.com/hc/en-us/articles/36819957597585) [CS](https://support.contentsquare.com/hc/en-us/articles/37271718906513) (45 languages) | **Missing** | build (closed Shadow DOM, CSP-safe) | S | `appearance {position, theme, accent, language, strings}` |
| Responses list and export | [H](https://help.hotjar.com/hc/en-us/articles/36819974400145) [H API](https://help.hotjar.com/hc/en-us/articles/36820005914001) | **Missing** | build; answers are visitor-typed: `untrusted`, PII scrubbed by default | S | `GET /surveys/:sv/responses?format=json\|ndjson\|csv`. MCP `list_survey_responses` (r) |
| Results (NPS score, distributions, drop-off) | [H](https://help.hotjar.com/hc/en-us/articles/36819974400145) | **Missing** | build; text themes deterministic | S | `GET /surveys/:sv/results`. MCP `get_survey_results` (r) |
| Responses linked to recordings | [H](https://help.hotjar.com/hc/en-us/articles/36819988306065) (auto, ask, never) | **Missing** | build (ahead once built: an API filter, not only a UI filter) | S | `link_session: auto \| ask \| never`; response `session_id`; `search_sessions?survey_id=&survey_answer=`; transcript line |
| Verify a survey | none | **Missing** | build (rule 6) | S | `POST /surveys/:sv/test` -> `preview_url` (`?afsr_survey=rsv_...`), checks. MCP `test_survey` (w) |
| Feedback widget (reaction, comment, element) | [H](https://help.hotjar.com/hc/en-us/articles/36820006299921) (merged into button surveys, Sep 2024) | **Missing** | build (element = stable selector; the recording is the screenshot) | M | `kind: "feedback"`, `allow_element`; `afsr('feedback')` |
| AI survey builder, AI summaries | [H](https://help.hotjar.com/hc/en-us/articles/36820044005393) [H](https://help.hotjar.com/hc/en-us/articles/36820006275857) | n/a | skip: the calling agent writes questions and reads answers; we give templates and deterministic themes | - | - |
| User interviews (Engage) | [H](https://help.hotjar.com/hc/en-us/articles/36820018995217) [CS](https://support.contentsquare.com/hc/en-us/articles/37271737000593) (no longer sold to new customers) | **Missing** | skip: recruiting and scheduling people, video calls; not agent-operable | L | - |

### Proposed feature set ("Ask" for agents)

One object, `survey` (`rsv_...`), with four `kind`s that share questions, targeting, responses and
results: `popover` (corner widget), `embedded` (rendered into a page element), `feedback`
(persistent side tab; Hotjar merged its Feedback widget into "button" surveys in Sep 2024) and
`link` (hosted page). It lives in the replay app because the loader is already on the page, consent,
masking, domain verification and fair use already exist there, and a response can carry the `rs_...`
of the tab that answered. Hotjar links responses to recordings in its UI (Reaction and NPS filters);
here it is an API filter, so "read the transcripts of detractors" is one call.

**Object** (`POST /v1/sites/:id/surveys`, idempotent by `name`: same name again -> 200 `existing:
true`)

```jsonc
{
  "name": "Checkout NPS",
  "kind": "popover",                     // popover | embedded {selector} | feedback | link
  "template": "nps",                     // optional, expands into questions you can edit:
                                         // nps | csat | ces | pmf | exit_intent | feature_request | bug_report
                                         // (csat, ces: presets over `rating`; Hotjar has no separate types)
  "status": "draft",                     // draft | active | paused | closed
  "questions": [{
    "id": "q1", "type": "nps",           // reaction (5 faces) | short_text | long_text | single_choice | multi_choice | rating | nps | statement | email
    "text": "How likely are you to recommend us?",
    "choices": null, "scale": null,      // choices for *_choice; scale {max: 5|7|10, min_label, max_label, style: numbers|stars|emoji} for rating
    "required": true, "randomize": false, "other": false,
    "logic": [{ "if": { "lte": 6 }, "goto": "q2" }, { "else": "end" }]   // equals | in | lte | gte | answered
  }],
  "targeting": { "pages": ["/checkout*"], "exclude_pages": [], "devices": ["desktop","mobile"],
                 "countries": null, "tags": { "plan": "pro" }, "identified": null, "sample_rate": 0.2 },
  "trigger": { "on": "load" },           // load | delay {seconds} | scroll {pct} | exit_intent | event {name} | frustration {signals} | manual
  "frequency": "once_per_visitor",       // once_per_tab | once_per_visitor | until_answered
  "limits": { "max_responses": 500, "ends_at": null },
  "appearance": { "position": "bottom_right", "theme": "auto", "accent": "#2a6df4", "language": "en", "strings": {} },
  "link_session": "auto",                // auto | ask | never (Hotjar's three options); link surveys: never
  "scrub_pii": true,                     // emails, phone-like and long numbers masked in answers (like JS errors)
  "show_with_gpc": false                 // privacy-first default: GPC/DNT browsers see no survey (Hotjar still shows them)
}
```

Returns `{ survey, preview_url, install: { nothing_to_paste: true }, next_steps }`: the loader
already
on the page picks active surveys up within ~5 minutes (loader TTL); `kind: link` also returns
`share_url`.

| Area | Route (REST, `/v1/sites/:id/...`) | MCP tool | Notes |
|---|---|---|---|
| Create | `POST surveys` | `create_survey` (write) | templates, idempotent by name; 403 quota_exceeded past MAX_SURVEYS_PER_SITE |
| List / get | `GET surveys`, `GET surveys/:sv` | `list_surveys`, `get_survey` (read) | get adds `stats {impressions, started, completed, completion_rate, last_response_at}` |
| Change | `PATCH surveys/:sv` | `update_survey` (write) | editing questions after responses bumps `version`; responses keep the question text they answered |
| Delete | `DELETE surveys/:sv` | `delete_survey` (write, destructive) | responses too |
| Verify | `POST surveys/:sv/test` | `test_survey` (write) | returns `preview_url` = `https://<domain>/<page>?afsr_survey=rsv_...` (forces display, own small quota, responses `test: true`), and checks: in loader config, targeted page matches, impression seen, response received, CSP. Rule 6 |
| Responses | `GET surveys/:sv/responses` `?period&question&answer&nps=promoter\|passive\|detractor&page&device&test&format=json\|ndjson\|csv&cursor` | `list_survey_responses` (read) | `{responses:[{id, created_at, version, session_id, path, device, country, untrusted:{answers}}]}`; text answers are visitor-typed: UNTRUSTED (rule 8) |
| Results | `GET surveys/:sv/results` `?period&page&device` | `get_survey_results` (read) | funnel views -> started -> completed, drop-off per question, distribution per choice, NPS score + promoters/passives/detractors, CSAT % satisfied, CES mean; `untrusted.text_themes` = deterministic term/bigram groups with example response and session ids (no model, like summarize_sessions) |
| Delete one | `DELETE surveys/:sv/responses/:rid` | `delete_survey_response` (write) | `delete_visitor_data` also deletes a visitor's responses |
| Sessions | `GET sessions?survey_id=&survey_answer=q1<=6` | `search_sessions` | transcript line `survey "Checkout NPS" q1=3 (detractor)`; summarize_sessions of detractors |
| Page API | `afsr('survey', 'rsv_...')` show now (trigger manual), `afsr('feedback')` open the tab | n/a | replaces Hotjar's `hj('trigger')` |
| Public | `GET /sv/<hash>.js` (survey UI, lazy), `POST /f` (answers; Origin + hostname checks, per-network caps like `/i`), `GET /f/<token>` (link survey page) | n/a | |

Feedback widget = `kind: feedback`: fixed first question (`reaction`, 5 faces), optional comment,
optional element pick (`allow_element: true`: the visitor clicks the part of the page; stores its
stable selector, masked label and `top_pct`, the same describe code as clicks; no screenshot: the
recording at that moment is the screenshot, and `create_replay_link {session_id, start_ms}` opens
it).
Placement `side_tab` right/left. Responses read through the same routes (`?reaction_lte=2`).
Embedded = `kind: embedded {selector}`: rendered into the first element matching the selector
(Hotjar: 400-char selector, first match), so a "Was this page helpful?" block sits in the page.

Link survey = `kind: link`: `share_url` `https://<replay>/f/<token>` (token stored hashed,
revocable,
`max_responses`), CSP `script-src 'self'`, noindex, optional `?ref=` (max 100 chars, untrusted) so
an
agent can send per-recipient links with the mail app and join answers to its own ids. A hosted form
on our domain is a phishing surface, so: verified domain required, no `email` question, no links or
HTML in question text, a footer naming the site's domain and "never enter passwords", per-token and
per-network response caps.

Rendering: closed Shadow DOM, no inline script (CSP-safe), host element `data-afsr-block` so the
survey and its typed answers never enter the recording; answers travel only to `POST /f`. No
cookies: `frequency` flags in sessionStorage (`once_per_tab`) or localStorage `afsr_sv_<id>`
(`once_per_visitor`, documented in the privacy section). Exit intent: desktop pointer leaving
through
the top after >= 5 s; mobile falls back to `delay`. `frustration` trigger: the recorder's own
in-browser rage / error-click check (same thresholds as server signals) opens "Something not
working?", so the answer sits next to the failing click in the transcript. Neither vendor has it.
Delivery: `webhooks` events `survey.response` and `feedback.created` (section 9) replace Hotjar's
Slack, Teams, email and Zapier forwarding.

Fair use (vars, off when unset): MAX_SURVEYS_PER_SITE (10), MAX_ACTIVE_SURVEYS_PER_SITE (3),
MAX_QUESTIONS_PER_SURVEY (20), MAX_ANSWER_CHARS (2000), MAX_RESPONSES_PER_SITE_PER_DAY (500),
MAX_RESPONSES_PER_NETWORK_PER_SITE_PER_DAY (5), MAX_TEST_RESPONSES_PER_SITE_PER_DAY (20),
`UNCLAIMED_*` lower; unverified sites: `test` only. Responses follow `retention_days`
(`response_retention_days` up to MAX_RESPONSE_RETENTION_DAYS).

Skipped on purpose: Hotjar AI survey generator and AI response summaries (the calling agent writes
the questions and reads the answers; we return templates and deterministic themes), user
interviews / Engage (recruiting and scheduling people, video calls: not agent-operable;
Contentsquare
no longer sells it to new customers), full-screen takeover surveys (hurt the page the product
measures), the respondent screenshot option (the linked recording is the screenshot), per-question
images (upload and hosting for little gain).

## 8. Data API and export

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Export / reporting API | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api) (10 req/day, 1-3 days, 3 dims, 1,000 rows) | **Have** (ahead): every read over REST, any period within retention, cursors; fair use only | keep | - | - |
| Dimension breakdowns (browser, device, OS, country, URL, source, medium, campaign, channel) | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api) | **Partial**: summary groups devices, browsers, countries, entry/exit pages; UTMs never leave the browser | build `by=` in metrics; skip source/medium/campaign (stripped by design; analytics has them) | S | `GET /metrics?by=...` (section 4) |
| Session list export | [C](https://learn.microsoft.com/en-us/clarity/session-recordings/download-recordings) (CSV, 100k rows) [H](https://help.hotjar.com/hc/en-us/articles/36820033667729) (CSV/XLSX, 100k) | **Missing** (JSON pages only) | build | S | `GET /sessions?format=csv\|ndjson` (streams up to MAX_EXPORT_ROWS) |
| Raw recording export | [C](https://learn.microsoft.com/en-us/clarity/faq) (not possible) | **Partial**: rrweb chunks only through a share link | build (rrweb JSON is reusable: own player, frame renders) | S | `GET /sessions/:sid/events?from_seq&to_seq` (ndjson, daily byte budget). MCP `get_session_events` (r, paged) |
| MCP server | [C](https://learn.microsoft.com/en-us/clarity/third-party-integrations/clarity-mcp-server) (stdio, 3 tools, export-token limits) [CS MCP](https://support.contentsquare.com/hc/en-us/articles/52247834293905) (read-only, OAuth, 300 calls/month on Free; no Hotjar MCP) | **Have** (ahead): remote Streamable HTTP, 19 tools, read/write scopes, OAuth | keep | - | - |
| Docs tool in MCP | [C](https://github.com/microsoft/clarity-mcp-server) (`query-documentation-resources`) | **Partial**: MCP instructions + `GET /llms.txt` | build | S | MCP `get_manual {section?}` (r) |
| Dashboard / heatmap file downloads (PDF, PNG) | [C](https://learn.microsoft.com/en-us/clarity/insights/download-dashboard) | **Missing** | skip: JSON and CSV; agents render | - | - |

Hotjar's REST API ([H](https://help.hotjar.com/hc/en-us/articles/36820005914001): OAuth client
credentials, 3,000 requests/min; list surveys, survey responses, user lookup and deletion; nothing
for recordings or heatmaps; Scale plans) maps to section 7 responses, `get_visitor` and
`delete_visitor_data`.

## 9. Integrations

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Own analytics link | none | **Have**: `analytics_site_id`: tracker loads the recorder, signals forwarded as events, visitor id joined, saved funnels reused | keep | - | - |
| Google Analytics 4 | [C](https://learn.microsoft.com/en-us/clarity/ga-integration/ga4-integration) [H](https://help.hotjar.com/hc/en-us/articles/36819973021457) | **Missing** | adapt: forward settled signals to a tags container, which already sends GA4 Measurement Protocol | M | `tags_container_id` setting (like `analytics_site_id`) |
| Ads dashboards (Microsoft / Google Ads, UET) | [C](https://learn.microsoft.com/en-us/clarity/advertising-dashboard/ad-getting-started) | **Missing** | skip: tags owns ad platforms | - | - |
| Platform installs (Shopify, Wix, Squarespace, Webflow, ...) | [C](https://learn.microsoft.com/en-us/clarity/third-party-integrations/supported-third-party-platforms) [H](https://help.hotjar.com/hc/en-us/articles/36819973021457) | **Partial**: `framework=html\|nextjs\|react\|astro\|wordpress\|gtm` | build | S | add `shopify`, `webflow`, `wix`, `squarespace`, `framer` to `FRAMEWORKS` |
| Google Tag Manager | [C](https://learn.microsoft.com/en-us/clarity/third-party-integrations/google-tag-manager) | **Have**: `framework=gtm` | keep | - | - |
| Webhooks; Slack, Teams, Jira, Zapier, HubSpot | [H webhooks](https://help.hotjar.com/hc/en-us/articles/36820033755281) (`survey_response`, `recording` on segment match, HMAC) [H](https://help.hotjar.com/hc/en-us/articles/36819973021457) [C](https://learn.microsoft.com/en-us/clarity/third-party-integrations/hubspot-integration) | **Missing** | adapt: one signed webhook API (mail app pattern); skip per-vendor apps (Contentsquare drops webhooks and Zapier after migration) | M | `POST /v1/webhooks {url, site_id?, events: ["survey.response","feedback.created","segment.session","error.new","signal.spike"]}` -> secret once; `GET`, `DELETE`, `POST /v1/webhooks/:id/test`. MCP `create_webhook` (w), `list_webhooks` (r), `delete_webhook` (w), `test_webhook` (w) |
| A/B testing tools (Optimizely, AB Tasty, Kameleoon) | [C](https://learn.microsoft.com/en-us/clarity/third-party-integrations/supported-third-party-platforms) [H](https://help.hotjar.com/hc/en-us/articles/36819973021457) | **Missing** | adapt via custom tags (`afsr('set','exp_checkout','B')`) + heatmap `compare` | S (with tags) | - |
| Product analytics (Segment, Mixpanel, Amplitude) | [H](https://help.hotjar.com/hc/en-us/articles/36819973021457) | **Partial**: `afsr.sessionId()` as an event prop (documented for analytics) | build docs snippet per tool | S | `get_install_snippet` `with_tools` section |
| Team roles, members | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/team-management) | **Have**: site dashboard owner / member, claim links (`docs/accounts.md`) | keep | - | - |
| Browser extension (Clarity Live) | [C](https://learn.microsoft.com/en-us/clarity/clarity-features/clarity-live-extension) | **Missing** | skip: for people; share links cover them | - | - |
| Install prompt for coding agents | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/setup-clarity-for-vibe-coding-platforms) | **Have** (ahead): `llms.txt`, MCP instructions | keep | - | - |
| Install check, debug mode | [C](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup) (watch POSTs to /collect) [H](https://help.hotjar.com/hc/en-us/articles/36819964544913) (`?hjDebug=1`) | **Have** (ahead): `?afsr=1` + `verify_install` (checks, CSP, refused chunks by reason, fixes) | keep | - | - |

## Prioritised build list

Ordered by value to an agent per unit of effort, with dependencies first. Every item ships with
its REST route, MCP tool, llms.txt section, `next_steps` and a check the agent can run (repo rules).

| # | Build | Effort | Closes | Notes |
|---|---|---|---|---|
| 1 | Custom tags and identify attributes: `afsr('set')`, `afsr('identify', id, attrs)`, `hash_user_ids`, `tag=` filter | S | custom tags, identify, A/B tools | prerequisite for segments, metrics `by=tag:`, survey targeting |
| 2 | Filter additions + `!` negation + saved segments (`segment_id` on every read) | S | filters, segments, heatmap from segment | segments also feed webhooks (`segment.session`) |
| 3 | `get_replay_metrics` time series with `by=`, plus `active_ms` | S | trends, dashboard, watchlist, popular pages, referrers, dimension breakdowns, active time | the Clarity export API's questions with no 10-a-day cap |
| 4 | Failed network requests (`afs.net`, `api_error` signal, `list_errors?kind=network`) | M | network capture | neither Clarity nor Hotjar has it; the next "what is broken" signal after JS errors |
| 5 | Surveys v1: `popover`, `embedded`, `feedback`; templates; targeting and triggers (incl. exit intent, frustration); logic; frequency and limits; responses (+CSV); results; `link_session`; `test_survey`; deletion coverage | L (2 x M) | 13 of 14 survey rows | slice a: model, widget, `POST /f`, responses, test; slice b: results and themes, session filters and transcript lines, feedback element pick |
| 6 | Heatmap bundle: session filters, first/last click, compare, sort, `converted_event`, findings, CSV | S | 6 heatmap rows + heatmap insights | all from stored click rows; no recorder change |
| 7 | Notes, labels, starred (outlives retention), clip windows on links | S | notes, favourites, labels, highlights | agents leave findings people open from a link |
| 8 | Consent and exclusion: `require_consent: "eea"`, `consent_source: "gcm"`, `exclude_ip_ranges`, `afsr('upgrade')` / `afsr('start')` | S | region consent, GCM, IP exclusion, upgrade | matches Clarity's enforced EEA/UK/CH consent without cookies |
| 9 | Signed webhooks (`survey.response`, `feedback.created`, `segment.session`, `error.new`, `signal.spike`) | M | Slack/Teams/Jira/Zapier/HubSpot via webhook, survey forwarding, alerts | mail app's webhook pattern; after 5 so the survey events exist |
| 10 | Event definitions (retroactive, <= 20) + auto `form_submit`, `outbound_click`, `download` | M | smart events | usable as filters and funnel steps |
| 11 | Attention map and zones | M | attention, engagement zones, area maps | recorder tags zones at click time; new rollup column |
| 12 | Exports and small reads: sessions CSV/NDJSON, raw rrweb events, `get_visitor`, `get_manual`, funnel time to convert, `sort=clicks\|pageviews`, `active=true`, `console.warn` opt-in | S | session export, raw export, visitor profile, data access, docs tool, live list | |
| 13 | Install targets: shopify, webflow, wix, squarespace, framer; Segment/Mixpanel/Amplitude snippets | S | platform installs, product analytics | text and verify notes only |
| 14 | Link surveys (`/f/<token>`, `?ref=`) with phishing guards | M | link survey | after 5; verified domains only |
| 15 | Later: IAB TCF consent, GA4 via a tags container, heatmap PNG via Browser Rendering | M each | TCF, GA4, heatmap image | build on demand |

Not building (15 rows): mobile SDKs, user intent buckets, Core Web Vitals and e-commerce/content
reports in replay (analytics owns them), move maps, heatmap screenshot editing, custom dashboards,
hosted LLM summaries and chat, an npm package, PDF/PNG dashboard downloads, ads dashboards, a
browser
extension, AI survey builder, user interviews.

Timing note: Hotjar accounts are being moved to Contentsquare since 26 Aug 2026, Observe data does
not migrate, and webhooks and Zapier are dropped after the move. Items 5 and 9 are what a Hotjar
user would look for in a replacement.
