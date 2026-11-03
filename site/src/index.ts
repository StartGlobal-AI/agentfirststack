import { type AuthContext, accountRoutes, onError, onNotFound } from "@afs/shared";
import { Hono } from "hono";
import { mcpGateway } from "./mcp-gateway";

// The platform apex (agentfirststack.com). Static assets in public/ (landing page, llms.txt,
// /.well-known/*) are served by the assets binding. This Worker runs first only for:
//   /        content negotiation (Accept: text/markdown -> /index.md) and discovery Link headers
//   /mcp     the MCP gateway over every service
//   /v1/*    the one signup endpoint for the whole platform, plus key management
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.onError(onError);
app.notFound(onNotFound);

/** Service hosts derive from the apex: https://example.com -> https://analytics.example.com. */
const serviceUrl = (base: string, svc: string) => {
  const u = new URL(base);
  return `${u.protocol}//${svc}.${u.host}`;
};

// RFC 8288 Link headers: where agents find the manual, catalogs, MCP server and skills.
const LINKS = [
  '</llms.txt>; rel="service-doc"; type="text/markdown"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/ai-catalog.json>; rel="ai-catalog"; type="application/json"',
  '</.well-known/mcp/server-card.json>; rel="mcp-server-card"; type="application/json"',
  '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"',
  '</auth.md>; rel="describedby"; type="text/markdown"',
  '</index.md>; rel="alternate"; type="text/markdown"',
].join(", ");

const wantsMarkdown = (accept: string | undefined) => {
  if (!accept) return false;
  // Prefer markdown when it's asked for explicitly and not out-ranked by text/html.
  const q = (type: string) => {
    const part = accept.split(",").find((p) => p.trim().toLowerCase().startsWith(type));
    if (!part) return -1;
    const m = /;\s*q=([\d.]+)/.exec(part);
    return m ? Number(m[1]) : 1;
  };
  const md = q("text/markdown");
  return md > 0 && md >= q("text/html");
};

app.on(["GET", "HEAD"], "/", async (c) => {
  const markdown = wantsMarkdown(c.req.header("accept"));
  const asset = await c.env.ASSETS.fetch(new URL(markdown ? "/index.md" : "/", c.req.url));
  const headers = new Headers(asset.headers);
  headers.set("link", LINKS);
  headers.append("vary", "Accept");
  if (markdown) {
    const text = await asset.clone().text();
    headers.set("content-type", "text/markdown; charset=utf-8");
    headers.set("x-markdown-tokens", String(Math.ceil(text.length / 4)));
  }
  return new Response(c.req.method === "HEAD" ? null : asset.body, { status: asset.status, headers });
});

app.all("/mcp", (c) => mcpGateway(c.req.raw, c.env));

// RFC 9728 protected resource metadata, for the apex and (path-suffixed) for the MCP gateway.
// No authorization_servers on purpose: keys come from one unauthenticated POST /v1/signup, not
// OAuth. resource_documentation (auth.md) explains registration and credential use.
const resourceMetadata = (resource: string) => ({
  resource,
  resource_name: "AgentFirstStack",
  resource_documentation: `${new URL(resource).origin}/auth.md`,
  bearer_methods_supported: ["header"],
  scopes_supported: ["*", "read"],
});
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(resourceMetadata(new URL(c.req.url).origin), 200, { "access-control-allow-origin": "*" }),
);
app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.json(resourceMetadata(`${new URL(c.req.url).origin}/mcp`), 200, { "access-control-allow-origin": "*" }),
);

app.route(
  "/",
  accountRoutes<Env>({
    keyPrefix: "afs",
    appName: "AgentFirstStack",
    mcpName: "afs",
    mcp: (base, key) => {
      const header = `--header "Authorization: Bearer ${key}"`;
      return {
        all: { url: `${base}/mcp`, claude_code: `claude mcp add --transport http afs ${base}/mcp ${header}` },
        ...Object.fromEntries(
          (["analytics", "tags", "mail"] as const).map((svc) => {
            const url = `${serviceUrl(base, svc)}/mcp`;
            return [svc, { url, claude_code: `claude mcp add --transport http afs-${svc} ${url} ${header}` }];
          }),
        ),
      };
    },
    nextSteps: (base) => [
      "Save api_key in the project's .env as AGENTFIRSTSTACK_API_KEY. It works for analytics, tags and mail.",
      `Read ${base}/llms.txt for what to do next.`,
      `Analytics: POST ${serviceUrl(base, "analytics")}/v1/sites {"domain":"example.com"}`,
      `Tags: POST ${serviceUrl(base, "tags")}/v1/containers {"domain":"example.com"}`,
      `Mail: POST ${serviceUrl(base, "mail")}/v1/inboxes {"username":"example-signups"}`,
    ],
  }),
);

export default app;
