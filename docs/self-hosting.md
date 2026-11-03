# Self-hosting

Every AgentFirstStack service is a Cloudflare Worker. You can run all of them, or just one, in
your own Cloudflare account on your own domain. The same tool deploys the hosted version at
agentfirststack.com, so this path is exercised on every release.

## What you need

- A Cloudflare account on the **Workers Paid** plan. Queues and Email Sending to arbitrary
  recipients need it; everything else runs on Free.
- A domain whose DNS is on Cloudflare (a zone in that account). The landing page and signup go on
  the apex, the services on `analytics.`, `tags.` and `mail.` subdomains, and inboxes on the apex
  (`anything@yourdomain`) unless you set a separate `mail_domain`.
- Node 22 or newer, pnpm 10 (`corepack enable`), and `wrangler login` done once.

## Deploy in four commands

```sh
git clone https://github.com/StartGlobal-AI/agentfirststack && cd agentfirststack
pnpm install

# 1. Create the D1 databases, R2 bucket and queues; write deploy/mystack.json and its secrets file
pnpm afs init mystack --domain example.com --account <your-account-id>

# 2. Generate configs, apply D1 migrations, deploy the four Workers, set their secrets
pnpm afs deploy mystack

# 3. Mail only: Email Routing catch-all to the mail Worker + Email Sending for the domain
CLOUDFLARE_API_TOKEN=<token> pnpm afs email mystack

# 4. Prove it works end to end (creates and then deletes a test account's resources)
pnpm afs check mystack
```

`init` is safe to re-run: it reuses resources that already exist and keeps the profile's ids.
`<your-account-id>` is shown by `pnpm exec wrangler whoami` (run it inside any app directory).

The token for step 3 needs, on the mail domain's zone: Zone Read, Zone Settings Edit, Email
Routing Rules Edit and Email Sending Edit. Create it in the dashboard under My Profile > API
Tokens. It is only used for that command and isn't stored.

## Decide who may sign up

Signup is one unauthenticated request by design. Pick the mode in your profile under
`vars.all.SIGNUP_MODE`:

| Mode | Who can create an account |
|---|---|
| `open` | Anyone. Turn on the fair-use vars below if the deployment is public |
| `token` | Callers that send the `SIGNUP_TOKEN` secret (add it to your secrets file) |
| `closed` | Only you, with `Authorization: Bearer <ADMIN_TOKEN>` |

For a private deployment (`token` or `closed`), leave the fair-use vars unset.

## Fair-use vars for public deployments

These are what agentfirststack.com uses (see `deploy/hosted.json`). All are off when unset.

| Var | App | Effect |
|---|---|---|
| `SIGNUP_HOURLY_LIMIT` | all | New accounts per network (IPv4 address or IPv6 /64) per hour |
| `MAX_SITES_PER_ACCOUNT` | analytics | Sites per account |
| `MAX_CONTAINERS_PER_ACCOUNT` | tags | Tag containers per account |
| `MAX_INBOXES_PER_ACCOUNT` | mail | Inboxes per account |
| `SHARED_SEND_POLICY=reply_only` | mail | Inboxes on the shared domain may only write to people who wrote to them |
| `SEND_DAILY_LIMIT` | mail | Recipients per account per UTC day |
| `SHARED_RETENTION_DAYS` | mail | Delete shared-domain mail older than this |
| `EXTRA_RESERVED_USERNAMES` | mail | Your brand and role names, on top of the built-in reserved list |
| `MAX_MESSAGES_PER_INBOX` | mail | Messages an inbox may hold; more are rejected at SMTP |
| `MAX_INBOUND_PER_ACCOUNT_PER_DAY` | mail | Inbound messages per account per UTC day |

Some caps are on by default with safe values and only need setting to change them:
`MAX_WEBHOOKS_PER_ACCOUNT` (10), `MAX_DESTINATIONS_PER_CONTAINER` (10),
`MAX_VERSIONS_PER_CONTAINER` (50), `MAX_DRAFT_BYTES` (512 KB), `SQL_MAX_ROWS_READ` (1,000,000).

Each app's README lists its full set of vars under "Config".

## Run only some services

`pnpm afs deploy mystack analytics` deploys one app. Every app binds the shared identity
database (`AUTH_DB`) and migrates it itself, so a single app works on its own: agents sign up at
`https://analytics.example.com/v1/signup`. Add the others later with the same command; existing
keys keep working because they all read the same identity database.

To run an app completely standalone (keys in its own database), delete the `AUTH_DB` binding
from its `wrangler.jsonc` before deploying.

## Update

```sh
git pull && pnpm install
pnpm afs deploy mystack       # applies new migrations first, then deploys
pnpm afs check mystack
```

Migrations are forward-only and additive (see [operations.md](operations.md)), so deploying a
newer version over an older one is safe. Read `CHANGELOG.md` before upgrading across versions.

## Secrets

`deploy/mystack.secrets.json` is created by `init` and is git-ignored. Back it up outside the
repository.

- `ADMIN_TOKEN`: operator access (signup when closed, admin-only mail features).
- `SALT_SECRET` (analytics): derives the daily salt for cookieless visitor ids.
- `ENCRYPTION_KEY` (tags, mail): seals stored third-party credentials and webhook secrets.
  **If you lose it, those stored values can't be decrypted**; users have to re-enter them.

`pnpm afs deploy` sets them on every deploy. To change one, edit the file and deploy again.

## Remove a deployment

```sh
cd analytics && pnpm exec wrangler delete -c wrangler.deploy.json   # repeat per app
```

Then delete the D1 databases, R2 bucket and queues named in your profile (`<prefix>-*`) from the
dashboard or with `wrangler d1 delete`, `wrangler r2 bucket delete` and `wrangler queues delete`.
