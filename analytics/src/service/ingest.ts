import { ECOMMERCE_SET, MAX_ITEMS_READ, cleanItems } from "../lib/items";
import { ApiError, accountSuspended, networkKey, parse, randomString, timingSafeEqual } from "@afs/shared";
import { z } from "zod";
import { type Bindings, isDev } from "../env";
import { classifyChannel, type ClickIdType, CLICK_ID_PARAMS } from "../lib/channel";
import { EMPTY_GEO, type Geo, PROXY_KEY_HEADER, geoFromFields, geoFromRequest, requestIp } from "../lib/geo";
import { botReason, parseUserAgent } from "../lib/ua";
import { hashRoute, parsePage, parseReferrer, primaryLanguage, queryOf, screenClass, takeDebugFlag } from "../lib/url";
import { proxyKey, userVisitorId, VISITOR_ID_RE, visitorHash } from "../lib/visitor";
import type { Attribution, EnrichedEvent, IngestResponse } from "../lib/types";
import { allow, enforce, limitVars, STORAGE_FULL_HINT } from "../lib/limits";
import { type Ctx, SITE_ID_RE, type SiteStub, loadSite, pushSettings, siteStub } from "./context";

const DEV_SALT = "insecure-dev-salt";
export const MAX_BODY_BYTES = 16 * 1024;
export const TOO_LARGE = { ok: false, error: "payload_too_large", hint: `POST /e bodies are limited to ${MAX_BODY_BYTES / 1024} KB.` };

export function saltSecret(env: Bindings): string {
  if (env.SALT_SECRET) return env.SALT_SECRET;
  if (isDev(env)) return DEV_SALT;
  throw new ApiError(
    503,
    "not_configured",
    "SALT_SECRET is not set on this deployment.",
    "Operator: `wrangler secret put SALT_SECRET` (openssl rand -hex 32).",
  );
}

/** The site's first-party proxy key, or null when SALT_SECRET is missing (deployment misconfigured). */
export async function proxyKeyFor(env: Bindings, siteId: string): Promise<string | null> {
  try {
    return await proxyKey(saltSecret(env), siteId);
  } catch {
    return null;
  }
}

type Props = Record<string, string>;

export const MAX_PROPS = 30;
export const MAX_PROP_KEY = 64;
export const MAX_PROP_VALUE = 500;
/** All props of one event together, as stored (JSON). Keys past it are dropped. */
export const MAX_PROPS_BYTES = 2048;
/** POST /v1/sites/:id/events bodies (100 events). */
export const MAX_SERVER_BODY_BYTES = 1024 * 1024;

/**
 * A prop value that is a URL keeps no query string or fragment, like page URLs (UTM tags, click
 * ids, preview tokens and emails ride there): a value starting with an http(s) URL or a path
 * ("/pricing", "//cdn.example/a") is cut at its first ? or #, when that comes before any
 * whitespace. Other text is kept as sent.
 */
export function stripUrlQuery(v: string): string {
  const t = v.trim();
  if (!/^(?:https?:\/\/|\/)[^\s?#]*[?#]/i.test(t)) return v;
  return t.slice(0, t.search(/[?#]/));
}

/**
 * Props are stored as strings: at most 30 keys of 64 characters, values of 500, and 2 KB of JSON
 * in all (keys past that are dropped, in order). URL values lose their query string (stripUrlQuery).
 */
export function cleanProps(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Props = {};
  let n = 0;
  let size = 2;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_PROPS) break;
    if (v == null || typeof v === "object") continue;
    const key = String(k).trim().slice(0, MAX_PROP_KEY);
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    const value = (typeof v === "string" ? stripUrlQuery(v) : String(v)).slice(0, MAX_PROP_VALUE);
    const add = JSON.stringify(key).length + JSON.stringify(value).length + 2;
    if (size + add > MAX_PROPS_BYTES) break;
    out[key] = value;
    size += add;
    n++;
  }
  return n ? JSON.stringify(out) : null;
}

/** User properties: up to 30 keys like props; a null value unsets the key. */
export function cleanUserProps(input: unknown): Record<string, string | null> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, string | null> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= MAX_PROPS) break;
    const key = String(k).trim().slice(0, MAX_PROP_KEY);
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (v === null) out[key] = null;
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = String(v).slice(0, MAX_PROP_VALUE);
    else continue;
    n++;
  }
  return n ? out : null;
}

/** The claim hint (only where this deployment names the platform site, AUTH_ISSUER). */
const claimHint = (env: Bindings) =>
  env.AUTH_ISSUER ? ` Accounts a person has claimed (POST ${env.AUTH_ISSUER.replace(/\/$/, "")}/v1/claim-link) get higher limits.` : "";

/** The error for a batch the site's DO refused as a whole. */
export function refusalError(env: Bindings, reason: NonNullable<IngestResponse["refused"]>): ApiError {
  switch (reason) {
    case "account_suspended":
      return accountSuspended();
    case "storage_full":
      return new ApiError(507, "storage_full", "This site's storage budget is used up, so new events are not stored.", STORAGE_FULL_HINT);
    case "daily_limit":
      return new ApiError(
        429,
        "daily_limit",
        "This site reached its daily event limit; new events are refused until 00:00 UTC.",
        `GET /v1/sites/:id shows usage_today and limits. If the traffic isn't yours, set allowed_hostnames or exclusions.${claimHint(env)}`,
      );
    case "account_daily_limit":
      return new ApiError(
        429,
        "daily_limit",
        "This account reached its daily event limit across its sites; new events are refused until 00:00 UTC.",
        `GET /v1/sites/:id shows usage_today and limits.${claimHint(env)}`,
      );
    case "platform_daily_budget":
      return new ApiError(
        429,
        "over_capacity",
        "This service reached its daily event budget; new events are refused until 00:00 UTC.",
        `Retry after 00:00 UTC, or self-host (the code is open source, see /llms.txt).${claimHint(env)}`,
      );
  }
}

const REFUSAL_STATUS = {
  account_suspended: 403,
  storage_full: 507,
  daily_limit: 429,
  account_daily_limit: 429,
  platform_daily_budget: 429,
} as const;

function attribution(pageHost: string | null, page: ReturnType<typeof parsePage>, referrerRaw: string | null | undefined): Attribution {
  const ref = parseReferrer(referrerRaw);
  const ch = classifyChannel({
    referrerHost: ref.referrer_host,
    pageHost,
    utmSource: page.utm_source,
    utmMedium: page.utm_medium,
    utmCampaign: page.utm_campaign,
    clickIdType: page.click_id_type,
  });
  const internal = ref.referrer_host && pageHost && ref.referrer_host.replace(/^www\./, "") === pageHost.replace(/^www\./, "");
  return {
    referrer: internal ? null : ref.referrer,
    referrer_host: internal ? null : ref.referrer_host,
    source: ch.source,
    channel: ch.channel,
    utm_source: page.utm_source,
    utm_medium: page.utm_medium,
    utm_campaign: page.utm_campaign,
    utm_term: page.utm_term,
    utm_content: page.utm_content,
    utm_id: page.utm_id,
    utm_source_platform: page.utm_source_platform,
    utm_creative_format: page.utm_creative_format,
    utm_marketing_tactic: page.utm_marketing_tactic,
    click_id_type: page.click_id_type,
    click_id: page.click_id,
  };
}

const clip = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

function revenueOf(v: unknown): { revenue: number | null; currency: string | null } {
  let amount: unknown;
  let currency: unknown;
  if (Array.isArray(v)) [amount, currency] = v;
  else if (v && typeof v === "object") ({ amount, currency } = v as { amount?: unknown; currency?: unknown });
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (typeof n !== "number" || !Number.isFinite(n)) return { revenue: null, currency: null };
  const c = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  return { revenue: Math.round(n * 100) / 100, currency: c };
}

// ------------------------------------------------------------------ browser: POST /e

/**
 * Tracker payload (text/plain JSON, so no CORS preflight):
 *   s site id · n event name (default "pageview"; "engagement" = visible-time beacon) · u page URL
 *   r referrer · p props · $ [amount, currency] · i user id · id persistent visitor id
 *   e engagement ms · b 1 when navigator.webdriver · d 1 when GPC/DNT · dbg 1 = test traffic (afsa('debug'))
 *   pageviews: t document.title (data-title="true") · w viewport width (stored as a class) · h 1 = hash routing
 *   custom events: ni 1 = non-interactive (doesn't un-bounce the session)
 *   engagement only: sd max scroll depth % · v [LCP ms, INP ms, CLS x 1000] of the page load
 */

const finiteIn = (x: unknown, max: number): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? x : null);

/** Scroll depth and Web Vitals from an engagement beacon, clamped; anything odd is dropped. */
export function engagementMetrics(p: Record<string, unknown>) {
  const sd = finiteIn(p.sd, 100);
  const v = Array.isArray(p.v) ? (p.v as unknown[]) : [];
  const lcp = finiteIn(v[0], 120_000);
  const inp = finiteIn(v[1], 60_000);
  const cls = finiteIn(v[2], 100_000);
  return {
    scroll_depth: sd == null ? null : Math.round(sd),
    lcp: lcp == null || lcp === 0 ? null : Math.round(lcp),
    inp: inp == null || inp === 0 ? null : Math.round(inp),
    cls: cls == null ? null : Math.round(cls) / 1000,
  };
}
export interface BrowserResult {
  status: 202 | 400 | 403 | 404 | 413 | 429 | 503 | 507;
  body: Record<string, unknown>;
}

const RATE_LIMITED: BrowserResult = {
  status: 429,
  body: { ok: false, error: "rate_limited", hint: "Too many events from this network or for this site; slow down and retry in a minute." },
};

export const REPLAY_SITE_RE = /^rsite_[0-9a-z]{16}$/;

/**
 * `r` for the tracker: the linked replay site's loader, which it injects once per page load. Only
 * with REPLAY_BASE_URL set. The loader makes its own sampling, bot, DNT and consent decisions, so
 * this rides on drops too.
 */
export function replayField(env: Bindings, replaySiteId: string | null | undefined): { r?: string } {
  const base = env.REPLAY_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base || !replaySiteId || !REPLAY_SITE_RE.test(replaySiteId)) return {};
  return { r: `${base}/r/${replaySiteId}.js` };
}

export async function ingestBrowser(
  env: Bindings,
  req: Request,
  text: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<BrowserResult> {
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { status: 413, body: TOO_LARGE };
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(text);
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error();
  } catch {
    return {
      status: 400,
      body: { ok: false, error: "invalid_json", hint: 'Body must be a JSON object like {"s":"site_...","u":"https://..."}.' },
    };
  }
  const siteId = typeof p.s === "string" ? p.s : "";
  if (!SITE_ID_RE.test(siteId))
    return { status: 400, body: { ok: false, error: "bad_site_id", hint: 'Set data-site="site_..." on the script tag.' } };
  const name = clip(p.n, 120) ?? "pageview";
  const stub = siteStub(env, siteId);
  let salt: string;
  try {
    salt = saltSecret(env);
  } catch {
    return { status: 503, body: { ok: false, error: "not_configured", hint: "SALT_SECRET is not set on this deployment." } };
  }
  // Forwarded IP / geo headers are trusted only with the site's proxy key (anyone can set them).
  // A request under a path prefix (/_a/e) came through a first-party proxy: without a valid key its
  // IP and geo are the proxy's, which the DO counts as a warning that verify reports.
  const presented = req.headers.get(PROXY_KEY_HEADER);
  const trusted = !!presented && timingSafeEqual(presented, await proxyKey(salt, siteId));
  const ip = requestIp(req, trusted);
  // Edge rate limits before any storage: per client network (behind a keyed proxy, the visitor's),
  // then per site.
  if (!(await allow(env.INGEST_IP_LIMITER, `ip:${networkKey(ip)}`)) || !(await allow(env.INGEST_SITE_LIMITER, `site:${siteId}`)))
    return RATE_LIMITED;
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf;
  const ua = req.headers.get("user-agent");
  const bm = cf?.botManagement as { verifiedBot?: boolean } | undefined;
  const bot = botReason({
    ua,
    verifiedBot: bm?.verifiedBot,
    verifiedBotCategory: (cf?.verifiedBotCategory as string) || null,
    webdriver: p.b === 1 || p.b === true,
  });
  if (bot) {
    const drop = stub.recordDrop(`bot:${bot}`, ua?.slice(0, 200) ?? null).catch(() => null);
    waitUntil(drop);
    // Waited for only when replay loading is on: the answer names the site's replay link.
    const link = env.REPLAY_BASE_URL ? await drop : null;
    return { status: 202, body: { ok: false, dropped: "bot", reason: bot, ...replayField(env, link?.replay_site_id) } };
  }
  const now = Date.now();
  // ?afsa_debug=1 in the page URL: test traffic (the tracker keeps it for the tab), never stored.
  const flagged = takeDebugFlag(clip(p.u, 2000));
  const page = parsePage(flagged.url);
  // Browser events always come from a real page; anything else (javascript:, file:, junk) is noise.
  if (typeof p.u !== "string" || !/^https?:\/\//i.test(p.u) || !page.hostname) {
    return { status: 400, body: { ok: false, error: "bad_url", hint: "u must be the page's absolute http(s) URL (location.href)." } };
  }
  const viaProxy = new URL(req.url).pathname !== "/e";
  const geo = geoFromRequest(req, { devMode: isDev(env), trustForwarded: trusted });
  // Hash-routed SPAs (data-hash="true"): the route after # is part of the page path.
  const route = p.h === 1 ? hashRoute(flagged.url) : null;
  const pathname = route ? `${page.pathname}${route}`.slice(0, 1000) : page.pathname;
  const ev: EnrichedEvent = {
    ts: now,
    name,
    origin: "browser",
    hostname: page.hostname,
    pathname,
    url: route && page.url ? `${page.url}${route}`.slice(0, 1500) : page.url,
    user_id: clip(p.i, 200),
    props: cleanProps(p.p),
    items: ECOMMERCE_SET.has(name) ? cleanItems((p.p as { items?: unknown } | undefined)?.items) : null,
    user_props: cleanUserProps(p.up),
    ...revenueOf(p.$),
    engagement_ms: typeof p.e === "number" && p.e > 0 ? Math.round(p.e) : 0,
    visitor_hash: await visitorHash(salt, siteId, ip, ua ?? "", now),
    client_visitor_id: typeof p.id === "string" && VISITOR_ID_RE.test(p.id) ? p.id : null,
    explicit_visitor_id: null,
    dnt: p.d === 1 || p.d === true || req.headers.get("sec-gpc") === "1" || req.headers.get("dnt") === "1",
    debug: p.dbg === 1 || p.dbg === true || flagged.debug,
    language: primaryLanguage(req.headers.get("accept-language")),
    screen: name === "pageview" ? screenClass(p.w) : null,
    title: name === "pageview" ? clip(p.t, 200) : null,
    interactive: !(p.ni === 1 || p.ni === true),
    // Read by the DO for the site's search_params only, then dropped.
    search_query: name === "pageview" ? queryOf(flagged.url) || null : null,
    proxy_warning: viaProxy && !trusted ? (presented ? "proxy_key_invalid" : "proxy_key_missing") : null,
    // Only for exclusions.ips, compared in the DO's memory; never stored.
    ip,
    ...(name === "engagement" ? engagementMetrics(p) : {}),
    ...attribution(page.hostname, page, clip(p.r, 2000)),
    ...geo,
    ...parseUserAgent(ua),
  };
  const res = await stub.ingest([ev], { vars: limitVars(env) });
  if (!res.known_site) {
    return {
      status: 404,
      body: { ok: false, error: "unknown_site", hint: `No site ${siteId}. Create one with POST /v1/sites and use its id in data-site.` },
    };
  }
  // A suspended account's site gets no replay link (its loader is refused anyway).
  const replay = res.refused === "account_suspended" ? {} : replayField(env, res.replay_site_id);
  if (res.refused) {
    const e = refusalError(env, res.refused);
    return { status: REFUSAL_STATUS[res.refused], body: { ok: false, error: e.code, hint: e.hint, ...replay } };
  }
  const r = res.results[0];
  if (!r?.ok) return { status: 202, body: { ok: false, dropped: r?.reason ?? "rejected", ...replay } };
  return { status: 202, body: { ok: true, v: r.visitor_id, ...(res.persistent ? { p: 1 } : {}), ...replay } };
}

// ------------------------------------------------------------------ server: POST /v1/sites/:id/events

const propValue = z.union([z.string().max(MAX_PROP_VALUE * 4), z.number(), z.boolean(), z.null()]);

export const serverEventSchema = z.object({
  name: z.string().min(1).max(120).describe('"pageview" or a custom event name, e.g. "purchase".'),
  timestamp: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("unix ms or ISO 8601; default now. Up to 31 days in the past, 5 minutes in the future."),
  url: z.string().max(2000).optional().describe("Page URL; supplies hostname, path, UTM tags and click ids."),
  referrer: z.string().max(2000).optional(),
  visitor_id: z.string().regex(VISITOR_ID_RE).optional().describe("From afsa.visitorId() in the browser; joins that exact visitor."),
  user_id: z.string().max(200).optional(),
  ip: z.string().max(64).optional().describe("Visitor IP. With user_agent, computes the same cookieless visitor id as the browser."),
  user_agent: z.string().max(1000).optional(),
  country: z.string().max(8).optional().describe("ISO 3166-1 alpha-2. Explicit geo always wins; nothing is looked up from ip."),
  region: z.string().max(100).optional(),
  region_code: z.string().max(10).optional(),
  city: z.string().max(100).optional(),
  continent: z.string().max(4).optional(),
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
  utm_term: z.string().max(200).optional(),
  utm_content: z.string().max(200).optional(),
  utm_id: z.string().max(200).optional(),
  utm_source_platform: z.string().max(200).optional(),
  utm_creative_format: z.string().max(200).optional(),
  utm_marketing_tactic: z.string().max(200).optional(),
  click_id_type: z.enum(CLICK_ID_PARAMS).optional().describe("e.g. gclid, with click_id."),
  click_id: z.string().max(500).optional(),
  props: z
    .record(z.string().max(MAX_PROP_KEY * 4), propValue)
    .refine((o) => Object.keys(o).length <= 100, "at most 100 keys (30 are kept)")
    .optional()
    .describe("String / number / boolean values. Kept: 30 keys of 64 characters, values of 500, 2 KB in all."),
  revenue: z.object({ amount: z.number(), currency: z.string().regex(/^[A-Za-z]{3}$/) }).optional(),
  user_props: z
    .record(z.string().max(MAX_PROP_KEY * 4), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
    .refine((o) => Object.keys(o).length <= 100, "at most 100 keys (30 are kept)")
    .optional()
    .describe(
      "User properties for user_id (needs user_id): last value per user, e.g. {plan: 'pro', company_size: 50}; null unsets a key. Filter and break down with user:<key>.",
    ),
  items: z
    .array(z.record(z.string(), z.unknown()))
    .max(MAX_ITEMS_READ)
    .optional()
    .describe(
      "Ecommerce events (view_item_list, select_item, view_item, add_to_cart, remove_from_cart, begin_checkout, purchase, refund): GA4-style items [{item_id, item_name, item_category, item_brand, item_variant, item_list_name, price, quantity}]. The site keeps MAX_ITEMS_PER_EVENT (default 25) per event.",
    ),
  debug: z
    .boolean()
    .optional()
    .describe(
      "Test traffic: stored (and counted against budgets) but left out of reports unless debug=include|only; purged after 7 days. A url carrying afsa_debug=1 does the same.",
    ),
  visit: z
    .boolean()
    .optional()
    .describe(
      "false: a backend event that is not a visit (an agent signing up with curl, a webhook). It joins the visitor's live session if there is one; otherwise it is stored with no visitor or session: it counts as an event, a conversion and revenue, never in visitors, visits, bounce rate or entry pages. Default true.",
    ),
  interactive: z
    .boolean()
    .optional()
    .describe("false: a non-interactive event (a background job, an impression): it doesn't un-bounce the session."),
  language: z
    .string()
    .max(35)
    .optional()
    .describe("The visitor's language (an Accept-Language value or a tag like en-US); the primary subtag is kept."),
  title: z.string().max(500).optional().describe("pageview: the page title (200 characters kept)."),
});
export type ServerEvent = z.infer<typeof serverEventSchema>;

const boolish = z.union([z.boolean(), z.enum(["true", "false", "1", "0"])]).optional();
const truthy = (v: z.infer<typeof boolish>) => v === true || v === "true" || v === "1";

export const serverIngestInput = z.union([
  z.object({
    events: z.array(serverEventSchema).min(1).max(100),
    validate_only: boolish.describe(
      "Check the batch without storing or counting anything: per event, what would be stored or why it would be dropped.",
    ),
  }),
  serverEventSchema.transform((e) => ({ events: [e], validate_only: undefined as z.infer<typeof boolish> })),
]);

function eventTs(t: ServerEvent["timestamp"], now: number): number | string {
  if (t == null) return now;
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return "timestamp is not unix ms or ISO 8601";
  if (ms > now + 5 * 60_000) return "timestamp is in the future";
  if (ms < now - 31 * 86_400_000) return "timestamp is more than 31 days old";
  return ms;
}

export async function enrichServerEvent(siteId: string, e: ServerEvent, salt: string, now: number): Promise<EnrichedEvent | string> {
  const ts = eventTs(e.timestamp, now);
  if (typeof ts === "string") return ts;
  if (e.user_agent) {
    const bot = botReason({ ua: e.user_agent });
    if (bot && bot !== "non_browser_user_agent" && bot !== "short_user_agent") return `bot (${bot})`;
  }
  const flagged = takeDebugFlag(e.url ?? null);
  const page = parsePage(flagged.url);
  // Explicit UTM / click id fields override what the URL carries.
  for (const k of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "utm_source_platform",
    "utm_creative_format",
    "utm_marketing_tactic",
  ] as const)
    if (e[k]) page[k] = e[k]!;
  if (e.click_id_type && e.click_id) {
    page.click_id_type = e.click_id_type as ClickIdType;
    page.click_id = e.click_id;
  }
  let visitor: string;
  if (e.visitor_id) visitor = e.visitor_id;
  else if (e.ip && e.user_agent) visitor = await visitorHash(salt, siteId, e.ip, e.user_agent, ts);
  else if (e.user_id) visitor = await userVisitorId(siteId, e.user_id);
  else visitor = `r${randomString(15)}`;
  const geo: Geo = e.country || e.city || e.region ? geoFromFields(e) : { ...EMPTY_GEO };
  return {
    ts,
    name: e.name,
    origin: "server",
    hostname: page.hostname,
    pathname: e.url ? page.pathname : null,
    url: page.url,
    user_id: e.user_id ?? null,
    props: cleanProps(e.props),
    items: ECOMMERCE_SET.has(e.name) ? cleanItems(e.items) : null,
    user_props: e.user_id ? cleanUserProps(e.user_props) : null,
    ...revenueOf(e.revenue),
    engagement_ms: 0,
    visitor_hash: visitor,
    client_visitor_id: null,
    explicit_visitor_id: e.visitor_id ?? null,
    dnt: false,
    // Only for exclusions.ips, compared in the DO's memory; never stored.
    ip: e.ip ?? null,
    debug: !!e.debug || flagged.debug,
    interactive: e.interactive !== false,
    ...(e.visit === false ? { visit: false } : {}),
    language: e.language ? primaryLanguage(e.language) : null,
    title: e.name === "pageview" ? clip(e.title, 200) : null,
    search_query: e.name === "pageview" && flagged.url ? queryOf(flagged.url) || null : null,
    ...attribution(page.hostname, page, e.referrer),
    ...geo,
    ...parseUserAgent(e.user_agent),
  };
}

/** Prop keys a server event sent that won't be kept (non-string-like values, bad keys, past the caps). */
function droppedProps(e: ServerEvent, kept: string | null): string[] {
  if (!e.props) return [];
  const keep = new Set(kept ? Object.keys(JSON.parse(kept) as object) : []);
  return Object.keys(e.props).filter((k) => !keep.has(k.trim().slice(0, MAX_PROP_KEY)));
}

export async function ingestServer(ctx: Ctx, siteId: string, raw: unknown, opts: { validateOnly?: boolean } = {}) {
  const input = parse(serverIngestInput, raw);
  const { events } = input;
  const validateOnly = !!opts.validateOnly || truthy(input.validate_only);
  await enforce(
    [[ctx.env.API_INGEST_LIMITER, `acct:${ctx.accountId}`]],
    "ingest requests",
    "Batch events (up to 100 per request) and retry in a minute.",
  );
  const site = await loadSite(ctx, siteId);
  const salt = saltSecret(ctx.env);
  const now = Date.now();
  const enriched = await Promise.all(events.map((e) => enrichServerEvent(site.id, e, salt, now)));
  const valid = enriched.filter((e): e is EnrichedEvent => typeof e !== "string");
  const stub: SiteStub = siteStub(ctx.env, site.id);
  const policy = { vars: limitVars(ctx.env), dryRun: validateOnly };
  let res: IngestResponse = valid.length ? await stub.ingest(valid, policy) : { known_site: true, persistent: false, results: [] };
  if (!res.known_site) {
    await pushSettings(ctx.env, site);
    res = await stub.ingest(valid, policy);
  }
  // Every event refused for one reason (and none rejected for its own): answer with that error.
  if (res.refused && valid.length === enriched.length && !validateOnly) throw refusalError(ctx.env, res.refused);
  let vi = 0;
  const results = enriched.map((e, index) => {
    if (typeof e === "string") return { index, ok: false, reason: e };
    const r = res.results[vi++];
    const base = {
      index,
      ok: !!r?.ok,
      ...(r?.ok
        ? r.no_visit
          ? { visitor_id: null, session_id: null, visit: false }
          : { visitor_id: r.visitor_id, session_id: r.session_id }
        : { reason: r?.reason ?? "rejected" }),
    };
    if (!validateOnly) return base;
    return {
      ...base,
      ...(r?.ok ? { new_session: !!r.new_session, stored: r.stored ?? null } : {}),
      dropped_props: droppedProps(events[index]!, e.props),
      warnings: r?.warnings ?? [],
    };
  });
  const accepted = results.filter((r) => r.ok).length;
  if (validateOnly)
    return {
      validate_only: true,
      would_accept: accepted,
      would_reject: results.length - accepted,
      results,
      note: "Nothing was stored or counted. stored is the exact row each accepted event would write (after redaction, path rules, attribution and session joining); session ids of new sessions are not kept.",
      next_steps: accepted ? [`Send the same body without validate_only to store it.`] : [],
    };
  return {
    accepted,
    rejected: results.length - accepted,
    results,
    ...(accepted ? { next_steps: [`GET /v1/sites/${site.id}/realtime shows them in recent_events.`] } : {}),
  };
}
