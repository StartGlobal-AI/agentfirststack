import { ApiError, accountSuspended, newId } from "@afs/shared";
import type { EventFilter, IngestRefusal, ServerIngestResult } from "../do/container-do";
import type { Bindings } from "../env";
import { eventQuotaError } from "./budget";
import { containerStub, getContainerRow, syncToDO } from "./containers";
import { cleanServerEvent } from "./ingest";
import type { ServerEvent } from "./ingest-schema";
import { assertRate } from "./ratelimit";

function refusal(env: Bindings, r: IngestRefusal): ApiError {
  switch (r.error) {
    case "suspended":
      return accountSuspended();
    case "quota":
      return eventQuotaError(env, { scope: r.scope, kind: "server", limit: r.limit, used: r.used });
    case "storage_full":
      return new ApiError(
        507,
        "storage_full",
        `This container's event store is over its limit (${r.limit} bytes).`,
        "Old events (7 days) and visitors (180 days) are purged daily; GET /v1/containers/:id shows stats.storage.",
      );
    default:
      return new ApiError(503, "not_ready", "The container's data store isn't ready.", "Retry in a few seconds.");
  }
}

export async function ingestServerEvents(env: Bindings, accountId: string, containerId: string, events: ServerEvent[], test: boolean) {
  const row = await getContainerRow(env, accountId, containerId);
  await assertRate(
    env.SERVER_EVENTS_LIMITER,
    accountId,
    "server event requests",
    "Batch up to 100 events per request and retry in a minute.",
  );
  const clean = events.map(cleanServerEvent);
  const stub = containerStub(env, containerId);
  let r = await stub.ingestServer(clean, { test, now: Date.now() });
  if (!Array.isArray(r) && r.error === "not_synced") {
    await syncToDO(env, row);
    r = await stub.ingestServer(clean, { test, now: Date.now() });
  }
  if (!Array.isArray(r)) throw refusal(env, r as IngestRefusal);
  const results = r as ServerIngestResult[];
  return {
    accepted: results.filter((x) => x.status === "accepted").length,
    duplicates: results.filter((x) => x.status === "duplicate").length,
    results,
    live_version: row.live_version,
    next_steps: [
      `GET /v1/containers/${containerId}/events shows each event's delivery status per destination (queued -> delivered/failed) within a few seconds.`,
      ...(row.live_version == null
        ? [
            "Nothing is published yet, so no conversion definitions apply: publish a config whose conversions match these event names (or pass send_to per event).",
          ]
        : []),
    ],
  };
}

export async function eventLog(env: Bindings, accountId: string, containerId: string, f: EventFilter) {
  await getContainerRow(env, accountId, containerId);
  // RPC typing can't express `unknown` payloads; the DO returns plain JSON.
  return (await containerStub(env, containerId).listEvents(f)) as unknown as {
    events: Record<string, unknown>[];
    next_before: number | null;
  };
}

export async function visitor(env: Bindings, accountId: string, containerId: string, visitorId: string) {
  await getContainerRow(env, accountId, containerId);
  const v = await containerStub(env, containerId).getVisitor(visitorId);
  if (!v)
    throw new ApiError(
      404,
      "not_found",
      "Visitor not found.",
      "Visitor ids come from the _afst_vid cookie or afst('get','visitor_id'); visitors are stored after their first /collect hit.",
    );
  return v;
}

export const parseSince = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s) < 1e12 ? Number(s) * 1000 : Number(s);
  const rel = /^(\d+)(m|h|d)$/.exec(s);
  if (rel) return Date.now() - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"];
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw new ApiError(400, "bad_request", `Can't parse since="${s}".`, 'Use unix ms, ISO 8601, or relative like "15m", "2h", "7d".');
};

export const randomEventId = () => newId("evt", 20);
