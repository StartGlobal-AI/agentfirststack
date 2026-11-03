# Development

## Setup

```sh
corepack enable            # pnpm 10, pinned in package.json
pnpm install
pnpm typecheck             # every package
pnpm test                  # unit tests + integration tests inside workerd
```

Node 22 or newer. Nothing needs a Cloudflare account until you deploy: `wrangler dev` runs D1,
Durable Objects, R2, Queues and the email handler locally.

## Run a service

```sh
cd mail                    # or analytics, tags, site
cp .dev.vars.example .dev.vars
pnpm db:migrate:local      # app DB + the shared identity DB
pnpm dev                   # site :8786, analytics :8787, tags :8788, mail :8789
pnpm smoke                 # end-to-end run against the dev server (in another terminal)
```

Each `wrangler.jsonc` is a generic template with safe local defaults. Never put deployment
values in it; those live in `deploy/<profile>.json` (see [self-hosting.md](self-hosting.md)).

Useful local hooks:

- **site:** `DEV_MODE=true` (in `.dev.vars`) adds a fake sign-in, `/auth/dev-login?email=you@example.com`,
  so claim links, the dashboard and the OAuth consent page work without Google. It answers 404
  unless `DEV_MODE` is exactly `true`.
- **analytics:** `DEV_MODE=true` honours `x-dev-geo-*` headers, so you can fake countries.
- **tags:** `DEV_MODE=true` allows `http://localhost` webhook destinations.
- **mail:** deliver a test message to the `email()` handler with
  `curl -X POST "localhost:8789/cdn-cgi/local/email?from=a@b.test&to=<inbox>" --data-binary @message.eml`.
  Sends land in `.wrangler/tmp/email/`.

## Layout

```
shared/        @afs/shared: auth, signup, errors, ids, crypto, MCP handler
site/          landing page (public/), platform llms.txt, platform signup, MCP gateway,
               sign-in, claim links, dashboard, OAuth server (docs/accounts.md)
analytics/     tags/     mail/
  src/index.ts        Hono app + handlers (fetch, email, queue, scheduled) + Durable Objects
  src/service/        business logic: the only place REST and MCP call into
  src/routes/         REST routes (thin)
  src/mcp.ts          MCP tools (thin)
  src/llms.ts         the manual served at /llms.txt
  migrations/         D1 migrations (forward-only)
  test/unit, test/integration, scripts/smoke.sh
scripts/afs.mjs       deployment tool
deploy/               deployment profiles
docs/                 these documents
```

## Tests

- **Unit tests** (`test/unit`, plain vitest in Node) cover pure logic: classification, parsing,
  extraction, payload builders, guards.
- **Integration tests** (`test/integration`) run the Worker inside workerd with
  `@cloudflare/vitest-pool-workers`, with real local D1, Durable Objects and queues. Migrations for
  the app DB and `AUTH_DB` are applied in the setup file. Fair-use vars are turned off in
  `vitest.config.ts`; tests for them turn them on per call. `DB` and `AUTH_DB` have different
  placeholder ids in each `wrangler.jsonc`, so they are two local databases, as in production.
- **The site** (`site/test`) runs in workerd too. The services behind its `ANALYTICS`, `TAGS` and
  `MAIL` bindings are stubbed in `site/test/helpers.ts` with the real `requireAuth()` and
  `handleMcp()`, so internal auth and OAuth access tokens are checked as the services check them.
  A small cookie-jar `Browser` drives sign-in, claim, dashboard and consent pages.
- **Smoke scripts** (`pnpm smoke`) drive a running dev server over HTTP the way an agent would.

CI runs `pnpm typecheck` and `pnpm test` on every pull request.

## Adding things

### An endpoint and its MCP tool

1. Write the logic as a function in `src/service/` that takes the env, the caller's account id
   and validated input. Scope every query by `account_id`.
2. Add the REST route in `src/routes/` (parse with zod via `readJson`/`readQuery`, call the
   service, return JSON) and the MCP tool in `src/mcp.ts`. Use `tools.read()` for tools that change
   nothing and `tools.write()` for the rest.
3. Throw `ApiError` (or the helpers in `shared/src/errors.ts`) with a `hint` that says how to fix
   the problem.
4. Document it in `src/llms.ts` and the app's README, and add tests.

### A database change

Add `migrations/000N_<name>.sql`. Migrations are forward-only and must keep working with the
previous release's code (add columns and tables; don't rename or drop in the same release). Run
`pnpm db:migrate:local` to apply locally; `pnpm afs deploy` applies them remotely before deploying.

### A tags destination

Connectors live in `tags/src/destinations/`, one file each, behind the interface in
`tags/src/destinations/types.ts`: a credential schema, a payload builder (pure, unit-tested
against the platform's documented examples), a sender, and a test-mode sender. Register it in
the destinations index and add it to the catalog `GET /v1/schema` returns.

## Conventions

The rules every service follows are in [`CLAUDE.md`](../CLAUDE.md). Briefly: one-request signup,
REST and MCP parity, `llms.txt` as the manual, verifiable setup steps, safe retries, errors with
hints. Ids are `prefix_` plus 16 base32 characters, timestamps are unix milliseconds, JSON is
snake_case, and third-party secrets are sealed with `encryptSecret()` and never returned.
