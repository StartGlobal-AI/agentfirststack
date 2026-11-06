import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { ApiError, badRequest } from "./errors";

/** Hono `app.onError` handler: ApiError -> its JSON shape; anything else -> logged 500. */
export const onError: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) return c.json(err.toJSON(), err.status);
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "http_error", message: err.message || "Request failed." } }, err.status);
  }
  console.error("unhandled error", err);
  return c.json({ error: { code: "internal", message: "Internal error." } }, 500);
};

/** Hono `app.notFound` handler that points agents at the docs instead of a bare 404. */
export const onNotFound: NotFoundHandler = (c) => {
  const path = new URL(c.req.url).pathname;
  return c.json(
    new ApiError(404, "no_route", `No route for ${c.req.method} ${path}.`, "GET /llms.txt lists every endpoint.").toJSON(),
    404,
  );
};

/** Validate with zod; on failure throw a 400 whose details list each bad field. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      "Invalid input.",
      "Fix the fields listed in details and retry.",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

/** Read and validate a JSON body. An empty body is treated as `{}`. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw badRequest("Body is not valid JSON.", "Send Content-Type: application/json with a JSON object body.");
    }
  }
  return parse(schema, body);
}

/** Validate query-string params (all values arrive as strings; use z.coerce for numbers). */
export function readQuery<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  return parse(schema, c.req.query());
}

/** The URL agents should use for this app: PUBLIC_BASE_URL if set, else the request origin. */
export function publicBaseUrl(c: Context): string {
  const configured = (c.env as { PUBLIC_BASE_URL?: string } | undefined)?.PUBLIC_BASE_URL;
  return (configured || new URL(c.req.url).origin).replace(/\/$/, "");
}

/**
 * USER_CONTENT_BASE_URL: the origin (scheme and host; any path is ignored) where an app serves its
 * pages that show customer-controlled content (replay's share player under /r/, analytics' public
 * dashboards under /a/), on a domain of its own, so no cookie and no origin is shared with the
 * platform's own domain. That host serves those pages and nothing else. Null when unset, not an
 * http(s) URL, or the app's own PUBLIC_BASE_URL host (then the pages stay where they always were).
 */
export function userContentOrigin(env: { USER_CONTENT_BASE_URL?: string; PUBLIC_BASE_URL?: string } | undefined): string | null {
  return userContentHost(env)?.origin ?? null;
}

/** Did this request arrive on the user-content host (userContentOrigin)? */
export function onUserContentHost(env: { USER_CONTENT_BASE_URL?: string; PUBLIC_BASE_URL?: string } | undefined, req: Request): boolean {
  const uc = userContentHost(env);
  return !!uc && new URL(req.url).host === uc.host;
}

// Parsed once per isolate and value: onUserContentHost runs on every request (tracker hits too).
const ucCache = new Map<string, { origin: string; host: string } | null>();

function userContentHost(env: { USER_CONTENT_BASE_URL?: string; PUBLIC_BASE_URL?: string } | undefined) {
  const raw = env?.USER_CONTENT_BASE_URL?.trim();
  if (!raw) return null;
  const key = `${raw}|${env?.PUBLIC_BASE_URL ?? ""}`;
  if (ucCache.has(key)) return ucCache.get(key)!;
  let out: { origin: string; host: string } | null = null;
  try {
    const u = new URL(raw);
    let own: string | null = null;
    try {
      own = env?.PUBLIC_BASE_URL ? new URL(env.PUBLIC_BASE_URL).host : null;
    } catch {
      /* an unparseable PUBLIC_BASE_URL is the app's own problem */
    }
    if ((u.protocol === "https:" || u.protocol === "http:") && u.host !== own) out = { origin: u.origin, host: u.host };
  } catch {
    /* not a URL: off */
  }
  if (ucCache.size > 16) ucCache.clear();
  ucCache.set(key, out);
  return out;
}

/** Best-effort client IP (Cloudflare sets cf-connecting-ip). */
export function clientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null;
}

/**
 * The unit abuse limits should count: an IPv4 address as is, an IPv6 address by its /48 prefix.
 * One subscriber usually controls at least a /64, and free tunnel brokers hand out whole /48s
 * (65,536 /64s), so per-address or per-/64 limits are trivially bypassed over IPv6.
 */
export function clientNetwork(req: Request): string {
  return networkKey(clientIp(req));
}

export function networkKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  // IPv4-mapped IPv6 (::ffff:192.0.2.1) is the IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // Expand "::" so the first three groups are known, then keep them.
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 3)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/48`;
}

/** The client's network operator (autonomous system number), from Cloudflare's request.cf. */
export function clientAsn(req: Request): number | null {
  const asn = (req as { cf?: { asn?: unknown } }).cf?.asn;
  return typeof asn === "number" && Number.isInteger(asn) && asn > 0 ? asn : null;
}
