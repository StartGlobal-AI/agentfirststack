import { accountRoutes, onError, onNotFound, protectedResourceRoutes } from "@afs/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { adminApi } from "./admin";
import { claimLinkApi, claimRoutes } from "./claims";
import { purgeExpired } from "./cleanup";
import { dashboard } from "./dashboard";
import type { Bindings, SiteEnv } from "./env";
import { authRoutes, siteBase } from "./google";
import { a2aEndpoint } from "./a2a";
import { mcpGateway } from "./mcp-gateway";
import { oauthApi, oauthPages } from "./oauth";
import { redirect } from "./session";

// The platform apex (agentfirststack.com). Static assets in public/ (landing page, llms.txt,
// privacy and terms, /.well-known/*) are served by the assets binding. This Worker runs first for:
//   /             content negotiation (Accept: text/markdown -> /index.md) and discovery Link headers
//   /mcp          the MCP gateway over every service
//   /v1/*         the one signup endpoint for the whole platform, key management, claim links,
//                 and the operator's /v1/admin/* (ADMIN_TOKEN only)
//   /signin, /auth/*, /claim/*, /dashboard/*   optional accounts for people (docs/accounts.md)
//   /oauth/*, /.well-known/oauth-*             the OAuth 2.1 server for MCP connectors
const app = new Hono<SiteEnv>();
app.onError(onError);
app.notFound(onNotFound);

// People-facing pages live on one host (PUBLIC_BASE_URL), so cookies and the Google callback match.
const canonicalHost: MiddlewareHandler<SiteEnv> = async (c, next) => {
  const base = c.env.PUBLIC_BASE_URL;
  if (base && (c.req.method === "GET" || c.req.method === "HEAD")) {
    const want = new URL(base);
    const u = new URL(c.req.url);
    if (u.host !== want.host) return redirect(`${want.origin}${u.pathname}${u.search}`, { status: 302 });
  }
  await next();
};
for (const path of ["/signin", "/auth/*", "/claim/*", "/dashboard", "/dashboard/*", "/oauth/authorize"]) app.use(path, canonicalHost);

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
app.all("/a2a", (c) => a2aEndpoint(c.req.raw, c.env));

// RFC 9728 protected resource metadata, for the apex and (path-suffixed) for the MCP gateway. Agents
// still get keys from one POST /v1/signup; the authorization server is for chat connectors.
app.route(
  "/",
  protectedResourceRoutes<Bindings>({
    name: "AgentFirstStack",
    documentation: (origin) => `${origin}/auth.md`,
    defaultIssuer: (c) => siteBase(c),
  }),
);

// OAuth 2.1 authorization server (RFC 8414 metadata, RFC 7591 registration, token, revoke) and
// its consent page; Google sign-in; claim links; the dashboard.
app.route("/", oauthApi);
app.route("/", oauthPages);
app.route("/", authRoutes);
app.route("/", claimRoutes);
app.route("/", claimLinkApi);
app.route("/", adminApi);
app.route("/dashboard", dashboard);

app.route(
  "/",
  accountRoutes<Bindings>({
    keyPrefix: "afs",
    appName: "AgentFirstStack",
    mcpName: "afs",
    mcp: (base, key) => {
      const header = `--header "Authorization: Bearer ${key}"`;
      return {
        all: { url: `${base}/mcp`, claude_code: `claude mcp add --transport http afs ${base}/mcp ${header}` },
        ...Object.fromEntries(
          (["analytics", "tags", "mail", "replay"] as const).map((svc) => {
            const url = `${serviceUrl(base, svc)}/mcp`;
            return [svc, { url, claude_code: `claude mcp add --transport http afs-${svc} ${url} ${header}` }];
          }),
        ),
      };
    },
    nextSteps: (base) => [
      "Save api_key in the project's .env as AGENTFIRSTSTACK_API_KEY. It works for analytics, tags, mail and replay.",
      `Read ${base}/llms.txt for what to do next.`,
      `Analytics: POST ${serviceUrl(base, "analytics")}/v1/sites {"domain":"example.com"}`,
      `Tags: POST ${serviceUrl(base, "tags")}/v1/containers {"domain":"example.com"}`,
      `Mail: POST ${serviceUrl(base, "mail")}/v1/inboxes {"username":"example-signups"}`,
      `Replay (ask the owner first): POST ${serviceUrl(base, "replay")}/v1/sites {"domain":"example.com"}`,
      `When you're done: POST ${base}/v1/claim-link and give the project's owner the returned url, so they can see everything in a dashboard.`,
    ],
  }),
);

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(purgeExpired(env.DB).then((n) => console.log(JSON.stringify({ event: "cron.purge", ...n }))));
  },
} satisfies ExportedHandler<Bindings>;
