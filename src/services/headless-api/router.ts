/**
 * The headless API feature (ALCHEMIST_FEATURE_API), mounted at /api by the
 * base app.ts. OFF by default: every path below answers 404 until the
 * project turns the feature on (src/lib/features.ts).
 *
 *   /api/api-keys  mint, list and revoke api_sk_ keys (session auth only,
 *                  so a leaked key cannot mint more keys)
 *   /api/v1/*      the API product (src/services/headless-api/v1.ts)
 *
 * The gate sits on these exact prefixes, never on "*": this router shares
 * /api with every other route, and a catch-all gate would 404 them too.
 * Add API routes to v1.ts, not here and not in app.ts.
 */
import { Hono } from "hono";
import { apiKeyRoutes } from "@/api/routes/api-keys/index.ts";
import { requireFeature } from "@/lib/features.ts";
import { apiV1Routes } from "@/services/headless-api/v1.ts";

export const headlessApiRouter = new Hono();

for (const path of ["/api-keys", "/api-keys/*", "/v1", "/v1/*"]) {
  headlessApiRouter.use(path, requireFeature("api"));
}
headlessApiRouter.route("/api-keys", apiKeyRoutes);
headlessApiRouter.route("/v1", apiV1Routes);
