# Proposal: AgentFirstStack Replay (headless session replay, heatmaps, frustration signals)

Status: proposal, not built. Research behind it: [analytics-landscape.md, section 3](../research/analytics-landscape.md#3-behaviour-analytics-product-notes-a-possible-headless-clarity).

## Why

Clarity and Hotjar answer "why": why people drop at /signup, what's broken, whether anyone sees the
CTA. Both are built for a person watching videos. Clarity's export API allows 10 requests a day
covering the last 1-3 days, and Hotjar is now part of Contentsquare with no new standalone
accounts. An agent can barely get anything out of either.

The headless version changes the primitive: **a session is a short, readable transcript**, not a
video. An agent can read 50 of them in the time a person watches two, group them, and come back
with "38 of 50 visitors who left /checkout rage-clicked the disabled Pay button on iOS Safari".

## What it answers

1. Why do visitors drop off at this step? (funnel step to the sessions that dropped there)
2. Is something broken? (rage clicks, dead clicks, error clicks, JS errors by page and browser)
3. Do people see the CTA or the content below the fold? (scroll reach)
4. What do people click that isn't clickable, and what do they ignore? (click maps as data)
5. Mobile vs desktop on this page.
6. What happened in this customer's session? (identified user, support ticket)
7. Did the release change behaviour? (before/after, written as an annotation by the deploying agent)

## Shape

A fourth app, `replay/` at `replay.agentfirststack.com`, with the same rules as the others: one
signup key, REST and MCP for everything, `llms.txt`, verifiable setup.

- **No new snippet.** The analytics tracker lazy-loads the recorder only on sites with replay
  turned on (`POST /v1/sites/:id/replay {sample_rate, mask, block_selectors}`). Recordings carry the
  analytics visitor and session ids, so every replay already has its channel, campaign, goals and
  revenue, and every analytics filter works on replays.
- **Recorder:** rrweb (MIT), the same approach PostHog and Datadog use: one DOM snapshot, then
  mutations, clicks, scrolls, input changes and viewport changes. Compressed in the browser, sent in
  batches.
- **Privacy by default:** all text and inputs masked in the browser before anything leaves
  (Clarity's "Strict"), unmask by selector, passwords always masked, query strings dropped, GPC/DNT
  honoured, no new cookies. Per-visitor deletion (Clarity can't do this).
- **Storage:** chunks in R2 (planning figure 20-100 KB per recorded minute compressed), a per-site
  Durable Object for the session index, signals and heatmap aggregates. Heatmaps don't need full
  recordings: click and scroll aggregates are under 1 KB per pageview.

## Headless primitives (REST + MCP)

| Call | Returns |
|---|---|
| `search_sessions {filters, signal?, sort: frustration\|recent}` | session ids with duration, pages, signals, frustration score |
| `get_session_transcript {session_id}` | compact text: pages, clicked element labels and selectors, masked inputs, scrolls, errors, signals, timestamps |
| `summarize_sessions {session_ids \| filters}` | grouped patterns across many sessions, computed without a model |
| `get_heatmap {url, device, type: click\|scroll}` | clicks per element (selector, label, count, rage/dead share), scroll-reach curve; optional PNG for people |
| `get_funnel_dropoffs {funnel_id, step}` | sessions that dropped at that step |
| `list_errors {page?, browser?}` | JS errors grouped by fingerprint, with the triggering click |
| `create_replay_link {session_id, expires_in}` | a share link to a human player (skip inactivity, event timeline, masked page) |

Frustration signals (rage, dead and error clicks, quick backs, excessive scrolling) are also written
into analytics as events, so `breakdown=page&filters=event_name==rage_click` works with no new
API.

## Hosted fair use (defaults, all vars)

Sample rate 10%, 30 minutes per session maximum, 1,000 recorded sessions per site per day, 30-day
retention, heatmap aggregates 6 months.

## Build order

1. Recorder behind the analytics tracker, ingest to R2, session index, transcript endpoint.
2. Frustration signals and JS errors, written to analytics.
3. Heatmap aggregates and funnel step to sessions.
4. Human player behind share links; alerts on new error types and rage-click spikes (through the
   alerts that analytics gets first).

Roughly the size of the mail app. Surveys and feedback widgets (Hotjar's "Ask") are a separate
product and are left out.
