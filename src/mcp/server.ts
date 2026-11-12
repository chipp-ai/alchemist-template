/**
 * MCP Server Factory
 *
 * Creates an McpServer wired to our tool registry. Tools are registered
 * by importing their modules (side-effect registration) before calling
 * createMcpServer().
 *
 * MONETIZATION GATES (run in this order per call):
 *   1. requiredProductKey -- entitlement (interactive clients; OAuth org
 *      must own the product; failure returns a Stripe Checkout link).
 *   2. creditCost -- prepaid credits (atomic debit; insufficient balance
 *      returns a top-up checkout link; failed runs are refunded).
 *   3. price -- MPP machine payments (programmatic agents; signed
 *      challenges in _meta["org.paymentauth/payment-required"], credential
 *      retry in _meta["org.paymentauth/credential"], receipts attached).
 *
 * ACCESS runs before all three: a tool that declares a `capability` passes
 * the same role and portal check as an agent tool (`toolAllowed`), so a call
 * the person may not make spends nothing. A tool they may not call is not
 * registered at all, so it looks exactly like a tool that does not exist.
 *
 * Gate failures are NORMAL tool results with honest wording (never opaque
 * errors, never thrown McpErrors -- the SDK would flatten those and strip
 * challenge/link payloads).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMcpTools, type McpTool } from "@/mcp/registry.ts";
import {
  formatToolPrice,
  gatePaidToolCall,
  mppEnabled,
  paymentRequiredToolResult,
} from "@/mcp/mpp.ts";
import {
  monetizationDescriptionSuffix,
  runMonetizationGates,
  signInRequiredText,
} from "@/mcp/gates.ts";
import type { Context } from "hono";
import type { McpAuthContext } from "@/api/middleware/mcp-auth.ts";
import { log } from "@/lib/logger.ts";
import { BRAND } from "@/config/brand.ts";
import { toolAllowed } from "@/services/agent-tools/registry.ts";
import { type AgentToolCaller, registerBridgedAgentTools } from "@/mcp/agent-tools-bridge.ts";

// Ensure example tools are registered (side-effect import)
import "@/mcp/tools/echo.ts";
import "@/mcp/tools/team_summary.ts";
// Generic read tools every project gets: documents, data model, read-only rows.
import "@/mcp/tools/project_files.ts";
import "@/mcp/tools/project_data.ts";

export interface McpServerContext {
  /** Resolved caller identity (null when unauthenticated in public mode). */
  auth?: McpAuthContext | null;
  /** Public base URL of THIS request (for minting checkout return URLs). */
  baseUrl?: string | null;
  /**
   * The signed-in person for the agent-tools bridge (resolveAgentToolCaller),
   * with the request context the tools run in. Absent: no agent tools.
   */
  agentTools?: { caller: AgentToolCaller; c: Context } | null;
}

/**
 * What this caller may do with a registry tool. Pure.
 *
 * Anonymous (public mode only): the tool stays listed, so the client knows to
 * connect, and the call asks them to sign in. A signed-in caller with no
 * resolved person (deleted, or their org changed) fails closed.
 */
export function mcpToolAccess(
  tool: Pick<McpTool, "capability" | "portalSafe">,
  auth: McpAuthContext | null,
  caller: AgentToolCaller | null,
): "allowed" | "sign-in" | "hidden" {
  if (!tool.capability) return "allowed";
  if (!auth) return "sign-in";
  if (!caller) return "hidden";
  const allowed = toolAllowed(
    { capability: tool.capability, portalSafe: tool.portalSafe },
    caller.user,
    caller.portalBindings,
  );
  return allowed ? "allowed" : "hidden";
}

export function createMcpServer(context: McpServerContext = {}): McpServer {
  const auth = context.auth ?? null;
  const baseUrl = context.baseUrl ?? null;

  const server = new McpServer(
    {
      // The assistant shows this name, so it is the app's own name.
      name: BRAND.name,
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: `Tools for ${BRAND.name}. They act as the signed-in person. The app's ` +
        "agent tools follow that person's role and organization. Tools marked " +
        "destructive change data: ask the person before calling one.",
    },
  );

  // The app's own capabilities for the signed-in person (agent-tools bridge).
  if (context.agentTools) {
    registerBridgedAgentTools(
      server,
      context.agentTools.caller,
      context.agentTools.c,
      new Set(listMcpTools().map((t) => t.name)),
    );
  }

  // Register all tools from the registry
  for (const tool of listMcpTools()) {
    const access = mcpToolAccess(tool, auth, context.agentTools?.caller ?? null);
    if (access === "hidden") continue;

    // Convert our plain shape to the SDK's expected input shape
    const inputSchema: Record<string, z.ZodTypeAny> = { ...tool.inputSchema };

    // Monetized tools advertise their requirements in the description so
    // agents (and their humans) discover the cost BEFORE calling.
    let description = tool.description + monetizationDescriptionSuffix(tool);
    if (tool.price) {
      description += ` [PAID TOOL: ${formatToolPrice(tool.price)} per call via MPP ` +
        `(machine payments, https://mpp.dev). Calls without payment receive challenges in ` +
        `_meta["org.paymentauth/payment-required"]; pay and retry with the credential in ` +
        `_meta["org.paymentauth/credential"].]`;
    }

    server.registerTool(
      tool.name,
      {
        description,
        inputSchema,
        ...(tool.readOnly ? { annotations: { readOnlyHint: true, destructiveHint: false } } : {}),
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        if (access === "sign-in") {
          return {
            isError: true,
            content: [{ type: "text" as const, text: signInRequiredText(tool.name) }],
          };
        }

        // ── 1 + 2. Entitlement + credit gates (identity-based) ──
        const gate = await runMonetizationGates(tool, auth, baseUrl);
        if (gate.kind === "blocked") return gate.result;

        try {
          // ── 3. MPP payment gate (payment IS the credential) ──
          if (tool.price) {
            if (!mppEnabled()) {
              return {
                isError: true,
                content: [{
                  type: "text" as const,
                  text: `"${tool.name}" is a paid tool, but this server has no payment method ` +
                    "configured yet, so the call cannot proceed. Do NOT retry. Tell the user " +
                    "the server operator needs to configure MPP payments (MPP_SECRET_KEY + " +
                    "Stripe credentials).",
                }],
              };
            }

            const paymentGate = await gatePaidToolCall(
              tool.name,
              tool.price,
              (extra ?? {}) as { _meta?: Record<string, unknown> },
            );
            if (paymentGate.kind === "unconfigured") {
              return {
                isError: true,
                content: [{ type: "text" as const, text: paymentGate.message }],
              };
            }
            if (paymentGate.kind === "challenge") {
              return paymentRequiredToolResult(tool.name, tool.price, paymentGate.error);
            }

            const result = await tool.handler(args, { auth, baseUrl });
            log.info("Paid tool call completed", { source: "mcp", toolName: tool.name });
            return paymentGate.attachReceipt(result);
          }

          return await tool.handler(args, { auth, baseUrl });
        } catch (err) {
          // Credit debits are refunded when the tool run fails -- the user
          // paid for work that did not happen.
          if (gate.refundOnFailure) {
            await gate.refundOnFailure().catch((refundErr) => {
              log.error("Credit refund after tool failure failed", {
                source: "mcp",
                toolName: tool.name,
              }, refundErr as Error);
            });
          }
          throw err;
        }
      },
    );
  }

  return server;
}
