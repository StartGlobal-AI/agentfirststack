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

# 2. Generate configs, apply D1 migrations, deploy the five Workers, set their secrets
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

agentfirststack.com sets all of these (its profile is kept private). All are off when unset.

| Var | App | Effect |
|---|---|---|
| `SIGNUP_HOURLY_LIMIT` | all | New accounts per network (IPv4 address or IPv6 /48) per hour |
| `MAX_SITES_PER_ACCOUNT` | analytics | Sites per account |
| `MAX_ANNOTATIONS_PER_SITE` / `MAX_FUNNELS_PER_SITE` | analytics | Chart annotations and saved funnels per site |
| `MAX_ITEMS_PER_EVENT` | analytics | Ecommerce items kept per event (default 25) |
| `MAX_EXPORT_ROWS_PER_SITE_PER_DAY` | analytics | Raw events exported per site per day (default 1000000) |
| `MAX_IMPORTED_ROWS_PER_SITE` / `MAX_IMPORTS_PER_SITE` | analytics | Imported GA4 / Plausible rows (default 500000) and files (default 100) per site |
| `MAX_CRAWL_HITS_PER_SITE_PER_DAY` | analytics | Crawler hits counted per site per day (default 100000) |
| `MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY` / `MAX_CRAWL_HITS_PER_DAY` | analytics | Crawler hits per account and for the whole deployment per day (unset = none) |
| `MAX_BROWSER_USER_PROP_KEYS_PER_SITE` | analytics | User property keys only browsers created (with `browser_user_props`; default 20) |
| `MAX_USER_PROP_KEYS_PER_SITE` | analytics | Distinct user property keys per site (default 50) |
| `MAX_COST_ROWS_PER_SITE` | analytics | Ad spend rows (date x source x campaign) per site (default 50000) |
| `MAX_SEGMENTS_PER_SITE` / `MAX_ALERTS_PER_SITE` / `MAX_ALERT_DESTINATIONS_PER_SITE` / `MAX_REPORTS_PER_SITE` | analytics | Saved segments (default 50), alerts (20), alert destinations (5), scheduled reports (5) per site; each has an `UNCLAIMED_` variant |
| `MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY` / `MAX_ALERT_EMAILS_PER_SITE_PER_DAY` | analytics | Alert, report and test deliveries per site per UTC day (default 100), of which emails (default 10) |
| `MAX_CONTAINERS_PER_ACCOUNT` | tags | Tag containers per account |
| `MAX_INBOXES_PER_ACCOUNT` | mail | Inboxes per account |
| `SHARED_SEND_POLICY=reply_only` | mail | Inboxes on the shared domain may only write to people who wrote to them |
| `SEND_DAILY_LIMIT` | mail | Recipients per account per UTC day |
| `SHARED_RETENTION_DAYS` | mail | Delete shared-domain mail older than this |
| `EXTRA_RESERVED_USERNAMES` | mail | Your brand and role names, on top of the built-in reserved list |
| `MAX_MESSAGES_PER_INBOX` | mail | Messages an inbox may hold; more are rejected at SMTP |
| `MAX_INBOUND_PER_ACCOUNT_PER_DAY` | mail | Inbound messages per account per UTC day |
| `MAX_BLOB_BYTES_PER_ACCOUNT` | mail | Stored mail (raw messages, HTML, attachments) per account; full means inbound is rejected at SMTP (default 1 GiB) |
| `MAX_FEED_EVENTS_PER_DAY` / `MAX_LIST_ENTRIES_PER_ACCOUNT` / `MAX_SCHEDULED_PER_ACCOUNT` / `MAX_INBOX_CLEARS_PER_DAY` / `MAX_ATTACHMENT_TEXT_PER_DAY` | mail | Event-feed rows per account a day (5000), allow/block entries (100), scheduled sends waiting (20), inbox clears a day (off), attachment-to-text conversions a day (20); each has an `UNCLAIMED_` variant |
| `DELIVERY_EVENTS_QUEUE` | mail | Turns on delivery status: the queue your Email Sending event subscriptions publish to (see the mail README, "Delivery status") |
| `MAX_EVENTS_PER_ACCOUNT_PER_DAY` / `MAX_EVENTS_PER_DAY` | tags | Browser hits and backend events per account, and for the whole deployment, per UTC day |
| `PROJECTS_PER_USER_DAILY_LIMIT` | site | New projects one signed-in person may create a day while connecting an app (default 5) |
| `OWN_ANALYTICS_ACCOUNT_ID` / `OWN_ANALYTICS_SITE_ID` | site | Your own project (`acct_...`) and analytics site (`site_...`): each signup and project claim on the apex is sent there as a server event (`signup`, `project_claimed`); off unless both are set |
| `MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY` / `MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY` / `MAX_PLATFORM_HEATMAP_IMAGES_PER_DAY` | replay | Heatmap images rendered with Browser Rendering per UTC day (on by default: 10 / 30 / 300; cached images are free) |
| `MAX_TAGS_EVENTS_PER_SITE_PER_DAY` | replay | Signals and survey scores sent to a linked tags container per site per day (default 500) |

Some caps are on by default with safe values and only need setting to change them:
`MAX_WEBHOOKS_PER_ACCOUNT` (10), `MAX_DESTINATIONS_PER_CONTAINER` (10),
`MAX_VERSIONS_PER_CONTAINER` (50), `MAX_DRAFT_BYTES` (512 KB), `SQL_MAX_ROWS_READ` (1,000,000),
and for tags `MAX_ENVIRONMENTS_PER_CONTAINER` (5), `MAX_LOOKUPS_PER_CONTAINER` (10),
`MAX_LOOKUP_ROWS` (10,000) and `MAX_LOOKUP_BYTES` (1 MB).

Each app's README lists its full set of vars under "Config".

Replay's R2 bucket: if you add a lifecycle rule to expire recording chunks, scope it to the prefix
`rsite_` (live chunks are `rsite_<id>/<session>/<seq>`), so starred sessions' playback copies under
`starred/` stay until replay deletes them itself; a second rule may expire `heatmaps/` (cached
heatmap images, re-rendered after a day) after 2 days. Replay binds Browser Rendering as `BROWSER`
for heatmap images (Workers Free includes 10 browser minutes a day, Workers Paid 10 hours a month
then $0.09 an hour); remove the `browser` block from `replay/wrangler.jsonc` to turn them off.

## Run only some services

`pnpm afs deploy mystack analytics` deploys one app. Every app binds the shared identity
database (`AUTH_DB`) and migrates it itself, so a single app works on its own: agents sign up at
`https://analytics.example.com/v1/signup`. Add the others later with the same command; existing
keys keep working because they all read the same identity database.

To run an app completely standalone (keys in its own database), delete the `AUTH_DB` binding
from its `wrangler.jsonc` before deploying. A standalone app has no OAuth server: its RFC 9728
metadata lists none unless you set `AUTH_ISSUER`.

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
- `INTERNAL_TOKEN` (top level, set on all five Workers): lets the site's dashboard read a
  project's sites, containers and inboxes from the services over service bindings. `init`
  generates it (and adds it to an older secrets file when you re-run it). Without it the dashboard
  shows those lists as unavailable; nothing else changes.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (site, optional): turn on "Sign in with Google" for
  claim links, the dashboard and OAuth connectors. Put them under `"site"` (or at the top level;
  they only go to the site). See [Sign-in for people](#sign-in-for-people-optional).
- `SALT_SECRET` (analytics): derives the daily salt for cookieless visitor ids.
- `ENCRYPTION_KEY` (analytics, tags, mail, replay): seals stored third-party credentials and webhook
  secrets (analytics: the Stripe webhook signing secret and alert destinations' webhook / Slack
  URLs and signing secrets; without it, connecting Stripe or adding a webhook or Slack
  destination answers 503 and the payments API still works; replay: webhook signing secrets,
  without it creating a replay webhook answers 503 `webhooks_unavailable`). `pnpm afs init` adds a missing one to an older secrets file
  for analytics, tags and mail; for replay add `"replay": {"ENCRYPTION_KEY": "<32 random bytes, base64>"}` to the secrets file
  yourself (`openssl rand -base64 32`).
  **If you lose it, those stored values can't be decrypted**; users have to re-enter them.

`pnpm afs deploy` sets them on every deploy. To change one, edit the file and deploy again.

Analytics alert and report emails (optional): the analytics template carries a `send_email`
binding (`EMAIL`); email destinations also need the var `ALERT_EMAIL_FROM` (under `vars.analytics`
in the profile), an address on a domain onboarded for Cloudflare Email Sending. They only ever go
to the project's members. Without the var, email destinations are refused and webhook and Slack
destinations still work. The analytics template also has a cron (`*/5 * * * *`) for alerts and
reports.

## Sign-in for people (optional)

Agents never need it. To let people claim projects, use the dashboard and connect Claude or
ChatGPT over OAuth ([accounts.md](accounts.md)):

1. Google Cloud Console > APIs & Services > OAuth consent screen: External, your app name, home
   page `https://example.com`, privacy policy `https://example.com/privacy`, terms
   `https://example.com/terms`, scopes `openid`, `email`, `profile` (no verification needed for
   these).
2. Credentials > Create OAuth client ID > Web application, with the authorised redirect URI
   `https://example.com/auth/google/callback`.
3. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` under `"site"` in your secrets file and
   `pnpm afs deploy mystack`.

`pnpm afs config` sets `AUTH_ISSUER=https://<domain>` on every app, so each service's RFC 9728
metadata names the site as the OAuth authorization server. The site's daily cron (03:17 UTC)
deletes expired OAuth tokens, codes, sessions and claim links. The privacy and terms pages in
`site/public/` describe the hosted service; edit them for your deployment.

## Remove a deployment

```sh
cd analytics && pnpm exec wrangler delete -c wrangler.deploy.json   # repeat per app
```

Then delete the D1 databases, R2 bucket and queues named in your profile (`<prefix>-*`) from the
dashboard or with `wrangler d1 delete`, `wrangler r2 bucket delete` and `wrangler queues delete`.
