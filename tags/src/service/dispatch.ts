import { accountStanding } from "@afs/shared";
import { getConnector } from "../destinations";
import type { DeliveryResult } from "../destinations/types";
import type { DispatchMessage } from "../do/container-do";
import type { Bindings } from "../env";
import { containerStub, getContainerRow, syncToDO } from "./containers";
import { type DestinationRow, loadCredentials } from "./destinations";
import { circuitReason } from "./dispatch-plan";
import { circuitBreaker } from "./limits";
import { sanitizeText } from "./sanitize";

/** Attempts before a delivery is marked failed; kept within max_retries (6) + 1 in wrangler.jsonc so the last attempt is recorded here, not dropped. Webhooks use fewer (their connector's maxAttempts). */
export const MAX_ATTEMPTS = 6;

/** 30s, 60s, 2m, 4m, 8m ... capped at 1h. */
export const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3600);

const clip = (v: unknown, max = 4000): unknown => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return v;
  if (s.length <= max) return v;
  return `${s.slice(0, max)}...(truncated)`;
};

/** Outcomes of real send attempts in one batch, per destination, in order (true = ok). */
type Outcomes = Map<string, { results: boolean[]; lastError?: string }>;

/**
 * Circuit breaker: CIRCUIT_BREAKER_FAILURES consecutive failed attempts (each retry counts) open
 * a destination's circuit for CIRCUIT_BREAKER_MINUTES; meanwhile the ContainerDO plans its
 * deliveries as skipped (reason in the event log) and this consumer drops queued ones without
 * sending. After the timeout deliveries flow again; one more failure re-opens it, a success (or
 * a passing test) closes it. State lives on the D1 row; the DO gets a copy on open and close.
 */
export async function updateBreakers(env: Bindings, rows: Map<string, DestinationRow>, outcomes: Outcomes, now = Date.now()) {
  const { failures: threshold, openMs } = circuitBreaker(env);
  const changed = new Set<string>();
  for (const [id, o] of outcomes) {
    const row = rows.get(id);
    if (!row || !o.results.length) continue;
    const lastOk = o.results.lastIndexOf(true);
    const trailing = o.results.length - 1 - lastOk; // failures after the last success
    const reset = lastOk >= 0;
    const wasOpen = !!row.circuit_open_until && row.circuit_open_until > now;
    if (reset && trailing === 0) {
      if ((row.consecutive_failures ?? 0) === 0 && row.circuit_open_until == null) continue;
      await env.DB.prepare("UPDATE destinations SET consecutive_failures = 0, circuit_open_until = NULL WHERE id = ?").bind(id).run();
      if (row.circuit_open_until != null) changed.add(row.container_id);
      continue;
    }
    // Atomic in D1: concurrent batches for the same destination add up instead of overwriting.
    const r = await env.DB.prepare(
      `UPDATE destinations SET
         consecutive_failures = CASE WHEN ?2 THEN ?3 ELSE consecutive_failures + ?3 END,
         last_failure = ?4, last_failure_at = ?5,
         circuit_open_until = CASE WHEN ?6 > 0 AND (CASE WHEN ?2 THEN ?3 ELSE consecutive_failures + ?3 END) >= ?6 THEN ?7 ELSE circuit_open_until END
       WHERE id = ?1 RETURNING consecutive_failures, circuit_open_until`,
    )
      .bind(
        id,
        reset ? 1 : 0,
        trailing,
        o.lastError ? sanitizeText(o.lastError, 300) : null,
        now,
        Number.isFinite(threshold) ? threshold : 0,
        now + openMs,
      )
      .first<{ consecutive_failures: number; circuit_open_until: number | null }>();
    const open = !!r?.circuit_open_until && r.circuit_open_until > now;
    if (open && !wasOpen) {
      console.warn(`destination ${id} circuit opened after ${r?.consecutive_failures} consecutive failures`);
      changed.add(row.container_id);
    }
  }
  // Push the new circuit state to each affected ContainerDO so it plans deliveries as skipped.
  for (const containerId of changed) {
    const row = [...rows.values()].find((r) => r.container_id === containerId);
    if (!row) continue;
    try {
      await syncToDO(env, await getContainerRow(env, row.account_id, containerId), { destinations: true });
    } catch (e) {
      console.error("circuit resync failed", e);
    }
  }
}

/** Queue consumer for `tags-dispatch`: one message = one event for one destination. */
export async function handleDispatchBatch(batch: MessageBatch<DispatchMessage>, env: Bindings) {
  const ids = [...new Set(batch.messages.map((m) => m.body.destination_id))];
  const rows = new Map<string, DestinationRow>();
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT * FROM destinations WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<DestinationRow>();
    for (const r of results) rows.set(r.id, r);
  }
  const creds = new Map<string, Record<string, unknown>>();
  const outcomes: Outcomes = new Map();
  const now = Date.now();

  await Promise.all(
    batch.messages.map(async (msg) => {
      const m = msg.body;
      const stub = containerStub(env, m.container_id);
      // The event log keys rows by (source, event_id); a browser and a server row may share an id.
      const record = (r: Parameters<typeof stub.recordResult>[2]) =>
        stub.recordResult(m.event.event_id, m.destination_id, r, m.event.source === "server" ? "server" : "browser");
      const row = rows.get(m.destination_id);
      const connector = getConnector(m.type);
      const skip = async (reason: string) => {
        await record({ type: m.type, status: "skipped", reason, attempts: msg.attempts });
        msg.ack();
      };
      if (!row || !row.enabled || !connector) return skip(row ? "destination disabled" : "destination deleted");
      if ((await accountStanding(env, row.account_id)).suspended) return skip("account suspended");
      if (row.circuit_open_until && row.circuit_open_until > now)
        return skip(circuitReason(row.circuit_open_until, row.consecutive_failures));
      let result: DeliveryResult;
      try {
        if (!creds.has(row.id)) creds.set(row.id, await loadCredentials(env, row));
        result = await connector.send(m.event, creds.get(row.id) as never, {
          test: m.test,
          fetch: (...a) => fetch(...a),
          env,
          destinationId: row.id,
          containerId: m.container_id,
        });
      } catch (e) {
        result = { ok: false, retryable: false, error: e instanceof Error ? e.message : String(e) };
      }
      const o = outcomes.get(row.id) ?? { results: [] };
      o.results.push(result.ok);
      if (!result.ok) o.lastError = result.error ?? `HTTP ${result.http_status ?? "error"}`;
      outcomes.set(row.id, o);
      const maxAttempts = connector.maxAttempts ?? MAX_ATTEMPTS;
      const final = result.ok || !result.retryable || msg.attempts >= maxAttempts;
      await record({
        type: m.type,
        status: result.ok ? "delivered" : final ? "failed" : "retrying",
        attempts: msg.attempts,
        http_status: result.http_status,
        response: clip(result.response),
        error: result.error,
        request: clip(result.request, 8000),
        ...(!final ? { reason: `retrying in ${backoffSeconds(msg.attempts)}s (attempt ${msg.attempts} of ${maxAttempts})` } : {}),
      });
      if (final) msg.ack();
      else msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    }),
  );
  await updateBreakers(env, rows, outcomes, now);
}
