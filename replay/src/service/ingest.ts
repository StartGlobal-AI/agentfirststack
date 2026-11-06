import { accountStanding, clientIp, edgeHost, networkKey, sha256Hex } from "@afs/shared";
import { chunkKey, type IngestResult } from "../do/engine";
import { type Bindings, isDev } from "../env";
import { gunzipCapped, gzip, readCapped } from "../lib/body";
import { deriveChunk, parseEnvelope } from "../lib/derive";
import { chunkBytesLimit, type IngestCaps, ingestCaps, LIMITS, sessionBytesLimit, sessionMinutesCap } from "../lib/limits";
import { SESSION_ID_RE, SITE_ID_RE } from "../lib/protocol";
import { Sampler } from "../lib/sampler";
import { botReason, parseUserAgent } from "../lib/ua";
import { type Cidr, ipInRanges, parseCidr } from "../lib/ip";
import { isLocalHost, originHostname, secureOriginHost, siteHostAllowed } from "../lib/url";

const rangeCache = new Map<string, Cidr[]>();
function rangesOf(json: string): Cidr[] {
  let r = rangeCache.get(json);
  if (!r) {
    r = jsonList(json)
      .map(parseCidr)
      .filter((x): x is Cidr => !!x);
    if (rangeCache.size > 2000) rangeCache.clear();
    rangeCache.set(json, r);
  }
  return r;
}
import { analyticsAvailable, analyticsEvents, forwardSignals } from "./analytics";
import { tagsAvailable } from "./tags";
import { tagsSignalsOf } from "../lib/tags";
import { isVerified, jsonList, type SiteRow, siteById, siteStub } from "./context";
import { onNewErrors, onSessionEnd } from "./webhook-events";

/**
 * POST /i?s=<site>&sid=<session>&q=<seq>&z=1|0: one recording chunk from the browser. Public and
 * CORS-enabled (anyone can call it, and site ids are public in every customer's HTML), so
 * everything is checked before it is stored, cheapest first:
 *   - edge rate limits per client network (before any D1 read), per site + network, per site;
 *   - the site exists, is enabled, its account isn't suspended; the deployment and the account
 *     aren't over their daily budget (remembered per isolate once the DO said so);
 *   - an Origin header naming the site's domain, a subdomain or allowed_hostnames (no Origin, or
 *     "null", is refused: browsers always send one with the recorder's requests);
 *   - sizes (compressed and decompressed), a well-formed envelope for this session and seq, mostly
 *     valid rrweb events, page hostnames that belong to the site;
 *   - automated browsers are dropped, unless the recording was forced with ?afsr=1, which counts
 *     against its own small daily quota instead.
 * Then the chunk is derived here (CPU in the stateless Worker), the site's DO stores the facts and
 * enforces the per-session, per-site, per-network, per-account and deployment limits, and the
 * chunk goes to R2 as gzip.
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
const BUSY_MS = 60_000;

/**
 * The visitor's IP: cf-connecting-ip, or, behind the platform's edge serving a first-party domain
 * (edge.example.com/_r/*, over a service binding with INTERNAL_TOKEN: @afs/shared edgeHost), the
 * first X-Forwarded-For hop the edge sets. Anyone else's X-Forwarded-For is ignored.
 */
export function visitorIp(req: Request, env: { INTERNAL_TOKEN?: string }): string | null {
  if (edgeHost(env, req)) {
    const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (first && /^[0-9a-fA-F:.]{3,45}$/.test(first)) return first;
  }
  return clientIp(req);
}

const forwarded = (req: Request, name: string, n: number) => {
  const raw = req.headers.get(`x-afs-geo-${name}`);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, n) || null;
  } catch {
    return raw.slice(0, n) || null;
  }
};

/** The visitor's country, region and city: Cloudflare's, or the edge's forwarded ones (x-afs-geo-*) for a first-party domain. */
export function geo(req: Request, dev: boolean, env: { INTERNAL_TOKEN?: string } = {}) {
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
  const country = forwarded(req, "country", 2);
  if (country && edgeHost(env, req))
    return { country: country.toUpperCase(), region: forwarded(req, "region", 100), city: forwarded(req, "city", 100) };
  return { country: s(cf.country, 2)?.toUpperCase() ?? null, region: s(cf.region, 100), city: s(cf.city, 100) };
}

/** A rate-limit binding's verdict; unbound or failing = allowed (fail open). */
export async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

// Refusals counted per isolate: the first per site and reason goes to the DO at once, then at most
// one write a minute carrying the count (a flood of refused chunks costs no DO write each).
const drops = new Sampler(60_000, 5_000);
// The DO said the deployment or an account is over its daily budget: refuse here for a minute.
const busy = new Map<string, number>();

// Keyed by the budget in force, so a refusal under one configuration never outlives it.
const busyKeys = (accountId: string, caps: IngestCaps) => ({
  platform: `p:${JSON.stringify(caps.platform)}`,
  account: `a:${accountId}:${JSON.stringify(caps.account)}`,
});

function busyReason(keys: ReturnType<typeof busyKeys>, now: number): string | null {
  const p = busy.get(keys.platform);
  if (p && p > now) return "platform_budget";
  const a = busy.get(keys.account);
  return a && a > now ? "account_daily_limit" : null;
}

function markBusy(r: Extract<IngestResult, { status: "rejected" }>, keys: ReturnType<typeof busyKeys>, now: number) {
  // Running sessions continue when only new sessions are capped.
  if (!r.counter || r.counter === "sessions") return;
  if (busy.size > 5_000) busy.clear();
  if (r.reason === "platform_budget") busy.set(keys.platform, now + BUSY_MS);
  else if (r.reason === "account_daily_limit") busy.set(keys.account, now + BUSY_MS);
}

const HINTS: Record<string, string> = {
  rate_limited: "Too many chunks from this network or for this site right now; recording resumes on its own.",
  daily_session_limit:
    "This site recorded the most sessions allowed per day here (MAX_SESSIONS_PER_SITE_PER_DAY); new sessions resume after 00:00 UTC.",
  unverified_daily_limit:
    "The site's domain isn't verified yet, so it records a small trial quota per day. Verify it: POST /v1/sites/:id/verify (the loader on https://<domain>/, or a DNS TXT record).",
  forced_daily_limit: "This site recorded the most ?afsr=1 test sessions allowed per day; normal sessions continue.",
  upgraded_daily_limit: "This site recorded the most afsr('upgrade') sessions allowed per day (MAX_UPGRADED_SESSIONS_PER_SITE_PER_DAY).",
  ip_daily_limit: "This network started the most sessions allowed per site and day.",
  account_daily_limit: "The account used its daily recording budget here; recording resumes after 00:00 UTC.",
  platform_budget: "The service is at its daily recording capacity; recording resumes later (after 00:00 UTC at the latest).",
  session_bytes_limit: "This session stored the most bytes allowed per session; recording stopped.",
  session_chunk_limit: "This session sent the most chunks allowed; recording stopped.",
  max_duration: "This session passed max_session_minutes; recording stopped.",
  session_mismatch: "This session id belongs to another browser.",
  session_deleted: "This session was deleted (privacy request); it isn't recorded again.",
  page_host_required: "A new session's first chunk carries its page (afs.page with the hostname); this one didn't.",
  unknown_site: "This replay site was deleted.",
};

const STATUS: Record<string, number> = {
  daily_session_limit: 429,
  unverified_daily_limit: 429,
  forced_daily_limit: 429,
  upgraded_daily_limit: 429,
  ip_daily_limit: 429,
  account_daily_limit: 429,
  platform_budget: 429,
  page_host_required: 400,
};

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
  const net = networkKey(visitorIp(req, env));
  // Before any D1 read: a flood of random site ids from one network stops here.
  if (!(await allowed(env.INGEST_IP_LIMITER, `i:${net}`))) return fail(429, "rate_limited", HINTS.rate_limited!);
  const site = await siteById(env, siteId);
  if (!site)
    return fail(404, "unknown_site", "This replay site does not exist (deleted?). Remove the snippet or create the site again.", true);
  const now = Date.now();
  const stub = siteStub(env, site.id);
  const drop = (reason: string, sample: string | null) => {
    const t = drops.take(`${site.id}:${reason}`, Date.now(), sample);
    if (t) waitUntil(stub.recordDrop(reason, t.sample, t.count).catch(() => {}));
  };
  const standing = await accountStanding(env, site.account_id);
  if (standing.suspended)
    return fail(403, "account_suspended", "The account that owns this replay site is suspended; nothing is recorded.", true);
  if (!site.enabled) return fail(403, "disabled", "Recording is turned off for this site (enabled: false).", true);
  if (!(await allowed(env.INGEST_SITE_IP_LIMITER, `${site.id}:${net}`)) || !(await allowed(env.INGEST_SITE_LIMITER, site.id))) {
    drop("rate_limited", null);
    return fail(429, "rate_limited", HINTS.rate_limited!);
  }
  const verified = isVerified(site);
  const caps = ingestCaps(env, standing, verified);
  const keys = busyKeys(site.account_id, caps);
  const over = busyReason(keys, now);
  if (over) {
    drop(over, null);
    return fail(429, over, HINTS[over]!, true);
  }

  const dev = isDev(env);
  const allowedHosts = site.allowed_hostnames ? jsonList(site.allowed_hostnames) : null;
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") {
    drop("origin_missing", null);
    return fail(
      403,
      "origin_required",
      "Chunks are accepted only from pages (with an Origin header) on the site's domain, its subdomains or allowed_hostnames.",
      true,
    );
  }
  // https pages only (a plain-http page can be rewritten by anyone on the path); http://localhost in dev.
  const host = secureOriginHost(origin, dev);
  // Local development pages (localhost, 127.0.0.1) are refused under their own reason, so verify
  // can say it's expected instead of suggesting allowed_hostnames (which takes no IPs or localhost).
  const local = isLocalHost(host ?? originHostname(origin));
  if (host === null && /^http:\/\//i.test(origin)) {
    drop(local ? "origin_local" : "origin_not_https", origin.slice(0, 100));
    return fail(403, "origin_not_https", "Chunks are accepted from https pages only (http://localhost in local development).", true);
  }
  if (!host || !siteHostAllowed(host, site.domain, allowedHosts, dev)) {
    drop(local ? "origin_local" : "origin_not_allowed", host || origin.slice(0, 100));
    return fail(
      403,
      "origin_not_allowed",
      `Chunks for this site are accepted from ${site.domain}, its subdomains and allowed_hostnames only.`,
      true,
    );
  }

  // exclude_ip_ranges (an office, a QA network): checked here, the address is never stored.
  if (site.exclude_ip_ranges && ipInRanges(visitorIp(req, env), rangesOf(site.exclude_ip_ranges))) {
    drop("ip_excluded", null);
    return fail(403, "ip_excluded", "This network is in the site's exclude_ip_ranges; it isn't recorded.", true);
  }

  const max = chunkBytesLimit(env);
  if (Number(req.headers.get("content-length")) > max) {
    drop("chunk_too_large", null);
    return fail(413, "chunk_too_large", `Chunks are limited to ${max} bytes compressed; this page is too heavy to record here.`, true);
  }
  const { bytes, truncated } = await readCapped(req.body, max);
  if (truncated) {
    drop("chunk_too_large", null);
    return fail(413, "chunk_too_large", `Chunks are limited to ${max} bytes compressed; this page is too heavy to record here.`, true);
  }
  let text: string;
  if (compressed) {
    const r = await gunzipCapped(bytes, LIMITS.DECOMPRESSED_BYTES);
    if ("error" in r)
      return fail(400, "invalid_gzip", "With z=1 the body must be gzip (CompressionStream('gzip')); send z=0 for plain JSON.");
    if (r.truncated) {
      drop("chunk_too_large", null);
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
  // ?afsr=1 recordings skip the bot filter (installs are verified from headless browsers) but have
  // their own small daily quota per site (MAX_FORCED_SESSIONS_PER_SITE_PER_DAY), checked in the DO.
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

  const skew = envl.t ? now - envl.t : 0;
  const shift = Math.abs(skew) > SKEW_MIN_MS ? Math.round(skew / 1000) * 1000 : 0;
  // Bounds are in the client's clock; the DO shifts the facts by the session's skew.
  const derived = deriveChunk(envl, { minTs: now - shift - DAY, maxTs: now - shift + 5 * 60_000, maxDerived: caps.derived_per_chunk });
  if (derived.invalid > 20 && derived.invalid > derived.rr_events)
    return fail(400, "invalid_events", "Most entries of ev are not rrweb events with a current timestamp; nothing was stored.");
  const foreign = derived.hosts.find((h) => !siteHostAllowed(h, site.domain, allowedHosts, dev));
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
  const forward = verified && !!site.analytics_site_id && analyticsAvailable(env);
  const toTags = verified && !!site.tags_container_id && tagsAvailable(env);
  const result = await stub.ingest({
    now,
    session_id: sid,
    seq,
    bytes: stored.byteLength,
    chunk: derived,
    skew_ms: shift,
    meta: {
      ...device,
      ...geo(req, dev, env),
      ua_hash: ua ? (await sha256Hex(ua)).slice(0, 16) : null,
      user_id: envl.uid ?? null,
      analytics_visitor_id: envl.avid ?? null,
      forced: envl.f === 1,
      upgraded: envl.up ?? null,
      debug: envl.dbg === 1,
    },
    end: envl.end === 1,
    limits: {
      session_bytes: sessionBytesLimit(env),
      max_session_ms: Math.min(site.max_session_minutes, sessionMinutesCap(env)) * 60_000,
      chunks_per_session: caps.chunks_per_session,
      derived_per_session: caps.derived_per_session,
      daily_sessions: caps.daily_sessions,
      forced_daily: caps.forced_daily,
      upgraded_daily: caps.upgraded_daily,
      net_daily: caps.net_daily,
      forward_daily: caps.forward_daily,
      account: caps.account,
      platform: caps.platform,
    },
    forward,
    tags: toTags
      ? { host: site.domain, signals: tagsSignalsOf(site.tags_signals), visitor_id: envl.tvid ?? null, daily: caps.tags_daily }
      : null,
    tags_container: toTags ? site.tags_container_id : null,
    net: (await sha256Hex(`replay-net:${net}`)).slice(0, 16),
    account_id: site.account_id,
    config: { site_id: site.id, retention_days: site.retention_days, heatmap_retention_days: site.heatmap_retention_days },
  });
  if (result.status === "duplicate") return { status: 200, body: { ok: true, duplicate: true } };
  if (result.status === "rejected") {
    markBusy(result, keys, now);
    const reason = result.reason === "daily_session_limit" && !verified ? "unverified_daily_limit" : result.reason;
    return fail(STATUS[reason] ?? 403, reason, HINTS[reason] ?? "Recording stopped.", result.stop);
  }

  // A chunk without rrweb events has nothing to play: its facts are kept, no R2 object is written.
  if (derived.rr_events > 0) {
    try {
      await env.CHUNKS.put(`${site.id}/${chunkKey(sid, seq)}`, stored, {
        httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
        customMetadata: { first_ts: String(derived.first_ts), last_ts: String(derived.last_ts), events: String(derived.rr_events) },
      });
    } catch (e) {
      console.error("replay chunk store failed", e);
      return fail(500, "storage_failed", "The chunk's facts were kept but its recording could not be stored; nothing to do.");
    }
  }
  // Webhooks (verified sites; nothing to do without subscriptions): new error groups, segment entries.
  if (verified && result.new_errors?.length)
    waitUntil(onNewErrors(env, site, sid, result.new_errors).catch((e) => console.error("replay error.new failed", e)));
  if (verified && envl.end === 1) waitUntil(onSessionEnd(env, site, sid).catch((e) => console.error("replay segment.session failed", e)));
  if (result.forward.length && site.analytics_site_id)
    waitUntil(
      forwardTo(
        env,
        site,
        result.forward,
        { ip: visitorIp(req, env), user_agent: ua, analytics_visitor_id: envl.avid ?? null },
        result.test,
      ),
    );
  return { status: 202, body: { ok: true, session_id: sid, seq, new_session: result.new_session } };
}

function forwardTo(
  env: Bindings,
  site: SiteRow,
  items: Parameters<typeof analyticsEvents>[0],
  visitor: Parameters<typeof analyticsEvents>[2],
  test: boolean,
) {
  return forwardSignals(env, site.account_id, site.analytics_site_id!, analyticsEvents(items, site.domain, visitor, test)).catch((e) =>
    console.error("replay forward failed", e),
  );
}
