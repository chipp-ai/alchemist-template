/**
 * Product monetization service -- sell things with Stripe, no re-plumbing.
 *
 * The app-global `products` catalog + org-scoped `purchases` (entitlement)
 * records. Supports two product shapes out of the box:
 *
 *   - one_time      -- a single payment (Checkout mode "payment")
 *   - subscription  -- monthly or yearly recurring (Checkout mode "subscription")
 *
 * Creating a product here ALSO creates the Stripe Product + Price via the
 * API -- the operator never has to click through the Stripe dashboard or
 * paste price IDs into env vars. The Stripe webhook (billing routes) calls
 * the fulfillment functions below to keep `purchases` in sync.
 *
 * Feature gating:
 *   - Server: `hasActiveEntitlement(orgId, "premium_reports")` or the
 *     `requireEntitlement("premium_reports")` route middleware.
 *   - Client: `billingStore.isEntitled("premium_reports")`.
 *
 * This is DISTINCT from the org plan tier (organizations.subscription_tier,
 * driven by STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY). Products are what
 * the app sells on top of (or instead of) plan tiers.
 */

import type Stripe from "stripe";
import { db } from "@/db/client.ts";
import type {
  BillingInterval,
  Product,
  ProductType,
  Purchase,
  PurchaseStatus,
} from "@/db/schema.ts";
import { requireStripe } from "@/lib/stripe.ts";
import { log } from "@/lib/logger.ts";
import {
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
} from "@/utils/errors.ts";

// ── Types ──

export interface NewProductInput {
  /** Stable code-level key, e.g. "premium_reports". Lowercase slug. */
  productKey: string;
  name: string;
  description?: string;
  type: ProductType;
  priceCents: number;
  /** ISO currency code, default "usd". */
  currency?: string;
  /** Required for type "subscription"; forbidden for "one_time". */
  interval?: BillingInterval;
}

export interface ProductUpdateInput {
  name?: string;
  description?: string | null;
  active?: boolean;
  /** Changing price creates a NEW Stripe Price and archives the old one. */
  priceCents?: number;
}

export interface ProductCheckoutInput {
  organizationId: string;
  userId: string;
  userEmail: string;
  userName?: string | null;
  productId: string;
  successUrl?: string;
  cancelUrl?: string;
}

/** Purchase row joined with the product it bought. */
export interface PurchaseWithProduct extends Purchase {
  productKey: string;
  productName: string;
  productType: ProductType;
}

// The subset of the Stripe SDK the service touches. Tests inject a stub;
// production callers default to requireStripe().
export type StripeLike = Pick<Stripe, "products" | "prices" | "customers" | "checkout">;

// ── Validation ──

const PRODUCT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertValidInput(input: NewProductInput): void {
  if (!PRODUCT_KEY_RE.test(input.productKey)) {
    throw new BadRequestError(
      "productKey must be a lowercase slug (a-z, 0-9, _ or -), max 64 chars.",
    );
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) {
    throw new BadRequestError("priceCents must be a positive integer.");
  }
  if (input.type === "subscription" && !input.interval) {
    throw new BadRequestError(
      'Subscription products require an interval ("month" or "year").',
    );
  }
  if (input.type === "one_time" && input.interval) {
    throw new BadRequestError("One-time products must not set an interval.");
  }
}

// ── Catalog ──

/**
 * Create a product: Stripe Product + Price first, then the DB row. If the
 * DB insert fails after Stripe objects were created, the Stripe objects
 * are orphaned but harmless (nothing references them); re-creating the
 * product mints fresh ones.
 */
export async function createProduct(
  input: NewProductInput,
  stripe: StripeLike = requireStripe(),
): Promise<Product> {
  assertValidInput(input);

  const existing = await db
    .selectFrom("products")
    .select("id")
    .where("productKey", "=", input.productKey)
    .executeTakeFirst();
  if (existing) {
    throw new ConflictError(
      `A product with key "${input.productKey}" already exists.`,
    );
  }

  const currency = (input.currency ?? "usd").toLowerCase();

  let stripeProductId: string;
  let stripePriceId: string;
  try {
    const stripeProduct = await stripe.products.create({
      name: input.name,
      description: input.description || undefined,
      metadata: { productKey: input.productKey },
    });
    stripeProductId = stripeProduct.id;

    const stripePrice = await stripe.prices.create({
      product: stripeProductId,
      unit_amount: input.priceCents,
      currency,
      ...(input.type === "subscription"
        ? { recurring: { interval: input.interval! } }
        : {}),
    });
    stripePriceId = stripePrice.id;
  } catch (err) {
    log.error("Failed to create Stripe product/price", {
      source: "product-service",
      productKey: input.productKey,
    }, err);
    throw new ExternalServiceError("Stripe", "Failed to create product");
  }

  const row = await db
    .insertInto("products")
    .values({
      productKey: input.productKey,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      priceCents: input.priceCents,
      currency,
      billingInterval: input.type === "subscription" ? input.interval! : null,
      stripeProductId,
      stripePriceId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  log.info("Product created", {
    source: "product-service",
    productId: row.id,
    productKey: row.productKey,
    type: row.type,
  });
  return row;
}

/**
 * Update name/description/active (synced to Stripe) and/or price (creates
 * a NEW Stripe Price -- Stripe prices are immutable -- and archives the old
 * one; existing subscriptions keep their original price).
 */
export async function updateProduct(
  productId: string,
  patch: ProductUpdateInput,
  stripe: StripeLike = requireStripe(),
): Promise<Product> {
  const product = await getProductById(productId);

  if (
    patch.priceCents !== undefined &&
    (!Number.isInteger(patch.priceCents) || patch.priceCents <= 0)
  ) {
    throw new BadRequestError("priceCents must be a positive integer.");
  }

  let newStripePriceId: string | undefined;
  try {
    if (
      product.stripeProductId &&
      (patch.name !== undefined || patch.description !== undefined ||
        patch.active !== undefined)
    ) {
      await stripe.products.update(product.stripeProductId, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description || undefined }
          : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      });
    }

    if (
      patch.priceCents !== undefined && patch.priceCents !== product.priceCents
    ) {
      if (!product.stripeProductId) {
        throw new BadRequestError(
          "Product has no Stripe product; cannot change price.",
        );
      }
      const price = await stripe.prices.create({
        product: product.stripeProductId,
        unit_amount: patch.priceCents,
        currency: product.currency,
        ...(product.type === "subscription"
          ? { recurring: { interval: product.billingInterval! } }
          : {}),
      });
      newStripePriceId = price.id;
      if (product.stripePriceId) {
        await stripe.prices.update(product.stripePriceId, { active: false });
      }
    }
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    log.error("Failed to update Stripe product/price", {
      source: "product-service",
      productId,
    }, err);
    throw new ExternalServiceError("Stripe", "Failed to update product");
  }

  const row = await db
    .updateTable("products")
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.priceCents !== undefined ? { priceCents: patch.priceCents } : {}),
      ...(newStripePriceId ? { stripePriceId: newStripePriceId } : {}),
      updatedAt: new Date(),
    })
    .where("id", "=", productId)
    .returningAll()
    .executeTakeFirstOrThrow();

  return row;
}

export async function listProducts(
  opts: { includeInactive?: boolean } = {},
): Promise<Product[]> {
  let q = db.selectFrom("products").selectAll().orderBy("createdAt", "asc");
  if (!opts.includeInactive) {
    q = q.where("active", "=", true);
  }
  return await q.execute();
}

export async function getProductById(productId: string): Promise<Product> {
  const row = await db
    .selectFrom("products")
    .selectAll()
    .where("id", "=", productId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("Product", productId);
  return row;
}

export async function getProductByKey(
  productKey: string,
): Promise<Product | null> {
  const row = await db
    .selectFrom("products")
    .selectAll()
    .where("productKey", "=", productKey)
    .executeTakeFirst();
  return row ?? null;
}

// ── Checkout ──

/**
 * Reuse or create the org's Stripe customer. Shared by plan-tier checkout
 * and product checkout so an org never ends up with duplicate customers.
 */
export async function ensureStripeCustomer(
  organizationId: string,
  email: string,
  name: string | null | undefined,
  stripe: StripeLike = requireStripe(),
): Promise<string> {
  const org = await db
    .selectFrom("organizations")
    .select(["id", "stripeCustomerId"])
    .where("id", "=", organizationId)
    .executeTakeFirstOrThrow();

  if (org.stripeCustomerId) return org.stripeCustomerId;

  const customer = await stripe.customers.create({
    email,
    name: name ?? undefined,
    metadata: { organizationId, type: "organization" },
  });

  await db
    .updateTable("organizations")
    .set({ stripeCustomerId: customer.id })
    .where("id", "=", organizationId)
    .execute();

  return customer.id;
}

/**
 * Create a Stripe Checkout session for a product. Mode follows the product
 * type. The metadata stamped here (organizationId + productId + productKey +
 * userId) is what the webhook fulfillment path trusts -- both on the session
 * AND on the subscription (for recurring products), so renewal/cancel events
 * route to the product path instead of the plan-tier path.
 */
export async function createProductCheckout(
  input: ProductCheckoutInput,
  stripe: StripeLike = requireStripe(),
): Promise<{ url: string; sessionId: string }> {
  const product = await getProductById(input.productId);
  if (!product.active) {
    throw new BadRequestError("This product is not available for purchase.");
  }
  if (!product.stripePriceId) {
    throw new BadRequestError(
      "This product has no Stripe price configured. Recreate it while Stripe is configured.",
    );
  }

  const customerId = await ensureStripeCustomer(
    input.organizationId,
    input.userEmail,
    input.userName,
    stripe,
  );

  const defaultWebUrl = Deno.env.get("WEB_APP_URL") ?? "http://localhost:5173";
  const metadata = {
    organizationId: input.organizationId,
    productId: product.id,
    productKey: product.productKey,
    userId: input.userId,
  };

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: product.type === "subscription" ? "subscription" : "payment",
      line_items: [{ price: product.stripePriceId, quantity: 1 }],
      success_url: input.successUrl ??
        `${defaultWebUrl}/settings/billing?purchase=success`,
      cancel_url: input.cancelUrl ?? `${defaultWebUrl}/settings/billing`,
      metadata,
      ...(product.type === "subscription"
        ? { subscription_data: { metadata } }
        : { payment_intent_data: { metadata } }),
    });
    if (!session.url) {
      throw new ExternalServiceError("Stripe", "Checkout session has no URL");
    }
    return { url: session.url, sessionId: session.id };
  } catch (err) {
    if (err instanceof ExternalServiceError) throw err;
    log.error("Failed to create product checkout session", {
      source: "product-service",
      organizationId: input.organizationId,
      productId: input.productId,
    }, err);
    throw new ExternalServiceError("Stripe", "Failed to create checkout session");
  }
}

// ── Webhook fulfillment (pure DB; called from the Stripe webhook) ──

/** Map a Stripe subscription status onto the purchase_status enum. */
export function mapStripeSubscriptionStatus(status: string): PurchaseStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    default:
      // canceled, unpaid, incomplete, incomplete_expired, paused
      return "canceled";
  }
}

export interface RecordPurchaseInput {
  organizationId: string;
  productId: string;
  checkoutSessionId: string;
  subscriptionId?: string | null;
  paymentIntentId?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  purchasedBy?: string | null;
}

/**
 * Record a completed checkout. Idempotent: replays of the same checkout
 * session (Stripe delivers at-least-once) are no-ops, and a subscription
 * row pre-created by an out-of-order subscription event is completed in
 * place rather than duplicated.
 */
export async function recordProductPurchase(
  input: RecordPurchaseInput,
): Promise<void> {
  // A subscription event can arrive BEFORE checkout.session.completed and
  // pre-create the row keyed by subscription id -- fill it in instead of
  // inserting a duplicate.
  if (input.subscriptionId) {
    const existing = await db
      .selectFrom("purchases")
      .select(["id", "stripeCheckoutSessionId"])
      .where("stripeSubscriptionId", "=", input.subscriptionId)
      .executeTakeFirst();
    if (existing) {
      if (!existing.stripeCheckoutSessionId) {
        await db
          .updateTable("purchases")
          .set({
            stripeCheckoutSessionId: input.checkoutSessionId,
            ...(input.paymentIntentId
              ? { stripePaymentIntentId: input.paymentIntentId }
              : {}),
            ...(input.amountCents != null
              ? { amountCents: input.amountCents }
              : {}),
            ...(input.currency ? { currency: input.currency } : {}),
            ...(input.purchasedBy ? { purchasedBy: input.purchasedBy } : {}),
            updatedAt: new Date(),
          })
          .where("id", "=", existing.id)
          .execute();
      }
      return;
    }
  }

  await db
    .insertInto("purchases")
    .values({
      organizationId: input.organizationId,
      productId: input.productId,
      purchasedBy: input.purchasedBy ?? null,
      status: "active",
      stripeCheckoutSessionId: input.checkoutSessionId,
      stripeSubscriptionId: input.subscriptionId ?? null,
      stripePaymentIntentId: input.paymentIntentId ?? null,
      amountCents: input.amountCents ?? 0,
      currency: (input.currency ?? "usd").toLowerCase(),
    })
    .onConflict((oc) => oc.column("stripeCheckoutSessionId").doNothing())
    .execute();

  log.info("Product purchase recorded", {
    source: "product-service",
    organizationId: input.organizationId,
    productId: input.productId,
    checkoutSessionId: input.checkoutSessionId,
  });
}

export interface SubscriptionEventInput {
  subscriptionId: string;
  status: string;
  /** Unix seconds, from subscription.current_period_end. */
  currentPeriodEnd?: number | null;
  canceledAt?: number | null;
  /** Metadata from the Stripe subscription (used to create a missing row). */
  metadata?: Record<string, string | undefined>;
}

/**
 * Apply a subscription created/updated/deleted event to the matching
 * purchase row. If no row exists yet (event raced ahead of
 * checkout.session.completed) and the metadata identifies a product
 * purchase, the row is created.
 */
export async function applyProductSubscriptionEvent(
  input: SubscriptionEventInput,
): Promise<void> {
  const status = mapStripeSubscriptionStatus(input.status);
  const currentPeriodEnd = input.currentPeriodEnd
    ? new Date(input.currentPeriodEnd * 1000)
    : null;
  const canceledAt = input.canceledAt
    ? new Date(input.canceledAt * 1000)
    : status === "canceled"
    ? new Date()
    : null;

  const updated = await db
    .updateTable("purchases")
    .set({
      status,
      ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
      ...(status === "canceled" ? { canceledAt } : {}),
      updatedAt: new Date(),
    })
    .where("stripeSubscriptionId", "=", input.subscriptionId)
    .executeTakeFirst();

  if (Number(updated.numUpdatedRows) > 0) return;

  // No row yet -- create one from metadata if this is a product subscription.
  const organizationId = input.metadata?.organizationId;
  const productId = input.metadata?.productId;
  if (!organizationId || !productId) {
    log.warn("Product subscription event matched no purchase row", {
      source: "product-service",
      subscriptionId: input.subscriptionId,
      status: input.status,
    });
    return;
  }

  await db
    .insertInto("purchases")
    .values({
      organizationId,
      productId,
      purchasedBy: input.metadata?.userId ?? null,
      status,
      stripeSubscriptionId: input.subscriptionId,
      currentPeriodEnd,
      canceledAt,
    })
    .onConflict((oc) => oc.column("stripeSubscriptionId").doNothing())
    .execute();
}

/** Mark the purchase paid by `paymentIntentId` as refunded. */
export async function markPurchaseRefunded(
  paymentIntentId: string,
): Promise<void> {
  const result = await db
    .updateTable("purchases")
    .set({ status: "refunded", updatedAt: new Date() })
    .where("stripePaymentIntentId", "=", paymentIntentId)
    .where("status", "!=", "refunded")
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) > 0) {
    log.info("Purchase marked refunded", {
      source: "product-service",
      paymentIntentId,
    });
  }
}

// ── Entitlements ──

/**
 * True when the org has a live purchase of `productKey`. `past_due` counts
 * as entitled (Stripe's grace window); a subscription whose period end has
 * lapsed does NOT, even if a cancel webhook was missed.
 */
export async function hasActiveEntitlement(
  organizationId: string,
  productKey: string,
): Promise<boolean> {
  const rows = await entitledPurchaseRows(organizationId);
  return rows.some((r) => r.productKey === productKey);
}

/**
 * Map of productKey -> true for every product the org currently has a live
 * entitlement to. Feed this to the client for UI gating.
 */
export async function getEntitlementsForOrg(
  organizationId: string,
): Promise<Record<string, boolean>> {
  const rows = await entitledPurchaseRows(organizationId);
  const map: Record<string, boolean> = {};
  for (const r of rows) map[r.productKey] = true;
  return map;
}

async function entitledPurchaseRows(
  organizationId: string,
): Promise<Array<{ productKey: string }>> {
  return await db
    .selectFrom("purchases")
    .innerJoin("products", "products.id", "purchases.productId")
    .select(["products.productKey as productKey"])
    .where("purchases.organizationId", "=", organizationId)
    .where("purchases.status", "in", ["active", "past_due"])
    .where((eb) =>
      eb.or([
        eb("purchases.currentPeriodEnd", "is", null),
        eb("purchases.currentPeriodEnd", ">", new Date()),
      ])
    )
    .execute();
}

export async function listPurchasesForOrg(
  organizationId: string,
): Promise<PurchaseWithProduct[]> {
  const rows = await db
    .selectFrom("purchases")
    .innerJoin("products", "products.id", "purchases.productId")
    .selectAll("purchases")
    .select([
      "products.productKey as productKey",
      "products.name as productName",
      "products.type as productType",
    ])
    .where("purchases.organizationId", "=", organizationId)
    .orderBy("purchases.createdAt", "desc")
    .execute();
  return rows as PurchaseWithProduct[];
}
