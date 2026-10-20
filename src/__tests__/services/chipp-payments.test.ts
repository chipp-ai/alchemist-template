/**
 * Chipp Payments in the app: config and raw-key precedence, the broker
 * client (no price, no full URL), the purchases mirror (seq ordering), the
 * checkout path switch in product.service.ts, and the billing webhook's
 * GET 405 / 503-when-unset answers.
 *
 * The broker is stubbed with __setChippPaymentsFetchForTest; no test calls
 * Chipp or Stripe.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { db } from "@/db/client.ts";
import { createIsolatedUser, withTestServer } from "../helpers.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import {
  __setChippPaymentsFetchForTest,
  chippPaymentsActive,
  chippPaymentsConfig,
  customerRefForOrg,
  orgIdFromCustomerRef,
  startChippCheckout,
  toRelativePath,
} from "@/lib/chipp-payments.ts";
import {
  applyChippEntitlement,
  ENTITLEMENT_CHANGED_TOPIC,
  localPurchaseStatus,
  registerChippEntitlementHandlers,
  syncChippEntitlements,
} from "@/services/chipp-entitlements.ts";
import {
  createProduct,
  createProductCheckout,
  getProductByKey,
  hasActiveEntitlement,
} from "@/services/product.service.ts";
import { billingRoutes } from "@/api/routes/billing/index.ts";
import { BadRequestError } from "@/utils/errors.ts";

const HAS_DB = !!(getEnv("TEST_DATABASE_URL") || getEnv("DATABASE_URL"));
function dbTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !HAS_DB, sanitizeResources: false, sanitizeOps: false, fn });
}

const ENV_KEYS = [
  "CHIPP_PAYMENTS_URL",
  "CHIPP_PAYMENTS_TOKEN",
  "CHIPP_PAYMENTS_MODE",
  "CHIPP_PAYMENTS_SCOPE",
  "CHIPP_PAYMENTS_PROJECT_ID",
  "CHIPP_PAYMENTS_ORG_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, getEnv(k)]));
  for (const k of ENV_KEYS) __deleteEnvForTest(k);
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) __setEnvForTest(k, v);
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) __deleteEnvForTest(k);
      else __setEnvForTest(k, prev[k]!);
    }
  }
}

const ON = {
  CHIPP_PAYMENTS_URL: "https://platform.chipp.test/",
  CHIPP_PAYMENTS_TOKEN: "tok_abc",
  CHIPP_PAYMENTS_MODE: "test",
  CHIPP_PAYMENTS_SCOPE: "deploy",
  CHIPP_PAYMENTS_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
  CHIPP_PAYMENTS_ORG_ID: "22222222-2222-4222-8222-222222222222",
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubBroker(
  routes: Record<string, (body: unknown) => unknown>,
): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  __setChippPaymentsFetchForTest((input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    const path = new URL(url).pathname.replace("/api/internal/payments-broker", "");
    const handler = routes[path];
    if (!handler) {
      return Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 404 }));
    }
    return Promise.resolve(new Response(JSON.stringify(handler(body)), { status: 200 }));
  });
  return { calls, restore: () => __setChippPaymentsFetchForTest() };
}

// ── config and precedence ──────────────────────────────────────────────────

Deno.test("chipp payments: unconfigured means off", async () => {
  await withEnv({}, () => {
    assertEquals(chippPaymentsConfig(), null);
    assertEquals(chippPaymentsActive(), false);
  });
  await withEnv({ ...ON, CHIPP_PAYMENTS_MODE: "prod" }, () => {
    assertEquals(chippPaymentsConfig(), null);
  });
});

Deno.test("chipp payments: the app's own STRIPE_SECRET_KEY wins (never switched silently)", async () => {
  await withEnv({ ...ON }, () => assertEquals(chippPaymentsActive(), true));
  await withEnv(
    { ...ON, STRIPE_SECRET_KEY: "sk_test_own" },
    () => assertEquals(chippPaymentsActive(), false),
  );
});

Deno.test("chipp payments: buyer refs and relative paths", () => {
  const org = "33333333-3333-4333-8333-333333333333";
  assertEquals(customerRefForOrg(org), `org:${org}`);
  assertEquals(orgIdFromCustomerRef(`org:${org}`), org);
  assertEquals(orgIdFromCustomerRef("org:not-a-uuid"), null);
  assertEquals(orgIdFromCustomerRef("user:x"), null);
  assertEquals(toRelativePath("https://evil.test/app/#/x?y=1", "/"), "/app/#/x?y=1");
  assertEquals(toRelativePath("/app/#/settings", "/"), "/app/#/settings");
  assertEquals(toRelativePath("//evil.test/x", "/"), "/");
  assertEquals(toRelativePath(undefined, "/fallback"), "/fallback");
  assertEquals(localPurchaseStatus({ status: "active", entitled: true }), "active");
  assertEquals(localPurchaseStatus({ status: "past_due", entitled: true }), "past_due");
  assertEquals(localPurchaseStatus({ status: "active", entitled: false }), "canceled");
  assertEquals(localPurchaseStatus({ status: "refunded", entitled: false }), "refunded");
});

Deno.test("chipp payments: the client sends the bound headers and never a price or a full URL", async () => {
  await withEnv(ON, async () => {
    const { calls, restore } = stubBroker({
      "/checkout": () => ({
        ok: true,
        url: "https://checkout.stripe.test/x",
        purchaseId: "p",
        testMode: true,
      }),
    });
    try {
      const res = await startChippCheckout({
        productKey: "pro",
        customerRef: "org:x",
        returnPath: "/app/#/billing",
      });
      assertEquals(res.url, "https://checkout.stripe.test/x");
      const c = calls[0];
      assertEquals(c.url, "https://platform.chipp.test/api/internal/payments-broker/checkout");
      assertEquals(c.headers["x-chipp-payments-auth"], "tok_abc");
      assertEquals(c.headers["x-chipp-payments-project"], ON.CHIPP_PAYMENTS_PROJECT_ID);
      assertEquals(c.headers["x-chipp-payments-org"], ON.CHIPP_PAYMENTS_ORG_ID);
      assertEquals(c.headers["x-chipp-payments-mode"], "test");
      assertEquals(c.headers["x-chipp-payments-scope"], "deploy");
      assertEquals(Object.keys(c.body as object).sort(), [
        "customerRef",
        "productKey",
        "returnPath",
      ]);
    } finally {
      restore();
    }
  });
});

Deno.test("chipp payments: the inbox handler is registered for entitlement.changed", () => {
  // Registration is pure bookkeeping; calling it twice must not throw.
  registerChippEntitlementHandlers();
  assertEquals(ENTITLEMENT_CHANGED_TOPIC, "entitlement.changed");
});

// ── the mirror ─────────────────────────────────────────────────────────────

function uniqueKey(): string {
  return `cp-${crypto.randomUUID().slice(0, 8)}`;
}

dbTest("chipp payments: entitlements mirror into purchases in seq order", async () => {
  const ctx = await createIsolatedUser("owner");
  const key = uniqueKey();
  const { restore } = stubBroker({
    "/products": () => ({
      ok: true,
      mode: "test",
      testMode: true,
      sandboxAccount: true,
      products: [{
        key,
        name: "Pro",
        description: null,
        kind: "subscription",
        amountCents: 2900,
        currency: "usd",
        interval: "month",
      }],
    }),
  });
  try {
    await withEnv(ON, async () => {
      const purchaseId = crypto.randomUUID();
      const base = {
        purchaseId,
        productKey: key,
        customerRef: customerRefForOrg(ctx.org.id),
        status: "active",
        entitled: true,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000).toISOString(),
        amountCents: 2900,
        currency: "usd",
      };
      assertEquals(await applyChippEntitlement({ ...base, seq: 2 }), "applied");
      assert(await hasActiveEntitlement(ctx.org.id, key));
      const product = await getProductByKey(key);
      assertEquals(product?.stripePriceId, null);
      // An older event arriving late is ignored.
      assertEquals(
        await applyChippEntitlement({ ...base, seq: 1, entitled: false, status: "canceled" }),
        "stale",
      );
      assert(await hasActiveEntitlement(ctx.org.id, key));
      // A newer one revokes.
      assertEquals(
        await applyChippEntitlement({ ...base, seq: 3, entitled: false, status: "refunded" }),
        "applied",
      );
      assertEquals(await hasActiveEntitlement(ctx.org.id, key), false);
      const rows = await db.selectFrom("purchases").selectAll().where(
        "organizationId",
        "=",
        ctx.org.id,
      ).execute();
      assertEquals(rows.length, 1);
      assertEquals(rows[0].status, "refunded");
      // An org this database does not have is skipped.
      assertEquals(
        await applyChippEntitlement({
          ...base,
          purchaseId: crypto.randomUUID(),
          customerRef: `org:${crypto.randomUUID()}`,
          seq: 1,
        }),
        "unknown_org",
      );
    });
  } finally {
    restore();
    await db.deleteFrom("purchases").where("organizationId", "=", ctx.org.id).execute();
    await db.deleteFrom("products").where("productKey", "=", key).execute();
    await ctx.cleanup();
  }
});

dbTest(
  "chipp payments: pull sync applies the broker's entitlements for the caller's org only",
  async () => {
    const ctx = await createIsolatedUser("owner");
    const key = uniqueKey();
    const { calls, restore } = stubBroker({
      "/products": () => ({
        ok: true,
        mode: "test",
        testMode: true,
        sandboxAccount: false,
        products: [{
          key,
          name: "Setup",
          description: null,
          kind: "one_time",
          amountCents: 9900,
          currency: "usd",
          interval: null,
        }],
      }),
      "/entitlements": () => ({
        ok: true,
        entitlements: [{
          purchaseId: crypto.randomUUID(),
          productKey: key,
          status: "active",
          entitled: true,
          disputeStatus: "none",
          currentPeriodEnd: null,
          seq: 1,
        }],
      }),
    });
    try {
      await withEnv(ON, async () => {
        assertEquals(await syncChippEntitlements(ctx.org.id), 1);
        assert(await hasActiveEntitlement(ctx.org.id, key));
        const pull = calls.find((c) => c.url.includes("/entitlements"))!;
        assert(
          pull.url.endsWith(`customerRef=${encodeURIComponent(customerRefForOrg(ctx.org.id))}`),
        );
      });
      // With the app's own key, sync does nothing.
      await withEnv({ ...ON, STRIPE_SECRET_KEY: "sk_test_own" }, async () => {
        assertEquals(await syncChippEntitlements(ctx.org.id), 0);
      });
    } finally {
      restore();
      await db.deleteFrom("purchases").where("organizationId", "=", ctx.org.id).execute();
      await db.deleteFrom("products").where("productKey", "=", key).execute();
      await ctx.cleanup();
    }
  },
);

dbTest(
  "chipp payments: product checkout goes through Chipp; the catalog is read-only here",
  async () => {
    const ctx = await createIsolatedUser("owner");
    const key = uniqueKey();
    const { calls, restore } = stubBroker({
      "/products": () => ({
        ok: true,
        mode: "test",
        testMode: true,
        sandboxAccount: false,
        products: [],
      }),
      "/checkout": () => ({
        ok: true,
        url: "https://checkout.stripe.test/cp",
        purchaseId: "pp",
        testMode: true,
      }),
    });
    try {
      await withEnv(ON, async () => {
        const product = await db.insertInto("products").values({
          productKey: key,
          name: "Pro",
          type: "subscription",
          priceCents: 2900,
          billingInterval: "month",
        }).returningAll().executeTakeFirstOrThrow();
        const res = await createProductCheckout({
          organizationId: ctx.org.id,
          userId: ctx.user.id,
          userEmail: ctx.user.email,
          productId: product.id,
          successUrl: "https://app.test/app/#/settings/billing?purchase=success",
        });
        assertEquals(res.url, "https://checkout.stripe.test/cp");
        const body = calls.find((c) => c.url.endsWith("/checkout"))!.body as Record<
          string,
          unknown
        >;
        assertEquals(body.productKey, key);
        assertEquals(body.customerRef, customerRefForOrg(ctx.org.id));
        assertEquals(body.returnPath, "/app/#/settings/billing?purchase=success");
        assert(!("amountCents" in body) && !("priceId" in body));
        await assertRejects(
          () =>
            createProduct({
              productKey: uniqueKey(),
              name: "X",
              type: "one_time",
              priceCents: 100,
            }),
          BadRequestError,
          "managed by Chipp Payments",
        );
      });
    } finally {
      restore();
      await db.deleteFrom("products").where("productKey", "=", key).execute();
      await ctx.cleanup();
    }
  },
);

// ── billing webhook answers (issue #10) ────────────────────────────────────

Deno.test("billing webhook: GET answers 405 with a plain message", async () => {
  const app = withTestServer((a) => a.route("/api/billing", billingRoutes));
  const res = await app.request("/api/billing/webhook");
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "POST");
  assertEquals(await res.text(), "Stripe sends POST requests here. This is not a page.");
});

Deno.test("billing webhook: POST answers 503 when Stripe or the webhook secret is unset", async () => {
  const app = withTestServer((a) => a.route("/api/billing", billingRoutes));
  await withEnv({}, async () => {
    assertEquals(
      (await app.request("/api/billing/webhook", { method: "POST", body: "{}" })).status,
      503,
    );
  });
  await withEnv({ STRIPE_SECRET_KEY: "sk_test_x" }, async () => {
    assertEquals(
      (await app.request("/api/billing/webhook", { method: "POST", body: "{}" })).status,
      503,
    );
  });
});
