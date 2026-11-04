/**
 * The few Stripe API calls one-call connect and backfill make, with a restricted key. Requests are
 * pinned to STRIPE_API_VERSION, and so is the webhook endpoint we create, so the event and object
 * shapes lib/stripe.ts reads never change under us. Pure apart from the injected fetch.
 *
 * Permissions the restricted key needs (Stripe Dashboard -> Developers -> API keys -> Create
 * restricted key):
 *   Webhook Endpoints: Write   create (and on disconnect delete) the endpoint for this site
 *   Checkout Sessions: Read    backfill: link customers and visitors (metadata.afs_visitor_id)
 *   Invoices: Read             backfill: paid invoices (new and renewal payments)
 *   Charges: Read              backfill: refunds (Charges and Refunds)
 *   Subscriptions: Read        backfill: subscription states for MRR
 * Nothing else: no write access to money, customers or products.
 */

export const STRIPE_API = "https://api.stripe.com";
export const STRIPE_API_VERSION = "2024-06-20";

export const STRIPE_KEY_PERMISSIONS = [
  { resource: "Webhook Endpoints", access: "Write", why: "create this site's webhook endpoint (and delete it on disconnect)" },
  { resource: "Checkout Sessions", access: "Read", why: "backfill: link customers to visitors" },
  { resource: "Invoices", access: "Read", why: "backfill: paid invoices (new and renewal payments)" },
  { resource: "Charges", access: "Read", why: "backfill: refunds" },
  { resource: "Subscriptions", access: "Read", why: "backfill: subscription states for MRR" },
] as const;

export const RESTRICTED_KEY_RE = /^rk_(live|test)_[A-Za-z0-9]{10,200}$/;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | (string | number)[] | undefined>;

export function formEncode(params: Params): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) out.append(`${k}[]`, String(x));
    else out.append(k, String(v));
  }
  return out.toString();
}

/** One Stripe API call. Throws StripeApiError with Stripe's own message (it names a missing permission). */
export async function stripeApi<T = Record<string, unknown>>(
  fetcher: Fetcher,
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params = {},
): Promise<T> {
  const qs = formEncode(params);
  const url = `${STRIPE_API}${path}${method === "GET" && qs ? `?${qs}` : ""}`;
  let res: Response;
  try {
    res = await fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "stripe-version": STRIPE_API_VERSION,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? qs : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StripeApiError(502, null, "unreachable", "Stripe's API could not be reached.");
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = (body.error ?? {}) as { type?: string; code?: string; message?: string };
    throw new StripeApiError(res.status, e.type ?? null, e.code ?? null, (e.message ?? `Stripe answered ${res.status}`).slice(0, 500));
  }
  return body as T;
}

export interface StripeList<T> {
  data: T[];
  has_more: boolean;
}
