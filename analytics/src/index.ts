import {
  accountRoutes,
  onError,
  onNotFound,
  onUserContentHost,
  protectedResourceRoutes,
  publicBaseUrl,
  requireAuth,
  userContentOrigin,
} from "@afs/shared";
import { handleMcp } from "@afs/shared/mcp";
import { Hono } from "hono";
import { type AppEnv, type Bindings, VERSION } from "./env";
import { llmsTxt } from "./llms";
import { MCP_INSTRUCTIONS, registerTools } from "./mcp";
import { accountPurgeRoutes } from "./routes/account";
import { ingestRoutes } from "./routes/ingest";
import { shareRoutes, userContentRoutes } from "./routes/share";
import { webhookRoutes } from "./routes/webhooks";
import { siteRoutes } from "./routes/sites";
import { usageRoutes } from "./routes/usage";
import { runCron } from "./service/cron";
import { getFxRates } from "./service/fx";
import { getRollup } from "./service/reads";
import { crawlerList } from "./service/crawlers";
import { ctxOf } from "./routes/util";

export { SiteDO } from "./do/site-do";

const app = new Hono<AppEnv>();
app.onError(onError);
app.notFound(onNotFound);
// The user-content host (USER_CONTENT_BASE_URL) serves the public dashboards and nothing else: no
// API, MCP, tracker or collection on the origin that shows visitor-sent content.
app.use("*", async (c, next) => {
  if (!onUserContentHost(c.env, c.req.raw)) return next();
  let ctx: Parameters<typeof userContentRoutes.fetch>[2];
  try {
    ctx = c.executionCtx;
  } catch {
    /* no execution context (tests calling app.request) */
  }
  return userContentRoutes.fetch(c.req.raw, c.env, ctx);
});
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
app.get("/llms.txt", (c) =>
  c.body(llmsTxt(publicBaseUrl(c), userContentOrigin(c.env)), 200, { "content-type": "text/markdown; charset=utf-8" }),
);
app.route("/", shareRoutes);
// Public, authenticated by the provider's signature (Stripe-Signature), not by an API key.
app.route("/", webhookRoutes);

app.all("/mcp", (c) =>
  handleMcp(c.req.raw, c.env, {
    name: "analytics",
    version: VERSION,
    instructions: MCP_INSTRUCTIONS,
    register: (t, auth) =>
      registerTools(t, {
        env: c.env,
        accountId: auth.accountId,
        auth,
        baseUrl: publicBaseUrl(c),
        origin: new URL(c.req.url).origin,
        callerIp: c.req.header("cf-connecting-ip") ?? null,
      }),
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
// The crawler list (public: middleware fetches it to know which requests to report).
app.get("/v1/crawlers", (c) => c.json(crawlerList()));
app.use("/v1/*", requireAuth<AppEnv>());
app.route("/v1/sites", siteRoutes);
// Erasing a deleted project's data (the platform's purge, internal auth only).
app.route("/v1/account", accountPurgeRoutes);
// Every fair-use cap for the account with what it uses now (the platform site reads it hourly).
app.route("/v1/usage", usageRoutes);
// Every site of the account at once (totals per site and summed).
app.get("/v1/rollup", async (c) => c.json(await getRollup(ctxOf(c), c.req.query())));
// The exchange rates conversion to a site currency uses (ECB reference rates, stored per day).
app.get("/v1/fx/rates", async (c) => c.json(await getFxRates(ctxOf(c), c.req.query())));

export default {
  fetch: app.fetch,
  // Alerts, scheduled reports, delivery retries and history purges (wrangler.jsonc triggers).
  scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Bindings>;
