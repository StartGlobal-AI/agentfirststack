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
  month and OAuth clients nobody authorized. Logged as `cron.purge` with counts.
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

Free, instant signup attracts abuse. In order of escalation:

1. **Limits.** The fair-use vars (see [self-hosting.md](self-hosting.md)) bound what one account
   or network can do. Tighten them in the profile and deploy.
2. **Revoke an account's keys.** This immediately blocks it on every service:
   ```sh
   cd site && pnpm exec wrangler d1 execute DB --remote -c wrangler.deploy.json \
     --command "UPDATE api_keys SET revoked_at = unixepoch() * 1000 WHERE account_id = 'acct_...'"
   ```
3. **Remove its resources.** Delete its inboxes, sites and containers through the API with a
   temporary key, or with SQL on the app's database.
4. **Close signup** temporarily: set `vars.all.SIGNUP_MODE` to `token` and deploy.

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
  The integration-test runtime bundled with `@cloudflare/vitest-pool-workers` caps how far it can
  go.

## Incident checklist

1. Run `pnpm afs check <profile>` to see which service is failing.
2. `wrangler tail` that service and reproduce the request.
3. If a deploy caused it, roll back (`wrangler rollback`) first, then fix forward.
4. If data is wrong, export it, then restore with D1 Time Travel to just before the incident.
5. Write a short note in `CHANGELOG.md` under the fix release.
