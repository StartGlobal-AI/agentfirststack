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
curl -X PATCH $BASE/v1/sites/$SITE -H "Authorization: Bearer $KEY" -d '{"unmask_selectors":["nav","button","a","h1","h2","label"]}'
#   open https://example.com/?afsr=1 once (forces a recording), click around
curl -X POST $BASE/v1/sites/$SITE/verify -H "Authorization: Bearer $KEY"
curl "$BASE/v1/sites/$SITE/sessions?sort=frustration&page=/checkout*" -H "Authorization: Bearer $KEY"
curl "$BASE/v1/sites/$SITE/sessions/$SID/transcript" -H "Authorization: Bearer $KEY" | jq -r .transcript
curl "$BASE/v1/sites/$SITE/summary?page=/checkout*&period=7d" -H "Authorization: Bearer $KEY"
```

A transcript looks like this (labels as recorded; `*` is masked text, `{...}` a selector for the live page):

```
[00:00.0] page /pricing · load · from google.com · stayed 15s · saw 64% of the page
[00:05.1] click button "Start trial" {#plans > div:nth-of-type(2) > button.cta}
[00:07.9] typed into input[type=email] "Email" name=email {#signup input[name="email"]} (value masked)
[00:09.3] click x4 in 0.8s button "Pay" {#checkout button.pay}  [RAGE DEAD ERROR-CLICK]
[00:09.5] JS error "TypeError: Cannot read properties of undefined (reading 'id')" at https://example.com/app.js:1:2345 after click on {#checkout button.pay}  [ERROR-CLICK]
[00:15.0] page /signup · push · from /pricing · stayed 2s · saw 30% of the page  [QUICK-BACK]
```

## Architecture

```
browser ── /r/<site>.js (2 KB loader, config inlined) ── decides: enabled? GPC/DNT? sampled? consent?
   │        └─ lazy-loads /recorder.<hash>.js after load (rrweb record + our events, 29 KB gzip)
   │           masks in the browser, gzip (CompressionStream), fetch keepalive / sendBeacon
   └─ POST /i?s=&sid=&q=&z= ──► Worker: origin + hostname check, size caps, gunzip (capped),
                                 envelope check, bot filter, derive the chunk (lib/derive.ts, bounded)
                                   ├─► ReplaySiteDO (one SQLite DO per site): session index, pages,
                                   │   derived events, signal resolution across chunks, counters,
                                   │   frustration score, daily caps, heatmap rollups, drop counters
                                   ├─► R2 CHUNKS: <site_id>/<session_id>/<seq 6 digits> (gzip, as received)
                                   └─► (optional) ANALYTICS service binding: settled signals as events
agent ── REST /v1 or MCP /mcp ──► src/service/* ──► DO queries (search, transcript, summary,
                                                    heatmap, errors, funnel) + R2 (player, deletion)
person ── /play/<token> ──► rrweb-player page (CSP script-src 'self') ──► /play/<token>/{data,chunks/<seq>}
cron (hourly) ──► roll settled days into heatmap aggregates, purge past retention (DO + R2),
                  finish R2 cleanup of deleted sites, drop expired links
```

Code layout: `src/index.ts` (Hono app, `fetch` + `scheduled`, exports `ReplaySiteDO`),
`src/routes/api.ts` (REST, thin), `src/routes/public.ts` (loader, recorder, ingest, player),
`src/mcp.ts` (MCP, thin), `src/service/*` (all logic, shared by both), `src/do/` (`site-do.ts`
the class, `engine.ts` schema + ingest + retention, `queries.ts` reads; both run on a tiny `Db`
interface so unit tests use node:sqlite), `src/lib/*` (pure: `derive`, `signals`, `transcript`,
`mask-rules`, `describe`, `fingerprint`, `protocol`, `selectors`, `limits`, `time`, `ua`),
`src/recorder/` and `src/player/` (browser code, own tsconfigs, bundled by
`scripts/build-recorder.mjs` into `dist/*.txt` Text modules), `src/llms.ts`,
`migrations/0002_replay.sql` (D1: `sites`, `replay_links`, `r2_cleanup`).

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

`/r/<site>.js` (loader, ~2.3 KB, 1.3 KB gzip) and `/recorder.<hash>.js` (~89 KB, 29 KB gzip,
immutable). Both are also served under any path prefix, and the loader derives its base from its
own `src`, so a first-party proxy of `/<prefix>/*` works unchanged.

- **Not recorded:** GPC or DNT, `localStorage.afsr_ignore`, not sampled in (`sample_rate`, decided
  once per tab), `exclude_paths` (also on SPA navigation; recording resumes with a new snapshot on
  an allowed path), `enabled: false`, automated browsers (server-side: `navigator.webdriver`, bot
  user agents), and with `require_consent` everything before `afsr('consent', true)`.
- **`?afsr=1`** (or `localStorage.afsr_force`) forces recording of the tab, bypassing sampling
  and bot filtering, so an agent can verify an install from a headless browser. Sessions carry
  `forced: true`.
- **No cookies.** The per-tab session (id, chunk counter, pageview counter, sampling decision,
  identify) is in sessionStorage. It spans page loads in the tab, ends after 30 idle minutes or
  `max_session_minutes`. After 5 minutes without input, recording pauses until the next input.
- **Batches:** a chunk every 5 s or 800 events; the DOM snapshot goes alone. gzip with
  CompressionStream, `fetch` with `keepalive` under 63 KB. On tab hide and pagehide the rest goes
  uncompressed with `sendBeacon`. A `stop: true` answer ends recording for the tab.
- **Events added to rrweb's** (`src/lib/protocol.ts`): `afs.page`, `afs.click`, `afs.input` (first
  input into a field per pageview), `afs.scroll` (throttled), `afs.error` (uncaught, unhandled
  rejection, console.error; errors before the recorder loads are queued by the loader), `afs.event`,
  `afs.hide`, `afs.idle`.
- **Page API:** `afsr.sessionId()`, `afsr.status()`, `afsr('identify', id)`, `afsr('event', name,
  props)`, `afsr('consent', bool)`, `afsr('stop')`. With the analytics tracker on the page, its
  `afsa.visitorId()` is attached to every chunk (`analytics_visitor_id`). To link the other way,
  send `afsr.sessionId()` as a prop on analytics events (the analytics tracker is not changed here).

## Privacy

| | |
|---|---|
| Text | `strict` (default): every text node and text attribute (title, alt, placeholder, aria-label, ...) masked in the browser (`*` per character), except `unmask_selectors` / `[data-afsr-unmask]`. `balanced`: digits and emails masked. `relaxed`: only `mask_selectors` / `[data-afsr-mask]` masked |
| Inputs | Every value masked in every mode. `unmask_selectors` can show a value, except password, hidden, payment-card (`cc-*`), one-time-code and secret-named fields, which are always masked |
| URLs | Query strings and fragments removed from the page URL (rrweb Meta), link `href`s and form actions. Image, stylesheet and font URLs are kept so the player can load them |
| Blocking | `block_selectors` / `[data-afsr-block]`: not recorded, a same-size placeholder is. `[data-afsr-ignore]`: no input or clicks |
| Errors | Messages and stacks scrubbed of emails, long numbers, 32+ character tokens and query strings |
| Storage | No cookies; sessionStorage per tab. Server stores the parsed device class, browser, OS, country/region/city (from Cloudflare) and a 16-hex prefix of the user agent's SHA-256 (binds a session id to one browser). Never the IP |
| Deletion | `delete_session`, `delete_visitor_data {user_id | analytics_visitor_id | session_ids}` (DO rows, R2 chunks, share links). Retention purge hourly |

## Signals

| Signal | Definition |
|---|---|
| `rage_click` | >= 3 clicks within 1 s on the same element (selector) or within 30 px, same pageview; one burst counts once |
| `dead_click` | no DOM change, scroll, input, navigation or page hide within 1 s; clicks focusing a text field or label never count. `dead_clicks_interactive` = on buttons, links, role=button, cursor:pointer, ... |
| `error_click` | a JS error within 1 s after a click; the error records the click's selector and label |
| `quick_back` | A -> B -> A with at most 7 s on B, flagged on B |
| `excessive_scroll` | one pageview with >= 4 direction reversals (40 px hysteresis) and >= 2.5x its scrollable height scrolled |
| `js_error` | uncaught errors, unhandled rejections, console.error (`capture_console_errors`) |

Frustration score 0-100 (`src/lib/signals.ts`): rage burst 25, error click 20, interactive dead
click 10, other dead click 2 (max 10), JS error 8 (max 32), quick back 10, excessive scroll 10.

With `analytics_site_id` set and the `ANALYTICS` binding + `INTERNAL_TOKEN` present, settled
signals are posted to that analytics site (`POST /v1/sites/:id/events`, internal auth) as
`rage_click`, `dead_click` (interactive, outside rage bursts), `error_click`, `js_error` (once per
fingerprint per session), `quick_back`, `excessive_scroll`, with `replay_session_id`, selector and
label props, joined to the visitor by `afsa.visitorId()` or, failing that, IP + user agent (the
same cookieless hash analytics computes). "Settled" = 1.5 s inside the chunk's coverage, or the
page ended; nothing is sent twice.

## API (under `/v1`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (`@afs/shared`) |
| GET | `/me`; GET, POST `/keys`; DELETE `/keys/:id` | `@afs/shared` |
| POST | `/sites` | `{ domain, ...settings }`; same domain returns existing (200); 403 `quota_exceeded` past `MAX_SITES_PER_ACCOUNT` |
| GET | `/sites`, `/sites/:id` | list; one with a data summary (sessions, last chunk, bytes, hostnames, chunks refused by reason) |
| PATCH, DELETE | `/sites/:id` | settings (lists replaced whole, caps clamped and reported in `notes`); delete removes everything (R2 by cron) |
| GET | `/sites/:id/install` | `?framework=html\|nextjs\|react\|astro\|wordpress\|gtm` |
| POST | `/sites/:id/verify` | `{ url? }`: page fetch, snippet, script, CSP, sessions received, drops, masking advice |
| GET | `/sites/:id/sessions` | filters (below), `sort=frustration\|recent\|duration`, `limit`, `cursor` |
| GET | `/sites/:id/sessions/:sid` | facts + pages (dwell, scroll reach, quick back, excessive scroll) |
| GET | `/sites/:id/sessions/:sid/transcript` | `?format=text\|json&max_events=&kinds=` |
| DELETE | `/sites/:id/sessions/:sid` | recording, derived events, links |
| GET | `/sites/:id/summary` | filters or `session_ids`, `limit` (sessions considered), `top` |
| GET | `/sites/:id/heatmap` | `?page=<glob>&device=&type=click\|scroll\|both&period=&limit=` |
| GET | `/sites/:id/errors` | `?period=&page=&device=&browser=&fingerprint=&limit=` |
| GET | `/sites/:id/funnel` | `?steps=/a,/b*,event:x` or `analytics_funnel_id=`, `drop_step=`, filters |
| POST | `/sites/:id/delete-visitor-data` | `{ user_id? \| analytics_visitor_id? \| session_ids? }` |
| POST, GET | `/sites/:id/links` | create `{ session_id, expires_in? }` (URL shown once) / list `?session_id=` |
| DELETE | `/sites/:id/links/:link_id` | revoke |

Session filters: `period` (`1h`, `24h`, `today`, `yesterday`, `7d`, `30d`, `90d`, `180d`, `365d`,
`all`) or `from`/`to`, `page`, `entry_page`, `exit_page` (path globs, `*` = anything), `signal`,
`has_error`, `device`, `browser`, `os`, `country`, `min_duration`/`max_duration` (seconds),
`min_frustration`, `user_id`, `analytics_visitor_id`, `clicked`, `error_fingerprint`, `event`,
`forced`.

Public: `GET /` (service info), `GET /llms.txt`, `GET /r/<site>.js`, `GET /recorder.<hash>.js`,
`POST|OPTIONS /i`, `GET /play/<token>` (+ `/data`, `/chunks/<seq>`), `GET /assets/player-<hash>.{js,css}`,
`/.well-known/oauth-protected-resource[/mcp]`, `POST /mcp`.

Responses put page-derived strings (paths, titles, labels, selectors, error messages, event names,
user ids) under an `untrusted` key; text transcripts fence the timeline as
`<<<UNTRUSTED_REPLAY_TRANSCRIPT_<nonce> ... UNTRUSTED_REPLAY_TRANSCRIPT_<nonce>>>` with a per-call nonce.

## MCP tools

`create_replay_site`, `list_replay_sites`, `get_replay_site`, `update_replay_site`,
`delete_replay_site`, `get_install_snippet`, `verify_install`, `search_sessions`, `get_session`,
`get_session_transcript`, `summarize_sessions`, `get_heatmap`, `list_errors`,
`get_funnel_dropoffs`, `delete_session`, `delete_visitor_data`, `create_replay_link`,
`list_replay_links`, `revoke_replay_link`. Each calls the same service function as its REST route;
write tools are hidden from read-only keys; tools that return recorded content say in their
description that it is untrusted.

## Human player

`create_replay_link` returns `/play/rpt_<32 chars>` (only the SHA-256 is stored; default 7 days,
max 30; revocable; views counted). The page is a static shell with no inline script, served with
`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https:; img-src 'self'
https: data: blob:; font-src https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri
'none'; form-action 'none'`, `referrer-policy: no-referrer`, `noindex`. The bundled rrweb-player
(skip inactivity, speed) rebuilds the masked page in its `sandbox="allow-same-origin"` iframe
(recorded scripts never run); the sidebar lists the timeline with signals, click to seek. Images,
fonts and stylesheets load from the recorded site, like Clarity and Hotjar.

## Config

| Var / secret | |
|---|---|
| `PUBLIC_BASE_URL` | var; the URL used in snippets, links and llms.txt (empty = request origin) |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | `@afs/shared` auth (`SIGNUP_MODE` is a var, the tokens are secrets) |
| `AUTH_ISSUER`, `INTERNAL_TOKEN` | `@afs/shared`: the OAuth server named in `/.well-known/oauth-protected-resource` (var; set by `pnpm afs`), and the secret the site's dashboard uses for internal auth. `INTERNAL_TOKEN` also turns on analytics forwarding (with the `ANALYTICS` binding) |
| `KEY_PREFIX` | var; prefix of minted keys (`afs`) |
| `DEV_MODE` | `"true"` only in local `.dev.vars`: honours `x-dev-geo-country/-region/-city`, accepts `localhost`/`127.0.0.1` origins and page hosts, lets verify fetch localhost |
| `SIGNUP_HOURLY_LIMIT` | optional var; signups per network per hour (`@afs/shared`) |
| `MAX_SITES_PER_ACCOUNT` | optional var; replay sites per account (unset = no cap) |
| `MAX_SAMPLE_RATE` | optional var; cap on every site's `sample_rate`, 0..1 (unset = 1). Proposal's hosted figure: 0.1 |
| `MAX_SESSION_MINUTES` | optional var; cap on `max_session_minutes` (unset = 240). Hosted: 30 |
| `MAX_SESSIONS_PER_SITE_PER_DAY` | optional var; new sessions per site per UTC day, more get 429 `daily_session_limit` and the recorder stops (unset = no cap). Hosted: 1000 |
| `MAX_CHUNK_BYTES` | optional var; compressed bytes per ingest request, below the built-in 1 MB (unset = 1 MB) |
| `MAX_SESSION_BYTES` | optional var; stored bytes per session, below the built-in 20 MB (unset = 20 MB) |
| `MAX_RETENTION_DAYS` | optional var; cap on `retention_days` (unset = 365). Hosted: 30 |
| `MAX_LINKS_PER_SITE` | optional var; active share links per site (unset = no cap) |

Site settings (`POST`/`PATCH /v1/sites`): `name`, `enabled` (true), `sample_rate` (1),
`mask_mode` (`strict`), `unmask_selectors`, `mask_selectors`, `block_selectors`, `exclude_paths`,
`allowed_hostnames`, `max_session_minutes` (30), `retention_days` (30), `heatmap_retention_days`
(180), `capture_console_errors` (true), `require_consent` (false), `analytics_site_id`.

Built-in limits (always on, `src/lib/limits.ts`): 1 MB compressed / 8 MB decompressed per chunk,
20 MB and 2,000 chunks per session, 50,000 rrweb events looked at and 2,000 facts derived per
chunk, 10,000 derived events, 500 pageviews and 300 errors per session (more is stored, not derived;
the session's `limited` says why), 50 errors per page in the browser.

Bindings (`wrangler.jsonc`): D1 `DB` (`afs-replay`, placeholder id) and `AUTH_DB` (`afs-identity`),
R2 `CHUNKS` (`afs-replay-chunks`), Durable Object `SITE` (`ReplaySiteDO`, SQLite, migration `v1`),
optional service `ANALYTICS` (`afs-analytics`), rate limit `SIGNUP_LIMITER` (namespace 41001,
shared), hourly cron `23 * * * *`, observability on. No queues. `compatibility_date` 2026-08-01
(the workerd bundled with `@cloudflare/vitest-pool-workers` 0.23).

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
  dead clicks resolved across chunks in both arrival orders, rage and error clicks across
  boundaries, quick backs, excessive scroll merging, daily/byte/duration/browser limits, session
  skew, analytics forwarding once, search filters and cursor, summaries, heatmaps live vs rolled
  up, error groups, funnels, deletion and purge), `transcript.test.ts` (ordering, rage folding,
  the fenced text format), `bundles.test.ts` (size budgets, masking switches in the bundle, the
  loader in a fake browser: GPC/DNT, sampling, `?afsr=1`, session reuse and expiry, consent, queue).
- `test/integration/` (workerd, D1 + DO + R2): every REST route and MCP tool, the loader and
  recorder scripts (ETag, prefix), ingest end to end (gzip and plain) and every refusal, caps,
  deletion from DO and R2, share links and the player (CSP, data, chunks, revoke), verify with a
  stubbed fetch, analytics forwarding and funnels through a stubbed `ANALYTICS` binding, the
  cron's purge and rollup, site deletion with the DO tombstone, read-only keys, llms.txt coverage.
- `scripts/smoke.sh`: the whole path over HTTP against `wrangler dev`.

## Not yet

- The analytics tracker lazy-loading the recorder ("no new snippet") and analytics funnels linking
  to sessions from the analytics side: need changes in `analytics/` (see the integration notes).
- Alerts on new error types and rage-click spikes (build-order step 4, waits for analytics alerts).
- Rendered heatmap PNGs for people, Web Vitals per session, network request capture, canvas,
  cross-origin iframes, raw recording export over the API.
- A duplicated browser tab shares its sessionStorage, so both tabs send the same session id and
  seq numbers; the second tab's chunks are dropped as duplicates.
