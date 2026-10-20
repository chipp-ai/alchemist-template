/**
 * Chipp Payments wired into the base billing layer: product checkout goes
 * through Chipp in Chipp mode, the catalog is read-only here, and the
 * billing webhook answers GET with 405 and POST with 503 when unset
 * (issue #10). Client and mirror tests: chipp-payments-mirror.test.ts.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { db } from "@/db/client.ts";
import { createIsolatedUser, withTestServer } from "../helpers.ts";
import { __deleteEnvForTest, __setEnvForTest, getEnv } from "@/lib/env.ts";
import { __setChippPaymentsFetchForTest, customerRefForOrg } from "@/lib/chipp-payments.ts";
import { createProduct, createProductCheckout } from "@/services/product.service.ts";
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

function uniqueKey(): string {
  return `cp-${crypto.randomUUID().slice(0, 8)}`;
}

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
