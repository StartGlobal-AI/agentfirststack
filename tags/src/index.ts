import { accountRoutes, onError, onNotFound, protectedResourceRoutes, publicBaseUrl, requireAuth } from "@afs/shared";
import { handleMcp } from "@afs/shared/mcp";
import { Hono } from "hono";
import { schemaDocument } from "./config/catalog";
import { ContainerDO, type DispatchMessage } from "./do/container-do";
import type { AppEnv, Bindings } from "./env";
import { llmsTxt } from "./llms";
import { mcpOptions } from "./mcp";
import { account } from "./routes/account";
import { dataPlane } from "./routes/public";
import { v1 } from "./routes/v1";
import { handleDispatchBatch } from "./service/dispatch";

const app = new Hono<AppEnv>();

app.onError(onError);
app.notFound(onNotFound);
// RFC 9728 metadata naming the platform's OAuth server (AUTH_ISSUER), for MCP connectors.
app.route("/", protectedResourceRoutes({ name: "AgentFirstStack Tags" }));

// Data plane first: /c/:id.js and /collect, at the root or under any proxy prefix.
app.use("*", dataPlane);

app.get("/", (c) => {
  const base = publicBaseUrl(c);
  return c.json({
    app: "tags",
    description: "Agent-native tag manager + server-side conversion router.",
    docs: `${base}/llms.txt`,
    signup: `POST ${base}/v1/signup`,
    mcp: `${base}/mcp`,
  });
});
app.get("/llms.txt", (c) => c.text(llmsTxt(publicBaseUrl(c)), 200, { "content-type": "text/markdown; charset=utf-8" }));
app.get("/v1/schema", (c) => c.json(schemaDocument()));

// Accounts (signup stays public) BEFORE the /v1 auth wall.
app.route(
  "/",
  accountRoutes<Bindings>({
    keyPrefix: "tags",
    appName: "tags",
    mcpName: "tags",
    nextSteps: (base) => [
      `POST ${base}/v1/containers { "domain": "example.com" } -> container + <script> snippet.`,
      `GET ${base}/llms.txt for every endpoint, MCP tool and config field.`,
    ],
  }),
);

app.all("/mcp", (c) =>
  handleMcp(
    c.req.raw,
    c.env,
    mcpOptions((auth) => {
      const base = publicBaseUrl(c);
      return { env: c.env, auth, base, origins: [base, new URL(c.req.url).origin] };
    }),
  ),
);

app.use("/v1/*", requireAuth());
app.route("/v1", v1);
// DELETE /v1/account: the platform's purge of a deleted project (internal auth only).
app.route("/v1", account);

export { ContainerDO };

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<DispatchMessage>, env: Bindings) {
    await handleDispatchBatch(batch, env);
  },
} satisfies ExportedHandler<Bindings, DispatchMessage>;
