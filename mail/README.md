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
                   suspended account / daily limit / storage full -> setReject (before the body is read)
                   parse the headers only: duplicate? per-sender daily cap -> setReject
                   parse the body (postal-mime), extract from its first 512 KB (linear scanners)
                                       ─► R2: raw .eml, HTML body (deleted again if the commit fails)
                                       ─► D1, one transaction: message row if the daily quota and stored
                                          bytes still allow (+ FTS5 index, the day's count, attachment
                                          rows pointing into the raw .eml), extracted codes/links/auth, thread,
                                          forward_queue row when the inbox forwards to its members
                                       ─► full inbox: evict the dominant sender's oldest mail
                                       ─► InboxDO.notify() wakes any parked wait_for_email
                                       ─► Queue: webhook deliveries (signed, retried)
                                       ─► after the SMTP answer (waitUntil): forward to the members
                                          (mode each); the hourly cron sends digests and leftovers
agent ─ REST / MCP ─► Worker ─► D1 / R2 ;  send ─► Cloudflare Email Service (send_email binding)
```

Code layout: `src/index.ts` (Hono app + `fetch`/`email`/`queue`/`scheduled` handlers, exports
`InboxDO`), `src/routes/api.ts` (thin REST), `src/mcp.ts` (thin MCP), `src/service/*` (all logic,
shared by both), `src/extract/*` (pure extraction), `src/lib/*` (address rules, threading, DNS,
Cloudflare API, signing, header hygiene, sender keys), `src/llms.ts`, `src/ui.ts`, `migrations/0002_mail.sql` (schema)
plus `0004_domain_ownership.sql`, `0005_inbound_limits.sql`, `0006_address_tombstones.sql`,
`0009_abuse_controls.sql` (wait slots, sender keys and counters, daily budgets, text usage, cron state),
`0010_blob_storage.sql` (stored bytes per message and account, attachments served from the raw MIME),
`0014_forward_to_members.sql` (the inbox `forward_*` columns and `forward_queue`),
`0015_permanent_tombstones.sql` (addresses of deleted projects reserved for good).

- **Receiving**: Email Routing's catch-all routes every address of a mail domain to this Worker.
  The envelope recipient is lowercased and its `+tag` stripped (`acme+meta@` delivers to `acme@`).
  Recipient address -> inbox (D1). Unknown address: delivered to the domain's catch-all inbox if one
  is set (custom domains only), else rejected with `setReject("Address does not exist")` before
  the body is read. Expired inboxes count as unknown, and so does every address on a custom domain
  whose ownership challenge has not passed (see Domains). Messages over 25 MB are rejected (Email
  Routing's limit). Also before the body is read: mail for a suspended account is refused with
  `Mailbox unavailable: <address> is not accepting mail` (polite, says nothing about why); with
  `MAX_INBOUND_PER_ACCOUNT_PER_DAY` set, once the account received N messages in the UTC day new
  mail is rejected with `Daily limit reached: ...; retry after 00:00 UTC`. The count
  (`inbound_counters`) only goes up in the transaction that stores a message, and the message's
  INSERT re-checks it there, so mail that is not stored (a duplicate, refused later, a failed or
  killed invocation) never uses up the quota, and concurrent deliveries cannot pass it. A `wait`
  that times out says so in its hint. With `MAX_BLOB_BYTES_PER_ACCOUNT` (on by default, see
  Storage) the account's stored bytes plus the message's size must fit, or it is rejected with
  `Mailbox full: ...`. Then the headers alone are parsed (`headerBlock()`): duplicates and the
  per-sender cap are settled before the body is parsed or extracted, so the cost of a hostile body
  only ever spends its own sender's allowance. With `MAX_INBOUND_PER_SENDER_PER_DAY` set, one sender
  may send one inbox that many messages per UTC day (`Too much mail from <sender> to <address>
  today (UTC)`), and with the daily account limit set one sender never gets more than half of it,
  across inboxes (one atomic upsert in `sender_counters`). The sender is a key one party cannot
  multiply for free (`src/lib/sender.ts`): the registrable domain of whatever authentication
  vouches for (the From address when `auth.verdict` is `pass`, else the SPF-checked envelope
  sender, else the DKIM signing domain), or the full address on shared mailbox providers
  (gmail.com, outlook.com, ..., `MAIL_DOMAIN`). Mail nothing vouches for (no SPF, DKIM or DMARC
  pass on Cloudflare's header) is one sender, `unauthenticated` (`Too much unauthenticated mail
  ...`): its envelope sender and From are whatever the sender typed, so keying by them would give
  every forged domain a fresh allowance. Extraction (`src/extract/*`) reads at most 512 KB of the
  text part and of the HTML, and every scanner in it is linear: tags are found with `indexOf`, and
  no regex can rescan the rest of the body from each repeat of an unclosed construct (a test runs
  each extractor over 300 KB of such input). With `MAX_MESSAGES_PER_INBOX` set, a full inbox no longer refuses everyone: after
  each new message is stored, the oldest messages of the sender that holds the most mail in the
  inbox are evicted until it holds N again (one flooder evicts itself; with many senders it is
  simply the oldest mail). A repeated Message-ID in the same inbox is a no-op, so redeliveries
  are safe; a partial unique index on inbound (inbox, Message-ID) plus insert-or-ignore makes that
  hold for concurrent deliveries too (the losing copy's blobs are deleted). Every D1 read and
  admission check happens before anything is written to R2, and if the D1 commit fails the
  message's R2 objects are deleted again (the cron's sweep catches a crash in between). Thread
  lookup by subject compares the counterparty with `json_each` equality and filters use `instr()`:
  D1 refuses `LIKE` patterns over 50 bytes, which used to make long sender addresses fail.
- **Storage**: D1 `messages` (headers, envelope, plain text, extracted data, thread_id, direction
  in/out, read flag), an FTS5 table over subject/sender/text kept in sync by triggers; R2 for the
  raw MIME (`inbox/<id>/<msg>/raw.eml`) and the HTML body. Attachments of received mail are kept
  once, inside the raw MIME: their D1 rows record their position (`part_index`) and a download
  parses the stored message to serve them. Sent mail (which has no raw MIME) keeps its HTML and
  attachments as objects of their own. Each message records the bytes it keeps in R2
  (`blob_bytes`) and `account_usage.blob_bytes` sums them by trigger, so it always equals what
  the account's current rows hold and every deletion (by hand, eviction, retention, inbox expiry
  or deletion) gives the bytes back. `MAX_BLOB_BYTES_PER_ACCOUNT` (default 1 GiB, 256 MiB for
  unclaimed accounts; `"0"` = off) caps it: inbound mail that does not fit is rejected at SMTP time
  (`Mailbox full: ...`; checked before the body is read and again, exactly, in the commit), and a
  sent message still goes out but its stored copy keeps only the text (`stored_copy: "text_only"`),
  so mail others send in cannot block sending. `GET /v1/inboxes` reports `storage`
  (`used_bytes`, `limit_bytes`). HTML is stored as received
  (not rewritten); the UI only renders it in a sandboxed iframe (see Human view). Plain text above
  64 KB (UTF-8) is cut in D1 and the message reports `text_truncated: true` (the raw MIME in R2
  keeps everything; for sent mail, which has no raw MIME, the message went out in full). Other
  sender-controlled fields are bounded too: subject 2,000 characters, sender name 500, To and Cc
  100 addresses each, References 8,000 characters (newest ids kept), link URLs 4,096 characters
  (longer links are dropped), 50 stored attachments per message (`attachments_omitted` counts the
  rest, still in the raw MIME), attachment filenames 255 characters. An attachment content type
  that is not a well-formed MIME type is stored (and served on download) as
  `application/octet-stream`. With `MAX_TEXT_BYTES_PER_ACCOUNT` set, `account_usage` (kept by
  triggers) counts the UTF-8 bytes of each account's stored text and links; past the budget new
  mail (in and out) keeps a 2 KB excerpt and 10 links (action links first) in D1, with
  `text_truncated: true`; codes and links are still extracted from the whole message.
- **Addresses**: a shared-domain address that received mail (it may have been used to sign up
  somewhere) is not handed to another account for a while. When such an inbox on `MAIL_DOMAIN` is
  deleted (by its account or by ttl expiry) its address goes into `address_tombstones` for
  `ADDRESS_TOMBSTONE_DAYS` (default 90; the cron prunes lapsed ones); only the account that owned
  it may create it again meanwhile. For anyone else creating it answers exactly like an address
  another account holds (409 `conflict`, same message), from one query either way, so the two
  cannot be told apart. An address that never received mail is free again at once, so create/delete
  loops reserve nothing; `MAX_INBOX_CREATES_PER_DAY` and `MAX_INBOX_DELETES_PER_DAY` (API deletes;
  ttl expiry does not count) cap the churn per account (429 `daily_limit` with a hint; a create
  that returns an address you already own is not counted). `DELETE` answers
  `address_reserved_until`. When a deleted project's mail is erased, its addresses that ever
  received mail are reserved permanently instead (`permanent = 1`, never pruned): they are often
  the recovery email of accounts elsewhere, and the project can't come back for them.
- **Project deletion** (`accounts.deleted_at` in the identity DB): reads as suspended, so keys stop,
  inbound mail is refused at SMTP and forwarding stops at once. 7 days later the site's cron calls
  `DELETE /v1/account` (internal auth only, no MCP tool; API keys get `403 forbidden`;
  `src/service/purge.ts`): every inbox (messages, attachments, threads, R2 blobs, scheduled
  sends), custom domains, webhooks and their logs, and the account's other rows (lists,
  Idempotency-Key replays, delivery status, the event feed, mail waiting to be forwarded, wait
  slots). It keeps the bare `accounts` row, the fair-use counters and the address tombstones. It
  answers `{account_id, done, deleted, addresses_reserved}`; `done: false` means call again, and
  a live project gets `409 not_deleted`.
- **Waiting** (`wait_for_email`): return the newest inbound message that matches the filters and
  was received after `after`. `after` defaults to the request time minus 60 s, so mail that landed
  between submitting a form and calling wait still counts; pass it explicitly (unix ms such as the
  `received_at` of the last message handled, unix seconds, or ISO 8601; `0` = anything) to exclude
  older mail. If nothing matches, the request takes a slot in `active_waits` (one atomic insert:
  `MAX_CONCURRENT_WAITS` per account, default 3, and `MAX_CONCURRENT_WAITS_PER_INBOX`, default 2;
  beyond them 429 `too_many_waits` with a hint; `timeout=0` never takes one; a slot whose Worker
  died expires 15 s after its deadline) and parks on the inbox's Durable Object (`InboxDO`) until
  the email handler notifies it or the timeout passes, then re-checks D1. Parking is a WebSocket from
  the Worker to the DO accepted with the Hibernation API, with the timeout kept in the Worker, so
  the DO hibernates while callers wait and is not billed for duration (a parked RPC promise kept
  it in memory for up to 125 s per call, about $4/month per inbox held awake). The DO keeps a
  persisted notification counter that `email()` bumps after each commit; a waiter reads it before
  its last D1 check and parks with that value, so mail that lands between the check and parking
  wakes it at once (timestamps alone are not enough: concurrent deliveries can commit out of
  order). The `WAIT_LIMITER` binding rate-limits waits per account (429 `rate_limited`); suspended
  accounts get 403 `account_suspended`. Default timeout 30 s, max 120 s; on timeout 408
  `{ "error": { "code": "timeout", "hint", "details": { after, ... } } }`. No polling.
- **latest-code** is strict about who sent the code: `from` must be a domain (the From address's
  domain equals it or is a subdomain; a display name or `github.com.evil.example` never matches)
  or a full address (a bare word is a 400), and by default only mail with `auth.verdict: "pass"`
  counts (`allow_unauthenticated=true` opts out; a 408 hint names a match that was skipped for
  failing authentication). `wait`'s `from` stays a loose substring filter.
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
  - `auth`: SPF/DKIM/DMARC/ARC from the first (topmost) `Authentication-Results` header, trusted
    (`trusted: true`) only when its authserv-id is exactly `mx.cloudflare.net`: Email Routing
    prepends it, so the sender cannot put one above it, while any header further down (even one
    claiming to be `mx.cloudflare.net`) may be the sender's and is ignored. `verdict: "pass"` =
    the From domain is authenticated: DMARC pass for that domain (the result's `header.from`, when
    present, must be the From domain), or a DKIM pass (`header.d`) or SPF pass (`smtp.mailfrom`)
    aligned with it (equal or parent/subdomain, never a bare TLD). Never `pass` with two From
    headers or two mailboxes in From, or when the trusted header reports `dmarc` or `spf` twice
    (injected text). `fail` = DMARC failed.
  - `automated`: list, bulk or machine-generated mail (List-Id / List-Unsubscribe / List-Post,
    Precedence bulk|list|junk, Auto-Submitted other than `no`, X-Autoreply, delivery reports,
    bounces with an empty envelope sender).
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
  or unauthenticated From does not count, and neither does `automated` mail (anyone can subscribe
  an inbox to an open list or get a helpdesk to auto-reply to it) (403 `reply_only`,
  `details.recipients_not_allowed`). Suspended accounts cannot send (403 `account_suspended`).
  Nothing that becomes a header carries control characters: `display_name` has CR/LF and other
  control characters replaced by spaces on create/update and again before sending; attachment
  `filename` likewise; an attachment `content_type` must be a well-formed MIME type and
  `content_id` a bare id (else 400). Up to 50 recipients
  (to+cc+bcc), 32 attachments (base64 in, sent as binary), 25 MiB; custom headers `X-*` only
  (Email Service accepts a fixed allow-list and rejects `Message-ID`). A text part is always sent
  (derived from html if needed). Sent mail is stored as `direction: "out"` in the same thread;
  replies get `Re:`, `In-Reply-To` and `References` (trimmed under Email Service's 2,048-byte header
  value limit, keeping the root and newest ids). Per-account daily limit `SEND_DAILY_LIMIT`
  (`UNCLAIMED_SEND_DAILY_LIMIT` for unclaimed accounts), counted per recipient per UTC day,
  reserved atomically and refunded if the send fails. Email Service
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
- **Webhooks**: events (`message.received`, `message.sent`, `message.delivered`, `message.bounced`,
  `message.complained`, `message.failed`, `message.forwarded`, `domain.verified`, and `webhook.test`) are written to a delivery log and
  sent through a Queue. Each webhook has its own secret, returned once at creation and sealed at
  rest with `encryptSecret()` when `ENCRYPTION_KEY` is set. Header
  `x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` plus
  `x-webhook-id`, `x-event-id`, `x-event-type`, `x-delivery-attempt`. Non-2xx is retried after
  10 s, 30 s, 1 min, 5 min, 15 min, 30 min, 1 h (8 attempts); 410 disables the webhook. Redirects
  are not followed (`redirect: "manual"`): a 3xx is a failed attempt. At most 64 KB of a response
  body is read (a failed delivery's `error` keeps the first 200 characters). URLs must be https
  (http only for localhost, and only with `DEV_MODE=true`), and never the platform itself: the
  registrable domain of `PUBLIC_BASE_URL` and of `AUTH_ISSUER` (e.g. `agentfirststack.com`) and
  all its subdomains are refused (400), checked again before every delivery (a webhook saved
  under other settings is marked `failed` without a request). Creating a webhook (or re-enabling
  one by creating it again) needs a permanent API key: a connected app's OAuth access token gets
  403 `temporary_credential` (`assertPermanentKey`), since a webhook would keep receiving every
  email after the token is gone; it is the only thing in mail that keeps sending data out (catch-all
  inboxes and custom domains route mail into the account). Same url + inbox again returns the existing webhook. At most
  `MAX_WEBHOOKS_PER_ACCOUNT` (default 10) webhooks per account (403 `quota_exceeded`). Fan-out is
  enqueued in `sendBatch` calls of at most 100 messages / 200 KB, under the Queues limits.
  `POST /webhooks/:id/test` is rate limited per account (`WEBHOOK_TEST_LIMITER`, 429
  `rate_limited`) and capped per UTC day (`MAX_WEBHOOK_TESTS_PER_DAY`, 429 `daily_limit`), and a
  test event is sent once, without retries. Delivery log rows are purged after 7 days. Suspended
  accounts' events are not enqueued, and queued deliveries for them are dropped (`failed`).
  `message.received` events carry `data.untrusted`, naming the fields a third party wrote.
- **Retries are safe for sends** (`src/service/idempotency.ts`): send, reply and forward take an
  `Idempotency-Key` header (MCP `idempotency_key`). The first request claims the key in D1
  (`send_keys`); a retry with the same key and body within 24 h gets the stored response (200,
  `idempotent_replay: true`), another body is 409 `idempotency_conflict`, a retry while the first
  is still sending is 409 `idempotency_in_progress`. A send that failed before Email Service
  accepted it releases the key; a claim left by a dead Worker is taken over after 2 minutes.
- **Own inboxes and own people** (`src/service/send.ts`): recipients that are this account's
  inboxes (or the catch-all of one of its domains) are delivered internally: the Worker writes the
  MIME (`src/lib/mime.ts`) and stores it with `ingestRaw` (receiving limits apply, authenticated
  as `authserv_id: "internal"`), and Email Service only gets the other recipients. Under
  `SHARED_SEND_POLICY=reply_only` those inboxes and the Google-verified emails of the account's
  members (identity DB `memberships` + `users`; `dev:` sign-ins only with `DEV_MODE`) are allowed
  without having written first. All recipients count toward `SEND_DAILY_LIMIT`.
- **Plus-address tags and reply text**: the `+tag` of the envelope recipient is stored
  (`messages.tag`, filter `tag=`). `src/extract/reply.ts` cuts the quoted history (attribution
  lines in a dozen languages, Original/Forwarded separators, Outlook header blocks, `>` lines, a
  trailing "Sent from my iPhone") in one linear pass; `reply_text` is stored only when it differs
  from the text. Calendar invites (`text/calendar`) are parsed by `src/extract/calendar.ts` into
  `calendar` at ingest.
- **Forward**: `Fwd:` subject, your text, a From/Date/Subject/To block, the original text and HTML
  (from the raw MIME when there is one), and its attachments; the same rules as send.
- **Forward to the owner** (`src/service/forward.ts`, pure parts in `src/lib/forwarding.ts`,
  migration `0014_forward_to_members.sql`): an inbox's `forward: { mode: each | digest | off,
  digest_hour, timezone }` sends its mail on to the project's members (Google-verified emails of
  the people who claimed it, read from the identity DB like `memberEmails`). At ingest,
  `forwardEligibility` decides from the headers whether a message may be forwarded at all (sender
  authenticated; not a bounce, auto-reply, internal delivery, our own `X-AFS-Forwarded` mail or the
  setup test's `+afs-test`); if so, a `forward_queue` row is written in the transaction that stores
  the message. Mode `each`: `email()` hands the stored message to `forwardEach` with `waitUntil`,
  after the SMTP answer; it claims the row, drops loops (mail from the account's own inboxes or a
  member), reserves `MAX_FORWARDS_PER_ACCOUNT_PER_DAY` (one per member; never `SEND_DAILY_LIMIT`)
  and sends one email per member from the inbox (`<inbox> via AgentFirstStack`, subject
  `[<inbox>] <subject>`, header block, text, HTML with active content stripped, attachments within
  the forward limits, a footer with the dashboard link from `AUTH_ISSUER`, no Reply-To). Mode
  `digest`: the hourly cron (`runForwards`) sends one digest per member when the inbox's local hour
  is `digest_hour`, claiming the local day on the inbox so a retry never sends twice. The cron also
  sends one catch-up digest once a member exists for mail that waited since before the claim, and
  in mode `each` what the live forward left (budget used up, a failed send) once the budget allows,
  noting the pause. Nothing is stored as sent mail and `message.forwarded` carries counts only, so
  the agent's key never learns the members' addresses. Rows go with their message and are dropped
  after 30 days.
- **Delivery status** (`src/service/delivery.ts`): Cloudflare Email Sending publishes
  `cf.email.sending.message.*` events to a Queues event subscription, one per sending domain. This
  Worker's `queue()` handler tells them from webhook jobs by shape, matches them to the sent
  message by `provider_message_id`, and keeps one row per recipient (`deliveries`): a terminal
  status is never replaced by a non-terminal one, an older event never replaces a newer one, and
  `complained` always wins. Changes wake `GET /messages/:id/delivery?timeout=` (it parks on the
  inbox's Durable Object like a wait) and emit `message.delivered|bounced|complained|failed`. See
  "Delivery status" below for the Cloudflare setup.
- **Event feed** (`src/service/feed.ts`, `events.ts`): every event webhooks get is also kept in D1
  `events` for 7 days (`MAX_FEED_EVENTS_PER_DAY`), read with `GET /v1/events?after=` / `wait_for_event`.
  Long-polls park on an `InboxDO` named `acct:<account>`, woken when an event is written, and use
  the same concurrent-wait slots as other waits.
- **Allow / block lists** (`src/service/lists.ts`): checked in `ingestRaw` right after the headers
  are parsed and before the per-sender allowance, so refused mail is rejected at SMTP time. Allow
  entries match only the authenticated sender (`senderIdentity`); block entries also match the
  claimed From of unauthenticated mail. A send block list refuses recipients (403).
- **Labels** (`labels_json` on messages and threads, `[a-z0-9:_-]{1,64}`, 20 each), system labels
  for filters, account-wide threads, thread delete, inbox clear (`MAX_INBOX_CLEARS_PER_DAY`), and a
  batch update of up to 100 messages.
- **Send-only domains** (`receiving: false`): no receiving records, no inbound mail (no catch-all),
  `verified` on ownership + sending; `auto_configure` leaves Email Routing alone. Zone-file export.
- **Scheduled send** (`send_at` <= 7 days): stored with status `scheduled` (HTML and attachments in
  R2, counted in the account's storage), capped by `MAX_SCHEDULED_PER_ACCOUNT`; the inbox's
  `InboxDO` alarm sends it (claim `scheduled -> sending`, so never twice), the hourly cron is the
  fallback. Rules and the daily limit are checked again then; a failure marks it `failed` and emits
  `message.failed`. Deleting it cancels it. OAuth access tokens may only schedule to the account's
  own inboxes and members.
- **Deliverability report** (`src/service/analysis.ts`) and **attachment text** (Workers AI
  `toMarkdown`, only with an `AI` binding, images not converted, `MAX_ATTACHMENT_TEXT_PER_DAY`).
- **Webhook management**: PATCH (url, events, `inbox_ids`, enabled), secret rotation, up to 5
  custom headers sealed with `ENCRYPTION_KEY` (names shown, values never), Standard Webhooks
  headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) next to `x-signature`. Changing
  or re-pointing a webhook needs the project's own key (OAuth tokens may only disable).
- **Usage** (`GET /v1/usage`): every cap with the configured value for the account's standing and
  what it has used; every mail 429 has `Retry-After` and `details.retry_after_s`. Each item has a
  `label` for people, `drops_data: true` where reaching the cap silently loses incoming mail
  (`inbound_per_day`, `messages_per_inbox`, `storage_bytes`, `text_bytes`), and
  `messages_per_inbox.per` lists every inbox (address, used, remaining), fullest first, at most 25:
  the same item shape as analytics, tags and replay, which the platform site reads to warn owners. `/llms.txt`
  renders this deployment's configured limits per request.
- **Cron** (hourly): sends forward digests (see Forward to the owner), deletes expired inboxes,
  shared-domain mail older than `SHARED_RETENTION_DAYS`, webhook delivery logs older than 7 days,
  daily counters older than a week, expired wait slots, lapsed address tombstones and forward-queue
  rows older than 30 days, and sweeps R2 for orphans: up to 5 list
  pages of 1,000 objects per run, resuming from a cursor in `cron_state`, deleting objects older
  than an hour whose message id has no D1 row. Each purge loops in rounds (retention: 200 messages
  per round; expiry: 50 inboxes per round, each inbox's mail deleted in 500-row chunks) until
  nothing is left or a 20 s wall-time budget is spent, then logs `more: true` and the next run
  continues. One failing job does not stop the others.

## API (under `/v1`)

| Method | Path | |
|---|---|---|
| POST | `/signup` | account + key (`@afs/shared`); also creates and returns a default inbox |
| GET | `/me`; GET, POST `/keys`; DELETE `/keys/:id` | `@afs/shared` |
| DELETE | `/account` | the platform's own: erases a deleted project's mail (see Project deletion); API keys get 403 |
| POST | `/inboxes` | `{ username?, domain?, display_name?, ttl_days?, forward? }` (`forward: { mode: each\|digest\|off, digest_hour, timezone }`, applied to a new inbox; every inbox JSON has `forward` with `recipients`, `waiting_for_owner`, `last_forwarded_at`, `last_digest_at`, `forwarded_today`, `daily_limit`, never the members' addresses); random username if omitted; same address returns existing (200); another account's address, or a recently deleted shared-domain address that received mail and was another account's, is 409; on a custom domain only once ownership is verified (else 403 `ownership_not_verified`); 429 `daily_limit` past `MAX_INBOX_CREATES_PER_DAY` |
| GET | `/inboxes`, `/inboxes/:id` | list (`?limit=&domain=`); one with message/unread counts |
| PATCH, DELETE | `/inboxes/:id` | `{ display_name?, ttl_days?, forward? }` (null = forever; `forward` merges, a bad `timezone` is 400); delete removes all its mail and answers `address_reserved_until` (429 `daily_limit` past `MAX_INBOX_DELETES_PER_DAY`) |
| GET | `/inboxes/:id/messages` | `?unread=true&q=&from=&to=&subject=&direction=in\|out&tag=&has=code,link,attachments&auth=pass\|fail\|unknown&labels=&status=&after=&before=&order=asc\|desc&limit=` -> `{ messages, next_before }` (`next_after` with `order=asc`) |
| DELETE | `/inboxes/:id/messages` | clear the inbox (`?before=`); `{ deleted, more }`; 429 past `MAX_INBOX_CLEARS_PER_DAY` |
| GET | `/inboxes/:id/threads` | `?limit=&before=&after=&q=&labels=` |
| GET | `/inboxes/:id/wait` | `?from=&subject=&contains=&tag=&after=&timeout=` -> newest matching message (with `reply_text`), or 408 `timeout`; 429 `too_many_waits` / `rate_limited` |
| GET | `/inboxes/:id/latest-code` | same wait, only mail with a code or action link, `from` = sender domain or address, authenticated senders only unless `allow_unauthenticated=true` -> `{ code, codes, link, link_kind, message_id, from, subject, received_at, auth_verdict, auth_required, tag, waited_ms }` |
| POST | `/inboxes/:id/send` | `{ to, cc?, bcc?, subject, text?, html?, reply_to?, attachments?, headers?, send_at? }`; `Idempotency-Key` header; own inboxes delivered internally (`internal`); 202 when scheduled |
| GET | `/messages/:id` | full message incl. `reply_text`, text (`text_truncated` when cut at 64 KB), html (`?html=false` to skip), codes, links, auth, tag, labels, calendar, attachments list; sent mail also `delivery` |
| GET | `/messages/:id/raw` | original MIME (inbound only) |
| GET | `/messages/:id/attachments/:aid` | download (always `content-disposition: attachment`, sandbox CSP) |
| GET | `/messages/:id/attachments/:aid/text` | a document attachment as Markdown via Workers AI (only with the `AI` binding, else 501); `MAX_ATTACHMENT_TEXT_PER_DAY` |
| GET | `/messages/:id/analysis` | deliverability checklist of a received message |
| GET | `/messages/:id/delivery` | per-recipient delivery status; `?timeout=` blocks until all are final |
| POST | `/messages/:id/reply` | `{ text?, html?, reply_all?, attachments?, headers?, send_at? }`; `Idempotency-Key` |
| POST | `/messages/:id/forward` | `{ to, cc?, bcc?, text?, html?, include_attachments?, headers?, send_at? }`; `Idempotency-Key`; same rules as send |
| PATCH, DELETE | `/messages/:id` | `{ read?, add_labels?, remove_labels? }`; DELETE cancels a scheduled message |
| POST | `/messages/batch` | `{ ids (<= 100), read?, add_labels?, remove_labels? }` or `{ ids, delete: true }` |
| GET | `/threads` | account-wide (`?inbox_id=&q=&labels=&after=&before=&limit=`) |
| GET, PATCH, DELETE | `/threads/:id` | thread with every message, oldest first; PATCH `{ add_labels?, remove_labels?, read? }`; DELETE removes it and its messages |
| GET | `/search?q=` | across all inboxes (the same filters as messages, plus `inbox_id`); every word of 3+ characters must appear (case-insensitive), within the account's 2,000 newest messages before the cursor; rate limited |
| GET | `/events` | the account's event feed: `?after=latest\|<next_after>&types=&inbox_id=&limit=&timeout=` (long-poll, 7 days kept) |
| POST, GET | `/lists/:direction/:kind` | `receive/allow`, `receive/block`, `send/block`: `{ entry, inbox_id?, reason? }` / list; `GET /lists` = all |
| DELETE | `/lists/:direction/:kind/:entry` | `?inbox_id=` for an inbox-scoped entry |
| GET | `/usage` | every cap with `label`, `used / limit / remaining / resets_at`, `drops_data`, `per` (inboxes), delivery counts (`?days=`) |
| POST, GET | `/domains` | add `{ domain, receiving?, auto_configure?, force?, catch_all_inbox_id? }` (`records[0]` = ownership challenge; 409 if another account owns it; `auto_configure`/`force` need header `x-admin-token`, else 403 `admin_required`; `receiving: false` = send-only) / list (+ shared domain) |
| GET, PATCH, DELETE | `/domains/:domain` | records + status (`ownership`, `receiving`, `sending`); PATCH `{ catch_all_inbox_id?, receiving?, auto_configure?, force? }`; DELETE `?delete_inboxes=true` |
| GET | `/domains/:domain/zone-file` | the records as a BIND zone file (`text/dns`) |
| POST | `/domains/:domain/verify` | live DNS check incl. the ownership challenge (while pending), per-record pass/fail with fixes; passing the challenge makes the account the owner; first `verified` emits `domain.verified` |
| POST, GET | `/webhooks` | `{ url, events?, inbox_id? \| inbox_ids?, headers? }` -> secret once (403 `quota_exceeded` past `MAX_WEBHOOKS_PER_ACCOUNT`) / list with last delivery |
| GET, PATCH, DELETE | `/webhooks/:id` | GET includes the last 20 deliveries; PATCH `{ url?, events?, inbox_ids?, enabled?, headers? }` (own key only, except disabling) |
| POST | `/webhooks/:id/rotate-secret` | new secret, shown once (own key only) |
| POST | `/webhooks/:id/test` | queue a signed `webhook.test` event, sent once; rate limited and capped per day |

Also: `GET /` (service info), `GET /llms.txt` (manual), `GET /ui` (human view), `POST /mcp`.

## MCP tools

`create_inbox`, `list_inboxes`, `get_inbox`, `update_inbox`, `delete_inbox`, `list_messages`,
`get_message`, `get_raw_message`, `wait_for_email`, `get_latest_code`, `search_messages`,
`get_thread`, `list_threads`, `update_thread`, `delete_thread`, `send_email`, `reply_to_message`,
`forward_message`, `get_delivery`, `mark_read`, `update_message`, `batch_update_messages`,
`delete_message`, `clear_inbox`, `get_attachment`, `get_attachment_text`, `analyze_message`,
`wait_for_event`, `add_list_entry`, `list_list_entries`, `delete_list_entry`, `get_usage`,
`add_domain`, `list_domains`, `get_domain`, `update_domain`, `delete_domain`, `verify_domain`,
`get_zone_file`, `create_webhook`, `list_webhooks`, `get_webhook`, `update_webhook`,
`rotate_webhook_secret`, `test_webhook`, `delete_webhook`. Each calls the same service function as
its REST route; `send_email`, `reply_to_message` and `forward_message` take `idempotency_key`
(the `Idempotency-Key` header on REST) and `send_at`. Write tools are hidden
from read-only keys. Operator-only arguments (`auto_configure`, `force`) need the `x-admin-token`
header on the `/mcp` request, as on REST.

REST responses that carry email content (messages, message, wait, latest-code, threads, search,
mark read) start with `"untrusted": { "notice", "fields" }`, listing the JSON paths a third party
wrote (`message.text`, `messages[].subject`, ...); the fields themselves stay in place, so programs
(and `/ui`) read them as before. Raw MIME and attachment downloads carry an `x-untrusted-content`
header. The manual has an "Email content is untrusted" section.

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
| `PUBLIC_BASE_URL` | var; URL used in responses and llms.txt (default: request origin). Its registrable domain and subdomains, and `AUTH_ISSUER`'s, are off limits to webhooks |
| `DEV_MODE` | var; `"true"` only for local development (`.dev.vars`): webhooks may use `http://localhost`. Template default `"false"` |
| `MAIL_DOMAIN` | var; shared domain for instant inboxes (placeholder `mail.example.com`; see operator setup) |
| `SIGNUP_MODE`, `SIGNUP_TOKEN`, `ADMIN_TOKEN` | `@afs/shared` auth (`SIGNUP_MODE` is a var, the tokens are secrets). `ADMIN_TOKEN` also authorises `auto_configure`/`force` (request header `x-admin-token`) and keys domain ownership challenges when `ENCRYPTION_KEY` is unset |
| `AUTH_ISSUER`, `INTERNAL_TOKEN` | `@afs/shared`: the OAuth server named in `/.well-known/oauth-protected-resource` (var; set by `pnpm afs`, unset = none listed; forwards to the owner also link to `<AUTH_ISSUER>/dashboard/projects/<account id>`, unset = no link), and the secret the site's dashboard uses for internal auth (unset = off) |
| `SEND_DAILY_LIMIT` | var, default 200 recipients per account per UTC day |
| `MAX_FORWARDS_PER_ACCOUNT_PER_DAY` | optional var; emails forwarded to the project's members (inbox `forward`: one per member per forward or digest) per account per UTC day, default 100, `"0"` = forwarding off. Never counts toward `SEND_DAILY_LIMIT` |
| `UNCLAIMED_<name>` | optional vars; for `SEND_DAILY_LIMIT` and every per-account cap below (`MAX_INBOXES_PER_ACCOUNT`, `MAX_INBOX_CREATES_PER_DAY`, `MAX_INBOX_DELETES_PER_DAY`, `MAX_MESSAGES_PER_INBOX`, `MAX_INBOUND_PER_ACCOUNT_PER_DAY`, `MAX_INBOUND_PER_SENDER_PER_DAY`, `MAX_TEXT_BYTES_PER_ACCOUNT`, `MAX_BLOB_BYTES_PER_ACCOUNT`, `MAX_CONCURRENT_WAITS`, `MAX_CONCURRENT_WAITS_PER_INBOX`, `MAX_WEBHOOKS_PER_ACCOUNT`, `MAX_WEBHOOK_TESTS_PER_DAY`, `MAX_FORWARDS_PER_ACCOUNT_PER_DAY`): the value for accounts no person has claimed (`capFor` in `@afs/shared`). For any cap, `"0"` means none allowed (except `MAX_BLOB_BYTES_PER_ACCOUNT`, where it turns the cap off) and unset means the default (or no cap) |
| `WORKER_NAME` | var; must equal the Worker name (`sg-mail`); auto_configure points catch-alls at it |
| `ENCRYPTION_KEY` | secret; 32-byte base64 (`openssl rand -base64 32`), seals webhook secrets and keys domain ownership challenges. Without it webhook secrets are stored unsealed (`plain:` prefix), and without it and `ADMIN_TOKEN` custom domains are refused. Changing it changes the challenge of domains whose ownership is still pending |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | optional secrets; enable `auto_configure` (operator only). Token: Zone Read, Zone Settings Edit, Email Routing Rules Edit, Email Sending Edit on the zones it may configure |
| `SHARED_SEND_POLICY` | optional var; `reply_only`: shared-domain inboxes may only send to addresses that emailed them with `auth.verdict: "pass"`, not counting list/bulk/auto-generated mail (unset = anyone) |
| `SHARED_RETENTION_DAYS` | optional var; hourly cron deletes shared-domain mail older than this (unset = keep) |
| `MAX_INBOXES_PER_ACCOUNT` | optional var; cap on inboxes per account (unset = none) |
| `MAX_INBOX_CREATES_PER_DAY` | optional var; inbox creations per account per UTC day (unset = no cap) |
| `MAX_INBOX_DELETES_PER_DAY` | optional var; inbox deletions through the API per account per UTC day (unset = no cap) |
| `ADDRESS_TOMBSTONE_DAYS` | optional var; days a deleted shared-domain address that received mail stays reserved for its old account (default 90) |
| `EXTRA_RESERVED_USERNAMES` | optional var; comma-separated usernames nobody may take on the shared domain, on top of the built-in role names |
| `MAX_MESSAGES_PER_INBOX` | optional var; inbound messages an inbox holds; beyond it the oldest mail of the sender holding the most is evicted (unset = no cap) |
| `MAX_INBOUND_PER_ACCOUNT_PER_DAY` | optional var; inbound messages an account may receive per UTC day across its inboxes, more are rejected at SMTP time; one sender gets at most half of it (unset = no cap) |
| `MAX_INBOUND_PER_SENDER_PER_DAY` | optional var; inbound messages one sender key may send one inbox per UTC day, more from it are rejected (unset = no cap) |
| `MAX_TEXT_BYTES_PER_ACCOUNT` | optional var; UTF-8 bytes of stored text and links per account; beyond it new mail keeps a 2 KB excerpt (unset = no budget) |
| `MAX_BLOB_BYTES_PER_ACCOUNT` | var; bytes of mail an account keeps in R2 (raw MIME, HTML bodies, sent attachments); beyond it inbound mail is rejected (`Mailbox full`) and sent mail keeps a text-only copy. Default 1 GiB, 256 MiB for unclaimed accounts (`UNCLAIMED_MAX_BLOB_BYTES_PER_ACCOUNT` overrides that); `"0"` = off |
| `MAX_CONCURRENT_WAITS` | optional var; parked waits per account (default 3) |
| `MAX_CONCURRENT_WAITS_PER_INBOX` | optional var; parked waits per inbox (default 2) |
| `MAX_WEBHOOKS_PER_ACCOUNT` | optional var; webhooks per account (default 10) |
| `MAX_WEBHOOK_TESTS_PER_DAY` | optional var; `POST /webhooks/:id/test` calls per account per UTC day (unset = no cap) |
| `MAX_FEED_EVENTS_PER_DAY` | optional var; events kept in the feed per account per UTC day (default 5000, 1000 unclaimed); webhooks still get the rest |
| `MAX_LIST_ENTRIES_PER_ACCOUNT` | optional var; allow / block list entries per account (default 100) |
| `MAX_INBOX_CLEARS_PER_DAY` | optional var; `DELETE /inboxes/:id/messages` calls per account per UTC day (unset = no cap) |
| `MAX_SCHEDULED_PER_ACCOUNT` | optional var; scheduled sends waiting at once (default 20, 5 unclaimed) |
| `MAX_ATTACHMENT_TEXT_PER_DAY` | optional var; attachment-to-text conversions per account per UTC day (default 20, 5 unclaimed) |
| `DELIVERY_EVENTS_QUEUE` | optional var; name of the queue the Email Sending event subscriptions publish to (consumed by this Worker); set = delivery tracking on (see Delivery status) |
| `UNCLAIMED_<name>` | optional var for every cap above |
| `WEBHOOK_SIGNING_SECRET` | not needed: each webhook gets its own secret, returned once |

Bindings (`wrangler.jsonc`): D1 `DB` (placeholder id), R2 `BLOBS`, Durable Object `INBOX`
(`InboxDO`, SQLite-backed, migration `v1`; waiters are hibernatable WebSockets), Queue `WEBHOOKS`
(producer + consumer, batch 10, 1 s, 8 retries), `send_email` `EMAIL` (unrestricted; the app
enforces senders), rate limits `SIGNUP_LIMITER` (41001), `WAIT_LIMITER` (42021, 30/min per
account), `WEBHOOK_TEST_LIMITER` (42022, 5/min), `SEARCH_LIMITER` (42023, 30/min) (each optional:
without the binding the check is skipped; the D1 caps are the strict limits), hourly cron (purges
expired inboxes, old shared-domain mail, delivery logs, idempotency keys, events and counters,
sweeps orphan blobs, sends scheduled messages an alarm missed and forward digests), observability on. Optional, not in
the template: an `ai` binding named `AI` (attachment text) and a consumer for the Email Sending
events queue (delivery status). `compatibility_date` is 2026-08-22, the newest date the
workerd bundled with `@cloudflare/vitest-plugin` 1.5 supports, so tests run on the same
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

## Delivery status (Email Sending events)

Off until the operator sets it up; without it, sent mail shows `status: "sent"` only and
`GET /v1/messages/:id/delivery` says `tracking: "off"`.

1. A queue this Worker consumes. Either the existing webhooks queue (`<prefix>-mail-webhooks`: no
   new resource and no deploy-tool change, since `queue()` tells events from webhook jobs by shape),
   or a dedicated one (`wrangler queues create <prefix>-mail-email-events`, plus a second consumer
   entry in the deploy config; note `pnpm afs config` currently maps every mail consumer onto the
   webhooks queue, so a dedicated queue needs that tool to learn a second name).
2. An event subscription per sending domain (the shared `MAIL_DOMAIN`, and each custom domain that
   sends): dashboard Queues > the queue > Subscriptions > Subscribe to events > source Email
   Sending > the sending domain > events `message.delivered`, `message.deferred`,
   `message.bounced`, `message.failed`, `message.rejected`, `message.complained` (or
   `wrangler queues subscription create <queue> --source <email sending source> --events ...`).
3. Set `DELIVERY_EVENTS_QUEUE` to that queue's name in the deployment's vars.
4. Check: send to an address you own, then `GET /v1/messages/<id>/delivery?timeout=60` shows
   `delivered` and `events_seen_at`. A custom domain without its own subscription keeps `sent` and
   `events_seen_at: null`.

## Development and tests

```sh
pnpm types && pnpm typecheck
pnpm test                    # unit (Node) + integration (workerd via @cloudflare/vitest-plugin)
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
  header injection; `abuse.test.ts` (with `test/unit/abuse-pure.test.ts`), one group per finding
  of the abuse/cost review: concurrent-wait caps, the wait rate limit and hibernating waits,
  suspended accounts, long sender addresses and filters, blob cleanup on a failed commit, the
  attachment cap and the orphan sweep, per-sender caps and eviction, tombstone expiry and daily
  create/delete caps, strict latest-code, the text budget, delivery-log purge, webhook-test limits,
  scoped search, first-header-only auth trust, reply_only and automated mail, and the REST
  untrusted markers; `hardening.test.ts` (with `test/unit/hardening-pure.test.ts`), one group per
  finding of the pre-public review: every extractor over 300 KB of hostile input (unclosed tags,
  comments, anchors, long runs) in well under a second, the daily quota counted only for stored
  mail and re-checked in the commit (also under concurrency), unauthenticated senders sharing one
  allowance, the stored-bytes budget (SMTP rejection, exact re-check, given back on delete,
  eviction, retention and inbox deletion, `UNCLAIMED_`, `"0"`), attachments stored once and served
  from the raw MIME, text-only copies of sent mail over the budget, webhooks refused (and not
  delivered) to the platform's own hosts or plain http outside `DEV_MODE`, and OAuth access tokens
  refused for webhook creation.
- `test/integration/features*.test.ts` (with `test/unit/features-pure.test.ts`,
  `features-p3-pure.test.ts`), the parity build (docs/parity/mail.md): idempotent sends,
  reply_only exemptions and internal delivery, plus-address tags, reply_text, forward, usage,
  Retry-After, list filters; delivery events (ordering, dedupe, waits, the mixed queue), the event
  feed and its long-poll, allow/block lists at SMTP time, labels / threads / clear / batch,
  send-only domains and zone files, webhook PATCH / rotation / sealed headers / Standard Webhooks
  signatures (spec test vector); scheduled sends, calendar invites, the deliverability report,
  attachment text with a fake AI binding, and llms.txt rendering the configured limits and every
  MCP tool. Reply and ICS parsing are in the hostile-input corpus of `hardening-pure.test.ts`.
- `scripts/smoke.sh`: the full path over HTTP against `wrangler dev`, including a local webhook
  receiver (`scripts/webhook-receiver.mjs`) that verifies signatures; it needs `DEV_MODE=true` in
  `.dev.vars` (see `.dev.vars.example`) for its `http://127.0.0.1` webhook.

## Not yet (v2)

IMAP/SMTP access, templates, inbox-scoped API keys (need an identity-DB change in `@afs/shared`),
inbound spam scoring beyond Email Routing's own checks, creating Email Sending event subscriptions
for custom domains automatically, literal per-address Email Routing rules for custom subdomains
whose zone catch-all must stay elsewhere, HTML sanitising for API consumers (HTML is returned as
received), `latest-code` for word-based login codes ("hungry-robot-lunch"). See
docs/parity/mail.md for the decisions on everything else.
