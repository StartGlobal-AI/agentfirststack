import type { Db } from "../../src/do/db";
import { type IngestRequest, ingestChunk, type SessionMeta, type UsageSnapshot } from "../../src/do/engine";
import { deriveChunk } from "../../src/lib/derive";
import { envelope, T0 } from "../fixtures/rrweb";

export const NOW = T0 + 3_600_000;

export const META: SessionMeta = {
  device: "desktop",
  browser: "Chrome",
  browser_version: "131",
  os: "Mac OS",
  country: "DE",
  region: null,
  city: null,
  ua_hash: "ua1",
  user_id: null,
  analytics_visitor_id: null,
  forced: false,
};

export interface Opts {
  end?: boolean;
  now?: number;
  t?: number;
  bytes?: number;
  meta?: Partial<SessionMeta>;
  skew?: number;
  limits?: Partial<IngestRequest["limits"]>;
  forward?: boolean;
  net?: string;
  usage?: UsageSnapshot;
}

/** Derive a chunk from fixture events and ingest it, as the Worker + DO do. */
export function feed(db: Db, sid: string, seq: number, ev: unknown[], o: Opts = {}) {
  const env = envelope(sid, seq, ev, o.t !== undefined ? { t: o.t } : {});
  const chunk = deriveChunk(env, { minTs: T0 - 86_400_000, maxTs: Math.max(NOW, o.now ?? 0) + 3_600_000 });
  return ingestChunk(db, {
    now: o.now ?? NOW,
    session_id: sid,
    seq,
    bytes: o.bytes ?? 1000,
    chunk,
    skew_ms: o.skew ?? 0,
    meta: { ...META, ...o.meta },
    end: !!o.end,
    limits: { session_bytes: 1e9, max_session_ms: 30 * 60_000, daily_sessions: null, ...o.limits },
    forward: !!o.forward,
    net: o.net ?? null,
    usage: o.usage ?? null,
  });
}

export const sid = (n: number) => `rs_${String(n).padStart(16, "0")}`;
