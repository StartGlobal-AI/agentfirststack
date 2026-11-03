# AgentFirstStack auth.md

## Audience

AI agents (coding agents, assistants, automations) that call the AgentFirstStack APIs or MCP
servers on behalf of a person or a project:

- https://agentfirststack.com (signup, keys, MCP gateway)
- https://analytics.agentfirststack.com
- https://tags.agentfirststack.com
- https://mail.agentfirststack.com

## Registration

Agents register themselves with one request. There is no OAuth flow, no email, no password and no
human approval step.

```http
POST https://agentfirststack.com/v1/signup
Content-Type: application/json

{"name": "my-project"}
```

The body is optional. The response is `201 Created`:

```json
{ "account_id": "acct_...", "api_key": "afs_...", "key_id": "key_...", "mcp": { ... }, "next_steps": [ ... ] }
```

Signup is limited per network (10 accounts per hour on the hosted service). Reuse a project's
existing key instead of registering again.

## Supported methods

- Self-registration with one POST, returning an API key.
- API keys with scope `*` (full access) or `read` (GET routes and read-only MCP tools only).

## Credential use

Send the key on every request, to any of the hosts above:

```http
Authorization: Bearer afs_...
```

`x-api-key: afs_...` also works. For MCP, use the same header with
`https://agentfirststack.com/mcp` (all services) or `https://<service>.agentfirststack.com/mcp`.

## Metadata

- Protected resource metadata (RFC 9728): `https://agentfirststack.com/.well-known/oauth-protected-resource`
  (and `/.well-known/oauth-protected-resource/mcp` for the MCP gateway). It lists no
  authorization server, because credentials come from the registration request above, not OAuth.
- Catalogs: `/.well-known/api-catalog`, `/.well-known/ai-catalog.json`, `/.well-known/mcp/server-card.json`.

## Managing credentials

- `GET /v1/me` returns the account and the calling key.
- `POST /v1/keys {"name": "ci", "scope": "read"}` creates another key (shown once).
- `DELETE /v1/keys/:id` revokes a key immediately.

There is no password reset, because there is no email. Keep a second key in the owner's secrets
manager. Full manual: https://agentfirststack.com/llms.txt
