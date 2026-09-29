/**
 * Monetization middleware -- how this API charges for routes.
 *
 * Three lanes, one per business model. Each failure response is an HONEST
 * machine-readable JSON body (stable `code` + a `checkoutUrl` when a
 * purchase can fix it) so both programmatic callers and LLM agents can act
 * on it instead of blind-retrying.
 *
 *   requirePurchase("pro")   -- entitlement gate: the caller's org must own
 *                               the product. 402 ENTITLEMENT_REQUIRED with a
 *                               server-minted Stripe Checkout link.
 *   chargeCredits(5)         -- prepaid metering: atomic per-request debit
 *                               against the org credit balance. 402
 *                               INSUFFICIENT_CREDITS with a top-up checkout
 *                               link; the debit is refunded when the route
 *                               handler throws (charge -> run -> refund).
 *   mppPaid({ fiatUsd })     -- MPP machine payments (per-request, no
 *                               account needed): 402 + signed
 *                               WWW-Authenticate Payment challenges; agents
 *                               pay and retry; responses carry receipts.
 *
 * The first two REQUIRE identity -- apply AFTER requireAuthOrApiKey.
 * mppPaid needs no identity (payment IS the credential) and composes WITH
 * the others if you want authenticated + per-call-paid routes.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getUser } from "@/api/middleware/auth.ts";
import {
  createProductCheckout,
  getProductByKey,
  hasActiveEntitlement,
  listProducts,
} from "@/services/product.service.ts";
import { creditService } from "@/services/credit.service.ts";
import type { CreditPackProduct } from "@/db/credit-tables.ts";
import { formatRoutePrice, gatePaidRequest, type RoutePrice } from "@/services/mpp.service.ts";
import { log } from "@/lib/logger.ts";

/** Public base URL for checkout return pages (mirrors well-known derivation). */
function requestBaseUrl(c: Context): string {
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (host) {
    const proto = c.req.header("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return Deno.env.get("APP_URL") ?? "http://localhost:8000";
}

/** Mint a checkout URL for a product, or null. Never throws. */
async function mintCheckoutUrl(c: Context, productId: string): Promise<string | null> {
  try {
    const user = getUser(c);
    const base = requestBaseUrl(c);
    const result = await createProductCheckout({
      organizationId: user.organizationId,
      userId: user.id,
      userEmail: user.email,
      productId,
      successUrl: `${base}/api/billing/purchase/complete`,
      cancelUrl: `${base}/api/billing/purchase/complete?canceled=true`,
    });
    return result.url;
  } catch (err) {
    log.warn("Could not mint checkout link for monetization gate", {
      source: "monetize",
      productId,
    }, err as Error);
    return null;
  }
}

/**
 * Entitlement gate. Apply after requireAuthOrApiKey:
 *
 *   app.get("/api/reports", requireAuthOrApiKey, requirePurchase("pro"), handler)
 */
export function requirePurchase(productKey: string) {
  return createMiddleware(async (c, next) => {
    const user = getUser(c);
    const entitled = await hasActiveEntitlement(user.organizationId, productKey);
    if (entitled) return await next();

    const product = await getProductByKey(productKey);
    if (!product || !product.active) {
      return c.json({
        error: `This endpoint requires the "${productKey}" purchase, which is not currently ` +
          "available for sale. Contact the operator.",
        code: "ENTITLEMENT_REQUIRED",
        productKey,
      }, 402);
    }
    const checkoutUrl = await mintCheckoutUrl(c, product.id);
    return c.json({
      error: `This endpoint requires the "${product.name}" purchase ` +
        `($${(product.priceCents / 100).toFixed(2)}${
          product.type === "subscription"
            ? product.billingInterval === "year" ? "/yr" : "/mo"
            : " one-time"
        }). Complete checkout, then retry.`,
      code: "ENTITLEMENT_REQUIRED",
      productKey,
      ...(checkoutUrl ? { checkoutUrl } : {}),
    }, 402);
  });
}

/**
 * Prepaid credit meter. Apply after requireAuthOrApiKey:
 *
 *   app.post("/api/analyze", requireAuthOrApiKey, chargeCredits(5), handler)
 *
 * Debits BEFORE the handler runs (atomic, never negative) and refunds if
 * the handler throws -- callers never pay for work that did not happen.
 */
export function chargeCredits(cost: number) {
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new Error("chargeCredits(cost) requires a positive integer");
  }
  return createMiddleware(async (c, next) => {
    const user = getUser(c);
    const debit = await creditService.debit({
      organizationId: user.organizationId,
      amount: cost,
      reason: "api_call",
      metadata: { path: c.req.path, userId: user.id },
    });

    if (!debit.ok) {
      const packs = (await listProducts() as CreditPackProduct[]).filter(
        (p) => p.grantsCredits && p.type === "one_time",
      ).sort((a, b) => a.priceCents - b.priceCents);
      const pack = packs[0];
      const checkoutUrl = pack ? await mintCheckoutUrl(c, pack.id) : null;
      return c.json({
        error: `Insufficient credits: this endpoint costs ${cost} ` +
          `credit${cost === 1 ? "" : "s"} per request and the balance is ${debit.balance}. ` +
          (checkoutUrl
            ? `Buy the "${pack!.name}" pack (${pack!.grantsCredits} credits), then retry.`
            : "Contact the operator to buy more credits."),
        code: "INSUFFICIENT_CREDITS",
        balance: Number(debit.balance),
        cost,
        ...(checkoutUrl ? { checkoutUrl } : {}),
      }, 402);
    }

    // Refund when the downstream handler fails. NOTE: Hono does NOT
    // propagate handler exceptions through middleware try/catch -- compose
    // catches them and dispatches app.onError directly, and `await next()`
    // resolves normally. The reliable signal is `c.error`, which Hono sets
    // on the context when a handler threw. (Verified against Hono 4.12;
    // a try/catch here would be dead code that silently kept the debit.)
    await next();
    if (c.error) {
      await creditService.refund({
        organizationId: user.organizationId,
        amount: cost,
        reason: "api_error_refund",
        metadata: { path: c.req.path },
      }).catch((refundErr) => {
        log.error("Credit refund after route failure failed", {
          source: "monetize",
          path: c.req.path,
        }, refundErr as Error);
      });
    }
  });
}

/**
 * MPP machine-payments gate (per-request, account-free). Apply on any route:
 *
 *   app.get("/api/data", mppPaid({ fiatUsd: "0.50", cryptoUsd: "0.01" }), handler)
 *
 * Unpaid requests get HTTP 402 + signed WWW-Authenticate Payment challenges;
 * MPP-capable agents (mppx client, @stripe/link-cli) pay and retry with an
 * Authorization: Payment credential; the final response carries a receipt.
 */
export function mppPaid(price: RoutePrice) {
  if (!price.fiatUsd && !price.cryptoUsd) {
    throw new Error("mppPaid(price) requires fiatUsd and/or cryptoUsd");
  }
  return createMiddleware(async (c, next) => {
    const gate = await gatePaidRequest(c.req.raw, price);

    if (gate.kind === "unconfigured") {
      // Fail closed with an honest, non-retryable body.
      return c.json({ error: gate.message, code: "PAYMENTS_UNCONFIGURED" }, 503);
    }
    if (gate.kind === "challenge") {
      // The mppx-built 402 carries the WWW-Authenticate Payment headers and
      // an RFC 9457 problem+json body (price context appended via header).
      const res = gate.response;
      res.headers.set("X-Price", formatRoutePrice(price));
      return res;
    }

    await next();
    c.res = gate.attachReceipt(c.res);
  });
}
