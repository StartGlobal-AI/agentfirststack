import { accountRoutes, onError, onNotFound, protectedResourceRoutes, publicBaseUrl, requireAuth } from "@afs/shared";
import { handleMcp } from "@afs/shared/mcp";
import { Hono } from "hono";
import { type AppEnv, type Bindings, VERSION } from "./env";
import { llmsTxt } from "./llms";
import { MCP_INSTRUCTIONS, registerTools } from "./mcp";
import { account } from "./routes/account";
import { api, waitUntilOf } from "./routes/api";
import { browserRoutes, playerRoutes } from "./routes/public";
import { runPurge } from "./service/purge";

export { ReplaySiteDO } from "./do/site-do";

const app = new Hono<AppEnv>();
app.onError(onError);
app.notFound(onNotFound);
// RFC 9728 metadata naming the platform's OAuth server (AUTH_ISSUER), for MCP connectors.
app.route("/", protectedResourceRoutes({ name: "AgentFirstStack Replay" }));

// Public, browser-facing: loader, recorder and chunk ingest (also under any path prefix).
app.use("*", browserRoutes);

app.get("/", (c) => {
  const base = publicBaseUrl(c);
  return c.json({
    app: "replay",
    version: VERSION,
    docs: `${base}/llms.txt`,
    signup: `POST ${base}/v1/signup`,
    mcp: `${base}/mcp`,
    next_steps: [`POST ${base}/v1/signup returns an API key, then POST ${base}/v1/sites {"domain":"example.com"}.`],
  });
});
app.get("/llms.txt", (c) => c.body(llmsTxt(publicBaseUrl(c)), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.route("/", playerRoutes);

app.all("/mcp", (c) =>
  handleMcp(c.req.raw, c.env, {
    name: "replay",
    version: VERSION,
    instructions: MCP_INSTRUCTIONS,
    register: (t, auth) =>
      registerTools(t, { env: c.env, accountId: auth.accountId, auth, baseUrl: publicBaseUrl(c), waitUntil: waitUntilOf(c) }),
  }),
);

// Accounts first, so /v1/signup stays public; everything after this needs a key.
app.route(
  "/",
  accountRoutes<Bindings>({
    keyPrefix: "rpy",
    appName: "replay",
    mcpName: "replay",
    nextSteps: (base) => [
      `Create a replay site: curl -X POST ${base}/v1/sites -H "Authorization: Bearer $KEY" -d '{"domain":"example.com"}'`,
      "Paste the returned <script> into <head>, open https://<domain>/?afsr=1 once in a browser, then POST /v1/sites/:id/verify.",
      `Full manual: ${base}/llms.txt`,
    ],
  }),
);
app.use("/v1/*", requireAuth<AppEnv>());
app.route("/v1", api);
app.route("/v1", account);

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runPurge(env).then((r) => console.log(JSON.stringify({ event: "cron.purge", ...r }))));
  },
} satisfies ExportedHandler<Bindings>;

export { app };
