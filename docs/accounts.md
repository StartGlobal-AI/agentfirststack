# Accounts: agents first, humans optional

Agents still get a working API key with one unauthenticated request. Humans can, whenever they
want, sign in with Google to **claim** what their agents created, see it in one dashboard, manage
keys, invite teammates, and connect chat apps (claude.ai, ChatGPT) over OAuth.

Nothing here changes anything for an agent that never involves a person: `/v1/signup`, `afs_`
keys, every service API and every MCP server behave as before.

## Model

```
user (Google identity)  ──<  membership (owner | member)  >──  account = a "project"
                                                                  ├─ api keys (agents, CI, OAuth tokens)
                                                                  ├─ sites       (analytics)
                                                                  ├─ containers  (tags)
                                                                  └─ inboxes     (mail)
```

- An **account** (shown to people as a *project*) is what an API key belongs to. Unchanged.
- A **user** is a person who signed in with Google. A user can belong to many projects (at most
  100); a project can have many users. The first user to claim a project is its owner.
- Anyone holding a project's full-access key already controls it, so a key holder may create
  claim links (that is how the owner gets in).

All of this lives in the shared identity database (`AUTH_DB`, migrations in `site/migrations`),
next to `accounts` and `api_keys`, served by the site Worker at the apex. Code: `site/src/`
(`google.ts`, `session.ts`, `claims.ts`, `dashboard.ts`, `oauth.ts`, `identity.ts`,
`services.ts`, `cleanup.ts`).

## Flows

### 1. Google sign-in (`/signin`, `/auth/google`, `/auth/google/callback`)

Standard OpenID Connect authorization code flow with PKCE (S256), `state` and `nonce`.

- `/signin?next=` shows "Sign in with Google" (Google's light rectangular button: official "G",
  self-hosted Google Sans Medium). A signed-out claim page shows the same button, starting
  `/auth/google?next=/claim/<token>`. Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
  it says sign-in isn't configured on this deployment.
- `/auth/google` keeps `state`, `nonce`, the PKCE verifier and `next` in a 10-minute cookie
  (`afs_google`, HttpOnly, Path=/auth/google) and redirects to Google with
  `prompt=select_account`.
- The callback checks `state` (constant-time), exchanges the code server-to-server with the
  client secret and the verifier, and reads the ID token from that direct TLS response. It checks
  `iss`, `aud` (and `azp` with several audiences), `exp`, `iat`, `nonce`, `sub` and
  `email_verified`; no JWKS fetch is needed (OIDC Core 3.1.3.7).
- It upserts the user by Google `sub` and starts a session.

Scopes are `openid email profile` only. Sessions are an opaque random cookie (`afs_session`,
HttpOnly, Secure, SameSite=Lax, host-only so apex only); only its SHA-256 is stored, and it lasts
30 days, sliding (extended at most once a day). `next` must be a same-origin path: anything with a
scheme, a host, `//`, a backslash or a control character falls back to `/dashboard`.

People-facing pages (`/signin`, `/auth/*`, `/claim/*`, `/dashboard*`, `/oauth/authorize`) redirect
to the `PUBLIC_BASE_URL` host first (www to apex), so cookies and the Google callback always match.

**Local dev and tests:** `GET /auth/dev-login?email=&next=` signs in as any email (user `sub`
`dev:<email>`). It answers exactly like an unknown route unless `DEV_MODE` is `"true"`; the
template sets `DEV_MODE` to `""` and deployments don't change it.

Sign out is `POST /auth/signout` (with CSRF): the session row is deleted and the cookie cleared.

### 2. Claiming a project

- **Claim link from the agent.** `POST /v1/claim-link` with a full-access key returns
  `{ "url": "https://agentfirststack.com/claim/<token>", "expires_at": ..., "account_id": ..., "next_steps": [...] }`.
  It is also the MCP gateway tool `afs_create_claim_link`, listed only for full-access keys.
  - The token is 40 random characters, stored hashed, and lasts 7 days, single use. A project can
    have at most 25 unused links at once.
  - Opening it signed out asks the person to sign in (and comes back), without showing anything
    about the project. Signed in, it shows the project, its sites, containers and inboxes, and
    **Claim** (a POST with CSRF). Claiming adds them as owner, or as a member if the project
    already has an owner. A member of an ownerless project who claims becomes its owner.
  - Only the request that marks the link used gets in; if adding the member then fails, the link
    is given back.
- **Import by key.** In the dashboard, paste a full-access key to add its project. Read-only keys
  are refused (a member can mint full keys, so import must not widen a read key).

### 3. Dashboard (`/dashboard`)

Server-rendered pages in the site Worker, in the landing page's visual language (one stylesheet,
`dashboard.css`: square tiles on a 12-column grid, CSS-only motion that honours
`prefers-reduced-motion`). The only script is `public/dashboard.js` (CSP `script-src 'self'`), which
adds Copy buttons to prompts, new keys, invite links and the MCP URL; without it they stay
click-to-select:

| Page | What it does |
|---|---|
| `/dashboard` | "You don't need this dashboard": prompts to give your agent; projects with resource counts and visitors in the last 7 days (summed over a project's sites, at most 12 stats calls per page, omitted when analytics doesn't answer); add a project by key; create an empty project |
| `/dashboard/projects/:id` | Sites (with 7-day visitors), tag containers and inboxes; key and member counts; "Open analytics dashboard" per site (creates or reuses the site's share link through analytics' API, then redirects to it); rename |
| `/dashboard/projects/:id/keys` | Keys (name, prefix, scope, created, last used); create (shown once) and revoke. OAuth access tokens are listed under connected apps instead |
| `/dashboard/projects/:id/members` | Members and roles; invite with a claim link (shown once); the owner removes members, anyone can leave. Removing someone revokes the apps they connected to that project |
| `/dashboard/apps` | Connected apps (OAuth grants): app name, redirect host, project, access, last used; disconnect |
| `/dashboard/account` | Profile, sign out, delete my account (type `delete` to confirm) |

- Resource lists come from the services over service bindings with internal auth (below). A
  service that can't be reached shows as unavailable, not empty.
- Every project route checks the membership first; a user who isn't a member gets a 404.
- All forms are POST with a CSRF token derived from the session cookie (and a browser `Origin`
  from another site is refused). Pages send `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `form-action 'self'`, `Cache-Control: no-store` and `Referrer-Policy: same-origin`. Everything
  shown is HTML-escaped.

### 4. OAuth 2.1 authorization server (for MCP connectors)

What MCP clients expect (MCP authorization spec):

- **Discovery.**
  - `GET /.well-known/oauth-authorization-server` (RFC 8414) lists `issuer`, the endpoints below,
    `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code",
    "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`,
    `token_endpoint_auth_methods_supported: ["none"]`, `scopes_supported: ["*", "read"]`,
    `authorization_response_iss_parameter_supported: true` and `service_documentation`.
  - Protected resource metadata (RFC 9728) on the apex and every service host lists
    `authorization_servers: ["https://agentfirststack.com"]` (`AUTH_ISSUER`, which `pnpm afs`
    sets on every app; the site defaults to its own public URL). A standalone app without
    `AUTH_ISSUER` lists none. The helper is `protectedResourceRoutes()` in `@afs/shared`.
  - Every `/mcp` 401 sends `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<host>/.well-known/oauth-protected-resource/mcp"`
    (plus `error="invalid_token"` when a key was sent but didn't work).
  - Metadata, register, token and revoke send CORS (`Access-Control-Allow-Origin: *`) and answer
    preflights.
- **Dynamic client registration** (RFC 7591, `POST /oauth/register`).
  - Public clients only: whatever `token_endpoint_auth_method` is asked for, the answer is
    `"none"` and no secret is issued.
  - Each `redirect_uris` entry (1 to 10) must be https, or http on `localhost`/`127.0.0.1`, with
    no fragment and no credentials. `grant_types` and `response_types` may only name what's
    supported.
  - Identical registrations (same name and redirect URIs) return the same `client_id`, so retries
    and many users of one app don't pile up clients.
  - New registrations are rate-limited per network: the `SIGNUP_LIMITER` burst limit (keyed
    separately from signup) and `OAUTH_REGISTER_HOURLY_LIMIT` per hour (default 30).
- **Authorize** (`GET /oauth/authorize`):
  - An unknown `client_id` or a `redirect_uri` that isn't exactly registered is shown as an error
    page and never redirected. Every other problem goes back to the client with `error`, `state`
    and `iss`: `response_type` must be `code`, `state` is required, PKCE must be `S256` with a
    43-character challenge, `scope` may be `*` and/or `read`, and a `resource` (RFC 8707) must be
    on the issuer's host or a subdomain.
  - It requires sign-in, then shows a consent page: "*<client name>* wants to use AgentFirstStack",
    the host it will send you back to (and the full redirect URI), and a note that the app chose
    its own name. If the name looks like Claude/Anthropic or ChatGPT/OpenAI but the redirect host
    isn't theirs, a warning says so. The person picks a project (or creates one) and full or read
    access; a client that asked only for `read` can only get `read`.
  - Approving (a POST with CSRF, re-validating every parameter and the membership) redirects with
    `code`, `state` and `iss` (RFC 9207). Denying redirects with `error=access_denied`. Codes are
    single use and expire in 10 minutes.
- **Token** (`POST /oauth/token`, form or JSON):
  - `authorization_code` marks the code used first, then checks expiry, client, the exact
    `redirect_uri`, the PKCE verifier and `resource`. A code presented twice revokes the grant it
    created.
  - `refresh_token` rotates the refresh token (`afsr_...`). Refresh tokens last 30 days. Presenting
    a rotated one again revokes the whole grant (every refresh and access token). A refresh may
    narrow `*` to `read`, never widen. A user who left the project loses the grant.
  - Access tokens are **API keys with an expiry** (`expires_at`, 8 hours) for the chosen project
    and scope, named after the client and linked to the grant (`oauth_grant_id`). Every service
    accepts them unchanged.
- **Revoke** (`POST /oauth/revoke`, RFC 7009) always answers 200. A refresh token revokes its
  whole grant; an access token only itself. Only OAuth-issued keys can be revoked here, and a
  `client_id`, when sent, must match.

A daily cron on the site (03:17 UTC) deletes expired keys, codes, refresh tokens, sessions and
claim links, grants with nothing left that are over a month old, and clients nobody authorized
within a month.

### 5. Services: internal auth for the dashboard

The site calls each service with `x-afs-internal: <INTERNAL_TOKEN>` and `x-afs-account: acct_...`
over service bindings. `requireAuth()` accepts that (constant-time compare, and the account must
exist in the identity DB) as a full-access caller for that account, with key id `internal`. A
wrong token is a 401, never a fallback to the API key next to it. `INTERNAL_TOKEN` is a secret
shared by the four Workers; without it, the headers are ignored and nothing changes.

### 6. Privacy and deletion

- `/privacy` and `/terms` pages (static, `site/public/`); Google's consent screen needs both URLs.
- We store a signed-in user's Google `sub`, email, name and picture URL, their memberships,
  sessions and OAuth grants (with hashed tokens), and claim links (hashed) until they expire.
- **Delete my account** removes the user, their memberships, sessions, OAuth grants with their
  codes and refresh tokens, and the access tokens those grants issued. Projects and their agent
  keys keep working (they belong to the project, not the person); references to the user on
  dashboard-made keys and claim links are cleared. A project left with no members simply becomes
  unclaimed again.

## Routes

| Route | Auth | What |
|---|---|---|
| `POST /v1/claim-link` | full-access key | a claim link (also MCP `afs_create_claim_link`) |
| `GET /signin` | none | sign-in page |
| `GET /auth/google`, `GET /auth/google/callback` | none | Google sign-in |
| `GET /auth/dev-login` | `DEV_MODE=true` only | fake sign-in for dev and tests |
| `POST /auth/signout` | session + CSRF | sign out |
| `GET`, `POST /claim/:token` | session (+ CSRF to claim) | claim page |
| `GET`, `POST /dashboard/...` | session (+ CSRF) | the pages above |
| `GET /.well-known/oauth-authorization-server` | none | RFC 8414 metadata |
| `GET /.well-known/oauth-protected-resource[/mcp]` | none | RFC 9728 metadata (every host) |
| `POST /oauth/register` | none (rate-limited) | RFC 7591 |
| `GET`, `POST /oauth/authorize` | session (+ CSRF to approve) | consent |
| `POST /oauth/token`, `POST /oauth/revoke` | client_id (public) | tokens |

## Schema

`site/migrations/0003_api_key_metadata.sql` adds `api_keys.expires_at`, `oauth_grant_id` and
`created_by_user_id`. `0004_users_oauth.sql` adds `users`, `memberships`, `sessions`,
`claim_links`, `oauth_clients`, `oauth_grants`, `oauth_codes` and `oauth_refresh_tokens`. Every
token, code and session column holds a SHA-256. Each app's own database gets `api_keys.expires_at`
too (`analytics/0004`, `tags/0004`, `mail/0007`), because `authenticate()` selects it in
standalone mode.

## Operator setup

1. Google Cloud Console > APIs & Services > OAuth consent screen:
   - External; app name AgentFirstStack.
   - Home page `https://agentfirststack.com`, privacy policy `https://agentfirststack.com/privacy`,
     terms `https://agentfirststack.com/terms`.
   - Scopes `openid`, `email` and `profile` (no app review needed).
2. Credentials > Create OAuth client ID > Web application:
   - Authorised redirect URI `https://agentfirststack.com/auth/google/callback`.
3. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `deploy/<profile>.secrets.json` under
   `site`, add `INTERNAL_TOKEN` at the top level (all apps; `pnpm afs init <profile>` adds one to
   an existing secrets file), and `pnpm afs deploy <profile>`. Migrations are applied before each
   Worker deploys, site first.
