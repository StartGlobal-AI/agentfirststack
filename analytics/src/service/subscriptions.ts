/**
 * Subscriptions and MRR. States come from three places and land in the same model (the site's
 * Durable Object, do/subscriptions.ts):
 *   - Stripe: customer.subscription.* webhook events, and the backfill's subscriptions stage.
 *   - Polar, Paddle, LemonSqueezy: their signed webhooks (service/billing-webhooks.ts).
 *   - Any provider: POST /v1/sites/:id/subscriptions with the state and its price.
 * A state is applied only when it is newer than the stored one (webhooks arrive out of order and
 * are retried), and only a state that changes something counts against the daily event budgets.
 * How MRR is computed: lib/subscriptions.ts.
 */

import { parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { hashCustomer } from "../lib/customer";
import { limitVars } from "../lib/limits";
import { INTERVALS, SUB_STATUSES, mrrCounts, monthlyAmount, roundMoney, stripeSubscriptionState } from "../lib/subscriptions";
import { PERIODS } from "../lib/time";
import { SESSION_ID_RE, VISITOR_ID_RE } from "../lib/visitor";
import { enforce } from "../lib/limits";
import type { SubscriptionRecord } from "../do/site-do";
import { SUBSCRIPTION_DIMS, type SubscriptionOutcome } from "../do/subscriptions";
import { type Ctx, type SiteRow, callSite, loadSite } from "./context";
import { type FxRates, convertRecords } from "./fx";
import { refusalError } from "./ingest";
import { periodOf } from "./stats";

type Obj = Record<string, unknown>;

/** Hand states to the site's DO (converted to the site currency first). */
export async function ingestSubscriptionStates(
  env: Bindings,
  site: SiteRow,
  records: SubscriptionRecord[],
  rates?: FxRates,
): Promise<{ results: SubscriptionOutcome[]; refused?: string }> {
  if (!records.length) return { results: [] };
  const converted = await convertRecords(env, site, records, rates);
  return callSite(env, site, (s) => s.ingestSubscriptions(converted, { vars: limitVars(env) }));
}

// ------------------------------------------------------------------ Stripe

/** A Stripe subscription object as a state for the DO (customer hashed). Null when it isn't one. */
export async function stripeSubscriptionRecord(siteId: string, o: Obj, ts: number, now = Date.now()): Promise<SubscriptionRecord | null> {
  const st = stripeSubscriptionState(o, ts, now);
  if (!st) return null;
  const { customer_raw, ...rest } = st;
  return { ...rest, customer: customer_raw ? await hashCustomer(siteId, "stripe", customer_raw) : null };
}

/** A signed customer.subscription.* event. Its object is the subscription as of event.created. */
export async function stripeSubscriptionEvent(
  env: Bindings,
  site: SiteRow,
  event: Obj,
  recordTest: boolean,
): Promise<{ status: 200 | 429; body: Obj; result: string }> {
  const o = ((event.data as Obj | undefined)?.object ?? null) as Obj | null;
  if (!o || o.object !== "subscription")
    return { status: 200, body: { received: true, ignored: "not_a_subscription" }, result: "ignored: not a subscription" };
  if (o.livemode !== true && !recordTest)
    return {
      status: 200,
      body: { received: true, ignored: "test_mode" },
      result: "ignored: test mode (connect with record_test_events: true)",
    };
  const created = Number(event.created);
  const rec = await stripeSubscriptionRecord(site.id, o, Number.isFinite(created) && created > 0 ? created * 1000 : Date.now());
  if (!rec) return { status: 200, body: { received: true, ignored: "unknown_status" }, result: "ignored: unknown subscription status" };
  const res = await ingestSubscriptionStates(env, site, [rec]);
  if (res.refused)
    return {
      status: 429,
      body: refusalError(env, res.refused as never).toJSON() as Obj,
      result: `refused: ${res.refused} (Stripe retries the delivery)`,
    };
  const out = res.results[0]!;
  const what = out.stale ? "older than the stored state" : out.changed ? out.changes?.join(", ") || "updated" : "unchanged";
  return { status: 200, body: { received: true, result: out }, result: `subscription ${rec.status}: ${what}` };
}

/** The backfill's subscriptions stage: current objects, skipping ones that ended before `since`. */
export async function importStripeSubscriptions(
  env: Bindings,
  site: SiteRow,
  objects: Obj[],
  testOk: boolean,
  since: number,
  now = Date.now(),
  rates?: FxRates,
): Promise<{ imported: number; existing: number; skipped: number; refusedAt: number | null }> {
  const recs: { i: number; rec: SubscriptionRecord }[] = [];
  let skipped = 0;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    const rec = o.livemode === true || testOk ? await stripeSubscriptionRecord(site.id, o, now, now) : null;
    if (!rec || (rec.ended_at != null && rec.ended_at < since)) skipped++;
    else recs.push({ i, rec });
  }
  const res = await ingestSubscriptionStates(
    env,
    site,
    recs.map((r) => r.rec),
    rates,
  );
  let imported = 0;
  let existing = 0;
  let refusedAt: number | null = null;
  res.results.forEach((r, k) => {
    if (!r.ok) refusedAt ??= recs[k]!.i;
    else if (r.existing) existing++;
    else imported++;
  });
  return { imported, existing, skipped, refusedAt };
}

// ------------------------------------------------------------------ API (any provider)

const ts = z.union([z.number().int(), z.string()]);

const subscriptionSchema = z.object({
  id: z.string().min(1).max(200).describe("The provider's subscription id (natural key with provider)."),
  provider: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .optional()
    .describe('e.g. "paddle", "chargebee", "app_store". Default "api".'),
  status: z.enum(SUB_STATUSES).describe("Only active and past_due count towards MRR."),
  amount: z
    .number()
    .min(0)
    .max(1e9)
    .optional()
    .describe("The price per billing interval in major units, after discounts and before tax (49.00 a month). Or give mrr."),
  mrr: z.number().min(0).max(1e9).optional().describe("The monthly amount directly (overrides amount/interval)."),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  interval: z.enum(INTERVALS).optional().describe("day, week, month (default) or year."),
  interval_count: z.number().int().min(1).max(365).optional().describe("Billed every N intervals. Default 1."),
  quantity: z.number().int().min(1).max(1_000_000).optional().describe("Seats: amount is per seat when given. Default 1."),
  plan: z.string().max(200).optional(),
  customer_id: z.string().max(200).optional().describe("The provider's customer id: links to the customer's earlier payments."),
  trial_start: ts.optional(),
  trial_end: ts.optional(),
  started_at: ts.optional().describe("When it started (unix ms or ISO 8601). Default: timestamp."),
  canceled_at: ts.optional(),
  ended_at: ts.optional(),
  cancel_at_period_end: z.boolean().optional(),
  timestamp: ts
    .optional()
    .describe("When this state became true (unix ms or ISO 8601). Default now. An older state than the stored one is ignored."),
  visitor_id: z.string().regex(VISITOR_ID_RE).optional().describe("From afsa.visitorId() in the browser."),
  session_id: z.string().regex(SESSION_ID_RE).optional(),
  user_id: z.string().max(200).optional(),
  livemode: z.boolean().optional().describe("false for test subscriptions (left out of MRR unless include_test). Default true."),
});

export const subscriptionsShape = { subscriptions: z.array(subscriptionSchema).min(1).max(100) };
export const recordSubscriptionsInput = z.union([
  z.object(subscriptionsShape),
  subscriptionSchema.transform((s) => ({ subscriptions: [s] })),
]);

const msOf = (v: number | string | undefined): number | null | "bad" => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) && n > 0 ? n : "bad";
};

export async function recordSubscriptions(ctx: Ctx, siteId: string, raw: unknown) {
  const { subscriptions } = parse(recordSubscriptionsInput, raw);
  await enforce(
    [[ctx.env.API_INGEST_LIMITER, `acct:${ctx.accountId}`]],
    "ingest requests",
    "Batch subscription states (up to 100 per request) and retry in a minute.",
  );
  const site = await loadSite(ctx, siteId);
  const now = Date.now();
  const prepared = await Promise.all(
    subscriptions.map(async (p): Promise<SubscriptionRecord | string> => {
      const dates = {
        ts: msOf(p.timestamp) ?? now,
        trial_start: msOf(p.trial_start),
        trial_end: msOf(p.trial_end),
        started_at: msOf(p.started_at),
        canceled_at: msOf(p.canceled_at),
        ended_at: msOf(p.ended_at),
      };
      const bad = Object.entries(dates).find(([, v]) => v === "bad");
      if (bad) return `${bad[0] === "ts" ? "timestamp" : bad[0]} is not unix ms or ISO 8601`;
      if ((dates.ts as number) > now + 5 * 60_000) return "timestamp is in the future";
      if (p.amount == null && p.mrr == null && p.status !== "trialing") return "give amount (per interval) or mrr";
      const interval = p.interval ?? "month";
      const count = p.interval_count ?? 1;
      const quantity = p.quantity ?? 1;
      const price = roundMoney(p.mrr ?? monthlyAmount((p.amount ?? 0) * quantity, interval, count));
      const provider = p.provider ?? "api";
      return {
        provider,
        external_id: p.id,
        customer: p.customer_id ? await hashCustomer(site.id, provider, p.customer_id) : null,
        status: p.status,
        plan: p.plan ?? null,
        currency: p.currency.toUpperCase(),
        mrr: mrrCounts(p.status) ? price : 0,
        price_mrr: price,
        interval,
        interval_count: count,
        quantity,
        trial_start: dates.trial_start as number | null,
        trial_end: dates.trial_end as number | null,
        started_at: dates.started_at as number | null,
        canceled_at: dates.canceled_at as number | null,
        ended_at: dates.ended_at as number | null,
        cancel_at_period_end: p.cancel_at_period_end ?? false,
        ts: dates.ts as number,
        visitor_id: p.visitor_id ?? null,
        session_id: p.session_id ?? null,
        user_id: p.user_id ?? null,
        livemode: p.livemode ?? true,
      };
    }),
  );
  const valid = prepared.filter((x): x is SubscriptionRecord => typeof x !== "string");
  const res = await ingestSubscriptionStates(ctx.env, site, valid);
  if (res.refused && valid.length === prepared.length) throw refusalError(ctx.env, res.refused as never);
  let vi = 0;
  const results = prepared.map((p, index) => (typeof p === "string" ? { index, ok: false, reason: p } : { index, ...res.results[vi++]! }));
  const accepted = results.filter((r) => r.ok).length;
  return {
    accepted,
    rejected: results.length - accepted,
    results,
    next_steps: [
      `GET /v1/sites/${site.id}/mrr shows MRR, ARR and its movements (new, expansion, contraction, churn) over time and by channel/source/campaign.`,
      `GET /v1/sites/${site.id}/subscriptions lists them with the channel each was attributed to.`,
    ],
  };
}

export const mrrInput = z.object({
  ...{
    period: z.enum(PERIODS).optional().describe("Default 12mo."),
    from: z.string().optional(),
    to: z.string().optional(),
  },
  interval: z.enum(["day", "week", "month"]).optional().describe("Series bucket. Default from the period (month for 12mo)."),
  breakdown: z
    .enum(SUBSCRIPTION_DIMS)
    .optional()
    .describe("Split MRR and its movements by acquisition channel, source, utm_*, referrer, country or plan."),
  include_test: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true")
    .describe("Count test-mode subscriptions too. Default false."),
});

export async function getMrr(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(mrrInput, raw);
  const site = await loadSite(ctx, siteId);
  const req = {
    ...periodOf({ ...q, period: q.period ?? (q.from ? undefined : "12mo") }),
    interval: q.interval,
    breakdown: q.breakdown,
    include_test: q.include_test,
  };
  return { site_id: site.id, ...(await callSite(ctx.env, site, (s) => s.mrr(req))) };
}

export const listSubscriptionsInput = z.object({
  status: z.enum(SUB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 50."),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

export async function listSubscriptions(ctx: Ctx, siteId: string, raw: unknown) {
  const q = parse(listSubscriptionsInput, raw);
  const site = await loadSite(ctx, siteId);
  return {
    site_id: site.id,
    ...(await callSite(ctx.env, site, (s) => s.listSubscriptions({ status: q.status, limit: q.limit ?? 50, offset: q.offset ?? 0 }))),
  };
}
