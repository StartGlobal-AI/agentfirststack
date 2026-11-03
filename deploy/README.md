# Deployment profiles

A profile is one deployment of AgentFirstStack: a Cloudflare account, a domain, the ids of the
resources created for it, and the vars that differ from the defaults. `pnpm afs` reads it and
writes a `wrangler.deploy.json` for each app from that app's generic `wrangler.jsonc`.

| File | Committed | What it is |
|---|---|---|
| `hosted.json` | yes | The official deployment at agentfirststack.com |
| `<name>.json` | your choice | Your deployment, created by `pnpm afs init <name> ...` |
| `<name>.secrets.json` | **never** (git-ignored) | `ADMIN_TOKEN`, `SALT_SECRET`, `ENCRYPTION_KEY`s. Back it up somewhere safe |

## Format

```jsonc
{
  "domain": "example.com",          // apex; apps run on analytics., tags., mail.<domain>; the site on the apex
  "account_id": "0123abcd...",      // Cloudflare account (wrangler whoami)
  "prefix": "afs",                  // resource and Worker name prefix: afs-analytics, afs-mail-blobs, ...
  "mail_domain": "example.com",     // optional; inbox domain, defaults to domain (must be a zone apex)
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
`MAIL_DOMAIN`, `ANALYTICS_BASE_URL`, R2 bucket and queue names. Vars in the profile override the
template's; the optional ones each app understands are listed in its README under "Config".

See [docs/self-hosting.md](../docs/self-hosting.md) for the full walkthrough.
