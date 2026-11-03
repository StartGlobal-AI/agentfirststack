# tags

A tag manager and server-side conversion router an agent can set up by itself: one snippet on
the site, then tags, triggers and conversions are configured, validated, previewed, tested
against the ad platforms and published entirely through the API or MCP.

Replaces Google Tag Manager (web container) **and** server-side GTM (sGTM on Cloud Run):
conversions are defined once and delivered to every platform both from the browser (pixels) and
from the server (conversion APIs), with the same `event_id` so platforms deduplicate.

Sections marked (v2) are deliberately not built yet.

## Agent quickstart

```sh
curl -X POST $BASE/v1/signup                                    # key
curl -X POST $BASE/v1/containers -d '{"domain":"example.com"}'  # container + snippet
curl -X POST $BASE/v1/containers/$C/scan                        # what's on the site today
curl -X POST $BASE/v1/containers/$C/setup -d @recipe.json       # or: whole draft + destinations from plain inputs
curl -X POST $BASE/v1/containers/$C/destinations -d '{"type":"meta","credentials":{...}}'
curl -X PUT  $BASE/v1/containers/$C/draft -d @config.json       # tags, triggers, conversions
curl -X POST $BASE/v1/containers/$C/draft/validate              # errors + warnings with hints
curl -X POST $BASE/v1/containers/$C/destinations/$D/test        # real test event, the platform's answer
curl -X POST $BASE/v1/containers/$C/preview                     # preview_url runs the draft on the live site
curl -X POST $BASE/v1/containers/$C/publish -d '{"note":"purchase tracking"}'
curl $BASE/v1/containers/$C/events                              # live log, per-destination result
```

`GET /llms.txt` is the full manual (every route, MCP tool and config field, with examples).

## Architecture

```
site ── <script src=/c/ctr_xxx.js> (runtime + published config, edge cached)
   │      dataLayer, variables, triggers, consent, click-id capture, client pixels
   └──► POST /collect ─► Worker (enrich: ip, ua, geo, cookies) ─► ContainerDO (identity +
                                                                    dedupe + event log)
backend ── POST /v1/containers/:id/events ──────────────────────────┘        │
                                                                     Queue `tags-dispatch`
                                                                             ▼
                                   destinations: GA4 MP · Meta CAPI · Google Ads ·
                                   TikTok Events API · analytics app · webhook   (retries)
D1: accounts, keys, containers, drafts, versions (immutable), preview tokens,
    destinations (sealed creds)
```

- **Container script** `GET /c/:container_id.js` = the static runtime (TypeScript in
  `src/runtime/`, own `tsconfig` with the DOM lib, bundled and minified by esbuild into
  `dist/runtime.txt` by wrangler's `build.command`, imported by the Worker as a Text module) +
  the live version's config inlined + the visitor's country/region (from Cloudflare's edge, for
  consent regions). The live config is cached per container in the edge Cache API
  (`caches.default`, 60 s); the response has an ETag (304 on match) and `max-age=300`.
  Publish/rollback delete the cache entry; the Cache API is per data center, so other colos
  pick up the new version within 60 s. Before the first publish the script serves the runtime
  with an empty config (so preview works). `?preview=<token>` serves the draft with debug
  logging and `no-store`; an expired token falls back to the live script and clears the flag.
- **ContainerDO** (one per container, SQLite): `meta` (copy of the container, live config and
  destination list, pushed by the control plane on create/publish/rollback/destination
  changes, so `/collect` never reads D1), `visitors` (click IDs with timestamps, fbp/fbc,
  `_ttp`, GA client/session id, first- and last-touch UTM, landing page, user_id, SHA-256
  email/phone/name hashes, last IP/UA/geo, consent), `events` (the event log, last 7 days:
  each event's per-destination status, attempts, HTTP status and response snippet). Rows are
  keyed by `(source, event_id)`: browser hits dedupe against browser rows, backend events
  against backend rows, so the dedupe window is the 7-day log retention; a daily alarm purges
  events after 7 days and visitors 180 days after they were last seen. Each row is written
  before its queue messages are sent, so concurrent copies of one event are delivered once.
  A `usage` table counts browser events, backend events and deliveries per UTC day (only ever
  incremented) for the daily quotas and budgets; visitor rows are capped
  (`MAX_VISITORS_PER_CONTAINER`, least recently seen evicted) and `/collect` stops writing when
  the database passes `MAX_CONTAINER_DB_BYTES` (see "Abuse and cost controls").
  Storage is created only when the control plane syncs a container (create, publish,
  rollback, destination change, or a resync of an id that exists in D1): `/collect` for an id
  nobody created answers 404 and writes nothing.
- **Queue** `tags-dispatch`: one message per (event, destination). The consumer decrypts the
  destination's credentials, sends, and writes the result back to the event log. Transient
  failures (network, 429, 5xx, Meta transient codes) retry with backoff (30 s doubling, max
  1 h) for up to 6 attempts (webhooks: 3); other failures are final. `GET /events` shows exactly
  what each platform answered. Consecutive failed attempts open the destination's circuit
  breaker; suspended accounts' messages are dropped.

## Config model (the draft, validated by zod; `GET /v1/schema` returns JSON Schema + examples)

```jsonc
{
  "variables": [
    { "name": "order_value", "type": "data_layer", "key": "ecommerce.value" },
    { "name": "email", "type": "dom_value", "selector": "input[type=email]" }
    // types: data_layer, url_param, cookie, dom_text, dom_value, dom_attr, js (global path,
    //        read only), constant, page_url, page_path, page_hostname, referrer, click_text,
    //        click_url, form_id. Every variable may have a `default`.
    // Built-ins usable without defining: page_url, page_path, page_hostname, page_title,
    //        referrer, event, click_text, click_url, click_id, click_classes, form_id,
    //        form_action, form_classes, scroll_depth
  ],
  "triggers": [
    { "id": "all_pages", "type": "page_view" },
    { "id": "thank_you", "type": "page_view", "conditions": [{ "var": "page_path", "op": "starts_with", "value": "/thank-you" }] },
    { "id": "lead_form", "type": "form_submit", "selector": "form#contact" },
    { "id": "purchase_dl", "type": "custom_event", "event": "purchase" }
    // types: page_view, dom_ready, history_change, click {selector?, links_only?},
    //        form_submit {selector?}, custom_event {event}, element_visible {selector,
    //        threshold?, once?, observe_dom?}, scroll_depth {percentages}, timer {interval_ms,
    //        limit?}. ops: equals, contains, starts_with, ends_with, matches_regex, and not_*
    //        of each; conditions AND together; optional ignore_case
  ],
  "tags": [
    { "id": "ga4", "type": "ga4", "params": { "measurement_id": "G-XXXX" }, "triggers": ["all_pages"], "consent": ["analytics_storage"] },
    { "id": "meta", "type": "meta_pixel", "params": { "pixel_id": "123" }, "triggers": ["all_pages"], "consent": ["ad_storage"] }
    // types: ga4, google_ads, meta_pixel, tiktok_pixel, linkedin_insight, microsoft_uet,
    //        reddit_pixel, x_pixel, pinterest_tag, analytics (our analytics app: loads
    //        <base_url>/s.js with data-site), custom_html, custom_js
    // also: exclude_triggers, once_per_page, enabled, description. When `consent` is omitted
    // the type's default applies: ad pixels ["ad_storage"], ga4 ["analytics_storage"],
    // analytics/custom_html/custom_js []. custom_html { html }: its <script>s run; {{var}}
    // values are HTML-encoded (all but letters, digits and _ . , : @ - become &#N;) and
    // javascript:/vbscript: values are dropped, since page data (url_param, cookie, DOM) is
    // attacker-controlled. custom_js { code } runs as (afst, event) => {...}; read page data
    // from event.data / event.model there instead of templating it into a <script>.
  ],
  "conversions": [
    {
      "name": "purchase",
      "trigger": "purchase_dl",
      "value": "order_value", "currency": "USD", "transaction_id": "order_id",
      "user_data": { "email": "email" },
      "send_to": {
        "ga4": { "event_name": "purchase" },
        "google_ads": { "send_to": "AW-123/AbC" },
        "meta": { "event_name": "Purchase" },
        "tiktok": { "event_name": "CompletePayment" }
      },
      "server": true
    }
    // value: number or variable; currency: "USD" or { "var": "..." }; also items (variable
    // holding GA4 items), params, once_per_page. send_to also takes linkedin {conversion_id},
    // microsoft_uet {event_action}, reddit {event_name}, x {event_id}, pinterest {event_name},
    // analytics {event_name?}; google_ads {conversion_action_id} overrides the server
    // destination's conversion action for this conversion.
  ],
  "consent": {
    "mode": "none",               // none | opt_in | opt_out
    "default": { "analytics_storage": "granted", "ad_storage": "granted", "ad_user_data": "granted", "ad_personalization": "granted" },
    "regions": { "EEA": { "ad_storage": "denied", "ad_user_data": "denied", "ad_personalization": "denied", "analytics_storage": "denied" } },
    "google_consent_mode": "basic", // basic: Google tags wait for consent; advanced: they load and gtag sends cookieless pings
    "wait_for_update_ms": 500       // passed to gtag('consent','default')
  },
  "settings": { "phone_country_code": "1", "cookie_domain": "example.com", "listen_to_gtag_events": false, "send_page_views": true, "debug": false }
}
```

Objects are strict (unknown keys are errors, so typos surface). `PUT /draft` rejects configs
that don't match the schema (400 with per-field details); semantic problems are returned in
`validation` and block publish. The validator (`POST /draft/validate`) returns `errors` and
`warnings`, each `{ path, code, message, hint }`: undefined triggers/variables, duplicate ids,
invalid regexes, placeholder pixel ids, purchases without value/currency (Meta Purchase without
them is an error), phones without a country code setting, conversions that no tag or
destination will deliver, `server: true` with no destination of that type, destinations that
receive nothing, Google Ads tag + upload double counting, and consent gaps (ad pixels with no
consent config, opt-in without a banner call, EEA without GB, ad tags with `consent: []`).
Drafts are capped at `MAX_DRAFT_BYTES` (default 512 KB of JSON; `413 draft_too_large`), and
publish keeps the newest `MAX_VERSIONS_PER_CONTAINER` versions (default 50; older ones are
deleted, the live one never). An account's drafts plus kept versions are capped at
`MAX_TAGS_BYTES_PER_ACCOUNT` (default 20 MB; `413 storage_quota_exceeded`; shrinking a draft
always works).

**Custom code** (`custom_html`, `custom_js`, and an `analytics` tag whose `base_url` isn't on
`ANALYTICS_BASE_URL`'s host) is served from this deployment's domain to every visitor, so a
version containing it is published (or rolled back to) only when the account may publish custom
code (`ALLOW_CUSTOM_CODE`, default true; unclaimed, agent-only accounts need
`UNCLAIMED_ALLOW_CUSTOM_CODE=true`), the container's domain is verified, and it fits
`MAX_CUSTOM_CODE_BYTES` (when set; also checked when the draft is saved). Otherwise validation
returns an error (`custom_code_not_allowed`, `domain_not_verified`, `custom_code_too_large`)
and publish answers 422. Verification: a DNS TXT record `_afs-verify.<domain>` with the value
from `GET /v1/containers/:id` (`verification.dns_record`, an HMAC of the container id), checked
over DNS-over-HTTPS (cloudflare-dns.com) by `POST /v1/containers/:id/verify`, or this
container's snippet in a `<script src>` on `https://<domain>/`, found by `verify` or `scan`.
Preview links of a draft that may not run custom code are served without those tags.

A **conversion** is defined once. When its trigger fires the runtime creates one `event_id`,
fires the matching client tags with it (gtag `transaction_id` when there's no order id, fbq
`eventID`, ttq `event_id`, Reddit `conversionId`, X `conversion_id`, Pinterest and LinkedIn
`event_id`), and posts it to `/collect`. With `server: true` the server sends it to each
matching destination's conversion API with the same id, so each platform counts it once. GA4
and the analytics app don't dedupe server hits by event id, so a browser conversion's server
copy is skipped when that same hit says the browser tag already sent it (it still covers
ad-blocked browsers). The rule never applies to backend events (`POST /events`): they are
always delivered, so if a browser GA4/analytics tag also sends that conversion, both count
(narrow one side with the event's `destinations` or a destination's `settings.conversions`).
Routing uses the server-side config only; the browser can't send an event to a destination
the config doesn't map. PII (email, phone, names) is normalised per platform and SHA-256
hashed in the browser, synchronously, before it leaves; the server never stores plaintext PII.

## Destinations (server-side connectors)

All connectors implement one interface (`src/destinations/types.ts`: credentials schema,
required consent, dedupe rule, payload builder, `send`); adding a platform is one file plus a
line in `src/destinations/index.ts`.

| type | API | credentials | test mode |
|---|---|---|---|
| `ga4` | Measurement Protocol | measurement_id, api_secret, region? (`eu`) | `/debug/mp/collect` validation |
| `meta` | Conversions API (Graph v26.0) | pixel_id, access_token, test_event_code? | `test_event_code` (required for `test`) |
| `google_ads` | offline click conversions: Data Manager API `events:ingest` (default) or Google Ads API v26 `uploadClickConversions` (`api: "google_ads_api"`); gclid/gbraid/wbraid + hashed email/phone | customer_id, conversion_action_id (an "Import from clicks" action), oauth client_id/client_secret/refresh_token, login_customer_id?, developer_token? (google_ads_api only), api? | `validateOnly: true` |
| `tiktok` | Events API 2.0 | pixel_code, access_token, test_event_code? | `test_event_code` (required for `test`) |
| `analytics` | our analytics app server ingest | site_id, api_key, base_url? (default `ANALYTICS_BASE_URL`; https, same host as `ANALYTICS_BASE_URL` when set, no query string, no IP literal, not this deployment; re-checked when sent) | none: sends one `tags_test` event |
| `webhook` | POST JSON, `x-signature` HMAC-SHA256 | url (https; http://localhost only with `DEV_MODE=true`; not this deployment's own host), secret | `"test": true` in the payload |

- Platform destinations (`ga4`, `meta`, `google_ads`, `tiktok`) receive server conversions
  whose `send_to` has their type; `analytics` receives every server conversion and backend
  event; `webhook` receives every server conversion and backend events whose name matches a
  conversion in the live config (`settings.all_events: true` for every backend event).
  `settings.conversions` restricts a destination to named conversions. A container has at most
  `MAX_DESTINATIONS_PER_CONTAINER` destinations (default 10; `403 quota_exceeded`), since each
  server conversion fans out to all of them.
- Circuit breaker: `CIRCUIT_BREAKER_FAILURES` (default 20) consecutive failed attempts (retries
  count) open a destination's circuit for `CIRCUIT_BREAKER_MINUTES` (default 60): deliveries are
  logged as `skipped` with the reason, queued ones are dropped unsent, `validate` warns
  (`destination_circuit_open`) and the destination shows `health.circuit: "open"`. After the
  timeout deliveries flow again (one more failure re-opens it); a passing test closes it.
- Webhooks retry at most 3 attempts (platforms 6), and only a short sanitized summary of their
  answer is kept (at most 8 scalar JSON fields or 200 characters of text, tags stripped).
- Deliveries never follow redirects (a 3xx is a failed delivery) and read at most 64 KB of the
  answer. Webhook URLs can't point at this deployment's own host (`PUBLIC_BASE_URL` or the
  host the API was called on), checked when saved and again when sent. Tests of webhook and
  analytics destinations (URLs the account chooses) return the HTTP status and a short
  sanitized summary, never the body.
- Consent: meta/tiktok/google_ads need `ad_user_data` granted, ga4 needs `analytics_storage`;
  otherwise the delivery is recorded as `skipped` with the reason. Google Ads also skips events
  with no click id and no hashed email/phone.
- Google Ads: since 15 June 2026 `UploadClickConversions` fails with
  `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` for developer tokens that made no offline
  conversion uploads between 17 Dec 2025 and 15 Jun 2026, and Google recommends the Data
  Manager API, which needs no developer token (OAuth scope
  `https://www.googleapis.com/auth/datamanager`). The default is therefore `data_manager`.
- Webhook payload `{ "type": "conversion", "test", "container_id", "destination_id", "event" }`;
  headers `x-signature: sha256=<hex HMAC-SHA256(secret, "<x-signature-timestamp>.<raw body>")>`,
  `x-signature-timestamp`, `x-event-id`.
- The analytics destination posts to `POST {base_url}/v1/sites/{site_id}/events` with the
  visitor's `ip`, `user_agent`, `country`/`region`/`region_code`/`city` passed explicitly (the
  tags Worker isn't where the visitor is), first-touch `utm_*`, `click_id_type`/`click_id`,
  `props` (event_id, transaction_id, params) and `revenue`; `visitor_id` only when the browser
  exposed the analytics app's own id (`afsa.visitorId()`).

(v2: LinkedIn CAPI, Reddit CAPI, Pinterest CAPI, Snap CAPI, Microsoft offline conversions.
LinkedIn, UET, Reddit, X and Pinterest conversions are browser-only for now.)

Credentials are sealed with AES-GCM (`ENCRYPTION_KEY`) and never returned (responses show
`"configured": true` plus non-secret ids). Creating a destination with the same platform id
returns the existing one (`existing: true`); PATCH merges credential fields.

## Click and identity capture (runtime)

Captures `gclid, gbraid, wbraid, dclid, fbclid (-> _fbc), msclkid, ttclid, li_fat_id, twclid,
rdt_cid, epik, ScCid` and UTM first touch from the landing URL; reads `_ga` (client and session
id), `_fbp` (created per Meta's format when a Meta tag/conversion exists and it's missing),
`_fbc`, `_ttp`. Stores `_afst_vid`, `_afst_<clickid>` (90 days), `_afst_ft` (first touch) and
`_afst_consent` as first-party cookies, only when consent allows (`analytics_storage` or
`ad_storage` for the visitor id and first touch, `ad_storage` for click ids/_fbc/_fbp;
otherwise they stay in memory for the page). When served first-party (proxy), `/collect` also
re-sets them server-side via `Set-Cookie` so they survive Safari ITP's 7-day script-cookie cap.
The visitor IP (sent on to the conversion APIs) is `cf-connecting-ip`, or the first
`X-Forwarded-For` hop only when the request carries the container's `x-afs-proxy-key`
(HMAC-SHA256 of `"afs-tags-proxy:" + container id` with `ENCRYPTION_KEY`), which the proxy
configs from `GET /install` add server-side. A client-set `first_party` flag or forwarded
header alone is ignored.

A light identity hit (`type: "visit"`) goes to `/collect` on a new visitor, a landing with click
ids or UTMs, or the first page of a session (`settings.send_page_views: false` turns it off).
Server conversions from the backend (`POST /v1/containers/:id/events` with `visitor_id`,
`user_id` or `email`/`phone` (hashed on arrival)) are joined to the stored visitor in that
order, so a purchase reported by Stripe a week later still carries the original gclid/fbclid,
IP and user agent. `user_id`/email/phone joins only match identities your backend linked to a
visitor (an earlier backend event carrying that `visitor_id` plus the user id or email); user
ids and hashes a browser posts to `/collect` (`afst('identify')`) never make a join, and a
user_id/email/phone join never inherits the visitor's consent or click ids (pass them in the
event, or pass `visitor_id`). Visitors stored before this rule have their join keys cleared once
(visitor_id joins are unaffected; the next backend event re-links). Backend events are the source of truth: they're deduped only against
earlier backend events (same `event_id`, or same name + `order_id`), and nothing a browser
posts to `/collect` (which anyone can) can make one a duplicate, change its values, lend it
an event_id or attach another visitor's click ids; the order id is never used to join a
visitor. Their `event_id` is the one you pass, else `<name>.<order_id>`, else random: to pair a
backend event with the browser's pixel so Meta/TikTok dedupe the two themselves, pass the
browser conversion's id (`afst('get','event_id')`) as `event_id`. When a browser conversion
arrives after the backend already sent the same one (same event_id, or same name + order
id), it's logged but not sent server-side again.

Runtime extras: GTM-compatible `dataLayer` (existing entries processed, `push` wrapped, objects
deep-merge into the model, arrays replace, `eventCallback` honoured when GTM isn't present,
`gtm.*` events ignored), `afst('event'|'consent'|'identify'|'get'|'debug', ...)` with a queue
stub, CMPs calling `gtag('consent','update', ...)` are followed, Consent Mode v2 default/update
passed to gtag, Meta/TikTok/UET consent APIs called on change, tags blocked by consent queue and
fire once granted, Consent Mode v1-style updates (only `ad_storage`) carry `ad_user_data` and
`ad_personalization` along, `history_change` starts a new "page" for `once_per_page`, debug log
in `window.__afst_debug` and the console (`?afst_debug=1`, preview, or `settings.debug`).

## API (under `/v1`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (public) |
| GET | `/schema` | JSON Schema for the config, tag/trigger/variable catalog with examples, destination credential schemas (public) |
| POST, GET | `/containers` | `{ domain, name?, allowed_hostnames? }`; same domain returns existing |
| GET, PATCH, DELETE | `/containers/:id` | GET includes destinations and last-24h stats; PATCH `{ name?, allowed_hostnames? }` |
| GET | `/containers/:id/install` | snippet + first-party proxy instructions (Cloudflare Worker, Next.js middleware, Vercel, netlify.toml, nginx) with the container's `proxy_key` |
| POST | `/containers/:id/scan` | `{ url?, paths?, follow_links? }`: fetch the site (own domain only, https on the default port, no IP literals; at most 6 pages, 2 at a time; redirects followed by hand, at most 3 hops and only within the domain; 1 MB per page; write key; `SCAN_LIMITER` per account; finding this container's snippet on `https://<domain>/` verifies the domain): existing tags (GTM-, G-, AW-, fbq, ttq, LinkedIn, UET, Reddit, X, Pinterest, our container/analytics), consent platforms, CMS, forms, CTAs, thank-you pages; suggested config |
| POST | `/containers/:id/verify` | `{ method?: "auto"\|"dns"\|"snippet" }`: domain verification (needed to publish custom code), rate limited with scan |
| POST | `/containers/:id/setup` | the `setup_conversion_tracking` recipe over REST |
| GET, PUT, PATCH | `/containers/:id/draft` | full replace (PUT) or JSON merge patch (PATCH); optional `?revision=` guards concurrent edits; `413 draft_too_large` over `MAX_DRAFT_BYTES` |
| POST | `/containers/:id/draft/validate` | errors and warnings with hints; optional `{ config }` validates without saving |
| POST | `/containers/:id/preview` | `{ ttl_minutes?, path? }` -> preview token + URL to open (`?afst_preview=`) |
| POST | `/containers/:id/publish` | new immutable version, goes live (422 with the errors if invalid) |
| GET | `/containers/:id/versions`, `/versions/:n` | newest `max_versions` kept |
| POST | `/containers/:id/rollback` | `{ version }`: moves the live pointer to that version; the draft is unchanged |
| POST, GET, PATCH, DELETE | `/containers/:id/destinations[/:did]` | POST: `403 quota_exceeded` past `MAX_DESTINATIONS_PER_CONTAINER` |
| POST | `/containers/:id/destinations/:did/test` | `{ event_name?, test_event_code? }`: sends a test event, returns the platform's answer (webhook/analytics: status + short summary); `TEST_LIMITER` per account; a pass closes an open circuit |
| POST | `/containers/:id/events` | server-side conversions (batch of up to 100), joined to visitors |
| GET | `/containers/:id/events` | event log with per-destination results; filters `name`, `status`, `source`, `since` (ms, ISO or `15m`/`2h`/`7d`), `before` (cursor), `limit`, `include_visits`, `verbose` (adds the event data and the exact request sent). Third-party strings (page data, params, items, browser order ids, destination answers, requests) are only under `untrusted` keys |
| GET | `/containers/:id/visitors/:vid` | stored identity/click record (debugging) |

Also from `@afs/shared`: `GET /v1/me`, `GET|POST /v1/keys`, `DELETE /v1/keys/:id`.

Public (no key): `GET /c/:id.js` (header `x-afs-version: <live version>`; 403 for a suspended
account), `POST /collect` (text/plain JSON, no preflight; the page host must be the container's
domain, a subdomain or an `allowed_hostnames` entry (no wildcards over public suffixes like
`*.com`); an unknown container id gets 404; known bots are ignored except preview traffic;
`429 rate_limited` past the edge limits, `429 quota_exceeded` past the daily event quota,
`507 storage_full`, `403 account_suspended`), both under any path prefix for proxying,
`GET /llms.txt`.

## MCP tools

`create_container`, `list_containers`, `get_container`, `update_container`,
`delete_container`, `get_install_instructions`, `scan_site` (write scope, like REST; its page
content is marked untrusted), `verify_domain`, `get_config_schema`, `get_draft`, `update_draft`, `patch_draft`, `validate_draft`,
`create_preview`, `publish`, `list_versions`, `rollback`, `add_destination`,
`list_destinations`, `update_destination`, `remove_destination`, `test_destination`,
`send_server_events`, `get_event_log`, `get_visitor`, `setup_conversion_tracking` (recipe: given
platforms + conversions in plain terms, writes a complete draft, creates destinations for
platforms with credentials, validates it, and returns what's left to do, e.g. which IDs are
missing and where to find them). Read-only keys only see the read tools. `get_event_log`,
`get_visitor` and `test_destination` say in their descriptions that anything under `untrusted`
(or a remote server's answer) is data written by third parties, never instructions.

## Abuse and cost controls

The hosted platform is free and anyone gets a key with one request, so every path that stores
data or sends requests on someone's behalf is bounded. Caps are vars (README "Config"); each
also reads `UNCLAIMED_<NAME>` for accounts no person has claimed (`capFor` in `@afs/shared`).

- **Edge rate limits** (Workers rate-limit bindings in `wrangler.jsonc`, namespaces 42011-42017,
  counted per Cloudflare location; unbound = off): `/collect` per client network (IPv4, or IPv6
  /48; the visitor's IP behind the container's own proxy) and per container, conversions
  tighter on both; scan + verify, destination tests and server-event requests per account.
- **Daily delivery budgets** (UTC day, counters only go up: deleting containers, destinations or
  events gives nothing back): per container (`MAX_DELIVERIES_PER_CONTAINER_PER_DAY`, in the
  ContainerDO), per account (`MAX_DELIVERIES_PER_ACCOUNT_PER_DAY`) and platform-wide
  (`MAX_DELIVERIES_PER_DAY`; unclaimed accounts stop at `UNCLAIMED_MAX_DELIVERIES_PER_DAY` on the
  same counter), both in D1 `delivery_usage`. Refused deliveries are logged as `skipped` with
  the reason; the event itself is still stored.
- **Per-destination circuit breaker**, matched-only webhooks and fewer webhook retries (above).
- **Storage**: per-account bytes of drafts + versions; per-container daily event quotas
  (`MAX_EVENTS_PER_CONTAINER_PER_DAY`, browser hits and backend events counted separately, 429
  past it); a visitor cap with eviction; a database-size threshold where `/collect` stops writing
  (backend events keep working up to 25% past it); bounded maps and strings in everything
  `/collect` stores (known click ids, utm_* and consent keys only, 25 scalar params, bounded
  first touch, id-shaped fbp/fbc/GA ids, 512-character user agent).
- **Custom code** needs a verified domain and a claimed account (above).
- **Outbound fetches** (scan, verify, destinations) go only to https hosts on the default port,
  never IP literals, local names or this deployment; analytics destinations only to the
  analytics app's host.
- **Suspended accounts** (`accounts.suspended_at`, see `@afs/shared` `accountStanding`): their
  keys stop working, `/collect` and `/c/:id.js` answer 403 and queued deliveries are dropped.

## Config

| Var / secret | |
|---|---|
| `PUBLIC_BASE_URL` | var; empty = request origin |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | `@afs/shared` auth |
| `AUTH_ISSUER`, `INTERNAL_TOKEN` | `@afs/shared`: the OAuth server named in `/.well-known/oauth-protected-resource` (var; set by `pnpm afs`, unset = none listed), and the secret the site's dashboard uses for internal auth (unset = off) |
| `ENCRYPTION_KEY` | secret, 32 bytes base64 (`openssl rand -base64 32`) |
| `ANALYTICS_BASE_URL` | var; default base URL of the analytics app for `analytics` tags/destinations |
| `DEV_MODE` | var; `true` only locally (allows `http://localhost` webhooks) |
| `MAX_CONTAINERS_PER_ACCOUNT` | optional var; containers per account (unset or `0` = no cap) |
| `MAX_DESTINATIONS_PER_CONTAINER` | optional var; destinations per container, default `10` (`0` = no cap) |
| `MAX_VERSIONS_PER_CONTAINER` | optional var; published versions kept per container, newest first, default `50` (`0` = keep all; the live version is never deleted) |
| `MAX_DRAFT_BYTES` | optional var; largest draft (serialised JSON), default `524288` (512 KB; `0` = no cap below D1's row limit) |
| `MAX_TAGS_BYTES_PER_ACCOUNT` | optional var; bytes of drafts + kept versions across an account's containers, default `20971520` (20 MB) |
| `MAX_CUSTOM_CODE_BYTES` | optional var; custom_html + custom_js bytes per config (unset = only the 50 KB per-tag limit) |
| `ALLOW_CUSTOM_CODE`, `UNCLAIMED_ALLOW_CUSTOM_CODE` | optional vars; whether claimed (default `true`) and unclaimed (default `false`) accounts may publish custom code (a verified domain is always needed) |
| `MAX_DELIVERIES_PER_CONTAINER_PER_DAY`, `MAX_DELIVERIES_PER_ACCOUNT_PER_DAY`, `MAX_DELIVERIES_PER_DAY` | optional vars; daily delivery budgets per container, per account and platform-wide (unset = off) |
| `MAX_EVENTS_PER_CONTAINER_PER_DAY` | optional var; browser hits per container per UTC day, and separately backend events (unset = off) |
| `MAX_VISITORS_PER_CONTAINER` | optional var; visitor rows kept per container, least recently seen evicted, default `250000` |
| `MAX_CONTAINER_DB_BYTES` | optional var; ContainerDO database size above which `/collect` stops writing (backend events up to 25% more), default `1073741824` (1 GiB) |
| `CIRCUIT_BREAKER_FAILURES`, `CIRCUIT_BREAKER_MINUTES` | optional vars; consecutive failed attempts that open a destination's circuit (default `20`, `0` = off) and minutes it stays open (default `60`) |

Every cap above (and `MAX_CONTAINERS_PER_ACCOUNT`, `MAX_DESTINATIONS_PER_CONTAINER`,
`MAX_VERSIONS_PER_CONTAINER`, `MAX_DRAFT_BYTES`) also reads `UNCLAIMED_<NAME>` for accounts no
person has claimed; `0` turns a cap off. Rate-limit bindings: `COLLECT_IP_LIMITER`,
`COLLECT_CONTAINER_LIMITER`, `CONVERSION_IP_LIMITER`, `CONVERSION_CONTAINER_LIMITER`,
`SCAN_LIMITER`, `TEST_LIMITER`, `SERVER_EVENTS_LIMITER` (each optional; see `wrangler.jsonc`).

## Development

`pnpm db:migrate:local`, `pnpm dev` (port 8788; builds the runtime first), `pnpm typecheck`
(Worker + runtime), `pnpm test` (unit tests in Node, including the bundled runtime run in a fake
browser; integration tests in workerd via `@cloudflare/vitest-pool-workers`), `pnpm smoke`
(end-to-end against `pnpm dev`, with a local signed-webhook sink; needs `DEV_MODE=true` in
`.dev.vars`).

## Not yet (v2)

Built-in consent banner UI, more CAPI connectors, A/B testing, Google Ads conversion
adjustments / enhanced conversions for web (`uploadConversionAdjustments`; click uploads already
carry hashed email/phone), offline conversion CSV import, per-tag sampling, signed browser `identify` (so a browser can
link a user id without the backend), a global (all-colo) cache purge on publish.
