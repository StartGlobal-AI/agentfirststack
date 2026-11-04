import {
  ApiError,
  accountStanding,
  assertPermanentKey,
  badRequest,
  decryptSecret,
  encryptSecret,
  identityDb,
  newId,
  notFound,
  parse,
  sha256Hex,
} from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { DESTINATION_TYPES, type DestinationType, type Fetcher, destinationUrlProblem, newSigningSecret, urlHint } from "../lib/delivery";
import { quotaExceeded, siteCap } from "../lib/limits";
import { type Ctx, loadSite } from "./context";
import { deliver } from "./notify";

/**
 * Where alerts and reports go: a signed webhook, a Slack incoming webhook, or email to the
 * project's members. URLs are credentials (anyone with a Slack hook URL can post to the channel),
 * so they are sealed with ENCRYPTION_KEY and never returned; a webhook's signing secret is shown
 * once, when it is created. Creating one needs the project's own key: a connected app's OAuth token
 * must not leave something behind that keeps sending after the token is gone.
 */

export const DEFAULT_MAX_ALERT_DESTINATIONS_PER_SITE = 5;

export interface DestinationRow {
  id: string;
  site_id: string;
  type: DestinationType;
  name: string | null;
  url_sealed: string | null;
  url_hash: string;
  url_hint: string | null;
  secret_sealed: string | null;
  last_status: string | null;
  last_error: string | null;
  last_delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

export const createDestinationInput = z.object({
  type: z
    .enum(DESTINATION_TYPES)
    .describe(
      "webhook: a signed JSON POST to your https endpoint. slack: a Slack incoming-webhook URL (https://hooks.slack.com/services/...). email: every member of this project (people who claimed it), when the deployment has email sending.",
    ),
  url: z.string().max(2000).optional().describe("webhook and slack: the URL (https, public host). Not for email."),
  name: z.string().max(120).optional().describe('A label, e.g. "Ops channel".'),
});

export function destinationJson(d: DestinationRow) {
  return {
    id: d.id,
    type: d.type,
    name: d.name,
    url: d.type === "email" ? null : { configured: true, hint: d.url_hint },
    ...(d.type === "webhook" ? { signing_secret: { configured: true } } : {}),
    last_status: d.last_status,
    last_error: d.last_error,
    last_delivered_at: d.last_delivered_at,
    created_at: d.created_at,
  };
}

export function emailConfigured(env: Bindings): boolean {
  return !!env.EMAIL && !!env.ALERT_EMAIL_FROM;
}

/** The email addresses of the account's members (people who claimed the project). */
export async function memberEmails(env: Bindings, accountId: string): Promise<string[]> {
  try {
    const { results } = await identityDb(env)
      .prepare("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.account_id = ? ORDER BY m.created_at LIMIT 20")
      .bind(accountId)
      .all<{ email: string }>();
    return results.map((r) => r.email).filter((e) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e));
  } catch {
    return []; // a deployment without the people tables has no members
  }
}

function requireKey(env: Bindings): string {
  if (!env.ENCRYPTION_KEY)
    throw new ApiError(
      503,
      "not_configured",
      "This deployment has no ENCRYPTION_KEY, so it can't store a webhook or Slack URL.",
      "Operator: set the ENCRYPTION_KEY secret on the analytics Worker (openssl rand -base64 32).",
    );
  return env.ENCRYPTION_KEY;
}

export async function loadDestinations(env: Bindings, siteId: string): Promise<DestinationRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM alert_destinations WHERE site_id = ? ORDER BY created_at")
    .bind(siteId)
    .all<DestinationRow>();
  return results;
}

/** Destination ids an alert or report names: all must exist on the site. */
export async function checkDestinationIds(env: Bindings, siteId: string, ids: string[]): Promise<string[]> {
  const known = new Set((await loadDestinations(env, siteId)).map((d) => d.id));
  const unique = [...new Set(ids)];
  const missing = unique.filter((id) => !known.has(id));
  if (missing.length)
    throw badRequest(
      `Unknown destination(s): ${missing.join(", ")}.`,
      known.size
        ? `Destinations on this site: ${[...known].join(", ")}.`
        : `Create one first: POST /v1/sites/${siteId}/destinations {"type":"slack","url":"https://hooks.slack.com/services/..."}.`,
    );
  return unique;
}

export async function createDestination(ctx: Ctx, siteId: string, raw: unknown) {
  assertPermanentKey(ctx.auth, "create alert destinations");
  const input = parse(createDestinationInput, raw);
  const site = await loadSite(ctx, siteId);
  const db = ctx.env.DB;
  let urlHash = "email";
  let url: string | null = null;
  if (input.type === "email") {
    if (input.url) throw badRequest("Email destinations take no url.", "They go to every member of this project (people who claimed it).");
    if (!emailConfigured(ctx.env))
      throw new ApiError(
        503,
        "not_configured",
        "This deployment doesn't send email (no EMAIL binding or ALERT_EMAIL_FROM).",
        "Use a webhook or Slack destination instead. Operator: add the send_email binding EMAIL and ALERT_EMAIL_FROM (an address on a domain onboarded for Cloudflare Email Sending).",
      );
    if (!(await memberEmails(ctx.env, ctx.accountId)).length)
      throw badRequest(
        "This project has no members to email yet.",
        "Email goes only to people who claimed the project (POST /v1/claim-link on the platform site, then sign in). Or use a webhook or Slack destination.",
      );
  } else {
    if (!input.url)
      throw badRequest(
        `A ${input.type} destination needs a url.`,
        input.type === "slack"
          ? "Create an incoming webhook in Slack (api.slack.com/messaging/webhooks) and pass its URL."
          : "Pass your https endpoint.",
      );
    // The request's own origin counts as the deployment too (PUBLIC_BASE_URL may be unset).
    const problem = destinationUrlProblem(input.url, input.type, { ...ctx.env, PUBLIC_BASE_URL: ctx.env.PUBLIC_BASE_URL || ctx.baseUrl });
    if (problem)
      throw badRequest(
        `That URL ${problem}.`,
        input.type === "slack"
          ? "Pass the incoming-webhook URL Slack gave you: https://hooks.slack.com/services/T.../B.../..."
          : "Use a public https:// endpoint on the default port (no IP addresses, no localhost, not this platform's own hosts). Redirects are not followed.",
      );
    url = new URL(input.url).toString();
    urlHash = await sha256Hex(`${input.type}|${url}`);
  }
  const existing = await db
    .prepare("SELECT * FROM alert_destinations WHERE site_id = ? AND url_hash = ?")
    .bind(site.id, urlHash)
    .first<DestinationRow>();
  if (existing)
    return {
      destination: destinationJson(existing),
      existing: true,
      ...(existing.type === "webhook"
        ? {
            note: "This webhook already exists; its signing secret was shown when it was created. Delete it and create it again for a new secret.",
          }
        : {}),
    };
  const max = siteCap(
    ctx.env,
    await accountStanding(ctx.env, ctx.accountId),
    "MAX_ALERT_DESTINATIONS_PER_SITE",
    DEFAULT_MAX_ALERT_DESTINATIONS_PER_SITE,
  );
  if (Number.isFinite(max)) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM alert_destinations WHERE site_id = ?").bind(site.id).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw quotaExceeded(
        `This site already has ${max} alert destinations, the most allowed here.`,
        "Delete one you no longer use (DELETE /v1/sites/:id/destinations/:destination_id); one destination can serve many alerts and reports.",
      );
  }
  const key = url ? requireKey(ctx.env) : null;
  const secret = input.type === "webhook" ? newSigningSecret() : null;
  const now = Date.now();
  const row: DestinationRow = {
    id: newId("dst"),
    site_id: site.id,
    type: input.type,
    name: input.name ?? null,
    url_sealed: url && key ? await encryptSecret(key, url) : null,
    url_hash: urlHash,
    url_hint: url ? urlHint(url) : null,
    secret_sealed: secret && key ? await encryptSecret(key, secret) : null,
    last_status: null,
    last_error: null,
    last_delivered_at: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        `INSERT INTO alert_destinations (id, site_id, type, name, url_sealed, url_hash, url_hint, secret_sealed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, row.site_id, row.type, row.name, row.url_sealed, row.url_hash, row.url_hint, row.secret_sealed, now, now)
      .run();
  } catch (e) {
    const other = await db
      .prepare("SELECT * FROM alert_destinations WHERE site_id = ? AND url_hash = ?")
      .bind(site.id, urlHash)
      .first<DestinationRow>();
    if (other) return { destination: destinationJson(other), existing: true };
    throw e;
  }
  return {
    destination: destinationJson(row),
    existing: false,
    ...(secret
      ? {
          signing_secret: secret,
          verify:
            'Each POST carries x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signing_secret, "<t>.<raw body>")>. Recompute it over the raw body and reject timestamps older than 5 minutes. This is the only time the secret is shown.',
        }
      : {}),
    next_steps: [
      `Send a test now: POST /v1/sites/${site.id}/destinations/${row.id}/test (MCP test_destination).`,
      `Alert on it: POST /v1/sites/${site.id}/alerts {"name":"Traffic spike","type":"traffic_spike","destination_ids":["${row.id}"]}.`,
      `Weekly digest: POST /v1/sites/${site.id}/reports {"name":"Weekly","cadence":"weekly","destination_ids":["${row.id}"]}.`,
    ],
  };
}

export async function listDestinations(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  return { destinations: (await loadDestinations(ctx.env, site.id)).map(destinationJson), email_available: emailConfigured(ctx.env) };
}

export async function deleteDestination(ctx: Ctx, siteId: string, id: string) {
  const site = await loadSite(ctx, siteId);
  const res = await ctx.env.DB.prepare("DELETE FROM alert_destinations WHERE id = ? AND site_id = ?").bind(id, site.id).run();
  if (!res.meta.changes) throw notFound("Destination", `GET /v1/sites/${site.id}/destinations lists this site's destinations.`);
  return { deleted: id, note: "Alerts and reports that named it skip it from now on." };
}

/** The URL and signing secret of a destination, unsealed for one delivery. */
export async function unsealDestination(env: Bindings, d: DestinationRow): Promise<{ url: string | null; secret: string | null }> {
  if (d.type === "email") return { url: null, secret: null };
  if (!env.ENCRYPTION_KEY || !d.url_sealed) throw new Error("ENCRYPTION_KEY missing or destination not sealed");
  return {
    url: await decryptSecret(env.ENCRYPTION_KEY, d.url_sealed),
    secret: d.secret_sealed ? await decryptSecret(env.ENCRYPTION_KEY, d.secret_sealed) : null,
  };
}

/** Send a test message to one destination now (counts against the daily delivery budget). */
export async function testDestination(ctx: Ctx, siteId: string, id: string, opts: { fetcher?: Fetcher } = {}) {
  const site = await loadSite(ctx, siteId);
  const d = await ctx.env.DB.prepare("SELECT * FROM alert_destinations WHERE id = ? AND site_id = ?")
    .bind(id, site.id)
    .first<DestinationRow>();
  if (!d) throw notFound("Destination", `GET /v1/sites/${site.id}/destinations lists this site's destinations.`);
  const sent = await deliver(
    ctx.env,
    site,
    [d.id],
    {
      kind: "test",
      type: "test",
      title: `[${site.domain}] Test from AgentFirstStack Analytics`,
      lines: ["This destination works: alerts and reports for this site will arrive here."],
      data: { destination_id: d.id, test: true },
    },
    opts,
  );
  return {
    test: true,
    ...sent,
    next_steps: sent.status === "delivered" ? [] : ["See deliveries[].error; fix the endpoint and test again."],
  };
}
