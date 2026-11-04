# Operations

How to run and maintain a deployment, including the hosted one at agentfirststack.com (profile
`hosted`). Commands run from the repository root.

## Releasing

1. Merge to `main` with CI green (`pnpm typecheck`, `pnpm test`).
2. Add the release to `CHANGELOG.md` and bump the version in the root `package.json`.
3. `pnpm afs deploy hosted`. This applies D1 migrations, then deploys in dependency order: site
   first (it owns the identity database), then analytics, tags and mail.
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
| `ENCRYPTION_KEY` (analytics, tags, mail) | **Not rotatable in place.** Stored credentials and webhook secrets are sealed with it. Keep it backed up |
| `SIGNUP_TOKEN` | Safe; callers need the new value |
| `INTERNAL_TOKEN` (all apps) | Safe: edit the file and deploy all five apps (`pnpm afs deploy <profile>`). Between the first and last app, the dashboard may show resource lists as unavailable |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (site) | Safe; create a new secret in Google Cloud Console, deploy the site, then delete the old one. Existing sessions keep working |

## Scheduled jobs

- **site**, daily at 03:17 UTC: deletes expired OAuth access tokens (API keys with `expires_at`),
  authorization codes, refresh tokens, sessions and claim links, unusable grants older than a
  month, OAuth clients nobody authorized, and `signup_log` rows older than two days (the shared
  signup counters; signup itself never prunes). Logged as `cron.purge` with counts.
- **mail**, hourly: retention purges (see the mail README).

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
  - Keep DMARC at `p=reject` on the mail domain; it stops others from forging
    `@<mail-domain>` addresses.
- **Cron.** Mail purges expired inboxes and old shared-domain mail hourly; its log line is
  `cron.purge`.

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
- **Retention**: replay chunks also expire through an R2 lifecycle rule (16 days on hosted).

When something gets through, in order of escalation:

1. **Limits.** The fair-use vars (see [self-hosting.md](self-hosting.md) and the table below)
   bound what one account or network can do. Tighten them in the profile and deploy.
2. **Suspend the account.** Every key it has (OAuth tokens included) stops on every service at
   once with `403 account_suspended`, and its public ingest stops within a minute. Its data and
   keys are kept, so it can be undone:
   ```sh
   pnpm afs suspend hosted acct_... --reason "spam inboxes, report #123"
   pnpm afs unsuspend hosted acct_...
   ```
   These call `POST /v1/admin/accounts/:id/suspend` and `/unsuspend` on the site with the
   profile's `ADMIN_TOKEN` (from `deploy/<profile>.secrets.json`); `GET /v1/admin/accounts/:id`
   shows an account's standing, key and member counts. Suspending twice keeps the first reason.
3. **Remove its resources.** Delete its inboxes, sites and containers through the API with a
   temporary key, or with SQL on the app's database.
4. **Close signup** temporarily: set `vars.all.SIGNUP_MODE` to `token` and deploy. For a burst
   from many networks, `SIGNUP_GLOBAL_HOURLY_LIMIT` already pauses new signups deployment-wide
   (`429 signups_paused`, existing keys unaffected) without a deploy.

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
| `SIGNUP_GLOBAL_HOURLY_LIMIT` | off | New accounts on the whole deployment per rolling hour: a circuit breaker |
| `MAX_KEYS_PER_ACCOUNT` | 50 | Active API keys per account (OAuth access tokens don't count) |
| `UNCLAIMED_MAX_KEYS_PER_ACCOUNT` | unset | The same cap for accounts no person has claimed |
| `KEYS_HOURLY_LIMIT` | off | New API keys per account per rolling hour, revoked ones included |

Bindings on the site: `SIGNUP_LIMITER` (5 per minute per network, signup and OAuth registration)
and `KEY_LIMITER` (namespace 42041, 10 key creations per minute per account).

Reports arrive at `abuse@<domain>`. Role addresses (abuse, postmaster, security, admin and others)
can't be claimed by users, so route them to a person: in the dashboard under Email > Email
Routing > Routing rules, add a custom address rule for each one that forwards to your own mailbox.

## Backups and data

| Data | Where | Protection |
|---|---|---|
| Accounts, keys, config | D1 | Time Travel (30 days), `wrangler d1 export` |
| Analytics events | Durable Object SQLite per site | Retained `retention_days`; DOs are replicated by Cloudflare |
| Tags identities, event log | Durable Object SQLite per container | Event log 7 days, visitors 180 days after last seen, by design |
| Raw mail, attachments | R2 | Durable storage; deleted with the message or inbox |

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
