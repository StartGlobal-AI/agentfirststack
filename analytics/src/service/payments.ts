import { ApiError, decryptSecret, encryptSecret, newId, notFound, parse, sha256Hex } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { readTextCapped } from "../lib/body";
import { STRIPE_EVENTS, STRIPE_OPTIONAL_EVENTS, STRIPE_TOLERANCE_S, normalizeStripeEvent, verifyStripeSignature } from "../lib/stripe";
import { PERIODS } from "../lib/time";
import type { PaymentInput } from "../lib/types";
import { SESSION_ID_RE, VISITOR_ID_RE } from "../lib/visitor";
import { type Ctx, type PaymentsSummary, type SiteRow, SITE_ID_RE, callSite, loadSite } from "./context";

/**
 * Revenue attribution. Two ways in, one ledger (the site's Durable Object, do/payments.ts):
 *   - Stripe: a signed webhook per site (POST /webhooks/stripe/:site_id), secret sealed with
 *     ENCRYPTION_KEY, event ids deduped, refunds and renewals understood.
 *   - Any other provider: POST /v1/sites/:id/payments, idempotent by (provider, id).
 * Payments find their visitor through metadata.afs_visitor_id (from afsa.visitorId()),
 * client_reference_id, a user id, or an earlier payment of the same customer.
 */

export const MAX_WEBHOOK_BYTES = 1024 * 1024;

const webhookUrl = (baseUrl: string, siteId: string) => `${baseUrl}/webhooks/stripe/${siteId}`;

/** Provider customer ids are stored only as a per-site salted hash (enough to link renewals). */
export const hashCustomer = async (siteId: string, provider: string, id: string) =>
  (await sha256Hex(`${siteId}|customer|${provider}|${id}`)).slice(0, 32);

interface IntegrationRow {
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
}

const optionsOf = (r: IntegrationRow | null) => (r?.options ? (JSON.parse(r.options) as { record_test_events?: boolean }) : {});

/** How to link a payment to the visitor: the same text in install instructions and the Stripe status. */
export function linkingInstructions() {
  return {
    helper: "afsa.visitorId()  // in the browser, after the first pageview: the visitor id to attach to the payment",
    stripe_checkout:
      "Pass afsa.visitorId() to your server and create the Checkout Session with metadata: { afs_visitor_id: <id> } (subscriptions: also subscription_data: { metadata: { afs_visitor_id: <id> } } so renewals keep it), or client_reference_id: <id>.",
    stripe_payment_links: "Append ?client_reference_id=<afsa.visitorId()> to the Payment Link URL.",
    stripe_payment_intents:
      "Your own PaymentIntents: set metadata.afs_visitor_id and also enable the payment_intent.succeeded event on the webhook.",
    user_ids: "If you identify users (afsa('identify', id)), client_reference_id or metadata.afs_user_id set to that user id links too.",
    other_providers: "POST /v1/sites/:id/payments with visitor_id (or session_id / user_id / customer_id).",
  };
}

function stripeStatus(ctx: Ctx, site: SiteRow, row: IntegrationRow | null, summary: PaymentsSummary | null) {
  return {
    provider: "stripe",
    connected: !!row,
    webhook_url: webhookUrl(ctx.baseUrl, site.id),
    events: [...STRIPE_EVENTS],
    optional_events: [...STRIPE_OPTIONAL_EVENTS],
    signing_secret: { configured: !!row },
    record_test_events: !!optionsOf(row).record_test_events,
    signature_tolerance_s: STRIPE_TOLERANCE_S,
    connected_at: row?.created_at ?? null,
    updated_at: row?.updated_at ?? null,
    events_received: row?.events_received ?? 0,
    last_event_at: row?.last_event_at ?? null,
    last_event_type: row?.last_event_type ?? null,
    last_event_livemode: row?.last_event_livemode == null ? null : !!row.last_event_livemode,
    last_result: row?.last_result ?? null,
    last_error: row?.last_error ?? null,
    last_error_at: row?.last_error_at ?? null,
    payments: summary,
    linking: linkingInstructions(),
  };
}

async function integrationRow(env: Bindings, siteId: string): Promise<IntegrationRow | null> {
  return env.DB.prepare("SELECT * FROM integrations WHERE site_id = ? AND provider = 'stripe'").bind(siteId).first<IntegrationRow>();
}

async function summaryOf(ctx: Ctx, site: SiteRow): Promise<PaymentsSummary | null> {
  try {
    return (await callSite(
      ctx.env,
      site,
      (s) => s.paymentsSummary() as Promise<PaymentsSummary & Record<string, unknown>>,
    )) as PaymentsSummary;
  } catch {
    return null;
  }
}

function requireEncryptionKey(env: Bindings): string {
  if (!env.ENCRYPTION_KEY)
    throw new ApiError(
      503,
      "not_configured",
      "This deployment has no ENCRYPTION_KEY, so it can't store a Stripe signing secret.",
      "Operator: set the ENCRYPTION_KEY secret on the analytics Worker (32 bytes, base64: openssl rand -base64 32). Until then send payments with POST /v1/sites/:id/payments.",
    );
  return env.ENCRYPTION_KEY;
}

export const connectStripeInput = z.object({
  webhook_secret: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/=_-]{8,200}$/, "a Stripe webhook signing secret (whsec_...)")
    .describe("The endpoint's signing secret (whsec_...), from Stripe after you add webhook_url as an endpoint."),
  record_test_events: z
    .boolean()
    .optional()
    .describe("Store test-mode (livemode: false) payments too. Default false: test events are verified and acknowledged, not counted."),
});

function stripeSteps(ctx: Ctx, site: SiteRow, connected: boolean): string[] {
  const url = webhookUrl(ctx.baseUrl, site.id);
  return connected
    ? [
        `Link payments to visitors: ${linkingInstructions().stripe_checkout}`,
        "Send a test: `stripe trigger checkout.session.completed` (test events count only with record_test_events: true), or make a real payment.",
        `Check delivery: GET /v1/sites/${site.id}/integrations/stripe (events_received, last_result, last_error); payments: GET /v1/sites/${site.id}/payments.`,
        `Revenue by source: GET /v1/sites/${site.id}/breakdown?breakdown=channel&metrics=visitors,revenue,revenue_per_visitor,purchase_rate&sort=revenue.`,
      ]
    : [
        `In Stripe, add a webhook endpoint with URL ${url} and events ${STRIPE_EVENTS.join(", ")} (Stripe API: POST /v1/webhook_endpoints {url, enabled_events}).`,
        `Then POST /v1/sites/${site.id}/integrations/stripe {"webhook_secret": "whsec_..."} with the endpoint's signing secret.`,
      ];
}

export async function getStripeIntegration(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const row = await integrationRow(ctx.env, site.id);
  return {
    site_id: site.id,
    integration: stripeStatus(ctx, site, row, row ? await summaryOf(ctx, site) : null),
    next_steps: stripeSteps(ctx, site, !!row),
  };
}

export async function connectStripe(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(connectStripeInput, raw);
  const key = requireEncryptionKey(ctx.env);
  const site = await loadSite(ctx, siteId);
  const db = ctx.env.DB;
  const row = await integrationRow(ctx.env, site.id);
  const now = Date.now();
  const options = JSON.stringify({ record_test_events: !!input.record_test_events });
  let existing = false;
  if (row) {
    let same = false;
    try {
      same = (await decryptSecret(key, row.secret_sealed)) === input.webhook_secret;
    } catch {
      same = false; // sealed with a key that changed: replace it
    }
    existing = same && row.options === options;
    if (!existing) {
      const sealed = same ? row.secret_sealed : await encryptSecret(key, input.webhook_secret);
      await db
        .prepare("UPDATE integrations SET secret_sealed = ?, options = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(sealed, options, now, row.id)
        .run();
    }
  } else {
    await db
      .prepare(
        "INSERT INTO integrations (id, site_id, provider, secret_sealed, options, created_at, updated_at) VALUES (?, ?, 'stripe', ?, ?, ?, ?) ON CONFLICT(site_id, provider) DO UPDATE SET secret_sealed = excluded.secret_sealed, options = excluded.options, updated_at = excluded.updated_at",
      )
      .bind(newId("int"), site.id, await encryptSecret(key, input.webhook_secret), options, now, now)
      .run();
  }
  const fresh = await integrationRow(ctx.env, site.id);
  return {
    site_id: site.id,
    integration: stripeStatus(ctx, site, fresh, await summaryOf(ctx, site)),
    existing,
    ...(existing ? { note: "Already connected with this signing secret; nothing changed." } : {}),
    next_steps: stripeSteps(ctx, site, true),
  };
}

export async function disconnectStripe(ctx: Ctx, siteId: string) {
  const site = await loadSite(ctx, siteId);
  const res = await ctx.env.DB.prepare("DELETE FROM integrations WHERE site_id = ? AND provider = 'stripe'").bind(site.id).run();
  if (!res.meta.changes)
    throw notFound("Stripe integration", `Nothing to disconnect. GET /v1/sites/${site.id}/integrations/stripe shows how to connect.`);
  return {
    disconnected: true,
    note: "The signing secret is deleted; webhooks to this site's URL now get 404. Payments already recorded are kept (DELETE /v1/sites/:id/payments/:payment_id removes one).",
  };
}

// ------------------------------------------------------------------ webhook (public, signed)

export interface WebhookResult {
  status: 200 | 400 | 404 | 413 | 503;
  body: Record<string, unknown>;
}

const fail = (status: WebhookResult["status"], error: string, hint: string): WebhookResult => ({
  status,
  body: { error: { code: error, message: error.replaceAll("_", " "), hint } },
});

export async function stripeWebhook(
  env: Bindings,
  siteId: string,
  req: Request,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<WebhookResult> {
  if (!SITE_ID_RE.test(siteId))
    return fail(404, "not_found", "The webhook URL is /webhooks/stripe/<site id> (from GET /v1/sites/:id/integrations/stripe).");
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
  const row = site ? await integrationRow(env, site.id) : null;
  if (!site || !row)
    return fail(404, "not_found", "No Stripe integration for this site. Connect it with POST /v1/sites/:id/integrations/stripe.");
  if (!env.ENCRYPTION_KEY) return fail(503, "not_configured", "The deployment's ENCRYPTION_KEY is missing; the operator must set it.");
  if (Number(req.headers.get("content-length")) > MAX_WEBHOOK_BYTES)
    return fail(413, "payload_too_large", "Stripe events are far smaller than 1 MB.");
  const { text, truncated } = await readTextCapped(req.body, MAX_WEBHOOK_BYTES);
  if (truncated) return fail(413, "payload_too_large", "Stripe events are far smaller than 1 MB.");
  const now = Date.now();
  const status = (sql: string, ...args: (string | number | null)[]) =>
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
    status("UPDATE integrations SET last_error = ?, last_error_at = ? WHERE id = ?", "secret_unreadable", now);
    return fail(
      503,
      "secret_unreadable",
      "The stored signing secret can't be decrypted (ENCRYPTION_KEY changed). Connect Stripe again with the secret.",
    );
  }
  const sig = await verifyStripeSignature(text, req.headers.get("stripe-signature"), secret, now);
  if (!sig.ok) {
    status("UPDATE integrations SET last_error = ?, last_error_at = ? WHERE id = ?", sig.reason, now);
    return fail(
      400,
      sig.reason,
      sig.reason === "timestamp_outside_tolerance"
        ? `The Stripe-Signature timestamp is more than ${STRIPE_TOLERANCE_S}s from now.`
        : "Stripe-Signature does not match the connected signing secret. Re-connect with the endpoint's current whsec_ secret.",
    );
  }
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return fail(400, "invalid_json", "The body is not JSON.");
  }
  const action = normalizeStripeEvent(event);
  const ev = event as { type?: string; livemode?: boolean };
  const mark = (result: string) =>
    status(
      "UPDATE integrations SET events_received = events_received + 1, last_event_at = ?, last_event_type = ?, last_event_livemode = ?, last_result = ?, last_error = NULL, updated_at = ? WHERE id = ?",
      now,
      String(ev.type ?? "").slice(0, 100),
      ev.livemode === true ? 1 : 0,
      result.slice(0, 200),
      now,
    );
  if (action.action === "ignore") {
    mark(`ignored: ${action.reason}`);
    return { status: 200, body: { received: true, ignored: action.reason } };
  }
  const rec = action.record;
  if (!rec.livemode && !optionsOf(row).record_test_events) {
    mark("ignored: test mode (connect with record_test_events: true to count test payments)");
    return { status: 200, body: { received: true, ignored: "test_mode" } };
  }
  const record: PaymentInput = { ...rec, customer: rec.customer ? await hashCustomer(site.id, "stripe", rec.customer) : null };
  const res = await callSite(env, site, (s) => s.ingestPayments([record]));
  const out = res.results[0]!;
  mark(
    out.duplicate_event
      ? "duplicate event"
      : rec.type === "link"
        ? `linked customer (${out.linked_by ?? "no visitor yet"})`
        : `recorded ${rec.type} (${out.linked_by ?? "unattributed"})`,
  );
  return { status: 200, body: { received: true, result: out } };
}

// ------------------------------------------------------------------ payments API (any provider)

const paymentSchema = z.object({
  id: z.string().min(1).max(200).describe("The provider's payment id (natural key with provider: sending it again changes nothing)."),
  provider: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .optional()
    .describe('e.g. "paddle", "lemonsqueezy", "polar", "shopify". Default "api".'),
  amount: z.number().min(-1e9).max(1e9).describe("In major units (49.00, not 4900). Refunds: the amount refunded (positive or negative)."),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  type: z
    .enum(["new", "renewal", "refund"])
    .optional()
    .describe("new (default; negative amount = refund), renewal (subscription renewal) or refund."),
  timestamp: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("When it was paid: unix ms or ISO 8601. Default now. Within the site's retention."),
  visitor_id: z.string().regex(VISITOR_ID_RE).optional().describe("From afsa.visitorId() in the browser."),
  session_id: z.string().regex(SESSION_ID_RE).optional().describe("A session id (from server event results)."),
  user_id: z.string().max(200).optional().describe("Your user id, if you identify users with afsa('identify', id)."),
  customer_id: z
    .string()
    .max(200)
    .optional()
    .describe("The provider's customer id: renewals of the same customer keep the first payment's source."),
  refunded_payment_id: z
    .string()
    .max(200)
    .optional()
    .describe("Refunds: the id of the payment being refunded (links the refund to its source)."),
  livemode: z.boolean().optional().describe("false for test payments (stored, shown as livemode: false). Default true."),
});

export const recordPaymentsInput = z.union([
  z.object({ payments: z.array(paymentSchema).min(1).max(100) }),
  paymentSchema.transform((p) => ({ payments: [p] })),
]);
export const paymentsShape = { payments: z.array(paymentSchema).min(1).max(100) };

export async function recordPayments(ctx: Ctx, siteId: string, raw: unknown) {
  const { payments } = parse(recordPaymentsInput, raw);
  const site = await loadSite(ctx, siteId);
  const now = Date.now();
  const oldest = now - site.retention_days * 86_400_000;
  const prepared = await Promise.all(
    payments.map(async (p): Promise<PaymentInput | string> => {
      const ts = p.timestamp == null ? now : typeof p.timestamp === "number" ? p.timestamp : Date.parse(p.timestamp);
      if (!Number.isFinite(ts)) return "timestamp is not unix ms or ISO 8601";
      if (ts > now + 5 * 60_000) return "timestamp is in the future";
      if (ts < oldest) return `timestamp is older than this site's retention_days (${site.retention_days})`;
      const provider = p.provider ?? "api";
      const type = p.type ?? (p.amount < 0 ? "refund" : "new");
      if (type !== "refund" && p.amount < 0) return "negative amount: use type refund";
      return {
        provider,
        external_id: p.id,
        event_id: null,
        type,
        amount: Math.abs(p.amount),
        currency: p.currency.toUpperCase(),
        ts,
        visitor_id: p.visitor_id ?? null,
        session_id: p.session_id ?? null,
        user_id: p.user_id ?? null,
        customer: p.customer_id ? await hashCustomer(site.id, provider, p.customer_id) : null,
        original_refs: p.refunded_payment_id ? [p.refunded_payment_id] : [],
        livemode: p.livemode ?? true,
      };
    }),
  );
  const valid = prepared.filter((x): x is PaymentInput => typeof x !== "string");
  const res = valid.length ? await callSite(ctx.env, site, (s) => s.ingestPayments(valid)) : { results: [] };
  let vi = 0;
  const results = prepared.map((p, index) => (typeof p === "string" ? { index, ok: false, reason: p } : { index, ...res.results[vi++]! }));
  const accepted = results.filter((r) => r.ok).length;
  const unlinked = results.filter((r) => r.ok && !("linked_by" in r && r.linked_by)).length;
  return {
    accepted,
    rejected: results.length - accepted,
    results,
    next_steps: [
      `GET /v1/sites/${site.id}/payments lists them with the channel/source each was attributed to.`,
      ...(unlinked
        ? [
            `${unlinked} payment(s) found no visitor: pass visitor_id (afsa.visitorId()), session_id, user_id or customer_id. They count as channel "Unattributed".`,
          ]
        : []),
    ],
  };
}

export const listPaymentsInput = z.object({
  period: z.enum(PERIODS).optional().describe("Default 30d."),
  from: z.string().optional(),
  to: z.string().optional(),
  type: z.enum(["new", "renewal", "refund"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 50."),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

export async function listPayments(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(listPaymentsInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = { period: q.period, from: q.from, to: q.to, type: q.type, limit: q.limit ?? 50, offset: q.offset ?? 0 };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.listPayments(req))) };
}

export async function deletePayment(ctx: Ctx, siteId: string, paymentId: string) {
  const site = await loadSite(ctx, siteId);
  if (!/^pay_[0-9a-z]{16}$/.test(paymentId))
    throw notFound("Payment", "Payment ids look like pay_xxxxxxxxxxxxxxxx (GET /v1/sites/:id/payments).");
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.deletePayment(paymentId))) };
}
