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
                                   TikTok · LinkedIn · Pinterest · Reddit · Snap · X ·
                                   analytics app · webhook   (retries)
D1: accounts, keys, containers, drafts, versions (immutable), preview tokens,
    environments, lookup tables, destinations (sealed creds)
```

- **Container script** `GET /c/:container_id.js` = the static runtime (TypeScript in
  `src/runtime/`, own `tsconfig` with the DOM lib, bundled and minified by esbuild into
  `dist/runtime.txt` by wrangler's `build.command`, imported by the Worker as a Text module;
  containers whose config uses video or js_error triggers, `wait_for_tags_ms`, cross-domain
  linking, TCF or `user_data: "auto"` get `dist/runtime-ext.txt` instead, which adds
  `src/runtime/ext.ts`, so most sites load less code; a test keeps both under a size budget) +
  the live version's config inlined + the visitor's country/region (from Cloudflare's edge, for
  consent regions). The live config is cached per container in the edge Cache API
  (`caches.default`, 60 s); the response has an ETag (304 on match) and `max-age=300`.
  Publish/rollback delete the cache entry; the Cache API is per data center, so other colos
  pick up the new version within 60 s. Before the first publish the script serves the runtime
  with an empty config (so preview works). `?preview=<token>` serves the draft (or the version
  the preview was made for) with debug logging and `no-store`; an expired token falls back to the
  live script, clears the flag and keeps the tab test traffic (sessionStorage `afsa_debug`). `?env=<token>` serves an environment's pinned version (or
  the draft), cached 60 s in the browser; an invalid token falls back to live.
- **ContainerDO** (one per container, SQLite): `meta` (copy of the container, live config and
  destination list, pushed by the control plane on create/publish/rollback/destination
  changes, so `/collect` never reads D1), `visitors` (click IDs with timestamps, fbp/fbc,
  `_ttp`, GA client/session id, first- and last-touch UTM, landing page, user_id, SHA-256
  email/phone/name hashes, last IP/UA/geo, consent; only for visitors whose consent allows a
  visitor id, so a backend conversion joined later is delivered with them), `events` (the event
  log, last 7 days: each event's per-destination status, attempts, HTTP status and response
  snippet). The log keeps no raw IP, user agent, city or postal code (`src/service/privacy.ts`):
  conversions store `ip_network` (IPv4 /24, IPv6 /48), country/region and coarse device fields,
  and the logged destination requests and answers have those values replaced. The raw IP and
  user agent ride only in each pending delivery's queue message (gone once delivered or given
  up). Rows are
  keyed by `(source, event_id)`: browser hits dedupe against browser rows, backend events
  against backend rows, so the dedupe window is the 7-day log retention; a daily alarm purges
  events after 7 days and visitors 180 days after they were last seen. Each row is written
  before its queue messages are sent, so concurrent copies of one event are delivered once.
  A `usage` table counts browser events, backend events and deliveries per UTC day (only ever
  incremented) for the daily quotas and budgets; when an account or platform event budget is set,
  the object reports its counts to D1 at most once a minute and reads the totals back (see
  "Abuse and cost controls"); visitor rows are capped
  (`MAX_VISITORS_PER_CONTAINER`, least recently seen evicted) and `/collect` stops writing when
  the database passes `MAX_CONTAINER_DB_BYTES` (see "Abuse and cost controls").
  Also `preview_log` (what preview builds post: per event, triggers matched and tags fired or
  not, with reasons; 500 entries per token, 48 h), `tag_stats` (per-tag fired/blocked/error/
  skipped/excluded/test_skipped counts per day from `settings.report_tag_fires`, only the live
  config's tag ids, 30 days) and `pages` (host + path coverage of live hits, at most 1000 rows, 30 days).
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
    //        read only), constant, lookup {input, map}, regex_table {input, rows: [{pattern,
    //        output ($1)}]}, url {component, param?, source?, strip_www?}, event_attr {attr},
    //        param_set {params}, custom_js {code} (custom code), page_url, page_path,
    //        page_hostname, referrer, click_text, click_url, form_id. Every variable may have
    //        `default`, `format` {lowercase, uppercase, trim, number, map_undefined, map_null,
    //        map_true, map_false} and `description`.
    // Built-ins usable without defining: page_url, page_path, page_hostname, page_title,
    //        referrer, event, click_* (text, url, id, classes, target, element), form_* (id,
    //        action, classes, target, text, element), event_element, scroll_depth/units/
    //        direction, percent_visible, visible_ms, history_source/old_url/new_url,
    //        error_message/url/line, container_id, container_version, environment, debug_mode,
    //        visitor_id, ga_client_id, ga_session_id, video_* (8)
  ],
  "triggers": [
    { "id": "all_pages", "type": "page_view" },
    { "id": "thank_you", "type": "page_view", "conditions": [{ "var": "page_path", "op": "starts_with", "value": "/thank-you" }] },
    { "id": "lead_form", "type": "form_submit", "selector": "form#contact" },
    { "id": "purchase_dl", "type": "custom_event", "event": "purchase" }
    // types: consent_init, init, page_view, dom_ready, window_loaded, history_change,
    //        js_error, click {selector?, links_only?, check_validation?, wait_for_tags_ms?},
    //        form_submit {selector?, check_validation?, wait_for_tags_ms?}, custom_event
    //        {event | event_regex}, element_visible {selector, threshold?, once? element|page|
    //        false, min_duration_ms?, observe_dom?}, scroll_depth {percentages?, pixels?,
    //        direction?}, timer {interval_ms, limit?}, trigger_group {triggers}, video
    //        {statuses, percentages?, providers?}. ops: equals, contains, starts_with,
    //        ends_with, matches_regex, matches_css_selector, and not_* of each, plus lt, lte,
    //        gt, gte; conditions AND together; optional ignore_case
  ],
  "tags": [
    { "id": "ga4", "type": "ga4", "params": { "measurement_id": "G-XXXX" }, "triggers": ["all_pages"], "consent": ["analytics_storage"] },
    { "id": "meta", "type": "meta_pixel", "params": { "pixel_id": "123" }, "triggers": ["all_pages"], "consent": ["ad_storage"] }
    // types: ga4, google_ads (both with config_params / config_params_from), meta_pixel,
    //        tiktok_pixel, linkedin_insight, microsoft_uet, reddit_pixel, x_pixel,
    //        pinterest_tag, snap_pixel, image_pixel {url, cache_bust?}, analytics (our
    //        analytics app: loads <base_url>/s.js with data-site), custom_html, custom_js
    // also: exclude_triggers, once_per_page, enabled, description, priority (higher first),
    // schedule {start?, end?}, live_only, after {tag, require_success?} (sequencing: the setup
    // tag fires first, once per page, and this tag waits for its scripts),
    // event_params_from (a param_set variable). When `consent` is omitted
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
    // holding GA4 items), params, once_per_page; user_data may be "auto" (the first email and
    // phone field of the submitted form). send_to also takes linkedin {conversion_id},
    // microsoft_uet {event_action}, reddit {event_name}, x {event_id}, pinterest {event_name},
    // snap {event_name}, analytics {event_name?}; google_ads {conversion_action_id} overrides
    // the server destination's conversion action, {remarketing: true, vertical?} adds a
    // dynamic remarketing event.
  ],
  "consent": {
    "mode": "none",               // none | opt_in | opt_out
    "default": { "analytics_storage": "granted", "ad_storage": "granted", "ad_user_data": "granted", "ad_personalization": "granted" },
    "regions": { "EEA": { "ad_storage": "denied", "ad_user_data": "denied", "ad_personalization": "denied", "analytics_storage": "denied" } },
    "google_consent_mode": "basic", // basic: Google tags wait for consent; advanced: they load and gtag sends cookieless pings
    "wait_for_update_ms": 500,      // passed to gtag('consent','default')
    "tcf": false                    // follow an IAB TCF v2 CMP (__tcfapi); see llms.txt for the purpose mapping
  },
  "consent_banner": {               // the built-in consent banner; { "enabled": true } alone is complete
    "enabled": true, "regions": "eea", // eea (EEA + UK + CH + unknown country) | all
    "categories": ["analytics", "ads", "personalization"], "privacy_url": "https://example.com/privacy",
    "position": "bottom", "expiry_days": 180, "version": 1, "reopen_button": false,
    "text": { "title": "..." }, "languages": { "de": { "accept": "Alle akzeptieren" } }, "colors": { "accent": "#1a56db" }
  },
  "settings": { "phone_country_code": "1", "cookie_domain": "example.com", "listen_to_gtag_events": false, "send_page_views": true, "debug": false,
                "cross_domain": ["checkout.example.net"], "cross_domain_forms": false, "report_tag_fires": false,
                "respect_dnt": true }         // default: nothing runs under Global Privacy Control / Do Not Track
}
```

Objects are strict (unknown keys are errors, so typos surface). `PUT /draft` rejects configs
that don't match the schema (400 with per-field details); semantic problems are returned in
`validation` and block publish. The validator (`POST /draft/validate`) returns `errors` and
`warnings`, each `{ path, code, message, hint }`: undefined triggers/variables, duplicate ids,
invalid regexes, placeholder pixel ids, purchases without value/currency (Meta Purchase without
them is an error), phones without a country code setting, conversions that no tag or
destination will deliver, `server: true` with no destination of that type, unused variables
(every place a config names a variable counts: conditions, tag params and `conversions[].params`
templates, param sets, conversion fields), templates in `send_to.ga4.params` /
`send_to.meta.custom_data` (sent as written: `template_not_rendered`), destinations that
receive nothing, Google Ads tag + upload double counting, and consent gaps (ad pixels with no
consent config, opt-in without a banner call, EEA without GB, ad tags with `consent: []`), and
for the consent banner: no privacy link, ad tags without the ads category, visitors outside the
regions who start denied but are never asked, a TCF CMP as well, and colors under 4.5:1 contrast.

### Consent banner (`consent_banner`, replaces Cookiebot)

Versioned with the rest of the config (draft -> publish). The runtime decides per visitor:
asked (regions `eea`: Cloudflare's country is in the EEA, the UK or Switzerland, or unknown;
`all`: everyone) and no current choice -> every category denied and the banner UI loaded; a
stored choice (`_afst_cc` = consent id, banner version, time, bits; re-asked when `version`
changes or after `expiry_days`, default 180, max 395) -> applied without the UI; everyone else
-> the `consent` block's defaults. With regions `eea` the script is `cache-control: private`
(also for `consent.regions`, which depend on the country too) and says `x-afs-consent-banner:
ask|default`. Categories map to Consent Mode v2: analytics -> `analytics_storage`; ads ->
`ad_storage`, `ad_user_data`; personalization -> `ad_personalization`, `personalization_storage`,
`functionality_storage`. On every page and choice: `gtag('consent','default')` before any Google
tag (also without Google tags in the config) and `'update'` on a choice; tags gated by their
consent types are released or held; `dataLayer.push({ event: "afst_consent", afst_consent })`;
`afsr('consent', analytics)` for replay (and `afsr('consent', false, 1)` while undecided);
`afsa('consent', analytics)` when the analytics tracker was loaded with
`data-require-consent="true"` (persistent visitor ids; cookieless analytics stores nothing and
isn't told). Withdrawal deletes this container's identity cookies. Reopen with
`afst('consent','open')`, any element with `data-afst-consent-open`, or `reopen_button`.

The UI (`src/runtime/banner.ts`, bundled alone as `dist/consent-ui.txt`, about 7 KB / 3.4 KB
gzip) is served at `/cb/<version>.js` (immutable) and loaded only when it must show. It renders
in a shadow root: first layer with "Reject all" styled exactly like "Accept all", settings layer
with unticked boxes per category (the current choice when reopened), labelled dialog, focus
moved in and restored, Tab trapped in modal layers, Escape, `prefers-reduced-motion`, stacked
buttons under 600 px. Text is plain text with English defaults, overridable per language
(`<html lang>`, then the browser's languages).

Each choice is posted to `/collect` as `type: "consent"` and stored in the ContainerDO
(`consent_records`, 12 months; `consent_daily` counts for the rates): consent id, server time,
banner version, method (`accept_all` / `reject_all` / `custom`), choice per category, country,
text language and container version, never the IP, user agent or visitor id. Test traffic isn't
recorded; `MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY` caps records (unset = off). `GET
/containers/:id/consent` (rates, totals, status) and `/consent/records?consent_id=` (one
visitor's history) read them.
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
container's snippet in a real `<script src>` tag on `https://<domain>/` itself (or
`https://www.<domain>/` after a redirect; answered 2xx; no query string or other page), found by
`verify` or `scan`. Text a page only echoes (comments, attribute values, JSON in an inline script,
textarea/title/noscript/template content) never counts.
Preview links and environments of a draft that may not run custom code are served without those
tags. `custom_js` variables count as custom code too.

**Editing and migrating.** Items can be edited one at a time (`PUT|DELETE /draft/:kind/:key`,
`POST /draft/:kind/:key/revert`), each write guarded by the draft revision it read: without
`?revision=` a change is re-applied on top of a newer draft, with it a stale revision is a 409.
`GET /diff` compares any two of live, draft and a version, in plain words and JSON paths, and
`GET /draft` includes `changes_vs_live`. `POST /draft/import` takes a GTM container (the export
file, a `containerVersion`, or the GTM API / Tag Manager MCP lists `{ tag, trigger, variable,
builtInVariable?, customTemplate? }`, plural keys and list responses too, all normalised to the
export's shape and mapped the same way; every GTM tag, trigger and variable reported as mapped,
adapted with a note, or unmapped with the reason; at most 2 MB; custom HTML/JS stays custom code)
or this platform's own JSON, merged by key (`on_conflict` overwrite, rename or skip) or replacing
the draft, with `dry_run`; re-running an import changes nothing. The container remembers the
last scan (`last_scan`: the tools the site used, as slugs with their public ids, never page text)
and the last real import (`last_import`: format, mode and per-kind counts), migration 0009.

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
| `meta` | Conversions API (Graph v26.0) | pixel_id, access_token, test_event_code? | `test_event_code` (without it: test traffic skipped, test 400) |
| `google_ads` | offline click conversions: Data Manager API `events:ingest` (default) or Google Ads API v26 `uploadClickConversions` (`api: "google_ads_api"`); gclid/gbraid/wbraid + hashed email/phone | customer_id, conversion_action_id (an "Import from clicks" action), oauth client_id/client_secret/refresh_token, login_customer_id?, developer_token? (google_ads_api only), api? | `validateOnly: true` |
| `tiktok` | Events API 2.0 | pixel_code, access_token, test_event_code? | `test_event_code` (without it: test traffic skipped, test 400) |
| `linkedin` | Conversions API (REST, LinkedIn-Version 202610) | ad_account_id, access_token? and/or refresh_token? + client_id? + client_secret?, conversion_rules? (Insight Tag id -> CAPI rule id) | none: test traffic is skipped, the test answers 400 `no_test_mode` |
| `pinterest` | Conversions API v5 `ad_accounts/{id}/events` | ad_account_id, access_token | `?test=true` |
| `reddit` | Conversions API v3 `pixels/{pixel_id}/conversion_events` | pixel_id, access_token, test_id? | `data.test_id` (without it: test traffic skipped, test 400) |
| `snap` | Conversions API v3 (tr.snapchat.com) | pixel_id, access_token | `/events/validate` |
| `x` | Ads API v12 `measurement/conversions/{pixel_id}` (OAuth 1.0a) | pixel_id, consumer_key, consumer_secret, access_token, access_token_secret | none: test traffic is skipped, the test answers 400 `no_test_mode` |
| `analytics` | our analytics app server ingest | site_id, api_key? (an `afs_` key), base_url? (with api_key only; default `ANALYTICS_BASE_URL`; https, same host as `ANALYTICS_BASE_URL` when set, no query string, no IP literal, not this deployment; re-checked when sent). Without api_key, on a deployment with the `ANALYTICS` service binding and `INTERNAL_TOKEN`, events go over the binding to `https://analytics.internal` with internal auth as the container's account: the site must be that account's (checked when saved, `400 analytics_site_not_found`, and by analytics on each delivery). Without the binding, api_key is required | `debug: true` (analytics test traffic, out of reports unless `debug=include|only`); the test sends one `tags_test` event |
| `webhook` | POST JSON, `x-signature` HMAC-SHA256 | url (https on a public host name, no IP literal or local name; http://localhost only with `DEV_MODE=true`; never this platform's domain or a subdomain of it), secret | `"test": true` in the payload |

- Platform destinations (`ga4`, `meta`, `google_ads`, `tiktok`, `linkedin`, `pinterest`,
  `reddit`, `snap`, `x`) receive server conversions whose `send_to` has their type, deduped with
  the browser pixel by the conversion's `event_id`; `analytics` receives every server conversion and backend
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
  answer is kept (at most 8 scalar JSON fields or 200 characters of text, tags stripped, and
  secret-named fields and key- or token-like strings replaced with `[redacted]`).
- Deliveries never follow redirects (a 3xx is a failed delivery) and read at most 64 KB of the
  answer. Webhook URLs can't point anywhere on this platform: its hosts (`PUBLIC_BASE_URL`,
  `AUTH_ISSUER`, `ANALYTICS_BASE_URL`, the host the API was called on), the domain they share
  and every subdomain of it (so not the site's `/v1/signup`, nor `mail.`), checked when saved
  and again when sent. Tests of webhook and analytics destinations (URLs the account chooses)
  return the HTTP status and a short, redacted summary, never the body.
- Adding a destination, or changing a destination's credentials (a webhook URL included), needs
  the project's own API key: an OAuth access token from a connected app gets
  `403 temporary_credential`, since a destination keeps receiving conversion data after the
  token expires (setup reports such destinations in `destination_errors`).
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

- Settings (all optional): `conditions` routes by event field (value, currency, name, source,
  country, region, city, transaction_id, page_url, referrer, user_id, event_id, visitor_id,
  `params.<key>`; failing events are logged as `skipped` with the condition); `params` allows or
  excludes custom params (and excludes standard fields such as `ip`, `user_agent`, `user` = all
  hashed PII), sets params, `value` or `currency` from a literal, another field or a lookup table
  (`{ lookup, key: "items[].item_id" }` sums per-item values times quantity), and
  `redact_query` drops query strings from page_url and referrer; `template` (webhook only) sets
  the method, static non-secret headers and a JSON body with `{{event.*}}` placeholders, signed
  as before. Transformations run in the queue consumer right before sending; tests show them.
- Lookup tables (`PUT /v1/containers/:id/lookups/:name { rows }`) live in D1, are read by the
  queue consumer and never reach browsers.

(Microsoft Advertising server-side conversions aren't built yet: its UET Conversions API is
documented but still rolling out. UET conversions are browser-only for now.)

**Test traffic** (browser test traffic, backend events with `test: true`, destination tests) is
never delivered as a real conversion. Each connector uses its platform's test mechanism (GA4's
validation server, Google Ads `validateOnly`, Meta/TikTok `test_event_code`, Reddit `test_id`,
Pinterest `?test=true`, Snap `/validate`, analytics `debug: true`, webhook `"test": true`); where
there is none (Meta/TikTok/Reddit without a test code, LinkedIn and X always) the delivery is
skipped with `test event, no test mode configured: <how to set one up>` and the destination test
answers 400 (`test_event_code_required` / `no_test_mode`) without sending anything.

**Browser test traffic** is how an agent (or a person) clicks through the site like a visitor
without making a real conversion. A tab is test traffic when:

- a page was opened with `?afsa_debug=1`: the runtime stores `afsa_debug = "1"` in sessionStorage,
  the same key and values the analytics tracker uses (and replay reads), so a flag set by either
  script holds for both, for the rest of the tab; `?afsa_debug=0` stores `"0"` and ends it;
- `afst('test', true)` was called (`afst('test', false)` ends it; both also call
  `afsa('debug', ...)` when the analytics tracker is on the page); `afst('get', 'test')` reads it;
- it runs a preview link (an expired link loads the live container and sets the tab flag).

In test traffic the ad and vendor pixel tags (`ga4`, `google_ads`, `meta_pixel`, `tiktok_pixel`,
`linkedin_insight`, `microsoft_uet`, `reddit_pixel`, `x_pixel`, `pinterest_tag`, `snap_pixel`,
`image_pixel`), and conversions through them, don't fire. Each is reported as would-have-fired:
`test_skipped` in the preview log (reason "test traffic: ad pixels don't fire in the browser; the
server-side conversion is sent in test mode") and in `GET /tag-stats`, where such a tag isn't
listed in `never_fired`. The `analytics` tag still runs and calls `afsa('debug')` first (and loads
the tracker with `data-debug`), so those visits are analytics test traffic; `custom_html` and
`custom_js` still run (the owner's code can check `afst('get','test')`); `live_only` tags are
skipped. Every `/collect` hit carries `test: 1`.

The server treats a hit as test when it carries `test`, any preview token (valid or not, so a
token that expires mid-session doesn't turn the rest of it into real conversions), or
`afsa_debug=1` in its `page_url` (as analytics does). Its conversions go to each destination's
test mode or are skipped as above, analytics gets `debug: true`, webhooks `"test": true`, the
event log row has `test: true` (`preview` is the older name for the same flag) and `/collect`
answers `test: true`. Test hits never create, update or join a visitor (browser hits never link
identities either); a test backend event naming such a `visitor_id` gets a note saying why it
didn't join. They count toward the usual rate limits, quotas and budgets. A test hit from a
headless browser (a user agent saying `Headless` and nothing else bot-like: Playwright,
Puppeteer) is kept, as analytics does; without the flag it's dropped as a bot, and crawlers are
dropped either way.

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
otherwise they stay in memory for the page). The consent banner's `_afst_cc` holds only the
choice itself, so it is written when the visitor chooses (strictly necessary). When served first-party (proxy), `/collect` also
re-sets them server-side via `Set-Cookie` so they survive Safari ITP's 7-day script-cookie cap.
The visitor IP (sent on to the conversion APIs) is `cf-connecting-ip`, or the first
`X-Forwarded-For` hop only when the request carries the container's `x-afs-proxy-key`
(HMAC-SHA256 of `"afs-tags-proxy:" + container id` with `ENCRYPTION_KEY`), which the proxy
configs from `GET /install?proxy=1` add server-side (the key is only returned there, to
full-access keys; `POST /containers` and a plain `GET /install` say how to get it). A client-set
`first_party` flag or forwarded header alone is ignored.

**Global Privacy Control and Do Not Track** (`settings.respect_dnt`, default true): when the
browser has `navigator.globalPrivacyControl === true` or `doNotTrack === "1"` (navigator or the
legacy `window.doNotTrack`), the runtime stops before doing anything: no tags, no `/collect`
hits, no cookies or storage, preview included. `afst()` stays defined as a no-op so a consent
banner's calls don't throw. `false` runs as usual (consent rules still apply). `GET
/containers/:id` shows `privacy.respect_dnt` for the live version and the draft.

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
`gtm.*` events ignored), `afst('event'|'consent'|'identify'|'get'|'debug'|'test', ...)` with a
queue stub, CMPs calling `gtag('consent','update', ...)` are followed, Consent Mode v2 default/update
passed to gtag, Meta/TikTok/UET consent APIs called on change, tags blocked by consent queue and
fire once granted, Consent Mode v1-style updates (only `ad_storage`) carry `ad_user_data` and
`ad_personalization` along, `history_change` starts a new "page" for `once_per_page`, debug log
in `window.__afst_debug` and the console (`?afst_debug=1`, preview, or `settings.debug`).

## API (under `/v1`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (public) |
| GET | `/schema` | JSON Schema for the config, tag/trigger/variable catalog with examples, destination credential schemas (public) |
| GET | `/usage` | every cap for the account (its standing's values) with `label`, `used / limit / remaining / resets_at`, `unit`, `var`, `note`, `drops_data`, and `per` (every container, highest first, at most 25) for per-container caps, plus `attacks` (containers under attack, contained, or ended in the last 24 h); read keys and the platform's internal calls too |
| POST, GET | `/containers` | `{ domain, name?, allowed_hostnames?, protection? }`; same domain returns existing |
| GET, PATCH, DELETE | `/containers/:id` | GET includes destinations, last-24h stats and `container.last_scan` / `container.last_import` (null until there is one) and `protection` (attack protection state); PATCH `{ name?, allowed_hostnames?, protection?: "auto"\|"strict"\|"off" }` |
| GET | `/containers/:id/install` | snippet, API guide and how to get the proxy configs; `?proxy=1` (full-access key) adds the first-party proxy configs (Cloudflare Worker, Next.js middleware, Vercel, netlify.toml, nginx) with the container's secret `proxy_key` |
| POST | `/containers/:id/scan` | `{ url?, paths? (at most 5), follow_links? }`: fetch the site (own domain only, https on the default port, no IP literals; the homepage (or url) plus up to 5 paths, 6 pages at most, with up to 3 linked contact/signup/pricing pages filling the room left; 2 at a time; redirects followed by hand, at most 3 hops and only within the domain; 1 MB per page; write key; `SCAN_LIMITER` per account; finding this container's snippet on `https://<domain>/` verifies the domain): existing tags (GTM-, G-, AW-, fbq, ttq, LinkedIn, UET, Reddit, X, Pinterest, our container/analytics, Plausible, Fathom, Umami, Matomo, Simple Analytics, DataFast, PostHog, Mixpanel, Amplitude, Segment, Heap, Hotjar, Clarity, FullStory, LogRocket, ...; only from script src, inline code, globals and noscript pixels, never links or text; kept on the container as `last_scan`, with next_steps for bringing GTM, analytics history and ad pixels over), consent platforms, CMS, forms, CTAs (buttons outside forms, data-attribute and button-styled links, nav/header and outbound links, with kind, area and a selector), thank-you pages; text in `<pre>`, `<code>`, `<template>`, comments and escaped markup is ignored; suggested config |
| POST | `/containers/:id/verify` | `{ method?: "auto"\|"dns"\|"snippet" }`: domain verification (needed to publish custom code), rate limited with scan |
| POST | `/containers/:id/setup` | the `setup_conversion_tracking` recipe over REST |
| GET, PUT, PATCH | `/containers/:id/draft` | full replace (PUT) or JSON merge patch (PATCH); optional `?revision=` guards concurrent edits; `413 draft_too_large` over `MAX_DRAFT_BYTES`; GET has `changes_vs_live` |
| GET, PUT, DELETE | `/containers/:id/draft/:kind/:key` | one tag, trigger, variable or conversion (`?revision=` optional; without it the edit is re-applied on a newer draft) |
| POST | `/containers/:id/draft/:kind/:key/revert` | copy the item back from the live version (or remove it) |
| GET | `/containers/:id/diff` | `?from=live&to=draft` (or version numbers): summary, per-item changes with JSON paths |
| POST | `/containers/:id/draft/import` | `{ format: "gtm"\|"afst", data\|config, mode?, on_conflict?, dry_run? }`: GTM container import (export file, containerVersion, or Tag Manager API lists) or own JSON; a real import sets `last_import`, with a mapped/adapted/unmapped report; 2 MB max |
| POST | `/containers/:id/draft/validate` | errors and warnings with hints; optional `{ config }` validates without saving |
| POST | `/containers/:id/preview` | `{ ttl_minutes?, path?, version? }` -> preview token + URL to open (`?afst_preview=`) |
| GET | `/containers/:id/preview/:token/log` | the preview log: per event, triggers matched or why not, tags fired / waiting for consent / not fired and why (untrusted) |
| POST | `/containers/:id/publish` | `{ note?, version? }`: new immutable version from the draft (or a saved version), goes live (422 with the errors if invalid) |
| POST | `/containers/:id/versions` | save the draft as a version without publishing |
| GET | `/containers/:id/versions`, `/versions/:n` | newest `max_versions` kept (plus live and environment-pinned ones) |
| POST, GET, PATCH, DELETE | `/containers/:id/environments[/:eid]` | `{ name, version: n\|"draft" }`: a named snippet pinned to a version; PATCH version = publish to it; `POST .../:eid/reauthorize` rotates its token |
| PUT, GET, DELETE | `/containers/:id/lookups[/:name]` | lookup tables for destinations' `settings.params.set` |
| GET | `/containers/:id/quarantine` | what attack protection set aside, `?since=7d` (at most 7 days): by reason, type and day, top network operators (ASN), countries; pages and browsers under `untrusted` |
| GET | `/containers/:id/tag-stats`, `/coverage` | per-tag fire counts (`settings.report_tag_fires`) and pages that sent hits, `?since=7d` |
| GET | `/containers/:id/consent` | consent banner status (live / draft), accept / reject / custom totals and rates, per category and per day, `?since=30d` (at most 365d), today's records against the cap, `next_steps` |
| GET | `/containers/:id/consent/records` | proof of consent, newest first: `?consent_id=` (one visitor's history), `since`, `before` (cursor), `limit` |
| POST | `/containers/:id/rollback` | `{ version }`: moves the live pointer to that version; the draft is unchanged |
| POST, GET, PATCH, DELETE | `/containers/:id/destinations[/:did]` | POST: `403 quota_exceeded` past `MAX_DESTINATIONS_PER_CONTAINER` |
| POST | `/containers/:id/destinations/:did/test` | `{ event_name?, test_event_code? }`: sends a test event in the platform's test mode, returns the platform's answer (webhook/analytics: status + short summary); never a real conversion (400 `test_event_code_required` / `no_test_mode` instead); `TEST_LIMITER` per account; a pass closes an open circuit |
| POST | `/containers/:id/events` | server-side conversions (batch of up to 100), joined to visitors |
| GET | `/containers/:id/events` | event log with per-destination results; filters `name`, `status`, `source`, `since` (ms, ISO or `15m`/`2h`/`7d`), `before` (cursor), `limit`, `include_visits`, `verbose` (adds the event data and the request sent, without the raw IP, user agent, city or postal code). Third-party strings (page data, params, items, browser order ids, destination answers, requests) are only under `untrusted` keys |
| GET | `/containers/:id/visitors/:vid` | stored identity/click record (debugging) |

Also from `@afs/shared`: `GET /v1/me`, `GET|POST /v1/keys`, `DELETE /v1/keys/:id`. `DELETE
/v1/account` is the platform's own (see Project deletion under Abuse and cost controls).

Public (no key): `GET /c/:id.js` (header `x-afs-version: <live version>`; 403 for a suspended
account), `POST /collect` (text/plain JSON, no preflight; the page host must be the container's
domain, a subdomain or an `allowed_hostnames` entry (no wildcards over public suffixes like
`*.com`); an unknown container id gets 404; known bots are ignored except preview traffic and
test traffic from a headless browser;
`429 rate_limited` past the edge limits, `429 quota_exceeded` past the daily event quota,
`507 storage_full`, `403 account_suspended`), both under any path prefix for proxying,
`GET /llms.txt`.

## MCP tools

`create_container`, `list_containers`, `get_container`, `update_container`,
`delete_container`, `get_install_instructions`, `scan_site` (write scope, like REST; its page
content is marked untrusted), `verify_domain`, `get_config_schema`, `get_draft`, `get_draft_item`,
`upsert_draft_item`, `remove_draft_item`, `revert_draft_item`, `update_draft`, `patch_draft`,
`import_draft`, `diff_versions`, `validate_draft`, `create_preview`, `get_preview_log`, `publish`,
`create_version`, `list_versions`, `rollback`, `create_environment`, `list_environments`,
`update_environment`, `reauthorize_environment`, `delete_environment`, `add_destination`,
`list_destinations`, `update_destination`, `remove_destination`, `test_destination`, `put_lookup`,
`list_lookups`, `get_lookup`, `delete_lookup`, `send_server_events`, `get_event_log`,
`get_visitor`, `get_tag_stats`, `get_coverage`, `get_quarantine`, `get_consent`, `list_consent_records`, `get_usage`, `setup_conversion_tracking` (recipe: given
platforms + conversions in plain terms, writes a complete draft, creates destinations for
platforms with credentials, validates it, and returns what's left to do, e.g. which IDs are
missing and where to find them; a conversion gets `server: true` only when a destination will
receive it, and `ready_to_publish` is true only when no warning says a conversion won't be
delivered, each such gap being listed in `missing`). `get_install_instructions { proxy: true }`
is the only tool that returns the proxy key. Read-only keys only see the read tools. `get_event_log`,
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
- **Daily event budgets across containers** (UTC day, counters only go up: deleting and
  re-creating containers frees nothing): per account (`MAX_EVENTS_PER_ACCOUNT_PER_DAY`, summed over
  its containers) and platform-wide (`MAX_EVENTS_PER_DAY`; unclaimed accounts stop at
  `UNCLAIMED_MAX_EVENTS_PER_DAY` on the same counter), browser hits and backend events counted
  separately. A D1 write per event would cost too much, so each ContainerDO reports its own
  absolute counts to D1 `usage_daily` at most once a minute (or per 1% of the smaller budget, at
  most 1,000 events) and reads the account's and the platform's (`usage_global`) totals back; a
  container reports what's left when it's deleted. Past a budget `/collect` and
  `POST /v1/containers/:id/events` answer `429 quota_exceeded` until 00:00 UTC, and
  `GET /v1/containers/:id` shows `stats.today.account`, `account_quota_reached` and
  `platform_quota_reached` with a warning. No budget set = no D1 call; a D1 failure fails open
  (logged), and the per-container quota still applies.
- **Storage**: per-account bytes of drafts + versions; per-container daily event quotas
  (`MAX_EVENTS_PER_CONTAINER_PER_DAY`, browser hits and backend events counted separately, 429
  past it); a visitor cap with eviction; a database-size threshold where `/collect` stops writing
  (backend events keep working up to 25% past it); bounded maps and strings in everything
  `/collect` stores (known click ids, utm_* and consent keys only, 25 scalar params, bounded
  first touch, id-shaped fbp/fbc/GA ids, 512-character user agent).
- **Attack protection** (`src/service/protection.ts`, per container `protection: auto | strict | off`):
  container ids are public, so one source could fill a container's daily budget. Past
  `MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY` browser hits from one network (IPv4 address or
  IPv6 /48, counted by an HMAC of container id, UTC day and network keyed from `ENCRYPTION_KEY`, one
  upsert per hit into the DO's `net_daily`), the rest of its hits that day are quarantined and the
  container is "contained". A 15-minute window with at least 10x the usual rate (the previous 7
  days' `browser_events` / 96) and at least 1000 (`SPIKE_MIN_EVENTS`) puts it "under_attack" (in
  memory, no extra query per hit): data-centre ASNs are quarantined and browser conversions are held
  (each destination skipped with a `held: ...` reason). `strict` applies those measures always.
  Episodes end an hour after the last trigger. Quarantined hits are logged (`status: quarantined`,
  `quarantine`, `asn`, `as_org`; up to `MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY`), never
  delivered, never stored as visitors and not counted against the daily budgets. Backend events
  are never affected. `GET /v1/usage` reports episodes in `attacks` for the platform site's emails.
- **Custom code** needs a verified domain and a claimed account (above), for tags and
  `custom_js` variables, imported or not; environments and `publish { version }` apply the same
  rule, and a page can block types itself (`data-afst-block`).
- **New stored things are capped**: environments (`MAX_ENVIRONMENTS_PER_CONTAINER`, default 5),
  lookup tables (`MAX_LOOKUPS_PER_CONTAINER` 10, `MAX_LOOKUP_ROWS` 10000, `MAX_LOOKUP_BYTES`
  1 MB, counted in `MAX_TAGS_BYTES_PER_ACCOUNT`), imports (2 MB, depth-checked, validated), the
  preview log (500 entries per preview token, only with a valid token, 48 h), tag stats (only the
  live config's tag ids; each telemetry hit counts as a browser event) and coverage (1000 pages,
  30 days). Each cap reads `UNCLAIMED_<NAME>` too.
- **Outbound fetches** (scan, verify, destinations) go only to https public host names (scan
  and verify on the default port), never IP literals, local names or this platform (webhooks:
  not its domain or any subdomain); analytics destinations only to the analytics app's host.
  Destinations can't be added or re-pointed with an OAuth access token.
- **Suspended accounts** (`accounts.suspended_at`, see `@afs/shared` `accountStanding`): their
  keys stop working, `/collect` and `/c/:id.js` answer 403 and queued deliveries are dropped.
- **Usage** (`GET /v1/usage`, MCP `get_usage`, `src/service/usage.ts`): every account and
  per-container cap and daily budget above with the value for the account's standing and what is
  used now, in the item shape mail, analytics and replay share (`label`, `drops_data`, `per`), so the
  platform site can warn owners before a limit. `drops_data: true` marks the daily event and
  delivery budgets, `visitors_per_container` and `container_db_bytes`, where reaching the cap loses
  incoming data rather than failing a call. It is cheap enough to read hourly: one D1 batch
  (per-container counts through the `container_id` indexes, today's `usage_daily` and
  `delivery_usage` rows) and one `ContainerDO.usageToday()` per container (point reads of the
  `usage` table, the visitor count eviction keeps, the database size; at most 100 containers).
  The account's daily event totals are each container's own count plus what containers deleted
  today reported. Deployment-wide budgets are not listed.
- **Project deletion** (`accounts.deleted_at` in the identity DB): reads as suspended, so keys and
  ingest stop at once. 7 days later the site's cron calls `DELETE /v1/account` (internal auth only,
  no MCP tool; API keys get `403 forbidden`; `src/service/purge.ts`), which runs
  `deleteContainer()` for every container (its D1 rows and its Durable Object's storage), then the
  account's other rows. It keeps the bare `accounts` row and the fair-use counters. It answers
  `{account_id, done, deleted: {containers, destinations, versions, ...}}`; `done: false` means call
  again (about 20 s of work per call), and a live project gets `409 not_deleted`.

## Config

| Var / secret | |
|---|---|
| `PUBLIC_BASE_URL` | var; empty = request origin |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | `@afs/shared` auth |
| `AUTH_ISSUER`, `INTERNAL_TOKEN` | `@afs/shared`: the OAuth server named in `/.well-known/oauth-protected-resource` (var; set by `pnpm afs`, unset = none listed), and the secret the deployment's Workers share for internal auth: the site's dashboard, and the `ANALYTICS` binding below (unset = off) |
| `ANALYTICS` | optional service binding to this deployment's analytics Worker (`wrangler.jsonc` `services`; `pnpm afs config` maps `afs-analytics` to the profile's Worker). With `INTERNAL_TOKEN`, analytics destinations without an api_key deliver over it as the container's account, and setup needs only `analytics.site_id` |
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
| `MAX_EVENTS_PER_ACCOUNT_PER_DAY` | optional var; the same summed over an account's containers, counted in D1 (unset = off) |
| `MAX_EVENTS_PER_DAY` | optional var; the same for the whole deployment; unclaimed accounts stop at `UNCLAIMED_MAX_EVENTS_PER_DAY` on the same counter (unset = off) |
| `MAX_EVENTS_PER_NETWORK_PER_CONTAINER_PER_DAY` | optional var; browser hits one network may send a container per UTC day before the rest are quarantined (attack protection; unset = off) |
| `MAX_QUARANTINED_EVENTS_PER_CONTAINER_PER_DAY` | optional var; quarantined hits logged per container per UTC day, the rest counted only (unset = off) |
| `MAX_CONSENT_RECORDS_PER_CONTAINER_PER_DAY` | optional var; consent banner choices recorded per container per UTC day; past it choices still apply but aren't recorded (unset = off) |
| `SPIKE_MIN_EVENTS` | optional var; fewest browser hits in 15 minutes that count as a spike, default `1000` (for tests) |
| `MAX_VISITORS_PER_CONTAINER` | optional var; visitor rows kept per container, least recently seen evicted, default `250000` |
| `MAX_CONTAINER_DB_BYTES` | optional var; ContainerDO database size above which `/collect` stops writing (backend events up to 25% more), default `1073741824` (1 GiB) |
| `CIRCUIT_BREAKER_FAILURES`, `CIRCUIT_BREAKER_MINUTES` | optional vars; consecutive failed attempts that open a destination's circuit (default `20`, `0` = off) and minutes it stays open (default `60`) |
| `MAX_ENVIRONMENTS_PER_CONTAINER` | optional var; environment snippets per container, default `5` |
| `MAX_LOOKUPS_PER_CONTAINER`, `MAX_LOOKUP_ROWS`, `MAX_LOOKUP_BYTES` | optional vars; lookup tables per container (default `10`), rows per table (default `10000`) and bytes per table (default `1048576`, never above 1.5 MB) |

Every cap above (and `MAX_CONTAINERS_PER_ACCOUNT`, `MAX_DESTINATIONS_PER_CONTAINER`,
`MAX_VERSIONS_PER_CONTAINER`, `MAX_DRAFT_BYTES`) also reads `UNCLAIMED_<NAME>` for accounts no
person has claimed; `0` turns a cap off. Rate-limit bindings: `COLLECT_IP_LIMITER`,
`COLLECT_CONTAINER_LIMITER`, `CONVERSION_IP_LIMITER`, `CONVERSION_CONTAINER_LIMITER`,
`SCAN_LIMITER`, `TEST_LIMITER`, `SERVER_EVENTS_LIMITER` (each optional; see `wrangler.jsonc`).

## Development

`pnpm db:migrate:local`, `pnpm dev` (port 8788; builds the runtime first), `pnpm typecheck`
(Worker + runtime), `pnpm test` (unit tests in Node, including the bundled runtime run in a fake
browser; integration tests in workerd via `@cloudflare/vitest-plugin`), `pnpm smoke`
(end-to-end against `pnpm dev`, with a local signed-webhook sink; needs `DEV_MODE=true` in
`.dev.vars`).

## Not yet (v2)

Microsoft Ads server-side conversions, custom domains (Cloudflare for
SaaS), the Google tag gateway and a GA4 `/g/collect` client, Measurement Protocol-compatible
ingest, a `draft` key scope (edit but not publish), A/B testing, Google Ads conversion
adjustments / enhanced conversions for web (`uploadConversionAdjustments`; click uploads already
carry hashed email/phone), offline conversion CSV import, per-tag sampling, signed browser `identify` (so a browser can
link a user id without the backend), a global (all-colo) cache purge on publish.
