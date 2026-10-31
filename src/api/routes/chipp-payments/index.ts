/**
 * Chipp Payments routes, mounted at /api/chipp-payments.
 *
 *   GET  /status    whether Chipp Payments is on, its mode, and the catalog
 *   POST /checkout  { productKey, returnPath?, cancelPath? } -> { url }
 *   POST /portal    { returnPath? } -> { url }  (manage billing)
 *   POST /sync      pull the org's sales from Chipp -> { entitlements }
 *
 * Donations (PUBLIC: a visitor gives without an account):
 *   GET  /donations          the donation products and their choices
 *   POST /donate             { productKey, amountCents, frequency, email?, returnPath?, cancelPath? } -> { url }
 *   POST /donation/confirm   { purchaseId, sessionId } -> the gift (the thank-you page)
 *   POST /donation/manage    { purchaseId, sessionId, returnPath? } -> { url } (a recurring gift's portal)
 *
 * A donation names its gift by Chipp's purchase id plus the Stripe Checkout
 * Session id from the donor's return URL; Chipp checks both and answers
 * only for this app's own project. /donate is rate limited per client IP,
 * and Chipp limits every app's payments calls too.
 *
 * The buyer is always the signed-in user's organization (`org:<orgId>`),
 * never an id from the request. Return paths are relative; Chipp builds the
 * origin. The client map from /sync is UX only: server routes still gate
 * with requirePurchase / requireEntitlement on the local `purchases` table.
 */

import { type Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getUser, requireAuth } from "@/api/middleware/auth.ts";
import { rateLimit } from "@/lib/redis.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import {
  chippPaymentsActive,
  chippPaymentsConfig,
  customerRefForOrg,
  listChippProducts,
  startChippCheckout,
  startChippDonation,
  startChippDonationPortal,
  startChippPortal,
  toRelativePath,
  usesOwnStripeKey,
} from "@/lib/chipp-payments.ts";
import { syncChippCatalog, syncChippEntitlements } from "@/services/chipp-entitlements.ts";
import { confirmChippDonation } from "@/services/chipp-donations.ts";
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

// ── Donations (public) ──

/** Where a donor lands after Stripe Checkout (web/src/routes/DonationThankYou.svelte). */
export const DONATION_THANK_YOU_PATH = "/app/#/donate/thank-you";

/** Gifts started per client IP per 10 minutes (CWE-770). */
export const DONATE_RATE_PER_IP = 20;

/**
 * The client IP for rate limiting. On the Chipp platform every request
 * reaches the app through Cloudflare, which sets cf-connecting-ip and
 * never forwards a client's own value; without it, one shared bucket.
 */
function rateLimitIp(c: Context): string {
  const ip = (c.req.header("cf-connecting-ip") ?? "").trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "unknown";
}

const donationRef = {
  purchaseId: z.string().uuid(),
  sessionId: z.string().trim().min(1).max(255),
};

chippPaymentsRoutes.get("/donations", async (c) => {
  if (!chippPaymentsActive()) {
    return c.json({ data: { active: false, testMode: false, sandboxAccount: false, donations: [] } });
  }
  const catalog = await listChippProducts();
  return c.json({
    data: {
      active: true,
      testMode: catalog.testMode,
      sandboxAccount: catalog.sandboxAccount,
      donations: catalog.donations ?? [],
    },
  });
});

chippPaymentsRoutes.post(
  "/donate",
  zValidator(
    "json",
    z.object({
      productKey: z.string().trim().min(1).max(64),
      amountCents: z.coerce.number().transform(Math.round).pipe(z.number().int().positive()),
      frequency: z.enum(["one_time", "month", "year"]),
      email: z.string().trim().email().max(254).nullish(),
      returnPath: relPath,
      cancelPath: relPath,
    }),
    validationHook,
  ),
  async (c) => {
    if (!chippPaymentsActive()) {
      throw new BadRequestError("Donations are not set up for this app yet.");
    }
    const limit = await rateLimit(`chipp-donate:${rateLimitIp(c)}`, { limit: DONATE_RATE_PER_IP, windowSeconds: 600 });
    if (!limit.allowed) {
      return c.json({ error: "Too many attempts. Try again in a few minutes." }, 429);
    }
    const body = c.req.valid("json");
    const returnPath = toRelativePath(body.returnPath, DONATION_THANK_YOU_PATH);
    const result = await startChippDonation({
      productKey: body.productKey,
      amountCents: body.amountCents,
      frequency: body.frequency,
      email: body.email ?? null,
      returnPath,
      cancelPath: toRelativePath(body.cancelPath, "/"),
    });
    return c.json({ data: { url: result.url, testMode: result.testMode } });
  },
);

chippPaymentsRoutes.post(
  "/donation/confirm",
  zValidator("json", z.object(donationRef), validationHook),
  async (c) => {
    if (!chippPaymentsActive()) {
      throw new BadRequestError("Donations are not set up for this app yet.");
    }
    const gift = await confirmChippDonation(c.req.valid("json"));
    return c.json({
      data: {
        status: gift.status,
        amountCents: gift.amountCents,
        currency: gift.currency,
        interval: gift.interval,
        recurring: gift.recurring,
        canManage: gift.canManage,
      },
    });
  },
);

chippPaymentsRoutes.post(
  "/donation/manage",
  zValidator("json", z.object({ ...donationRef, returnPath: relPath }), validationHook),
  async (c) => {
    if (!chippPaymentsActive()) {
      throw new BadRequestError("Donations are not set up for this app yet.");
    }
    const body = c.req.valid("json");
    const result = await startChippDonationPortal({
      purchaseId: body.purchaseId,
      sessionId: body.sessionId,
      returnPath: toRelativePath(body.returnPath, "/"),
    });
    return c.json({ data: { url: result.url } });
  },
);
