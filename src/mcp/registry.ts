/**
 * MCP Tool Registry
 *
 * A minimal, explicit registry for MCP tools. Each tool declares:
 * - name (unique)
 * - description (shown to clients)
 * - inputSchema (plain object mapping argName -> Zod type)
 * - handler (receives validated args, returns MCP content blocks)
 *
 * This keeps tool definitions decoupled from the transport wiring and
 * makes it easy to enumerate / introspect available tools.
 */

import { z } from "zod";
import type { ToolPrice } from "@/mcp/mpp.ts";
import type { McpAuthContext } from "@/api/middleware/mcp-auth.ts";

export type ToolInputShape = Record<string, z.ZodTypeAny>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputShape;
  /**
   * Optional MPP price -- makes this a PAID tool (Stripe machine payments,
   * for PROGRAMMATIC agents that can pay per call). Unpaid calls receive a
   * payment challenge; MPP-capable agents pay and retry with the credential
   * in `_meta["org.paymentauth/credential"]`. Mutually exclusive with
   * `creditCost`. See src/mcp/mpp.ts.
   */
  price?: ToolPrice;
  /**
   * Entitlement gate for INTERACTIVE clients: the caller's org must own
   * this product (products/purchases layer). Unentitled calls return a
   * Stripe Checkout link the agent relays to its human. Requires
   * MCP_AUTH_MODE=oauth. See src/mcp/gates.ts.
   */
  requiredProductKey?: string;
  /**
   * Prepaid metered gate for INTERACTIVE clients: atomically debits the
   * org's credit balance per call; insufficient balance returns a top-up
   * checkout link. Requires MCP_AUTH_MODE=oauth. Mutually exclusive with
   * `price`. See src/mcp/gates.ts + src/services/credit.service.ts.
   */
  creditCost?: number;
  handler: (
    args: Record<string, unknown>,
    context?: { auth: McpAuthContext | null; baseUrl: string | null },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

const registeredTools: McpTool[] = [];

export function registerMcpTool(tool: McpTool): void {
  if (registeredTools.some((t) => t.name === tool.name)) {
    throw new Error(`MCP tool "${tool.name}" is already registered`);
  }
  if (tool.price && tool.creditCost) {
    throw new Error(
      `MCP tool "${tool.name}": price (MPP per-call payments) and creditCost (prepaid ` +
        "credits) are mutually exclusive -- pick ONE metered lane per tool.",
    );
  }
  if (tool.creditCost !== undefined && (!Number.isInteger(tool.creditCost) || tool.creditCost <= 0)) {
    throw new Error(`MCP tool "${tool.name}": creditCost must be a positive integer.`);
  }
  registeredTools.push(tool);
}

export function listMcpTools(): McpTool[] {
  return [...registeredTools];
}

export function getMcpTool(name: string): McpTool | undefined {
  return registeredTools.find((t) => t.name === name);
}
