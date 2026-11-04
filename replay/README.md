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
   │        └─ lazy-loads /rec/<hash>.js after load (rrweb record + our events, 31 KB gzip)
   │           masks in the browser, gzip (CompressionStream), fetch keepalive (sendBeacon fallback)
   └─ POST /i?s=&sid=&q=&z= ──► Worker: edge rate limits, site + account standing, Origin + page
                                 hostname check, size caps, gunzip (capped), strict envelope, bot
                                 filter (forced: own quota), derive the chunk (lib/derive.ts, bounded)
                                   ├─► ReplaySiteDO (one SQLite DO per site): session index, pages,
                                   │   derived events, signal resolution across chunks, non-decreasing
                                   │   daily counters and caps, frustration score, heatmap rollups,
                                   │   drop counters, its own retention alarm; reports usage to D1
                                   │   (account_usage) at most once a minute for account/deployment budgets
                                   ├─► R2 CHUNKS: <site_id>/<session_id>/<seq 6 digits> (gzip, as received)
                                   └─► (optional, verified sites) ANALYTICS service binding: settled signals
agent ── REST /v1 or MCP /mcp ──► src/service/* ──► DO queries (search, transcript, summary,
                                                    heatmap, errors, funnel) + R2 (player, deletion)
person ── /play/<token> ──► rrweb-player page (CSP script-src 'self') ──► /play/<token>/{data,chunks/<seq>}
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
(D1: verification columns, `account_usage`, `verify_log`). The DO schema is versioned (`meta.schema_version`;
v2 replaced `events_kind_ts` + `events_click_path` with one partial index `events_ce` and added the daily
counters, tombstones, `r2_pending` and `link_usage`); existing objects migrate in place when they start.

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

`/r/<site>.js` (loader, ~2.3 KB, 1.3 KB gzip) and `/rec/<hash>.js` (~94 KB, 31 KB gzip,
immutable; the old `/recorder.<hash>.js` path is still served). Both are also served under any path prefix, and the loader derives its base from its
own `src`, so a first-party proxy of `/<prefix>/*` works unchanged.

- **Not recorded:** GPC or DNT, `localStorage.afsr_ignore`, not sampled in (`sample_rate`, decided
  once per tab), `exclude_paths` (also on SPA navigation; recording resumes with a new snapshot on
  an allowed path), `enabled: false`, automated browsers (server-side: `navigator.webdriver`, bot
  user agents), and with `require_consent` everything before `afsr('consent', true)`.
- **`?afsr=1`** (or `localStorage.afsr_force`) forces recording of the tab, bypassing sampling
  and bot filtering, so an agent can verify an install from a headless browser. Sessions carry
  `forced: true` and count against `MAX_FORCED_SESSIONS_PER_SITE_PER_DAY` (default 20) instead.
- **No cookies.** The per-tab session (id, chunk counter, pageview counter, sampling decision,
  identify) is in sessionStorage. It spans page loads in the tab, ends after 30 idle minutes or
  `max_session_minutes`. After 5 minutes without input, recording pauses until the next input.
- **Batches:** a chunk every 5 s or 800 events; the DOM snapshot goes alone. gzip with
  CompressionStream, `fetch` with `keepalive` under 63 KB. On tab hide and pagehide the rest goes
  uncompressed with a keepalive `fetch` (a CORS request, so it always carries the page's Origin;
  `sendBeacon` only where keepalive is missing). A `stop: true` answer ends recording for the tab.
- **Events added to rrweb's** (`src/lib/protocol.ts`): `afs.page`, `afs.click`, `afs.input` (first
  input into a field per pageview), `afs.scroll` (throttled), `afs.error` (uncaught, unhandled
  rejection, console.error; errors before the recorder loads are queued by the loader), `afs.event`,
  `afs.hide`, `afs.idle`.
- **Page API:** `afsr.sessionId()`, `afsr.status()`, `afsr('identify', id)`, `afsr('event', name,
  props)`, `afsr('consent', bool)`, `afsr('stop')`. With the analytics tracker on the page, its
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
  it). The direct snippet stays the alternative for pages without the tracker and for a strict CSP
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
| Exclusions | `exclude_paths` travel in the public loader as salted hashes (exact paths and `prefix*` globs) |

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

With `analytics_site_id` set, the domain verified, and the `ANALYTICS` binding + `INTERNAL_TOKEN`
present, settled signals (at most `MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY`, default 500) are posted to that analytics site (`POST /v1/sites/:id/events`, internal auth) as
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
| POST | `/sites` | `{ domain, ...settings }`; same domain returns existing (200); 403 `quota_exceeded` past `MAX_SITES_PER_ACCOUNT`, 403 `verification_required` past `MAX_UNVERIFIED_SITES_PER_ACCOUNT`; IPs, TLDs and public suffixes refused (400) |
| GET | `/sites`, `/sites/:id` | list; one with a data summary (sessions, last chunk, bytes, today's counters, hostnames, chunks refused by reason), its `limits`, and `untrusted.drop_samples` |
| PATCH, DELETE | `/sites/:id` | settings (lists replaced whole, caps clamped and reported in `notes`); delete removes everything (R2 by cron) |
| GET | `/sites/:id/install` | `?framework=html\|nextjs\|react\|astro\|wordpress\|gtm` |
| POST | `/sites/:id/verify` | `{ url? }`: page fetch (https on the domain or a subdomain, port 443), snippet (or the linked analytics site's tracker, checked live with analytics), script, CSP (path-scoped advice), domain verification (homepage loader, the linked analytics site's tracker on the homepage = `homepage_analytics`, or DNS TXT), sessions received, drops, masking advice; `MAX_VERIFY_PER_ACCOUNT_PER_HOUR` |
| GET | `/sites/:id/sessions` | filters (below), `sort=frustration\|recent\|duration`, `limit`, `cursor` |
| GET | `/sites/:id/sessions/:sid` | facts + pages (dwell, scroll reach, quick back, excessive scroll) |
| GET | `/sites/:id/sessions/:sid/transcript` | `?format=text\|json&max_events=&kinds=` |
| DELETE | `/sites/:id/sessions/:sid` | recording, derived events, links |
| GET | `/sites/:id/summary` | filters or `session_ids`, `limit` (sessions considered), `top` |
| GET | `/sites/:id/heatmap` | `?page=<glob>&device=&type=click\|scroll\|both&period=&limit=` |
| GET | `/sites/:id/errors` | `?period=&page=&device=&browser=&fingerprint=&limit=` |
| GET | `/sites/:id/funnel` | `?steps=/a,/b*,event:x` or `analytics_funnel_id=`, `drop_step=`, filters |
| POST | `/sites/:id/delete-visitor-data` | `{ user_id? \| analytics_visitor_id? \| session_ids? }` |
| POST, GET | `/sites/:id/links` | create `{ session_id, expires_in? }` (verified sites only; URL shown once) / list `?session_id=` |
| DELETE | `/sites/:id/links/:link_id` | revoke |

Session filters: `period` (`1h`, `24h`, `today`, `yesterday`, `7d`, `30d`, `90d`, `180d`, `365d`,
`all`) or `from`/`to`, `page`, `entry_page`, `exit_page` (path globs, `*` = anything), `signal`,
`has_error`, `device`, `browser`, `os`, `country`, `min_duration`/`max_duration` (seconds),
`min_frustration`, `user_id`, `analytics_visitor_id`, `clicked`, `error_fingerprint`, `event`,
`forced`.

Public: `GET /` (service info), `GET /llms.txt`, `GET /r/<site>.js`, `GET /rec/<hash>.js` (and `/recorder.<hash>.js`),
`POST|OPTIONS /i`, `GET /play/<token>` (+ `/data`, `/chunks/<seq>`), `GET /assets/player-<hash>.{js,css}`,
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
`list_replay_links`, `revoke_replay_link`. Each calls the same service function as its REST route;
write tools are hidden from read-only keys; tools that return recorded content say in their
description that it is untrusted.

## Human player

`create_replay_link` (verified sites only) returns `/play/rpt_<32 chars>` (only the SHA-256 is stored;
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
| `AUTH_ISSUER`, `INTERNAL_TOKEN` | `@afs/shared`: the OAuth server named in `/.well-known/oauth-protected-resource` (var; set by `pnpm afs`), and the secret the site's dashboard uses for internal auth. `INTERNAL_TOKEN` also turns on analytics forwarding (with the `ANALYTICS` binding) |
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

All the count caps above are optional vars read through `capFor()` (`@afs/shared`): each also takes
`UNCLAIMED_<NAME>`, applied to accounts no person has claimed (agent-only). `"0"` means a cap of 0.

Site settings (`POST`/`PATCH /v1/sites`): `name`, `enabled` (true), `sample_rate` (1),
`mask_mode` (`strict`), `unmask_selectors`, `mask_selectors`, `block_selectors`, `exclude_paths`,
`allowed_hostnames`, `max_session_minutes` (30), `retention_days` (30), `heatmap_retention_days`
(180), `capture_console_errors` (true), `require_consent` (false), `analytics_site_id` (site JSON
adds `loads_with_analytics`).

Built-in limits (always on, `src/lib/limits.ts`): 1 MB compressed / 8 MB decompressed per chunk,
20 MB and 2,000 chunks per session, 50,000 rrweb events looked at per chunk, derived events per chunk
and session as above, 20 clicks in any 1 s window, 500 pageviews and 300 errors per session (more is
stored, not derived; the session's `limited` says why), 50 errors per page in the browser.

Bindings (`wrangler.jsonc`): D1 `DB` (`afs-replay`, placeholder id) and `AUTH_DB` (`afs-identity`),
R2 `CHUNKS` (`afs-replay-chunks`), Durable Object `SITE` (`ReplaySiteDO`, SQLite, migration `v1`),
optional service `ANALYTICS` (`afs-analytics`), rate limits `SIGNUP_LIMITER` (namespace 41001,
shared), `INGEST_IP_LIMITER` (42031, 600/min per client network, loader + ingest, before any D1 read),
`INGEST_SITE_IP_LIMITER` (42032, 120/min per site and network), `INGEST_SITE_LIMITER` (42033,
3,000/min per site), hourly cron `23 * * * *`, DO alarms, observability on. No queues. `compatibility_date` 2026-08-01
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
- `scripts/smoke.sh`: the whole path over HTTP against `wrangler dev`.

## Not yet

- Analytics funnels linking to sessions from the analytics side: needs changes in `analytics/`.
- Alerts on new error types and rage-click spikes (build-order step 4, waits for analytics alerts).
- Rendered heatmap PNGs for people, Web Vitals per session, network request capture, canvas,
  cross-origin iframes, raw recording export over the API.
- A duplicated browser tab shares its sessionStorage, so both tabs send the same session id and
  seq numbers; the second tab's chunks are dropped as duplicates.
