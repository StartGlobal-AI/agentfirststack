import { getConnector } from "../destinations";
import type { DeliveryResult } from "../destinations/types";
import type { DispatchMessage } from "../do/container-do";
import type { Bindings } from "../env";
import { containerStub } from "./containers";
import { type DestinationRow, loadCredentials } from "./destinations";

/** Attempts before a delivery is marked failed; kept within max_retries (6) + 1 in wrangler.jsonc so the last attempt is recorded here, not dropped. */
export const MAX_ATTEMPTS = 6;

/** 30s, 60s, 2m, 4m, 8m ... capped at 1h. */
export const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3600);

const clip = (v: unknown, max = 4000): unknown => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return v;
  if (s.length <= max) return v;
  return `${s.slice(0, max)}...(truncated)`;
};

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

  await Promise.all(
    batch.messages.map(async (msg) => {
      const m = msg.body;
      const stub = containerStub(env, m.container_id);
      // The event log keys rows by (source, event_id); a browser and a server row may share an id.
      const record = (r: Parameters<typeof stub.recordResult>[2]) =>
        stub.recordResult(m.event.event_id, m.destination_id, r, m.event.source === "server" ? "server" : "browser");
      const row = rows.get(m.destination_id);
      const connector = getConnector(m.type);
      if (!row || !row.enabled || !connector) {
        await record({
          type: m.type,
          status: "skipped",
          reason: row ? "destination disabled" : "destination deleted",
          attempts: msg.attempts,
        });
        msg.ack();
        return;
      }
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
      const final = result.ok || !result.retryable || msg.attempts >= MAX_ATTEMPTS;
      await record({
        type: m.type,
        status: result.ok ? "delivered" : final ? "failed" : "retrying",
        attempts: msg.attempts,
        http_status: result.http_status,
        response: clip(result.response),
        error: result.error,
        request: clip(result.request, 8000),
        ...(!final ? { reason: `retrying in ${backoffSeconds(msg.attempts)}s` } : {}),
      });
      if (final) msg.ack();
      else msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
    }),
  );
}
