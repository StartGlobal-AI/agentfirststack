import { accountRoutes, onError, onNotFound, protectedResourceRoutes, publicBaseUrl, requireAuth } from "@afs/shared";
import { handleMcp } from "@afs/shared/mcp";
import { Hono } from "hono";
import { type AppEnv, type Bindings, VERSION } from "./env";
import { llmsTxt } from "./llms";
import { MCP_INSTRUCTIONS, registerTools } from "./mcp";
import { ingestRoutes } from "./routes/ingest";
import { shareRoutes } from "./routes/share";
import { siteRoutes } from "./routes/sites";

export { SiteDO } from "./do/site-do";

const app = new Hono<AppEnv>();
app.onError(onError);
app.notFound(onNotFound);
// RFC 9728 metadata naming the platform's OAuth server (AUTH_ISSUER), for MCP connectors.
app.route("/", protectedResourceRoutes({ name: "AgentFirstStack Analytics" }));

// Public: tracker + collection (also under any path prefix, for first-party proxies).
app.use("*", ingestRoutes);

app.get("/", (c) => {
  const base = publicBaseUrl(c);
  return c.json({
    app: "analytics",
    version: VERSION,
    docs: `${base}/llms.txt`,
    signup: `POST ${base}/v1/signup`,
    mcp: `${base}/mcp`,
    tracker: `${base}/s.js`,
  });
});
app.get("/llms.txt", (c) => c.body(llmsTxt(publicBaseUrl(c)), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.route("/", shareRoutes);

app.all("/mcp", (c) =>
  handleMcp(c.req.raw, c.env, {
    name: "analytics",
    version: VERSION,
    instructions: MCP_INSTRUCTIONS,
    register: (t, auth) => registerTools(t, { env: c.env, accountId: auth.accountId, baseUrl: publicBaseUrl(c) }),
  }),
);

// Accounts first, so /v1/signup stays public; everything after this needs a key.
app.route(
  "/",
  accountRoutes<Bindings>({
    keyPrefix: "ana",
    appName: "analytics",
    mcpName: "analytics",
    nextSteps: (base) => [
      `Create a site: curl -X POST ${base}/v1/sites -H "Authorization: Bearer $KEY" -d '{"domain":"example.com"}'`,
      "Paste the returned snippet into <head>, open the site once in a browser, then POST /v1/sites/:id/verify.",
      `Full manual: ${base}/llms.txt`,
    ],
  }),
);
app.use("/v1/*", requireAuth<AppEnv>());
app.route("/v1/sites", siteRoutes);

export default app;
