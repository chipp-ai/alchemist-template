/**
 * The headless API product: every route under /api/v1. Mounted by
 * router.ts, so the whole tree 404s unless the API feature is on
 * (ALCHEMIST_FEATURE_API, see src/lib/features.ts).
 *
 * Add the project's API routes HERE. Put `requireAuthOrApiKey` first (a
 * browser session or `Authorization: Bearer api_sk_...`), then a
 * monetization lane from src/api/middleware/monetize.ts if the route is
 * paid: `chargeCredits(n)`, `requirePurchase("key")` or `mppPaid(price)`.
 * Scope every query to `getUser(c).organizationId`, never to an org id the
 * caller sends.
 *
 * `GET /api/v1/team-summary` is the example: 1 credit per call, the
 * caller's own organization only. Replace it with the project's real
 * routes; keep the pattern.
 */
import { Hono } from "hono";
import { db } from "@/db/client.ts";
import { getUser } from "@/api/middleware/auth.ts";
import { requireAuthOrApiKey } from "@/api/middleware/api-key-auth.ts";
import { chargeCredits } from "@/api/middleware/monetize.ts";

export const apiV1Routes = new Hono();

apiV1Routes.get("/team-summary", requireAuthOrApiKey, chargeCredits(1), async (c) => {
  const { organizationId } = getUser(c);
  const rows = await db
    .selectFrom("users")
    .select(["role"])
    .where("organizationId", "=", organizationId)
    .execute();
  const roleCounts: Record<string, number> = {};
  for (const row of rows) roleCounts[row.role] = (roleCounts[row.role] ?? 0) + 1;
  return c.json({ data: { teamSize: rows.length, roleCounts } });
});
