/**
 * POST /api/agent-mcp: the embedded Chipp agent's tool endpoint.
 *
 * Server to server. The Chipp runtime calls it with
 * `Authorization: Bearer <agentToken>` (minted by the embedded-agent session
 * proxy for the signed-in user). Session cookies are never accepted, and the
 * global CORS middleware skips this path (see app.ts), so a browser page
 * cannot call it with someone's ambient credentials.
 *
 * Body: one JSON-RPC 2.0 message (or a batch array). Reply: a JSON body, or
 * 202 with no body when the message was only notifications. GET and DELETE
 * answer 405: there is no SSE stream and no session to end.
 *
 * Rate limit: AGENT_MCP_RATE_LIMIT calls per user per minute (Redis,
 * fail-open like every limiter in this app).
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AgentAuthVariables, requireAgentAuth } from "@/api/middleware/agent-auth.ts";
import { rateLimit } from "@/lib/redis.ts";
import {
  handleAgentMcpMessage,
  INVALID_REQUEST,
  type JsonRpcResponse,
  PARSE_ERROR,
  rpcError,
} from "@/services/agent-tools/mcp.ts";
// Registers every agent tool.
import "@/services/agent-tools/index.ts";

export const AGENT_MCP_RATE_LIMIT = 120;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 20;

export const agentMcpRoutes = new Hono<{ Variables: AgentAuthVariables }>();

agentMcpRoutes.post(
  "/",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json(rpcError(null, INVALID_REQUEST, "Request body too large"), 413),
  }),
  requireAgentAuth,
  async (c) => {
    const user = c.get("user");

    const rl = await rateLimit(`agent-mcp:${user.id}`, {
      limit: AGENT_MCP_RATE_LIMIT,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      c.header("Retry-After", "60");
      return c.json(rpcError(null, -32000, "Rate limit exceeded"), 429);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, PARSE_ERROR, "Parse error"), 400);
    }

    const ctx = { user, c };

    if (Array.isArray(body)) {
      if (body.length === 0 || body.length > MAX_BATCH) {
        return c.json(rpcError(null, INVALID_REQUEST, "Invalid batch"), 400);
      }
      const replies: JsonRpcResponse[] = [];
      // In order, one at a time: a batch is a short list and order matters
      // to a reader of the logs.
      for (const message of body) {
        const reply = await handleAgentMcpMessage(message, ctx);
        if (reply) replies.push(reply);
      }
      if (replies.length === 0) return c.body(null, 202);
      return c.json(replies);
    }

    const reply = await handleAgentMcpMessage(body, ctx);
    if (!reply) return c.body(null, 202);
    return c.json(reply);
  },
);

agentMcpRoutes.on(["GET", "DELETE"], "/", (c) => {
  c.header("Allow", "POST");
  return c.json(rpcError(null, -32000, "Method not allowed"), 405);
});
