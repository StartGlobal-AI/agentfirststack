import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type AuthBindings, type AuthContext, authenticate, authenticateEnv, canWrite, extractKey } from "./auth";
import { ApiError } from "./errors";
import { mcpChallenge } from "./resource";

/**
 * Stateless remote MCP (Streamable HTTP, JSON responses) for a Worker. A fresh McpServer per
 * request: no Durable Object, no sessions, scales like any other route.
 *
 *   app.all("/mcp", (c) => handleMcp(c.req.raw, c.env.DB, {
 *     name: "analytics", version: "0.1.0", instructions: "...",
 *     register: (t, auth) => { t.read("list_sites", {...}, async () => ...) },
 *   }));
 *
 * Tools are registered through a ToolRegistrar, which hides write tools from read-only keys
 * and turns thrown ApiErrors into MCP tool errors (with the hint) instead of protocol errors.
 */

export type ToolHandler<S extends z.ZodRawShape> = (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;

export interface ToolSpec<S extends z.ZodRawShape> {
  description: string;
  input?: S;
  title?: string;
  /** Mark tools that delete or overwrite (sets the MCP destructiveHint). */
  destructive?: boolean;
  /** Tools that call out to third-party systems (sets openWorldHint). */
  openWorld?: boolean;
}

export interface ToolRegistrar {
  server: McpServer;
  auth: AuthContext;
  /** A tool that changes nothing. Available to every key. */
  read<S extends z.ZodRawShape>(name: string, spec: ToolSpec<S>, handler: ToolHandler<S>): void;
  /** A tool that changes state. Only registered for full-access keys. */
  write<S extends z.ZodRawShape>(name: string, spec: ToolSpec<S>, handler: ToolHandler<S>): void;
}

export interface McpOptions {
  name: string;
  version: string;
  /** Server-level instructions shown to the model: the "how to use this app" briefing. */
  instructions?: string;
  register: (tools: ToolRegistrar, auth: AuthContext) => void | Promise<void>;
}

/** Serialise a tool result. Strings pass through; everything else is pretty JSON. */
export function toolText(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function toolFailure(err: unknown) {
  if (err instanceof ApiError) return { ...toolText(err.toJSON()), isError: true };
  console.error("mcp tool error", err);
  const message = err instanceof Error ? err.message : String(err);
  return { ...toolText({ error: { code: "internal", message } }), isError: true };
}

function makeRegistrar(server: McpServer, auth: AuthContext): ToolRegistrar {
  const register = <S extends z.ZodRawShape>(readOnly: boolean, name: string, spec: ToolSpec<S>, handler: ToolHandler<S>) => {
    const annotations: ToolAnnotations = {
      readOnlyHint: readOnly,
      ...(readOnly ? {} : { destructiveHint: !!spec.destructive }),
      ...(spec.openWorld ? { openWorldHint: true } : {}),
      ...(spec.title ? { title: spec.title } : {}),
    };
    // The SDK's generics don't line up cleanly with zod v4 raw shapes through a wrapper; the
    // runtime contract (raw shape in, parsed args out) is what matters here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(
      name,
      { title: spec.title, description: spec.description, inputSchema: spec.input ?? {}, annotations },
      async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return toolText(await handler(args));
        } catch (err) {
          return toolFailure(err);
        }
      },
    );
  };
  return {
    server,
    auth,
    read: (name, spec, handler) => register(true, name, spec, handler),
    write: (name, spec, handler) => {
      if (canWrite(auth)) register(false, name, spec, handler);
    },
  };
}

// The challenge points at RFC 9728 metadata, so OAuth-capable clients (claude.ai, ChatGPT) can
// find the authorization server; clients with a key never see it.
const unauthorizedMcp = (request: Request, hint: string, invalidToken: boolean) =>
  new Response(JSON.stringify(new ApiError(401, "unauthorized", "Missing or invalid API key.", hint).toJSON()), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": mcpChallenge(request, invalidToken) },
  });

/**
 * `envOrDb`: pass the Worker env (recommended: honours a shared AUTH_DB) or, for a self-contained
 * app, its D1 database directly.
 */
export async function handleMcp(request: Request, envOrDb: AuthBindings | D1Database, opts: McpOptions): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const token = extractKey(request);
  if (!token) return unauthorizedMcp(request, "Add header `Authorization: Bearer <api_key>`. Get a key with POST /v1/signup.", false);
  const auth =
    "prepare" in envOrDb && typeof envOrDb.prepare === "function"
      ? await authenticate(envOrDb as D1Database, token)
      : await authenticateEnv(envOrDb as AuthBindings, token);
  if (!auth) return unauthorizedMcp(request, "That API key is unknown, revoked or expired. POST /v1/signup for a new one.", true);

  const server = new McpServer(
    { name: opts.name, version: opts.version },
    { instructions: opts.instructions, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  await opts.register(makeRegistrar(server, auth), auth);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
