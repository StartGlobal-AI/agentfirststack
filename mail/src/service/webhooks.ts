import { ApiError, badRequest, decryptSecret, encryptSecret, newId, notFound } from "@afs/shared";
import { type AppEnv, type Standing, type WebhookEvent, type WebhookJob, cap, standingOf } from "../env";
import { newWebhookSecret, signPayload } from "../lib/signing";
import { assertActive, dailyLimitError, rateLimit, refundDaily, reserveDaily } from "./budgets";
import { getInboxRow } from "./inboxes";

export const WEBHOOK_EVENTS = ["message.received"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Retry schedule (seconds) after attempt n fails. The 8th failure is final. */
export const BACKOFF_SECONDS = [10, 30, 60, 300, 900, 1800, 3600];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const DELIVERY_TIMEOUT_MS = 10_000;
/** Most of a receiver's response body ever read. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** Queue sendBatch limits: 100 messages and 256 KB per call (kept under with headroom). */
export const QUEUE_BATCH_MESSAGES = 100;
export const QUEUE_BATCH_BYTES = 200 * 1024;
/** MAX_WEBHOOKS_PER_ACCOUNT default. */
export const DEFAULT_MAX_WEBHOOKS = 10;
/** Delivery log rows older than this are purged by the cron. */
export const DELIVERY_RETENTION_MS = 7 * 86_400_000;
const PURGE_CHUNK = 500;

export const maxWebhooks = (env: AppEnv, standing: Standing) => cap(env, standing, "MAX_WEBHOOKS_PER_ACCOUNT", DEFAULT_MAX_WEBHOOKS);

interface WebhookRow {
  id: string;
  account_id: string;
  url: string;
  events: string;
  inbox_id: string | null;
  secret_sealed: string;
  enabled: number;
  created_at: number;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function validateWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("url is not a valid URL.", "Pass an absolute https:// URL that accepts POST.");
  }
  const local = LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw badRequest(
      "Webhook URLs must use https.",
      "Use an https:// endpoint (plain http is only accepted for localhost during development).",
    );
  }
  if (u.username || u.password)
    throw badRequest("Credentials in webhook URLs are not allowed.", "Verify requests with the x-signature header instead.");
  return u.toString();
}

async function seal(env: AppEnv, secret: string): Promise<string> {
  return env.ENCRYPTION_KEY ? encryptSecret(env.ENCRYPTION_KEY, secret) : `plain:${secret}`;
}

async function unseal(env: AppEnv, sealed: string): Promise<string> {
  if (sealed.startsWith("plain:")) return sealed.slice(6);
  if (!env.ENCRYPTION_KEY) throw new Error("Webhook secret is sealed but ENCRYPTION_KEY is not set.");
  return decryptSecret(env.ENCRYPTION_KEY, sealed);
}

function webhookJson(w: WebhookRow, last?: DeliveryRow | null) {
  return {
    id: w.id,
    url: w.url,
    events: w.events.split(" ").filter(Boolean),
    inbox_id: w.inbox_id,
    enabled: !!w.enabled,
    created_at: w.created_at,
    secret_configured: true,
    last_delivery: last
      ? {
          event_type: last.event_type,
          status: last.status,
          attempts: last.attempts,
          response_status: last.response_status,
          error: last.error,
          at: last.updated_at,
        }
      : null,
  };
}

function deliveryJson(d: DeliveryRow) {
  return {
    id: d.id,
    event_id: d.event_id,
    event_type: d.event_type,
    status: d.status,
    attempts: d.attempts,
    response_status: d.response_status,
    error: d.error,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

export async function createWebhook(
  env: AppEnv,
  accountId: string,
  input: { url: string; events?: string[]; inbox_id?: string | null },
  now = Date.now(),
) {
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const url = validateWebhookUrl(input.url);
  const events = [...new Set(input.events?.length ? input.events : ["message.received"])];
  for (const e of events) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(e))
      throw badRequest(`Unknown event "${e}".`, `Supported events: ${WEBHOOK_EVENTS.join(", ")}.`);
  }
  if (input.inbox_id) await getInboxRow(env, accountId, input.inbox_id);

  const existing = await env.DB.prepare("SELECT * FROM webhooks WHERE account_id = ? AND url = ? AND COALESCE(inbox_id, '') = ?")
    .bind(accountId, url, input.inbox_id ?? "")
    .first<WebhookRow>();
  if (existing) {
    await env.DB.prepare("UPDATE webhooks SET events = ?, enabled = 1 WHERE id = ?").bind(events.join(" "), existing.id).run();
    return {
      webhook: webhookJson({ ...existing, events: events.join(" "), enabled: 1 }),
      existing: true,
      note: "A webhook for this URL already exists; its secret was shown when it was created and is not shown again. DELETE it and create it again to get a new secret.",
      next_steps: [`POST /v1/webhooks/${existing.id}/test sends a signed test event.`],
    };
  }
  const max = maxWebhooks(env, standing);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE account_id = ?").bind(accountId).first<{ n: number }>();
  if ((count?.n ?? 0) >= max) {
    throw new ApiError(
      403,
      "quota_exceeded",
      `This account already has ${max} webhooks, the most allowed here.`,
      "Delete one you no longer need (DELETE /v1/webhooks/:id; disabled ones count too, see GET /v1/webhooks), or use one webhook without inbox_id: it receives events for every inbox.",
      { limit: max },
    );
  }
  const secret = newWebhookSecret();
  const row: WebhookRow = {
    id: newId("wh"),
    account_id: accountId,
    url,
    events: events.join(" "),
    inbox_id: input.inbox_id ?? null,
    secret_sealed: await seal(env, secret),
    enabled: 1,
    created_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO webhooks (id, account_id, url, events, inbox_id, secret_sealed, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
  )
    .bind(row.id, row.account_id, row.url, row.events, row.inbox_id, row.secret_sealed, row.created_at)
    .run();
  return {
    webhook: webhookJson(row),
    secret,
    existing: false,
    note: 'Store `secret` now; it is not shown again. Verify each delivery: x-signature is t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>.',
    next_steps: [
      `POST /v1/webhooks/${row.id}/test sends a signed test event so you can check your receiver.`,
      "GET /v1/webhooks/" + row.id + " shows recent deliveries.",
    ],
  };
}

export async function listWebhooks(env: AppEnv, accountId: string) {
  const { results } = await env.DB.prepare("SELECT * FROM webhooks WHERE account_id = ? ORDER BY created_at DESC")
    .bind(accountId)
    .all<WebhookRow>();
  const lasts = await Promise.all(
    results.map((w) =>
      env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY updated_at DESC LIMIT 1")
        .bind(w.id)
        .first<DeliveryRow>(),
    ),
  );
  return { webhooks: results.map((w, i) => webhookJson(w, lasts[i])) };
}

async function getWebhookRow(env: AppEnv, accountId: string, id: string): Promise<WebhookRow> {
  const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ? AND account_id = ?").bind(id, accountId).first<WebhookRow>();
  if (!w) throw notFound("Webhook", "GET /v1/webhooks lists your webhooks.");
  return w;
}

export async function getWebhook(env: AppEnv, accountId: string, id: string) {
  const w = await getWebhookRow(env, accountId, id);
  const { results } = await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 20")
    .bind(id)
    .all<DeliveryRow>();
  return { webhook: { ...webhookJson(w, results[0]), deliveries: results.map(deliveryJson) } };
}

export async function deleteWebhook(env: AppEnv, accountId: string, id: string) {
  await getWebhookRow(env, accountId, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").bind(id),
    env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(id),
  ]);
  return { deleted: id };
}

/** Split queue messages so each sendBatch call stays within the platform's count and size limits. Pure. */
export function chunkForQueue<T>(
  items: T[],
  size: (item: T) => number,
  maxCount = QUEUE_BATCH_MESSAGES,
  maxBytes = QUEUE_BATCH_BYTES,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const n = size(it);
    if (cur.length && (cur.length >= maxCount || bytes + n > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function enqueue(env: AppEnv, hooks: WebhookRow[], event: WebhookEvent, now: number) {
  if (!hooks.length) return 0;
  const jobs: WebhookJob[] = hooks.map((w) => ({ delivery_id: newId("whd"), webhook_id: w.id, event }));
  for (let i = 0; i < jobs.length; i += 100) {
    await env.DB.batch(
      jobs
        .slice(i, i + 100)
        .map((j) =>
          env.DB.prepare(
            "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
          ).bind(j.delivery_id, j.webhook_id, event.id, event.type, now, now),
        ),
    );
  }
  const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
  for (const chunk of chunkForQueue(jobs, () => eventBytes + 200)) {
    await env.WEBHOOKS.sendBatch(chunk.map((body) => ({ body, contentType: "json" as const })));
  }
  return jobs.length;
}

/** Fan an event out to the account's matching webhooks. */
export async function emitEvent(
  env: AppEnv,
  accountId: string,
  inboxId: string | null,
  type: WebhookEventType,
  data: Record<string, unknown>,
  now = Date.now(),
) {
  if ((await standingOf(env, accountId)).suspended) return 0; // suspended accounts get no webhooks
  const { results } = await env.DB.prepare(
    "SELECT * FROM webhooks WHERE account_id = ? AND enabled = 1 AND (inbox_id IS NULL OR inbox_id = ?) AND (' ' || events || ' ') LIKE ?",
  )
    .bind(accountId, inboxId ?? "", `% ${type} %`)
    .all<WebhookRow>();
  const event: WebhookEvent = { id: newId("evt"), type, created_at: now, data };
  return enqueue(env, results, event, now);
}

/**
 * POST /webhooks/:id/test. Bounded three ways, since each test is an outbound request we make for
 * the caller: the WEBHOOK_TEST_LIMITER binding (bursts), MAX_WEBHOOK_TESTS_PER_DAY (per account
 * per UTC day), and a test is delivered once (no retries).
 */
export async function testWebhook(env: AppEnv, accountId: string, id: string, now = Date.now()) {
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const w = await getWebhookRow(env, accountId, id);
  await rateLimit(
    env.WEBHOOK_TEST_LIMITER,
    `whtest:${accountId}`,
    "webhook test",
    `Test events are limited per account per minute. Check the last one with GET /v1/webhooks/${id} before sending another; retry in a minute.`,
  );
  const limit = cap(env, standing, "MAX_WEBHOOK_TESTS_PER_DAY");
  const budget = await reserveDaily(env, accountId, "webhook_test", limit, now);
  if (!budget.ok)
    throw dailyLimitError(
      `this account sent ${limit} webhook tests today`,
      limit,
      `GET /v1/webhooks/${id} shows the result of the last test and of real deliveries.`,
    );
  const event: WebhookEvent = {
    id: newId("evt"),
    type: "webhook.test",
    created_at: now,
    data: { webhook_id: w.id, message: "Test delivery from mail. Verify x-signature with your webhook secret." },
  };
  try {
    await enqueue(env, [w], event, now);
  } catch (e) {
    await refundDaily(env, accountId, "webhook_test", budget.day);
    throw e;
  }
  return {
    queued: true,
    event_id: event.id,
    attempts: 1,
    next_steps: [`GET /v1/webhooks/${id} shows the delivery result within a few seconds. Test events are sent once, without retries.`],
  };
}

/** Cron: delivery log rows older than DELIVERY_RETENTION_MS, in chunks under a wall-time budget. */
export async function purgeWebhookDeliveries(env: AppEnv, now = Date.now(), budgetMs = 20_000) {
  const stop = Date.now() + budgetMs;
  let purged = 0;
  for (;;) {
    if (Date.now() >= stop) return { deliveries_purged: purged, deliveries_more: true };
    const r = await env.DB.prepare(
      "DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < ? LIMIT ?)",
    )
      .bind(now - DELIVERY_RETENTION_MS, PURGE_CHUNK)
      .run();
    const n = r.meta.changes ?? 0;
    purged += n;
    if (n < PURGE_CHUNK) return { deliveries_purged: purged, deliveries_more: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Queue consumer

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** The exact HTTP request a delivery sends (pure apart from the HMAC). */
export async function buildDeliveryRequest(secret: string, job: WebhookJob, attempt: number, nowSec: number) {
  const body = JSON.stringify(job.event);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "afs-mail-webhooks/1",
      "x-signature": await signPayload(secret, body, nowSec),
      "x-webhook-id": job.webhook_id,
      "x-event-id": job.event.id,
      "x-event-type": job.event.type,
      "x-delivery-attempt": String(attempt),
    },
  };
}

/** Read at most `max` bytes of a body (then cancel the rest), decoded as text. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max = MAX_RESPONSE_BYTES): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.byteLength > max - n ? value.subarray(0, max - n) : value;
      parts.push(take);
      n += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function deliverBatch(batch: MessageBatch<WebhookJob>, env: AppEnv, fetcher: Fetcher = fetch) {
  for (const msg of batch.messages) {
    const job = msg.body;
    const now = Date.now();
    const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(job.webhook_id).first<WebhookRow>();
    if (!w || !w.enabled) {
      msg.ack(); // deleted or disabled since: drop
      continue;
    }
    const attempt = msg.attempts;
    if ((await standingOf(env, w.account_id)).suspended) {
      await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?")
        .bind(attempt, "account suspended: not delivered", Date.now(), job.delivery_id)
        .run();
      msg.ack();
      continue;
    }
    let status: number | null = null;
    let error: string | null = null;
    try {
      const req = await buildDeliveryRequest(await unseal(env, w.secret_sealed), job, attempt, Math.floor(now / 1000));
      // Redirects are not followed: a 3xx is a failed delivery (the receiver must answer at its URL).
      const res = await fetcher(w.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      status = res.status;
      if (res.ok) {
        await res.body?.cancel(); // the body of a 2xx is not needed
      } else {
        // An excerpt helps debugging; never read more than MAX_RESPONSE_BYTES of it.
        const text = (await readCapped(res.body).catch(() => "")).trim().slice(0, 200);
        error =
          status >= 300 && status < 400
            ? `HTTP ${status}: redirects are not followed; point the webhook at the final URL`
            : `HTTP ${status}${text ? `: ${text}` : ""}`;
      }
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    const delivered = status !== null && status >= 200 && status < 300;
    const gone = status === 410;
    // A test event is sent once: it checks the receiver, it is not mail to deliver.
    const final = delivered || gone || attempt >= MAX_ATTEMPTS || job.event.type === "webhook.test";
    const state = delivered ? "delivered" : final ? "failed" : "retrying";
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status = ?, attempts = ?, response_status = ?, error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(state, attempt, status, error, Date.now(), job.delivery_id)
      .run();
    if (gone) await env.DB.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").bind(w.id).run(); // receiver says: stop
    if (final) msg.ack();
    else msg.retry({ delaySeconds: BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)]! });
  }
}
