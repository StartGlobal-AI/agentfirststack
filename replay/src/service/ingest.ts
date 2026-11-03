import { sha256Hex } from "@afs/shared";
import { chunkKey, type IngestResult } from "../do/engine";
import { type Bindings, isDev } from "../env";
import { gunzipCapped, gzip, readCapped } from "../lib/body";
import { deriveChunk, parseEnvelope } from "../lib/derive";
import { chunkBytesLimit, dailySessionsCap, LIMITS, sessionBytesLimit, sessionMinutesCap } from "../lib/limits";
import { SESSION_ID_RE, SITE_ID_RE } from "../lib/protocol";
import { botReason, parseUserAgent } from "../lib/ua";
import { siteHostAllowed } from "../lib/url";
import { analyticsAvailable, analyticsEvents, forwardSignals } from "./analytics";
import { jsonList, type SiteRow, siteById, siteStub } from "./context";

/**
 * POST /i?s=<site>&sid=<session>&q=<seq>&z=1|0: one recording chunk from the browser. Public and
 * CORS-enabled (anyone can call it), so everything is checked before it is stored: the site
 * exists and is enabled, the Origin and the recorded page hostnames belong to the site, sizes are
 * capped (compressed and decompressed), the body is a well-formed envelope for this session and
 * seq, automated browsers are dropped (unless the recording was forced with ?afsr=1). Then the
 * chunk is derived here (CPU in the stateless Worker), the site's DO stores the facts and
 * enforces the per-session and per-day limits, and the chunk goes to R2 as gzip.
 *
 * Answers are JSON the recorder reads: {ok:true} or {ok:false, error, hint, stop?}. stop:true
 * tells the recorder to end recording for the tab (limits, unknown site, disabled).
 */

export interface IngestResponse {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string, hint: string, stop = false): IngestResponse => ({
  status,
  body: { ok: false, error, hint, ...(stop ? { stop: true } : {}) },
});

const DAY = 86_400_000;
const SKEW_MIN_MS = 60_000;

function geo(req: Request, dev: boolean) {
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const s = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);
  if (dev) {
    const c = req.headers.get("x-dev-geo-country");
    if (c)
      return {
        country: c.toUpperCase().slice(0, 2),
        region: s(req.headers.get("x-dev-geo-region"), 100),
        city: s(req.headers.get("x-dev-geo-city"), 100),
      };
  }
  return { country: s(cf.country, 2)?.toUpperCase() ?? null, region: s(cf.region, 100), city: s(cf.city, 100) };
}

export async function ingestChunk(env: Bindings, req: Request, waitUntil: (p: Promise<unknown>) => void): Promise<IngestResponse> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const siteId = q.get("s") ?? "";
  const sid = q.get("sid") ?? "";
  const seqRaw = q.get("q") ?? "";
  const compressed = q.get("z") !== "0";
  if (!SITE_ID_RE.test(siteId))
    return fail(400, "bad_site_id", "?s= must be a replay site id (rsite_...). Use the snippet from GET /v1/sites/:id/install.", true);
  if (!SESSION_ID_RE.test(sid)) return fail(400, "bad_session_id", "?sid= must be rs_ + 16 base32 characters (the recorder generates it).");
  if (!/^\d{1,6}$/.test(seqRaw)) return fail(400, "bad_seq", "?q= must be the chunk number (0, 1, 2, ...).");
  const seq = Number(seqRaw);
  const site = await siteById(env, siteId);
  if (!site)
    return fail(404, "unknown_site", "This replay site does not exist (deleted?). Remove the snippet or create the site again.", true);
  const stub = siteStub(env, site.id);
  const drop = (reason: string, sample: string | null) => waitUntil(stub.recordDrop(reason, sample).catch(() => {}));
  if (!site.enabled) return fail(403, "disabled", "Recording is turned off for this site (enabled: false).", true);

  const dev = isDev(env);
  const allowed = site.allowed_hostnames ? jsonList(site.allowed_hostnames) : null;
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      /* invalid Origin */
    }
    if (!host || !siteHostAllowed(host, site.domain, allowed, dev)) {
      drop("origin_not_allowed", host || origin.slice(0, 100));
      return fail(
        403,
        "origin_not_allowed",
        `Chunks for this site are accepted from ${site.domain}, its subdomains and allowed_hostnames only.`,
        true,
      );
    }
  }

  const max = chunkBytesLimit(env);
  if (Number(req.headers.get("content-length")) > max) {
    drop("chunk_too_large", sid);
    return fail(413, "chunk_too_large", `Chunks are limited to ${max} bytes compressed; this page is too heavy to record here.`, true);
  }
  const { bytes, truncated } = await readCapped(req.body, max);
  if (truncated) {
    drop("chunk_too_large", sid);
    return fail(413, "chunk_too_large", `Chunks are limited to ${max} bytes compressed; this page is too heavy to record here.`, true);
  }
  let text: string;
  if (compressed) {
    const r = await gunzipCapped(bytes, LIMITS.DECOMPRESSED_BYTES);
    if ("error" in r)
      return fail(400, "invalid_gzip", "With z=1 the body must be gzip (CompressionStream('gzip')); send z=0 for plain JSON.");
    if (r.truncated) {
      drop("chunk_too_large", sid);
      return fail(413, "chunk_too_large", `A chunk may expand to at most ${LIMITS.DECOMPRESSED_BYTES} bytes.`, true);
    }
    text = r.text;
  } else text = new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(400, "invalid_json", "The (decompressed) body must be a JSON envelope {v:1, sid, seq, t, ev:[...]}.");
  }
  const parsed = parseEnvelope(raw, { sid, seq });
  if (!parsed.ok) return fail(400, parsed.error, parsed.hint);
  const envl = parsed.env;
  const ua = req.headers.get("user-agent");
  if (!envl.f) {
    const bot = botReason(ua, envl.wd === 1);
    if (bot) {
      drop(`bot:${bot}`, ua?.slice(0, 120) ?? null);
      return {
        status: 202,
        body: {
          ok: false,
          dropped: "bot",
          reason: bot,
          stop: true,
          hint: "Automated browsers are not recorded; open the page with ?afsr=1 to force a recording.",
        },
      };
    }
  }

  const now = Date.now();
  const skew = envl.t ? now - envl.t : 0;
  const shift = Math.abs(skew) > SKEW_MIN_MS ? Math.round(skew / 1000) * 1000 : 0;
  // Bounds are in the client's clock; the DO shifts the facts by the session's skew.
  const derived = deriveChunk(envl, { minTs: now - shift - DAY, maxTs: now - shift + 5 * 60_000 });
  const foreign = derived.hosts.find((h) => h && !siteHostAllowed(h, site.domain, allowed, dev));
  if (foreign) {
    drop("hostname_not_allowed", foreign);
    return fail(
      403,
      "hostname_not_allowed",
      `Recorded pages must be on ${site.domain}, its subdomains or allowed_hostnames (got ${foreign}).`,
      true,
    );
  }

  const device = parseUserAgent(ua, derived.viewport?.w ?? null);
  const stored = compressed ? bytes : await gzip(text);
  const result: IngestResult = await stub.ingest({
    now,
    session_id: sid,
    seq,
    bytes: stored.byteLength,
    chunk: derived,
    skew_ms: shift,
    meta: {
      ...device,
      ...geo(req, dev),
      ua_hash: ua ? (await sha256Hex(ua)).slice(0, 16) : null,
      user_id: envl.uid ?? null,
      analytics_visitor_id: envl.avid ?? null,
      forced: envl.f === 1,
    },
    end: envl.end === 1,
    limits: {
      session_bytes: sessionBytesLimit(env),
      max_session_ms: Math.min(site.max_session_minutes, sessionMinutesCap(env)) * 60_000,
      daily_sessions: dailySessionsCap(env),
    },
    forward: !!site.analytics_site_id && analyticsAvailable(env),
  });
  if (result.status === "duplicate") return { status: 200, body: { ok: true, duplicate: true } };
  if (result.status === "rejected") {
    const hints: Record<string, string> = {
      daily_session_limit:
        "This site recorded the most sessions allowed per day here (MAX_SESSIONS_PER_SITE_PER_DAY); new sessions resume after 00:00 UTC.",
      session_bytes_limit: "This session stored the most bytes allowed per session; recording stopped.",
      session_chunk_limit: "This session sent the most chunks allowed; recording stopped.",
      max_duration: "This session passed max_session_minutes; recording stopped.",
      session_mismatch: "This session id belongs to another browser.",
      unknown_site: "This replay site was deleted.",
    };
    return fail(
      result.reason === "daily_session_limit" ? 429 : 403,
      result.reason,
      hints[result.reason] ?? "Recording stopped.",
      result.stop,
    );
  }

  try {
    await env.CHUNKS.put(`${site.id}/${chunkKey(sid, seq)}`, stored, {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
      customMetadata: { first_ts: String(derived.first_ts), last_ts: String(derived.last_ts), events: String(derived.rr_events) },
    });
  } catch (e) {
    console.error("replay chunk store failed", e);
    return fail(500, "storage_failed", "The chunk's facts were kept but its recording could not be stored; nothing to do.");
  }
  if (result.forward.length && site.analytics_site_id)
    waitUntil(
      forward(env, site, result.forward, {
        ip: req.headers.get("cf-connecting-ip"),
        user_agent: ua,
        analytics_visitor_id: envl.avid ?? null,
      }),
    );
  return { status: 202, body: { ok: true, session_id: sid, seq, new_session: result.new_session } };
}

function forward(
  env: Bindings,
  site: SiteRow,
  items: Parameters<typeof analyticsEvents>[0],
  visitor: Parameters<typeof analyticsEvents>[2],
) {
  return forwardSignals(env, site.account_id, site.analytics_site_id!, analyticsEvents(items, site.domain, visitor)).catch((e) =>
    console.error("replay forward failed", e),
  );
}
