import { ApiError, badRequest, decryptSecret, encryptSecret, newId, notFound } from "@afs/shared";
import { type AppEnv, type Standing, type WebhookEvent, type WebhookJob, cap, isDevMode, standingOf } from "../env";
import { hasControlChars } from "../lib/headers";
import { registrableDomain } from "../lib/sender";
import { newWebhookSecret, signPayload, standardSignature } from "../lib/signing";
import { assertActive, dailyLimitError, rateLimit, refundDaily, reserveDaily } from "./budgets";
import { FEED_EVENT_TYPES, recordEvent } from "./feed";
import { getInboxRow } from "./inboxes";

/** Events a webhook can subscribe to (the feed's types). */
export const WEBHOOK_EVENTS = FEED_EVENT_TYPES;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
/** Custom headers per webhook, and the names a webhook may not set (ours, and transport headers). */
export const MAX_WEBHOOK_HEADERS = 5;
const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "host",
  "user-agent",
  "x-signature",
  "x-webhook-id",
  "x-event-id",
  "x-event-type",
  "x-delivery-attempt",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
]);

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
  /** Several inboxes: sorted JSON array (inbox_id is then NULL). */
  inbox_ids_json?: string | null;
  /** Custom headers, sealed: encryptSecret(JSON {name: value}). */
  headers_sealed?: string | null;
  /** Their names, space-separated (values are write-only). */
  header_names?: string | null;
  updated_at?: number | null;
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
const isLocalHost = (h: string) => LOCAL_HOSTS.has(h) || h.endsWith(".localhost");
const isIpLiteral = (h: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.startsWith("[");

/**
 * Hosting suffixes under which every name belongs to a different customer (a small slice of the
 * Public Suffix List's private section): the deployment's own unit there is one label below.
 */
const SHARED_HOSTING_SUFFIXES = [
  "workers.dev",
  "pages.dev",
  "trycloudflare.com",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "github.io",
  "fly.dev",
  "onrender.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
];

/** The registrable parent of a public host: example.com for mail.example.com, acme.workers.dev for afs-mail.acme.workers.dev. */
export function apexOf(host: string): string {
  for (const sfx of SHARED_HOSTING_SUFFIXES) {
    if (host === sfx) return host;
    if (host.endsWith(`.${sfx}`))
      return `${host
        .slice(0, -(sfx.length + 1))
        .split(".")
        .pop()}.${sfx}`;
  }
  return registrableDomain(host);
}

/**
 * The deployment's own hosts, from PUBLIC_BASE_URL and AUTH_ISSUER: each one's registrable parent
 * (the platform apex), which covers every app of the platform as a subdomain. A local or IP host
 * is kept as an exact origin instead (in development another port is another service).
 */
export function deploymentHosts(env: Pick<AppEnv, "PUBLIC_BASE_URL" | "AUTH_ISSUER">): { apex: string[]; origins: URL[] } {
  const apex = new Set<string>();
  const origins: URL[] = [];
  for (const v of [env.PUBLIC_BASE_URL, env.AUTH_ISSUER]) {
    if (!v) continue;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      continue;
    }
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    if (!h) continue;
    if (isLocalHost(h) || isIpLiteral(h)) origins.push(u);
    else apex.add(apexOf(h));
  }
  return { apex: [...apex], origins };
}

/**
 * Why `raw` may not be a webhook URL here, or null. https only (http://localhost and other local
 * hosts only with DEV_MODE=true), no credentials, and never the deployment itself: not its apex
 * (from PUBLIC_BASE_URL / AUTH_ISSUER) or any subdomain, so a webhook cannot make the platform
 * call its own services. Checked when a webhook is created and again before every delivery.
 */
export function webhookUrlProblem(raw: string, env: Pick<AppEnv, "PUBLIC_BASE_URL" | "AUTH_ISSUER" | "DEV_MODE">): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  const local = isLocalHost(h);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && isDevMode(env))) {
    return isDevMode(env) ? "must use https (or http://localhost)" : "must use https";
  }
  if (local && !isDevMode(env)) return "localhost is only allowed with DEV_MODE=true";
  if (u.username || u.password) return "credentials in the URL are not allowed";
  const own = deploymentHosts(env);
  if (own.apex.some((a) => h === a || h.endsWith(`.${a}`))) return `points at this deployment (${h})`;
  if (own.origins.some((o) => o.hostname.toLowerCase() === h && o.port === u.port)) return `points at this deployment (${u.host})`;
  return null;
}

export function validateWebhookUrl(raw: string, env: Pick<AppEnv, "PUBLIC_BASE_URL" | "AUTH_ISSUER" | "DEV_MODE">): string {
  const problem = webhookUrlProblem(raw, env);
  if (!problem) return new URL(raw).toString();
  if (problem === "not a valid URL") throw badRequest("url is not a valid URL.", "Pass an absolute https:// URL that accepts POST.");
  if (problem.startsWith("credentials"))
    throw badRequest("Credentials in webhook URLs are not allowed.", "Verify requests with the x-signature header instead.");
  if (problem.startsWith("points at"))
    throw badRequest(
      `Webhook URL ${problem}.`,
      "Webhooks can't call this platform's own hosts (its domain or any subdomain). Point it at your own endpoint.",
    );
  throw badRequest(
    `Webhook URLs ${problem.startsWith("localhost") ? "can't use localhost here" : "must use https"}.`,
    "Use a public https:// endpoint that accepts POST (plain http://localhost is only accepted when the deployment runs with DEV_MODE=true, i.e. local development).",
  );
}

async function seal(env: AppEnv, secret: string): Promise<string> {
  return env.ENCRYPTION_KEY ? encryptSecret(env.ENCRYPTION_KEY, secret) : `plain:${secret}`;
}

async function unseal(env: AppEnv, sealed: string): Promise<string> {
  if (sealed.startsWith("plain:")) return sealed.slice(6);
  if (!env.ENCRYPTION_KEY) throw new Error("Webhook secret is sealed but ENCRYPTION_KEY is not set.");
  return decryptSecret(env.ENCRYPTION_KEY, sealed);
}

/** The inboxes a webhook is for: [] = every inbox of the account. */
const inboxIdsOf = (w: Pick<WebhookRow, "inbox_id" | "inbox_ids_json">): string[] =>
  w.inbox_ids_json ? (JSON.parse(w.inbox_ids_json) as string[]) : w.inbox_id ? [w.inbox_id] : [];

function webhookJson(w: WebhookRow, last?: DeliveryRow | null) {
  const ids = inboxIdsOf(w);
  return {
    id: w.id,
    url: w.url,
    events: w.events.split(" ").filter(Boolean),
    inbox_id: ids.length === 1 ? ids[0] : null,
    inbox_ids: ids,
    enabled: !!w.enabled,
    created_at: w.created_at,
    updated_at: w.updated_at ?? null,
    secret_configured: true,
    headers: (w.header_names ?? "").split(" ").filter(Boolean),
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

function parseEvents(events: string[] | undefined): string[] {
  const list = [...new Set(events?.length ? events : ["message.received"])];
  for (const e of list) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(e))
      throw badRequest(`Unknown event "${e}".`, `Supported events: ${WEBHOOK_EVENTS.join(", ")}.`);
  }
  return list;
}

/** One inbox -> inbox_id; several -> sorted inbox_ids_json; none -> every inbox. Each must be the account's. */
async function inboxScope(env: AppEnv, accountId: string, ids: string[]) {
  const list = [...new Set(ids)].sort();
  if (list.length > 50) throw badRequest("At most 50 inbox_ids per webhook.", "Leave inbox_ids out to get events for every inbox.");
  for (const id of list) await getInboxRow(env, accountId, id);
  return list.length === 0
    ? { inbox_id: null, inbox_ids_json: null }
    : list.length === 1
      ? { inbox_id: list[0]!, inbox_ids_json: null }
      : { inbox_id: null, inbox_ids_json: JSON.stringify(list) };
}

/** Validate custom headers (at most 5, no reserved names, no line breaks) and seal them. null = none. */
export async function sealHeaders(env: AppEnv, headers: Record<string, string> | null | undefined) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return { headers_sealed: null, header_names: null };
  if (entries.length > MAX_WEBHOOK_HEADERS)
    throw badRequest(
      `At most ${MAX_WEBHOOK_HEADERS} custom headers per webhook.`,
      "Keep the ones your receiver checks, e.g. an Authorization token.",
    );
  const seen = new Set<string>();
  for (const [k, v] of entries) {
    const name = k.toLowerCase();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || RESERVED_HEADERS.has(name) || seen.has(name))
      throw badRequest(
        `Header "${k}" can't be set on a webhook.`,
        "Use names of letters, digits and '-' (e.g. Authorization or X-Api-Key); content-type, user-agent, host, the x-signature / x-event-* / webhook-* headers we sign with and hop-by-hop headers are reserved, and each name once.",
      );
    if (typeof v !== "string" || v.length > 1024 || hasControlChars(v))
      throw badRequest(`Header "${k}" has an invalid value.`, "At most 1024 characters, no line breaks or other control characters.");
    seen.add(name);
  }
  return { headers_sealed: await seal(env, JSON.stringify(Object.fromEntries(entries))), header_names: entries.map(([k]) => k).join(" ") };
}

async function unsealHeaders(env: AppEnv, w: WebhookRow): Promise<Record<string, string>> {
  if (!w.headers_sealed) return {};
  try {
    return JSON.parse(await unseal(env, w.headers_sealed)) as Record<string, string>;
  } catch (e) {
    console.error("webhook headers could not be unsealed", e);
    return {};
  }
}

export async function createWebhook(
  env: AppEnv,
  accountId: string,
  input: { url: string; events?: string[]; inbox_id?: string | null; inbox_ids?: string[]; headers?: Record<string, string> },
  now = Date.now(),
) {
  const standing = await standingOf(env, accountId);
  assertActive(standing);
  const url = validateWebhookUrl(input.url, env);
  const events = parseEvents(input.events);
  const scope = await inboxScope(env, accountId, [...(input.inbox_ids ?? []), ...(input.inbox_id ? [input.inbox_id] : [])]);
  const sealedHeaders = await sealHeaders(env, input.headers);

  const existing = await env.DB.prepare(
    "SELECT * FROM webhooks WHERE account_id = ? AND url = ? AND COALESCE(inbox_id, '') = ? AND COALESCE(inbox_ids_json, '') = ?",
  )
    .bind(accountId, url, scope.inbox_id ?? "", scope.inbox_ids_json ?? "")
    .first<WebhookRow>();
  if (existing) {
    const headersChanged = input.headers !== undefined;
    await env.DB.prepare(
      `UPDATE webhooks SET events = ?, enabled = 1, updated_at = ?${headersChanged ? ", headers_sealed = ?, header_names = ?" : ""} WHERE id = ?`,
    )
      .bind(events.join(" "), now, ...(headersChanged ? [sealedHeaders.headers_sealed, sealedHeaders.header_names] : []), existing.id)
      .run();
    return {
      webhook: webhookJson({
        ...existing,
        events: events.join(" "),
        enabled: 1,
        updated_at: now,
        ...(headersChanged ? sealedHeaders : {}),
      }),
      existing: true,
      note: `A webhook for this URL already exists; its secret was shown when it was created and is not shown again. POST /v1/webhooks/${existing.id}/rotate-secret issues a new one.`,
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
    inbox_id: scope.inbox_id,
    inbox_ids_json: scope.inbox_ids_json,
    secret_sealed: await seal(env, secret),
    enabled: 1,
    created_at: now,
    updated_at: now,
    ...sealedHeaders,
  };
  await env.DB.prepare(
    "INSERT INTO webhooks (id, account_id, url, events, inbox_id, inbox_ids_json, secret_sealed, headers_sealed, header_names, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
  )
    .bind(
      row.id,
      row.account_id,
      row.url,
      row.events,
      row.inbox_id,
      row.inbox_ids_json,
      row.secret_sealed,
      row.headers_sealed,
      row.header_names,
      row.created_at,
      now,
    )
    .run();
  return {
    webhook: webhookJson(row),
    secret,
    existing: false,
    note: 'Store `secret` now; it is not shown again. Verify each delivery: x-signature is t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>; Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature) are sent too, so stock verifiers work.',
    next_steps: [
      `POST /v1/webhooks/${row.id}/test sends a signed test event so you can check your receiver.`,
      "GET /v1/webhooks/" + row.id + " shows recent deliveries.",
    ],
  };
}

export interface UpdateWebhookInput {
  url?: string;
  events?: string[];
  inbox_id?: string | null;
  inbox_ids?: string[] | null;
  enabled?: boolean;
  /** Replaces all custom headers; null or {} removes them. */
  headers?: Record<string, string> | null;
}

/** True when an update only turns the webhook off (allowed for an OAuth access token). */
export const onlyDisables = (i: UpdateWebhookInput) =>
  i.enabled === false && Object.entries(i).every(([k, v]) => k === "enabled" || v === undefined);

/** PATCH /v1/webhooks/:id: change URL, events, inboxes, enabled, custom headers. */
export async function updateWebhook(env: AppEnv, accountId: string, id: string, input: UpdateWebhookInput, now = Date.now()) {
  const w = await getWebhookRow(env, accountId, id);
  if (input.enabled !== false) assertActive(await standingOf(env, accountId));
  const url = input.url !== undefined ? validateWebhookUrl(input.url, env) : w.url;
  const events = input.events !== undefined ? parseEvents(input.events).join(" ") : w.events;
  const scope =
    input.inbox_ids !== undefined || input.inbox_id !== undefined
      ? await inboxScope(env, accountId, [...(input.inbox_ids ?? []), ...(input.inbox_id ? [input.inbox_id] : [])])
      : { inbox_id: w.inbox_id, inbox_ids_json: w.inbox_ids_json ?? null };
  const headers =
    input.headers !== undefined
      ? await sealHeaders(env, input.headers)
      : { headers_sealed: w.headers_sealed ?? null, header_names: w.header_names ?? null };
  const enabled = input.enabled === undefined ? w.enabled : input.enabled ? 1 : 0;
  await env.DB.prepare(
    "UPDATE webhooks SET url = ?, events = ?, inbox_id = ?, inbox_ids_json = ?, headers_sealed = ?, header_names = ?, enabled = ?, updated_at = ? WHERE id = ?",
  )
    .bind(url, events, scope.inbox_id, scope.inbox_ids_json, headers.headers_sealed, headers.header_names, enabled, now, id)
    .run();
  const next = { ...w, url, events, ...scope, ...headers, enabled, updated_at: now };
  return {
    webhook: webhookJson(next),
    next_steps: [`POST /v1/webhooks/${id}/test sends a signed test event to ${url}.`],
  };
}

/** POST /v1/webhooks/:id/rotate-secret: a new signing secret, shown once; the old one stops at once. */
export async function rotateWebhookSecret(env: AppEnv, accountId: string, id: string, now = Date.now()) {
  const w = await getWebhookRow(env, accountId, id);
  assertActive(await standingOf(env, accountId));
  const secret = newWebhookSecret();
  await env.DB.prepare("UPDATE webhooks SET secret_sealed = ?, updated_at = ? WHERE id = ?")
    .bind(await seal(env, secret), now, id)
    .run();
  return {
    webhook: webhookJson({ ...w, updated_at: now }),
    secret,
    note: "Store `secret` now; it is not shown again. Deliveries are signed with it from now on (retries of earlier events too).",
    next_steps: [`POST /v1/webhooks/${id}/test checks your receiver with the new secret.`],
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

/**
 * An event happened: keep it in the account's event feed (GET /v1/events) and fan it out to the
 * matching webhooks: the type is subscribed, and the webhook is for every inbox, or for this one.
 * Account-level events (inboxId null, e.g. domain.verified) go to webhooks for every inbox only.
 */
export async function emitEvent(
  env: AppEnv,
  accountId: string,
  inboxId: string | null,
  type: WebhookEventType,
  data: Record<string, unknown>,
  now = Date.now(),
) {
  const standing = await standingOf(env, accountId);
  if (standing.suspended) return 0; // suspended accounts get no webhooks or events
  const event: WebhookEvent = { id: newId("evt"), type, created_at: now, data };
  try {
    await recordEvent(env, accountId, inboxId, event, standing);
  } catch (e) {
    console.error("event feed write failed", e);
  }
  const { results } = await env.DB.prepare(
    `SELECT * FROM webhooks WHERE account_id = ?1 AND enabled = 1 AND (' ' || events || ' ') LIKE ?3
       AND ((inbox_id IS NULL AND inbox_ids_json IS NULL) OR inbox_id = ?2
            OR EXISTS (SELECT 1 FROM json_each(webhooks.inbox_ids_json) j WHERE j.value = ?2))`,
  )
    .bind(accountId, inboxId ?? "", `% ${type} %`)
    .all<WebhookRow>();
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

/**
 * The exact HTTP request a delivery sends (pure apart from the HMACs). Two signatures over the
 * same body: ours (x-signature) and Standard Webhooks (webhook-id / webhook-timestamp /
 * webhook-signature, standardwebhooks.com, so stock verifiers such as Svix's work). Custom headers
 * go first; ours always win.
 */
export async function buildDeliveryRequest(
  secret: string,
  job: WebhookJob,
  attempt: number,
  nowSec: number,
  custom: Record<string, string> = {},
) {
  const body = JSON.stringify(job.event);
  return {
    body,
    headers: {
      ...custom,
      "content-type": "application/json",
      "user-agent": "afs-mail-webhooks/1",
      "x-signature": await signPayload(secret, body, nowSec),
      "x-webhook-id": job.webhook_id,
      "x-event-id": job.event.id,
      "x-event-type": job.event.type,
      "x-delivery-attempt": String(attempt),
      "webhook-id": job.event.id,
      "webhook-timestamp": String(nowSec),
      "webhook-signature": await standardSignature(secret, job.event.id, nowSec, body),
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

export async function deliverBatch(batch: Pick<MessageBatch<WebhookJob>, "messages">, env: AppEnv, fetcher: Fetcher = fetch) {
  for (const msg of batch.messages) {
    const job = msg.body;
    const now = Date.now();
    const w = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(job.webhook_id).first<WebhookRow>();
    if (!w || !w.enabled) {
      msg.ack(); // deleted or disabled since: drop
      continue;
    }
    const attempt = msg.attempts;
    // Re-checked at send time: PUBLIC_BASE_URL / AUTH_ISSUER / DEV_MODE may have changed since the
    // webhook was saved, and webhooks saved before these rules existed are held to them too.
    const problem = webhookUrlProblem(w.url, env);
    if (problem) {
      await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?")
        .bind(attempt, `webhook URL not allowed: ${problem}; not delivered`, Date.now(), job.delivery_id)
        .run();
      msg.ack();
      continue;
    }
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
      const req = await buildDeliveryRequest(
        await unseal(env, w.secret_sealed),
        job,
        attempt,
        Math.floor(now / 1000),
        await unsealHeaders(env, w),
      );
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
