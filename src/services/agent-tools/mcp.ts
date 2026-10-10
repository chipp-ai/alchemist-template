/**
 * A minimal MCP server over JSON-RPC 2.0 for the agent tools.
 *
 * Methods: initialize, notifications/initialized (and any other
 * notification), ping, tools/list, tools/call. Responses are plain JSON
 * bodies, which the Streamable HTTP transport allows for a POST. There is no
 * SSE stream and no session id: every request carries its own agent token,
 * so the server is stateless.
 *
 * This is NOT the optional public MCP feature (src/mcp/, /api/mcp, gated by
 * ALCHEMIST_FEATURE_MCP). That one serves third-party clients over OAuth.
 * This one serves only the embedded Chipp agent, acting as one signed-in
 * user, and is always on.
 */

import type { Context } from "hono";
import type { AuthUser } from "@/api/middleware/auth.ts";
import { log } from "@/lib/logger.ts";
import { AppError } from "@/utils/errors.ts";
import {
  agentToolsFor,
  findAgentToolFor,
  portalBindingsFor,
  toolDefinition,
  validateAgentToolArgs,
} from "@/services/agent-tools/registry.ts";

export const AGENT_MCP_SERVER_INFO = { name: "chipp-app-agent-tools", version: "1.0.0" };
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

interface CallContext {
  user: AuthUser;
  c: Context;
}

/**
 * Handle one JSON-RPC message. Returns null for a notification (no reply).
 */
export async function handleAgentMcpMessage(
  message: unknown,
  ctx: CallContext,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return rpcError(null, INVALID_REQUEST, "Invalid request");
  }
  const msg = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const isNotification = !("id" in msg);
  const id: JsonRpcId = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;

  // A JSON-RPC response from the client (result or error, no method) and a
  // notification (no id) both get no reply.
  const isClientResponse = msg.method === undefined && ("result" in msg || "error" in msg);
  if (msg.jsonrpc === "2.0" && isClientResponse) return null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : rpcError(id, INVALID_REQUEST, "Invalid request");
  }
  if (isNotification) return null;

  const params =
    (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Record<
      string,
      unknown
    >;

  switch (msg.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: AGENT_MCP_SERVER_INFO,
        instructions: "Tools act as the signed-in user, inside their organization only. " +
          "Tools marked with _meta.chipp/requiresConfirmation change data and need the person's confirmation.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list": {
      const bindings = await portalBindingsFor(ctx.user);
      return rpcResult(id, { tools: agentToolsFor(ctx.user, bindings).map(toolDefinition) });
    }
    case "tools/call":
      return await callTool(id, params, ctx);
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

async function callTool(
  id: JsonRpcId,
  params: Record<string, unknown>,
  ctx: CallContext,
): Promise<JsonRpcResponse> {
  const name = params.name;
  if (typeof name !== "string") return rpcError(id, INVALID_PARAMS, "params.name is required");

  const bindings = await portalBindingsFor(ctx.user);
  // A tool the user may not call looks exactly like a tool that does not exist.
  const tool = findAgentToolFor(name, ctx.user, bindings);
  if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);

  try {
    const args = validateAgentToolArgs(tool.inputSchema, params.arguments);
    const result = await tool.handler({ user: ctx.user, c: ctx.c, portalBindings: bindings }, args);
    const structured = result === undefined ? null : JSON.parse(JSON.stringify(result));
    const response: Record<string, unknown> = {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      isError: false,
    };
    if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
      response.structuredContent = structured;
    }
    return rpcResult(id, response);
  } catch (err) {
    if (err instanceof AppError) {
      // A user-facing failure (not found, forbidden, bad input): the model
      // reads it and can recover, so it is a tool result, not a protocol error.
      return rpcResult(id, {
        content: [{ type: "text", text: err.message }],
        isError: true,
        structuredContent: { error: err.message, code: err.code },
      });
    }
    log.error("Agent tool failed", {
      source: "agent-tools",
      feature: "tools-call",
      toolName: tool.name,
      userId: ctx.user.id,
    }, err as Error);
    return rpcResult(id, {
      content: [{ type: "text", text: `The ${tool.name} tool failed. Try again later.` }],
      isError: true,
    });
  }
}
