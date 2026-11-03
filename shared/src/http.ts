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

/** Best-effort client IP (Cloudflare sets cf-connecting-ip). */
export function clientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null;
}

/**
 * The unit abuse limits should count: an IPv4 address as is, an IPv6 address by its /64 prefix
 * (one subscriber usually controls a whole /64, so per-address limits are trivially bypassed).
 */
export function clientNetwork(req: Request): string {
  return networkKey(clientIp(req));
}

export function networkKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // Expand "::" so the first four groups are known, then keep them.
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
