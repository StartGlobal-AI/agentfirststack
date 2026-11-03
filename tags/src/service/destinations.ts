import { ApiError, accountStanding, badRequest, decryptSecret, encryptSecret, newId, notFound } from "@afs/shared";
import { z } from "zod";
import { getConnector, DESTINATION_TYPES } from "../destinations";
import type { Connector, DeliveryResult, DispatchEvent } from "../destinations/types";
import type { Bindings } from "../env";
import { getContainerRow, syncToDO } from "./containers";
import { limits } from "./limits";
import { assertRate } from "./ratelimit";
import { summarizeResponse } from "./sanitize";

export interface DestinationRow {
  id: string;
  container_id: string;
  account_id: string;
  type: string;
  name: string | null;
  natural_key: string;
  public: string;
  credentials: string;
  settings: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  /** Circuit breaker (migration 0006). */
  consecutive_failures?: number;
  circuit_open_until?: number | null;
  last_failure?: string | null;
  last_failure_at?: number | null;
}

export const destinationSettings = z.strictObject({
  conversions: z
    .array(z.string())
    .max(100)
    .optional()
    .describe("Only these conversion/event names (default: all that map to this destination)."),
  all_events: z
    .boolean()
    .optional()
    .describe(
      "webhook only: also receive backend events whose name matches no conversion in the config (default false: only matched conversions).",
    ),
});

function encryptionKey(env: Bindings): string {
  const k = env.ENCRYPTION_KEY;
  if (!k)
    throw new ApiError(
      500,
      "not_configured",
      "ENCRYPTION_KEY is not set on this deployment.",
      "The operator must set the ENCRYPTION_KEY secret (openssl rand -base64 32).",
    );
  return k;
}

function connectorOr400(type: string): Connector {
  const c = getConnector(type);
  if (!c)
    throw badRequest(
      `Unknown destination type "${type}".`,
      `Use one of: ${DESTINATION_TYPES.join(", ")}. GET /v1/schema -> destinations lists their credentials.`,
    );
  return c;
}

function parseCredentials(env: Bindings, connector: Connector, raw: unknown, origins: string[] = []): Record<string, unknown> {
  const r = connector.credentials.safeParse(raw);
  if (!r.success) {
    throw badRequest(
      `Invalid ${connector.type} credentials.`,
      `GET /v1/schema -> destinations.${connector.type} shows the fields and an example.`,
      r.error.issues.map((i) => ({ path: `credentials.${i.path.join(".")}`, message: i.message })),
    );
  }
  try {
    connector.check?.(r.data as never, env, origins);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : String(e), `See GET /v1/schema -> destinations.${connector.type}.`);
  }
  return r.data as Record<string, unknown>;
}

function publicFields(connector: Connector, creds: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of connector.publicFields) if (creds[f] !== undefined) out[f] = creds[f];
  if (connector.type === "webhook" && typeof creds.url === "string") {
    const u = new URL(creds.url);
    out.url = `${u.origin}${u.pathname}${u.search ? "?..." : ""}`;
  }
  return out;
}

/** Circuit breaker state, as GET /destinations and the test show it. */
export function destinationHealth(row: DestinationRow, now = Date.now()) {
  const open = !!row.circuit_open_until && row.circuit_open_until > now;
  return {
    circuit: open ? ("open" as const) : ("closed" as const),
    consecutive_failures: row.consecutive_failures ?? 0,
    open_until: open ? row.circuit_open_until! : null,
    last_failure: row.last_failure ?? null,
    last_failure_at: row.last_failure_at ?? null,
  };
}

export function presentDestination(row: DestinationRow) {
  return {
    id: row.id,
    container_id: row.container_id,
    type: row.type,
    name: row.name,
    enabled: !!row.enabled,
    credentials: { configured: true, ...(JSON.parse(row.public) as Record<string, unknown>) },
    settings: JSON.parse(row.settings) as Record<string, unknown>,
    health: destinationHealth(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getRow(env: Bindings, accountId: string, containerId: string, id: string) {
  const row = await env.DB.prepare("SELECT * FROM destinations WHERE id = ? AND container_id = ? AND account_id = ?")
    .bind(id, containerId, accountId)
    .first<DestinationRow>();
  if (!row) throw notFound("Destination", `GET /v1/containers/${containerId}/destinations lists them.`);
  return row;
}

async function resync(env: Bindings, accountId: string, containerId: string) {
  await syncToDO(env, await getContainerRow(env, accountId, containerId), { destinations: true });
}

export async function createDestination(
  env: Bindings,
  accountId: string,
  containerId: string,
  input: { type: string; name?: string; credentials: unknown; settings?: z.infer<typeof destinationSettings>; enabled?: boolean },
  origins: string[] = [],
) {
  await getContainerRow(env, accountId, containerId);
  const connector = connectorOr400(input.type);
  const creds = parseCredentials(env, connector, input.credentials, origins);
  const natural = connector.naturalKey(creds as never);
  const found = await env.DB.prepare("SELECT * FROM destinations WHERE container_id = ? AND type = ? AND natural_key = ?")
    .bind(containerId, input.type, natural)
    .first<DestinationRow>();
  if (found) return { row: found, existing: true };
  // Every server conversion fans out to each destination (with retries), so cap them.
  const max = limits(env, await accountStanding(env, accountId)).maxDestinations;
  if (Number.isFinite(max)) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM destinations WHERE container_id = ?")
      .bind(containerId)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= max) {
      throw new ApiError(
        403,
        "quota_exceeded",
        `This container already has ${max} destinations, the most allowed here.`,
        `Remove one you don't need (DELETE /v1/containers/${containerId}/destinations/:did), or use one webhook that fans out on your side. Self-hosting? Raise MAX_DESTINATIONS_PER_CONTAINER.`,
      );
    }
  }
  const now = Date.now();
  const row: DestinationRow = {
    id: newId("dst"),
    container_id: containerId,
    account_id: accountId,
    type: input.type,
    name: input.name ?? null,
    natural_key: natural,
    public: JSON.stringify(publicFields(connector, creds)),
    credentials: await encryptSecret(encryptionKey(env), JSON.stringify(creds)),
    settings: JSON.stringify(input.settings ?? {}),
    enabled: input.enabled === false ? 0 : 1,
    created_at: now,
    updated_at: now,
    consecutive_failures: 0,
    circuit_open_until: null,
  };
  await env.DB.prepare(
    "INSERT INTO destinations (id, container_id, account_id, type, name, natural_key, public, credentials, settings, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, containerId, accountId, row.type, row.name, natural, row.public, row.credentials, row.settings, row.enabled, now, now)
    .run();
  await resync(env, accountId, containerId);
  return { row, existing: false };
}

export async function listDestinations(env: Bindings, accountId: string, containerId: string) {
  await getContainerRow(env, accountId, containerId);
  const { results } = await env.DB.prepare("SELECT * FROM destinations WHERE container_id = ? AND account_id = ? ORDER BY created_at")
    .bind(containerId, accountId)
    .all<DestinationRow>();
  return results;
}

export async function getDestination(env: Bindings, accountId: string, containerId: string, id: string) {
  return getRow(env, accountId, containerId, id);
}

/** Credentials merge: send only the fields that change (e.g. a new access_token). */
export async function updateDestination(
  env: Bindings,
  accountId: string,
  containerId: string,
  id: string,
  input: { name?: string | null; credentials?: Record<string, unknown>; settings?: z.infer<typeof destinationSettings>; enabled?: boolean },
  origins: string[] = [],
) {
  const row = await getRow(env, accountId, containerId, id);
  const connector = connectorOr400(row.type);
  let { credentials, public: pub, natural_key } = row;
  if (input.credentials) {
    const current = JSON.parse(await decryptSecret(encryptionKey(env), row.credentials)) as Record<string, unknown>;
    const merged = { ...current, ...input.credentials };
    for (const [k, v] of Object.entries(input.credentials)) if (v === null) delete merged[k];
    const creds = parseCredentials(env, connector, merged, origins);
    credentials = await encryptSecret(encryptionKey(env), JSON.stringify(creds));
    pub = JSON.stringify(publicFields(connector, creds));
    natural_key = connector.naturalKey(creds as never);
  }
  const next: DestinationRow = {
    ...row,
    name: input.name === undefined ? row.name : input.name,
    credentials,
    public: pub,
    natural_key,
    settings: input.settings ? JSON.stringify(input.settings) : row.settings,
    enabled: input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
    updated_at: Date.now(),
  };
  await env.DB.prepare(
    "UPDATE destinations SET name = ?, credentials = ?, public = ?, natural_key = ?, settings = ?, enabled = ?, updated_at = ? WHERE id = ?",
  )
    .bind(next.name, next.credentials, next.public, next.natural_key, next.settings, next.enabled, next.updated_at, id)
    .run();
  // An open circuit stays open across edits: only a passing test (rate limited) or the timeout
  // closes it, so editing a destination can't be used to reset the breaker over and over.
  await resync(env, accountId, containerId);
  return next;
}

export async function deleteDestination(env: Bindings, accountId: string, containerId: string, id: string) {
  await getRow(env, accountId, containerId, id);
  await env.DB.prepare("DELETE FROM destinations WHERE id = ?").bind(id).run();
  await resync(env, accountId, containerId);
}

export async function closeCircuit(env: Bindings, id: string) {
  await env.DB.prepare(
    "UPDATE destinations SET consecutive_failures = 0, circuit_open_until = NULL WHERE id = ? AND (consecutive_failures > 0 OR circuit_open_until IS NOT NULL)",
  )
    .bind(id)
    .run();
}

/** Destination types whose URL the account chooses: tests return a summary, never the raw body. */
const USER_URL_TYPES = new Set(["webhook", "analytics"]);

export async function loadCredentials(env: Bindings, row: DestinationRow): Promise<Record<string, unknown>> {
  return JSON.parse(await decryptSecret(encryptionKey(env), row.credentials)) as Record<string, unknown>;
}

/** A representative conversion for test sends (hashes of documented example values). */
export function sampleEvent(name: string, containerId: string, domain: string): DispatchEvent {
  const now = Date.now();
  return {
    event_id: `test.${now.toString(36)}`,
    name,
    ts: now,
    source: "server",
    test: true,
    value: 1.0,
    currency: "USD",
    transaction_id: `test-${now}`,
    page_url: `https://${domain}/`,
    ip: "203.0.113.7",
    user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    geo: { country: "US", region: "California", region_code: "CA", city: "San Francisco" },
    visitor_id: `test_${containerId}`,
    click_ids: { gclid: "TeSter-123_gclid-test-value" },
    // sha256("john_smith@gmail.com") and sha256("16505551212"): Meta's documented examples.
    user: {
      em: "62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f",
      ph: "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176",
      country: "us",
    },
    consent: { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
    send_to: {
      ga4: { event_name: name === "purchase" ? "purchase" : name },
      meta: { event_name: name === "purchase" ? "Purchase" : name },
      tiktok: { event_name: name === "purchase" ? "CompletePayment" : name },
      google_ads: {},
      analytics: { event_name: name },
    },
  };
}

export async function testDestination(
  env: Bindings,
  accountId: string,
  containerId: string,
  id: string,
  opts: { event_name?: string; test_event_code?: string },
): Promise<{ destination: ReturnType<typeof presentDestination>; test_mode: string; result: DeliveryResult; next_steps: string[] }> {
  const container = await getContainerRow(env, accountId, containerId);
  const row = await getRow(env, accountId, containerId, id);
  const connector = connectorOr400(row.type);
  await assertRate(
    env.TEST_LIMITER,
    accountId,
    "destination tests",
    "Wait a minute before testing again (tests are rate limited per account).",
  );
  const creds = await loadCredentials(env, row);
  if (opts.test_event_code) creds.test_event_code = opts.test_event_code;
  if ((row.type === "meta" || row.type === "tiktok") && !creds.test_event_code) {
    throw new ApiError(
      400,
      "test_event_code_required",
      `Testing ${row.type} without a test_event_code would record a real event.`,
      `Copy the code from ${row.type === "meta" ? "Meta Events Manager > (pixel) > Test events" : "TikTok Events Manager > (pixel) > Test events"} and pass { "test_event_code": "TEST..." } in this request, or PATCH it into credentials.`,
    );
  }
  const event = sampleEvent(opts.event_name ?? "purchase", containerId, container.domain);
  const result = await connector.send(event, creds as never, {
    test: true,
    fetch: (...a) => fetch(...a),
    env,
    destinationId: id,
    containerId,
  });
  if (USER_URL_TYPES.has(row.type)) {
    // The URL is the account's choice: report the status and a short summary, not the body.
    result.response = summarizeResponse(result.response);
    if (result.request) result.request = { url: result.request.url };
  }
  // A passing test closes an open circuit (deliveries resume now).
  const health = destinationHealth(row);
  if (result.ok && (health.circuit === "open" || health.consecutive_failures > 0)) {
    await closeCircuit(env, id);
    row.consecutive_failures = 0;
    row.circuit_open_until = null;
    await resync(env, accountId, containerId);
  }
  const next = result.ok
    ? [
        `The ${row.type} test passed. Publish a config whose conversions have server: true and send_to.${row.type} (analytics gets every server conversion; webhooks every matched conversion, or every event with settings.all_events).`,
        `After real traffic, GET /v1/containers/${containerId}/events shows each delivery and the platform's response.`,
      ]
    : [
        result.retryable
          ? "The platform was unreachable or rate-limited; retry in a minute."
          : "Read result.response: it's the platform's own error. Fix the credentials with PATCH /v1/containers/:id/destinations/:did { credentials: {...} } and test again.",
      ];
  if (!result.ok && destinationHealth(row).circuit === "open")
    next.push(
      "The destination's circuit is open (too many consecutive failures): deliveries are skipped until a test passes or it times out.",
    );
  return { destination: presentDestination(row), test_mode: connector.testMode, result, next_steps: next };
}
