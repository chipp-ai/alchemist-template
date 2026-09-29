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
 * Gate failures are NORMAL tool results with honest wording (never opaque
 * errors, never thrown McpErrors -- the SDK would flatten those and strip
 * challenge/link payloads).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMcpTools } from "@/mcp/registry.ts";
import { formatToolPrice, gatePaidToolCall, mppEnabled, paymentRequiredToolResult } from "@/mcp/mpp.ts";
import { monetizationDescriptionSuffix, runMonetizationGates } from "@/mcp/gates.ts";
import type { McpAuthContext } from "@/api/middleware/mcp-auth.ts";
import { log } from "@/lib/logger.ts";

// Ensure example tools are registered (side-effect import)
import "@/mcp/tools/echo.ts";
import "@/mcp/tools/team_summary.ts";

export interface McpServerContext {
  /** Resolved caller identity (null when unauthenticated in public mode). */
  auth?: McpAuthContext | null;
  /** Public base URL of THIS request (for minting checkout return URLs). */
  baseUrl?: string | null;
}

export function createMcpServer(context: McpServerContext = {}): McpServer {
  const auth = context.auth ?? null;
  const baseUrl = context.baseUrl ?? null;

  const server = new McpServer(
    {
      name: "alchemist-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register all tools from the registry
  for (const tool of listMcpTools()) {
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
      },
      async (args: Record<string, unknown>, extra: unknown) => {
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
                  text:
                    `"${tool.name}" is a paid tool, but this server has no payment method ` +
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
