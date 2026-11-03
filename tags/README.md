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
curl -X POST $BASE/v1/containers/$C/destinations/$D/test        # real test event, raw response
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
  Storage is created only when the control plane syncs a container (create, publish,
  rollback, destination change, or a resync of an id that exists in D1): `/collect` for an id
  nobody created answers 404 and writes nothing.
- **Queue** `tags-dispatch`: one message per (event, destination). The consumer decrypts the
  destination's credentials, sends, and writes the result back to the event log. Transient
  failures (network, 429, 5xx, Meta transient codes) retry with backoff (30 s doubling, max
  1 h) for up to 6 attempts; other failures are final. `GET /events` shows exactly what each
  platform answered.

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
deleted, the live one never).

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
| `analytics` | our analytics app server ingest | site_id, api_key, base_url? (default `ANALYTICS_BASE_URL`) | none: sends one `tags_test` event |
| `webhook` | POST JSON, `x-signature` HMAC-SHA256 | url (https; http://localhost only with `DEV_MODE=true`; not this deployment's own host), secret | `"test": true` in the payload |

- Platform destinations (`ga4`, `meta`, `google_ads`, `tiktok`) receive server conversions
  whose `send_to` has their type; `webhook` and `analytics` receive every server conversion.
  `settings.conversions` restricts a destination to named conversions. A container has at most
  `MAX_DESTINATIONS_PER_CONTAINER` destinations (default 10; `403 quota_exceeded`), since each
  server conversion fans out to all of them.
- Deliveries never follow redirects (a 3xx is a failed delivery) and read at most 64 KB of the
  answer. Webhook URLs can't point at this deployment's own host (`PUBLIC_BASE_URL` or the
  host the API was called on), checked when saved and again when sent.
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
IP and user agent. Backend events are the source of truth: they're deduped only against
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
| POST | `/containers/:id/scan` | `{ url?, paths?, follow_links? }`: fetch the site (own domain only; redirects followed by hand, at most 3 hops and only within the domain; 1 MB per page; write key): existing tags (GTM-, G-, AW-, fbq, ttq, LinkedIn, UET, Reddit, X, Pinterest, our container/analytics), consent platforms, CMS, forms, CTAs, thank-you pages; suggested config |
| POST | `/containers/:id/setup` | the `setup_conversion_tracking` recipe over REST |
| GET, PUT, PATCH | `/containers/:id/draft` | full replace (PUT) or JSON merge patch (PATCH); optional `?revision=` guards concurrent edits; `413 draft_too_large` over `MAX_DRAFT_BYTES` |
| POST | `/containers/:id/draft/validate` | errors and warnings with hints; optional `{ config }` validates without saving |
| POST | `/containers/:id/preview` | `{ ttl_minutes?, path? }` -> preview token + URL to open (`?afst_preview=`) |
| POST | `/containers/:id/publish` | new immutable version, goes live (422 with the errors if invalid) |
| GET | `/containers/:id/versions`, `/versions/:n` | newest `max_versions` kept |
| POST | `/containers/:id/rollback` | `{ version }`: moves the live pointer to that version; the draft is unchanged |
| POST, GET, PATCH, DELETE | `/containers/:id/destinations[/:did]` | POST: `403 quota_exceeded` past `MAX_DESTINATIONS_PER_CONTAINER` |
| POST | `/containers/:id/destinations/:did/test` | `{ event_name?, test_event_code? }`: sends a test event, returns the platform's raw answer |
| POST | `/containers/:id/events` | server-side conversions (batch of up to 100), joined to visitors |
| GET | `/containers/:id/events` | event log with per-destination results; filters `name`, `status`, `source`, `since` (ms, ISO or `15m`/`2h`/`7d`), `before` (cursor), `limit`, `include_visits`, `verbose` (adds the exact request sent) |
| GET | `/containers/:id/visitors/:vid` | stored identity/click record (debugging) |

Also from `@afs/shared`: `GET /v1/me`, `GET|POST /v1/keys`, `DELETE /v1/keys/:id`.

Public (no key): `GET /c/:id.js` (header `x-afs-version: <live version>`), `POST /collect`
(text/plain JSON, no preflight; the page host must be the container's domain, a subdomain or an
`allowed_hostnames` entry; an unknown container id gets 404; known bots are ignored except
preview traffic), both under any path prefix for proxying, `GET /llms.txt`.

## MCP tools

`create_container`, `list_containers`, `get_container`, `update_container`,
`delete_container`, `get_install_instructions`, `scan_site` (write scope, like REST; its page
content is marked untrusted), `get_config_schema`, `get_draft`, `update_draft`, `patch_draft`, `validate_draft`,
`create_preview`, `publish`, `list_versions`, `rollback`, `add_destination`,
`list_destinations`, `update_destination`, `remove_destination`, `test_destination`,
`send_server_events`, `get_event_log`, `get_visitor`, `setup_conversion_tracking` (recipe: given
platforms + conversions in plain terms, writes a complete draft, creates destinations for
platforms with credentials, validates it, and returns what's left to do, e.g. which IDs are
missing and where to find them). Read-only keys only see the read tools.

## Config

| Var / secret | |
|---|---|
| `PUBLIC_BASE_URL` | var; empty = request origin |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | `@afs/shared` auth |
| `ENCRYPTION_KEY` | secret, 32 bytes base64 (`openssl rand -base64 32`) |
| `ANALYTICS_BASE_URL` | var; default base URL of the analytics app for `analytics` tags/destinations |
| `DEV_MODE` | var; `true` only locally (allows `http://localhost` webhooks) |
| `MAX_CONTAINERS_PER_ACCOUNT` | optional var; containers per account (unset = no cap) |
| `MAX_DESTINATIONS_PER_CONTAINER` | optional var; destinations per container, default `10` (`0` = no cap) |
| `MAX_VERSIONS_PER_CONTAINER` | optional var; published versions kept per container, newest first, default `50` (`0` = keep all; the live version is never deleted) |
| `MAX_DRAFT_BYTES` | optional var; largest draft (serialised JSON), default `524288` (512 KB; `0` = no cap below D1's row limit) |

## Development

`pnpm db:migrate:local`, `pnpm dev` (port 8788; builds the runtime first), `pnpm typecheck`
(Worker + runtime), `pnpm test` (unit tests in Node, including the bundled runtime run in a fake
browser; integration tests in workerd via `@cloudflare/vitest-pool-workers`), `pnpm smoke`
(end-to-end against `pnpm dev`, with a local signed-webhook sink; needs `DEV_MODE=true` in
`.dev.vars`).

## Not yet (v2)

Built-in consent banner UI, more CAPI connectors, A/B testing, Google Ads conversion
adjustments / enhanced conversions for web (`uploadConversionAdjustments`; click uploads already
carry hashed email/phone), offline conversion CSV import, per-tag sampling, /collect rate
limiting, a global (all-colo) cache purge on publish.
