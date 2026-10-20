/**
 * Chipp Payments routes, mounted at /api/chipp-payments.
 *
 *   GET  /status    whether Chipp Payments is on, its mode, and the catalog
 *   POST /checkout  { productKey, returnPath?, cancelPath? } -> { url }
 *   POST /portal    { returnPath? } -> { url }  (manage billing)
 *   POST /sync      pull the org's sales from Chipp -> { entitlements }
 *
 * The buyer is always the signed-in user's organization (`org:<orgId>`),
 * never an id from the request. Return paths are relative; Chipp builds the
 * origin. The client map from /sync is UX only: server routes still gate
 * with requirePurchase / requireEntitlement on the local `purchases` table.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getUser, requireAuth } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import {
  chippPaymentsActive,
  chippPaymentsConfig,
  customerRefForOrg,
  listChippProducts,
  startChippCheckout,
  startChippPortal,
  toRelativePath,
  usesOwnStripeKey,
} from "@/lib/chipp-payments.ts";
import { syncChippCatalog, syncChippEntitlements } from "@/services/chipp-entitlements.ts";
import { getEntitlementsForOrg } from "@/services/product.service.ts";

export const chippPaymentsRoutes = new Hono();

const relPath = z.string().trim().max(512).optional();

chippPaymentsRoutes.get("/status", requireAuth, async (c) => {
  const cfg = chippPaymentsConfig();
  if (!chippPaymentsActive() || !cfg) {
    return c.json({
      data: {
        active: false,
        ownStripeKey: usesOwnStripeKey(),
        mode: null,
        testMode: false,
        sandboxAccount: false,
        products: [],
      },
    });
  }
  const catalog = await listChippProducts();
  try {
    await syncChippCatalog(catalog);
  } catch (err) {
    // The catalog still answers; the mirror catches up on the next sync.
    log.warn("Chipp Payments catalog mirror failed", { source: "chipp-payments" }, err);
  }
  return c.json({
    data: {
      active: true,
      ownStripeKey: false,
      mode: catalog.mode,
      testMode: catalog.testMode,
      sandboxAccount: catalog.sandboxAccount,
      products: catalog.products,
    },
  });
});

chippPaymentsRoutes.post(
  "/checkout",
  requireAuth,
  zValidator(
    "json",
    z.object({
      productKey: z.string().trim().min(1).max(64),
      returnPath: relPath,
      cancelPath: relPath,
    }),
    validationHook,
  ),
  async (c) => {
    if (!chippPaymentsActive()) {
      throw new BadRequestError("Chipp Payments is not set up for this app.");
    }
    const user = getUser(c);
    const body = c.req.valid("json");
    const returnPath = toRelativePath(body.returnPath, "/app/#/settings/billing");
    const result = await startChippCheckout({
      productKey: body.productKey,
      customerRef: customerRefForOrg(user.organizationId),
      email: user.email,
      returnPath,
      cancelPath: toRelativePath(body.cancelPath, returnPath),
    });
    return c.json({ data: { url: result.url, testMode: result.testMode } });
  },
);

chippPaymentsRoutes.post(
  "/portal",
  requireAuth,
  zValidator("json", z.object({ returnPath: relPath }), validationHook),
  async (c) => {
    if (!chippPaymentsActive()) {
      throw new BadRequestError("Chipp Payments is not set up for this app.");
    }
    const user = getUser(c);
    const result = await startChippPortal({
      customerRef: customerRefForOrg(user.organizationId),
      returnPath: toRelativePath(c.req.valid("json").returnPath, "/app/#/settings/billing"),
    });
    return c.json({ data: { url: result.url } });
  },
);

chippPaymentsRoutes.post("/sync", requireAuth, async (c) => {
  const user = getUser(c);
  const applied = await syncChippEntitlements(user.organizationId);
  const entitlements = await getEntitlementsForOrg(user.organizationId);
  return c.json({ data: { applied, entitlements } });
});
