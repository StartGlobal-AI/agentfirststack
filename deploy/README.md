# Deployment profiles

A profile is one deployment of AgentFirstStack: a Cloudflare account, a domain, the ids of the
resources created for it, and the vars that differ from the defaults. `pnpm afs` reads it and
writes a `wrangler.deploy.json` for each app from that app's generic `wrangler.jsonc`.

| File | Committed | What it is |
|---|---|---|
| `<name>.json` | your choice | Your deployment, created by `pnpm afs init <name> ...` |
| `hosted.json` | no (git-ignored) | The official deployment at agentfirststack.com. Its exact budgets and resource ids stay private; the operator keeps it in a private backup |
| `<name>.secrets.json` | **never** (git-ignored) | `INTERNAL_TOKEN` (top level, every app), `ADMIN_TOKEN` (top level; deployed to the site and mail only), `SALT_SECRET`, `ENCRYPTION_KEY`s, optional `site.GOOGLE_CLIENT_ID` / `site.GOOGLE_CLIENT_SECRET`. Back it up somewhere safe |

## Format

```jsonc
{
  "domain": "example.com",          // apex; apps run on analytics., tags., mail.<domain>; the site on the apex
  "account_id": "0123abcd...",      // Cloudflare account (wrangler whoami)
  "prefix": "afs",                  // resource and Worker name prefix: afs-analytics, afs-mail-blobs, ...
  "mail_domain": "example.com",     // optional; inbox domain, defaults to domain (must be a zone apex)
  "shared_inbox_domain": "inbox-example.com",   // optional; where new shared inboxes go (SHARED_INBOX_DOMAIN); mail_domain keeps working
  "user_content_domain": "usercontent-example.com", // optional; share pages: routes <it>/a/* and <it>/r/*, USER_CONTENT_BASE_URL
  "ratelimit_namespace": "41001",   // optional; Workers rate-limit namespace shared by all apps
  "resources": {
    "d1": { "identity": "<uuid>", "analytics": "<uuid>", "tags": "<uuid>", "mail": "<uuid>" }
  },
  "vars": {
    "all":       { "SIGNUP_MODE": "open", "KEY_PREFIX": "afs" },   // every app
    "analytics": { "MAX_SITES_PER_ACCOUNT": "50" },                // one app
    "tags":      {},
    "mail":      {}
  }
}
```

Everything else is derived: Worker names (`<prefix>-<app>`), custom domains, `PUBLIC_BASE_URL`,
`AUTH_ISSUER` (the site, for OAuth), `MAIL_DOMAIN`, `SHARED_INBOX_DOMAIN`, `USER_CONTENT_BASE_URL` (and the
user-content Worker routes), `ANALYTICS_BASE_URL`, R2 bucket and queue names. Vars in the profile override the
template's; the optional ones each app understands are listed in its README under "Config".

See [docs/self-hosting.md](../docs/self-hosting.md) for the full walkthrough.
