# mail

Email built for agents: create an inbox in one request, use it to sign up for any third-party
service, block until the verification email arrives and get the code or link back already
extracted, read and reply, send from your own domains, and get webhooks. Also the general email
infrastructure for a business (custom domains, sending, receiving).

Sections marked (v2) are deliberately not built yet. `GET /llms.txt` is the full agent manual.

## Agent quickstart

```sh
curl -X POST $BASE/v1/signup                         # key + a ready default inbox
curl -X POST $BASE/v1/inboxes -H "Authorization: Bearer $KEY" -d '{"username":"acme-signups"}'
#   -> { "inbox": { "id": "inb_...", "address": "acme-signups@MAIL_DOMAIN" }, ... }
# ... agent fills a signup form on some website with that address ...
curl "$BASE/v1/inboxes/$INBOX/latest-code?timeout=60" -H "Authorization: Bearer $KEY"
#   -> { "code": "482913", "link": "https://...", "link_kind": "verify", "message_id": "msg_...", ... }
curl "$BASE/v1/inboxes/$INBOX/wait?from=facebookmail.com&timeout=60" -H "Authorization: Bearer $KEY"
#   -> { "message": { "subject": "...", "code": "482913", "codes": ["482913"], "verify_link": "https://...", ... } }
curl -X POST $BASE/v1/messages/$MSG/reply -H "Authorization: Bearer $KEY" -d '{"text":"Thanks!"}'
```

## Architecture

```
internet ─ MX ─► Cloudflare Email Routing (catch-all) ─► Worker email() handler
                   recipient -> inbox (D1), else domain catch-all inbox, else setReject
                   inbox full / account's daily limit -> setReject (before the body is read)
                   parse (postal-mime) ─► R2: raw .eml, HTML body, attachments
                                       ─► D1: message row (+ FTS5 index), extracted codes/links/auth, thread
                                       ─► InboxDO.notify() wakes any parked wait_for_email
                                       ─► Queue: webhook deliveries (signed, retried)
agent ─ REST / MCP ─► Worker ─► D1 / R2 ;  send ─► Cloudflare Email Service (send_email binding)
```

Code layout: `src/index.ts` (Hono app + `fetch`/`email`/`queue`/`scheduled` handlers, exports
`InboxDO`), `src/routes/api.ts` (thin REST), `src/mcp.ts` (thin MCP), `src/service/*` (all logic,
shared by both), `src/extract/*` (pure extraction), `src/lib/*` (address rules, threading, DNS,
Cloudflare API, signing, header hygiene), `src/llms.ts`, `src/ui.ts`, `migrations/0002_mail.sql` (schema)
plus `0004_domain_ownership.sql`, `0005_inbound_limits.sql`, `0006_address_tombstones.sql`.

- **Receiving**: Email Routing's catch-all routes every address of a mail domain to this Worker.
  The envelope recipient is lowercased and its `+tag` stripped (`acme+meta@` delivers to `acme@`).
  Recipient address -> inbox (D1). Unknown address: delivered to the domain's catch-all inbox if one
  is set (custom domains only), else rejected with `setReject("Address does not exist")` before
  the body is read. Expired inboxes count as unknown, and so does every address on a custom domain
  whose ownership challenge has not passed (see Domains). Messages over 25 MB are rejected (Email
  Routing's limit). Also before the body is read: with `MAX_MESSAGES_PER_INBOX` set, an inbox that
  holds that many inbound messages rejects with `Mailbox full: <address> already holds the maximum
  of N messages` (one row read: `inboxes.inbound_count`, kept by triggers); with
  `MAX_INBOUND_PER_ACCOUNT_PER_DAY` set, the account's Nth+1 inbound message of the UTC day is
  rejected with `Daily limit reached: ...; retry after 00:00 UTC` (one atomic upsert in
  `inbound_counters`; refunded if the message turns out to be a duplicate or fails). A `wait` that
  times out says so in its hint. A repeated Message-ID in the same inbox is a no-op, so redeliveries
  are safe; a partial unique index on inbound (inbox, Message-ID) plus insert-or-ignore makes that
  hold for concurrent deliveries too (the losing copy's blobs are deleted).
- **Storage**: D1 `messages` (headers, envelope, plain text, extracted data, thread_id, direction
  in/out, read flag), an FTS5 table over subject/sender/text kept in sync by triggers; R2 for the
  raw MIME (`inbox/<id>/<msg>/raw.eml`), the HTML body and attachments. HTML is stored as received
  (not rewritten); the UI only renders it in a sandboxed iframe (see Human view). Plain text above
  64 KB (UTF-8) is cut in D1 and the message reports `text_truncated: true` (the raw MIME in R2
  keeps everything; for sent mail, which has no raw MIME, the message went out in full). Other
  sender-controlled fields are bounded too: subject 2,000 characters, sender name 500, To and Cc
  100 addresses each, References 8,000 characters (newest ids kept), link URLs 4,096 characters
  (longer links are dropped). An attachment content type that is not a well-formed MIME type is
  stored (and served on download) as `application/octet-stream`.
- **Addresses**: a shared-domain address is never handed to another account. When an inbox on
  `MAIL_DOMAIN` is deleted (by its account or by ttl expiry) its address goes into
  `address_tombstones` for good; only the account that owned it may create it again. For anyone
  else creating it answers exactly like an address another account holds (409 `conflict`, same
  message), from one query either way, so the two cannot be told apart.
- **Waiting** (`wait_for_email`): return the newest inbound message that matches the filters and
  was received after `after`. `after` defaults to the request time minus 60 s, so mail that landed
  between submitting a form and calling wait still counts; pass it explicitly (unix ms such as the
  `received_at` of the last message handled, unix seconds, or ISO 8601; `0` = anything) to exclude
  older mail. If nothing matches, the request parks on the inbox's Durable Object (`InboxDO`) until
  the email handler notifies it or the timeout passes, then re-checks D1. The DO keeps a persisted
  notification counter that `email()` bumps after each commit; a waiter reads it before its last D1
  check and parks with that value, so mail that lands between the check and parking wakes it at
  once (timestamps alone are not enough: concurrent deliveries can commit out of order). Default timeout 30 s, max 120 s; on
  timeout 408 `{ "error": { "code": "timeout", "hint", "details": { after, ... } } }`. No polling.
- **Extraction at ingest** (`src/extract/`, pure, tested against `test/fixtures/`):
  - `codes`: 4-10 digits, digit groups (`482 913`, `482-913` -> `482913`) or upper-case
    alphanumerics with a digit (`7Q9XLD`, `K7P-2QX`, dash kept). Reported only with positive
    evidence: a code keyword just before it (verification/security/login/confirmation code, OTP,
    one-time password, passcode, PIN, 2FA, ... plus Spanish, Portuguese, French, German, Italian,
    Dutch, Polish, Turkish, Nordic, Chinese, Japanese, Korean, Russian), "`<code>` is your ... code"
    after it, or the code alone on its line under such a label (HTML table cells, letter-spaced
    `4 8 2 9 1 3`). URLs, emails, prices, percentages, dates, times, phone numbers, versions and IPs
    are masked first; a nearer order/invoice/reference/tracking/account/zip/promo/price word vetoes;
    years need an adjacent strong keyword; counts ("2048 lines") are ignored; quoted reply lines
    (`>`) are skipped; alphanumerics need a strong keyword and no promo context. False positives
    cost more than misses: a newsletter full of numbers yields `[]`. The OTP-Token header is used
    when present. `code` = `codes[0]`.
  - `links`: every http(s) link with `kind` (`verify`, `magic_login`, `password_reset`,
    `unsubscribe`, `other`) and anchor `text`, including List-Unsubscribe. An action kind needs
    wording (anchor, URL, or the sentence before a "click here"/bare link) and a token-bearing or
    action URL, so a footer "Log in" link is `other`. `verify_link` = first action link.
  - `auth`: SPF/DKIM/DMARC/ARC from the first `Authentication-Results` header written by
    `mx.cloudflare.net` (`trusted: true`); headers further down can be forged by the sender and only
    give `trusted: false`, `verdict: "unknown"`. `verdict: "pass"` = the From domain is
    authenticated: DMARC pass for that domain (the result's `header.from`, when present, must be
    the From domain), or a DKIM pass (`header.d`) or SPF pass (`smtp.mailfrom`) aligned with it
    (equal or parent/subdomain, never a bare TLD). `fail` = DMARC failed.
  - `preview`: ~160 chars of plain text, URLs dropped.
- **Threads**: In-Reply-To/References that name a message in the same inbox -> that thread. Else,
  if the subject has a reply/forward prefix (Re:, Fwd:, AW:, SV:, ...) and a thread in the inbox
  has the same normalised subject with the same counterparty in the last 30 days -> that thread
  (covers clients that drop the headers, and replies to sent mail if Email Service's Message-ID
  differs from the id the binding returned). Else a new thread. Fresh mail never joins a thread by
  subject alone.
- **Sending**: Cloudflare Email Service via the `send_email` binding, always from the inbox's own
  address (display name from the inbox). Allowed from-domains: the shared `MAIL_DOMAIN`, or a
  custom domain the account owns (ownership challenge passed; else 403 `ownership_not_verified`)
  whose sending records passed `verify` (else 403 `domain_not_verified`). With
  `SHARED_SEND_POLICY=reply_only`, a shared-domain inbox may only send to addresses that have
  emailed that inbox with authenticated mail (`auth.verdict: "pass"`, see `auth` above); a forged
  or unauthenticated From does not count (403 `reply_only`, `details.recipients_not_allowed`).
  Nothing that becomes a header carries control characters: `display_name` has CR/LF and other
  control characters replaced by spaces on create/update and again before sending; attachment
  `filename` likewise; an attachment `content_type` must be a well-formed MIME type and
  `content_id` a bare id (else 400). Up to 50 recipients
  (to+cc+bcc), 32 attachments (base64 in, sent as binary), 25 MiB; custom headers `X-*` only
  (Email Service accepts a fixed allow-list and rejects `Message-ID`). A text part is always sent
  (derived from html if needed). Sent mail is stored as `direction: "out"` in the same thread;
  replies get `Re:`, `In-Reply-To` and `References` (trimmed under Email Service's 2,048-byte header
  value limit, keeping the root and newest ids). Per-account daily limit `SEND_DAILY_LIMIT`, counted
  per recipient per UTC day, reserved atomically and refunded if the send fails. Email Service
  error codes (`E_SENDER_NOT_VERIFIED`, `E_RECIPIENT_NOT_ALLOWED`, ...) map to errors with hints.
  Raw MIME is not available for sent mail (Email Service composes it); its stored text is capped at
  64 KB like inbound mail.
- **Domains**: the operator's shared `MAIL_DOMAIN` works for every account out of the box. An
  account can add its own domain: the response lists the exact DNS records, first the ownership
  challenge, then receiving (MX `route1/2/3.mx.cloudflare.net`, SPF
  `v=spf1 include:_spf.mx.cloudflare.net ~all`, DKIM `cf2024-1._domainkey`) and sending (MX/SPF on
  `cf-bounce.<domain>`, DKIM `cf-bounce._domainkey`, DMARC `_dmarc`). Both services require
  Cloudflare DNS; DKIM keys and MX priorities are generated by Cloudflare, so those are checked for
  presence/host only.
  - **Ownership**: a claim gives no rights by itself, and several accounts may claim the same
    domain. The account proves control with TXT `_afs-verify.<domain>` = `afs-verify=<token>`,
    token = the first 32 hex chars of HMAC-SHA256(secret, `<account_id>|<domain>`), secret =
    `ENCRYPTION_KEY`, else `ADMIN_TOKEN` (neither set: custom domains are refused with 400
    `custom_domains_unavailable`). It is deterministic, so adding the domain again returns the same
    record (`records[0]`, `id: "ownership_txt"`, with a hint in `next_steps[0]`). The first account
    whose challenge passes in `verify` owns the domain (`ownership: "verified"`,
    `owner_verified_at`): the other accounts' claims are removed (and any inboxes they hold on it
    from before challenges existed), and new claims by other accounts get 409 `conflict`. Until
    then the domain receives no mail (neither addresses nor catch-all), cannot send, and
    `POST /v1/inboxes` on it answers 403 `ownership_not_verified`. Ownership is kept once proven;
    `verify` stops checking the TXT record (it may be removed).
  - `verify` checks live DNS over DoH (`cloudflare-dns.com/dns-query`, JSON) and returns pass/fail
    per record with the fix, plus `ownership`, `receiving` and `sending`; status is `pending` |
    `partial` | `verified` (ownership, receiving and sending all pass).
  - **auto_configure** (operator only): if the operator set `CF_API_TOKEN` and the zone is in the
    operator's account, `auto_configure: true` with the request header `x-admin-token: <ADMIN_TOKEN>`
    (compared in constant time) enables Email Routing for the domain (apex, or adds the subdomain),
    points the zone's catch-all at this Worker (refusing to replace a catch-all that routes
    elsewhere unless `force: true`), onboards the domain to Email Sending and creates its missing
    records, then merges the exact records (priorities, DKIM keys) Cloudflare returns. Without a
    matching header, `auto_configure` or `force` answers 403 `admin_required` (before anything is
    stored or changed) with the DNS records to add by hand in `error.details.records`; on MCP the
    header goes on the `/mcp` request. Without `CF_API_TOKEN`, `auto_configure` answers 400
    `auto_configure_unavailable`. auto_configure does not prove ownership: the challenge still has
    to pass. Note: catch-all rules exist only on the zone apex; the apex catch-all also receives
    mail for routing subdomains that have no literal rule. Deleting a domain never changes
    Cloudflare settings.
- **Webhooks**: `message.received` events (and `webhook.test`) are written to a delivery log and
  sent through a Queue. Each webhook has its own secret, returned once at creation and sealed at
  rest with `encryptSecret()` when `ENCRYPTION_KEY` is set. Header
  `x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` plus
  `x-webhook-id`, `x-event-id`, `x-event-type`, `x-delivery-attempt`. Non-2xx is retried after
  10 s, 30 s, 1 min, 5 min, 15 min, 30 min, 1 h (8 attempts); 410 disables the webhook. Redirects
  are not followed (`redirect: "manual"`): a 3xx is a failed attempt. At most 64 KB of a response
  body is read (a failed delivery's `error` keeps the first 200 characters). URLs must be https
  (http only for localhost). Same url + inbox again returns the existing webhook. At most
  `MAX_WEBHOOKS_PER_ACCOUNT` (default 10) webhooks per account (403 `quota_exceeded`). Fan-out is
  enqueued in `sendBatch` calls of at most 100 messages / 200 KB, under the Queues limits.
- **Cron** (hourly): deletes expired inboxes, shared-domain mail older than
  `SHARED_RETENTION_DAYS`, and inbound counters older than a week. Each purge loops in rounds
  (retention: 200 messages per round; expiry: 50 inboxes per round, each inbox's mail deleted in
  500-row chunks) until nothing is left or a 20 s wall-time budget is spent, then logs `more: true`
  and the next run continues.

## API (under `/v1`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (`@afs/shared`); also creates and returns a default inbox |
| GET | `/me`; GET, POST `/keys`; DELETE `/keys/:id` | `@afs/shared` |
| POST | `/inboxes` | `{ username?, domain?, display_name?, ttl_days? }`; random username if omitted; same address returns existing (200); another account's address, or a deleted shared-domain address that was another account's, is 409; on a custom domain only once ownership is verified (else 403 `ownership_not_verified`) |
| GET | `/inboxes`, `/inboxes/:id` | list (`?limit=&domain=`); one with message/unread counts |
| PATCH, DELETE | `/inboxes/:id` | `{ display_name?, ttl_days? }` (null = forever); delete removes all its mail |
| GET | `/inboxes/:id/messages` | `?unread=true&q=search&from=&direction=in\|out&limit=&before=` -> `{ messages, next_before }` |
| GET | `/inboxes/:id/threads` | `?limit=&before=` |
| GET | `/inboxes/:id/wait` | `?from=&subject=&contains=&after=&timeout=` -> newest matching message, or 408 `timeout` |
| GET | `/inboxes/:id/latest-code` | same wait, only mail with a code or action link -> `{ code, codes, link, link_kind, message_id, from, subject, received_at, auth_verdict, waited_ms }` |
| POST | `/inboxes/:id/send` | `{ to, cc?, bcc?, subject, text?, html?, reply_to?, attachments?, headers? }` |
| GET | `/messages/:id` | full message incl. text (`text_truncated` when cut at 64 KB), html (`?html=false` to skip), codes, links, auth, attachments list |
| GET | `/messages/:id/raw` | original MIME (inbound only) |
| GET | `/messages/:id/attachments/:aid` | download (always `content-disposition: attachment`, sandbox CSP) |
| POST | `/messages/:id/reply` | `{ text?, html?, reply_all?, attachments?, headers? }` |
| PATCH, DELETE | `/messages/:id` | `{ read: true }` |
| GET | `/threads/:id` | thread with every message, oldest first |
| GET | `/search?q=` | across all inboxes (`&inbox_id=&from=&limit=&before=`); words are prefix-matched and AND-ed |
| POST, GET | `/domains` | add `{ domain, auto_configure?, force?, catch_all_inbox_id? }` (`records[0]` = ownership challenge; 409 if another account owns it; `auto_configure`/`force` need header `x-admin-token`, else 403 `admin_required`) / list (+ shared domain) |
| GET, PATCH, DELETE | `/domains/:domain` | records + status (`ownership`, `receiving`, `sending`); PATCH `{ catch_all_inbox_id?, auto_configure?, force? }`; DELETE `?delete_inboxes=true` |
| POST | `/domains/:domain/verify` | live DNS check incl. the ownership challenge (while pending), per-record pass/fail with fixes; passing the challenge makes the account the owner |
| POST, GET | `/webhooks` | `{ url, events: ["message.received"], inbox_id? }` -> secret once (403 `quota_exceeded` past `MAX_WEBHOOKS_PER_ACCOUNT`) / list with last delivery |
| GET, DELETE | `/webhooks/:id` | GET includes the last 20 deliveries |
| POST | `/webhooks/:id/test` | queue a signed `webhook.test` event |

Also: `GET /` (service info), `GET /llms.txt` (manual), `GET /ui` (human view), `POST /mcp`.

## MCP tools

`create_inbox`, `list_inboxes`, `get_inbox`, `update_inbox`, `delete_inbox`, `list_messages`,
`get_message`, `get_raw_message`, `wait_for_email`, `get_latest_code`, `search_messages`,
`get_thread`, `list_threads`, `send_email`, `reply_to_message`, `mark_read`, `delete_message`,
`get_attachment`, `add_domain`, `list_domains`, `get_domain`, `update_domain`, `delete_domain`,
`verify_domain`, `create_webhook`, `list_webhooks`, `get_webhook`, `test_webhook`,
`delete_webhook`. Each calls the same service function as its REST route. Write tools are hidden
from read-only keys. Operator-only arguments (`auto_configure`, `force`) need the `x-admin-token`
header on the `/mcp` request, as on REST.

Tools that return message content say in their description that email content is untrusted
input written by third parties. Subject, sender name and preview are returned inside an
`untrusted` field and bodies are fenced as `<<<UNTRUSTED_EMAIL_TEXT_<nonce> ... UNTRUSTED_EMAIL_TEXT_<nonce>>>`
with a per-call random nonce, so the content cannot close the fence.

## Human view

`GET /ui`: one self-contained page, no framework (paste an API key, stored in localStorage; or
create an account from the page). Lists inboxes and messages, shows codes (click to copy), action
links, auth verdict, text/HTML/raw and attachments. All third-party text is inserted with
`textContent`. HTML mail is rendered in `<iframe sandbox srcdoc>` with no sandbox allowances (no
scripts, forms, popups, same-origin or top navigation) and a CSP (`default-src 'none'; img-src
data:; style-src 'unsafe-inline'`) that blocks remote images and scripts; the page itself is
served with a strict CSP.

## Config

| Var / secret | |
|---|---|
| `PUBLIC_BASE_URL` | var; URL used in responses and llms.txt (default: request origin) |
| `MAIL_DOMAIN` | var; shared domain for instant inboxes (placeholder `mail.example.com`; see operator setup) |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | `@afs/shared` auth (`SIGNUP_MODE` is a var, the tokens are secrets). `ADMIN_TOKEN` also authorises `auto_configure`/`force` (request header `x-admin-token`) and keys domain ownership challenges when `ENCRYPTION_KEY` is unset |
| `SEND_DAILY_LIMIT` | var, default 200 recipients per account per UTC day |
| `WORKER_NAME` | var; must equal the Worker name (`sg-mail`); auto_configure points catch-alls at it |
| `ENCRYPTION_KEY` | secret; 32-byte base64 (`openssl rand -base64 32`), seals webhook secrets and keys domain ownership challenges. Without it webhook secrets are stored unsealed (`plain:` prefix), and without it and `ADMIN_TOKEN` custom domains are refused. Changing it changes the challenge of domains whose ownership is still pending |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | optional secrets; enable `auto_configure` (operator only). Token: Zone Read, Zone Settings Edit, Email Routing Rules Edit, Email Sending Edit on the zones it may configure |
| `SHARED_SEND_POLICY` | optional var; `reply_only`: shared-domain inboxes may only send to addresses that emailed them with `auth.verdict: "pass"` (unset = anyone) |
| `SHARED_RETENTION_DAYS` | optional var; hourly cron deletes shared-domain mail older than this (unset = keep) |
| `MAX_INBOXES_PER_ACCOUNT` | optional var; cap on inboxes per account (unset = none) |
| `EXTRA_RESERVED_USERNAMES` | optional var; comma-separated usernames nobody may take on the shared domain, on top of the built-in role names |
| `MAX_MESSAGES_PER_INBOX` | optional var; inbound messages an inbox may hold, more are rejected at SMTP time (unset = no cap) |
| `MAX_INBOUND_PER_ACCOUNT_PER_DAY` | optional var; inbound messages an account may receive per UTC day across its inboxes, more are rejected at SMTP time (unset = no cap) |
| `MAX_WEBHOOKS_PER_ACCOUNT` | optional var; webhooks per account (default 10) |
| `WEBHOOK_SIGNING_SECRET` | not needed: each webhook gets its own secret, returned once |

Bindings (`wrangler.jsonc`): D1 `DB` (placeholder id), R2 `BLOBS`, Durable Object `INBOX`
(`InboxDO`, SQLite-backed, migration `v1`), Queue `WEBHOOKS` (producer + consumer, batch 10,
1 s, 8 retries), `send_email` `EMAIL` (unrestricted; the app enforces senders), hourly cron (purges
expired inboxes, old shared-domain mail and old counters), observability on. `compatibility_date` is 2026-08-22, the newest date the
workerd bundled with `@cloudflare/vitest-pool-workers` 0.23 supports, so tests run on the same
runtime semantics as dev and production.

## What Cloudflare Email Service supports (checked against the docs, 2026-11)

- **Receiving** (Email Routing, free): `email(message, env, ctx)` gets a `ForwardableEmailMessage`
  (`from`/`to` envelope, `headers`, single-use `raw` stream, `rawSize`, `setReject`, `forward`,
  `reply`). Inbound limit 25 MiB. Catch-all rules exist only on the zone apex (they also receive
  mail for routing subdomains without a literal rule).
- **Sending** (Email Sending, beta): `env.EMAIL.send({ from, to, cc, bcc, replyTo, subject, text,
  html, attachments, headers })` -> `{ messageId }`. Arbitrary recipients need the **Workers Paid**
  plan and an **onboarded sending domain**; before onboarding, only the account's verified
  destination addresses can receive. Onboarding (dashboard Email Sending > Onboard Domain, `wrangler
  email sending enable <domain>`, or `POST /zones/:zone/email/sending/subdomains`) adds MX/SPF/DKIM
  on `cf-bounce.<domain>` and DMARC; the zone must use Cloudflare DNS. Headers: `In-Reply-To`,
  `References`, `List-*` and other allow-listed names plus `X-*` (max 20 non-X); `Message-ID` and
  address headers are rejected. Attachments: binary (`ArrayBuffer`/view) or string content.
- **Local dev**: `POST /cdn-cgi/local/email?from=&to=` with a raw RFC 5322 body (must have a
  Message-ID) invokes `email()`; 200 on success, 400 with the reject reason after `setReject`. The
  local `send_email` binding sends nothing: it logs "send_email binding called with
  MessageBuilder", writes text/HTML/attachments under `.wrangler/tmp/email/`, and records each send
  in the Local Explorer (`GET /cdn-cgi/local/explorer/api/local/email/sending`), which the smoke
  test asserts on. `"remote": true` on the binding would send real mail; it is not set.

## Operator setup: going live

1. **Resources**: `wrangler d1 create sg-mail` (put the id in `wrangler.jsonc`), `wrangler r2
   bucket create sg-mail-blobs`, `wrangler queues create sg-mail-webhooks`.
2. **Secrets**: `wrangler secret put ENCRYPTION_KEY` (`openssl rand -base64 32`); optionally
   `SIGNUP_TOKEN`/`ADMIN_TOKEN` (and set `SIGNUP_MODE`), `CF_API_TOKEN` + `CF_ACCOUNT_ID` for
   `auto_configure` (which then also needs `ADMIN_TOKEN`: only requests with
   `x-admin-token: <ADMIN_TOKEN>` may use it). Set `MAIL_DOMAIN` and `PUBLIC_BASE_URL` in
   `wrangler.jsonc`; a public deployment also sets the fair-use vars in Config.
3. **Shared MAIL_DOMAIN** (one time). Use a domain on Cloudflare DNS in the same account, ideally
   the apex of a dedicated zone (e.g. `agentmail-example.com`), because Email Routing's catch-all
   only exists on the apex and would otherwise also capture the apex's unknown addresses:
   - Receiving: Compute > Email Service > Email Routing > Onboard Domain (removes nothing; fails
     with 2008 if other MX records exist). For a subdomain MAIL_DOMAIN, add it under the apex's
     Settings > Subdomains instead. Then Routing rules > Catch-all > Action "Send to a Worker" >
     `sg-mail` > Active. Alternatively uncomment `"addresses": ["*@<apex>"]` in `wrangler.jsonc`
     and `wrangler deploy` manages the catch-all.
   - Sending: Compute > Email Service > Email Sending > Onboard Domain > `MAIL_DOMAIN` (or `wrangler
     email sending enable <MAIL_DOMAIN>`), on the Workers Paid plan. Check with `wrangler email
     sending dns get <MAIL_DOMAIN>`. Add/tighten DMARC once mail flows.
4. **Deploy**: `pnpm db:migrate` (remote), `pnpm deploy`.
5. **Check**: `curl -X POST $BASE/v1/signup`, send a mail from any mailbox to the returned address,
   `curl $BASE/v1/inboxes/$ID/wait?timeout=60`. Send one with `POST /v1/inboxes/$ID/send` to an
   address you own. Run `bash scripts/smoke.sh` only against `wrangler dev` (it uses the local
   email endpoint).

## Development and tests

```sh
pnpm types && pnpm typecheck
pnpm test                    # unit (Node) + integration (workerd via @cloudflare/vitest-pool-workers)
pnpm db:migrate:local && pnpm dev   # http://localhost:8789
pnpm smoke                   # against BASE (default http://localhost:8789); needs curl, jq, node, openssl
```

- `test/unit/`: the extraction corpus (`test/fixtures/*.eml`: Google, Meta/Facebook, Microsoft,
  Stripe, GitHub, Slack, Shopify, TikTok, Amazon, a Spanish bank OTP, a magic-link login, a
  password reset, and negatives: a newsletter full of numbers and promo codes, an order
  confirmation with prices/order/tracking numbers, a security alert, a quoted reply), ~50 single
  line positive/negative code cases, link and auth parsing, address validation and normalisation,
  threading, webhook signing, the DNS record builder and DoH evaluation (fake fetcher), and the
  Cloudflare API request builders plus `auto_configure` against a fake API (never the real one);
  `security-pure.test.ts`: operator-token matching, the ownership challenge record and its check,
  the 64 KB text cap, forged vs genuine authentication verdicts, queue chunking, capped response
  reads, header-safe values.
- `test/integration/`: the Worker in workerd: signup + default inbox, `email()` storing /
  rejecting / idempotency / plus-addressing / expiry, wait parking on `InboxDO` and waking, the
  grace window and explicit `after`, latest-code, reply threading headers and inbound replies
  joining the thread, the daily limit, unverified-domain refusal, webhook delivery records and
  sealed secrets, MCP `tools/list` and `tools/call`; `security.test.ts`, one group per review
  finding: operator-only auto_configure (REST, MCP, fake Cloudflare API), ownership challenges
  (two accounts racing for a domain, legacy rows), text cap, per-inbox and per-day inbound limits,
  time-budgeted purges, reply_only with forged and genuine mail, address tombstones, webhook cap /
  redirects / 64 KB reads / batched fan-out, the dedupe race (unique index) and the wait race, and
  header injection.
- `scripts/smoke.sh`: the full path over HTTP against `wrangler dev`, including a local webhook
  receiver (`scripts/webhook-receiver.mjs`) that verifies signatures.

## Not yet (v2)

IMAP/SMTP access, labels/folders beyond in/out, scheduled send, templates, bounce/complaint
processing (and `message.sent`/`message.bounced` webhook events), inbound spam scoring beyond Email
Routing's own checks, per-inbox allow-lists, literal per-address Email Routing rules for custom
subdomains whose zone catch-all must stay elsewhere, HTML sanitising for API consumers (HTML is
returned as received), `latest-code` for word-based login codes ("hungry-robot-lunch").
