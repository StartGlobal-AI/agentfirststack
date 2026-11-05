# replay

Headless session replay, built so an agent can answer "why do visitors drop off, what's broken,
do people see the CTA" without watching videos. A browser recorder (rrweb, masked by default)
sends compressed chunks; the Worker derives what happened (pages, clicks with labels and stable
selectors, fields typed into, scroll reach, errors) and the per-site Durable Object detects
frustration signals, groups JS errors and aggregates heatmaps. The primitive is a **transcript**:
one readable line per event, so an agent can read 50 sessions in the time a person watches two.
REST and MCP for everything; a human player behind expiring share links.

`GET /llms.txt` is the full agent manual. Local port 8790; hosted at `replay.<domain>`.

## Agent quickstart

```sh
KEY=$(curl -s -X POST $BASE/v1/signup | jq -r .api_key)
SITE=$(curl -s -X POST $BASE/v1/sites -H "Authorization: Bearer $KEY" -d '{"domain":"example.com"}' | jq -r .site.id)
#   paste <script defer src="$BASE/r/$SITE.js"></script> into <head>
#   (already running AgentFirstStack analytics? pass "analytics_site_id":"site_..." above instead:
#   its tracker then loads the recorder by itself, site.loads_with_analytics = true, nothing to paste)
curl -X PATCH $BASE/v1/sites/$SITE -H "Authorization: Bearer $KEY" -d '{"unmask_selectors":["nav","button","a","h1","h2","label"]}'
#   open https://example.com/?afsr=1 once (forces a recording), click around
curl -X POST $BASE/v1/sites/$SITE/verify -H "Authorization: Bearer $KEY"   # also verifies the domain
curl "$BASE/v1/sites/$SITE/sessions?sort=frustration&page=/checkout*" -H "Authorization: Bearer $KEY"
curl "$BASE/v1/sites/$SITE/sessions/$SID/transcript" -H "Authorization: Bearer $KEY" | jq -r .transcript
curl "$BASE/v1/sites/$SITE/summary?page=/checkout*&period=7d" -H "Authorization: Bearer $KEY"
```

A transcript looks like this (labels as recorded; `*` is masked text, `{...}` a selector for the live page):

```
[00:00.0] page "/pricing" · load · from "google.com" · stayed 15s · saw 64% of the page
[00:05.1] click button "Start trial" {"#plans > div:nth-of-type(2) > button.cta"}
[00:07.9] typed into input[type=email] "Email" name="email" {"#signup input[name=\"email\"]"} (value masked)
[00:09.3] click x4 in 0.8s button "Pay" {"#checkout button.pay"}  [RAGE DEAD ERROR-CLICK]
[00:09.5] JS error "TypeError: Cannot read properties of undefined (reading 'id')" at "https://example.com/app.js:1:2345" after click on {"#checkout button.pay"}  [ERROR-CLICK]
[00:15.0] page "/signup" · push · from "/pricing" · stayed 2s · saw 30% of the page  [QUICK-BACK]
```

## Architecture

```
browser ── /r/<site>.js (2 KB loader, config inlined) ── decides: enabled? GPC/DNT? sampled? consent?
   │        └─ lazy-loads /rec/<hash>.js after load (rrweb record + our events, 32 KB gzip)
   │           masks in the browser, gzip (CompressionStream), fetch keepalive (sendBeacon fallback)
   └─ POST /i?s=&sid=&q=&z= ──► Worker: edge rate limits, site + account standing, Origin + page
                                 hostname check, size caps, gunzip (capped), strict envelope, bot
                                 filter (forced: own quota), derive the chunk (lib/derive.ts, bounded)
                                   ├─► ReplaySiteDO (one SQLite DO per site): session index, pages,
                                   │   derived events, signal resolution across chunks, non-decreasing
                                   │   daily counters and caps, frustration score, heatmap rollups,
                                   │   drop counters, its own retention alarm; reports usage to D1
                                   │   (account_usage) at most once a minute for account/deployment budgets
                                   ├─► R2 CHUNKS: <site_id>/<session_id>/<seq 6 digits> (gzip, as received);
                                   │   starred sessions' copies under starred/<site_id>/ (no lifecycle rule)
                                   ├─► (optional, verified sites) TAGS service binding: chosen signals and survey
                                   │   scores as server events, batched by the DO's alarm (tags_outbox)
                                   └─► (optional, verified sites) ANALYTICS service binding: settled signals
agent ── REST /v1 or MCP /mcp ──► src/service/* ──► DO queries (search, transcript, summary,
                                                    heatmap, errors, funnel) + R2 (player, deletion)
person ── /play/<token> ──► rrweb-player page (CSP script-src 'self') ──► /play/<token>/{data,chunks/<seq>}
agent ── GET /v1/sites/:id/heatmap/image ──► latest stored snapshot (R2) -> static HTML + overlay -> BROWSER
                                              (Browser Rendering screenshot, JS off) -> R2 heatmaps/<site>/ (a day)
visitor ── /sv/<site>.<rev>.js (survey widget, lazy, closed Shadow DOM) ── POST /f (impressions, answers)
                                 └─► ReplaySiteDO: survey_responses (linked to the session), daily caps
events ──► D1 webhook_deliveries ──► signed POST now; retries on the site DO's alarm (10 s ... 1 h, 8 tries)
DO alarm (hourly per site with data) ──► roll settled days into heatmap aggregates, purge past
                  retention (rows, then R2 keys from r2_pending until R2 confirms), housekeeping
cron (hourly) ──► R2 cleanup of deleted sites (own budget), a daily kick of each site's DO, expired
                  links and old usage rows
```

Code layout: `src/index.ts` (Hono app, `fetch` + `scheduled`, exports `ReplaySiteDO`),
`src/routes/api.ts` (REST, thin), `src/routes/public.ts` (loader, recorder, ingest, player),
`src/mcp.ts` (MCP, thin), `src/service/*` (all logic, shared by both), `src/do/` (`site-do.ts`
the class, `engine.ts` schema + ingest + retention, `queries.ts` reads; both run on a tiny `Db`
interface so unit tests use node:sqlite), `src/lib/*` (pure: `derive`, `signals`, `transcript`,
`mask-rules`, `describe`, `fingerprint`, `protocol`, `selectors`, `limits`, `time`, `ua`),
`src/recorder/` and `src/player/` (browser code, own tsconfigs, bundled by
`scripts/build-recorder.mjs` into `dist/*.txt` Text modules), `src/llms.ts`,
`migrations/0002_replay.sql` (D1: `sites`, `replay_links`, `r2_cleanup`), `migrations/0006_verification_usage.sql`
(D1: verification columns, `account_usage`, `verify_log`), `migrations/0008_parity.sql` (D1, additive: site settings for
tags hashing, network/console capture, consent, IP ranges, zones, auto events; `segments`, `surveys`, `event_definitions`,
`webhooks`, `webhook_deliveries`, `webhook_usage`; clip columns on `replay_links`). The DO schema is versioned
(`meta.schema_version`; v2 replaced `events_kind_ts` + `events_click_path` with one partial index `events_ce` and added the
daily counters, tombstones, `r2_pending` and `link_usage`; v3, additive: `session_tags`, `session_labels`, `notes`,
`survey_responses` / `survey_daily` / `survey_net_daily` / `survey_versions`, `error_groups`, `segment_hits`, the partial
index `events_nw` (failed requests, console warnings), and columns for active time, attention, referrer, starred, upgraded,
zones and chunk snapshots); existing objects migrate in place when they start. New code: `src/survey/widget.ts` (the
survey widget, own tsconfig, `dist/survey.txt`), `src/lib/{survey,survey-def,survey-results,themes,ip,hash,csv,webhook-url}.ts`,
`src/do/{surveys,annotations}.ts`, `src/service/{segments,metrics,surveys,survey-ingest,annotations,event-definitions,exports,webhooks,webhook-events}.ts`.

- **Ingest is split for CPU:** decompressing and deriving happen in the stateless Worker; the
  per-site DO only inserts a few dozen rows per chunk and re-evaluates signals in a window of a
  few seconds around it, so one busy site doesn't serialise heavy work in its DO. Every step is
  bounded (`src/lib/limits.ts`).
- **The browser describes interactions.** Element selectors, labels (masked by the site's rules),
  "interactive or not" and positions are computed in the browser at click time and sent as rrweb
  custom events, so the server never needs the DOM to say what was clicked. Everything in a chunk
  is still validated, clipped and clamped server-side (anyone can POST a chunk).
- **Signals across chunk boundaries:** a click whose 1 s window runs past its chunk is `open`; the
  next chunk's first-second effect timestamps (stored per chunk) or a navigation resolve it, in
  either arrival order. Rage and error clicks are recomputed for clicks within 1.5 s of the new
  chunk using clicks within 3 s, which is exact for the updated range. Quick backs and dwell are
  recomputed over the session's pageviews.
- **Clock skew:** the skew measured on a session's first chunk (server time vs the client's send
  time, when over a minute) is stored and applied to every chunk of the session, so order holds.
- **Heatmaps** are read live from the derived clicks and pageviews; the hourly cron rolls settled
  days (two days back) into `heat_daily` / `scroll_daily` before retention deletes the rows, and
  queries use the aggregates for rolled days. Aggregates have no visitor or session reference.

## Recorder

`/r/<site>.js` (loader, ~3.5 KB, 1.7 KB gzip) and `/rec/<hash>.js` (~97 KB, 32 KB gzip,
immutable; the old `/recorder.<hash>.js` path is still served). Both are also served under any path prefix, and the loader derives its base from its
own `src`, so a first-party proxy of `/<prefix>/*` works unchanged.

- **Not recorded:** GPC or DNT, `localStorage.afsr_ignore`, not sampled in (`sample_rate`, decided
  once per tab), `exclude_paths` (also on SPA navigation; recording resumes with a new snapshot on
  an allowed path), `enabled: false`, automated browsers (server-side: `navigator.webdriver`, bot
  user agents), and with `require_consent` everything before `afsr('consent', true)`.
- **`?afsr=1`** (or `localStorage.afsr_force`) forces recording of the tab, bypassing sampling
  and bot filtering, so an agent can verify an install from a headless browser. Sessions carry
  `forced: true` and count against `MAX_FORCED_SESSIONS_PER_SITE_PER_DAY` (default 20) instead;
  their signals go to analytics and tags as test traffic.
- **No cookies.** The per-tab session (id, chunk counter, pageview counter, sampling decision,
  identify) is in sessionStorage. It spans page loads in the tab, ends after 30 idle minutes or
  `max_session_minutes`. After 5 minutes without input, recording pauses until the next input.
- **https only:** `/i` and `/f` refuse a plain `http://` Origin (403 `origin_not_https`); `wrangler dev`
  (`DEV_MODE`) also accepts `http://localhost` and `http://127.0.0.1`.
- **Batches:** a chunk every 5 s or 800 events; the DOM snapshot goes alone. gzip with
  CompressionStream, `fetch` with `keepalive` under 63 KB. On tab hide and pagehide the rest goes
  uncompressed with a keepalive `fetch` (a CORS request, so it always carries the page's Origin;
  `sendBeacon` only where keepalive is missing). A `stop: true` answer ends recording for the tab.
- **Events added to rrweb's** (`src/lib/protocol.ts`): `afs.page`, `afs.click` (with its heatmap zone),
  `afs.input` (first input into a field per pageview), `afs.scroll` (throttled), `afs.error` (uncaught,
  unhandled rejection, console.error, opt-in console.warn; errors before the recorder loads are queued by
  the loader), `afs.event` (also `form_submit` with `auto_events`), `afs.tag`, `afs.net` (a failed
  fetch/XHR with `capture_network_errors`: method, scrubbed path, status, duration; never headers or
  bodies), `afs.hide`, `afs.idle`.
- **Consent:** `require_consent: true | "eea"` (EEA, UK, CH and unknown countries only; the loader is then
  served `private`), `consent_source: "gcm"` follows Google Consent Mode's `analytics_storage` in
  `dataLayer`; `consent_source: "tcf"` follows an IAB TCF v2 CMP (`__tcfapi`): consent (never legitimate
  interest) for every purpose in `tcf_purposes`, default 1 "Store and/or access information on a device" and
  8 "Measure content performance" (9 or 10 may stand in for 8), in the purpose or publisher consents;
  `gdprApplies: false` records, no CMP = no consent, the TC string is never stored. `exclude_ip_ranges` (CIDRs) are refused at ingest; the address is never stored.
- **Page API:** `afsr.sessionId()`, `afsr.status()`, `afsr('identify', id, attrs?)` (attrs become tags; with
  `hash_user_ids` the id is hashed in the browser), `afsr('set', key, value | values)` (custom tags: 20 keys, 5 values,
  100 characters, scrubbed), `afsr('event', name, props)`, `afsr('consent', bool)`, `afsr('stop')`, `afsr('start')`
  (resumes after stop or withdrawn consent), `afsr('upgrade', reason)` (records an unsampled tab; own daily cap),
  `afsr('survey', id)`, `afsr('feedback')`. With the analytics tracker on the page, its
  `afsa.visitorId()` is attached to every chunk (`analytics_visitor_id`). To link the other way,
  send `afsr.sessionId()` as a prop on analytics events.
- **Loaded by the analytics tracker (no second snippet).** Linking a site (`analytics_site_id`) sets
  that analytics site's `replay_site_id` to it over the `ANALYTICS` binding; the analytics tracker
  then adds `<script async src="<replay>/r/<site>.js">` once per page load (analytics needs
  `REPLAY_BASE_URL`). `loads_with_analytics` is true once analytics confirmed it. An analytics
  failure never fails the replay call: it is logged, `loads_with_analytics` stays false, and
  `notes` say to PATCH the same `analytics_site_id` again, which re-asserts the link. Unlinking,
  moving the link or deleting the site clears the old analytics site's `replay_site_id`, only while
  it still names this site. One analytics site loads one replay site (linking a second one moves
  it). Analytics accepts `replay_site_id` only from this link (internal auth), never from an API key.
  The direct snippet stays the alternative for pages without the tracker and for a strict CSP
  (the tracker fetches the loader from the replay host directly). Unlinked sites on an account with
  analytics get `suggested_analytics_site_id` in install responses instead of a second snippet.

## Privacy

| | |
|---|---|
| Text | `strict` (default): every text node and text attribute (title, alt, placeholder, aria-label, ...) masked in the browser (`*` per character), except `unmask_selectors` / `[data-afsr-unmask]`. `balanced`: digits and emails masked. `relaxed`: only `mask_selectors` / `[data-afsr-mask]` masked. Until the domain is verified the loader masks strictly whatever the settings. Mask checks cross shadow roots |
| Inputs | Every value masked in every mode. Only `[data-afsr-unmask]` on the page itself shows a value (never `unmask_selectors`), and never for password, hidden, payment-card (`cc-*`), one-time-code and secret-named fields |
| Attributes | An allowlist (`src/lib/attrs.ts`): layout and state kept, text-like ones and `data-*` / `aria-*` values masked like text (UI states such as `data-state="open"` kept), the rest dropped (event handlers, `nonce`, `<meta content>`, unknown attributes) |
| URLs | Query strings and fragments removed from every URL: page (rrweb Meta), links, forms, images, `srcset`, iframes, CSS `url()`. Id-like path segments (emails, long numbers, uuids, tokens) of the page and links become `:id`, also in stored paths. `mailto:` / `tel:` keep only the scheme. Click labels skip masked and blocked parts |
| Blocking | `block_selectors` / `[data-afsr-block]`: not recorded, a same-size placeholder is. `[data-afsr-ignore]`: no input or clicks |
| Errors | Messages and stacks scrubbed of emails, long numbers, 32+ character tokens and query strings |
| Storage | No cookies; sessionStorage per tab. Server stores the parsed device class, browser, OS, country/region/city (from Cloudflare), a 16-hex prefix of the user agent's SHA-256 (binds a session id to one browser) and, per day, a salted hash of the client network for the per-network cap. Never the IP. Refused requests' samples (Origin hostname, user agent) are kept a day |
| Deletion | `delete_session`, `delete_visitor_data {user_id | analytics_visitor_id | session_ids}` (DO rows, R2 chunks retried until confirmed, share links; ids refused for two days so open tabs can't recreate them). Retention purge hourly on each site's alarm. Signal events already forwarded to analytics stay there (analytics has no per-visitor deletion yet) |
| Exclusions | `exclude_paths` travel in the public loader as salted hashes (exact paths and `prefix*` globs); `exclude_ip_ranges` are checked at ingest and never stored with the address |
| Tags, ids | Custom tags and identify attributes are capped and scrubbed like error messages; `hash_user_ids` hashes ids in the browser (SHA-256, site id as salt) |
| Failed requests | Method, path without query (id-like segments `:id`), status and duration only; never headers or bodies; off by default |
| Surveys | The widget renders in a closed Shadow DOM on a `data-afsr-block` host (never recorded), text only (no HTML); answers are validated, size-capped and scrubbed (`scrub_pii`, default on); linked to the session only with `link_session` auto/ask; GPC/DNT browsers see no survey unless `show_with_gpc`; no cookies (frequency in session/localStorage) |
| Deletion of new data | Tags, labels, notes, segment hits and linked survey responses go with their session; `delete_visitor_data {user_id}` also deletes a visitor's responses whose session is gone; `get_visitor` shows everything stored about a visitor |

## Surveys and feedback

On-site only (popover, embedded, feedback tab), shown by the loader already on the page: with active
surveys (`sites.surveys_rev`) the loader lazy-loads `/sv/<site>.<rev>.js` (~6 KB gzip, the widget with the
site's active surveys inlined; `private, max-age=300`, since country targeting is decided there) after the
load event, whatever the recording decision. Templates (nps, csat, ces, pmf, free_text), question types
(reaction, short/long text, single/multi choice, rating 5/7/10, nps, statement, and opt-in email: never required,
sent only with a ticked consent box whose line is the question's `consent_text`, kept in the response only:
transcripts, webhooks and results say "given", filters and themes skip it), forward-only skip logic,
targeting (pages, devices, countries, tags, identified, browser-checkable segments, sample rate), triggers
(load, delay, scroll %, exit intent, frustration after a rage or error click detected in the browser,
`afsr('survey', id)`), frequency and limits. Answers go to `POST /f` (an https Origin on the site's hosts, 60 KB, strict
body, answers validated against the survey's current version and scrubbed) and into the site's DO; a response
linked to a recorded session is a transcript line and a session filter (`survey_id`, `survey_answer`).
Results are deterministic (NPS, top-two share, means, PMF share, text themes from recurring words and
phrases). `test_survey` returns a `?afsr_survey=rsv_<id>.<token>` preview URL (token valid 24 h, stored on
the survey) that shows the survey at once; only that token lets test impressions and responses in (own
quota), and it checks that an impression and a response arrived. Unverified domains: drafts only. API
output puts survey texts (name, questions, strings) and response paths under `untrusted`.

The widget's safety rules (on customers' pages): closed Shadow DOM, host with `data-afsr-block` and
`data-afsr-ignore` that gets its shadow root before it is attached (rrweb never sees it), every string set
with `textContent`, no `innerHTML`, eval or cookies, the accent colour re-checked as `#rgb`/`#rrggbb` before it
becomes a CSS custom property, styles through `adoptedStyleSheets` (a strict `style-src` CSP doesn't break it),
the recorder drops pointer moves and clicks over the widget's host (`data-afsr-survey`), so a replay can't
show where an answer was clicked, the feedback element pick keeps only a stable selector and position (a transparent overlay in the shadow
root takes every pointer event meanwhile, with a Cancel button, so the page's own controls never fire),
typing/input/clipboard/focus events stop at the shadow root, a text box never takes the focus unless the
visitor opened the survey, posts go with `credentials: "omit"`. What isn't isolated: a page script
listening in the capture phase, or wrapping `attachShadow` / `fetch` before the widget loads, can still
see input; rrweb keeps recording pointer movement over the blocked placeholder.

## Webhooks

`POST /v1/webhooks {url, events, site_id?, segment_id?}` (the project's own key; verified sites only):
`survey.response`, `feedback.created`, `segment.session`, `error.new`, `signal.spike`. The secret (shown
once) is sealed with `ENCRYPTION_KEY`; deliveries are D1 rows sent right after the event and retried with
backoff (10 s, 30 s, 1 min, 5 min, 15 min, 30 min, 1 h) by the site's Durable Object alarm, claimed
atomically so the Worker and the alarm never both send one; URLs (https, a hostname, no credentials, not the
platform's own domain, port 443) are re-checked before every attempt; attempts are counted when a
delivery is claimed, so one that dies with the Worker still counts; the receiver's body is never stored;
a 410 disables the webhook; per-account daily
delivery and test caps; logs kept 7 days. Signatures: `x-signature: t=<s>,v1=<hex HMAC-SHA256(secret,
"<t>.<body>")>`, the mail app's format.

## Signals

| Signal | Definition |
|---|---|
| `rage_click` | >= 3 clicks within 1 s on the same element (selector) or within 30 px, same pageview; one burst counts once |
| `dead_click` | no DOM change, scroll, input, navigation or page hide within 1 s; clicks focusing a text field or label never count. `dead_clicks_interactive` = on buttons, links, role=button, cursor:pointer, ... |
| `error_click` | a JS error within 1 s after a click; the error records the click's selector and label |
| `quick_back` | A -> B -> A with at most 7 s on B, flagged on B |
| `excessive_scroll` | one pageview with >= 4 direction reversals (40 px hysteresis) and >= 2.5x its scrollable height scrolled |
| `js_error` | uncaught errors, unhandled rejections, console.error (`capture_console_errors`) |
| `api_error` | a fetch/XHR answered >= 400 or failed (`capture_network_errors`); one within 1 s of a click records that click |

Frustration score 0-100 (`src/lib/signals.ts`): rage burst 25, error click 20, interactive dead
click 10, other dead click 2 (max 10), JS error 8 (max 32), quick back 10, excessive scroll 10, failed request 6 (max 24).

With `analytics_site_id` set, the domain verified, and the `ANALYTICS` binding + `INTERNAL_TOKEN`
present, settled signals (at most `MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY`, default 500) are posted to that analytics site (`POST /v1/sites/:id/events`, internal auth) as
`rage_click`, `dead_click` (interactive, outside rage bursts), `error_click`, `js_error` (once per
fingerprint per session), `quick_back`, `excessive_scroll`, with `replay_session_id`, selector and
label props, joined to the visitor by `afsa.visitorId()` or, failing that, IP + user agent (the
same cookieless hash analytics computes). "Settled" = 1.5 s inside the chunk's coverage, or the
page ended; nothing is sent twice. Test traffic is sent with `debug: true` (analytics keeps it out of
reports): every signal of a forced `?afsr=1` session, and those forwarded with a chunk recorded while
analytics debug was on for the page (envelope `dbg: 1`: `?afsa_debug=1` in the URL, or sessionStorage
`afsa_debug` = "1", which the analytics tracker keeps for the tab).

With `tags_container_id` set (a tags container on the same account, checked with tags
`GET /v1/containers/:id`), the domain verified, and the `TAGS` binding + `INTERNAL_TOKEN` present, the
signals in `tags_signals` (`rage_click`, `dead_click`, `js_error`, `api_error`, `survey_response`; default
all) go to that container as server events, the route backends use (`POST /v1/containers/:id/events`,
internal auth): queued in the site's DO (`tags_outbox`, its own bit in `events.forwarded` and counter
`daily.tags_forwarded`, at most `MAX_TAGS_EVENTS_PER_SITE_PER_DAY`, default 500), sent by the DO's
alarm in batches of up to 100 within 15 s, 429/5xx/binding failures retried (30 s doubling, at most an
hour; dropped after a day or 8 tries), other 4xx dropped and logged; the last answer shows in
`data.tags_forwarding`. Test traffic (forced sessions, analytics debug pages, survey responses in a forced
session) is queued marked and sent in batches of its own with tags' `test: true`. Events carry a fixed `event_id` (tags dedupes retries), `page_url`, `send_to.ga4`
(the container's GA4 destination gets them by name; a conversion of the same name in its config wins and is
needed for ad platforms), `params`
(ids, selector, error fingerprint/message, method/url/status, NPS and rating scores), and `visitor_id` =
the tags runtime's `afst.visitorId()` (read by the recorder and widget only while linked, config `tg`) so
tags applies that visitor's consent, or else an explicit consent with every ad purpose denied. No IP, user
agent, user id, label, typed value or survey text. Survey responses: completed, non-test, with an NPS or
rating answer only.

## API (under `/v1`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (`@afs/shared`) |
| GET | `/me`; GET, POST `/keys`; DELETE `/keys/:id` | `@afs/shared` |
| DELETE | `/account` | the platform's own (internal auth only, no MCP tool; API keys get 403 `forbidden`): 7 days after a project is deleted, the site's cron erases its replay data here (`src/service/purge.ts`): every site (its Durable Object, D1 rows, and its R2 chunks, queued for the hourly cron), then its webhooks and their deliveries. Keeps the bare `accounts` row and the fair-use counters. `done: false` = call again; a live project gets 409 `not_deleted`. Deleting a project reads as suspended at once, so recording and its share links stop |
| POST | `/sites` | `{ domain, ...settings }`; same domain returns existing (200); 403 `quota_exceeded` past `MAX_SITES_PER_ACCOUNT`, 403 `verification_required` past `MAX_UNVERIFIED_SITES_PER_ACCOUNT`; IPs, TLDs and public suffixes refused (400) |
| GET | `/sites`, `/sites/:id` | list; one with a data summary (sessions, last chunk, bytes, today's counters, hostnames, chunks refused by reason), its `limits`, and `untrusted.drop_samples` |
| PATCH, DELETE | `/sites/:id` | settings (lists replaced whole, caps clamped and reported in `notes`); delete removes everything (R2 by cron) |
| GET | `/sites/:id/install` | `?framework=html\|nextjs\|react\|astro\|wordpress\|gtm` |
| POST | `/sites/:id/verify` | `{ url? }`: page fetch (https on the domain or a subdomain, port 443), snippet (or the linked analytics site's tracker, checked live with analytics), script, CSP (path-scoped advice), domain verification (homepage loader, the linked analytics site's tracker on the homepage = `homepage_analytics`, or DNS TXT; the homepage is exactly `https://<domain>/`, fetched by verify itself, never a passed `url` with a query string, fragment or other path, and only parsed `<script src>` tags count: a loader URL in inline code, a comment or an attribute is reported as `inline`, never proof), sessions received, drops, masking advice; `MAX_VERIFY_PER_ACCOUNT_PER_HOUR` |
| GET | `/sites/:id/sessions` | filters (below), `sort=frustration\|recent\|duration`, `limit`, `cursor` |
| GET | `/sites/:id/sessions/:sid` | facts + pages (dwell, scroll reach, quick back, excessive scroll) |
| GET | `/sites/:id/sessions/:sid/transcript` | `?format=text\|json&max_events=&kinds=` |
| DELETE | `/sites/:id/sessions/:sid` | recording, derived events, links |
| GET | `/sites/:id/summary` | filters or `session_ids`, `limit` (sessions considered), `top` |
| GET | `/sites/:id/heatmap` | `?page=<glob>&device=&type=click\|scroll\|both&period=&limit=` |
| GET | `/sites/:id/heatmap/image` | `?page=&device=desktop\|mobile\|tablet&type=click\|scroll\|attention&period=&max_height=` -> PNG (Browser Rendering; verified sites; cached a day) |
| GET | `/sites/:id/errors` | `?period=&page=&device=&browser=&fingerprint=&limit=` |
| GET | `/sites/:id/funnel` | `?steps=/a,/b*,event:x` or `analytics_funnel_id=`, `drop_step=`, filters |
| POST | `/sites/:id/delete-visitor-data` | `{ user_id? \| analytics_visitor_id? \| session_ids? }` |
| POST, GET | `/sites/:id/links` | create `{ session_id, expires_in? }` (verified sites only; not with an OAuth access token; URL shown once) / list `?session_id=` |
| DELETE | `/sites/:id/links/:link_id` | revoke |
| POST, GET, PATCH, DELETE | `/sites/:id/segments[/:seg_id]` | saved filters (idempotent by name, `matching_now`); `segment_id=` on every read |
| GET | `/sites/:id/metrics` | trends per hour/day/week, `by=page\|referrer\|device\|browser\|os\|country\|entry_page\|exit_page\|tag:<key>` |
| PATCH | `/sites/:id/sessions/:sid` | `{ starred?, labels? }` |
| POST, GET, DELETE | `/sites/:id/sessions/:sid/notes[/:note_id]` | notes at a point in time (transcript and player) |
| GET | `/sites/:id/labels` | labels in use |
| GET | `/sites/:id/sessions/:sid/events` | raw rrweb events, NDJSON, paged by chunk, daily byte budget |
| GET | `/sites/:id/visitors` | `?user_id=\|analytics_visitor_id=`: everything stored about a visitor |
| POST, GET, PATCH, DELETE | `/sites/:id/surveys[/:sv]` | on-site surveys (popover, embedded, feedback), templates, targeting, triggers, logic |
| POST | `/sites/:id/surveys/:sv/test` | preview URL + checks (impression and response seen) |
| GET, DELETE | `/sites/:id/surveys/:sv/responses[/:rid]` | `?format=json\|ndjson\|csv`, filters |
| GET | `/sites/:id/surveys/:sv/results` | funnel, NPS, distributions, text themes |
| POST, GET, DELETE | `/sites/:id/event-definitions[/:evd_id]` | events from clicks / page visits after the fact |
| POST, GET, DELETE | `/webhooks[/:id]` | signed webhooks (secret once); POST `/webhooks/:id/test` |
| GET | `/manual` | `?section=`: the manual by section |

Session filters: `period` (`1h`, `24h`, `today`, `yesterday`, `7d`, `30d`, `90d`, `180d`, `365d`,
`all`) or `from`/`to`, `page`, `entry_page`, `exit_page` (path globs, `*` = anything), `signal`,
`has_error`, `device`, `browser`, `os`, `country`, `min_duration`/`max_duration` (seconds),
`min_frustration`, `user_id`, `analytics_visitor_id`, `clicked`, `error_fingerprint`, `event`,
`forced`, plus `segment_id`, `referrer`, `region`, `city`, `min_pageviews`, `min_scroll_pct`, `min_active`, `tag`
(`plan:pro`, `!exp:B`), `label`, `starred`, `upgraded`, `active`, `survey_id` + `survey_answer`; text filters negate
with a leading `!`. Sorts: frustration, recent, duration, clicks, pageviews, active. `format=csv|ndjson` exports.

Public: `GET /` (service info), `GET /llms.txt`, `GET /r/<site>.js`, `GET /rec/<hash>.js` (and `/recorder.<hash>.js`),
`POST|OPTIONS /i`, `GET /sv/<site>.<rev>.js` (survey widget; `?preview=rsv_...`), `POST|OPTIONS /f` (survey impressions and answers), `GET /play/<token>` (+ `/data`, `/chunks/<seq>`), `GET /assets/player-<hash>.{js,css}`,
`/.well-known/oauth-protected-resource[/mcp]`, `POST /mcp`.

Responses put page-derived strings (paths, titles, labels, selectors, error messages, event names,
user ids) and refused requests' samples under an `untrusted` key; text transcripts fence the timeline as
`<<<UNTRUSTED_REPLAY_TRANSCRIPT_<nonce> ... UNTRUSTED_REPLAY_TRANSCRIPT_<nonce>>>` with a per-call nonce,
and quote every recorded value as one JSON string. Control characters, line/paragraph separators, bidi
overrides and zero-width characters are removed when chunks are stored.

## MCP tools

`create_replay_site`, `list_replay_sites`, `get_replay_site`, `update_replay_site`,
`delete_replay_site`, `get_install_snippet`, `verify_install`, `search_sessions`, `get_session`,
`get_session_transcript`, `summarize_sessions`, `get_heatmap`, `list_errors`,
`get_funnel_dropoffs`, `delete_session`, `delete_visitor_data`, `create_replay_link`,
`list_replay_links`, `revoke_replay_link`, and since the parity release `get_manual`, `export_sessions`,
`get_session_events`, `get_visitor`, `get_replay_metrics`, `label_session`, `list_labels`, `add_session_note`,
`list_session_notes`, `delete_session_note`, `define_event`, `list_event_definitions`, `delete_event_definition`,
`create_segment`, `list_segments`, `update_segment`, `delete_segment`, `create_survey`, `list_surveys`, `get_survey`,
`update_survey`, `delete_survey`, `test_survey`, `list_survey_responses`, `get_survey_results`, `delete_survey_response`,
`create_webhook`, `list_webhooks`, `get_webhook`, `delete_webhook`, `test_webhook`, and since wave 2
`get_heatmap_image` (51 tools). Each calls the same service function as its REST route;
write tools are hidden from read-only keys; tools that return recorded content say in their
description that it is untrusted.

## Human player

`create_replay_link` (verified sites only; the project's own key, since a connected app's OAuth
access token gets `403 temporary_credential`) returns `/play/rpt_<32 chars>` (only the SHA-256 is stored;
default 7 days, max 30; revocable; views counted). The page is a static shell with no inline script,
served with `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' <site hosts>;
img-src 'self' data: blob: <site hosts>; font-src data: <site hosts>; connect-src 'self';
frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, where the site hosts are
`https://<domain> https://*.<domain>` and `allowed_hostnames`; `referrer-policy: no-referrer`,
`noindex`. The bundled rrweb-player (skip inactivity, speed) rebuilds the masked page in its
`sandbox="allow-same-origin"` iframe (recorded scripts never run); the sidebar lists the timeline with
signals, click to seek. A link serves only chunks ingest accepted with rrweb events, at most
`MAX_LINK_BYTES_PER_DAY` per day; the player holds at most 64 MB / 300k events. If the site isn't
verified any more (domain changed), the page shows an "unverified site" banner, no domain and no
replay. Links of suspended accounts stop working.

## Config

| Var / secret | |
|---|---|
| `PUBLIC_BASE_URL` | var; the URL used in snippets, links and llms.txt (empty = request origin) |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | `@afs/shared` auth (`SIGNUP_MODE` is a var, the tokens are secrets) |
| `AUTH_ISSUER`, `INTERNAL_TOKEN` | `@afs/shared`: the OAuth server named in `/.well-known/oauth-protected-resource` (var; set by `pnpm afs`), and the secret the site's dashboard uses for internal auth. `INTERNAL_TOKEN` also turns on analytics forwarding (with the `ANALYTICS` binding) and tags forwarding (with the `TAGS` binding) |
| `KEY_PREFIX` | var; prefix of minted keys (`afs`) |
| `DEV_MODE` | `"true"` only in local `.dev.vars`: honours `x-dev-geo-country/-region/-city`, accepts `localhost`/`127.0.0.1` origins and page hosts and `localhost` as a site domain, lets verify fetch localhost (and count a localhost page with the loader as domain verification) |
| `SIGNUP_HOURLY_LIMIT` | optional var; signups per network per hour (`@afs/shared`) |
| `MAX_SITES_PER_ACCOUNT` | replay sites per account (unset = no cap) |
| `MAX_UNVERIFIED_SITES_PER_ACCOUNT` | sites whose domain isn't verified, per account (unset = 1) |
| `MAX_SAMPLE_RATE` | cap on every site's `sample_rate`, 0..1 (unset = 1) |
| `MAX_SESSION_MINUTES` | cap on `max_session_minutes` (unset = 240) |
| `MAX_SESSIONS_PER_SITE_PER_DAY` | new sessions per site per UTC day (non-decreasing counter), more get 429 `daily_session_limit` and the recorder stops (unset = no cap) |
| `MAX_UNVERIFIED_SESSIONS_PER_SITE_PER_DAY` | the trial quota while the domain isn't verified (unset = 20) |
| `MAX_FORCED_SESSIONS_PER_SITE_PER_DAY` | `?afsr=1` sessions per site per day (unset = 20) |
| `MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY` | new sessions per client network (IPv4, IPv6 /48) per site per day (unset = 50) |
| `MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY` | analytics events forwarded per site per day (unset = 500) |
| `MAX_TAGS_EVENTS_PER_SITE_PER_DAY` | signals and survey scores queued for the linked tags container per site per day (unset = 500) |
| `MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY`, `MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY`, `MAX_PLATFORM_HEATMAP_IMAGES_PER_DAY` | heatmap images rendered per UTC day (unset = 10 / 30 / 300; cached images are free). Browser Rendering bills browser time: about 2-5 s per image, so 300 a day is at most ~12 browser hours a month |
| `MAX_CHUNK_BYTES` | compressed bytes per ingest request, below the built-in 1 MB (unset = 1 MB) |
| `MAX_SESSION_BYTES` | stored bytes per session, below the built-in 20 MB (unset = 20 MB) |
| `MAX_CHUNKS_PER_SESSION` | chunks per session, below the built-in 2,000 |
| `MAX_DERIVED_PER_CHUNK`, `MAX_DERIVED_PER_SESSION` | derived events kept per chunk / session (unset = 500 / 1,500; at most 2,000 / 10,000) |
| `MAX_SESSIONS_PER_ACCOUNT_PER_DAY`, `MAX_CHUNKS_PER_ACCOUNT_PER_DAY`, `MAX_BYTES_PER_ACCOUNT_PER_DAY`, `MAX_DERIVED_PER_ACCOUNT_PER_DAY` | an account's daily budget across its sites (429 `account_daily_limit`); each site's DO reports to D1 `account_usage` at most once a minute (sooner near a cap), so the overshoot is about a minute of traffic (unset = no cap) |
| `MAX_PLATFORM_SESSIONS_PER_DAY`, `MAX_PLATFORM_CHUNKS_PER_DAY`, `MAX_PLATFORM_BYTES_PER_DAY`, `MAX_PLATFORM_DERIVED_PER_DAY` | the deployment's daily budget: past it ingest answers 429 `platform_budget` to everyone (UNCLAIMED_ variants: a lower line for unclaimed accounts) (unset = no cap) |
| `MAX_RETENTION_DAYS` | cap on `retention_days` (unset = 365) |
| `MAX_HEATMAP_RETENTION_DAYS` | cap on `heatmap_retention_days` (unset = 730) |
| `MAX_LINKS_PER_SITE` | active share links per site (unset = no cap) |
| `MAX_LINK_BYTES_PER_DAY` | recorded bytes one share link serves per UTC day (unset = 50 MB) |
| `MAX_VERIFY_PER_ACCOUNT_PER_HOUR` | verify calls per account per hour (unset = 30) |
| `CAPTURE_CONSOLE_ERRORS_DEFAULT` | `false`: new sites start with `capture_console_errors` off |
| `CAPTURE_NETWORK_ERRORS_DEFAULT` | `true`: new sites start with `capture_network_errors` on (unset = off) |
| `ENCRYPTION_KEY` | secret, 32 bytes base64: seals webhook secrets at rest. Without it webhooks can't be created (503 `webhooks_unavailable`; `DEV_MODE` stores them plain) |
| `MAX_UPGRADED_SESSIONS_PER_SITE_PER_DAY` | new sessions `afsr('upgrade')` may start per site per day (unset = 50) |
| `MAX_SEGMENTS_PER_SITE` | saved segments (unset = 50) |
| `MAX_EVENT_DEFINITIONS_PER_SITE` | event definitions (unset = 20) |
| `MAX_STARRED_SESSIONS_PER_SITE`, `MAX_STARRED_RETENTION_DAYS`, `MAX_STARRED_BYTES_PER_SITE` | starred sessions at once (unset = 100), how long they outlive `retention_days` (unset = 90 days; not a count cap) and the bytes a site may keep in their playback copies (unset = 200 MB). A starred session's chunks are copied to `starred/<site_id>/<session_id>/<seq>` (counted against the daily byte budgets) so its playback outlives an R2 lifecycle rule that covers only `rsite_` (the live chunks' prefix); the copy goes when the session is unstarred, deleted or past `MAX_STARRED_RETENTION_DAYS` |
| `MAX_NOTES_PER_SESSION`, `MAX_NOTES_PER_SITE`, `MAX_LABELS_PER_SITE` | notes (unset = 50 / 2,000), distinct labels (unset = 1,000) |
| `MAX_SURVEYS_PER_SITE`, `MAX_ACTIVE_SURVEYS_PER_SITE`, `MAX_QUESTIONS_PER_SURVEY`, `MAX_ANSWER_CHARS` | surveys (unset = 10 / 3 / 20 / 2,000; the last two can only go lower) |
| `MAX_RESPONSES_PER_SITE_PER_DAY`, `MAX_RESPONSES_PER_NETWORK_PER_SITE_PER_DAY`, `MAX_TEST_RESPONSES_PER_SITE_PER_DAY`, `MAX_IMPRESSIONS_PER_NETWORK_PER_SITE_PER_DAY` | survey responses and impressions (unset = 500 / 5 / 20 / 50); a response also counts 1 derived row and its bytes, an impression 1 derived row, against the account and deployment budgets |
| `MAX_WEBHOOKS_PER_ACCOUNT`, `MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY`, `MAX_WEBHOOK_TESTS_PER_DAY` | webhooks (unset = 10 / 1,000 / 50) |
| `MAX_EXPORT_ROWS`, `MAX_EXPORT_BYTES_PER_DAY` | rows per session export (unset = 10,000, at most 100,000), recorded bytes raw event exports read per site per day (unset = 100 MB) |

All the count caps above are optional vars read through `capFor()` (`@afs/shared`): each also takes
`UNCLAIMED_<NAME>`, applied to accounts no person has claimed (agent-only). `"0"` means a cap of 0.

Site settings (`POST`/`PATCH /v1/sites`): `name`, `enabled` (true), `sample_rate` (1),
`mask_mode` (`strict`), `unmask_selectors`, `mask_selectors`, `block_selectors`, `zones`, `exclude_paths`,
`exclude_ip_ranges`, `allowed_hostnames`, `max_session_minutes` (30), `retention_days` (30), `heatmap_retention_days`
(180), `capture_console_errors` (true), `capture_console_warnings` (false), `capture_network_errors` (false),
`auto_events` (true), `require_consent` (false | true | "eea"), `consent_source` (api | gcm), `hash_user_ids` (false),
`analytics_site_id` (site JSON adds `loads_with_analytics`).

Built-in limits (always on, `src/lib/limits.ts`): 1 MB compressed / 8 MB decompressed per chunk,
20 MB and 2,000 chunks per session, 50,000 rrweb events looked at per chunk, derived events per chunk
and session as above, 20 clicks in any 1 s window, 500 pageviews and 300 errors per session (more is
stored, not derived; the session's `limited` says why), 50 errors per page in the browser.

Bindings (`wrangler.jsonc`): D1 `DB` (`afs-replay`, placeholder id) and `AUTH_DB` (`afs-identity`),
R2 `CHUNKS` (`afs-replay-chunks`), Durable Object `SITE` (`ReplaySiteDO`, SQLite, migration `v1`),
optional services `ANALYTICS` (`afs-analytics`) and `TAGS` (`afs-tags`), optional Browser Rendering `BROWSER` (heatmap images; local mode under `wrangler dev`), rate limits `SIGNUP_LIMITER` (namespace 41001,
shared), `INGEST_IP_LIMITER` (42031, 600/min per client network, loader + ingest + survey widget and posts, before any D1 read),
`INGEST_SITE_IP_LIMITER` (42032, 120/min per site and network), `INGEST_SITE_LIMITER` (42033,
3,000/min per site), hourly cron `23 * * * *`, DO alarms (retention, signal spikes, webhook retries), observability on. No queues: webhook retries run on each site's DO alarm. `compatibility_date` 2026-08-01
(the workerd bundled with `@cloudflare/vitest-plugin` 1.5).

## Develop and test

```sh
pnpm typecheck               # wrangler types + tsc for the Worker, the recorder and the player
pnpm test                    # builds dist/*.txt, then unit (Node) + integration (workerd)
cp .dev.vars.example .dev.vars && pnpm db:migrate:local && pnpm dev   # http://localhost:8790
pnpm smoke                   # against BASE (default http://localhost:8790); needs curl, jq, node, gzip
BASE=http://localhost:8791 pnpm smoke   # when 8790 is taken: run `wrangler dev --port 8791` instead
```

- `test/unit/` (Node): `derive.test.ts` (envelope parsing, chunk derivation, dead and open clicks,
  focus clicks, malformed and out-of-range input, clipping, caps, early errors, skew shift, scroll
  segments, error fingerprints), `signals.test.ts` (rage, error clicks, quick backs, excessive
  scroll, score), `masking.test.ts` (mask modes, inputs always masked, URL and text scrubbing,
  globs, selector validation, the loader config, stable selectors and labels on a fake DOM),
  `engine.test.ts` (the DO engine on node:sqlite: counters, duplicate seqs, late page events,
  dead clicks resolved across chunks in both arrival orders within a session, rage and error clicks across
  boundaries, quick backs, excessive scroll merging, daily/byte/duration/browser limits, session
  skew, analytics forwarding once, search filters and cursor, summaries, heatmaps live vs rolled
  up, error groups, funnels, deletion and purge), `transcript.test.ts` (ordering, rage folding,
  the fenced text format), `bundles.test.ts` (size budgets, masking switches in the bundle, the
  loader in a fake browser: GPC/DNT, sampling, `?afsr=1`, session reuse and expiry, consent, queue),
  `hardening.test.ts` (domain rules, URL/text/attribute scrubbing, typed values, click labels, linear
  rage detection, forced/network/account/deployment caps, tombstones, `r2_pending`, bounded purge
  and rollup, sampled drops, share-link chunk budget, the in-place v1 -> v2 DO migration and the
  partial index in query plans).
- `test/integration/` (workerd, D1 + DO + R2): every REST route and MCP tool, the loader and
  recorder scripts (ETag, prefix), ingest end to end (gzip and plain) and every refusal, caps,
  deletion from DO and R2, share links and the player (CSP, data, chunks, revoke), verify with a
  stubbed fetch, analytics forwarding, funnels and the replay_site_id link (link, move, unlink,
  delete, repair, suggestions, verify by the analytics tracker) through a stubbed `ANALYTICS` binding, the
  cron's purge and rollup, site deletion with the DO tombstone, read-only keys, llms.txt coverage;
  `hardening.test.ts`: Origin and page-host checks, the trial quota and verification (homepage and
  DNS TXT), forced and per-network quotas, account and deployment budgets, suspension, edge rate
  limits, the DO alarm and the cron's per-site isolation, share links (per-site CSP, byte budget,
  unverified banner), verify's fetch rules and rate limit, deletion tombstones, junk envelopes, and a
  measurement of DO rows written per click (3.2, was 5.2 with the old indexes).
- Parity release: `test/unit/parity.test.ts` (tags, filters and negation, active time, metrics, failed requests,
  heatmap first/last/conversion, notes/labels/stars/clips, CIDRs and consent countries, upgraded caps, error groups,
  segment hits, spikes, event definitions, attention and zones), `test/unit/surveys.test.ts` (skip logic, definitions,
  answer validation, results and themes, CSV, DO caps and deletion), `test/unit/survey-widget.test.ts` (the built widget
  in a fake DOM: closed shadow root on a blocked host, text only, posts, targeting, frequency, GPC, link_session, the
  loader's survey loading), loader tests for Consent Mode, upgrade and start in `bundles.test.ts`;
  `test/integration/{parity,surveys,webhooks}.test.ts` (every new route and MCP tool end to end).
- `scripts/smoke.sh`: the whole path over HTTP against `wrangler dev`.

## Not yet

- Analytics funnels linking to sessions from the analytics side: needs changes in `analytics/`.
- Link surveys on a hosted page (`/f/<token>`): a form on this service's domain is a phishing surface until user content
  has its own domain.
- Heatmap images of SPA route changes (only page loads carry a full snapshot) and of pages whose images or fonts are
  served from hosts outside the site's domain and `allowed_hostnames` (the render doesn't fetch them).
- Web Vitals per session (analytics owns them), canvas, cross-origin iframes.
- A duplicated browser tab shares its sessionStorage, so both tabs send the same session id and
  seq numbers; the second tab's chunks are dropped as duplicates.
