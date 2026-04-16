/**
 * Billing Routes
 *
 * All routes (except webhook) require authentication.
 *
 * GET  /subscription  - Current plan and status
 * POST /portal        - Create Stripe billing portal session
 * POST /checkout      - Create Stripe checkout session for plan upgrade
 * POST /webhook       - Stripe webhook handler
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import Stripe from "stripe";
import { db } from "@/db/client.ts";
import { requireAuth, getUser } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError, ExternalServiceError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";

const billingRoutes = new Hono();

// ── Stripe client ──

function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return null;
  // deno-lint-ignore no-explicit-any
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" as any });
}

// ── Schemas ──

const checkoutSchema = z.object({
  priceId: z.string().min(1, "Price ID is required"),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const portalSchema = z.object({
  returnUrl: z.string().url().optional(),
});

// ── Routes ──

/**
 * GET /subscription
 * Returns the current organization's subscription details.
 */
billingRoutes.get("/subscription", requireAuth, async (c) => {
  const user = getUser(c);

  const org = await db
    .selectFrom("app.organizations")
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
      .selectFrom("app.organizations")
      .select("stripeCustomerId")
      .where("id", "=", user.organizationId)
      .executeTakeFirstOrThrow();

    if (!org.stripeCustomerId) {
      throw new BadRequestError("No billing account found. Please subscribe to a plan first.");
    }

    const defaultReturnUrl =
      Deno.env.get("WEB_APP_URL") ?? "http://localhost:5173";

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

    const org = await db
      .selectFrom("app.organizations")
      .select(["id", "stripeCustomerId"])
      .where("id", "=", user.organizationId)
      .executeTakeFirstOrThrow();

    const defaultWebUrl =
      Deno.env.get("WEB_APP_URL") ?? "http://localhost:5173";

    try {
      // Create or reuse Stripe customer
      let customerId = org.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name ?? undefined,
          metadata: {
            organizationId: user.organizationId,
            type: "organization",
          },
        });
        customerId = customer.id;

        await db
          .updateTable("app.organizations")
          .set({ stripeCustomerId: customerId })
          .where("id", "=", user.organizationId)
          .execute();
      }

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

/**
 * POST /webhook
 * Stripe webhook handler. Verifies signature, handles subscription events.
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
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    log.warn("Webhook signature verification failed", { source: "billing" }, err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  // Handle events
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const orgId = subscription.metadata?.organizationId;
      if (!orgId) {
        log.warn("Subscription webhook missing organizationId metadata", {
          source: "billing",
          subscriptionId: subscription.id,
          eventType: event.type,
        });
        break;
      }

      const tier = mapSubscriptionToTier(subscription);
      await db
        .updateTable("app.organizations")
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

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const orgId = subscription.metadata?.organizationId;
      if (!orgId) break;

      await db
        .updateTable("app.organizations")
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

  return c.json({ received: true });
});

// ── Helpers ──

/**
 * Map a Stripe subscription to an internal tier name.
 * Looks at subscription metadata or price ID to determine tier.
 */
function mapSubscriptionToTier(subscription: Stripe.Subscription): string {
  // Check metadata first
  if (subscription.metadata?.subscriptionTier) {
    return subscription.metadata.subscriptionTier;
  }

  // Default mapping by price ID
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const monthlyPriceId = Deno.env.get("STRIPE_PRICE_MONTHLY");
  const yearlyPriceId = Deno.env.get("STRIPE_PRICE_YEARLY");

  if (priceId === monthlyPriceId || priceId === yearlyPriceId) {
    return "PRO";
  }

  return "BUILDER";
}

export { billingRoutes };
