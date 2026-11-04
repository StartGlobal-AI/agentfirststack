# Licensing

Copyright (c) 2026 StartGlobal Inc.

AgentFirstStack is open source.

- **The services** (everything in this repository unless listed below) are licensed under the
  [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
- **The browser scripts** that websites load are licensed under the [MIT License](LICENSE-MIT):
  the analytics tracker (`/s.js`), the tag manager runtime (`/c/<container>.js`) and the replay
  loader, recorder and survey widget. That covers every source file those scripts are built from
  by `analytics/scripts/build-tracker.mjs`, `tags/scripts/build-runtime.mjs` and
  `replay/scripts/build-recorder.mjs` (the replay share-link player, built by the same script, is
  not one of them: it stays AGPL). Putting these scripts or their snippets on your site places no
  AGPL obligations on your site or your code.
- **Third-party code** keeps its own license: rrweb (MIT) in the replay recorder and player, and
  each dependency under its own terms.

## What the AGPL means in practice

- **Using the hosted service** at agentfirststack.com: nothing to do.
- **Self-hosting** for your own sites, changed or not: allowed, with no obligation to publish
  anything.
- **Offering a changed version as a service to other people:** you must offer those users the
  complete source code of your version under the same license (AGPL section 13). Unchanged, a link
  to this repository is enough.

The hosted service meets section 13 by linking to this repository from every page and manual.
