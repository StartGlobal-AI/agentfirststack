import {
  accountStanding,
  ApiError,
  assertPermanentKey,
  badRequest,
  decryptSecret,
  encryptSecret,
  newId,
  notFound,
  parse,
} from "@afs/shared";
import { z } from "zod";
import { type Bindings, isDev } from "../env";
import { readCapped } from "../lib/body";
import { cap, DEFAULTS } from "../lib/limits";
import { utcDay } from "../lib/time";
import { newWebhookSecret, signPayload, webhookUrlProblem } from "../lib/webhook-url";
import { type Ctx, isVerified, loadSite, type SiteRow, siteStub } from "./context";

/**
 * Signed webhooks for replay events, the mail app's pattern without a queue: the secret is sealed
 * with ENCRYPTION_KEY and shown once; each event is a delivery row in D1, sent at once (after the
 * response) and retried with backoff by the site's Durable Object alarm (10 s ... 1 h, 8 attempts,
 * a 410 disables the webhook); URLs are re-checked before every attempt; per-account daily caps.
 */

export const WEBHOOK_EVENTS = ["survey.response", "feedback.created", "segment.session", "error.new", "signal.spike"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | "webhook.test";

/** Seconds to wait after attempt n fails; the 8th failure is final. */
export const BACKOFF_SECONDS = [10, 30, 60, 300, 900, 1800, 3600];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const TIMEOUT_MS = 10_000;
/** A delivery left "sending" this long (the Worker went away mid-request) is due again. */
const STALE_MS = 5 * 60_000;
export const DELIVERY_RETENTION_MS = 7 * 86_400_000;

interface WebhookRow {
  id: string;
  account_id: string;
  site_id: string | null;
  segment_id: string | null;
  url: string;
  events: string;
  secret_sealed: string;
  enabled: number;
  created_at: number;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  account_id: string;
  site_id: string | null;
  event_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  next_at: number;
  response_status: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export const createWebhookInput = z.object({
  url: z.string().min(1).max(2000).describe("https:// endpoint that accepts POST (not this platform's own hosts, no IP literals)."),
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1)
    .max(WEBHOOK_EVENTS.length)
    .describe(`Event types: ${WEBHOOK_EVENTS.join(", ")}.`),
  site_id: z.string().max(40).nullable().optional().describe("Only this replay site's events (default every site of the account)."),
  segment_id: z.string().max(40).optional().describe("segment.session: the segment (seg_...) whose new sessions are sent; needs site_id."),
});

async function seal(env: Bindings, secret: string): Promise<string> {
  if (env.ENCRYPTION_KEY) return encryptSecret(env.ENCRYPTION_KEY, secret);
  if (isDev(env)) return `plain:${secret}`;
  throw new ApiError(
    503,
    "webhooks_unavailable",
    "This deployment can't store webhook secrets (no ENCRYPTION_KEY).",
    "The operator sets the ENCRYPTION_KEY secret (32 bytes, base64) on the replay Worker.",
  );
}

async function unseal(env: Bindings, sealed: string): Promise<string> {
  // plain secrets exist only in local development (no ENCRYPTION_KEY, DEV_MODE)
  if (sealed.startsWith("plain:")) {
    if (!isDev(env)) throw new Error("A plain webhook secret outside DEV_MODE: not sent.");
    return sealed.slice(6);
  }
  if (!env.ENCRYPTION_KEY) throw new Error("Webhook secret is sealed but ENCRYPTION_KEY is not set.");
  return decryptSecret(env.ENCRYPTION_KEY, sealed);
}

function webhookJson(w: WebhookRow, last?: DeliveryRow | null) {
  return {
    id: w.id,
    url: w.url,
    events: w.events.split(" ").filter(Boolean),
    site_id: w.site_id,
    segment_id: w.segment_id,
    enabled: !!w.enabled,
    created_at: w.created_at,
    secret_configured: true,
    last_delivery: last ? deliveryJson(last) : null,
  };
}

const deliveryJson = (d: DeliveryRow) => ({
  id: d.id,
  event_id: d.event_id,
  event_type: d.event_type,
  site_id: d.site_id,
  status: d.status,
  attempts: d.attempts,
  next_at: d.status === "retrying" || d.status === "pending" ? d.next_at : null,
  response_status: d.response_status,
  error: d.error,
  created_at: d.created_at,
  updated_at: d.updated_at,
});

function checkUrl(env: Bindings, raw: string): string {
  const p = webhookUrlProblem(raw, env);
  if (!p) return new URL(raw).toString();
  throw badRequest(
    `Webhook URL ${p}.`,
    p.startsWith("points at")
      ? "Webhooks can't call this platform's own hosts. Point it at your own endpoint."
      : "Use a public https:// endpoint with a hostname that accepts POST (http://localhost only in local development).",
  );
}

// Webhooks per account, per isolate: every event and every chunk with an error looks them up.
const hookCache = new Map<string, { at: number; rows: WebhookRow[] }>();
const HOOK_CACHE_MS = 30_000;
export const forgetHooks = (accountId: string) => hookCache.delete(accountId);

async function accountHooks(env: Bindings, accountId: string): Promise<WebhookRow[]> {
  const hit = hookCache.get(accountId);
  if (hit && Date.now() - hit.at < HOOK_CACHE_MS) return hit.rows;
  const { results } = await env.DB.prepare("SELECT * FROM webhooks WHERE account_id = ? AND enabled = 1 LIMIT 100")
    .bind(accountId)
    .all<WebhookRow>();
  if (hookCache.size > 5000) hookCache.clear();
  hookCache.set(accountId, { at: Date.now(), rows: results });
  return results;
}

/** The enabled webhooks of a site's account that want this event (and segment). */
export async function hooksFor(env: Bindings, site: SiteRow, type: WebhookEvent, segmentId?: string): Promise<WebhookRow[]> {
  return (await accountHooks(env, site.account_id)).filter(
    (w) =>
      (w.site_id === null || w.site_id === site.id) &&
      w.events.split(" ").includes(type) &&
      (type !== "segment.session" || (segmentId !== undefined && w.segment_id === segmentId)),
  );
}

/** Segments of this site that a segment.session webhook listens to (from the cached account hooks). */
export async function segmentHookIds(env: Bindings, site: SiteRow): Promise<Set<string>> {
  const out = new Set<string>();
  for (const w of await accountHooks(env, site.account_id))
    if (w.site_id === site.id && w.segment_id && w.events.split(" ").includes("segment.session")) out.add(w.segment_id);
  return out;
}

export async function createWebhook(ctx: Ctx, raw: unknown) {
  // A webhook keeps sending for as long as it exists: a connected app's short-lived token can't leave one behind.
  assertPermanentKey(ctx.auth, "create webhooks");
  const q = parse(createWebhookInput, raw);
  const url = checkUrl(ctx.env, q.url);
  const events = [...new Set(q.events)].sort();
  let site: SiteRow | null = null;
  if (q.site_id) {
    site = await loadSite(ctx, q.site_id);
    if (!isVerified(site))
      throw new ApiError(
        403,
        "domain_not_verified",
        `Webhooks need a verified domain; ${site.domain} isn't verified yet.`,
        `Verify it first: POST /v1/sites/${site.id}/verify.`,
      );
  }
  if (q.segment_id) {
    if (!site) throw badRequest("segment_id needs site_id.", "A segment belongs to one site.");
    const seg = await ctx.env.DB.prepare("SELECT id FROM segments WHERE id = ? AND site_id = ?").bind(q.segment_id, site.id).first();
    if (!seg) throw notFound("Segment", `GET /v1/sites/${site.id}/segments lists them.`);
  }
  if (events.includes("segment.session") && !q.segment_id)
    throw badRequest("segment.session needs segment_id.", "Pass the segment (seg_...) whose new sessions to send, and its site_id.");
  const db = ctx.env.DB;
  const existing = await db
    .prepare("SELECT * FROM webhooks WHERE account_id = ? AND url = ? AND COALESCE(site_id, '') = ? AND COALESCE(segment_id, '') = ?")
    .bind(ctx.accountId, url, q.site_id ?? "", q.segment_id ?? "")
    .first<WebhookRow>();
  if (existing) {
    await db.prepare("UPDATE webhooks SET events = ?, enabled = 1 WHERE id = ?").bind(events.join(" "), existing.id).run();
    forgetHooks(ctx.accountId);
    return {
      webhook: webhookJson({ ...existing, events: events.join(" "), enabled: 1 }),
      existing: true,
      note: "A webhook for this URL (and site / segment) already exists; its events were updated and its secret is not shown again. Delete it and create it again for a new secret.",
      next_steps: [`POST /v1/webhooks/${existing.id}/test sends a signed test event.`],
    };
  }
  const standing = await accountStanding(ctx.env, ctx.accountId);
  const max = cap(ctx.env, standing, "MAX_WEBHOOKS_PER_ACCOUNT", DEFAULTS.WEBHOOKS_PER_ACCOUNT);
  if (max !== null) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE account_id = ?").bind(ctx.accountId).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This account already has ${max} webhooks, the most allowed here (MAX_WEBHOOKS_PER_ACCOUNT).`,
        "Delete one you no longer need (DELETE /v1/webhooks/:id), or use one without site_id: it receives every site's events.",
      );
  }
  const secret = newWebhookSecret();
  const row: WebhookRow = {
    id: newId("wh"),
    account_id: ctx.accountId,
    site_id: q.site_id ?? null,
    segment_id: q.segment_id ?? null,
    url,
    events: events.join(" "),
    secret_sealed: await seal(ctx.env, secret),
    enabled: 1,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO webhooks (id, account_id, site_id, segment_id, url, events, secret_sealed, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
    )
    .bind(row.id, row.account_id, row.site_id, row.segment_id, row.url, row.events, row.secret_sealed, row.created_at)
    .run();
  forgetHooks(ctx.accountId);
  return {
    webhook: webhookJson(row),
    secret,
    existing: false,
    note: 'Store `secret` now; it is not shown again. Verify each delivery: x-signature is t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>; reject timestamps older than 5 minutes. Payloads carry recorded and visitor-typed content under `untrusted`.',
    next_steps: [
      `POST /v1/webhooks/${row.id}/test sends a signed test event now and returns the result.`,
      `GET /v1/webhooks/${row.id} shows recent deliveries.`,
      ...(site ? [] : ["Events come only from sites whose domain is verified."]),
    ],
  };
}

export async function listWebhooks(ctx: Ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM webhooks WHERE account_id = ? ORDER BY created_at DESC LIMIT 100")
    .bind(ctx.accountId)
    .all<WebhookRow>();
  const lasts = await Promise.all(
    results.map((w) =>
      ctx.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY updated_at DESC LIMIT 1")
        .bind(w.id)
        .first<DeliveryRow>(),
    ),
  );
  return { webhooks: results.map((w, i) => webhookJson(w, lasts[i])) };
}

async function hookRow(ctx: Ctx, id: string): Promise<WebhookRow> {
  const w = await ctx.env.DB.prepare("SELECT * FROM webhooks WHERE id = ? AND account_id = ?").bind(id, ctx.accountId).first<WebhookRow>();
  if (!w) throw notFound("Webhook", "GET /v1/webhooks lists your webhooks.");
  return w;
}

export async function getWebhook(ctx: Ctx, id: string) {
  const w = await hookRow(ctx, id);
  const { results } = await ctx.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 20")
    .bind(id)
    .all<DeliveryRow>();
  return { webhook: { ...webhookJson(w, results[0]), deliveries: results.map(deliveryJson) } };
}

export async function deleteWebhook(ctx: Ctx, id: string) {
  await hookRow(ctx, id);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").bind(id),
    ctx.env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(id),
  ]);
  forgetHooks(ctx.accountId);
  return { deleted: id };
}

/** Reserve n of today's deliveries or tests for the account; false when over its cap. */
async function reserve(env: Bindings, accountId: string, col: "deliveries" | "tests", n: number, max: number | null): Promise<boolean> {
  const day = utcDay(Date.now());
  const r = await env.DB.prepare(
    `INSERT INTO webhook_usage (account_id, day, ${col}) VALUES (?, ?, ?)
     ON CONFLICT(account_id, day) DO UPDATE SET ${col} = ${col} + excluded.${col} RETURNING ${col} AS n`,
  )
    .bind(accountId, day, n)
    .first<{ n: number }>();
  if (max !== null && (r?.n ?? 0) > max) {
    await env.DB.prepare(`UPDATE webhook_usage SET ${col} = ${col} - ? WHERE account_id = ? AND day = ?`).bind(n, accountId, day).run();
    return false;
  }
  return true;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** One attempt. Returns the delivery's new state. */
async function attempt(
  env: Bindings,
  w: WebhookRow,
  d: Pick<DeliveryRow, "id" | "payload" | "event_id" | "event_type">,
  n: number,
  fetcher: Fetcher,
) {
  const problem = webhookUrlProblem(w.url, env);
  if (problem) return { status: null, error: `webhook URL not allowed: ${problem}; not delivered`, final: true, delivered: false };
  if ((await accountStanding(env, w.account_id)).suspended)
    return { status: null, error: "account suspended: not delivered", final: true, delivered: false };
  let status: number | null = null;
  let error: string | null = null;
  try {
    const secret = await unseal(env, w.secret_sealed);
    const res = await fetcher(w.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "afs-replay-webhooks/1",
        "x-signature": await signPayload(secret, d.payload, Math.floor(Date.now() / 1000)),
        "x-webhook-id": w.id,
        "x-event-id": d.event_id,
        "x-event-type": d.event_type,
        "x-delivery-attempt": String(n),
      },
      body: d.payload,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    // The receiver's body is never kept: it is the receiver's text, and nothing here needs it.
    await res.body?.cancel();
    if (!res.ok)
      error =
        status >= 300 && status < 400 ? `HTTP ${status}: redirects are not followed; point the webhook at the final URL` : `HTTP ${status}`;
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const delivered = status !== null && status >= 200 && status < 300;
  if (status === 410) await env.DB.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").bind(w.id).run();
  return { status, error, delivered, final: delivered || status === 410 || n >= MAX_ATTEMPTS };
}

/**
 * Send one due delivery (claimed atomically, so the Worker and the alarm never both send it).
 * Returns when it is due again, or null when it is done.
 */
async function deliverRow(env: Bindings, id: string, fetcher: Fetcher): Promise<number | null> {
  const now = Date.now();
  const claim = await env.DB.prepare(
    `UPDATE webhook_deliveries SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?
     AND ((status IN ('pending', 'retrying') AND next_at <= ?) OR (status = 'sending' AND updated_at < ?)) RETURNING *`,
  )
    .bind(now, id, now, now - STALE_MS)
    .first<DeliveryRow>();
  if (!claim) return null;
  const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(claim.webhook_id).first<WebhookRow>();
  if (!w || !w.enabled) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(w ? "webhook disabled: not delivered" : "webhook deleted", Date.now(), id)
      .run();
    return null;
  }
  // attempts was counted in the claim: an attempt that dies with the Worker still counts
  const n = claim.attempts;
  if (n > MAX_ATTEMPTS) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', error = COALESCE(error, 'gave up'), updated_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    return null;
  }
  const r = await attempt(env, w, claim, n, fetcher);
  const next = r.final ? null : Date.now() + BACKOFF_SECONDS[Math.min(n - 1, BACKOFF_SECONDS.length - 1)]! * 1000;
  await env.DB.prepare(
    // only while the claim is still ours (a stale reclaim may have taken it over)
    "UPDATE webhook_deliveries SET status = ?, response_status = ?, error = ?, next_at = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND updated_at = ?",
  )
    .bind(
      r.delivered ? "delivered" : r.final ? "failed" : "retrying",
      r.status,
      r.error,
      next ?? claim.next_at,
      Date.now(),
      id,
      claim.updated_at,
    )
    .run();
  return next;
}

/** Deliver the given rows now; the site's alarm is told when any is due again. */
export async function deliverNow(env: Bindings, siteId: string, ids: string[], fetcher: Fetcher = fetch) {
  let wake: number | null = null;
  for (const id of ids) {
    const next = await deliverRow(env, id, fetcher).catch((e) => {
      console.error("replay webhook delivery failed", e);
      return Date.now() + 60_000;
    });
    if (next !== null) wake = wake === null ? next : Math.min(wake, next);
  }
  if (wake !== null) await siteStub(env, siteId).wakeWebhooks(wake);
}

/**
 * The site's alarm: send what is due (at most `max` rows, within the time budget), then report
 * when the next one is due (null = nothing pending).
 */
export async function deliverDue(
  env: Bindings,
  siteId: string,
  opts: { budgetMs?: number; max?: number; fetcher?: Fetcher } = {},
): Promise<number | null> {
  const stop = Date.now() + (opts.budgetMs ?? 15_000);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id FROM webhook_deliveries WHERE site_id = ? AND ((status IN ('pending', 'retrying') AND next_at <= ?) OR (status = 'sending' AND updated_at < ?))
     ORDER BY next_at LIMIT ?`,
  )
    .bind(siteId, now, now - STALE_MS, opts.max ?? 25)
    .all<{ id: string }>();
  for (const r of results) {
    if (Date.now() > stop) break;
    await deliverRow(env, r.id, opts.fetcher ?? fetch).catch((e) => console.error("replay webhook delivery failed", e));
  }
  const next = await env.DB.prepare(
    "SELECT MIN(CASE WHEN status = 'sending' THEN updated_at + ? ELSE next_at END) AS t FROM webhook_deliveries WHERE site_id = ? AND status IN ('pending', 'retrying', 'sending')",
  )
    .bind(STALE_MS, siteId)
    .first<{ t: number | null }>();
  return next?.t ?? null;
}

/**
 * Fan an event out to the site's matching webhooks: verified sites only, suspended accounts get
 * nothing, MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY (over it, deliveries are recorded as dropped).
 * `data` carries recorded or visitor-typed content only under `untrusted`.
 */
export async function emitSiteEvent(
  env: Bindings,
  site: SiteRow,
  type: WebhookEvent,
  data: Record<string, unknown>,
  opts: { segmentId?: string; waitUntil?: (p: Promise<unknown>) => void } = {},
): Promise<number> {
  if (!isVerified(site)) return 0;
  const hooks = await hooksFor(env, site, type, opts.segmentId);
  if (!hooks.length) return 0;
  const standing = await accountStanding(env, site.account_id);
  if (standing.suspended) return 0;
  const now = Date.now();
  const event = { id: newId("evt"), type, created_at: now, site_id: site.id, data };
  const payload = JSON.stringify(event);
  const ok = await reserve(
    env,
    site.account_id,
    "deliveries",
    hooks.length,
    cap(env, standing, "MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY", DEFAULTS.WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY),
  );
  const ids = hooks.map(() => newId("whd"));
  await env.DB.batch(
    hooks.map((w, i) =>
      env.DB.prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, account_id, site_id, event_id, event_type, payload, status, attempts, next_at, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).bind(
        ids[i]!,
        w.id,
        site.account_id,
        site.id,
        event.id,
        type,
        payload,
        ok ? "pending" : "dropped",
        now,
        ok ? null : "daily delivery limit (MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY)",
        now,
        now,
      ),
    ),
  );
  if (!ok) return 0;
  // The alarm is the safety net (the Worker may go away mid-send); the first attempt is now.
  await siteStub(env, site.id).wakeWebhooks(now + 60_000);
  const send = deliverNow(env, site.id, ids);
  if (opts.waitUntil) opts.waitUntil(send.catch(() => {}));
  else await send.catch(() => {});
  return ids.length;
}

/** POST /v1/webhooks/:id/test: one signed test event, delivered now (no retries), result returned. */
export async function testWebhook(ctx: Ctx, id: string, fetcher: Fetcher = fetch) {
  const w = await hookRow(ctx, id);
  const standing = await accountStanding(ctx.env, ctx.accountId);
  if (
    !(await reserve(
      ctx.env,
      ctx.accountId,
      "tests",
      1,
      cap(ctx.env, standing, "MAX_WEBHOOK_TESTS_PER_DAY", DEFAULTS.WEBHOOK_TESTS_PER_DAY),
    ))
  )
    throw new ApiError(
      429,
      "rate_limited",
      "This account sent the most webhook tests allowed today (MAX_WEBHOOK_TESTS_PER_DAY).",
      "Try again tomorrow (UTC); real deliveries continue.",
    );
  const now = Date.now();
  const event = {
    id: newId("evt"),
    type: "webhook.test",
    created_at: now,
    site_id: w.site_id,
    data: { webhook_id: w.id, message: "Test delivery from replay. Verify x-signature with your webhook secret." },
  };
  const payload = JSON.stringify(event);
  const did = newId("whd");
  const r = await attempt(ctx.env, w, { id: did, payload, event_id: event.id, event_type: "webhook.test" }, 1, fetcher);
  await ctx.env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, account_id, site_id, event_id, event_type, payload, status, attempts, next_at, response_status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'webhook.test', ?, ?, 1, ?, ?, ?, ?, ?)`,
  )
    .bind(
      did,
      w.id,
      w.account_id,
      w.site_id,
      event.id,
      payload,
      r.delivered ? "delivered" : "failed",
      now,
      r.status,
      r.error,
      now,
      Date.now(),
    )
    .run();
  return {
    delivered: r.delivered,
    response_status: r.status,
    error: r.error,
    event_id: event.id,
    next_steps: r.delivered
      ? ["Your receiver answered 2xx. Real events arrive the same way (retried with backoff when it doesn't)."]
      : ["Make the URL answer 2xx to a POST (and check x-signature), then test again."],
  };
}

/** Cron: delivery logs older than 7 days and old usage rows. */
export async function purgeWebhookLogs(env: Bindings, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < ? LIMIT 1000)").bind(
      now - DELIVERY_RETENTION_MS,
    ),
    env.DB.prepare("DELETE FROM webhook_usage WHERE day < ?").bind(utcDay(now - 2 * 86_400_000)),
  ]);
}
