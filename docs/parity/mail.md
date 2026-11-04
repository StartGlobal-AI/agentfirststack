# Mail feature parity: AgentMail and inbound-email APIs

Audit date 2026-11-04. Ours = `mail/` as of this date (`src/llms.ts`, `src/mcp.ts`, `src/service/*`, `src/extract/*`,
`src/routes/api.ts`). Paths in "Ours" are relative to `mail/src/` unless they start with another app.
Theirs = public docs: AgentMail (docs.agentmail.to, OpenAPI `https://docs.agentmail.to/openapi.json`, 132 operations
outside `/pods`), Mailgun, Postmark, SendGrid, Resend, Mailosaur, MailSlurp, Lumbox.

Legend. Status: **Have** / **Partial** / **Missing**. Decision: Keep (have it), Build (as they do it), Adapt (our
shape, with the reason), Skip (with the reason). Effort: S (< 1 day), M (1 to 3 days), L (more). Proposed APIs follow
the repo conventions: REST under `/v1` + an MCP tool on the same service function, snake_case, `next_steps`, hints,
`tools.write()` for mutating tools, a fair-use var for every new cost.

## Summary

| Area | Have | Partial | Missing | Rows |
|---|---|---|---|---|
| Inboxes | 7 | 2 | 5 | 14 |
| Messages and threads | 9 | 6 | 10 | 25 |
| Sending | 3 | 3 | 8 | 14 |
| Extraction | 6 | 1 | 4 | 11 |
| Waiting, webhooks, realtime | 2 | 6 | 3 | 11 |
| Domains | 4 | 4 | 4 | 12 |
| Access protocols | 3 | 1 | 6 | 10 |
| Testing features | 2 | 1 | 7 | 10 |
| Organization, identity, metrics | 5 | 2 | 4 | 11 |
| **Total** | **41** | **26** | **51** | **118** |

Decisions on the 77 Partial + Missing rows: **Build 21, Adapt 20, Skip 36**. Most Missing rows are AgentMail
or testing-suite features we skip on purpose: abuse risk on a free shared domain, or not possible on Workers.

Where we are ahead of every product audited: one-request signup that can reply at once (AgentMail's agent signup cannot
send until a human enters an OTP); OTP extraction with positive evidence and exclusions, and link classification
(AgentMail's message schema has neither; Mailosaur, MailSlurp and Lumbox extract codes but never check that the sender
is authenticated); `latest-code` that matches the
sender domain exactly and requires an aligned auth verdict; untrusted-content marking on every surface; multi-tenant
domain ownership challenges; flood controls (per-sender caps, dominant-sender eviction, storage caps, tombstones).

Biggest gaps vs AgentMail: delivery status (delivered / bounced / complained), forward, send idempotency, reply-text
extraction, labels, allow/block lists, an event feed for agents without a public URL, inbox-scoped keys.

## Inboxes

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Create inbox on shared domain, chosen or random username | [AgentMail](https://docs.agentmail.to/inboxes) | **Have**: `POST /v1/inboxes`, `create_inbox`; `service/inboxes.ts` `createInbox` | Keep | - | - |
| Idempotent create | [AgentMail client_id](https://docs.agentmail.to/idempotency) | **Have**: natural key (address) returns 200 `existing: true` | Keep (natural key needs no client_id) | - | - |
| Inbox on a custom domain | [AgentMail](https://docs.agentmail.to/inboxes) | **Have**: `domain` param; 403 `ownership_not_verified` until owned | Keep | - | - |
| Inboxes on any subdomain (wildcard MX) | [AgentMail](https://docs.agentmail.to/knowledge-base/subdomain-inboxes) | **Partial**: a subdomain can be added as its own domain; no wildcard | Skip: Email Routing has no wildcard-subdomain MX; per-subdomain add works today | - | - |
| Display name | [AgentMail](https://docs.agentmail.to/inboxes) | **Have**: `display_name` on create / `PATCH /v1/inboxes/:id` | Keep | - | - |
| Expiring / disposable inbox | [AgentMail pause_at](https://docs.agentmail.to/api-reference/inboxes/update) | **Have**: `ttl_days`; cron `purgeExpiredInboxes` | Keep | - | - |
| Pause / resume inbox | [AgentMail status](https://docs.agentmail.to/api-reference/inboxes/update) | **Missing** | Adapt: kill switch for a leaked key or runaway agent. Paused = inbound refused at SMTP ("Mailbox unavailable", so senders know; AgentMail drops silently), sends 403 `inbox_paused` | S | `PATCH /v1/inboxes/:id {status: "active"\|"paused"}`; `update_inbox` gains `status` |
| Inbox metadata / client_id | [AgentMail](https://docs.agentmail.to/inboxes) | **Missing** | Adapt (low): small map for agent bookkeeping | S | `metadata` (<= 16 keys, 256 chars) on create/PATCH; `GET /v1/inboxes?metadata.<k>=<v>` |
| Signature appended to sends | [AgentMail](https://docs.agentmail.to/inboxes) | **Missing** | Skip: the agent writes the whole body; per-inbox send state for little gain | - | - |
| Search inboxes by address / name | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/search) | **Partial**: `GET /v1/inboxes?domain=` | Adapt (low; hosted cap is 10 inboxes) | S | `GET /v1/inboxes?q=` substring of address or display_name |
| Message / unread counts, storage used | [AgentMail usage](https://docs.agentmail.to/api-reference/metrics/query-usage) | **Have**: `GET /v1/inboxes/:id` `message_count`, `unread_count`; `GET /v1/inboxes` `storage` | Keep | - | - |
| Reserved role names, address tombstones | (not documented elsewhere) | **Have**: reserved list + `EXTRA_RESERVED_USERNAMES`; `ADDRESS_TOMBSTONE_DAYS` | Keep | - | - |
| Inbox profile picture | [AgentMail](https://docs.agentmail.to/knowledge-base/inbox-profile-pictures) | **Missing** | Skip: cosmetic | - | - |
| Per-inbox file drive | [AgentMail files](https://docs.agentmail.to/api-reference/inboxes/files/create) | **Missing** | Skip: not email; free general storage is an R2 abuse magnet | - | - |

## Messages and threads (receiving, reading, safety)

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Instant receive on shared domain | [AgentMail](https://docs.agentmail.to/messages) | **Have**: Email Routing catch-all -> `email()` -> `service/ingest.ts` `handleEmail` | Keep | - | - |
| Plus addressing (`name+tag@`) | [Postmark MailboxHash](https://postmarkapp.com/developer/user-guide/inbound/parse-an-email), [MailSlurp](https://www.mailslurp.com/docs/plus-addresses/) | **Partial**: delivered to `name@`; `lib/address.ts` `normalizeRecipient` computes the tag but it is only visible as `envelope.to` in `GET /v1/messages/:id`; not stored, not filterable | Build: one inbox, one tag per signup (`me+github@`) is the cheapest way to keep signups apart | S | `tag` on message summary; `tag=` filter on `/wait`, `/latest-code`, `/messages`, MCP `wait_for_email`, `get_latest_code`, `list_messages` |
| List messages with filters | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/messages/list) | **Partial**: `unread, q, from, direction, before` (`GET /v1/inboxes/:id/messages`, `list_messages`) | Build | S | add `after`, `to`, `subject`, `has=code\|link\|attachments`, `auth=pass`, `order=asc` (also on `/v1/search`) |
| Get message: text, html, threading headers, attachments | [AgentMail](https://docs.agentmail.to/messages) | **Have**: `GET /v1/messages/:id`, `get_message` (+ `codes, links, auth, automated, envelope`) | Keep | - | - |
| Full header list | [AgentMail](https://docs.agentmail.to/messages) | **Partial**: selected headers in detail; all in raw MIME | Skip: `/raw` covers it | - | - |
| Raw MIME | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/messages/get-raw), [Mailosaur EML](https://mailosaur.com/docs/api) | **Have** (inbound): `GET /v1/messages/:id/raw`, `get_raw_message` | Keep | - | - |
| Attachment download | [AgentMail](https://docs.agentmail.to/attachments) | **Have**: `GET /v1/messages/:id/attachments/:aid` (download-only, CSP sandbox), `get_attachment` (<= 2 MB) | Keep | - | - |
| Threads per inbox, get thread | [AgentMail](https://docs.agentmail.to/threads) | **Have**: `GET /v1/inboxes/:id/threads`, `GET /v1/threads/:id`; `lib/threading.ts` | Keep | - | - |
| Account-wide thread list / filters | [AgentMail](https://docs.agentmail.to/api-reference/threads/list) | **Partial**: per inbox only | Adapt | S | `GET /v1/threads?inbox_id=&q=&after=&before=`; `list_threads` with optional `inbox_id` |
| Delete thread | [AgentMail](https://docs.agentmail.to/threads) | **Missing** (per message only) | Build | S | `DELETE /v1/threads/:id`, `delete_thread` |
| Read / unread | [AgentMail labels](https://docs.agentmail.to/labels) | **Have**: `PATCH /v1/messages/:id {read}`, `mark_read`, `unread=true` | Keep | - | - |
| Custom labels on messages and threads | [AgentMail](https://docs.agentmail.to/labels), [thread update](https://docs.agentmail.to/api-reference/threads/update) | **Missing** | Build: agents keep state in the mailbox (`handled`, `needs-human`) instead of their own store | M | `PATCH /v1/messages/:id` and `PATCH /v1/threads/:id {add_labels, remove_labels}`; `labels=` filter on lists/search; <= 20 per message, `[a-z0-9:_-]{1,64}`; read-only system labels `unread, sent, received, automated, unauthenticated, has-code` |
| Trash (reversible delete) | [AgentMail](https://docs.agentmail.to/labels) | **Missing** | Skip: hard delete keeps storage caps honest; a `trash` label covers it once labels ship | - | - |
| Batch get / update | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/messages/batch-update) | **Missing** | Adapt (low) | S | `POST /v1/messages/batch {ids <= 100, read?, add_labels?, remove_labels?, delete?}` |
| Clear an inbox | [Mailosaur](https://mailosaur.com/docs/api) `DELETE /api/messages?server=` | **Missing** | Build: test resets, frees storage in one call | S | `DELETE /v1/inboxes/:id/messages?before=`, `clear_inbox` (counts toward `MAX_INBOX_DELETES_PER_DAY`-style cap) |
| Full-text search across inboxes | [AgentMail](https://docs.agentmail.to/messages) | **Have**: `GET /v1/search` (AND of 3+ char words, 2,000 newest), `search_messages` | Keep (`after` via list filters row) | - | - |
| Spam classification, `include_spam` | [AgentMail](https://docs.agentmail.to/spam-virus-detection), [SendGrid spam_score](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook) | **Partial**: `auth_verdict`, `automated`, sender caps; no spam score | Adapt: no SpamAssassin on Workers; expose `unauthenticated` label + `auth=pass` filter | S | (in list filters / labels rows) |
| Virus scan | [AgentMail](https://docs.agentmail.to/spam-virus-detection) | **Missing** | Skip: no AV engine on Workers; attachments are never rendered (download-only, `nosniff`, CSP sandbox) | - | - |
| Receive allow / block lists (address or domain, account or inbox) | [AgentMail lists](https://docs.agentmail.to/lists), [Postmark inbound rules](https://postmarkapp.com/developer/api/inbound-rules-triggers-api), [MailSlurp rulesets](https://www.mailslurp.com/docs/routing-rulesets/) | **Missing** (automatic `MAX_INBOUND_PER_SENDER_PER_DAY` only) | Build: receive-allow shrinks the injection surface ("only github.com may write here"); block stops a flooder before it spends quota. Match the authenticated sender (`lib/sender.ts` `senderKeyFor`), not From text; refuse at SMTP time | M | `POST /v1/lists/receive/{allow\|block} {entry, inbox_id?, reason?}`, `GET`, `DELETE /v1/lists/receive/{type}/{entry}`; MCP `add_list_entry`, `list_list_entries`, `delete_list_entry`; `MAX_LIST_ENTRIES_PER_ACCOUNT` (100) |
| Send allow / block lists | [AgentMail](https://docs.agentmail.to/lists) | **Missing** | Adapt: block only (send-allow is moot under reply_only) | S | `/v1/lists/send/block` (same handlers) |
| Prompt-injection scan (Agent Armor) | [AgentMail](https://docs.agentmail.to/agent-armor) | **Partial**: `untrusted` marker on REST, nonce fences in MCP (`service/format.ts` `fence`), `x-untrusted-content` on raw/attachments; no classifier | Adapt: optional Workers AI classifier at ingest, advisory only (no hold), daily budget, off for unclaimed accounts | M | `injection: {verdict: "clear"\|"review", model}` on message + webhook `data`; `injection=review` filter; `MAX_INJECTION_SCANS_PER_DAY` |
| Retention / expiry | [AgentMail 24 h expiry](https://docs.agentmail.to/message-expiry) | **Have**: `SHARED_RETENTION_DAYS` (14 hosted), `ttl_days`, `MAX_MESSAGES_PER_INBOX` eviction | Keep | - | - |
| Inbound flood controls | (not documented elsewhere) | **Have**: per-sender / per-account daily caps, dominant-sender eviction, blob and text caps | Keep | - | - |
| Calendar invites (calendar, RSVP, agenda) | [AgentMail](https://docs.agentmail.to/calendar) | **Missing** | Adapt: parse `text/calendar` parts at ingest; a calendar product is out of scope (L) | S | `calendar: {method, uid, summary, start, end, organizer, attendees}` on message detail |
| Label-change event log | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/events/list) | **Missing** | Skip: exists for IMAP UID projection; we have no IMAP | - | - |

## Sending

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Send: to/cc/bcc, text/html, attachments, X- headers | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/messages/send) | **Have**: `POST /v1/inboxes/:id/send`, `send_email`; 50 recipients, 32 attachments, 25 MiB | Keep | - | - |
| Reply, reply-all | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/messages/reply-all) | **Have**: `POST /v1/messages/:id/reply {reply_all}`, `reply_to_message`; In-Reply-To/References | Keep | - | - |
| Forward | [AgentMail](https://docs.agentmail.to/api-reference/inboxes/messages/forward), [Mailosaur](https://mailosaur.com/docs/api) | **Missing** | Build: `Fwd:` subject, quoted original, attachments re-attached from the raw MIME; recipients follow send rules (reply_only on shared) | S | `POST /v1/messages/:id/forward {to, cc?, bcc?, text?, html?, include_attachments? = true}`, `forward_message` |
| Unrestricted send from shared domain | [AgentMail signup limits](https://docs.agentmail.to/knowledge-base/agent-sign-up-limits) (after human OTP; 3/5/10 new-recipient ramp) | **Partial** (by design): `SHARED_SEND_POLICY=reply_only` (`service/send.ts` `assertReplyOnly`); custom domains send to anyone within `SEND_DAILY_LIMIT` | Skip: a free shared domain that cold-mails is burned in days; the custom-domain path is the answer | - | - |
| Send to the account's own people and own inboxes | [AgentMail attach human](https://docs.agentmail.to/api-reference/agent/attach-human) (unverified agent may mail its `human_email`) | **Missing**: reply_only blocks mailing the claimed owner until they write first, and inbox-to-inbox in one account | Build: exempt (a) Google-verified emails of the account's members (`users` / `memberships` in AUTH_DB), (b) the account's own inboxes, delivered internally via `ingestRaw` without leaving the Worker | S | no new route; 403 hint points unclaimed agents to `POST /v1/claim-link` |
| Send idempotency | [AgentMail Idempotency-Key](https://docs.agentmail.to/idempotency) | **Missing**: a send retried after a timeout goes out twice (breaks rule 7) | Build | S | `Idempotency-Key` header on send/reply/forward (1-256 chars `[A-Za-z0-9._~-]`); D1 `send_keys(account_id, key, body_hash, message_id, expires_at)` 24 h; same key + body -> 200 original + `idempotent_replay: true`; other body -> 409 `idempotency_conflict`; MCP arg `idempotency_key` |
| Delivery status per recipient | [AgentMail events](https://docs.agentmail.to/events), [Cloudflare Email Sending events](https://developers.cloudflare.com/email-service/reference/event-subscriptions/) | **Partial**: `status: "sent"` only; suppressed recipient = 422 `recipient_suppressed` (`mapSendError`) | Build: Queues event subscription per sending domain (shared + onboarded custom); map provider message id -> message; rule 6, the agent can check its mail arrived | M | `delivery: [{recipient, status: delivered\|deferred\|bounced\|failed\|rejected\|complained, smtp_code, at}]` on `GET /v1/messages/:id`; `GET /v1/messages/:id/delivery?timeout=` blocks until all terminal; `get_delivery` |
| Scheduled send | [AgentMail drafts send_at](https://docs.agentmail.to/drafts) | **Missing** | Adapt: `send_at` <= 7 days ahead on send/reply/forward; policy + quota checked at schedule and at send; DO alarm per inbox; delete cancels | M | `send_at`; `status: "scheduled"`; `DELETE /v1/messages/:id` cancels; `?status=scheduled` filter; `MAX_SCHEDULED_PER_ACCOUNT` |
| Drafts, human approval | [AgentMail](https://docs.agentmail.to/drafts) | **Missing** | Skip for now: agents compose and send in one call; approval belongs in the dashboard if asked; a scheduled message is the draft | - | - |
| Attachments by URL | [AgentMail](https://docs.agentmail.to/drafts) | **Missing** (base64 only) | Skip: server-side fetch of caller URLs = SSRF and bandwidth abuse | - | - |
| Open / click tracking | [AgentMail](https://docs.agentmail.to/knowledge-base/open-tracking) | **Missing** | Skip: tracking pixels contradict the platform's cookieless stance and are unreliable (prefetch) | - | - |
| Suppression list | [Cloudflare suppressions](https://developers.cloudflare.com/email-service/concepts/suppressions/) | **Partial**: 422 on send only | Adapt: read-only list per own sending domain via CF API; delete only on custom domains | S | `GET /v1/domains/:domain/suppressions`, `DELETE /v1/domains/:domain/suppressions/:email` |
| Daily send quota in response | [AgentMail rate limits](https://docs.agentmail.to/knowledge-base/rate-limits) | **Have**: `daily` on send response | Keep | - | - |
| Bulk send, templates | [MailSlurp](https://www.mailslurp.com/docs/) | **Missing** | Skip: bulk is the abuse case; agents render bodies | - | - |

## Extraction

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| OTP code extraction | [Mailosaur codes](https://mailosaur.com/docs/test-cases/codes), [MailSlurp OTP](https://www.mailslurp.com/docs/otp-mfa-testing/), [Lumbox](https://docs.lumbox.co) (AgentMail: none) | **Have**: `extract/codes.ts` (keyword evidence, exclusions, languages, OTP-Token header) -> `code`, `codes` | Keep | - | - |
| Action links with kind | [Mailosaur](https://mailosaur.com/docs/api) (links, no kind) | **Have**: `extract/links.ts` `verify\|magic_login\|password_reset\|unsubscribe\|other`, `verify_link` | Keep | - | - |
| Block until a code arrives, strict sender | [Lumbox `/otp`](https://docs.lumbox.co), [MailSlurp](https://www.mailslurp.com/docs/wait-for/) | **Have**: `GET /v1/inboxes/:id/latest-code`, `get_latest_code`; domain-exact `from`, auth pass by default | Keep | - | - |
| Sender auth verdict (SPF/DKIM/DMARC/ARC, aligned) | [AgentMail](https://docs.agentmail.to/messages), [SendGrid](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook) | **Have**: `extract/auth.ts` (trusts only Cloudflare's first A-R header) | Keep | - | - |
| Automated / bulk detection | (none) | **Have**: `automated` (List-Id, Precedence, Auto-Submitted, bounces) | Keep | - | - |
| HTML -> text, preview | [Mailgun body-plain](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http) | **Have**: `extract/text.ts` | Keep | - | - |
| Reply extraction (drop quoted history, boilerplate) | [AgentMail](https://docs.agentmail.to/reply-extraction), [Mailgun stripped-text](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http), [Postmark StrippedTextReply](https://postmarkapp.com/developer/user-guide/inbound/parse-an-email) | **Missing** | Build: conversations are the second use case after signups; without it agents re-read whole quoted chains. Linear cut at "On ... wrote:" (multi-language), `>` blocks, Outlook From/Sent blocks, "Sent from my iPhone"; keep signature; at ingest, in and out | S-M | `reply_text` on message detail, `wait` result and webhook `data`; `get_message` shows it first |
| Attachment text (PDF, DOCX, XLSX, CSV) | [AgentMail](https://docs.agentmail.to/reply-extraction) | **Missing** | Adapt: on demand, not at ingest, via Workers AI [toMarkdown](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/); cached in R2; <= 10 MB in, <= 250k chars out; no images (vision cost); fenced as untrusted | M | `GET /v1/messages/:id/attachments/:aid/text`, `get_attachment_text`; `MAX_ATTACHMENT_TEXT_PER_DAY` |
| Regex match / extract | [MailSlurp](https://www.mailslurp.com/docs/wait-for/) `getEmailContentMatch` | **Missing** | Skip: caller regex over sender text = ReDoS on our CPU; agents regex `text` locally | - | - |
| AI extraction with output schema | [MailSlurp AI](https://www.mailslurp.com/docs/ai/) | **Missing** | Skip: the caller is already an LLM | - | - |
| Category (otp, verification, ...) | [Lumbox](https://docs.lumbox.co) `category` | **Partial**: `code`, `verify_link_kind`, `automated` | Adapt: `has=` filter (list filters row) | S | (list filters row) |

## Waiting, webhooks and realtime

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Long-poll wait with filters | [MailSlurp](https://www.mailslurp.com/docs/wait-for/), [Lumbox](https://docs.lumbox.co) | **Have**: `GET /v1/inboxes/:id/wait`, `wait_for_email`; hibernating WebSocket to `InboxDO` (`inbox-do.ts`); `after` semantics; <= 120 s | Keep | - | - |
| Wait for N / nth message, multi-inbox wait | [MailSlurp](https://www.mailslurp.com/docs/wait-for/) | **Missing** | Skip: loop with `after=received_at`; multi-inbox via the event feed | - | - |
| Webhook event types beyond `message.received` | [AgentMail (20 types)](https://docs.agentmail.to/events) | **Partial**: `message.received` + `webhook.test` (`service/webhooks.ts` `WEBHOOK_EVENTS`) | Build (after delivery status) | S | `message.sent`, `message.delivered`, `message.bounced`, `message.complained`, `message.failed`, `message.refused` (inbound refused: list, limit), `domain.verified` |
| Signed deliveries, retries, delivery log, test | [AgentMail](https://docs.agentmail.to/webhook-verification), [Mailgun](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http), [Postmark](https://postmarkapp.com/developer/user-guide/inbound/parse-an-email) | **Have**: HMAC `x-signature`, 8 attempts 10 s -> 1 h, 410 disables, last 20 deliveries, `POST /v1/webhooks/:id/test` | Keep | - | - |
| Standard Webhooks (Svix-compatible) headers | [AgentMail Svix](https://docs.agentmail.to/webhook-verification) | **Partial**: own scheme | Adapt (low): also send `webhook-id`, `webhook-timestamp`, `webhook-signature` ([spec](https://www.standardwebhooks.com/)) so stock verifiers work | S | headers only |
| Update webhook, rotate secret, custom headers | [AgentMail update](https://docs.agentmail.to/api-reference/webhooks/update), [headers](https://docs.agentmail.to/api-reference/webhooks/update-headers) | **Partial**: delete + recreate | Build | S | `PATCH /v1/webhooks/:id {url?, events?, inbox_ids?, enabled?}`, `POST /v1/webhooks/:id/rotate-secret`; `headers` (<= 5, sealed with `encryptSecret`, write-only); `update_webhook` |
| Several inboxes per webhook | [AgentMail](https://docs.agentmail.to/webhooks-overview) `inbox_ids` | **Partial**: one `inbox_id` or all | Build (with update row) | S | `inbox_ids: [...]` |
| Body in webhook payload | [AgentMail](https://docs.agentmail.to/events) | **Partial**: summary + links + auth, no text | Adapt: add `reply_text` and a text excerpt <= 8 KB | S | `data.message.text_excerpt`, `data.message.reply_text` |
| Event feed without a public URL (polling webhooks) | [AgentMail](https://docs.agentmail.to/webhook-polling) | **Partial**: per-inbox `wait` covers inbound only | Build: most agents have no public URL; one cursor over all inboxes and delivery events | M | `GET /v1/events?after=&types=&inbox_id=&timeout=` -> `{events, next_after}` (D1, 7-day retention, webhook payloads); `wait_for_event` |
| WebSocket push | [AgentMail](https://docs.agentmail.to/websockets) | **Missing** (WS internal only) | Skip: the event feed long-poll gives the same without a socket per agent | - | - |
| MCP Events push | [AgentMail](https://docs.agentmail.to/integrations/mcp-events) | **Missing** | Skip: our MCP server is stateless (`handleMcp`); blocking tools instead | - | - |

## Domains

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Add domain, DNS records, live verify | [AgentMail](https://docs.agentmail.to/custom-domains) | **Have**: `POST /v1/domains`, `POST /v1/domains/:d/verify` (DoH), `service/domains.ts`, `lib/dns.ts` | Keep | - | - |
| Ownership challenge between tenants | (not documented elsewhere) | **Have**: `_afs-verify` TXT, first verifier owns, others 409 | Keep | - | - |
| One-click DNS setup | [AgentMail setup link (Domain Connect)](https://docs.agentmail.to/api-reference/domains/get-setup-link) | **Partial**: `auto_configure` operator-only (zone in operator's CF account) | Adapt later: publish a Domain Connect template with Cloudflare (the only DNS we support) for an owner-approved link | L | `GET /v1/domains/:d/setup-link` -> `{supported, url}` |
| Any DNS provider | [AgentMail](https://docs.agentmail.to/custom-domains) | **Partial**: zone must be on Cloudflare DNS (Email Routing) | Skip: platform constraint; keep it in the first 400 hint | - | - |
| Zone file export | [AgentMail](https://docs.agentmail.to/api-reference/domains/get-zone-file) | **Missing** (JSON `records`) | Build | S | `GET /v1/domains/:d/zone-file` (text/dns, BIND) |
| Send-only domain (keep existing MX) | [AgentMail `inbound_enabled`](https://docs.agentmail.to/api-reference/domains/create) | **Partial**: sending verifies on its own, but `records` always lists apex MX and `status` stays `partial` | Build: most sites already run Google Workspace / M365 MX and only want transactional sending | S | `receiving: false` on `POST/PATCH /v1/domains`: apex MX/SPF dropped from `records`; `status: verified` when ownership + sending pass |
| Catch-all inbox | [Mailgun catch_all](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/routes) | **Have**: `catch_all_inbox_id` | Keep | - | - |
| Routing rules (recipient regex -> forward / store / stop) | [Mailgun routes](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/routes) | **Partial**: exact address + catch-all; webhook = forward-to-URL | Skip: inbox per address + webhooks covers it | - | - |
| Auto-forward to an external address | [MailSlurp](https://www.mailslurp.com/docs/forwarding/), [Resend](https://resend.com/docs/dashboard/receiving/introduction) | **Missing** | Skip: relay abuse and SPF/DMARC breakage on shared; custom-domain owners can use Email Routing rules | - | - |
| Auto-reply | [MailSlurp](https://www.mailslurp.com/docs/repliers/) | **Missing** | Skip: backscatter; agents reply from a webhook | - | - |
| Bounce / complaint feedback, `domain.verified` | [AgentMail `feedback_enabled`](https://docs.agentmail.to/api-reference/domains/create) | **Missing** | Build via delivery status + webhook events rows | - | - |
| DMARC record | [AgentMail](https://docs.agentmail.to/managing-domains) (`p=reject` default) | **Have**: `p=none` for first setup | Keep | - | - |

## Access protocols

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| REST + llms.txt manual | [AgentMail llms.txt](https://docs.agentmail.to/llms.txt) | **Have**: `GET /llms.txt` (`llms.ts`) | Keep | - | - |
| MCP over HTTP, API key or OAuth | [AgentMail (47 tools)](https://docs.agentmail.to/integrations/mcp) | **Have**: `/mcp`, 29 tools (`mcp.ts`), OAuth 2.1 via site | Keep (new tools listed per row) | - | - |
| IMAP | [AgentMail](https://docs.agentmail.to/imap-smtp) | **Missing** | Skip: Workers cannot accept inbound TCP; needs an always-on server outside the stack; agents use REST/MCP | - | - |
| SMTP submission | [AgentMail](https://docs.agentmail.to/imap-smtp), [Mailosaur](https://mailosaur.com/docs/api) | **Missing** | Skip: same; Cloudflare SMTP submission authenticates the operator, not tenants | - | - |
| SDKs, CLI | [AgentMail CLI](https://docs.agentmail.to/integrations/cli), [Lumbox](https://docs.lumbox.co) | **Missing** | Adapt: OpenAPI 3.1 generated from `schemas.ts` zod shapes; generators make SDKs; no hand-written SDKs | M | `GET /openapi.json` (all apps eventually) |
| Framework integrations | [AgentMail](https://docs.agentmail.to/llms.txt) | **Missing** | Skip: MCP covers them | - | - |
| 429 with `Retry-After` | [AgentMail](https://docs.agentmail.to/knowledge-base/rate-limits) | **Partial**: 429 + hint, no `Retry-After` (none in `shared/src`) | Build (shared, all apps) | S | `Retry-After` on every 429: limiter window, or seconds to next UTC midnight for `daily_limit` |
| Human inbox UI | [AgentMail console](https://docs.agentmail.to/knowledge-base/claiming-agent-inbox) | **Have**: `GET /ui`, site dashboard | Keep | - | - |
| GraphQL / Protobuf | [MailSlurp](https://www.mailslurp.com/docs/) | **Missing** | Skip | - | - |
| EU region, pay-per-call (x402/MPP) | [AgentMail](https://docs.agentmail.to/llms.txt) | **Missing** | Skip: free, single region | - | - |

## Testing features

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| Wait-for + code + link (test signups) | [Mailosaur](https://mailosaur.com/docs/test-cases/codes), [MailSlurp](https://www.mailslurp.com/docs/otp-mfa-testing/) | **Have**: see Extraction and Waiting | Keep | - | - |
| Disposable test inboxes | [MailSlurp](https://www.mailslurp.com/docs/) | **Have**: `ttl_days`, delete, retention | Keep | - | - |
| Deliverability / content report (auth, List-Unsubscribe, HTML checks, spam score) | [Mailosaur analysis](https://mailosaur.com/docs/api), [MailSlurp audit](https://www.mailslurp.com/docs/email-audit/) | **Partial**: `auth` + `automated` | Adapt: the agent testing its own site's mail gets a checklist: aligned auth, List-Unsubscribe + one-click, text part, size, images without alt, scripts/iframes/forms, link domains vs From, shorteners. No SpamAssassin, no DNSBL (blocked from shared resolvers) | M | `GET /v1/messages/:id/analysis`, `analyze_message` |
| Link checking (HTTP status of links) | [MailSlurp audit](https://www.mailslurp.com/docs/email-audit/) | **Missing** | Skip: fetching sender-controlled URLs from our IPs = SSRF / click-fraud bait | - | - |
| Client rendering previews | [MailSlurp](https://www.mailslurp.com/docs/device-renders/) | **Missing** | Skip: L (browser per client) for little agent value | - | - |
| SMS / phone numbers | [MailSlurp](https://www.mailslurp.com/docs/txt-sms/), [Mailosaur](https://mailosaur.com/docs/api) | **Missing** | Skip: carrier cost and KYC; a separate product if ever | - | - |
| TOTP virtual devices | [MailSlurp](https://www.mailslurp.com/docs/totp/), [Mailosaur devices](https://mailosaur.com/docs/api) | **Missing** | Skip: not email; RFC 6238 is a few local lines; holding 2FA seeds is custody risk | - | - |
| Capture outbound without delivering (virtual inbox) | [MailSlurp](https://www.mailslurp.com/docs/virtual-inbox/) | **Missing** | Adapt: covered by internal delivery to own inboxes (Sending, own-people row) | - | - |
| Recipient address validation | [MailSlurp](https://www.mailslurp.com/docs/verification/) | **Missing** | Skip: list cleaning is a spammer tool | - | - |
| Inbox placement / warmup | [MailSlurp](https://www.mailslurp.com/docs/) | **Missing** | Skip: needs seed mailboxes at big providers; not free-tier shaped | - | - |

## Organization, identity, metrics

| Feature | Doc | Ours | Decision | Effort | Proposed API |
|---|---|---|---|---|---|
| One-request agent signup (key + inbox) | [AgentMail](https://docs.agentmail.to/api-reference/agent/sign-up) (send only to `human_email` until OTP) | **Have**: `POST /v1/signup` (`accountRoutes` in `@afs/shared`), replies work at once | Keep | - | - |
| Attach / claim by a human | [AgentMail attach human](https://docs.agentmail.to/api-reference/agent/attach-human), [claim](https://docs.agentmail.to/knowledge-base/claiming-agent-inbox) | **Have**: `POST /v1/claim-link` (`site/src/claims.ts`), Google sign-in, `UNCLAIMED_*` caps lift | Keep | - | - |
| API keys CRUD, read-only scope | [AgentMail](https://docs.agentmail.to/api-reference/api-keys/create) | **Have**: `/v1/keys` `*`\|`read`; read keys never see write tools | Keep | - | - |
| Inbox-scoped keys | [AgentMail](https://docs.agentmail.to/permissions), [Lumbox](https://docs.lumbox.co) `allowed_inbox_ids` | **Missing** | Build: an orchestrator gives each sub-agent one inbox; a leaked key exposes one mailbox | M | `POST /v1/keys {scope, inbox_ids: [...]}` (AUTH_DB column, shared); every inbox/message/thread lookup and list filters by it; such keys cannot create inboxes, domains, keys, or webhooks outside their inboxes |
| Granular permission flags | [AgentMail](https://docs.agentmail.to/permissions) | **Partial**: `*` / `read` | Skip the flag matrix; revisit a `send: false` key only on demand | - | - |
| Pods (tenant sub-containers) | [AgentMail](https://docs.agentmail.to/documentation/core-concepts/pods) | **Missing** | Skip: accounts are free and instant, so an account is the tenant; inbox-scoped keys cover delegation | - | - |
| Team members | [AgentMail pricing (seats)](https://www.agentmail.to/pricing) | **Have**: memberships in site dashboard | Keep | - | - |
| whoami | [AgentMail](https://docs.agentmail.to/api-reference/auth/me) | **Have**: `GET /v1/me` | Keep | - | - |
| Usage vs limits | [AgentMail usage](https://docs.agentmail.to/api-reference/metrics/query-usage) | **Partial**: `storage` on `GET /v1/inboxes`, `daily` on send | Build: agents should read caps before a 429 (rule 6); counters already exist (`send_counters`, `budgets.ts` `reserveDaily`) | S | `GET /v1/usage` -> `{day, claimed, sends, inbound, inbox_creates, inbox_deletes, webhook_tests, waits, storage, text}` each `{used, limit}`; `get_usage` |
| Delivery rates (bounce, complaint) | [AgentMail rates](https://docs.agentmail.to/api-reference/metrics/query-rates) | **Missing** | Adapt after delivery status | S | `GET /v1/usage?days=30` adds `delivered, bounced, complained` |
| App sign-in identity (AgentID) | [AgentMail](https://docs.agentmail.to/agentid-sign-in) | **Missing** | Skip: proprietary identity network; inbox + code extraction works with any site's normal signup | - | - |

## Notes found during the audit

- Hosted llms.txt says unclaimed accounts get 256 MiB of mail storage (the code default,
  `budgets.ts` `DEFAULT_UNCLAIMED_MAX_BLOB_BYTES`), but `deploy/hosted.json` sets
  `UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT=104857600` (100 MiB). The manual hard-codes defaults rather than the
  deployment's values; `GET /v1/usage` (below) would give the agent the real number.
- Cloudflare Email Sending now publishes `message.delivered|deferred|bounced|failed|rejected|complained` to Queues
  per sending domain (changelog 2026-07-15). Delivery status needs that subscription per domain: a
  deploy step for the shared domain, and an `auto_configure` step for custom domains.

## Prioritised build list

P1: small, high value, closes a rule gap. Each ships REST + MCP + llms.txt + tests.

1. **Send idempotency** (`Idempotency-Key` on send/reply/forward). S. Rule 7 today stops at creates.
2. **Reply-only exemptions**: the account's members' verified emails and its own inboxes (internal delivery). S. An
   agent can email its person and test inbox-to-inbox without a custom domain.
3. **Plus-address `tag`** field + `tag=` filter on wait, latest-code, list. S.
4. **`reply_text`** (quoted-history stripping) at ingest, in message, wait and webhook. S-M.
5. **Forward** (`POST /v1/messages/:id/forward`, `forward_message`). S.
6. **`GET /v1/usage`** + `get_usage`: every cap with used/limit for this account. S.
7. **`Retry-After` on all 429s** (shared, every app). S.
8. **List filters**: `after, to, subject, has, auth, order` on messages and search. S.

P2: the next layer agents notice.

9. **Delivery status**: Email Sending event subscription -> per-recipient `delivery`, `GET /v1/messages/:id/delivery?timeout=`,
   webhook events `message.sent|delivered|bounced|complained|failed`, `domain.verified`. M.
10. **Event feed** `GET /v1/events?after=&timeout=` + `wait_for_event` (polling webhooks without a URL). M.
11. **Receive allow/block lists** (+ send block), matched on the authenticated sender, refused at SMTP. M.
12. **Labels** on messages/threads + `labels=` filter; with **delete thread**, **account-wide threads**, **clear inbox**. M.
13. **Send-only domains** (`receiving: false`) + **zone file** export. S.
14. **Webhook update**: PATCH, rotate secret, `inbox_ids`, sealed custom headers. S.
15. **Inbox-scoped API keys** (shared AUTH_DB change, enforced in mail). M.

P3: worth doing once P1/P2 land.

16. **Attachment text** via Workers AI toMarkdown, on demand, budgeted. M.
17. **Scheduled send** (`send_at`, DO alarm, cancel by delete). M.
18. **Deliverability analysis** of a received message (`analyze_message`). M.
19. **Prompt-injection verdict** (advisory Workers AI classifier, budgeted, claimed accounts). M.
20. **OpenAPI 3.1** from the zod shapes. M.
21. Small follow-ups: pause inbox, ICS parsing, webhook `reply_text`/excerpt, Standard Webhooks headers, batch
    update, inbox `q=`, inbox metadata, suppressions read, Domain Connect setup link (L).

Deliberately skipped (abuse or platform): unrestricted shared-domain sending, auto-forward and auto-reply, open/click
tracking, URL attachments, link checking, address validation, bulk/templates, IMAP/SMTP, SMS, TOTP custody, pods,
AgentID, file drive, calendar product, WebSockets and MCP push (long-poll instead).
