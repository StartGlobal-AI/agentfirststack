import { type Context, Hono } from "hono";
import type { AuthBindings } from "./auth";

/**
 * RFC 9728 OAuth protected resource metadata, for every app's host and its `/mcp` endpoint.
 *
 *   app.route("/", protectedResourceRoutes({ name: "AgentFirstStack Analytics" }));
 *
 * serves `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.
 * `authorization_servers` lists AUTH_ISSUER (the site's public URL, set by `pnpm afs`), or
 * `defaultIssuer` when given. Without either (a standalone app) it is left out: keys then come
 * only from POST /v1/signup. Access tokens from that server are ordinary API keys with an expiry,
 * so nothing else in the app changes.
 */

export interface ProtectedResourceOptions {
  /** Shown to people by clients that display it. */
  name: string;
  /** Human-readable documentation for the resource. Default: `<origin>/llms.txt`. */
  documentation?: (origin: string) => string;
  /** Issuer to use when AUTH_ISSUER is unset (the site passes its own public URL). */
  defaultIssuer?: (c: Context) => string | undefined;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

/** The authorization server for this app, if any (no trailing slash). */
export function authIssuer(env: AuthBindings | undefined, fallback?: string): string | undefined {
  const issuer = env?.AUTH_ISSUER || fallback;
  return issuer ? issuer.replace(/\/+$/, "") : undefined;
}

/**
 * Where a client finds the metadata for the resource at `req`'s URL (RFC 9728 section 3.1: the
 * well-known path is inserted between the host and the resource's path).
 */
export function resourceMetadataUrl(req: Request): string {
  const u = new URL(req.url);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}

/** `WWW-Authenticate` for a 401 from an MCP endpoint (RFC 9728 section 5.1, RFC 6750). */
export function mcpChallenge(req: Request, invalidToken: boolean): string {
  return `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl(req)}"${invalidToken ? ', error="invalid_token"' : ""}`;
}

export function protectedResourceRoutes<B extends AuthBindings>(opts: ProtectedResourceOptions) {
  const app = new Hono<{ Bindings: B }>();
  const meta = (c: Context<{ Bindings: B }>, resource: string) => {
    const origin = new URL(c.req.url).origin;
    const issuer = authIssuer(c.env, opts.defaultIssuer?.(c));
    return {
      resource,
      resource_name: opts.name,
      ...(issuer ? { authorization_servers: [issuer] } : {}),
      resource_documentation: opts.documentation ? opts.documentation(origin) : `${origin}/llms.txt`,
      bearer_methods_supported: ["header"],
      scopes_supported: ["*", "read"],
    };
  };
  // The resource identifier is the URL the client used, so it matches what it validates against.
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(meta(c, new URL(c.req.url).origin), 200, CORS));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(meta(c, `${new URL(c.req.url).origin}/mcp`), 200, CORS));
  app.options("/.well-known/oauth-protected-resource", () => new Response(null, { status: 204, headers: CORS }));
  app.options("/.well-known/oauth-protected-resource/mcp", () => new Response(null, { status: 204, headers: CORS }));
  return app;
}
