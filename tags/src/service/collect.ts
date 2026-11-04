import { ApiError, accountSuspended, networkKey, parse } from "@afs/shared";
import UAParser from "ua-parser-js";
import type { ContainerConfig } from "../config/schema";
import type { CollectResult } from "../do/container-do";
import type { Bindings } from "../env";
import { CLICK_ID_DAYS, clickCookieName, VISITOR_COOKIE } from "../lib/clickids";
import { eventQuotaError } from "./budget";
import { containerStub, resyncById } from "./containers";
import { type CollectHit, cleanClickIds, cleanCollectPayload, type Enrichment } from "./ingest";
import { collectSchema } from "./ingest-schema";
import { originHost } from "./origin";
import { fromTrustedProxy } from "./proxy";
import { overLimit, rateLimited } from "./ratelimit";
import { MAX_USER_AGENT } from "./sanitize";
import { environmentByToken } from "./environments";
import { previewConfig, previewToken } from "./versions";
import { sha256Hex } from "@afs/shared";

const BOT =
  /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|facebookexternalhit|preview|prerender|python-requests|go-http-client|scrapy|httpclient/i;
export const MAX_COLLECT_BYTES = 64 * 1024;

export function geoFrom(req: Request): Enrichment["geo"] {
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const s = (k: string) => (typeof cf[k] === "string" && cf[k] ? (cf[k] as string) : undefined);
  return { country: s("country"), region: s("region"), region_code: s("regionCode"), city: s("city"), postal_code: s("postalCode") };
}

export function deviceFrom(ua: string | undefined, lang?: string | null): Enrichment["device"] {
  if (!ua) return undefined;
  const r = new UAParser(ua).getResult();
  const t = r.device.type;
  return {
    category: t === "mobile" ? "mobile" : t === "tablet" ? "tablet" : t === "smarttv" ? "smart TV" : "desktop",
    browser: r.browser.name,
    browser_version: r.browser.version,
    os: r.os.name,
    os_version: r.os.version,
    model: r.device.model,
    brand: r.device.vendor,
    language: lang ? lang.split(",")[0]?.split(";")[0]?.trim().slice(0, 10) : undefined,
  };
}

/**
 * Visitor IP. Forwarded headers are client-settable, so the first X-Forwarded-For hop is used
 * only when the request comes from the container's own first-party proxy (`trustedProxy`: it
 * carried the container's x-afs-proxy-key). Otherwise Cloudflare's cf-connecting-ip.
 */
export function clientIpFrom(req: Request, trustedProxy: boolean): string | undefined {
  if (trustedProxy) {
    const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (first && /^[0-9a-fA-F:.]{3,45}$/.test(first)) return first;
  }
  return req.headers.get("cf-connecting-ip") ?? undefined;
}

export const corsHeaders = (req: Request): Record<string, string> => {
  const origin = req.headers.get("origin");
  return origin && origin !== "null"
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        vary: "Origin",
      }
    : {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      };
};

/**
 * Cookies to (re-)set from the server when /collect is first-party (served through the site's
 * own domain): server-set cookies aren't subject to Safari's 7-day cap on script-set cookies.
 */
export function identityCookies(
  payload: ReturnType<typeof collectSchema.parse>,
  pageHost: string | null,
  domain: string | undefined,
  secure: boolean,
): string[] {
  if (!payload.first_party || !pageHost) return [];
  const out: string[] = [];
  let dom = "";
  if (domain && (pageHost === domain || pageHost.endsWith(`.${domain}`))) dom = `; Domain=${domain}`;
  const attrs = (days: number) => `; Path=/; Max-Age=${days * 86400}; SameSite=Lax${dom}${secure ? "; Secure" : ""}`;
  const c = payload.consent ?? {};
  const store = c.analytics_storage === "granted" || c.ad_storage === "granted";
  const ads = c.ad_storage === "granted";
  if (store && payload.visitor_id) out.push(`${VISITOR_COOKIE}=${encodeURIComponent(payload.visitor_id)}${attrs(395)}`);
  if (ads) {
    // Known click ids only: a raw key from the body would end up in the Set-Cookie name.
    for (const [k, v] of Object.entries(cleanClickIds(payload.click_ids))) {
      out.push(`${clickCookieName(k)}=${encodeURIComponent(v)}${attrs(CLICK_ID_DAYS)}`);
    }
    if (payload.fbc && /^fb\.\d\.\d+\.[A-Za-z0-9._~-]+$/.test(payload.fbc))
      out.push(`_fbc=${encodeURIComponent(payload.fbc)}${attrs(CLICK_ID_DAYS)}`);
    if (payload.fbp && /^fb\.\d\.\d+\.\d+$/.test(payload.fbp)) out.push(`_fbp=${encodeURIComponent(payload.fbp)}${attrs(CLICK_ID_DAYS)}`);
  }
  return out;
}

const RATE_HINT =
  "The runtime sends a few hits per page; this many from one network or for one container in a minute looks like a flood. Retry later.";

/**
 * Edge rate limits (Workers rate-limit bindings, per Cloudflare location): every hit per client
 * network (IPv4 address or IPv6 /48; the visitor's IP behind the container's own proxy) and per
 * container, and conversions (which fan out to destinations) tighter on both.
 */
export async function collectRateLimited(env: Bindings, ipKey: string, containerId: string, conversion: boolean): Promise<string | null> {
  const checks: [RateLimit | undefined, string, string][] = [
    [env.COLLECT_IP_LIMITER, ipKey, "hits from this network"],
    [env.COLLECT_CONTAINER_LIMITER, containerId, "hits for this container"],
    ...(conversion
      ? ([
          [env.CONVERSION_IP_LIMITER, ipKey, "conversions from this network"],
          [env.CONVERSION_CONTAINER_LIMITER, containerId, "conversions for this container"],
        ] as [RateLimit | undefined, string, string][])
      : []),
  ];
  for (const [limiter, key, what] of checks) if (await overLimit(limiter, key)) return what;
  return null;
}

export async function handleCollect(env: Bindings, req: Request): Promise<Response> {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-max-age": "86400" } });
  const json = (body: unknown, status = 200, extra: [string, string][] = []) => {
    const h = new Headers({ "content-type": "application/json", "cache-control": "no-store", ...cors });
    for (const [k, v] of extra) h.append(k, v);
    return new Response(JSON.stringify(body), { status, headers: h });
  };
  try {
    const text = await req.text();
    if (text.length > MAX_COLLECT_BYTES)
      throw new ApiError(413, "too_large", "Payload too large.", `Keep /collect bodies under ${MAX_COLLECT_BYTES} bytes.`);
    let raw: unknown;
    try {
      raw = JSON.parse(text || "{}");
    } catch {
      throw new ApiError(400, "bad_request", "Body is not JSON.", "POST a JSON object (text/plain is fine) as the runtime does.");
    }
    const payload = cleanCollectPayload(parse(collectSchema, raw));
    const ua = req.headers.get("user-agent")?.slice(0, MAX_USER_AGENT) ?? undefined;
    // Bots are dropped, except preview traffic (agents verify setups with headless browsers).
    if (ua && BOT.test(ua) && !payload.preview)
      return json({
        ok: true,
        ignored: "bot",
        hint: "Known bot/headless user agent. Use a preview link (POST /v1/containers/:id/preview) to test with a headless browser.",
      });
    // Rate limits before any storage is touched (the preview lookup reads D1).
    const ip = clientIpFrom(req, await fromTrustedProxy(env, req, payload.container_id));
    const limited = await collectRateLimited(env, networkKey(ip ?? null), payload.container_id, payload.type === "conversion");
    if (limited) throw rateLimited(limited, RATE_HINT);
    const host = originHost(req.headers.get("origin") ?? undefined, payload.page_url);
    let preview: ContainerConfig | undefined;
    let envConfig: ContainerConfig | undefined;
    const tok = payload.preview ? await previewToken(env, payload.preview) : null;
    if (tok?.container_id === payload.container_id) preview = (await previewConfig(env, tok.container_id, tok.version)) ?? undefined;
    if (payload.type === "debug") {
      // The preview log: only from a preview build of this container (a valid, unexpired token).
      if (!preview || !payload.preview)
        throw new ApiError(
          403,
          "preview_required",
          "Debug entries are accepted only from a preview link.",
          "POST /v1/containers/:id/preview creates one.",
        );
      const r = await containerStub(env, payload.container_id).previewLog(
        await sha256Hex(payload.preview),
        payload.entries ?? [],
        Date.now(),
      );
      if (!r.ok && r.error === "storage_full")
        throw new ApiError(507, "storage_full", "This container's event store is full.", "GET /v1/containers/:id shows stats.storage.");
      return json({ ok: true, stored: r.stored });
    }
    if (payload.env && !preview) envConfig = (await environmentByToken(env, payload.container_id, payload.env))?.config;
    const hit: CollectHit = {
      payload,
      enrich: {
        ip,
        user_agent: ua,
        geo: geoFrom(req),
        device: deviceFrom(ua, req.headers.get("accept-language")),
        origin_host: host ?? undefined,
        received_at: Date.now(),
      },
      preview_config: preview,
      env_config: envConfig,
    };
    const stub = containerStub(env, payload.container_id);
    let result: CollectResult = await stub.collect(hit);
    if (!result.ok && result.error === "not_synced") {
      // The object writes nothing until the control plane initialises it, so an id nobody created
      // costs one read here and one in D1. resync only initialises ids that exist in D1.
      if (!(await resyncById(env, payload.container_id))) {
        if (await stub.isStale()) await stub.destroy(); // leftover from older code: clean it up
        throw new ApiError(404, "not_found", "Unknown container.", "Check the container id in the snippet.");
      }
      result = await stub.collect(hit);
    }
    if (!result.ok) {
      if (result.error === "suspended") throw accountSuspended();
      if (result.error === "quota") throw eventQuotaError(env, { scope: result.scope, kind: "browser", limit: result.limit });
      if (result.error === "storage_full")
        throw new ApiError(
          507,
          "storage_full",
          `This container's event store is over its ${result.limit} byte limit; new hits aren't stored.`,
          "Old events (7 days) and visitors (180 days) are purged daily; GET /v1/containers/:id shows stats.storage.",
        );
      throw new ApiError(
        403,
        "origin_not_allowed",
        `Hits from "${result.error === "origin_not_allowed" ? (result.host ?? "unknown host") : "?"}" aren't accepted for this container.`,
        "The page must be on the container's domain (or a subdomain). Add other hosts with PATCH /v1/containers/:id { allowed_hostnames: [...] }.",
      );
    }
    const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
    const domain =
      payload.cookie_domain && host && (host === payload.cookie_domain || host.endsWith(`.${payload.cookie_domain}`))
        ? payload.cookie_domain
        : undefined;
    const cookies = identityCookies(payload, host, domain, secure).map((c) => ["set-cookie", c] as [string, string]);
    return json(
      {
        ok: true,
        event_id: result.event_id,
        ...(result.duplicate ? { duplicate: true } : {}),
        ...(result.destinations
          ? {
              destinations: result.destinations.map((d) => ({ type: d.type, status: d.status, ...(d.reason ? { reason: d.reason } : {}) })),
            }
          : {}),
        ...(result.note ? { note: result.note } : {}),
      },
      200,
      cookies,
    );
  } catch (e) {
    if (e instanceof ApiError) return json(e.toJSON(), e.status);
    console.error("collect error", e);
    return json({ error: { code: "internal", message: "Internal error." } }, 500);
  }
}
