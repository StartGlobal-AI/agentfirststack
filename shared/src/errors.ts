import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Every error the apps return has the same shape, and carries a `hint` that tells an agent what
 * to do next. Agents recover from errors by reading them, so hints matter more than messages.
 *
 *   { "error": { "code": "not_found", "message": "...", "hint": "...", "details": ... } }
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message: string, hint?: string, details?: unknown) => new ApiError(400, "bad_request", message, hint, details);

export const unauthorized = (hint = "Send `Authorization: Bearer <api_key>`. No key yet? POST /v1/signup returns one instantly.") =>
  new ApiError(401, "unauthorized", "Missing or invalid API key.", hint);

export const forbidden = (message = "This key is not allowed to do that.", hint?: string) => new ApiError(403, "forbidden", message, hint);

export const notFound = (what: string, hint?: string) => new ApiError(404, "not_found", `${what} not found.`, hint);

export const conflict = (message: string, hint?: string) => new ApiError(409, "conflict", message, hint);

export const tooManyRequests = (hint = "Slow down and retry in a few seconds.") =>
  new ApiError(429, "rate_limited", "Too many requests.", hint);

export const internal = (message = "Internal error.") => new ApiError(500, "internal", message);

/** The operator suspended the account (abuse). Its keys and its public ingest stop working. */
export const accountSuspended = () =>
  new ApiError(
    403,
    "account_suspended",
    "This account has been suspended for abuse of the free service.",
    "If you think this is a mistake, email abuse@agentfirststack.com with the account id.",
  );
