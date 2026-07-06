/**
 * Product monetization tests -- catalog, checkout session shape, webhook
 * fulfillment idempotency, and entitlement checks.
 *
 * Stripe is stubbed (StripeLike) -- these tests exercise OUR logic: DB
 * writes, idempotency under Stripe's at-least-once/out-of-order delivery,
 * the product-vs-plan-tier webhook routing rule, and entitlement math.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type Stripe from "stripe";
import { db } from "@/db/client.ts";
import { createIsolatedUser } from "../helpers.ts";
import {
  applyProductSubscriptionEvent,
  createProduct,
  createProductCheckout,
  getEntitlementsForOrg,
  hasActiveEntitlement,
  listPurchasesForOrg,
  mapStripeSubscriptionStatus,
  markPurchaseRefunded,
  recordProductPurchase,
  type StripeLike,
  updateProduct,
} from "@/services/product.service.ts";
import {
  handleStripeWebhookEvent,
  mapSubscriptionToTier,
} from "@/api/routes/billing/index.ts";
import { BadRequestError, ConflictError } from "@/utils/errors.ts";

// ── Stripe stub ──

interface StubCalls {
  productCreates: unknown[];
  priceCreates: unknown[];
  sessionCreates: Record<string, unknown>[];
}

function stubStripe(): { stripe: StripeLike; calls: StubCalls } {
  let seq = 0;
  const calls: StubCalls = {
    productCreates: [],
    priceCreates: [],
    sessionCreates: [],
  };
  const stripe = {
    products: {
      create: (params: unknown) => {
        calls.productCreates.push(params);
        return Promise.resolve({ id: `prod_test_${++seq}` });
      },
      update: () => Promise.resolve({}),
    },
    prices: {
      create: (params: unknown) => {
        calls.priceCreates.push(params);
        return Promise.resolve({ id: `price_test_${++seq}` });
      },
      update: () => Promise.resolve({}),
    },
    customers: {
      create: () => Promise.resolve({ id: `cus_test_${++seq}` }),
    },
    checkout: {
      sessions: {
        create: (params: Record<string, unknown>) => {
          calls.sessionCreates.push(params);
          return Promise.resolve({
            id: `cs_test_${++seq}`,
            url: "https://checkout.stripe.com/test",
          });
        },
      },
    },
  } as unknown as StripeLike;
  return { stripe, calls };
}

let keyCounter = 0;
function uniqueKey(prefix: string): string {
  keyCounter++;
  return `${prefix}_${Date.now().toString(36)}_${keyCounter}`;
}

async function deleteProduct(productId: string): Promise<void> {
  await db.deleteFrom("purchases").where("productId", "=", productId).execute();
  await db.deleteFrom("products").where("id", "=", productId).execute();
}

function test(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

// ── Pure helpers ──

test("mapStripeSubscriptionStatus: active/trialing entitle, past_due is grace, rest cancel", () => {
  assertEquals(mapStripeSubscriptionStatus("active"), "active");
  assertEquals(mapStripeSubscriptionStatus("trialing"), "active");
  assertEquals(mapStripeSubscriptionStatus("past_due"), "past_due");
  assertEquals(mapStripeSubscriptionStatus("canceled"), "canceled");
  assertEquals(mapStripeSubscriptionStatus("unpaid"), "canceled");
  assertEquals(mapStripeSubscriptionStatus("incomplete_expired"), "canceled");
});

test("mapSubscriptionToTier: never returns a value outside the subscription_tier enum", () => {
  const KNOWN = ["FREE", "STARTER", "PRO", "ENTERPRISE"];
  // Unknown price + no metadata -- the old code returned "BUILDER", which
  // is not in the enum and crashed the org UPDATE.
  const unknownPrice = {
    id: "sub_x",
    metadata: {},
    items: { data: [{ price: { id: "price_unknown" } }] },
  } as unknown as Stripe.Subscription;
  assert(KNOWN.includes(mapSubscriptionToTier(unknownPrice)));

  // Metadata with a bogus tier is ignored, not written to the enum column.
  const bogusMeta = {
    id: "sub_y",
    metadata: { subscriptionTier: "BUILDER" },
    items: { data: [{ price: { id: "price_unknown" } }] },
  } as unknown as Stripe.Subscription;
  assert(KNOWN.includes(mapSubscriptionToTier(bogusMeta)));

  // Valid metadata tier passes through.
  const goodMeta = {
    id: "sub_z",
    metadata: { subscriptionTier: "STARTER" },
    items: { data: [] },
  } as unknown as Stripe.Subscription;
  assertEquals(mapSubscriptionToTier(goodMeta), "STARTER");
});

// ── Catalog ──

test("createProduct: subscription product creates Stripe product + recurring price", async () => {
  const { stripe, calls } = stubStripe();
  const key = uniqueKey("sub_product");
  const product = await createProduct({
    productKey: key,
    name: "Premium Plan",
    description: "All the extras",
    type: "subscription",
    priceCents: 2900,
    interval: "month",
  }, stripe);
  try {
    assertEquals(product.productKey, key);
    assertEquals(product.type, "subscription");
    assertEquals(product.billingInterval, "month");
    assert(product.stripeProductId?.startsWith("prod_test_"));
    assert(product.stripePriceId?.startsWith("price_test_"));
    assertEquals(calls.priceCreates.length, 1);
    const priceParams = calls.priceCreates[0] as {
      unit_amount: number;
      recurring?: { interval: string };
    };
    assertEquals(priceParams.unit_amount, 2900);
    assertEquals(priceParams.recurring?.interval, "month");
  } finally {
    await deleteProduct(product.id);
  }
});

test("createProduct: one_time product has no recurring block", async () => {
  const { stripe, calls } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("onetime"),
    name: "Lifetime Deal",
    type: "one_time",
    priceCents: 9900,
  }, stripe);
  try {
    assertEquals(product.type, "one_time");
    assertEquals(product.billingInterval, null);
    const priceParams = calls.priceCreates[0] as { recurring?: unknown };
    assertEquals(priceParams.recurring, undefined);
  } finally {
    await deleteProduct(product.id);
  }
});

test("createProduct: validation rejects bad shapes", async () => {
  const { stripe } = stubStripe();
  // subscription without interval
  await assertRejects(
    () =>
      createProduct({
        productKey: uniqueKey("bad"),
        name: "X",
        type: "subscription",
        priceCents: 100,
      }, stripe),
    BadRequestError,
  );
  // one_time WITH interval
  await assertRejects(
    () =>
      createProduct({
        productKey: uniqueKey("bad"),
        name: "X",
        type: "one_time",
        priceCents: 100,
        interval: "month",
      }, stripe),
    BadRequestError,
  );
  // uppercase / invalid key
  await assertRejects(
    () =>
      createProduct({
        productKey: "Not A Slug",
        name: "X",
        type: "one_time",
        priceCents: 100,
      }, stripe),
    BadRequestError,
  );
});

test("createProduct: duplicate productKey conflicts", async () => {
  const { stripe } = stubStripe();
  const key = uniqueKey("dup");
  const product = await createProduct(
    { productKey: key, name: "First", type: "one_time", priceCents: 500 },
    stripe,
  );
  try {
    await assertRejects(
      () =>
        createProduct(
          { productKey: key, name: "Second", type: "one_time", priceCents: 500 },
          stripe,
        ),
      ConflictError,
    );
  } finally {
    await deleteProduct(product.id);
  }
});

test("updateProduct: price change mints a new Stripe price", async () => {
  const { stripe, calls } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("reprice"),
    name: "Reprice Me",
    type: "subscription",
    priceCents: 1000,
    interval: "year",
  }, stripe);
  try {
    const updated = await updateProduct(product.id, { priceCents: 2000 }, stripe);
    assertEquals(updated.priceCents, 2000);
    assert(updated.stripePriceId !== product.stripePriceId);
    assertEquals(calls.priceCreates.length, 2);
  } finally {
    await deleteProduct(product.id);
  }
});

// ── Checkout ──

test("createProductCheckout: mode + metadata follow the product type", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  const { stripe, calls } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("checkout_sub"),
    name: "Checkout Sub",
    type: "subscription",
    priceCents: 1500,
    interval: "month",
  }, stripe);
  try {
    const result = await createProductCheckout({
      organizationId: org.id,
      userId: user.id,
      userEmail: user.email,
      productId: product.id,
    }, stripe);
    assert(result.url.startsWith("https://checkout.stripe.com/"));

    const params = calls.sessionCreates[0] as {
      mode: string;
      metadata: Record<string, string>;
      subscription_data?: { metadata: Record<string, string> };
    };
    assertEquals(params.mode, "subscription");
    assertEquals(params.metadata.organizationId, org.id);
    assertEquals(params.metadata.productId, product.id);
    assertEquals(params.metadata.productKey, product.productKey);
    // The subscription itself carries the same metadata so renewal/cancel
    // events route to the product path, not the plan-tier path.
    assertEquals(params.subscription_data?.metadata.productId, product.id);
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});

test("createProductCheckout: archived products are not purchasable", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  const { stripe } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("archived"),
    name: "Archived",
    type: "one_time",
    priceCents: 500,
  }, stripe);
  try {
    await updateProduct(product.id, { active: false }, stripe);
    await assertRejects(
      () =>
        createProductCheckout({
          organizationId: org.id,
          userId: user.id,
          userEmail: user.email,
          productId: product.id,
        }, stripe),
      BadRequestError,
    );
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});

// ── Fulfillment + entitlements ──

test("recordProductPurchase: idempotent under webhook replays", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  const { stripe } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("replay"),
    name: "Replay",
    type: "one_time",
    priceCents: 500,
  }, stripe);
  try {
    const input = {
      organizationId: org.id,
      productId: product.id,
      checkoutSessionId: `cs_replay_${product.id}`,
      paymentIntentId: `pi_replay_${product.id}`,
      amountCents: 500,
    };
    await recordProductPurchase(input);
    await recordProductPurchase(input); // Stripe delivers at-least-once

    const purchases = await listPurchasesForOrg(org.id);
    assertEquals(purchases.length, 1);
    assertEquals(purchases[0].productKey, product.productKey);
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), true);
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});

test("subscription events: out-of-order create, then session fill, then cancel", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  const { stripe } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("ooo"),
    name: "Out of order",
    type: "subscription",
    priceCents: 900,
    interval: "month",
  }, stripe);
  const subId = `sub_ooo_${product.id}`;
  try {
    // 1. customer.subscription.created lands BEFORE checkout.session.completed.
    await applyProductSubscriptionEvent({
      subscriptionId: subId,
      status: "active",
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      metadata: { organizationId: org.id, productId: product.id },
    });
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), true);

    // 2. checkout.session.completed fills in the session -- no duplicate row.
    await recordProductPurchase({
      organizationId: org.id,
      productId: product.id,
      checkoutSessionId: `cs_ooo_${product.id}`,
      subscriptionId: subId,
      amountCents: 900,
    });
    let purchases = await listPurchasesForOrg(org.id);
    assertEquals(purchases.length, 1);
    assertEquals(purchases[0].stripeCheckoutSessionId, `cs_ooo_${product.id}`);

    // 3. subscription canceled -> entitlement gone.
    await applyProductSubscriptionEvent({
      subscriptionId: subId,
      status: "canceled",
      metadata: { organizationId: org.id, productId: product.id },
    });
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), false);
    purchases = await listPurchasesForOrg(org.id);
    assertEquals(purchases[0].status, "canceled");
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});

test("entitlements: lapsed period end does not entitle even if cancel webhook was missed", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  const { stripe } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("lapsed"),
    name: "Lapsed",
    type: "subscription",
    priceCents: 900,
    interval: "month",
  }, stripe);
  try {
    await applyProductSubscriptionEvent({
      subscriptionId: `sub_lapsed_${product.id}`,
      status: "active",
      currentPeriodEnd: Math.floor(Date.now() / 1000) - 3600, // an hour ago
      metadata: { organizationId: org.id, productId: product.id },
    });
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), false);
    const map = await getEntitlementsForOrg(org.id);
    assertEquals(map[product.productKey], undefined);
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});

test("markPurchaseRefunded: refund revokes the entitlement", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  const { stripe } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("refund"),
    name: "Refund",
    type: "one_time",
    priceCents: 500,
  }, stripe);
  const piId = `pi_refund_${product.id}`;
  try {
    await recordProductPurchase({
      organizationId: org.id,
      productId: product.id,
      checkoutSessionId: `cs_refund_${product.id}`,
      paymentIntentId: piId,
      amountCents: 500,
    });
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), true);

    await markPurchaseRefunded(piId);
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), false);
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});

// ── Webhook routing (the load-bearing rule) ──

test("webhook: a PRODUCT subscription event never touches the org plan tier", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  const { stripe } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("routing"),
    name: "Routing",
    type: "subscription",
    priceCents: 900,
    interval: "month",
  }, stripe);
  const subId = `sub_routing_${product.id}`;
  try {
    const before = await db
      .selectFrom("organizations")
      .select("subscriptionTier")
      .where("id", "=", org.id)
      .executeTakeFirstOrThrow();

    await handleStripeWebhookEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subId,
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          canceled_at: null,
          metadata: {
            organizationId: org.id,
            productId: product.id,
            productKey: product.productKey,
          },
          items: { data: [] },
        },
      },
    } as unknown as Stripe.Event);

    const after = await db
      .selectFrom("organizations")
      .select(["subscriptionTier", "stripeSubscriptionId"])
      .where("id", "=", org.id)
      .executeTakeFirstOrThrow();

    // Tier untouched; purchase recorded instead.
    assertEquals(after.subscriptionTier, before.subscriptionTier);
    assertEquals(after.stripeSubscriptionId, null);
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), true);
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});

test("webhook: a PLAN-TIER subscription event updates the org tier", async () => {
  const { org, cleanup } = await createIsolatedUser("owner");
  try {
    await handleStripeWebhookEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_tier_${org.id}`,
          status: "active",
          metadata: {
            organizationId: org.id,
            subscriptionTier: "PRO",
          },
          items: { data: [] },
        },
      },
    } as unknown as Stripe.Event);

    const after = await db
      .selectFrom("organizations")
      .select(["subscriptionTier", "stripeSubscriptionId"])
      .where("id", "=", org.id)
      .executeTakeFirstOrThrow();
    assertEquals(after.subscriptionTier, "PRO");
    assertEquals(after.stripeSubscriptionId, `sub_tier_${org.id}`);
  } finally {
    await cleanup();
  }
});

test("webhook: checkout.session.completed with productId metadata records the purchase", async () => {
  const { user, org, cleanup } = await createIsolatedUser("owner");
  const { stripe } = stubStripe();
  const product = await createProduct({
    productKey: uniqueKey("cs_done"),
    name: "Checkout Done",
    type: "one_time",
    priceCents: 4200,
  }, stripe);
  try {
    await handleStripeWebhookEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_done_${product.id}`,
          subscription: null,
          payment_intent: `pi_done_${product.id}`,
          amount_total: 4200,
          currency: "usd",
          metadata: {
            organizationId: org.id,
            productId: product.id,
            productKey: product.productKey,
            userId: user.id,
          },
        },
      },
    } as unknown as Stripe.Event);

    const purchases = await listPurchasesForOrg(org.id);
    assertEquals(purchases.length, 1);
    assertEquals(purchases[0].amountCents, 4200);
    assertEquals(purchases[0].purchasedBy, user.id);
    assertEquals(await hasActiveEntitlement(org.id, product.productKey), true);
  } finally {
    await deleteProduct(product.id);
    await cleanup();
  }
});
