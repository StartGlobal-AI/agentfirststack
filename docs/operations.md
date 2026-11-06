# Operations

How to run and maintain a deployment, including the hosted one at agentfirststack.com (profile
`hosted`). Commands run from the repository root.

## Releasing

1. Merge to `main` with CI green (`pnpm typecheck`, `pnpm test`).
2. Add the release to `CHANGELOG.md` and bump the version in the root `package.json`.
3. `pnpm afs deploy hosted`. This applies D1 migrations, then deploys in dependency order: site
   first (it owns the identity database), then analytics, tags, mail and replay.
4. `pnpm afs check hosted`. The live check signs up, uses the key on every service, lists the MCP
   tools and deletes everything it created. Don't call a release done until this passes.
5. Tag the commit: `git tag v0.x.y && git push --tags`.

To deploy one service: `pnpm afs deploy hosted mail`.

### Rolling back

`pnpm exec wrangler rollback -c wrangler.deploy.json` inside an app directory reverts to the
previous Worker version. Migrations are not rolled back, which is why every migration must stay
compatible with the previous release's code.

## Database migrations

- Forward-only, numbered files in `<app>/migrations/`, plus `site/migrations/` for the identity
  database.
- Additive within a release: add tables, columns and indexes. To remove or rename, stop using the
  old thing in one release and drop it in a later one.
- D1 Time Travel restores any database to a point in the last 30 days:
  `pnpm exec wrangler d1 time-travel restore <database> --timestamp <unix-seconds>`. Export a copy
  first with `wrangler d1 export`.

## Secrets

They live in `deploy/<profile>.secrets.json` (git-ignored); `pnpm afs deploy` sets them on every
deploy.

| Secret | Rotating it |
|---|---|
| `ADMIN_TOKEN` | Safe any time: edit the file and deploy |
| `SALT_SECRET` (analytics) | Safe; visitor ids for the current day are split once, nothing else changes |
| `ENCRYPTION_KEY` (analytics, tags, mail, replay) | **Not rotatable in place.** Stored credentials and webhook secrets are sealed with it (analytics: Stripe signing secrets and restricted keys, Polar / Paddle / LemonSqueezy signing secrets, alert destination URLs and signing secrets). Keep it backed up |
| `SIGNUP_TOKEN` | Safe; callers need the new value |
| `INTERNAL_TOKEN` (all apps) | Safe: edit the file and deploy all five apps (`pnpm afs deploy <profile>`). Between the first and last app, the dashboard may show resource lists as unavailable |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (site) | Safe; create a new secret in Google Cloud Console, deploy the site, then delete the old one. Existing sessions keep working |

## Scheduled jobs

- **site**, daily at 03:17 UTC: deletes expired OAuth access tokens (API keys with `expires_at`),
  authorization codes, refresh tokens, sessions and claim links, unusable grants older than a
  month, OAuth clients nobody authorized, and `signup_log` rows older than two days (the shared
  signup counters; signup itself never prunes). Logged as `cron.purge` with counts. It also
  prunes emails older than 30 days (`cron.email_prune`), writes setup notices (`cron.notices`),
  queues setup reminders (`cron.setup_reminders`), looks for analytics sites that went quiet
  (`cron.quiet_sites`), forgets limit warnings older than a month (`cron.limit_warnings_prune`)
  and abuse reports older than 180 days (`cron.abuse_reports_prune`), sends the operator's daily
  summary (`cron.operator_digest`) and erases deleted projects past their 7 days
  (`cron.project_purge`).
- **site**, hourly at :47: the reminders the day before a deleted project is erased, the usage of
  every claimed project (warnings for caps close to their limit), the emails for capability pauses
  a service wrote directly (`pauses`), then sends queued and retried emails (`cron.email`, with
  `limits: {checked, warned}`).
- **analytics**, every 5 minutes: alerts, reports, Stripe backfills and exchange rates.
- **mail**, hourly at :17: retention purges and forwarding digests (see the mail README).
- **replay**, hourly at :23: retention and R2 cleanup (see the replay README).

## Watching it

- **Logs.** Every Worker has observability on. Tail one live with
  `cd mail && pnpm exec wrangler tail -c wrangler.deploy.json`, or use Workers > Observability in
  the dashboard.
- **Queues.** Failed deliveries end up in `<prefix>-tags-dispatch-dlq` and
  `<prefix>-mail-webhooks-dlq`. Look at their depth in the dashboard; a growing DLQ means a
  destination is down or misconfigured. Agents see the same failures in the tags event log and the
  mail webhook delivery list.
- **Email.**
  - Check sending reputation, bounces and complaints under Email Service in the dashboard, or with
    `GET /accounts/<id>/email/sending/reputation`.
  - Keep DMARC at `p=reject` on the mail domain (and on the shared inbox domain, once mail flows);
    it stops others from forging `@<mail-domain>` addresses.
  - A shared domain that isn't in `SHARED_SENDING_DOMAINS` sends nothing to outside addresses
    (`503 domain_not_onboarded`); forwards to members from its inboxes wait in the queue (up to 30
    days) and log `forward.cannot_send`. Seeing that log line means a domain needs onboarding.
  - Delivery status (per-recipient delivered / bounced / complained, `GET /v1/messages/:id/delivery`)
    needs an Email Sending event subscription per sending domain publishing to a queue the mail
    Worker consumes, and the mail var `DELIVERY_EVENTS_QUEUE`; see the mail README, "Delivery
    status". `events_seen_at` in that response shows whether events arrive for a domain.
- **Cron.** Mail purges expired inboxes and old shared-domain mail hourly, and also expired
  idempotency keys, event-feed rows older than 7 days, and sends scheduled messages whose inbox
  alarm did not fire; its log line is `cron.purge`. Scheduled sends log `mail.scheduled` from the
  inbox's Durable Object.

## Own domains for shared inboxes and share pages

Shared inboxes and share pages carry other people's content, so the hosted platform gives them
domains of their own: `agentfirstinbox.com` for new inboxes, `afsusercontent.com` for share pages.
Both are zones in the same account as `agentfirststack.com`. In order:

1. **Inbox domain, receiving.** Add `"shared_inbox_domain": "agentfirstinbox.com"` to the profile.
   `CLOUDFLARE_API_TOKEN=<token with Zone Read, Zone Settings Edit, Email Routing Rules Edit, Email
   Sending Edit on both zones> pnpm afs email hosted`: Email Routing on for the new zone (MX
   `route1/2/3.mx.cloudflare.net`, SPF, DKIM `cf2024-1._domainkey`, added and locked by
   Cloudflare), catch-all -> `afs-mail`, Email Sending onboarded (MX and SPF on
   `cf-bounce.agentfirstinbox.com`, DKIM `cf-bounce._domainkey`). Add DMARC:
   `_dmarc.agentfirstinbox.com TXT "v=DMARC1; p=none; rua=mailto:<you>"`, tightened to `p=reject`
   once mail flows.
2. **Deploy mail** (`pnpm afs deploy hosted mail`). New inboxes go on agentfirstinbox.com and
   receive at once; old ones on agentfirststack.com keep working. Their outside mail answers
   `503 domain_not_onboarded` until step 3.
3. **Inbox domain, sending.** When `wrangler email sending dns get agentfirstinbox.com` shows the
   records verified: `vars.mail.SHARED_SENDING_DOMAINS = "agentfirststack.com,agentfirstinbox.com"`,
   deploy mail again. With delivery status on, subscribe the domain's Email Sending events to
   `afs-mail-webhooks` (mail README, "Delivery status").
4. **User-content domain.** On `afsusercontent.com`: `AAAA @ 100::` proxied, Always Use HTTPS on.
   Add `"user_content_domain": "afsusercontent.com"` to the profile and
   `pnpm afs deploy hosted analytics replay site`: the Worker routes `afsusercontent.com/a/*`
   (analytics), `afsusercontent.com/r/*` (replay) and `afsusercontent.com/*` (the site: the root
   page saying what the domain is, robots.txt, 404 for the rest) and their `USER_CONTENT_BASE_URL`
   come from it. Keep the
   routes in the profile, not the dashboard (`wrangler deploy` replaces a Worker's routes).
5. **Reputation.** `vars.site.REPUTATION_DOMAINS = "agentfirstinbox.com,afsusercontent.com"` and
   deploy the site, so the daily summary checks them too.
6. `pnpm afs check hosted`: new inboxes on the new domain, both user-content paths reach their
   Worker, the root page answers, no API there.

Once inboxes exist on agentfirstinbox.com, keep `shared_inbox_domain` set: the mail Worker treats
only `MAIL_DOMAIN` and `SHARED_INBOX_DOMAIN` as shared, so inboxes on a domain taken out of both stop
receiving and sending. Taking `user_content_domain` out moves new share links back to the service
hosts; links handed out on afsusercontent.com stop working once its routes are gone.

## Abuse handling

Free, instant signup attracts abuse. What bounds it, outermost first:

- **Cloudflare edge rules** on the zone (dashboard, Security rules; not in this repo): a per-IP
  rate-limit rule on POST requests, and custom rules block
  replay uploads (`/i`) without a browser `Origin` and verified crawlers on `/e`, `/collect` and
  `/i`. Budget and usage notifications (Alerts) email the operator; they never cap spend.
- **Workers rate-limit bindings** in each app (namespaces 42001-42049) before any storage access.
- **Daily budgets** per site or container, per account and per deployment (analytics events, tags
  deliveries and events, replay sessions, chunks, bytes and derived rows, mail inbound per sender).
  Counters never go down, so deleting and re-creating things frees nothing; past a budget the
  service answers 429 (or skips the delivery with a logged reason).
- **Unclaimed accounts** (no person has claimed them) get the lower `UNCLAIMED_<NAME>` value of
  any cap or budget; custom tag code and replay beyond its trial need a claimed account and a
  verified domain.
- **Retention**: replay chunks also expire through an R2 lifecycle rule (16 days on hosted). Scope
  that rule to the prefix `rsite_` (every live chunk key is `rsite_<id>/<session>/<seq>`), not the
  whole bucket: starred sessions (kept up to `MAX_STARRED_RETENTION_DAYS`) get a playback copy under
  `starred/<site_id>/`, which the DO deletes itself when the session is unstarred, deleted or past
  starred retention. Cached heatmap images live under `heatmaps/<site_id>/` (a second rule deleting
  them after 2 days is a backstop; the service treats a copy older than a day as missing).
- **Replay surveys and webhooks**: survey posts (`/f`) share the ingest rate limits and have their own
  daily caps per site, network and test (`MAX_RESPONSES_*`, `MAX_IMPRESSIONS_PER_NETWORK_PER_SITE_PER_DAY`);
  a response counts against the account's daily derived and byte budgets. Webhooks are capped per account
  (`MAX_WEBHOOKS_PER_ACCOUNT`, `MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY`, `MAX_WEBHOOK_TESTS_PER_DAY`),
  only verified sites emit events, and delivery logs (`webhook_deliveries`) are purged after 7 days by the
  hourly cron. A stuck webhook shows in `GET /v1/webhooks/:id` (`status`, `error`).

The policy behind all of it is public: `/acceptable-use` (site/public/acceptable-use.html), linked
from the terms, every footer, llms.txt and the setup prompts. The rule: **strong signals pause one
capability automatically; suspending a whole account is always a person's decision.**

When something gets through, in order of escalation:

1. **Limits.** The fair-use vars (see [self-hosting.md](self-hosting.md) and the table below)
   bound what one account or network can do. Tighten them in the profile and deploy.
2. **Capability pauses** (automatic, or by hand). One capability of one account stops while
   everything else keeps working: `mail.send`, `mail.inbox_create`, `tags.custom_code`,
   `replay.share_links`, `analytics.share_links`. The services pause on strong signals (mail: the
   last hour's bounce or complaint rate past its threshold, an inbox-creation burst; tags: custom
   code matching known-malicious patterns at publish) by calling the site's
   `POST https://site.internal/v1/internal/pauses` over a service binding with `x-afs-internal`
   (`requestCapabilityPause()` in `@afs/shared`; without a `SITE` binding it writes the row itself
   and the hourly cron sends the emails). The row lives in `capability_pauses` (identity DB); every
   service reads it with `capabilityPaused()`, cached a minute per isolate, and answers
   `403 capability_paused` with the reason. The project's people (account email, always sent) and
   `OPERATOR_EMAIL` are emailed at once. Review each one:
   ```sh
   curl -s https://<domain>/v1/admin/pauses -H "authorization: Bearer $ADMIN_TOKEN"   # in force now
   pnpm afs unpause hosted acct_... mail.send            # a false positive: lift it (people are told)
   pnpm afs pause hosted acct_... replay.share_links --reason "phishing page, report abr_..."
   ```
   After a lift, automatic re-pauses of that capability are ignored for `PAUSE_LIFT_GRACE_HOURS`
   (default 24), so the same hour of data doesn't pause it again; the operator's own pauses always
   apply. `GET /v1/admin/accounts/:id` lists an account's pauses, lifted ones included. If the
   pause shows clear abuse, go on to step 3.
3. **Suspend the account.** Every key it has (OAuth tokens included) stops on every service at
   once with `403 account_suspended`, and its public ingest stops within a minute. Its data and
   keys are kept, so it can be undone:
   ```sh
   pnpm afs suspend hosted acct_... --reason "spam inboxes, report #123"
   pnpm afs unsuspend hosted acct_...
   ```
   These call `POST /v1/admin/accounts/:id/suspend` and `/unsuspend` on the site with the
   profile's `ADMIN_TOKEN` (from `deploy/<profile>.secrets.json`); `GET /v1/admin/accounts/:id`
   shows an account's standing, key and member counts. Suspending twice keeps the first reason.
4. **Remove its resources.** Delete its inboxes, sites and containers through the API with a
   temporary key, or with SQL on the app's database.

5. **Close signup** temporarily: set `vars.all.SIGNUP_MODE` to `token` and deploy. For a burst
   from many networks, `SIGNUP_GLOBAL_HOURLY_LIMIT` already slows new signups deployment-wide
   without a deploy: past it, `POST /v1/signup` answers `429 proof_of_work_required` with a signed
   `challenge` and a `difficulty` (20 bits by default, `SIGNUP_POW_DIFFICULTY`; one more bit each
   time the hour's count doubles past the limit, at most 4 more). A signup carrying a solution goes
   through (per-network limits still apply; one signup per challenge, valid 10 minutes). An agent
   solves it in about a second; a bulk script pays that per account. Challenges are signed with
   `INTERNAL_TOKEN` (else `ADMIN_TOKEN`), so any app's challenge works on every app; with neither,
   it's the old `429 signups_paused`. People creating projects in the dashboard (OAuth consent) are
   counted but never held by the breaker: they have `PROJECTS_PER_USER_DAILY_LIMIT`.

### Abuse reports

Anyone can report abuse without an account: the form at `/report-abuse` (share pages link to it
with `?url=`), `POST /v1/abuse-reports {url_or_resource, kind, details, contact?}` (kind:
phishing, spam, malware, impersonation, other) or MCP `afs_report_abuse`. Reports are stored in
`abuse_reports` (identity DB, kept 180 days, the reporter's network only as a hash); the same report
from the same network within a day is the same report. Phishing and malware are emailed to
`OPERATOR_EMAIL` at once (at most `ABUSE_REPORT_EMAILS_PER_DAY`, default 20; the rest wait for the
summary), and every report is in the daily summary. Limits: `ABUSE_REPORTS_HOURLY_LIMIT` per
network (default 5) and `ABUSE_REPORTS_DAILY_LIMIT` for the deployment (default 500). Work through
them:

```sh
curl -s "https://<domain>/v1/admin/abuse-reports?status=new" -H "authorization: Bearer $ADMIN_TOKEN"
# find the project behind the URL (a site_, ctr_, rsite_, inbox address or share token), then pause
# or suspend, and close the report:
curl -s -X PATCH https://<domain>/v1/admin/abuse-reports/abr_... -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"status":"reviewed","note":"paused replay.share_links"}'
```

Report text is from the public: read it, don't paste it into an agent as instructions.

### Reputation checks

The daily summary checks the deployment's own name (src/reputation.ts): Google Safe Browsing for
the apex and its service hosts (secret `SAFE_BROWSING_API_KEY` on the site; skipped without it),
the Spamhaus DBL for the apex through DNS over HTTPS (Spamhaus refuses public resolvers, so set
`SPAMHAUS_DQS_KEY`, a free Data Query Service key, or the line reads "unknown"), and the mail
service's delivery health for the last day (mail's `GET /v1/admin/delivery-health`, read over the
binding as the deployment's own project, `OWN_ANALYTICS_ACCOUNT_ID`, else the oldest account; a
bounce rate past 5% or complaints past 0.3% with at least 20 sends is a warning, and the worst
accounts are named). `REPUTATION_DOMAINS` (comma-separated) adds domains the deployment uses,
such as a user-content or shared-inbox domain. A listing or a warning puts "Needs a look" in the
subject. If the apex is listed: find the cause in the abuse reports and pauses, fix it, then use
the list's removal form (Safe Browsing: Search Console, Security issues; Spamhaus: its lookup page).

### Signup and key limits

All in the identity database, so one count is shared by every app (`accountRoutes()` runs in all
of them). Signup counts insert first, then count, so racing requests can't overrun a limit, and a
refused attempt takes its rows back out (a blocked network hammering can't trip the global
breaker). Set them under `vars.all` so every app's `/v1/signup` and `/v1/keys` applies them.

| Var | Default | Effect |
|---|---|---|
| `SIGNUP_HOURLY_LIMIT` | off | New accounts per network per rolling hour. A network is an IPv4 address or an IPv6 /48 (free tunnel brokers hand out whole /48s) |
| `SIGNUP_DAILY_LIMIT` | off | New accounts per network per rolling day |
| `SIGNUP_ASN_DAILY_LIMIT` | off | New accounts per network operator (`request.cf.asn`) per rolling day; skipped when Cloudflare gives no ASN |
| `SIGNUP_GLOBAL_HOURLY_LIMIT` | off | New accounts on the whole deployment per rolling hour: a circuit breaker; past it a signup needs a proof of work |
| `SIGNUP_POW_DIFFICULTY` | 20 | The proof of work's base difficulty in leading zero bits of SHA-256 (about a second; each bit doubles it) |
| `MAX_KEYS_PER_ACCOUNT` | 50 | Active API keys per account (OAuth access tokens don't count) |
| `UNCLAIMED_MAX_KEYS_PER_ACCOUNT` | unset | The same cap for accounts no person has claimed |
| `KEYS_HOURLY_LIMIT` | off | New API keys per account per rolling hour, revoked ones included |

Bindings on the site: `SIGNUP_LIMITER` (5 per minute per network, signup and OAuth registration)
`KEY_LIMITER` (namespace 42041, 10 key creations per minute per account) and `SETUP_LIMITER`
(namespace 42042, 30 setup checks per minute per project; each reads the services about 15 times)
and `SETUP_TEST_LIMITER` (namespace 42043, 3 setup test runs per minute per project).

Every app also has `READ_LIMITER` (namespaces 42008 analytics, 42018 tags, 42024 mail, 42034
replay, 42044 site; 300 per minute per account): GET and HEAD requests with an API key or OAuth
token, and every MCP request, counted in `requireAuth()` and `handleMcp()` of `@afs/shared`.
Writes and ingest keep their own limits; the dashboard's internal calls are not counted here. The
dashboard's data route and live stream have `DASHBOARD_LIMITER` instead (namespace 42045, 600 per
minute per signed-in person; a page load makes 20-40 reads). Both fail open if the binding errors.

Reports also arrive at `abuse@<domain>`, and appeals of pauses and suspensions at
`support@<domain>` (the emails and the `capability_paused` hint name it). Role addresses (abuse,
support, postmaster, security, admin and others) can't be claimed by users, so route them to a
person: in the dashboard under Email > Email Routing > Routing rules, add a custom address rule
for each one that forwards to your own mailbox.

## Emails to people

The site's hourly cron logs `cron.email` (`reminders`, `sent`, `failed`,
`left`), and each failed send `email.failed` with its error. The `email_outbox` table in the
identity DB shows every email of the last 30 days and its status:
```sh
wrangler d1 execute afs-identity --remote -c site/wrangler.deploy.json --command \
  "SELECT kind, status, attempts, error, created_at FROM email_outbox ORDER BY created_at DESC LIMIT 20"
```

To check sending end to end (sender, binding, SPF, DKIM, DMARC, and whether it lands in the
inbox), send yourself the welcome email: `pnpm afs email-test hosted you@example.com` (you must
have signed in once).

Emails come from `notifications@` (`NOTIFY_EMAIL_FROM`; the username is reserved in mail) with
Reply-To `support@` (`NOTIFY_REPLY_TO`), which an Email Routing rule forwards to the operator, like
`security@`, `abuse@`, `privacy@` and `conduct@`. The apex has SPF, DKIM (`cf-bounce`) and DMARC
`p=reject`; DMARC aggregate reports go to Cloudflare DMARC Management (zone, Email, DMARC
Management), which shows who sends as the domain and their pass rate.

**Operator summary** (`site/src/operator-digest.ts`): every day the site's daily cron emails
`OPERATOR_EMAIL` (site var, comma-separated; off when unset) the last 24 hours: new, claimed,
deleted, erased and suspended projects, new people, signup attempts and networks, the limit
warnings and suspicious-traffic episodes emailed to projects, emails sent and failed (with the top
failures), whether each service answers, the day's capability pauses and abuse reports, and the
reputation checks (see "Reputation checks" above). It is never held back by
`MAX_EMAILS_PER_PERSON_PER_DAY`. The subject starts "Needs a look:" when a service is down, there
was an attack, an email failed, an account was suspended, a capability was paused, a phishing or
malware report came in, or a reputation check found a listing or a warning. `pnpm afs digest <profile>`
sends one now and prints it (admin route `POST /v1/admin/digest`). Worker errors aren't in it: see
each Worker's Observability tab.

**Zone security rules** run before the Workers and live in the Cloudflare dashboard (Security,
Security rules): a per-IP rate limit on POST requests, a block on replay `/i` without a browser
Origin, and a block on verified crawlers on `/e`, `/collect` and `/i`. Their exact definitions
are recorded in the profile (`zone_rules` in `deploy/<profile>.json`, private like the budgets).
`pnpm afs zone-rules <profile>` compares the live rules with them and exits 1 on any difference;
`--save` records the live ones after a deliberate change. With `zone_id` in the profile the token
needs only Zone WAF Read (otherwise also Zone Read, to find the zone by name). `pnpm afs check` runs the same
comparison when `CLOUDFLARE_WAF_TOKEN` is set: an API token with Zone > WAF > Read on the zone
(read-only; neither command changes the zone).

Alerts (`site/src/project-health.ts`) go to claimed projects' owners and members, who can turn them
off. `limit_warning`: a cap that drops data (incoming events, mail or sessions) is at 80% of its
limit or reached, at most once a week per cap and level. `site_quiet`: an analytics site that had
steady page views has had none for two whole days. `site_attack`: an analytics site or tags
container's attack protection started (or escalated), from the `attacks` in the services' usage
answers; once per episode, recorded in `limit_warnings` as `<service>.attack:<id>:<since>`. The warnings name the caps a project is close to,
and the people can reply to `support@` if a project needs more, so these emails are also where
requests for higher limits come from. To see what a project is close to:
`curl -H "Authorization: Bearer $KEY" https://agentfirststack.com/v1/usage` with one of its keys, or
query `limit_warnings` in the identity DB for what was sent.

## Deleted projects

Owners delete projects in the dashboard, and an unclaimed project's agent
can with `DELETE /v1/me` (see [accounts.md](accounts.md#6-privacy-and-deletion)). A deleted
project stops at once. The site's daily cron (03:17 UTC) erases it 7 days later in every service
(`cron.project_purge` in the site's logs lists `purged` and `pending` ids). A project stays
pending while a service fails, and is retried the next day. To undo a deletion before the purge,
for example when someone writes to privacy@ because an agent deleted their unclaimed project:
```sh
pnpm afs restore hosted acct_...
```

## Backups and data

| Data | Where | Protection |
|---|---|---|
| Accounts, keys, config | D1 | Time Travel (30 days), `wrangler d1 export` |
| Analytics events | Durable Object SQLite per site | Retained `retention_days`; DOs are replicated by Cloudflare |
| Analytics subscriptions, costs, items, user properties, crawler hits, imports | The same per-site Durable Object | Subscriptions, costs and imports are kept until deleted; items go with their events; crawler hits follow `retention_days` |
| Analytics exchange rates | D1 `fx_rates` (ECB, one row per day and currency) | Refetchable at any time; the cron fills gaps from the ECB's 90-day file |
| Tags identities, event log | Durable Object SQLite per container | Event log 7 days, visitors 180 days after last seen, by design |
| Raw mail, attachments | R2 | Durable storage; deleted with the message or inbox |
| Replay recordings | R2 chunks, Durable Object per site | Retention per site (14 days hosted), R2 lifecycle backstop |
| Emails to people | D1 `email_outbox` | 30 days, deleted with the person's account |
| Alert state | D1 `project_health`, `limit_warnings` | Warnings kept 30 days; both erased with the project |
| Quarantine | analytics events `debug = 2`; tags event log `status: quarantined` | 7 days (with the test traffic purge), then deleted; never in reports |
| Consent records | tags ContainerDO `consent_records`, `consent_daily` | 12 months; consent id, time, banner version, choices, country (no IP, user agent or visitor id) |

## Dependencies and runtime

- Dependabot opens weekly update PRs. CI has to pass before merge.
- Raise `compatibility_date` in a `wrangler.jsonc` deliberately: read the Workers changelog first.
  The integration-test runtime bundled with `@cloudflare/vitest-plugin` caps how far it can
  go.

## Releases that sign people out

The session cookie became `__Host-afs_session` (it was `afs_session`): the first deploy with it
signs every person out once. Nothing changes for agents or API keys.

## Incident checklist

1. Run `pnpm afs check <profile>` to see which service is failing.
2. `wrangler tail` that service and reproduce the request.
3. If a deploy caused it, roll back (`wrangler rollback`) first, then fix forward.
4. If data is wrong, export it, then restore with D1 Time Travel to just before the incident.
5. Write a short note in `CHANGELOG.md` under the fix release.
