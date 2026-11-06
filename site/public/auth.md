# AgentFirstStack auth.md

## Audience

AI agents (coding agents, assistants, automations) that call the AgentFirstStack APIs or MCP
servers on behalf of a person or a project, and chat apps (claude.ai, ChatGPT) that connect to the
MCP servers for a signed-in person:

- https://agentfirststack.com (signup, keys, claim links, MCP gateway, OAuth server)
- https://analytics.agentfirststack.com
- https://tags.agentfirststack.com
- https://mail.agentfirststack.com

## Registration

Agents register themselves with one request. There is no email, no password and no human
approval step.

```http
POST https://agentfirststack.com/v1/signup
Content-Type: application/json

{"name": "my-project"}
```

The body is optional. The response is `201 Created`:

```json
{ "account_id": "acct_...", "api_key": "afs_...", "key_id": "key_...", "mcp": { ... }, "next_steps": [ ... ] }
```

Signup is limited per network (3 accounts an hour and 10 a day on the hosted service). Reuse a project's
existing key instead of registering again. When the deployment gets unusually many signups, the
answer is `429 proof_of_work_required` with a `challenge` and a `difficulty`: find a `solution`
such that SHA-256 of `<challenge>:<solution>` starts with `difficulty` zero bits (about a second;
`solve.node` and `solve.python` in the answer are ready-made commands) and repeat the request with
`{"challenge": "...", "solution": "..."}` added to the body. Using the platform means following its
Acceptable Use Policy: https://agentfirststack.com/acceptable-use.

## Supported methods

- **Self-registration** with one POST, returning an API key. This is the method for agents.
- **API keys** with scope `*` (full access) or `read` (GET routes and read-only MCP tools only).
- **OAuth 2.1** for chat apps that can't hold a key (MCP authorization spec): a person signs in
  with Google, picks a project and grants full or read access. Access tokens are API keys that
  expire after 8 hours; they can't create other keys or claim links.

## Credential use

Send the key on every request, to any of the hosts above:

```http
Authorization: Bearer afs_...
```

`x-api-key: afs_...` also works. For MCP, use the same header with
`https://agentfirststack.com/mcp` (all services) or `https://<service>.agentfirststack.com/mcp`.
OAuth access tokens are used the same way.

## Handing the project to a person

People are optional, but the person you work for will want to see what you built. When you finish,
test the setup (`POST https://agentfirststack.com/v1/setup/test`, then its browser plan) and run the
setup check (`GET https://agentfirststack.com/v1/setup`) until it says ready, then create a claim link
and give them the URL with the report tables:

```http
POST https://agentfirststack.com/v1/claim-link
Authorization: Bearer afs_...
```

```json
{ "url": "https://agentfirststack.com/claim/<token>", "expires_at": 1793000000000, "account_id": "acct_..." }
```

It needs a full-access key, works once and lasts 7 days. Over MCP it's the gateway tool
`afs_create_claim_link`. Opening it, the person signs in with Google and becomes the project's
owner (or a member, if it already has one). Your key keeps working.

## OAuth for MCP connectors

- Every `/mcp` answers a request without a valid key with `401` and
  `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`.
- Protected resource metadata (RFC 9728) on every host lists
  `authorization_servers: ["https://agentfirststack.com"]`.
- Authorization server metadata (RFC 8414): `https://agentfirststack.com/.well-known/oauth-authorization-server`.
- Dynamic client registration (RFC 7591): `POST /oauth/register` with `redirect_uris` (https, or
  http on localhost / 127.0.0.1) and `client_name`. Public clients only
  (`token_endpoint_auth_method: "none"`); identical registrations return the same `client_id`.
- `GET /oauth/authorize`: `response_type=code`, `client_id`, the exact registered `redirect_uri`,
  `state`, `code_challenge` with `code_challenge_method=S256`, optional `scope` (`*` or `read`)
  and `resource`. The redirect back carries `code`, `state` and `iss`. Codes are single use and
  expire after 10 minutes.
- `POST /oauth/token`: `grant_type=authorization_code` (with `code_verifier`) or
  `grant_type=refresh_token`. Refresh tokens last 30 days and rotate on every use; presenting a
  used one revokes the whole authorization.
- `POST /oauth/revoke` (RFC 7009) revokes an access token, or a refresh token and everything
  issued with it.

## Metadata

- Protected resource metadata (RFC 9728): `https://agentfirststack.com/.well-known/oauth-protected-resource`
  (and `/.well-known/oauth-protected-resource/mcp` for the MCP gateway), and the same paths on
  every service host.
- Authorization server: `https://agentfirststack.com/.well-known/oauth-authorization-server`.
- Catalogs: `/.well-known/api-catalog`, `/.well-known/ai-catalog.json`, `/.well-known/mcp/server-card.json`.

## Managing credentials

- `GET /v1/me` returns the account and the calling key.
- `POST /v1/keys {"name": "ci", "scope": "read"}` creates another key (shown once). At most 25
  active keys per account on the hosted service (10 until a person claims it); OAuth access tokens
  can't create keys.
- `DELETE /v1/keys/:id` revokes a key immediately.
- People who claimed the project manage keys and connected apps at https://agentfirststack.com/dashboard.
- Deleting the project stops every key and OAuth token at once (`403 project_deleted`). Its owner
  deletes it in the dashboard; an unclaimed project's own agent can, with a full-access key, when
  the person asks: `DELETE /v1/me {"confirm":"acct_..."}` (MCP `afs_delete_project`).

There is no password reset for agents, because there is no email. Keep a second key in the
owner's secrets manager, or give the owner a claim link. Full manual: https://agentfirststack.com/llms.txt
