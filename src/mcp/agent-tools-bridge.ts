/**
 * The agent-tools bridge: the app's real capabilities on the public MCP
 * server at /api/mcp.
 *
 * The agent tools (src/services/agent-tools/) are what the app can do for a
 * signed-in person: list records, add a task, update a profile. The embedded
 * Chipp agent reaches them through /api/agent-mcp. This bridge serves the SAME
 * tools to ChatGPT, Claude, and other assistants that connect to /api/mcp
 * with OAuth (the builder turns this on with the platform's "Connect to AI
 * assistants" setting, which sets ALCHEMIST_FEATURE_MCP=1 and
 * MCP_AUTH_MODE=oauth).
 *
 * The rules (each one is the agent-tools rule, applied on this transport):
 *
 * - FAIL CLOSED on identity. Agent tools exist only for a caller with an
 *   OAuth token or an mcp_sk_ key, in BOTH auth modes. An anonymous caller
 *   in "public" mode sees only the MCP registry tools (src/mcp/tools/).
 * - The person is re-read through the SAME `resolveUser` the session and
 *   agent-token paths use: current role, current org. A token whose org is
 *   no longer the person's org gets no agent tools.
 * - Visibility and dispatch go through `agentToolsFor` and `runAgentTool`,
 *   the same role filter, portal filter, argument validation, and org
 *   scoping as /api/agent-mcp. Never a parallel path.
 * - Token scopes: a read tool needs `tools:read`, a write tool `tools:write`.
 * - Write tools carry `destructiveHint: true`, so the assistant asks the
 *   person before it calls one. Read tools carry `readOnlyHint: true`.
 * - Calls are rate limited per person (MCP_AGENT_TOOLS_RATE_LIMIT a minute),
 *   and each write call leaves an info log (tool name and user id, never
 *   the arguments).
 */

import { z } from "zod";
import type { Context } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AuthUser, resolveUser } from "@/api/middleware/auth.ts";
import type { McpAuthContext } from "@/api/middleware/mcp-auth.ts";
import { rateLimit } from "@/lib/redis.ts";
import { log } from "@/lib/logger.ts";
import type { PortalAccess } from "@/services/portal-access.service.ts";
import {
  type AgentTool,
  agentToolsFor,
  type JsonSchema,
  portalBindingsFor,
  REQUIRES_CONFIRMATION_META,
} from "@/services/agent-tools/registry.ts";
import { runAgentTool } from "@/services/agent-tools/mcp.ts";
// Registers every agent tool.
import "@/services/agent-tools/index.ts";

export const MCP_AGENT_TOOLS_RATE_LIMIT = 120;

/** The person behind an /api/mcp request, ready to call agent tools. */
export interface AgentToolCaller {
  user: AuthUser;
  portalBindings: PortalAccess[];
  scopes: string[];
}

/** Test seam: the user re-read. Production never overrides. */
export const _bridgeDeps = {
  resolveUser: (userId: string) => resolveUser({ sub: userId }),
  portalBindingsFor,
};

/**
 * Resolve the caller for agent tools, or null. Null for an anonymous call,
 * an unknown method, a deleted or org-less user, and a token whose org is no
 * longer the user's org.
 */
export async function resolveAgentToolCaller(
  auth: McpAuthContext | null,
): Promise<AgentToolCaller | null> {
  if (!auth || (auth.method !== "oauth" && auth.method !== "api_key")) return null;
  const user = await _bridgeDeps.resolveUser(auth.userId);
  if (!user || !auth.organizationId || user.organizationId !== auth.organizationId) return null;
  const portalBindings = await _bridgeDeps.portalBindingsFor(user);
  return { user, portalBindings, scopes: auth.scopes };
}

/** True when the token's scopes allow this tool. */
export function scopeAllows(tool: AgentTool, scopes: readonly string[]): boolean {
  return scopes.includes(tool.write ? "tools:write" : "tools:read");
}

/** The agent tools this caller may see and call on /api/mcp. */
export function bridgedAgentTools(caller: AgentToolCaller): AgentTool[] {
  return agentToolsFor(caller.user, caller.portalBindings).filter((t) =>
    scopeAllows(t, caller.scopes)
  );
}

/**
 * Convert the agent-tool JSON Schema subset to zod, so the SDK advertises
 * the real argument shape in tools/list. `runAgentTool` still runs
 * `validateAgentToolArgs`, which stays the authoritative check.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  let out: z.ZodTypeAny;
  if (schema.enum && schema.enum.length > 0) {
    const values = schema.enum;
    if (values.length === 1) {
      out = z.literal(values[0]);
    } else if (values.every((v) => typeof v === "string")) {
      out = z.enum(values as [string, ...string[]]);
    } else {
      const [a, b, ...rest] = values.map((v) => z.literal(v));
      out = z.union([a, b, ...rest]);
    }
  } else {
    switch (schema.type) {
      case "object": {
        const obj = z.object(objectShape(schema));
        out = schema.additionalProperties === true ? obj.passthrough() : obj.strict();
        break;
      }
      case "string": {
        let s = z.string();
        if (schema.minLength !== undefined) s = s.min(schema.minLength);
        if (schema.maxLength !== undefined) s = s.max(schema.maxLength);
        if (schema.format === "uuid") s = s.uuid();
        out = s;
        break;
      }
      case "integer":
      case "number": {
        let n = z.number();
        if (schema.type === "integer") n = n.int();
        if (schema.minimum !== undefined) n = n.min(schema.minimum);
        if (schema.maximum !== undefined) n = n.max(schema.maximum);
        out = n;
        break;
      }
      case "boolean":
        out = z.boolean();
        break;
      case "array":
        out = z.array(schema.items ? jsonSchemaToZod(schema.items) : z.unknown());
        break;
      default:
        out = z.unknown();
    }
  }
  return schema.description ? out.describe(schema.description) : out;
}

/** The zod raw shape of an object schema (what McpServer.registerTool takes). */
export function objectShape(schema: JsonSchema): Record<string, z.ZodTypeAny> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([key, prop]) => {
      const t = jsonSchemaToZod(prop);
      return [key, required.has(key) ? t : t.optional()];
    }),
  );
}

function toolError(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/**
 * Register this caller's agent tools on a per-request McpServer. Returns the
 * names it registered. A name the MCP registry already uses is skipped: the
 * builder's own src/mcp/tools/ tool wins.
 */
export function registerBridgedAgentTools(
  server: McpServer,
  caller: AgentToolCaller,
  c: Context,
  takenNames: ReadonlySet<string>,
): string[] {
  const registered: string[] = [];
  for (const tool of bridgedAgentTools(caller)) {
    if (takenNames.has(tool.name)) {
      log.warn("Agent tool name collides with an MCP tool; the MCP tool wins", {
        source: "mcp",
        feature: "agent-tools-bridge",
        toolName: tool.name,
      });
      continue;
    }
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: objectShape(tool.inputSchema),
        annotations: { readOnlyHint: !tool.write, destructiveHint: tool.write },
        ...(tool.write ? { _meta: { [REQUIRES_CONFIRMATION_META]: true } } : {}),
      },
      async (args: Record<string, unknown>) => {
        const rl = await rateLimit(`mcp-agent-tools:${caller.user.id}`, {
          limit: MCP_AGENT_TOOLS_RATE_LIMIT,
          windowSeconds: 60,
        });
        if (!rl.allowed) {
          return toolError("Too many tool calls in the last minute. Wait a minute, then try again.");
        }
        if (tool.write) {
          log.info("Agent tool write call over MCP", {
            source: "mcp",
            feature: "agent-tools-bridge",
            toolName: tool.name,
            userId: caller.user.id,
          });
        }
        return await runAgentTool(
          tool,
          { user: caller.user, c, portalBindings: caller.portalBindings },
          args,
        );
      },
    );
    registered.push(tool.name);
  }
  return registered;
}
