/**
 * Bearer API-key auth that COMPOSES with the existing session auth.
 *
 * `requireAuthOrApiKey` accepts EITHER the session cookie (browser/dashboard
 * callers) OR `Authorization: Bearer api_sk_...` (programmatic callers) and
 * populates the SAME context (`c.get("user")` as AuthUser), so every
 * downstream middleware -- requireCapability, requireEntitlement, the
 * monetization gates -- works identically for both caller types.
 *
 * Use it on the routes that make up your API PRODUCT. Keep plain
 * `requireAuth` on account-management surfaces (key minting, billing config)
 * so a leaked API key cannot mint more keys or change billing.
 */

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { requireAuth } from "@/api/middleware/auth.ts";
import { apiKeyService } from "@/services/api-key.service.ts";
import { UnauthorizedError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";

export const requireAuthOrApiKey = createMiddleware(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (token) {
    let resolved;
    try {
      resolved = await apiKeyService.verify(token);
    } catch (err) {
      // A transient DB failure must NOT masquerade as an invalid key --
      // 503 tells well-behaved clients to retry instead of rotating keys.
      log.warn("API key lookup failed", { source: "api-key-auth" }, err as Error);
      return c.json({ error: "Auth backend unavailable, retry", code: "AUTH_UNAVAILABLE" }, 503);
    }
    if (!resolved) {
      throw new UnauthorizedError("Invalid or revoked API key");
    }
    if (!resolved.organizationId) {
      throw new UnauthorizedError("API key owner has no organization");
    }
    c.set("user", {
      id: resolved.userId,
      email: resolved.email,
      name: resolved.name,
      organizationId: resolved.organizationId,
      role: resolved.role,
    });
    c.set("organizationId", resolved.organizationId);
    return await next();
  }

  // No bearer -- fall through to the session-cookie path. Delegate to the
  // canonical requireAuth so session semantics (logout-all, HIPAA TTLs)
  // stay in ONE place.
  if (!getCookie(c, "session_id")) {
    throw new UnauthorizedError(
      "Authentication required: send Authorization: Bearer api_sk_... or a session cookie",
    );
  }
  return await requireAuth(c, next);
});
