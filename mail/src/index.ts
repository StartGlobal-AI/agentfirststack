import { accountRoutes, onError, onNotFound, protectedResourceRoutes, publicBaseUrl, requireAuth } from "@afs/shared";
import { handleMcp } from "@afs/shared/mcp";
import { Hono } from "hono";
import type { AppEnv, AppHono, WebhookJob } from "./env";
import { llmsTxt } from "./llms";
import { MCP_INSTRUCTIONS, registerTools } from "./mcp";
import { api } from "./routes/api";
import { createDefaultInbox, pruneCounters, purgeExpiredInboxes, purgeOldSharedMessages, sharedDomain } from "./service/inboxes";
import { handleEmail } from "./service/ingest";
import { sweepOrphanBlobs } from "./service/sweep";
import { deliverBatch, purgeWebhookDeliveries } from "./service/webhooks";
import { uiHtml } from "./ui";

export { InboxDO } from "./inbox-do";

const VERSION = "0.1.0";

const app = new Hono<AppHono>();
app.onError(onError);
app.notFound(onNotFound);
// RFC 9728 metadata naming the platform's OAuth server (AUTH_ISSUER), for MCP connectors.
app.route("/", protectedResourceRoutes({ name: "AgentFirstStack Mail" }));

app.get("/", (c) => {
  const base = publicBaseUrl(c);
  return c.json({
    app: "mail",
    version: VERSION,
    shared_domain: sharedDomain(c.env),
    docs: `${base}/llms.txt`,
    mcp: `${base}/mcp`,
    ui: `${base}/ui`,
    next_steps: [`POST ${base}/v1/signup returns an API key and a ready inbox.`],
  });
});

app.get("/llms.txt", (c) =>
  c.text(llmsTxt(publicBaseUrl(c), sharedDomain(c.env)), 200, { "content-type": "text/markdown; charset=utf-8" }),
);

app.get("/ui", (c) =>
  c.html(uiHtml(), 200, {
    // The page itself: only its own inline script/style, API calls to this origin. Mail HTML is
    // rendered in a sandboxed srcdoc iframe that inherits this policy (no remote images/scripts).
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  }),
);

// Signup (public) must be mounted before the /v1/* auth guard: Hono runs handlers in order.
app.route(
  "/",
  accountRoutes<AppEnv>({
    keyPrefix: "mail",
    appName: "mail",
    mcpName: "mail",
    onSignup: async (env, accountId) => ({ inbox: await createDefaultInbox(env, accountId) }),
    nextSteps: (base) => [
      "Your default inbox is in `inbox`. Use inbox.address in a signup form, then:",
      `curl -H "Authorization: Bearer $KEY" "${base}/v1/inboxes/<inbox.id>/latest-code?timeout=60"  # blocks until the code arrives`,
      `POST ${base}/v1/inboxes {"username":"acme-signups"} creates more addresses.`,
      `Manual: ${base}/llms.txt`,
    ],
  }),
);

app.all("/mcp", (c) =>
  handleMcp(c.req.raw, c.env, {
    name: "mail",
    version: VERSION,
    instructions: MCP_INSTRUCTIONS,
    register: (t) => registerTools(t, c.env, { adminToken: c.req.header("x-admin-token") ?? null }),
  }),
);

app.use("/v1/*", requireAuth<AppHono>());
app.route("/v1", api);

export default {
  fetch: app.fetch,
  async email(message, env) {
    await handleEmail(message, env);
  },
  async queue(batch, env) {
    await deliverBatch(batch, env);
  },
  async scheduled(_controller, env, ctx) {
    // Each purge loops in batches under a wall-time budget (PURGE_BUDGET_MS) and reports `more`
    // when the next hourly run has to continue. The blob sweep resumes from its saved cursor.
    // One failing job does not stop the others.
    const run = <T extends object>(name: string, p: Promise<T>) =>
      p.catch((e: unknown) => {
        console.error(`cron ${name} failed`, e);
        return { [`${name}_error`]: String(e) };
      });
    ctx.waitUntil(
      Promise.all([
        run(
          "expiry",
          purgeExpiredInboxes(env).then((a) => ({ purged_inboxes: a.purged, inboxes_more: a.more })),
        ),
        run("retention", purgeOldSharedMessages(env)),
        run("prune", pruneCounters(env)),
        run("deliveries", purgeWebhookDeliveries(env)),
        run("sweep", sweepOrphanBlobs(env)),
      ]).then((parts) => console.log(JSON.stringify(Object.assign({ event: "cron.purge" }, ...parts)))),
    );
  },
} satisfies ExportedHandler<AppEnv, WebhookJob>;

export { app };
