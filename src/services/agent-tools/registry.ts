/**
 * Agent tool registry: the tools the embedded Chipp agent may call on
 * behalf of the signed-in user, through POST /api/agent-mcp.
 *
 * One registration per tool:
 *
 *   registerAgentTool({
 *     name: "list_orders",
 *     description: "List this workspace's orders, newest first.",
 *     inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
 *     capability: "app.read",
 *     write: false,
 *     handler: ({ user }, args) => listOrders({ organizationId: user.organizationId, limit: args.limit }),
 *   });
 *
 * The rules (each one closes a cross-tenant or confused-deputy bug):
 *
 * - Scope by `ctx.user.organizationId` (and `ctx.user.id` for personal
 *   data). NEVER take an org id or a user id from `args`. Registration
 *   refuses an inputSchema with such a property.
 * - A row id in `args` is fine, but the service query must still carry the
 *   org in its WHERE clause, so another org's id is a "not found".
 * - `capability` is checked against the user's CURRENT role on every list
 *   and every call. tools/list never shows a tool the user cannot call.
 * - `write: true` for anything that changes data. The tool is then
 *   advertised with `destructiveHint: true` and
 *   `_meta["chipp/requiresConfirmation"] = true`, so the Chipp runtime asks
 *   the person before it calls.
 * - Portal viewers (end users who signed in through a portal link) see ONLY
 *   tools marked `portalSafe: true`. A portal-safe handler scopes by
 *   `ctx.portalBindings` or by `ctx.user.id`, never by the whole org.
 * - No raw SQL tools, no "run a query" tools. Registration refuses names
 *   that look like one.
 */

import type { Context } from "hono";
import type { AuthUser } from "@/api/middleware/auth.ts";
import { can, type Capability } from "@/lib/roles.ts";
import { listPortalAccessForUser, type PortalAccess } from "@/services/portal-access.service.ts";
import { BadRequestError } from "@/utils/errors.ts";

// ── Types ──

/** The JSON Schema subset the agent-tool validator understands. */
export interface JsonSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: "uuid";
}

export interface AgentToolContext {
  /** The signed-in user, re-read from the DB on this request. */
  user: AuthUser;
  /** The Hono context of the /api/agent-mcp request. */
  c: Context;
  /**
   * The user's live portal bindings in their org. Non-empty only for a
   * portal viewer; a portal-safe tool scopes by these.
   */
  portalBindings: PortalAccess[];
}

// deno-lint-ignore no-explicit-any
export type AgentToolArgs = Record<string, any>;

export interface AgentTool {
  /** snake_case, unique. */
  name: string;
  /** What the tool does, written for the model. */
  description: string;
  /** JSON Schema for `arguments`. Must be `type: "object"`. */
  inputSchema: JsonSchema;
  /** The roles.ts capability the user needs to see and call the tool. */
  capability: Capability;
  /** True when the tool changes data. Advertised as needing confirmation. */
  write: boolean;
  /** True only when the handler is safe for a portal viewer (see above). */
  portalSafe?: boolean;
  /** Returns a JSON-serializable result. Throw an AppError for a user-facing failure. */
  handler: (ctx: AgentToolContext, args: AgentToolArgs) => Promise<unknown> | unknown;
}

/** One entry of an MCP tools/list result. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
  };
  _meta?: Record<string, unknown>;
}

/** The `_meta` key that tells the Chipp runtime to confirm before calling. */
export const REQUIRES_CONFIRMATION_META = "chipp/requiresConfirmation";

// ── Registration ──

const tools = new Map<string, AgentTool>();

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Property names that would let the model pick the tenant or the person. */
const FORBIDDEN_ARG = /^(org|organization|organisation|tenant|workspace|user|owner|account)_?id$/i;
/** Tool names that would be a raw query surface. */
const FORBIDDEN_NAME = /(^|_)(sql|query_database|raw_query|execute_query)(_|$)/;

export function registerAgentTool(tool: AgentTool): void {
  if (!TOOL_NAME.test(tool.name)) {
    throw new Error(`Agent tool "${tool.name}": name must be snake_case (a-z, 0-9, _).`);
  }
  if (FORBIDDEN_NAME.test(tool.name)) {
    throw new Error(`Agent tool "${tool.name}": raw SQL or query tools are not allowed.`);
  }
  if (tools.has(tool.name)) {
    throw new Error(`Agent tool "${tool.name}" is already registered.`);
  }
  if (tool.inputSchema.type !== "object") {
    throw new Error(`Agent tool "${tool.name}": inputSchema must be { type: "object" }.`);
  }
  for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
    if (FORBIDDEN_ARG.test(key)) {
      throw new Error(
        `Agent tool "${tool.name}": argument "${key}" is not allowed. Scope by ctx.user, ` +
          "never by an org or user id the model supplies.",
      );
    }
  }
  tools.set(tool.name, tool);
}

/** Every registered tool, unfiltered. For tests and introspection only. */
export function listRegisteredAgentTools(): AgentTool[] {
  return [...tools.values()];
}

/** Test only: remove a tool a test registered. */
export function __unregisterAgentToolForTest(name: string): void {
  tools.delete(name);
}

// ── Access ──

/**
 * The user's live portal bindings in their CURRENT org. A user with at
 * least one, who cannot write app data, is a portal viewer.
 */
export async function portalBindingsFor(user: AuthUser): Promise<PortalAccess[]> {
  if (can(user.role, "app.write")) return [];
  const access = await listPortalAccessForUser(user.id);
  return access.filter((a) => a.organizationId === user.organizationId);
}

/** True when `user` may see and call `tool`. */
export function toolAllowed(
  tool: AgentTool,
  user: AuthUser,
  portalBindings: PortalAccess[],
): boolean {
  if (!can(user.role, tool.capability)) return false;
  if (portalBindings.length > 0 && tool.portalSafe !== true) return false;
  return true;
}

/** The tools this user may call, in registration order. */
export function agentToolsFor(user: AuthUser, portalBindings: PortalAccess[]): AgentTool[] {
  return [...tools.values()].filter((t) => toolAllowed(t, user, portalBindings));
}

/** A tool this user may call, or undefined (unknown and forbidden look the same). */
export function findAgentToolFor(
  name: string,
  user: AuthUser,
  portalBindings: PortalAccess[],
): AgentTool | undefined {
  const tool = tools.get(name);
  if (!tool || !toolAllowed(tool, user, portalBindings)) return undefined;
  return tool;
}

/** The MCP tools/list entry for a tool. */
export function toolDefinition(tool: AgentTool): AgentToolDefinition {
  const def: AgentToolDefinition = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: !tool.write,
      destructiveHint: tool.write,
    },
  };
  if (tool.write) def._meta = { [REQUIRES_CONFIRMATION_META]: true };
  return def;
}

// ── Argument validation ──

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check `args` against the tool's schema. Throws BadRequestError naming the
 * first problem. Unknown properties are refused unless the schema sets
 * `additionalProperties: true`, so a model cannot slip in an org id the
 * handler might read by mistake.
 */
export function validateAgentToolArgs(schema: JsonSchema, args: unknown): AgentToolArgs {
  const value = args === undefined || args === null ? {} : args;
  checkValue(schema, value, "arguments");
  return value as AgentToolArgs;
}

function checkValue(schema: JsonSchema, value: unknown, path: string): void {
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    throw new BadRequestError(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BadRequestError(`${path} must be an object`);
      }
      const obj = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) throw new BadRequestError(`${path}.${key} is required`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const prop = props[key];
        if (!prop) {
          if (schema.additionalProperties === true) continue;
          throw new BadRequestError(`${path}.${key} is not a known argument`);
        }
        if (v !== undefined) checkValue(prop, v, `${path}.${key}`);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") throw new BadRequestError(`${path} must be a string`);
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new BadRequestError(`${path} must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new BadRequestError(`${path} must be at most ${schema.maxLength} characters`);
      }
      if (schema.format === "uuid" && !UUID.test(value)) {
        throw new BadRequestError(`${path} must be a UUID`);
      }
      return;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new BadRequestError(`${path} must be a number`);
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        throw new BadRequestError(`${path} must be an integer`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new BadRequestError(`${path} must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new BadRequestError(`${path} must be at most ${schema.maximum}`);
      }
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new BadRequestError(`${path} must be true or false`);
      return;
    case "array": {
      if (!Array.isArray(value)) throw new BadRequestError(`${path} must be an array`);
      if (schema.items) value.forEach((v, i) => checkValue(schema.items!, v, `${path}[${i}]`));
      return;
    }
    default:
      return;
  }
}
