/**
 * Billing Routes
 *
 * Two layers, one Stripe account:
 *
 *   PLAN TIER (the org's own subscription to THIS app's plans)
 *     GET  /subscription  - Current plan and status
 *     POST /portal        - Create Stripe billing portal session
 *     POST /checkout      - Checkout session for plan upgrade (env price IDs)
 *
 *   PRODUCTS (things this app SELLS -- one-time or monthly/yearly recurring;
 *   see src/services/product.service.ts)
 *     GET   /products              - List sellable products (active catalog)
 *     POST  /products              - Create product (billing.manage)
 *     PATCH /products/:id          - Update/archive product (billing.manage)
 *     POST  /products/:id/checkout - Checkout session for a product purchase
 *     GET   /purchases             - The org's purchase history
 *     GET   /entitlements          - Map of productKey -> entitled (UI gating)
 *
 *   POST /webhook - Stripe webhook handler (signature-verified). Routes
 *     product events (metadata.productId present) to purchase fulfillment
 *     and plan-tier events to organizations.subscription_tier. A product
 *     subscription must NEVER touch the org tier -- that is what the
 *     metadata.productId branch guards.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type Stripe from "stripe";
import { db } from "@/db/client.ts";
import { getUser, requireAuth, requireCapability } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError, ExternalServiceError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import { getStripe } from "@/lib/stripe.ts";
import {
  applyProductSubscriptionEvent,
  createProduct,
  createProductCheckout,
  ensureStripeCustomer,
  getEntitlementsForOrg,
  listProducts,
  listPurchasesForOrg,
  markPurchaseRefunded,
  recordProductPurchase,
  updateProduct,
} from "@/services/product.service.ts";
import { can } from "@/lib/roles.ts";

const billingRoutes = new Hono();

// ── Schemas ──

const checkoutSchema = z.object({
  priceId: z.string().min(1, "Price ID is required"),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const portalSchema = z.object({
  returnUrl: z.string().url().optional(),
});

const productCreateSchema = z.object({
  productKey: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1, "Name is required").max(255),
  description: z.string().trim().max(2000).optional(),
  type: z.enum(["one_time", "subscription"]),
  priceCents: z.number().int().positive().max(50_000_000),
  currency: z.string().trim().toLowerCase().length(3).optional(),
  interval: z.enum(["month", "year"]).optional(),
});

const productUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullish(),
  active: z.boolean().optional(),
  priceCents: z.number().int().positive().max(50_000_000).optional(),
});

const productCheckoutSchema = z.object({
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

// ── Plan-tier routes ──

/**
 * GET /subscription
 * Returns the current organization's subscription details.
 */
billingRoutes.get("/subscription", requireAuth, async (c) => {
  const user = getUser(c);

  const org = await db
    .selectFrom("organizations")
    .select([
      "id",
      "subscriptionTier",
      "stripeCustomerId",
      "stripeSubscriptionId",
      "creditsExhausted",
    ])
    .where("id", "=", user.organizationId)
    .executeTakeFirstOrThrow();

  // If there's a Stripe subscription, fetch details
  let subscription: Stripe.Subscription | null = null;
  const stripe = getStripe();
  if (stripe && org.stripeSubscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    } catch (err) {
      log.warn("Failed to fetch Stripe subscription", {
        source: "billing",
        subscriptionId: org.stripeSubscriptionId,
      }, err);
    }
  }

  return c.json({
    data: {
      tier: org.subscriptionTier,
      creditsExhausted: org.creditsExhausted,
      stripeCustomerId: org.stripeCustomerId,
      subscription: subscription
        ? {
          id: subscription.id,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        }
        : null,
    },
  });
});

/**
 * POST /portal
 * Creates a Stripe billing portal session. Requires an existing Stripe customer.
 */
billingRoutes.post(
  "/portal",
  requireAuth,
  zValidator("json", portalSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { returnUrl } = c.req.valid("json");
    const stripe = getStripe();

    if (!stripe) {
      throw new BadRequestError("Stripe not configured");
    }

    const org = await db
      .selectFrom("organizations")
      .select("stripeCustomerId")
      .where("id", "=", user.organizationId)
      .executeTakeFirstOrThrow();

    if (!org.stripeCustomerId) {
      throw new BadRequestError("No billing account found. Please subscribe to a plan first.");
    }

    const defaultReturnUrl = Deno.env.get("WEB_APP_URL") ?? "http://localhost:5173";

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: org.stripeCustomerId,
        return_url: returnUrl ?? `${defaultReturnUrl}/settings/billing`,
      });

      return c.json({ url: session.url });
    } catch (err) {
      log.error("Failed to create billing portal session", {
        source: "billing",
        orgId: user.organizationId,
      }, err);
      throw new ExternalServiceError("Stripe", "Failed to create billing portal session");
    }
  },
);

/**
 * POST /checkout
 * Creates a Stripe checkout session for upgrading to a paid plan.
 */
billingRoutes.post(
  "/checkout",
  requireAuth,
  zValidator("json", checkoutSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { priceId, successUrl, cancelUrl } = c.req.valid("json");
    const stripe = getStripe();

    if (!stripe) {
      throw new BadRequestError("Stripe not configured");
    }

    const defaultWebUrl = Deno.env.get("WEB_APP_URL") ?? "http://localhost:5173";

    try {
      const customerId = await ensureStripeCustomer(
        user.organizationId,
        user.email,
        user.name,
        stripe,
      );

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl ?? `${defaultWebUrl}/settings/billing?success=true`,
        cancel_url: cancelUrl ?? `${defaultWebUrl}/settings/billing`,
        subscription_data: {
          metadata: {
            organizationId: user.organizationId,
            type: "organization",
          },
        },
      });

      return c.json({ url: session.url, sessionId: session.id });
    } catch (err) {
      log.error("Failed to create checkout session", {
        source: "billing",
        orgId: user.organizationId,
      }, err);
      throw new ExternalServiceError("Stripe", "Failed to create checkout session");
    }
  },
);

// ── Product routes ──

/**
 * GET /products
 * Active sales catalog. Managers (`billing.manage`) can pass
 * ?includeInactive=true to also see archived products.
 */
billingRoutes.get("/products", requireAuth, async (c) => {
  const user = getUser(c);
  const includeInactive = c.req.query("includeInactive") === "true" &&
    can(user.role, "billing.manage");
  const products = await listProducts({ includeInactive });
  return c.json({ data: { products } });
});

/**
 * POST /products
 * Create a sellable product. Creates the Stripe Product + Price
 * automatically -- no dashboard steps, no env vars.
 */
billingRoutes.post(
  "/products",
  requireAuth,
  requireCapability("billing.manage"),
  zValidator("json", productCreateSchema, validationHook),
  async (c) => {
    const input = c.req.valid("json");
    const product = await createProduct(input);
    return c.json({ data: { product } }, 201);
  },
);

/**
 * PATCH /products/:id
 * Update name/description/price or archive (active: false).
 */
billingRoutes.patch(
  "/products/:id",
  requireAuth,
  requireCapability("billing.manage"),
  zValidator("json", productUpdateSchema, validationHook),
  async (c) => {
    const patch = c.req.valid("json");
    const productId = c.req.param("id");
    if (!productId) throw new BadRequestError("Missing product id");
    const product = await updateProduct(productId, patch);
    return c.json({ data: { product } });
  },
);

/**
 * POST /products/:id/checkout
 * Start a Stripe Checkout for a product. Mode (payment vs subscription)
 * follows the product type.
 */
billingRoutes.post(
  "/products/:id/checkout",
  requireAuth,
  zValidator("json", productCheckoutSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { successUrl, cancelUrl } = c.req.valid("json");
    const productId = c.req.param("id");
    if (!productId) throw new BadRequestError("Missing product id");
    const result = await createProductCheckout({
      organizationId: user.organizationId,
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      productId,
      successUrl,
      cancelUrl,
    });
    return c.json({ data: result });
  },
);

/**
 * GET /purchases
 * The org's purchase history (joined with product name/key).
 */
billingRoutes.get("/purchases", requireAuth, async (c) => {
  const user = getUser(c);
  const purchases = await listPurchasesForOrg(user.organizationId);
  return c.json({ data: { purchases } });
});

/**
 * GET /entitlements
 * Map of productKey -> true for live entitlements. Drive client-side
 * feature gating from this (server routes still enforce via
 * requireEntitlement -- the client map is UX, not security).
 */
billingRoutes.get("/entitlements", requireAuth, async (c) => {
  const user = getUser(c);
  const entitlements = await getEntitlementsForOrg(user.organizationId);
  return c.json({ data: { entitlements } });
});

// ── Webhook ──

/**
 * POST /webhook
 * Stripe webhook handler. Verifies signature, then dispatches to
 * handleStripeWebhookEvent (exported for tests).
 */
billingRoutes.post("/webhook", async (c) => {
  const stripe = getStripe();
  if (!stripe) {
    return c.json({ error: "Stripe not configured" }, 500);
  }

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) {
    log.warn("STRIPE_WEBHOOK_SECRET not set, skipping signature verification", {
      source: "billing",
    });
    return c.json({ error: "Webhook not configured" }, 500);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 400);
  }

  let event: Stripe.Event;
  try {
    const body = await c.req.text();
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    log.warn("Webhook signature verification failed", { source: "billing" }, err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  await handleStripeWebhookEvent(event);

  return c.json({ received: true });
});

/**
 * Dispatch one verified Stripe event. Exported so tests can exercise the
 * routing rules (product vs plan-tier) without a signed HTTP request.
 *
 * Routing rule: `metadata.productId` present -> PRODUCT purchase path
 * (purchases table). Absent -> plan-tier path (organizations table).
 */
export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const meta = session.metadata ?? {};
      if (!meta.productId || !meta.organizationId) {
        // Plan-tier checkouts are fulfilled by customer.subscription.*
        // events; nothing to do here.
        break;
      }
      await recordProductPurchase({
        organizationId: meta.organizationId,
        productId: meta.productId,
        checkoutSessionId: session.id,
        subscriptionId: typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null,
        paymentIntentId: typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
        amountCents: session.amount_total,
        currency: session.currency,
        purchasedBy: meta.userId || null,
      });
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const meta = subscription.metadata ?? {};

      // PRODUCT subscription -- update the purchase record and NEVER
      // touch the org's plan tier.
      if (meta.productId) {
        await applyProductSubscriptionEvent({
          subscriptionId: subscription.id,
          status: event.type === "customer.subscription.deleted" ? "canceled" : subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          canceledAt: subscription.canceled_at,
          metadata: meta,
        });
        break;
      }

      // PLAN-TIER subscription.
      const orgId = meta.organizationId;
      if (!orgId) {
        log.warn("Subscription webhook missing organizationId metadata", {
          source: "billing",
          subscriptionId: subscription.id,
          eventType: event.type,
        });
        break;
      }

      if (event.type === "customer.subscription.deleted") {
        await db
          .updateTable("organizations")
          .set({
            subscriptionTier: "FREE",
            stripeSubscriptionId: null,
            updatedAt: new Date(),
          })
          .where("id", "=", orgId)
          .execute();
        log.info("Subscription cancelled", {
          source: "billing",
          orgId,
          eventType: event.type,
        });
        break;
      }

      const tier = mapSubscriptionToTier(subscription);
      await db
        .updateTable("organizations")
        .set({
          subscriptionTier: tier,
          stripeSubscriptionId: subscription.id,
          updatedAt: new Date(),
        })
        .where("id", "=", orgId)
        .execute();
      log.info("Subscription updated", {
        source: "billing",
        orgId,
        tier,
        status: subscription.status,
        eventType: event.type,
      });
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id;
      if (paymentIntentId) {
        await markPurchaseRefunded(paymentIntentId);
      }
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      log.info("Invoice paid", {
        source: "billing",
        invoiceId: invoice.id,
        customerId: invoice.customer,
        amountPaid: invoice.amount_paid,
      });
      break;
    }

    default:
      log.debug("Unhandled webhook event", {
        source: "billing",
        eventType: event.type,
      });
  }
}

// ── Helpers ──

/** Tiers that exist in the subscription_tier Postgres enum. */
const KNOWN_TIERS = ["FREE", "STARTER", "PRO", "ENTERPRISE"] as const;

/**
 * Map a Stripe subscription to an internal tier name.
 * Looks at subscription metadata or price ID to determine tier.
 * Exported for tests.
 */
export function mapSubscriptionToTier(subscription: Stripe.Subscription): string {
  // Check metadata first -- but only values the DB enum accepts.
  const metaTier = subscription.metadata?.subscriptionTier;
  if (metaTier) {
    if ((KNOWN_TIERS as readonly string[]).includes(metaTier)) {
      return metaTier;
    }
    log.warn("Subscription metadata carries unknown tier; ignoring", {
      source: "billing",
      subscriptionId: subscription.id,
      metaTier,
    });
  }

  // Default mapping by price ID
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const monthlyPriceId = Deno.env.get("STRIPE_PRICE_MONTHLY");
  const yearlyPriceId = Deno.env.get("STRIPE_PRICE_YEARLY");

  if (priceId === monthlyPriceId || priceId === yearlyPriceId) {
    return "PRO";
  }

  // Unrecognized paid price. Grant PRO (they paid for SOMETHING; never
  // strand a paying org on FREE) and flag the mapping gap. If you add a
  // new plan price, extend this function -- "BUILDER"-style made-up tier
  // names crash the subscription_tier enum on UPDATE.
  log.warn("Unrecognized plan price; defaulting tier to PRO", {
    source: "billing",
    subscriptionId: subscription.id,
    priceId,
  });
  return "PRO";
}

export { billingRoutes };
