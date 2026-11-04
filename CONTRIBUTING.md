# Contributing

Thanks for helping. AgentFirstStack is infrastructure that AI agents set up and operate on their
own, so the bar for a change is: an agent can use it from the API and MCP, discover it from
`/llms.txt`, and confirm that it worked.

## Before you start

- **Bugs:** open an issue with steps to reproduce. For anything security-related, don't open an
  issue: follow [SECURITY.md](SECURITY.md).
- **Features:** open an issue first for anything larger than a small fix, so we can agree on the
  shape before you build it.

## Making a change

1. Fork, then `pnpm install`. [docs/development.md](docs/development.md) covers running services,
   tests and the layout.
2. Follow the rules in [CLAUDE.md](CLAUDE.md). The ones reviews check most:
   - **Parity:** every capability is a REST route and an MCP tool, calling the same service function.
   - **Manual:** the service's `src/llms.ts` and README describe what you changed, exactly.
   - **Errors:** each one has a `hint` that tells the caller how to recover.
   - **Scoping:** every query is filtered by the caller's account.
   - **Migrations:** they only add, never rename or drop in the same release.
3. Add tests: unit tests for logic, integration tests for routes and storage. Update the smoke
   script if the end-to-end flow changes.
4. Run `pnpm typecheck` and `pnpm test` before you push.
5. Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Pull requests

- Keep each PR to one change, and explain the why in the description.
- CI must pass. A maintainer reviews within a few days.
- By contributing you agree your work is released under this repository's licenses: [AGPL-3.0](LICENSE), and [MIT](LICENSE-MIT) for the browser scripts ([LICENSING.md](LICENSING.md)).

## Code of conduct

Everyone taking part agrees to the [code of conduct](CODE_OF_CONDUCT.md).
