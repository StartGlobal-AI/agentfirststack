import { ApiError, assertPermanentKey, badRequest, decryptSecret, encryptSecret, newId, parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { limitVars } from "../lib/limits";
import { STRIPE_EVENTS, STRIPE_SUBSCRIPTION_EVENTS, normalizeStripeEvent } from "../lib/stripe";
import {
  type Fetcher,
  RESTRICTED_KEY_RE,
  STRIPE_API_VERSION,
  STRIPE_KEY_PERMISSIONS,
  StripeApiError,
  type StripeList,
  stripeApi,
} from "../lib/stripe-api";
import type { PaymentInput } from "../lib/types";
import { utcDay } from "../do/common";
import { type Ctx, type SiteRow, callSite, loadSite } from "./context";
import { hashCustomer } from "../lib/customer";
import { importStripeSubscriptions } from "./subscriptions";
import { FxRates, convertRecords } from "./fx";

/**
 * Stripe in one call: with a restricted key we create the site's webhook endpoint ourselves
 * (pinned API version, the events we use), keep its signing secret and the key sealed with
 * ENCRYPTION_KEY, and import the last `backfill_days` (default 90) of checkout sessions, paid
 * invoices, refunds and subscriptions. The key is used for nothing else.
 *
 * Backfill is bounded and resumable: a few list pages run in the connect call, the cron continues
 * (BACKFILL_PAGES_PER_RUN pages for at most BACKFILL_SITES_PER_RUN sites per run), progress lives
 * in integrations.backfill. Every imported payment counts against the daily event budgets; when a
 * budget is used up the backfill pauses until the next UTC day. Re-running is safe: payments are
 * idempotent by (provider, id), so a second pass only fills gaps.
 */

export const DEFAULT_BACKFILL_DAYS = 90;
export const MAX_BACKFILL_DAYS = 90;
export const PAGE_SIZE = 100;
export const CONNECT_PAGES = 2;
export const BACKFILL_PAGES_PER_RUN = 5;
export const BACKFILL_SITES_PER_RUN = 10;
/** Subscription list pages one backfill reads at most (20,000 subscriptions); past it: done, truncated. */
export const MAX_SUBSCRIPTION_PAGES = 200;

/** Backfill stages, in order: links first, so invoices and refunds find their visitor. */
export const BACKFILL_STAGES = ["checkout_sessions", "invoices", "charges", "subscriptions"] as const;
export type BackfillStage = (typeof BACKFILL_STAGES)[number];

export interface BackfillState {
  status: "running" | "paused" | "done" | "failed";
  since: number;
  stage: BackfillStage;
  /** starting_after for the stage's next page (Stripe lists newest first) */
  cursor: string | null;
  imported: number;
  existing: number;
  linked: number;
  skipped: number;
  pages: number;
  started_at: number;
  updated_at: number;
  finished_at?: number | null;
  paused_until?: number | null;
  /** pages of the subscriptions stage read so far (bounded by MAX_SUBSCRIPTION_PAGES) */
  subscription_pages?: number;
  /** why the backfill stopped short of everything (the subscriptions stage bound) */
  truncated?: string | null;
  error?: string | null;
}

interface Row {
  id: string;
  site_id: string;
  secret_sealed: string;
  options: string | null;
  api_key_sealed: string | null;
  endpoint_id: string | null;
  backfill: string | null;
}

export const connectStripeKeyInput = z.object({
  restricted_key: z
    .string()
    .regex(RESTRICTED_KEY_RE, "a Stripe restricted key (rk_live_... or rk_test_...)")
    .describe(
      `A restricted key with: ${STRIPE_KEY_PERMISSIONS.map((p) => `${p.resource} ${p.access}`).join(", ")}. Used only to create the webhook endpoint and backfill; sealed at rest.`,
    ),
  backfill_days: z.number().int().min(0).max(MAX_BACKFILL_DAYS).optional().describe("Days of history to import (default 90, 0 = none)."),
  record_test_events: z.boolean().optional().describe("Count test-mode payments (an rk_test_ key: set true to see them)."),
});

const webhookUrl = (baseUrl: string, siteId: string) => `${baseUrl}/webhooks/stripe/${siteId}`;

function key(env: Bindings): string {
  if (!env.ENCRYPTION_KEY)
    throw new ApiError(
      503,
      "not_configured",
      "This deployment has no ENCRYPTION_KEY, so it can't store Stripe credentials.",
      "Operator: set the ENCRYPTION_KEY secret on the analytics Worker (openssl rand -base64 32).",
    );
  return env.ENCRYPTION_KEY;
}

/** A Stripe API error as our own, saying which permission is missing when Stripe says so. */
function asApiError(e: unknown, doing: string): ApiError {
  if (!(e instanceof StripeApiError)) return new ApiError(502, "stripe_error", `Stripe failed while ${doing}.`);
  if (e.status === 401)
    return badRequest(
      "Stripe rejected the restricted key (401).",
      "Check the key is current and not revoked, and that it's the account's own (rk_live_ or rk_test_).",
    );
  if (e.status === 403 || (e.type === "invalid_request_error" && /permission/i.test(e.message)))
    return new ApiError(
      400,
      "stripe_permission_missing",
      `The restricted key can't do this: ${e.message}`,
      `Give the key: ${STRIPE_KEY_PERMISSIONS.map((p) => `${p.resource} ${p.access}`).join(", ")}.`,
    );
  return new ApiError(
    502,
    "stripe_error",
    `Stripe answered ${e.status} while ${doing}: ${e.message}`,
    "Retry; the call is safe to repeat.",
  );
}

async function loadRow(env: Bindings, siteId: string): Promise<Row | null> {
  return env.DB.prepare("SELECT * FROM integrations WHERE site_id = ? AND provider = 'stripe'").bind(siteId).first<Row>();
}

export const backfillOf = (r: { backfill: string | null } | null): BackfillState | null =>
  r?.backfill ? (JSON.parse(r.backfill) as BackfillState) : null;

function freshBackfill(days: number, now: number): BackfillState {
  return {
    status: "running",
    since: now - days * 86_400_000,
    stage: BACKFILL_STAGES[0],
    cursor: null,
    imported: 0,
    existing: 0,
    linked: 0,
    skipped: 0,
    pages: 0,
    started_at: now,
    updated_at: now,
    finished_at: null,
    paused_until: null,
    error: null,
  };
}

/**
 * POST /v1/sites/:id/integrations/stripe/connect: create (or reuse) the endpoint, store the
 * secrets sealed, start the backfill. Calling it again with the same key changes nothing and
 * resumes the backfill if it isn't done.
 */
export async function connectStripeWithKey(ctx: Ctx, siteId: string, raw: unknown, opts: { fetcher?: Fetcher } = {}) {
  // The key keeps reading Stripe for this site: never from a connected app's temporary token.
  assertPermanentKey(ctx.auth, "connect Stripe");
  const input = parse(connectStripeKeyInput, raw);
  const enc = key(ctx.env);
  const fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const site = await loadSite(ctx, siteId);
  const url = webhookUrl(ctx.baseUrl, site.id);
  const row = await loadRow(ctx.env, site.id);
  const now = Date.now();
  // The same key as before: reuse the endpoint if Stripe still has it.
  let sameKey = false;
  if (row?.api_key_sealed) {
    try {
      sameKey = (await decryptSecret(enc, row.api_key_sealed)) === input.restricted_key;
    } catch {
      sameKey = false;
    }
  }
  let endpointId = sameKey ? (row?.endpoint_id ?? null) : null;
  let secret: string | null = null;
  if (endpointId) {
    try {
      const ep = await stripeApi<{ id: string; url: string; status: string }>(
        fetcher,
        input.restricted_key,
        "GET",
        `/v1/webhook_endpoints/${endpointId}`,
      );
      if (ep.url !== url) endpointId = null;
    } catch (e) {
      if (e instanceof StripeApiError && e.status === 404) endpointId = null;
      else throw asApiError(e, "reading the webhook endpoint");
    }
  }
  if (!endpointId) {
    try {
      const ep = await stripeApi<{ id: string; secret: string }>(fetcher, input.restricted_key, "POST", "/v1/webhook_endpoints", {
        url,
        enabled_events: [...STRIPE_EVENTS, ...STRIPE_SUBSCRIPTION_EVENTS],
        api_version: STRIPE_API_VERSION,
        description: `AgentFirstStack Analytics (${site.id})`,
        "metadata[afs_site_id]": site.id,
      });
      endpointId = ep.id;
      secret = ep.secret;
    } catch (e) {
      throw asApiError(e, "creating the webhook endpoint");
    }
    if (!secret || !/^whsec_/.test(secret))
      throw new ApiError(502, "stripe_error", "Stripe created the endpoint but returned no signing secret.", "Retry the call.");
  }
  // A new endpoint replaced one we made before (another key, or the URL changed): remove the old
  // one, best effort, with the key that made it (else the new one: usually the same account).
  let oldEndpointDeleted: boolean | undefined;
  if (row?.endpoint_id && row.endpoint_id !== endpointId) {
    let oldKey: string | null = null;
    try {
      oldKey = row.api_key_sealed ? await decryptSecret(enc, row.api_key_sealed) : null;
    } catch {
      oldKey = null;
    }
    oldEndpointDeleted = false;
    for (const k of [...new Set([oldKey, input.restricted_key].filter((x): x is string => !!x))]) {
      try {
        await stripeApi(fetcher, k, "DELETE", `/v1/webhook_endpoints/${row.endpoint_id}`);
        oldEndpointDeleted = true;
        break;
      } catch (e) {
        if (e instanceof StripeApiError && e.status === 404) {
          oldEndpointDeleted = true; // already gone
          break;
        }
      }
    }
  }
  const days = input.backfill_days ?? DEFAULT_BACKFILL_DAYS;
  const prevBackfill = backfillOf(row);
  const backfill = sameKey && prevBackfill && prevBackfill.status !== "failed" ? prevBackfill : days ? freshBackfill(days, now) : null;
  const options = JSON.stringify({ record_test_events: input.record_test_events ?? input.restricted_key.startsWith("rk_test_") });
  const sealedKey = await encryptSecret(enc, input.restricted_key);
  if (row) {
    await ctx.env.DB.prepare(
      `UPDATE integrations SET api_key_sealed = ?, endpoint_id = ?, options = ?, backfill = ?, last_error = NULL, updated_at = ?${secret ? ", secret_sealed = ?" : ""} WHERE id = ?`,
    )
      .bind(
        sealedKey,
        endpointId,
        options,
        backfill ? JSON.stringify(backfill) : null,
        now,
        ...(secret ? [await encryptSecret(enc, secret)] : []),
        row.id,
      )
      .run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO integrations (id, site_id, provider, secret_sealed, options, api_key_sealed, endpoint_id, backfill, created_at, updated_at)
       VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId("int"),
        site.id,
        await encryptSecret(enc, secret!),
        options,
        sealedKey,
        endpointId,
        backfill ? JSON.stringify(backfill) : null,
        now,
        now,
      )
      .run();
  }
  // A first stretch of history now; the cron does the rest.
  const state = backfill && backfill.status === "running" ? await runBackfill(ctx.env, site, CONNECT_PAGES, fetcher, now) : backfill;
  return {
    site_id: site.id,
    connected: true,
    existing: sameKey && !secret,
    webhook: {
      endpoint_id: endpointId,
      url,
      api_version: STRIPE_API_VERSION,
      created: !!secret,
      ...(oldEndpointDeleted !== undefined ? { previous_endpoint_deleted: oldEndpointDeleted } : {}),
    },
    signing_secret: { configured: true },
    restricted_key: { configured: true, used_for: "creating this endpoint and the backfill only" },
    backfill: state,
    permissions: STRIPE_KEY_PERMISSIONS,
    next_steps: [
      `Progress: GET /v1/sites/${site.id}/integrations/stripe (backfill). The cron imports ${BACKFILL_PAGES_PER_RUN * PAGE_SIZE} objects per stage page run until done; payments count against the daily event budget and pause the backfill when it is used up.`,
      `Link new payments to visitors: put afsa.visitorId() in the Checkout Session's metadata.afs_visitor_id (subscriptions: subscription_data.metadata too) or client_reference_id.`,
      `Revenue and MRR by source: GET /v1/sites/${site.id}/breakdown?breakdown=channel&metrics=revenue,customers and GET /v1/sites/${site.id}/mrr?breakdown=channel.`,
    ],
  };
}

/** POST /v1/sites/:id/integrations/stripe/backfill {days}: start over (or resume) the import. */
export const backfillInput = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_BACKFILL_DAYS)
    .optional()
    .describe("Days of history (default 90). Already imported payments are skipped."),
});

export async function restartBackfill(ctx: Ctx, siteId: string, raw: unknown, opts: { fetcher?: Fetcher } = {}) {
  // The backfill reads Stripe with the stored key and writes into the site for a while: the
  // project's own key only, like connecting.
  assertPermanentKey(ctx.auth, "restart the Stripe backfill");
  const input = parse(backfillInput, raw);
  const site = await loadSite(ctx, siteId);
  const row = await loadRow(ctx.env, site.id);
  if (!row?.api_key_sealed)
    throw badRequest(
      "This site's Stripe was connected without a restricted key, so there is nothing to backfill with.",
      `Connect with POST /v1/sites/${site.id}/integrations/stripe/connect {"restricted_key":"rk_..."}.`,
    );
  const cur = backfillOf(row);
  const now = Date.now();
  const state =
    cur && cur.status !== "done" && cur.status !== "failed" && !input.days ? cur : freshBackfill(input.days ?? DEFAULT_BACKFILL_DAYS, now);
  if (state.status === "paused" && (state.paused_until ?? 0) <= now) state.status = "running";
  await ctx.env.DB.prepare("UPDATE integrations SET backfill = ? WHERE id = ?").bind(JSON.stringify(state), row.id).run();
  const out =
    state.status === "running" ? await runBackfill(ctx.env, site, CONNECT_PAGES, opts.fetcher ?? ((u, i) => fetch(u, i)), now) : state;
  return { site_id: site.id, backfill: out };
}

// ------------------------------------------------------------------ backfill steps

type StripeObj = Record<string, unknown> & { id: string; created?: number; livemode?: boolean };

const LISTS: Record<BackfillStage, { path: string; params: Record<string, string | string[]> }> = {
  checkout_sessions: { path: "/v1/checkout/sessions", params: {} },
  invoices: { path: "/v1/invoices", params: { status: "paid" } },
  charges: { path: "/v1/charges", params: { "expand[]": "data.refunds" } },
  subscriptions: { path: "/v1/subscriptions", params: { status: "all" } },
};

/** A listed object as the webhook event it stands for (backfill uses the same normaliser). */
function asEvent(stage: BackfillStage, o: StripeObj): unknown {
  const paidAt = Number((o.status_transitions as { paid_at?: number } | undefined)?.paid_at) || o.created;
  const refundedAt = Math.max(
    0,
    ...(((o.refunds as { data?: { created?: number }[] } | undefined)?.data ?? []).map((r) => Number(r.created) || 0) as number[]),
  );
  const type = stage === "checkout_sessions" ? "checkout.session.completed" : stage === "invoices" ? "invoice.paid" : "charge.refunded";
  const created = stage === "invoices" ? paidAt : stage === "charges" ? refundedAt || o.created : o.created;
  return { id: `backfill:${o.id}`, type, created, livemode: o.livemode === true, data: { object: o } };
}

/** Run up to `pages` list pages of the site's backfill and save the progress. */
export async function runBackfill(
  env: Bindings,
  site: SiteRow,
  pages: number,
  fetcher: Fetcher,
  now = Date.now(),
  rates: FxRates = new FxRates(env),
): Promise<BackfillState | null> {
  const row = await loadRow(env, site.id);
  let state = backfillOf(row);
  if (!row?.api_key_sealed || !state) return state;
  if (state.status === "paused" && (state.paused_until ?? 0) <= now) state = { ...state, status: "running", paused_until: null };
  if (state.status !== "running") return state;
  let restricted: string;
  try {
    restricted = await decryptSecret(key(env), row.api_key_sealed);
  } catch {
    state = { ...state, status: "failed", error: "the stored key can't be read (ENCRYPTION_KEY changed?): connect again", updated_at: now };
    await save(env, row.id, state);
    return state;
  }
  const testOk = !!(row.options && (JSON.parse(row.options) as { record_test_events?: boolean }).record_test_events);
  for (let i = 0; i < pages && state.status === "running"; i++) {
    const list = LISTS[state.stage];
    let page: StripeList<StripeObj>;
    try {
      page = await stripeApi<StripeList<StripeObj>>(fetcher, restricted, "GET", list.path, {
        ...list.params,
        limit: PAGE_SIZE,
        // Subscriptions: every one, however old (an active subscription from 2019 is MRR today);
        // the ones that ended before the window are skipped.
        ...(state.stage === "subscriptions" ? {} : { "created[gte]": Math.floor(state.since / 1000) }),
        ...(state.cursor ? { starting_after: state.cursor } : {}),
      });
    } catch (e) {
      const msg = e instanceof StripeApiError ? `${e.status}: ${e.message}` : "Stripe unreachable";
      // A missing permission won't fix itself; anything else is retried by the next cron run.
      if (e instanceof StripeApiError && (e.status === 401 || e.status === 403))
        state = { ...state, status: "failed", error: msg, updated_at: now };
      else state = { ...state, error: msg, updated_at: now };
      break;
    }
    const objects = page.data ?? [];
    let accepted = objects.length;
    let refused = false;
    try {
      if (state.stage === "subscriptions") {
        if (objects.length) {
          const r = await importStripeSubscriptions(env, site, objects, testOk, state.since, now, rates);
          state.imported += r.imported;
          state.existing += r.existing;
          state.skipped += r.skipped;
          if (r.refusedAt != null) {
            refused = true;
            accepted = r.refusedAt;
          }
        }
      } else {
        const records: { i: number; rec: PaymentInput }[] = [];
        objects.forEach((o, idx) => {
          const a = normalizeStripeEvent(asEvent(state!.stage, o));
          if (a.action === "ignore" || (!a.record.livemode && !testOk)) state!.skipped++;
          else records.push({ i: idx, rec: { ...a.record, event_id: null } });
        });
        if (records.length) {
          const hashed = await convertRecords(
            env,
            site,
            await Promise.all(
              records.map(async (r) => ({
                ...r.rec,
                customer: r.rec.customer ? await hashCustomer(site.id, "stripe", r.rec.customer) : null,
              })),
            ),
            rates,
          );
          const res = await callSite(env, site, (s) => s.ingestPayments(hashed, { vars: limitVars(env) }));
          res.results.forEach((r, k) => {
            if (!r.ok) {
              if (!refused) accepted = records[k]!.i; // objects from here on are retried after the pause
              refused = true;
            } else if (hashed[k]!.type === "link") state!.linked++;
            else if (r.existing) state!.existing++;
            else state!.imported++;
          });
        }
      }
    } catch (e) {
      // The site's Durable Object refused the page: a suspended account or a full site waits
      // (checked again daily); anything else stops with its message, shown in the integration.
      const code = e instanceof ApiError ? e.code : null;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      if (code === "account_suspended" || code === "storage_full") {
        const tomorrow = Date.parse(`${utcDay(now + 86_400_000)}T00:00:00Z`);
        state = { ...state, status: "paused", paused_until: tomorrow, error: `${code}: ${msg}`, updated_at: now };
      } else state = { ...state, status: "failed", error: msg, updated_at: now };
      break;
    }
    state.pages++;
    if (refused) {
      const tomorrow = Date.parse(`${utcDay(now + 86_400_000)}T00:00:00Z`);
      state = {
        ...state,
        status: "paused",
        paused_until: tomorrow,
        error: "daily budget for server events and payments used up: resumes after 00:00 UTC",
        updated_at: now,
      };
      if (accepted > 0) state.cursor = objects[accepted - 1]!.id;
      break;
    }
    state.error = null;
    if (state.stage === "subscriptions") state.subscription_pages = (state.subscription_pages ?? 0) + 1;
    if (state.stage === "subscriptions" && page.has_more && (state.subscription_pages ?? 0) >= MAX_SUBSCRIPTION_PAGES) {
      state = {
        ...state,
        status: "done",
        cursor: null,
        finished_at: now,
        truncated: `stopped after ${MAX_SUBSCRIPTION_PAGES * PAGE_SIZE} subscriptions (newest first); later changes arrive by webhook, and older subscriptions can be sent with POST /v1/sites/:id/subscriptions`,
      };
    } else if (page.has_more && objects.length) state.cursor = objects[objects.length - 1]!.id;
    else {
      const next: number = BACKFILL_STAGES.indexOf(state.stage) + 1;
      if (next >= BACKFILL_STAGES.length) state = { ...state, status: "done", cursor: null, finished_at: now };
      else state = { ...state, stage: BACKFILL_STAGES[next]!, cursor: null };
    }
    state.updated_at = now;
  }
  await save(env, row.id, state);
  return state;
}

const save = (env: Bindings, id: string, s: BackfillState) =>
  env.DB.prepare("UPDATE integrations SET backfill = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(s), s.updated_at, id).run();

/** Cron step: continue running or paused-and-due backfills, bounded. */
export async function runStripeBackfills(env: Bindings, now: number, stopAt: number, fetcher?: Fetcher, maxSites = BACKFILL_SITES_PER_RUN) {
  // Least recently worked on first: long backfills take turns instead of holding every slot.
  const { results } = await env.DB.prepare(
    `SELECT i.site_id FROM integrations i WHERE i.provider = 'stripe' AND i.api_key_sealed IS NOT NULL
       AND json_extract(i.backfill, '$.status') IN ('running', 'paused')
       AND COALESCE(json_extract(i.backfill, '$.paused_until'), 0) <= ?
     ORDER BY COALESCE(json_extract(i.backfill, '$.updated_at'), 0) ASC, i.id LIMIT ?`,
  )
    .bind(now, maxSites)
    .all<{ site_id: string }>();
  // One rate table for the whole run: a currency costs one D1 query, not one per day and page.
  const rates = new FxRates(env);
  let pages = 0;
  let failed = 0;
  for (const r of results) {
    if (Date.now() > stopAt) break;
    try {
      const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(r.site_id).first<SiteRow>();
      if (!site) continue;
      const before = backfillOf(await loadRow(env, site.id))?.pages ?? 0;
      const s = await runBackfill(env, site, BACKFILL_PAGES_PER_RUN, fetcher ?? ((u, i) => fetch(u, i)), now, rates);
      pages += (s?.pages ?? 0) - before;
      if (s?.status === "failed") failed++;
    } catch (e) {
      // Never let one site stall the queue: record why and move on.
      failed++;
      const row = await loadRow(env, r.site_id).catch(() => null);
      const cur = backfillOf(row);
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      if (row && cur) await save(env, row.id, { ...cur, status: "failed", error, updated_at: now }).catch(() => {});
    }
  }
  return { stripe_backfill_pages: pages, ...(failed ? { stripe_backfill_failed: failed } : {}) };
}

/** Disconnect: delete the endpoint we created (best effort) before the row goes. */
export async function deleteCreatedEndpoint(env: Bindings, siteId: string, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<boolean> {
  const row = await loadRow(env, siteId);
  if (!row?.api_key_sealed || !row.endpoint_id || !env.ENCRYPTION_KEY) return false;
  try {
    const k = await decryptSecret(env.ENCRYPTION_KEY, row.api_key_sealed);
    await stripeApi(fetcher, k, "DELETE", `/v1/webhook_endpoints/${row.endpoint_id}`);
    return true;
  } catch {
    return false;
  }
}
