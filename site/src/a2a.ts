import { mcpGateway } from "./mcp-gateway";
import type { Bindings } from "./env";

/**
 * A2A (Agent2Agent) JSON-RPC endpoint at /a2a, described by /.well-known/agent-card.json.
 *
 * A thin, deterministic adapter over the MCP gateway, so other agents can use AgentFirstStack
 * through A2A as well as MCP. No model sits behind it:
 *   - message/send with a data part {"tool": "<name>", "arguments": {...}} runs that tool
 *     (exactly an MCP tools/call through the gateway, with the caller's own key and scopes);
 *   - message/send with only text returns the available tools and how to call them.
 * Replies are complete Messages (no long-running Tasks), so tasks/get and tasks/cancel answer
 * TaskNotFound.
 */

interface Part {
  kind?: string;
  type?: string;
  text?: string;
  data?: Record<string, unknown>;
}
interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { message?: { parts?: Part[]; contextId?: string; messageId?: string } };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const rpcError = (id: RpcRequest["id"], code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

async function viaGateway(req: Request, env: Bindings, body: unknown): Promise<{ response: Response; json: unknown }> {
  const inner = new Request(new URL("/mcp", req.url), {
    method: "POST",
    headers: {
      authorization: req.headers.get("authorization") ?? "",
      "x-api-key": req.headers.get("x-api-key") ?? "",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const response = await mcpGateway(inner, env);
  const text = await response.clone().text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { response, json: parsed };
}

const agentMessage = (contextId: string | undefined, parts: Part[]) => ({
  kind: "message",
  role: "agent",
  messageId: crypto.randomUUID(),
  ...(contextId ? { contextId } : {}),
  parts,
});

export async function a2aEndpoint(req: Request, env: Bindings): Promise<Response> {
  if (req.method !== "POST") {
    return json(
      { error: { code: "method_not_allowed", message: "POST A2A JSON-RPC to /a2a. The agent card is /.well-known/agent-card.json." } },
      405,
      {
        allow: "POST",
      },
    );
  }
  let rpc: RpcRequest;
  try {
    rpc = (await req.json()) as RpcRequest;
  } catch {
    return json(rpcError(null, -32700, "Body is not valid JSON."), 400);
  }
  const id = rpc.id ?? null;
  switch (rpc.method) {
    case "tasks/get":
    case "tasks/cancel":
      return json(rpcError(id, -32001, "Task not found: this agent answers every message immediately and keeps no tasks."));
    case "message/send":
      break;
    default:
      return json(rpcError(id, -32601, `Method "${rpc.method}" is not supported. Use message/send.`));
  }

  const parts = rpc.params?.message?.parts ?? [];
  const contextId = rpc.params?.message?.contextId;
  const call = parts.find((p) => (p.kind ?? p.type) === "data" && typeof p.data?.tool === "string")?.data;

  if (!call) {
    // No tool call: answer with the tool list, as a usage guide.
    const { response, json: listed } = await viaGateway(req, env, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    if (response.status === 401) return new Response(response.body, response);
    const tools = ((listed as { result?: { tools?: { name: string; description?: string }[] } })?.result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
    }));
    return json({
      jsonrpc: "2.0",
      id,
      result: agentMessage(contextId, [
        {
          kind: "text",
          text:
            'Send a data part {"tool": "<name>", "arguments": {...}} to run a tool. ' +
            `${tools.length} tools are available to this key; the full manual is https://agentfirststack.com/llms.txt.`,
        },
        { kind: "data", data: { tools } },
      ]),
    });
  }

  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const { response, json: out } = await viaGateway(req, env, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: call.tool, arguments: args },
  });
  if (response.status === 401) return new Response(response.body, response);
  const rpcOut = out as {
    result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    error?: { code: number; message: string };
  };
  if (rpcOut?.error) return json(rpcError(id, -32602, rpcOut.error.message));
  const text = rpcOut?.result?.content?.find((c) => c.type === "text")?.text ?? "";
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return json({
    jsonrpc: "2.0",
    id,
    result: agentMessage(contextId, [
      { kind: "text", text: rpcOut?.result?.isError ? `The tool ${String(call.tool)} returned an error.` : `Ran ${String(call.tool)}.` },
      { kind: "data", data: { tool: call.tool, is_error: !!rpcOut?.result?.isError, result: data } },
    ]),
  });
}
