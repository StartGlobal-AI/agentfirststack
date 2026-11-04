# Feature parity: Google Tag Manager (web + server-side) vs AgentFirstStack Tags

Audited 2026-11-04 against `tags/src` (llms.ts, mcp.ts, config/schema.ts, service/*, runtime/*,
destinations/*) and Google's own docs (Tag Manager API v2 reference, Tag Manager Help,
tag-platform server-side guides). Evidence paths are relative to `tags/src/`.

## Build status (2026-11-04)

The prioritised list below has since been built in `tags/` except: custom domains (Cloudflare for
SaaS, a live infrastructure change), the Google tag gateway passthrough, the GA4 `/g/collect`
client, the Measurement Protocol-compatible `/mp/collect` ingest, the `draft` key scope (needs
`@afs/shared`), the `replay` tag type, `containers.lookup` filters and Microsoft Ads server-side
conversions (its UET Conversions API is still rolling out). The tables below are the audit as it
was; `tags/llms.txt` (`GET /llms.txt`) describes what exists now.

## Summary

| Bucket | Count | Meaning |
|---|---|---|
| Have | 63 | Equivalent exists (it may work differently, but it covers the same need) |
| Partial | 33 | Part of it exists; we build or adapt the rest |
| Missing | 35 | Doesn't exist; we build or adapt it |
| Skip | 22 | Missing or partial, and we don't plan to build it (the reason is in the row) |
| **Total** | **153** | |

| Area | Have | Partial | Missing | Skip |
|---|---|---|---|---|
| 1. API resources, container types | 11 | 6 | 0 | 11 |
| 2. Triggers | 9 | 5 | 7 | 2 |
| 3. Variables | 7 | 7 | 10 | 1 |
| 4. Tag features | 7 | 4 | 4 | 1 |
| 5. Server-side | 7 | 5 | 2 | 1 |
| 6. Tag types, destinations | 16 | 3 | 9 | 4 |
| 7. Workflow | 6 | 3 | 3 | 2 |

Read it this way: what's missing is mostly breadth in the browser runtime (trigger and variable
types that GTM exports use) plus more conversion APIs. The server-side core (routing, dedupe,
consent, enrichment, test modes, delivery log) is already there and in places goes further than
server-side GTM. Most of the skips are features built around Google's own account model or legacy
container types.

How rows are counted: Have = status Have. Skip = decision skip, whatever the status. Partial and
Missing = that status with decision build or adapt.

Effort: S = under a day, including tests, llms.txt and the MCP tool. M = 2-5 days. L = more than a week.

Conventions used in "Proposed API": REST under `/v1/containers/:id/...`, snake_case JSON, MCP tool
named in snake_case and calling the same service function, and every new config field added to
`config/schema.ts`, `config/catalog.ts` (with an example), `config/validate.ts` (with hints) and
`llms.ts`.

## 1. Tag Manager API v2 resources and container types

| GTM feature | Doc | Ours (status + evidence) | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Accounts get/list/update | [api-accounts] | Have. An account is a project in `@afs/shared`: `POST /v1/signup`, `GET /v1/me`, keys | — | — | — |
| Containers create/get/list/update/delete | [api-containers] | Have. `POST/GET/PATCH/DELETE /v1/containers[/:id]` (routes/v1.ts); MCP `create_container` … `delete_container`. Creating the same domain again returns the existing container | — | — | — |
| containers.snippet | [api-containers] | Have. `GET /v1/containers/:id/install` (`get_install_instructions`): snippet + first-party proxy configs | — | — | — |
| containers.lookup (by tag or destination id) | [api-containers] | Partial. Create is idempotent by domain, but you can't find a container by domain or by pixel/measurement id | build | S | `GET /v1/containers?domain=&tag_id=` (filters on `list_containers`) |
| containers.combine / move_tag_id | [api-containers] | Missing | skip: specific to Google tag ids | — | — |
| Workspaces (several concurrent drafts) | [api-workspaces] | Partial. One draft per container with `revision` (409 `revision_conflict`), `PUT`/`PATCH /draft` (service/versions.ts) | skip: one draft plus the revision guard is enough for agents; staging needs are covered by environments | — | — |
| workspaces.sync / resolve_conflict | [api-sync] | Missing | skip: there are no forked workspaces; re-GET + retry on 409 covers it | — | — |
| workspaces.quick_preview | [api-workspaces] | Have. `POST /v1/containers/:id/preview` (`create_preview`) | — | — | — |
| workspaces.create_version (a version without publishing) | [api-workspaces] | Partial. `publish` creates the version and makes it live in one step | adapt (with environments) | S | `POST /v1/containers/:id/versions { note }` -> unpublished version; `POST /publish { version? }` |
| Tag/trigger/variable CRUD per entity (+ revert) | [api-tags], [api-triggers], [api-variables] | Partial. Whole-draft `PUT`; the RFC 7396 `PATCH` replaces arrays whole, so changing one tag means resending every tag (lib/merge-patch.ts) | build | S | `PUT/DELETE /v1/containers/:id/draft/{tags,triggers,variables,conversions}/:key` (upsert by id/name; returns draft + validation); `POST …/:key/revert` (copy from live); MCP `upsert_draft_item`, `remove_draft_item`, `revert_draft_item` |
| built_in_variables create/delete/revert | [api-builtin] | Have. Built-ins are always available, with nothing to enable (`BUILTIN_VARIABLES`, config/schema.ts) | — | — | — |
| Folders (+ move_entities_to_folder) | [api-folders] | Missing. Only `description` | skip: they organise things for humans; ids and descriptions are enough | — | — |
| Custom templates + import_from_gallery | [api-templates], [templates] | Missing. A closed set of 12 tag types; `custom_html` / `custom_js` cover the rest | skip: sandboxed-JS templates mean running hosted code. Grow the built-in catalog instead (section 6) | L | — |
| Environments create/list/update/delete/reauthorize | [api-envs], [h-envs] | Partial. Only draft preview tokens (`prv_…`, up to 24 h; service/versions.ts `createPreview`) | build | M | `POST /v1/containers/:id/environments { name, version: n\|"draft", hostnames? }` -> `{ id, snippet (/c/:id.js?env=<token>), preview_url }`; `PATCH` (set version = publish to environment); `POST …/:eid/reauthorize` (rotate token); MCP `create_environment`, `list_environments`, `update_environment` |
| versions get/list/live | [api-versions] | Have. `GET /versions`, `GET /versions/:n`, `live_version` (`list_versions`) | — | — | — |
| versions.publish (an older version) | [api-versions] | Have. `POST /rollback { version }` (`rollback`) applies the custom-code rules again | — | — | — |
| versions.update (name/notes after publish) | [api-versions] | Partial. `note` can only be set at publish | skip: versions are immutable by design | — | — |
| versions.delete / undelete / set_latest | [api-versions] | Missing. Pruned automatically to `MAX_VERSIONS_PER_CONTAINER`; the live version is never deleted | skip: pruning is automatic and the live version is protected | — | — |
| version_headers list/latest | [api-vheaders] | Have. `list_versions` returns summaries (counts, note, created_by) without the configs | — | — | — |
| user_permissions (account admin/user; container read/edit/approve/publish) | [api-perms], [h-perms] | Partial. Keys have scope `*` or `read` (`requireAuth`), dashboard members are owner or member. No per-container permissions, and no "can edit but not publish" | adapt | M | key scope `draft` (every write except publish, rollback and destination credentials) in `@afs/shared`; optional `container_ids[]` on a key |
| Zones (360) | [api-zones], [h-zones] | Missing | skip: 360 sandboxing of linked containers; one container per domain doesn't need it | — | — |
| containers.destinations (link G-/AW- destinations) | [api-dest] | Missing. The name clashes: our "destinations" are server connectors | skip: specific to Google tags | — | — |
| gtag_config (Google tag config settings) | [api-gtag] | Partial. ga4 has `send_page_view` and `event_params`; google_ads has `allow_enhanced_conversions` hard-coded (runtime/vendors.ts). No other config params (user_properties, cookie_prefix, cookie_flags…) | build | S | `tags[].params.config_params` (ga4, google_ads), passed to `gtag('config')` |
| Web container | [h-web] | Have. Runtime `GET /c/:id.js` + `POST /collect` (routes/public.ts) | — | — | — |
| Server container | [sgtm] | Have. The same container is also the server side: destinations + `POST /v1/containers/:id/events`, so there is no second container to wire up | — | — | — |
| Multiple containers on one page | [datalayer] | Have. `__afst_runtimes`, one guard per container (runtime/core.ts `installApi`) | — | — | — |
| AMP container | [api-triggers] | Missing | skip: AMP is legacy | — | — |
| iOS/Android (Firebase) containers | [mobile] | Missing. No SDK | skip: no mobile SDK; app backends already use `send_server_events` | — | — |

## 2. Triggers (web)

| GTM feature | Doc | Ours (status + evidence) | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Consent Initialization | [h-pageview], [h-consent] | Partial. The consent default (config, region, stored cookie) is applied at boot, before any tag (runtime/core.ts `start`). There is no trigger type to fire a CMP loader tag first | build | S | `trigger.type: "consent_init"` (runs before everything else; validate warns about non-consent tags on it) |
| Initialization | [h-pageview] | Missing. `page_view` is the first event | build | S | `type: "init"` (runs before `page_view`) |
| Page View | [h-pageview] | Have. `page_view` | — | — | — |
| DOM Ready | [h-pageview] | Have. `dom_ready` | — | — | — |
| Window Loaded | [h-pageview] | Missing | build | S | `type: "window_loaded"` (window `load`; fires right away if already loaded) |
| Click: All Elements | [h-click] | Have. `click { selector? }` (closest match) + `click_*` built-ins | — | — | — |
| Click: Just Links | [h-click] | Have. `links_only: true` | — | — | — |
| Wait for tags (link/form) | [api-triggers] | Missing. `/collect` hits survive navigation (keepalive fetch); vendor pixels may not | adapt | S | `click\|form_submit { wait_for_tags_ms? (max 2000) }`: prevent default, fire, then navigate or submit again |
| Check validation (link/form) | [api-triggers] | Missing. The submit and click listeners run in the capture phase, so they fire even when the site's own validation cancels the event | build | S | `check_validation: true` (bubble-phase listener; skip when `defaultPrevented`) |
| Element visibility | [h-vis] | Partial. `element_visible { selector, threshold, once, observe_dom }`. Missing: minimum on-screen duration, once per page (only once per element), percent/duration variables | build | S | add `min_duration_ms?` and `once: "element"\|"page"\|false`; built-ins `percent_visible`, `visible_ms` |
| Form submission | [h-form] | Have. `form_submit { selector? }` + `form_*` built-ins (wait and validation are separate rows above) | — | — | — |
| History change | [h-history] | Have. pushState, replaceState, popstate, hashchange; resets `once_per_page` | — | — | — |
| JavaScript error | [h-jserror] | Missing | build | S | `type: "js_error"` (window `error` + `unhandledrejection`, capped per page) + error built-ins (section 3) |
| Scroll depth | [h-scroll] | Partial. Vertical percentages only | build | S | `scroll_depth { percentages?, pixels?, direction?: "vertical"\|"horizontal" }` |
| Timer | [h-timer] | Have. `timer { interval_ms, limit? }` + conditions | — | — | — |
| YouTube video | [h-youtube] | Missing | build | M | `type: "video" { providers?: ["youtube","html5"], statuses: ["start","progress","pause","seek","complete"], percentages? }` (YouTube iframe API; adds `enablejsapi`) + video built-ins |
| Custom event | [h-custom] | Partial. Exact name only (`custom_event { event }`); GTM also matches by regex | build | S | `custom_event { event? , event_regex? }` (exactly one) |
| Trigger groups | [h-group] | Missing | build | S | `type: "trigger_group" { triggers: [ids] }`: fires once per page after all of them have fired |
| Trigger exceptions (blocking triggers) | [h-blocking] | Have. `tags[].exclude_triggers` | — | — | — |
| "Some events" conditions and operators | [h-blocking], [api-triggers] | Partial. AND-ed `conditions`, 10 ops (`equals` … `not_matches_regex`), `ignore_case` (lib/conditions.ts). Missing: CSS-selector match and numeric `<`, `<=`, `>`, `>=` | build | S | ops `matches_css_selector`, `not_matches_css_selector`, `lt`, `lte`, `gt`, `gte` |
| dataLayer API (push, deep merge, eventCallback, gtag consent) | [datalayer] | Have. GTM-compatible `dataLayer.push`, deep merge, `eventCallback` honoured, `gtm.*` ignored, gtag consent followed (runtime/core.ts `processEntry`). `eventTimeout` is ignored | — | — | — |
| Data layer v1 (flat keys) | [h-udv] | Missing. v2 dot paths only | skip: v1 is legacy | — | — |
| Firebase / AMP trigger types | [api-triggers] | Missing | skip: those container types are skipped | — | — |

## 3. Variables

| GTM feature | Doc | Ours (status + evidence) | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Pages: Page URL / Hostname / Path, Referrer | [h-builtin] | Have. `page_url`, `page_hostname`, `page_path`, `referrer` (+ `page_title`) | — | — | — |
| Utilities: Event | [h-builtin] | Have. `event` | — | — | — |
| Utilities: Container ID / Version, Environment Name, Debug Mode | [h-builtin] | Missing as variables. The boot config holds `id`, `v` and `preview` (runtime/types.ts) | build | S | built-ins `container_id`, `container_version`, `environment`, `debug_mode` |
| Utilities: Random Number, HTML ID | [h-builtin] | Missing | skip: used for sampling, cache busting and template plumbing; little agent value | — | — |
| Analytics Client ID / Session ID / Session Number | [h-builtin] | Partial. The runtime reads `_ga` / `_ga_<id>` and sends `ga_client_id` / `ga_session_id` to `/collect` (runtime/core.ts `gaIds`), but they can't be read as variables | build | S | built-ins `ga_client_id`, `ga_session_id`, `visitor_id` |
| Errors: Message / URL / Line | [h-builtin] | Missing | build | S | `error_message`, `error_url`, `error_line` (with `js_error`) |
| Clicks: Element / Classes / ID / Target / URL / Text (+ auto-event element attribute) | [h-builtin], [h-udv] | Partial. Has `click_text`, `click_url`, `click_id`, `click_classes`. Missing: `click_target` and any other attribute of the event element | build | S | built-in `click_target`; variable `event_attr { attr }` (attribute of the clicked, submitted or visible element) |
| Forms: Classes / Element / ID / Target / Text / URL | [h-builtin] | Partial. Has `form_id`, `form_action` (= Form URL), `form_classes`. Missing: `form_target`, `form_text` | build | S | built-ins `form_target`, `form_text` |
| History: source, old/new fragment, old/new state | [h-builtin] | Missing | build | S | built-ins `history_source`, `history_old_url`, `history_new_url` |
| Videos (8 built-ins) | [h-builtin] | Missing | build | M | `video_provider`, `video_status`, `video_url`, `video_title`, `video_duration`, `video_current_time`, `video_percent`, `video_visible` (with the video trigger) |
| Scroll: Threshold / Units / Direction | [h-builtin] | Partial. `scroll_depth` (threshold) | build | S | `scroll_units`, `scroll_direction` (with the scroll row) |
| Visibility: Percent Visible / On-Screen Duration | [h-builtin] | Missing | build | S | `percent_visible`, `visible_ms` (with the visibility row) |
| URL variable (components; another variable as source) | [h-udv] | Partial. `page_url` / `page_path` / `page_hostname`, and `url_param` (page URL only). No protocol, port, query, fragment, and no parsing of another URL (e.g. `click_url`) | build | S | `url { component: "href"\|"protocol"\|"host"\|"port"\|"path"\|"query"\|"fragment"\|"param", param?, source?: <var>, strip_www? }` |
| HTTP Referrer (components) | [h-udv] | Partial. Whole referrer only | build | S | covered by `url { source: "referrer" }` |
| 1st-party cookie | [h-udv] | Have. `cookie { cookie }` | — | — | — |
| Custom JavaScript | [h-udv] | Missing, on purpose: `js` reads a path and never evaluates code (config/schema.ts) | adapt | S | `type: "custom_js" { code }` returning a value, gated like custom-code tags (verified domain, claimed account); ship lookup, regex and format first |
| Data layer variable (v2, default value) | [h-udv] | Have. `data_layer { key }` dot path into the merged model, `default` | — | — | — |
| JavaScript variable | [h-udv] | Have. `js { path }` | — | — | — |
| DOM element (id or CSS, attribute) | [h-udv] | Have. `dom_text`, `dom_value` (searches the submitted form first), `dom_attr` | — | — | — |
| Constant | [h-udv] | Have. `constant { value }` | — | — | — |
| Lookup table | [h-udv] | Missing | build | S | `lookup { input: <var>, map: { "<in>": scalar }, default? }` |
| RegEx table | [h-udv] | Missing | build | S | `regex_table { input, rows: [{ pattern, output }], ignore_case?, full_match? }` (output may use `$1`) |
| Google Tag: Configuration / Event settings (shared parameter sets) | [h-udv] | Missing | adapt | S | `variables[] { type: "param_set", params }`, referenced as `tags[].params.event_params_from: "<name>"` |
| User-provided data (automatic / manual / code) | [h-udv] | Partial. Manual: `conversions[].user_data` mapping + `afst('identify')`, normalised and SHA-256 hashed in the browser (lib/pii.ts). No automatic detection | adapt | S | `user_data: "auto"`: the runtime takes the first email/tel input of the submitted form (`scan_site` already suggests selectors) |
| Format value (case, null/undefined/true/false mapping) | [h-udv] | Missing. Only `default` | build | S | `format?: { lowercase?, trim?, number?, map_undefined?, map_null? }` on any variable |

## 4. Tag features

| GTM feature | Doc | Ours (status + evidence) | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Firing triggers (any of) | [api-tags] | Have. `tags[].triggers` | — | — | — |
| Firing options: once per event / once per page / unlimited | [api-tags] | Have. A tag fires once per event even when several of its triggers match (runtime/core.ts `emit`); `once_per_page` resets on `history_change` | — | — | — |
| Tag sequencing (setup / cleanup, stop on failure) | [h-seq] | Missing | adapt | M | `tags[].after: { tag: <id>, require_success?: bool }` (waits for the setup tag's script onload/onerror); conversions already order the base tag before the event per platform |
| Firing priority | [h-priority] | Partial. Tags fire in array order, which is deterministic; there is no `priority` field | build | S | `tags[].priority` (integer, higher first; ties keep array order) |
| Custom firing schedule (start/end) | [h-priority] | Missing | build | S | `tags[].schedule: { start?, end? }` (ms or ISO; checked in the browser; validate warns when expired) |
| Pausing | [api-tags] | Have. `enabled: false` (filtered out at boot) | — | — | — |
| Per-tag consent (not set / not needed / required types) | [h-consent] | Have. `consent` omitted = the type's default, `[]` = not needed, a list = required. Blocked tags queue and fire when consent is granted (runtime/core.ts `gate`) | — | — | — |
| Built-in consent checks, Consent Mode v2 | [h-consent] | Have. `DEFAULT_TAG_CONSENT`, gtag consent default/update, `google_consent_mode: basic\|advanced`, `wait_for_update_ms`, regions (EEA/GB/US-CA) from Cloudflare geo, CMP gtag updates followed (lib/consent.ts) | — | — | — |
| Consent overview | [h-consent] | Have. Validate warnings `consent_gap`, `consent_not_configured`, `consent_needs_banner`, `consent_uk`, `never_fires_without_update` (config/validate.ts) | — | — | — |
| TCF v2.0 signals | [h-consent] | Missing | adapt | S | `consent.tcf: true`: map TCF purposes to consent types via `__tcfapi('addEventListener')` |
| liveOnly (skip in preview) | [api-tags] | Missing | build | S | `tags[].live_only: true` |
| Notes | [api-tags] | Partial. `description` on triggers, tags and conversions, and `note` on versions; none on variables | build | S | `variables[].description` |
| Monitoring metadata / tag-fired telemetry | [api-tags] | Partial. Browser-only log (`afst('get','log')`, `window.__afst_debug`); `/collect` gets the `fired` tag types for conversions only | build | M | `settings.report_tag_fires: true` -> the runtime batches `{ tag_id, status: fired\|blocked\|error, reason }` to `/collect`; `GET /v1/containers/:id/tag-stats?since=` (MCP `get_tag_stats`) |
| On-page allowlist / blocklist | [restrict] | Partial. Gated on the platform side: custom code needs a verified domain and a claimed account, plus `MAX_CUSTOM_CODE_BYTES` (service/verify.ts). The site can't set its own policy | build | S | `<script … data-afst-block="custom_html,custom_js">`, honoured by the runtime |
| Malware detection | [h-malware] | Partial. Custom code can't publish without domain verification and a claimed account; content isn't scanned | skip: the gate already stops third parties injecting code; content scanning costs a lot and adds little here | — | — |
| Custom HTML | [h-custom-tags] | Have. `custom_html` (scripts re-created; `{{var}}` HTML-encoded; gated) | — | — | — |

## 5. Server-side

| GTM feature | Doc | Ours (status + evidence) | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| GA4 client (accepts gtag.js `/g/collect`) | [sgtm-intro] | Missing. We take hits only from our runtime (`/collect`) and backend events | adapt (later) | L | first-party `/<prefix>/g/collect` ingest, so existing gtag.js sites can set `server_container_url` and fan out to destinations |
| Measurement Protocol client | [sgtm-intro] | Partial. `POST /v1/containers/:id/events` (`send_server_events`) is the backend ingest, with its own schema | build | M | `POST /mp/collect?container_id=&api_secret=<ingest key>` that accepts GA4 MP JSON, so MP backends can switch by changing the URL |
| Custom clients, client priority / claiming | [sgtm-intro], [templates] | Missing | skip: parsing arbitrary requests means running hosted code; the two ingest paths above cover the need | — | — |
| Transformations: allow / exclude / augment parameters | [sgtm-transform] | Partial. Global caps (25 scalar params, known click ids and UTMs), PII hashed before it leaves the browser, per-destination `settings.conversions`. No per-destination parameter control | build | S | `destinations[].settings.params: { allow?: [], exclude?: [], set?: { key: value\|{ var } }, redact_query?: bool }` applied in dispatch; visible in the `request` from `test_destination` |
| Server-side event routing conditions | [sgtm-intro] | Partial. Routing by conversion name (`send_to`), `settings.conversions`, `all_events`, consent (service/dispatch-plan.ts). No value, country or param conditions | build | S | `destinations[].settings.conditions: [{ var: "value"\|"currency"\|"country"\|"params.<k>", op, value }]` (trigger ops) |
| First-party serving (script + collect on the site's domain) | [sgtm-send], [sgtm-domain] | Have. Data plane under any path prefix; proxy configs for Worker, Next.js, Vercel, Netlify and nginx with `x-afs-proxy-key` (service/proxy.ts, containers.ts `installInstructions`) | — | — | — |
| Server-set first-party cookies (ITP) | [sgtm-domain] | Have. `/collect` sets `_afst_vid` and click-id cookies itself when first-party (service/collect.ts `identityCookies`) | — | — | — |
| Custom domain (CNAME tagging subdomain) | [sgtm-domain] | Missing. First-party needs a reverse proxy | build | M | `POST /v1/containers/:id/custom-domain { hostname }` -> Cloudflare for SaaS custom hostname, returns CNAME + TXT; `POST …/custom-domain/verify`; MCP `set_custom_domain`, `verify_custom_domain` |
| Dependency serving / Google tag gateway | [sgtm-deps], [gateway] | Partial. Our runtime can be first-party; gtag.js, fbevents.js etc. load from vendor hosts, and gtag hits go straight to Google | adapt | M | `settings.first_party_vendors: ["google"]`: data-plane passthrough `/<prefix>/gtag/js` and `/<prefix>/g/collect` to Google; proxy configs add the paths |
| Data enrichment (Firestore lookup etc.) | [sgtm-api] | Partial. A built-in identity graph enriches server events: click ids, fbp/fbc, IP, UA (ua-parser), geo (Cloudflare), first touch, joins on visitor_id / user_id / email (service/identity.ts, collect.ts). No user-supplied lookup data (SKU -> margin, user -> LTV) | adapt | M | `PUT /v1/containers/:id/lookups/:name { rows }` (row cap) + variable `{ type: "lookup_store", store, key }`, usable server-side in value/params |
| Event data model | [sgtm-eventdata] | Have. Normalised `DispatchEvent` (destinations/types.ts) | — | — | — |
| Server-side consent | [h-consent] | Have. Each connector's `requiredConsent`; consent fields in GA4 MP and Data Manager; skips logged with the reason | — | — | — |
| Server preview / debug | [sgtm-debug] | Have. Preview traffic uses test modes; `get_event_log verbose=true` shows the exact request and the platform's answer per destination; `test_destination` | — | — | — |
| Logging | [sgtm-cloudrun] | Have. A 7-day event log with per-destination status, attempts, HTTP status and reason (service/events.ts) | — | — | — |
| Hosting (Cloud Run / App Engine / manual) | [sgtm-cloudrun] | Have. Hosted on Workers, so there's no server for the user to run; self-host with `pnpm afs` | — | — | — |

## 6. Tag types and destinations

| GTM feature | Doc | Ours (status + evidence) | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Google tag (config) | [h-tags] | Have. ga4 and google_ads call `gtag('config')` once per id (runtime/vendors.ts `gtagConfig`) | — | — | — |
| GA4 event | [h-tags] | Have. ga4 `event_name` + `event_params`; `conversions[].send_to.ga4` | — | — | — |
| Google Ads conversion (web) | [h-tags] | Have. `conversion_label` or `send_to.google_ads.send_to`; transaction_id dedupe | — | — | — |
| Google Ads enhanced conversions (web) | [sgtm-ads] | Have. Hashed `gtag('set','user_data')` from `user_data` | — | — | — |
| Google Ads remarketing (dynamic) | [h-tags] | Partial. The base config gives standard remarketing; no dynamic remarketing params (items with `google_business_vertical`) | build | S | `send_to.google_ads.remarketing: true` (sends items + vertical) |
| Conversion Linker (+ cross-domain linking) | [h-linker] | Partial. Click ids (gclid, gbraid, wbraid, dclid, fbclid…) go to first-party `_afst_*` cookies (lib/clickids.ts). No cross-domain link decoration | build | M | `settings.cross_domain: [hosts]`: the runtime decorates links and forms with a signed `_afst` param and reads it on landing; validate checks `allowed_hostnames` |
| Floodlight counter/sales (web + server) | [h-tags] | Missing | skip (for now): CM360-only advertisers; `custom_js` with gtag `DC-` send_to works | S | later: `floodlight { advertiser_id, group, activity, counting }` |
| Custom HTML | [h-custom-tags] | Have. `custom_html` | — | — | — |
| Custom Image | [h-custom-tags] | Missing | build | S | `image_pixel { url }` (https; `{{var}}` URL-encoded; `cache_bust?`); not treated as custom code (no script) |
| Function call, Consumer Surveys | [h-custom-tags], [h-tags] | Missing | skip: niche or deprecated | — | — |
| Meta Pixel | [h-gallery] | Have. `meta_pixel` (advanced matching, `eventID` dedupe) | — | — | — |
| TikTok Pixel | [h-gallery] | Have. `tiktok_pixel` | — | — | — |
| LinkedIn Insight | [h-gallery] | Have. `linkedin_insight` (+ `conversion_id`, `event_id`) | — | — | — |
| X pixel | [h-gallery] | Have. `x_pixel` | — | — | — |
| Pinterest tag | [h-gallery] | Have. `pinterest_tag` | — | — | — |
| Reddit pixel | [h-gallery] | Have. `reddit_pixel` | — | — | — |
| Microsoft UET | [h-gallery] | Have. `microsoft_uet` (SPA page loads, consent) | — | — | — |
| Snap Pixel | [h-gallery] | Missing | build | S | tag `snap_pixel { pixel_id, event_name? }` + `send_to.snap { event_name }` |
| Hotjar / Microsoft Clarity | [h-gallery] | Missing. Our `replay` app replaces both | build | S | tag `replay { site_id, base_url? }` (like `analytics`) |
| Long-tail community templates (Quora, Criteo, HubSpot…) | [h-gallery] | Partial. `custom_html` (gated) | skip: add types when asked; `custom_html` covers the long tail | — | — |
| Server: GA4 | [sgtm-intro] | Have. `ga4` destination (MP, EU region, debug validation) | — | — | — |
| Server: Google Ads conversions + enhanced conversions for leads | [sgtm-ads] | Have. `google_ads` destination (Data Manager or uploadClickConversions; gclid/gbraid/wbraid + hashed email/phone; validateOnly) | — | — | — |
| Server: Google Ads remarketing | [sgtm-ads] | Missing | skip: no public API for it; the browser tag covers it | — | — |
| Server: Meta Conversions API | [meta-gtm] | Have. `meta` destination (CAPI, test_event_code, fbc/fbp, dedupe) | — | — | — |
| Server: TikTok Events API | [h-gallery] | Have. `tiktok` destination | — | — | — |
| Server: LinkedIn Conversions API | [h-gallery] | Missing | build | M | destination `linkedin { access_token, ad_account_id }`, reusing `send_to.linkedin.conversion_id` |
| Server: Pinterest Conversions API | [h-gallery] | Missing | build | M | destination `pinterest { ad_account_id, access_token }` + `send_to.pinterest` |
| Server: Reddit Conversions API | [h-gallery] | Missing | build | M | destination `reddit { ad_account_id, access_token }` + `send_to.reddit` |
| Server: Snap Conversions API | [h-gallery] | Missing | build | M | destination `snap { pixel_id, access_token }` + `send_to.snap` |
| Server: X Conversions API | [h-gallery] | Missing | build | M | destination `x { pixel_id, oauth creds }` + `send_to.x.event_id` |
| Server: Microsoft Ads offline / UET conversions | [h-gallery] | Missing | build (confirm API access first) | M | destination `microsoft_ads { … }` + `send_to.microsoft_uet` |
| Server: HTTP request tag | [sgtm-intro] | Partial. `webhook` destination has a fixed, HMAC-signed payload, a public https host and 3 attempts (destinations/webhook.ts). Method, headers and body can't be changed | adapt | S | `settings.template?: { method, headers (non-secret), body (JSON with {{event.*}}) }`; signing kept |

## 7. Workflow: preview, versions, import

| GTM feature | Doc | Ours (status + evidence) | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Preview mode (Tag Assistant) | [h-preview] | Have. `create_preview` -> `preview_url` (`?afst_preview=`): draft with debug on, console log, `window.__afst_debug`; preview conversions use test modes | — | — | — |
| Debug detail readable without a browser (tags fired / not fired, variables per event) | [h-preview] | Partial. The decision log exists only in the browser (`afst('get','log')`); the server sees only `/collect` hits | build | M | in preview the runtime posts its log to `/collect` (`type: "debug"`); `GET /v1/containers/:id/preview/:token/log` -> per event: triggers matched, tags fired/blocked + reason, variable values; MCP `get_preview_log` |
| Share preview link | [h-preview] | Have. `preview_url` works for anyone until it expires; custom code is left out unless it could be published | — | — | — |
| Preview an older version | [h-preview] | Missing | build | S | `POST /preview { version? }` |
| Publish with notes | [h-versions] | Have. `POST /publish { note }` | — | — | — |
| Roll back / restore a version | [h-versions] | Have. `POST /rollback` | — | — | — |
| Version diff + workspace status (changes vs live) | [h-versions], [api-workspaces] | Missing | build | S | `GET /v1/containers/:id/diff?from=live\|<n>&to=draft\|<n>` -> per-entity `added/removed/changed` with JSON paths; MCP `diff_versions`; `get_draft` adds a `changes_vs_live` summary |
| Approvals (360) | [h-versions] | Missing | skip: the `draft` key scope (section 1) covers "edit, don't publish" | — | — |
| Environments / publish to environment | [h-envs] | (counted in section 1) | — | — | — |
| Container export (JSON) | [h-import] | Have. `GET /draft` and `GET /versions/:n` return the full config, and `PUT /draft` takes it back | — | — | — |
| Import own JSON: overwrite / merge with conflict rules | [h-import] | Partial. Overwrite = `PUT`; merge = `PATCH`, but arrays replace whole and there are no rename/overwrite rules | build | S | `POST /v1/containers/:id/draft/import { config, mode: "overwrite"\|"merge", on_conflict: "overwrite"\|"rename", dry_run? }` -> change counts |
| Import a GTM container export | [h-import] | Missing. `scan_site` only detects `GTM-…` and warns about double counting (service/scan.ts) | build | M | the same endpoint with `{ format: "gtm", data }`: maps Google tag/GA4, Ads conversion, Custom HTML, Meta/TikTok/LinkedIn/… templates, the main trigger and variable types; returns `config` + `unmapped[]` with hints; MCP `import_gtm_container` |
| Tag coverage summary | [h-coverage] | Partial. `scan_site` checks for the snippet on the homepage; `get_container` has hit counts but nothing per page | build | S | `GET /v1/containers/:id/coverage?since=7d` -> hosts/paths with hits + last_seen; `scan { paths }` reports the snippet per page |
| Tag diagnostics / container quality | [h-diagnostics] | Have. Validate warnings (`placeholder_id`, `google_ads_double_count`, `destination_idle`, `destination_circuit_open`…) + destination health in `get_container` | — | — | — |
| Change history (who changed what in the draft) | [h-versions] | Partial. Versions record `created_by`; draft writes keep no history | skip: versions + revision are enough; revisit if agents need draft undo | — | — |

## Where we already go beyond GTM (keep)

- One-call recipe (`setup_conversion_tracking`), site scan with a suggested config (`scan_site`), and
  `validate_draft` with hints for every issue. GTM has no equivalent.
- One conversion definition fans out to every browser pixel and every conversion API with one
  `event_id`, so platforms dedupe it. In GTM that's N tags plus transport wiring.
- Backend events joined to the browser identity (`send_server_events`), with dedupe rules that
  can't be spoofed from `/collect`.
- Delivery: queue retries, backoff, a circuit breaker, daily budgets, and a per-destination
  event log with the platform's answer. Server-side GTM fires once with no retry.
- `test_destination` uses each platform's test mode and returns the raw answer.
- No account, GCP project, Cloud Run service or OAuth needed to get going.

## Prioritised build list

Ranked by value to an agent doing a GTM migration or setup, divided by effort.

1. **Per-entity draft edits** (`PUT/DELETE /draft/{kind}/:key`, revert): S. Changing one tag no
   longer means resending every array, which cuts both conflicts and tokens.
2. **Diff** (`GET /diff`, `changes_vs_live` in `get_draft`): S. The agent can check what will
   change before it publishes (rule 6).
3. **GTM container import** (`POST /draft/import { format: "gtm", dry_run }`, plus the own-JSON
   merge mode): M. This is the migration path; `scan_site` already finds `GTM-…`.
4. **Agent-readable preview log** (`get_preview_log`): M. Confirms that tags fired without
   driving a browser console.
5. **Variable pack**: `lookup`, `regex_table`, `url` components, `format`, `event_attr`, plus the
   missing built-ins (container_*, ga_*, form_*, history_*, errors): S each, about M together.
   These are what GTM exports use most, so import needs them.
6. **Trigger pack**: `window_loaded`, `init` / `consent_init`, `js_error`, `trigger_group`,
   `event_regex`, ops (`gt/gte/lt/lte`, CSS match), `check_validation`, `wait_for_tags_ms`, visibility
   `min_duration_ms`, scroll px/horizontal: S each, about M together. Also needed for import fidelity.
7. **Server transformations + routing conditions** (`settings.params`, `settings.conditions`):
   S each. Privacy controls (strip params, redact query strings) and value/country filters.
8. **Tag scheduling, priority, live_only, variable descriptions**: S together.
9. **Environments** (named, version-pinned snippet; unpublished versions; preview of an older
   version): M.
10. **More conversion APIs**: LinkedIn, then Pinterest, Reddit, Snap, X, Microsoft Ads: M each.
    Plus browser `snap_pixel`, `image_pixel` and `replay` tag types: S each.
11. **Custom domain** through Cloudflare for SaaS custom hostnames: M. First-party serving with no
    proxy code on the customer's side.
12. **Cross-domain linking** (`settings.cross_domain`): M.
13. **Tag-fire telemetry + coverage** (`tag-stats`, `coverage`): M + S.
14. **gtag `config_params`, Ads dynamic remarketing, `param_set`, TCF v2, `user_data: "auto"`, on-page
    blocklist, webhook templates**: S each.
15. **Enrichment lookup store** (`lookups/:name` + `lookup_store` variable): M.
16. **Video trigger + video built-ins**: M.
17. **Google tag gateway passthrough** (`first_party_vendors`): M.
18. **`draft` key scope** (edit, can't publish) in `@afs/shared`: M.
19. **Tag sequencing** (`after`), gated **custom_js variable**: M, S.
20. **MP-compatible ingest** (`/mp/collect`): M. Then the **GA4 client** (`/g/collect`): L, only if
    customers want to keep gtag.js as-is.

[api-accounts]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts
[api-containers]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers
[api-workspaces]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces
[api-sync]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces/sync
[api-tags]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.tags
[api-triggers]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.triggers
[api-variables]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.variables
[api-builtin]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.built_in_variables
[api-folders]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.folders
[api-templates]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.templates
[api-envs]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.environments
[api-versions]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.versions
[api-vheaders]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.version_headers
[api-perms]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.user_permissions
[api-zones]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.zones
[api-dest]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations
[api-gtag]: https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.gtag_config
[templates]: https://developers.google.com/tag-platform/tag-manager/templates
[mobile]: https://developers.google.com/tag-platform/tag-manager/mobile
[datalayer]: https://developers.google.com/tag-platform/tag-manager/datalayer
[restrict]: https://developers.google.com/tag-platform/tag-manager/web/restrict
[gateway]: https://developers.google.com/tag-platform/tag-manager/gateway
[sgtm]: https://developers.google.com/tag-platform/tag-manager/server-side
[sgtm-intro]: https://developers.google.com/tag-platform/tag-manager/server-side/intro
[sgtm-transform]: https://developers.google.com/tag-platform/tag-manager/server-side/transformations
[sgtm-send]: https://developers.google.com/tag-platform/tag-manager/server-side/send-data
[sgtm-domain]: https://developers.google.com/tag-platform/tag-manager/server-side/custom-domain
[sgtm-deps]: https://developers.google.com/tag-platform/tag-manager/server-side/dependency-serving
[sgtm-api]: https://developers.google.com/tag-platform/tag-manager/server-side/api
[sgtm-eventdata]: https://developers.google.com/tag-platform/tag-manager/server-side/common-event-data
[sgtm-debug]: https://developers.google.com/tag-platform/tag-manager/server-side/debug
[sgtm-cloudrun]: https://developers.google.com/tag-platform/tag-manager/server-side/cloud-run-setup-guide
[sgtm-ads]: https://developers.google.com/tag-platform/tag-manager/server-side/ads-setup
[meta-gtm]: https://developers.facebook.com/docs/marketing-api/conversions-api/guides/gtm-server-side
[h-web]: https://support.google.com/tagmanager/answer/14842164
[h-pageview]: https://support.google.com/tagmanager/answer/7679319
[h-click]: https://support.google.com/tagmanager/answer/7679320
[h-vis]: https://support.google.com/tagmanager/answer/7679410
[h-form]: https://support.google.com/tagmanager/answer/7679217
[h-scroll]: https://support.google.com/tagmanager/answer/7679218
[h-youtube]: https://support.google.com/tagmanager/answer/7679325
[h-custom]: https://support.google.com/tagmanager/answer/7679219
[h-history]: https://support.google.com/tagmanager/answer/7679322
[h-jserror]: https://support.google.com/tagmanager/answer/7679411
[h-timer]: https://support.google.com/tagmanager/answer/7679323
[h-group]: https://support.google.com/tagmanager/answer/9164222
[h-blocking]: https://support.google.com/tagmanager/answer/7679318
[h-builtin]: https://support.google.com/tagmanager/answer/7182738
[h-udv]: https://support.google.com/tagmanager/answer/7683362
[h-seq]: https://support.google.com/tagmanager/answer/6238868
[h-priority]: https://support.google.com/tagmanager/answer/2772421
[h-consent]: https://support.google.com/tagmanager/answer/10718549
[h-malware]: https://support.google.com/tagmanager/answer/6328489
[h-custom-tags]: https://support.google.com/tagmanager/answer/6107167
[h-tags]: https://support.google.com/tagmanager/answer/6106924
[h-linker]: https://support.google.com/tagmanager/answer/7549390
[h-gallery]: https://support.google.com/tagmanager/answer/9454109
[h-preview]: https://support.google.com/tagmanager/answer/6107056
[h-envs]: https://support.google.com/tagmanager/answer/6311518
[h-import]: https://support.google.com/tagmanager/answer/6106997
[h-versions]: https://support.google.com/tagmanager/answer/6107163
[h-perms]: https://support.google.com/tagmanager/answer/6107011
[h-zones]: https://support.google.com/tagmanager/answer/7647043
[h-coverage]: https://support.google.com/tagmanager/answer/12270036
[h-diagnostics]: https://support.google.com/tagmanager/answer/14681508
