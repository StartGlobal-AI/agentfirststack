import { ApiError } from "@afs/shared";

/**
 * Workers rate-limit bindings (wrangler.jsonc `ratelimits`, counted per Cloudflare location).
 * An unbound limiter (self-hosting without it, or a unit test) never limits; a limiter that
 * errors fails open, so a platform hiccup can't take ingest down.
 */
export async function overLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  try {
    return !(await limiter.limit({ key })).success;
  } catch (e) {
    console.error("rate limiter failed", e);
    return false;
  }
}

export function rateLimited(what: string, hint: string) {
  return new ApiError(429, "rate_limited", `Too many ${what}.`, hint);
}

/** Throw 429 when `limiter` is over its limit for `key`. */
export async function assertRate(limiter: RateLimit | undefined, key: string, what: string, hint: string) {
  if (await overLimit(limiter, key)) throw rateLimited(what, hint);
}
