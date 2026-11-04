# MCP registry entries

The `server.json` files published to the official MCP registry
(https://registry.modelcontextprotocol.io) as `com.agentfirststack/{mcp,analytics,tags,mail,replay}`:
the gateway at https://agentfirststack.com/mcp and each service's own `/mcp`.

The `com.agentfirststack/*` namespace is proved with DNS: the apex TXT record
`v=MCPv1; k=ed25519; p=<public key>` on agentfirststack.com. The matching private key is kept by the
operator (not in this repo).

To publish a new version: bump `version` in each file, then sign the current RFC 3339 timestamp
with the key, exchange it at `POST /v0/auth/dns` (`{domain, timestamp, signed_timestamp}` with the
signature in hex) for a registry token, and `POST /v0/publish` each file with
`Authorization: Bearer <token>`. The official `mcp-publisher login dns` CLI does the same.
