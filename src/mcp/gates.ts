/**
 * Monetization gates for MCP tools -- the INTERACTIVE-client lanes.
 *
 * Two per-tool knobs on registerMcpTool (combinable with each other; both
 * require an authenticated org, i.e. MCP_AUTH_MODE=oauth):
 *
 *   requiredProductKey  -- entitlement gate. The org must own the product
 *                          (subscription or one-time; products/purchases
 *                          layer). Unentitled calls return a tool error
 *                          carrying a server-minted Stripe Checkout link the
 *                          agent relays to its human -- the agentic purchase
 *                          funnel. After payment the webhook grants and the
 *                          retry succeeds.
 *   creditCost          -- prepaid metered gate. Atomically debits the org's
 *                          credit balance (credit.service.ts); insufficient
 *                          balance returns a top-up checkout link for a
 *                          credit-pack product (grantsCredits). A debit whose
 *                          tool run then fails is refunded.
 *
 * The third knob, `price` (MPP machine payments), serves programmatic agents
 * and lives in src/mcp/mpp.ts -- it is mutually exclusive with creditCost.
 *
 * All failure texts use honest anti-confabulation wording so the calling
 * agent relays reality instead of retrying or inventing explanations.
 */

import type { McpAuthContext } from "@/api/middleware/mcp-auth.ts";
import type { McpTool } from "@/mcp/registry.ts";
import {
  createProductCheckout,
  getProductByKey,
  hasActiveEntitlement,
  listProducts,
} from "@/services/product.service.ts";
import { creditService } from "@/services/credit.service.ts";
import type { CreditPackProduct } from "@/db/credit-tables.ts";
import { log } from "@/lib/logger.ts";

export interface ToolErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

export type GateOutcome =
  | { kind: "proceed"; refundOnFailure: (() => Promise<void>) | null }
  | { kind: "blocked"; result: ToolErrorResult };

function blocked(text: string): GateOutcome {
  return { kind: "blocked", result: { isError: true, content: [{ type: "text", text }] } };
}

function connectRequired(toolName: string): GateOutcome {
  return blocked(
    `"${toolName}" requires a signed-in account, but this call is not authenticated. ` +
      "Tell the user to connect this MCP server with OAuth (their MCP client will open a " +
      "sign-in page when the connection is added/refreshed). Do NOT retry until the " +
      "connection is authenticated.",
  );
}

/**
 * Mint a Stripe Checkout URL for a product, or null when checkout cannot be
 * created (Stripe unconfigured, product missing). Never throws.
 */
async function mintCheckoutUrl(
  productId: string,
  auth: McpAuthContext,
  baseUrl: string | null,
): Promise<string | null> {
  try {
    if (!auth.organizationId) return null;
    const result = await createProductCheckout({
      organizationId: auth.organizationId,
      userId: auth.userId,
      userEmail: auth.email,
      productId,
      ...(baseUrl
        ? {
          successUrl: `${baseUrl}/api/billing/purchase/complete`,
          cancelUrl: `${baseUrl}/api/billing/purchase/complete?canceled=true`,
        }
        : {}),
    });
    return result.url;
  } catch (err) {
    log.warn("Could not mint checkout link for tool gate", {
      source: "tool-gates",
      productId,
    }, err as Error);
    return null;
  }
}

/**
 * Run the entitlement + credit gates for one tool call. MPP (price) gating
 * happens separately in the server wrapper -- these two need identity, MPP
 * does not.
 */
export async function runMonetizationGates(
  tool: McpTool,
  auth: McpAuthContext | null,
  baseUrl: string | null,
): Promise<GateOutcome> {
  // ── Entitlement gate ──
  if (tool.requiredProductKey) {
    if (!auth || !auth.organizationId) return connectRequired(tool.name);

    const entitled = await hasActiveEntitlement(auth.organizationId, tool.requiredProductKey);
    if (!entitled) {
      const product = await getProductByKey(tool.requiredProductKey);
      if (!product || !product.active) {
        return blocked(
          `"${tool.name}" requires the "${tool.requiredProductKey}" purchase, but that ` +
            "product is not currently available for sale on this server. Tell the user to " +
            "contact the operator. Do NOT retry.",
        );
      }
      const price = (product.priceCents / 100).toFixed(2);
      const cadence = product.type === "subscription"
        ? `/${product.billingInterval === "year" ? "yr" : "mo"}`
        : " one-time";
      const url = await mintCheckoutUrl(product.id, auth, baseUrl);
      if (!url) {
        return blocked(
          `"${tool.name}" requires the "${product.name}" purchase ($${price}${cadence}), but ` +
            "checkout could not be created (payments may not be configured on this server). " +
            "Tell the user to contact the operator. Do NOT retry.",
        );
      }
      return blocked(
        `Purchase required: "${tool.name}" is part of "${product.name}" ` +
          `($${price}${cadence}). Share this secure Stripe Checkout link with the user so ` +
          `they can buy it: ${url} -- after they complete payment, retry this tool call ` +
          "and it will work. Do NOT retry before the user confirms payment.",
      );
    }
  }

  // ── Credit gate ──
  if (tool.creditCost) {
    if (!auth || !auth.organizationId) return connectRequired(tool.name);
    const organizationId = auth.organizationId;

    const debit = await creditService.debit({
      organizationId,
      amount: tool.creditCost,
      reason: "tool_call",
      metadata: { toolName: tool.name, userId: auth.userId },
    });

    if (!debit.ok) {
      // Offer the cheapest active credit pack as the top-up path.
      const packs = (await listProducts() as CreditPackProduct[]).filter(
        (p) => p.grantsCredits && p.type === "one_time",
      ).sort((a, b) => a.priceCents - b.priceCents);
      const pack = packs[0];
      const packLine = pack
        ? await (async () => {
          const url = await mintCheckoutUrl(pack.id, auth, baseUrl);
          const packPrice = (pack.priceCents / 100).toFixed(2);
          return url
            ? ` Share this Stripe Checkout link with the user to buy the "${pack.name}" ` +
              `credit pack ($${packPrice} for ${pack.grantsCredits} credits): ${url} -- ` +
              "after payment, retry this call."
            : " Tell the user to buy more credits from the operator.";
        })()
        : " No credit packs are currently for sale; tell the user to contact the operator.";
      return blocked(
        `Insufficient credits: "${tool.name}" costs ${tool.creditCost} ` +
          `credit${tool.creditCost === 1 ? "" : "s"} per call and the current balance is ` +
          `${debit.balance}.${packLine} Do NOT retry before topping up.`,
      );
    }

    // Charge -> run -> refund-on-failure.
    return {
      kind: "proceed",
      refundOnFailure: async () => {
        await creditService.refund({
          organizationId,
          amount: tool.creditCost!,
          reason: "tool_error_refund",
          metadata: { toolName: tool.name },
        });
      },
    };
  }

  return { kind: "proceed", refundOnFailure: null };
}

/** Description suffix so agents discover the requirement before calling. */
export function monetizationDescriptionSuffix(tool: McpTool): string {
  const parts: string[] = [];
  if (tool.requiredProductKey) {
    parts.push(
      `[REQUIRES PURCHASE: the "${tool.requiredProductKey}" product. Unpurchased calls ` +
        "return a checkout link to relay to the user.]",
    );
  }
  if (tool.creditCost) {
    parts.push(
      `[COSTS ${tool.creditCost} credit${tool.creditCost === 1 ? "" : "s"} per call, ` +
        "debited from the org's prepaid balance.]",
    );
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}
