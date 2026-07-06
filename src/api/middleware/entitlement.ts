/**
 * Entitlement-gated middleware -- the server-side feature gate for paid
 * products (see src/services/product.service.ts).
 *
 * Apply AFTER `requireAuth` on any route that should only be reachable by
 * orgs that purchased the named product:
 *
 *   reportRoutes.get(
 *     "/premium",
 *     requireAuth,
 *     requireEntitlement("premium_reports"),
 *     handler,
 *   );
 *
 * Responds 402 with code "ENTITLEMENT_REQUIRED" when the org has no live
 * purchase. The client can catch that code and route the user to the
 * purchase surface (billingStore.startCheckout).
 *
 * NOTE: this checks PRODUCT entitlements, not the org plan tier
 * (organizations.subscription_tier). Tier gating stays a simple role/tier
 * comparison in the handler.
 */

import { createMiddleware } from "hono/factory";
import { getUser } from "@/api/middleware/auth.ts";
import { hasActiveEntitlement } from "@/services/product.service.ts";
import { EntitlementRequiredError, ForbiddenError } from "@/utils/errors.ts";

export function requireEntitlement(productKey: string) {
  return createMiddleware(async (c, next) => {
    const user = getUser(c);
    if (!user.organizationId) {
      throw new ForbiddenError("You must belong to an organization.");
    }
    const entitled = await hasActiveEntitlement(user.organizationId, productKey);
    if (!entitled) {
      throw new EntitlementRequiredError(productKey);
    }
    await next();
  });
}
