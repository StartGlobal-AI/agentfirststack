/**
 * Polar, Paddle and LemonSqueezy: one signed webhook per site and provider
 * (POST /webhooks/<provider>/<site_id>), feeding the same payments and subscriptions as Stripe.
 * The signing secret is sealed with ENCRYPTION_KEY (never returned). Signature schemes and the
 * mapping of each provider's events: lib/billing.ts.
 */

import { ApiError, assertPermanentKey, decryptSecret, encryptSecret, newId, notFound, parse, randomString } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { readTextCapped } from "../lib/body";
import {
  BILLING_PROVIDERS,
  BILLING_TOLERANCE_S,
  type BillingAction,
  type BillingProvider,
  normalizeLemonSqueezy,
  normalizePaddle,
  normalizePolar,
  verifyBilling,
} from "../lib/billing";
import { hashCustomer } from "../lib/customer";
import { allow, limitVars } from "../lib/limits";
import type { PaymentInput } from "../lib/types";
import type { SubscriptionRecord } from "../do/subscriptions";
import { type Ctx, type SiteRow, SITE_ID_RE, callSite, loadSite } from "./context";
import { convertRecords } from "./fx";
import { refusalError } from "./ingest";
import { MAX_WEBHOOK_BYTES, takeStatusWrite } from "./payments";
import { ingestSubscriptionStates } from "./subscriptions";

export const providerParam = z.enum(BILLING_PROVIDERS);

const NAMES: Record<BillingProvider, string> = { polar: "Polar", paddle: "Paddle", lemonsqueezy: "LemonSqueezy" };

/** What to subscribe the provider's webhook to, and where its secret is. */
export const BILLING_SETUP: Record<BillingProvider, { events: string[]; secret: string; where: string; sandbox: string }> = {
  polar: {
    events: [
      "order.paid",
      "order.refunded",
      "subscription.created",
      "subscription.updated",
      "subscription.active",
      "subscription.canceled",
      "subscription.uncanceled",
      "subscription.revoked",
      "subscription.past_due",
      "subscription.paused",
      "subscription.resumed",
    ],
    secret: "whsec_... (the endpoint's secret)",
    where: "Polar dashboard -> Settings -> Webhooks -> Add Endpoint (format Raw), or POST https://api.polar.sh/v1/webhooks/endpoints",
    sandbox: "a sandbox.polar.sh organization",
  },
  paddle: {
    events: [
      "transaction.completed",
      "adjustment.created",
      "adjustment.updated",
      "subscription.created",
      "subscription.updated",
      "subscription.activated",
      "subscription.trialing",
      "subscription.past_due",
      "subscription.paused",
      "subscription.resumed",
      "subscription.canceled",
    ],
    secret: "pdl_ntfset_... (the notification destination's secret key)",
    where:
      "Paddle dashboard -> Developer tools -> Notifications -> New destination (type webhook), or POST https://api.paddle.com/notification-settings",
    sandbox: "sandbox-vendors.paddle.com",
  },
  lemonsqueezy: {
    events: [
      "order_created",
      "order_refunded",
      "subscription_created",
      "subscription_updated",
      "subscription_cancelled",
      "subscription_resumed",
      "subscription_expired",
      "subscription_paused",
      "subscription_unpaused",
      "subscription_payment_success",
      "subscription_payment_refunded",
    ],
    secret: "the signing secret you type when creating the webhook (6-40 characters)",
    where: "LemonSqueezy dashboard -> Settings -> Webhooks -> +, or POST https://api.lemonsqueezy.com/v1/webhooks",
    sandbox: "test mode (events carry test_mode: true)",
  },
};

interface Row {
  id: string;
  site_id: string;
  provider: string;
  secret_sealed: string;
  options: string | null;
  events_received: number;
  last_event_at: number | null;
  last_event_type: string | null;
  last_event_livemode: number | null;
  last_result: string | null;
  last_error: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
  sig_fail_window?: number | null;
  sig_fail_count?: number | null;
}

type Options = { sandbox?: boolean; record_test_events?: boolean };
const optionsOf = (r: Row | null): Options => (r?.options ? (JSON.parse(r.options) as Options) : {});

const rowOf = (env: Bindings, siteId: string, provider: BillingProvider) =>
  env.DB.prepare("SELECT * FROM integrations WHERE site_id = ? AND provider = ?").bind(siteId, provider).first<Row>();

const webhookUrl = (baseUrl: string, provider: BillingProvider, siteId: string) => `${baseUrl}/webhooks/${provider}/${siteId}`;

function status(ctx: Ctx, site: SiteRow, provider: BillingProvider, row: Row | null) {
  const setup = BILLING_SETUP[provider];
  const o = optionsOf(row);
  return {
    provider,
    connected: !!row,
    webhook_url: webhookUrl(ctx.baseUrl, provider, site.id),
    events: setup.events,
    signing_secret: { configured: !!row, format: setup.secret },
    sandbox: !!o.sandbox,
    record_test_events: !!o.record_test_events,
    ...(provider === "lemonsqueezy" ? {} : { signature_tolerance_s: BILLING_TOLERANCE_S }),
    connected_at: row?.created_at ?? null,
    events_received: row?.events_received ?? 0,
    last_event_at: row?.last_event_at ?? null,
    last_event_type: row?.last_event_type ?? null,
    last_result: row?.last_result ?? null,
    last_error: row?.last_error ?? null,
  };
}

function steps(ctx: Ctx, site: SiteRow, provider: BillingProvider, connected: boolean): string[] {
  const s = BILLING_SETUP[provider];
  const url = webhookUrl(ctx.baseUrl, provider, site.id);
  const link =
    provider === "polar"
      ? "Link checkouts to visitors: create the checkout with metadata {afs_visitor_id: afsa.visitorId()} (it is copied to the order and subscription), or set the customer's external_id to your user id."
      : provider === "paddle"
        ? "Link checkouts to visitors: pass customData {afs_visitor_id: afsa.visitorId()} to Paddle.Checkout.open (or custom_data on the transaction); subscriptions inherit it."
        : "Link checkouts to visitors: add checkout[custom][afs_visitor_id]=<afsa.visitorId()> to the checkout URL (or checkout_data.custom in the API).";
  return connected
    ? [
        `Send a test event from ${NAMES[provider]} to ${url}, then GET /v1/sites/${site.id}/integrations/${provider}: events_received and last_result say what happened.`,
        link,
        `GET /v1/sites/${site.id}/payments and /v1/sites/${site.id}/mrr show what arrived.`,
      ]
    : [
        `In ${s.where}: URL ${url}, events ${s.events.join(", ")}.`,
        `POST /v1/sites/${site.id}/integrations/${provider} {"webhook_secret":"${s.secret.split(" ")[0]}"} with its secret.`,
        link,
      ];
}

export async function getBillingIntegration(ctx: Ctx, siteId: string, provider: string) {
  const p = parse(providerParam, provider);
  const site = await loadSite(ctx, siteId);
  const row = await rowOf(ctx.env, site.id, p);
  return { site_id: site.id, integration: status(ctx, site, p, row), next_steps: steps(ctx, site, p, !!row) };
}

/** LemonSqueezy secrets are chosen by the user: at least this long (a generated one is 40). */
export const MIN_LS_SECRET = 20;
/** Failed webhook signatures per integration in a 10-minute window, then 429 until it ends. */
export const MAX_SIGNATURE_FAILURES = 20;
const FAIL_WINDOW_MS = 10 * 60_000;

export const connectBillingInput = z.object({
  webhook_secret: z
    .string()
    .min(6)
    .max(200)
    .optional()
    .describe(
      "The webhook's signing secret (sealed at rest, never returned). Polar and Paddle: the one they show. LemonSqueezy: leave it out and we generate one (shown once, to paste into the webhook's Signing secret), or give your own of 20+ characters.",
    ),
  sandbox: z.boolean().optional().describe("Polar / Paddle: this is a sandbox account; its payments count as test (livemode false)."),
  record_test_events: z
    .boolean()
    .optional()
    .describe(
      "Count test-mode / sandbox payments and subscriptions (stored with livemode false). Default: true for a sandbox, else false.",
    ),
});

export async function connectBilling(ctx: Ctx, siteId: string, provider: string, raw: unknown) {
  const p = parse(providerParam, provider);
  // The secret keeps writing payments into the site after a connected app's token is gone.
  assertPermanentKey(ctx.auth, `connect ${NAMES[p]}`);
  const input = parse(connectBillingInput, raw);
  if (!ctx.env.ENCRYPTION_KEY)
    throw new ApiError(
      503,
      "not_configured",
      `This deployment has no ENCRYPTION_KEY, so it can't store a ${NAMES[p]} signing secret.`,
      "Operator: set the ENCRYPTION_KEY secret (openssl rand -base64 32). Until then send payments with POST /v1/sites/:id/payments and subscriptions with POST /v1/sites/:id/subscriptions.",
    );
  if (p !== "lemonsqueezy" && !input.webhook_secret)
    throw new ApiError(
      400,
      "missing_secret",
      `${NAMES[p]} shows the webhook's signing secret: send it as webhook_secret.`,
      BILLING_SETUP[p].where,
    );
  if (p === "lemonsqueezy" && input.webhook_secret && input.webhook_secret.length < MIN_LS_SECRET)
    throw new ApiError(
      400,
      "weak_secret",
      `A LemonSqueezy signing secret must be at least ${MIN_LS_SECRET} characters.`,
      "Leave webhook_secret out and we generate a strong one (shown once), or choose a random one of 20+ characters.",
    );
  if (p === "polar" && !input.webhook_secret!.startsWith("whsec_"))
    throw new ApiError(
      400,
      "invalid_secret",
      "A Polar webhook secret starts with whsec_.",
      "Copy the secret shown for the endpoint in Polar -> Settings -> Webhooks.",
    );
  if (p === "paddle" && !input.webhook_secret!.startsWith("pdl_ntfset_"))
    throw new ApiError(
      400,
      "invalid_secret",
      "A Paddle notification secret starts with pdl_ntfset_.",
      "Copy the secret key of the notification destination in Paddle -> Developer tools -> Notifications.",
    );
  const site = await loadSite(ctx, siteId);
  const row = await rowOf(ctx.env, site.id, p);
  // LemonSqueezy without a secret: connected already = nothing changes (retries are safe); else
  // a strong one is generated and shown in this answer only.
  let generated: string | null = null;
  if (!input.webhook_secret) {
    if (row)
      return {
        site_id: site.id,
        integration: status(ctx, site, p, row),
        existing: true,
        note: "Already connected; the signing secret was shown when it was created. To replace it, send webhook_secret (20+ characters), or DELETE the integration and connect again for a new generated one.",
        next_steps: steps(ctx, site, p, true),
      };
    generated = randomString(40);
  }
  const secret = input.webhook_secret ?? generated!;
  // A sandbox account is connected to be tested: its events count unless told otherwise.
  const options = JSON.stringify({ sandbox: !!input.sandbox, record_test_events: input.record_test_events ?? !!input.sandbox });
  const now = Date.now();
  let existing = false;
  if (row) {
    let same = false;
    try {
      same = (await decryptSecret(ctx.env.ENCRYPTION_KEY, row.secret_sealed)) === secret;
    } catch {
      same = false;
    }
    existing = same && row.options === options;
    if (!existing)
      await ctx.env.DB.prepare("UPDATE integrations SET secret_sealed = ?, options = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(same ? row.secret_sealed : await encryptSecret(ctx.env.ENCRYPTION_KEY, secret), options, now, row.id)
        .run();
  } else {
    await ctx.env.DB.prepare(
      "INSERT INTO integrations (id, site_id, provider, secret_sealed, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, provider) DO UPDATE SET secret_sealed = excluded.secret_sealed, options = excluded.options, updated_at = excluded.updated_at",
    )
      .bind(newId("int"), site.id, p, await encryptSecret(ctx.env.ENCRYPTION_KEY, secret), options, now, now)
      .run();
  }
  return {
    site_id: site.id,
    integration: status(ctx, site, p, await rowOf(ctx.env, site.id, p)),
    existing,
    ...(existing ? { note: "Already connected with this signing secret; nothing changed." } : {}),
    ...(generated
      ? {
          webhook_secret: generated,
          secret_note:
            "Shown once: it is sealed at rest and never returned again. Paste it into the LemonSqueezy webhook's Signing secret now.",
        }
      : {}),
    next_steps: [
      ...(generated
        ? [
            `In LemonSqueezy (Settings -> Webhooks), create the webhook with URL ${webhookUrl(ctx.baseUrl, p, site.id)} and paste this webhook_secret as its Signing secret.`,
          ]
        : []),
      ...steps(ctx, site, p, true),
    ],
  };
}

export async function disconnectBilling(ctx: Ctx, siteId: string, provider: string) {
  const p = parse(providerParam, provider);
  const site = await loadSite(ctx, siteId);
  const res = await ctx.env.DB.prepare("DELETE FROM integrations WHERE site_id = ? AND provider = ?").bind(site.id, p).run();
  if (!res.meta.changes)
    throw notFound(`${NAMES[p]} integration`, `Nothing to disconnect. GET /v1/sites/${site.id}/integrations/${p} shows how to connect.`);
  return {
    disconnected: true,
    note: `The signing secret is deleted; deliveries to this site's ${NAMES[p]} webhook URL are now rejected (400 webhook_rejected). Recorded payments and subscriptions are kept. Remove the webhook in ${NAMES[p]} too.`,
  };
}

// ------------------------------------------------------------------ the webhook (public, signed)

export interface BillingWebhookResult {
  status: 200 | 400 | 413 | 429 | 503;
  body: Record<string, unknown>;
}

const fail = (status: BillingWebhookResult["status"], code: string, hint: string): BillingWebhookResult => ({
  status,
  body: { error: { code, message: code.replaceAll("_", " "), hint } },
});
/** One answer for every unauthenticated failure (unknown site or provider, no secret, bad signature). */
const REJECTED = fail(
  400,
  "webhook_rejected",
  "Signature verification failed for this endpoint. Check that the URL is the webhook_url from GET /v1/sites/:id/integrations/<provider>, that the connected secret is the webhook's current one, and the clock (5 minute tolerance).",
);

export async function billingWebhook(
  env: Bindings,
  provider: string,
  siteId: string,
  req: Request,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<BillingWebhookResult> {
  const p = providerParam.safeParse(provider);
  if (!p.success) return REJECTED;
  const prov = p.data;
  if (!env.ENCRYPTION_KEY) return fail(503, "not_configured", "The deployment's ENCRYPTION_KEY is missing; the operator must set it.");
  if (!(await allow(env.WEBHOOK_LIMITER, `${prov}:${siteId}`)))
    return fail(429, "rate_limited", "Too many deliveries for this endpoint; the provider retries later.");
  if (Number(req.headers.get("content-length")) > MAX_WEBHOOK_BYTES)
    return fail(413, "payload_too_large", "Webhook bodies are capped at 1 MB.");
  const { text, truncated } = await readTextCapped(req.body, MAX_WEBHOOK_BYTES);
  if (truncated) return fail(413, "payload_too_large", "Webhook bodies are capped at 1 MB.");
  if (!SITE_ID_RE.test(siteId)) return REJECTED;
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
  const row = site ? await rowOf(env, site.id, prov) : null;
  if (!site || !row) return REJECTED;
  const now = Date.now();
  const win = Math.floor(now / FAIL_WINDOW_MS);
  const write = (sql: string, ...args: (string | number | null)[]) =>
    waitUntil(
      env.DB.prepare(sql)
        .bind(...args, row.id)
        .run()
        .catch(() => {}),
    );
  let secret: string;
  try {
    secret = await decryptSecret(env.ENCRYPTION_KEY, row.secret_sealed);
  } catch {
    if (row.last_error !== "secret_unreadable")
      write("UPDATE integrations SET last_error = ?, last_error_at = ? WHERE id = ?", "secret_unreadable", now);
    return REJECTED;
  }
  // A correctly signed delivery always goes through, so junk deliveries can't hold up real ones.
  // Bad signatures are counted per site and provider; past the limit they get a 429 instead of a 400.
  // (The secrets are long enough that guessing them is not practical: the count slows noise.)
  const sig = await verifyBilling(prov, text, req.headers, secret, now);
  if (!sig.ok) {
    const failures = row.sig_fail_window === win ? (row.sig_fail_count ?? 0) + 1 : 1;
    await env.DB.prepare(
      "UPDATE integrations SET sig_fail_count = CASE WHEN sig_fail_window = ? THEN sig_fail_count + 1 ELSE 1 END, sig_fail_window = ? WHERE id = ?",
    )
      .bind(win, win, row.id)
      .run()
      .catch(() => {});
    if (failures > MAX_SIGNATURE_FAILURES)
      return {
        status: 429,
        body: {
          error: {
            code: "rate_limited",
            message: "Too many deliveries with a bad signature for this endpoint.",
            hint: "Correctly signed deliveries are still accepted. Check that the connected secret is the webhook's current one.",
          },
          retry_after: Math.ceil(((win + 1) * FAIL_WINDOW_MS - now) / 1000),
        },
      };
    return REJECTED;
  }
  // Authenticated from here on.
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return fail(400, "invalid_json", "The body is not JSON.");
  }
  const o = optionsOf(row);
  const live = !o.sandbox;
  const action: BillingAction =
    prov === "polar"
      ? normalizePolar(event, sig.event_id, live)
      : prov === "paddle"
        ? normalizePaddle(event, live)
        : normalizeLemonSqueezy(event, req.headers.get("x-event-name"));
  const type = String(
    (event as Record<string, unknown>)?.type ??
      (event as Record<string, unknown>)?.event_type ??
      ((event as Record<string, Record<string, unknown>>)?.meta?.event_name as string) ??
      "",
  ).slice(0, 100);
  const mark = (result: string, livemode: boolean) => {
    const n = takeStatusWrite(row.id, now);
    if (n === null) return;
    write(
      "UPDATE integrations SET events_received = events_received + ?, last_event_at = ?, last_event_type = ?, last_event_livemode = ?, last_result = ?, last_error = NULL, updated_at = ? WHERE id = ?",
      n,
      now,
      type,
      livemode ? 1 : 0,
      result.slice(0, 200),
      now,
    );
  };
  const payments = action.payments.filter((x) => x.livemode || o.record_test_events);
  const subs = action.subscriptions.filter((x) => x.livemode || o.record_test_events);
  if (action.ignored || (!payments.length && !subs.length)) {
    const why = action.ignored ?? "test mode (connect with record_test_events: true to count it)";
    mark(`ignored: ${why}`, live);
    return { status: 200, body: { received: true, ignored: why } };
  }
  const hashed = await Promise.all(
    payments.map(
      async (x): Promise<PaymentInput> => ({ ...x, customer: x.customer ? await hashCustomer(site.id, prov, x.customer) : null }),
    ),
  );
  const states = await Promise.all(
    subs.map(
      async ({ customer_raw, ...x }): Promise<SubscriptionRecord> => ({
        ...x,
        customer: customer_raw ? await hashCustomer(site.id, prov, customer_raw) : null,
      }),
    ),
  );
  const results: Record<string, unknown> = {};
  if (hashed.length) {
    const converted = await convertRecords(env, site, hashed);
    const res = await callSite(env, site, (s) => s.ingestPayments(converted, { vars: limitVars(env) }));
    if (res.refused) {
      mark(`refused: ${res.refused} (the provider retries)`, live);
      return { status: 429, body: refusalError(env, res.refused).toJSON() };
    }
    results.payments = res.results;
  }
  if (states.length) {
    const res = await ingestSubscriptionStates(env, site, states);
    if (res.refused) {
      mark(`refused: ${res.refused} (the provider retries)`, live);
      return { status: 429, body: refusalError(env, res.refused as never).toJSON() as Record<string, unknown> };
    }
    results.subscriptions = res.results;
  }
  const pay = (results.payments as { duplicate_event?: boolean; linked_by?: string | null }[] | undefined)?.[0];
  const sub = (results.subscriptions as { changes?: string[]; stale?: boolean }[] | undefined)?.[0];
  mark(
    pay
      ? pay.duplicate_event
        ? "duplicate event"
        : `recorded ${hashed[0]!.type} (${pay.linked_by ?? "unattributed"})`
      : sub
        ? `subscription ${states[0]!.kind === "invoice" ? "invoice" : states[0]!.status}: ${sub.stale ? "older than the stored state" : sub.changes?.join(", ") || "unchanged"}`
        : "ok",
    hashed[0]?.livemode ?? states[0]?.livemode ?? live,
  );
  return { status: 200, body: { received: true, ...results } };
}
