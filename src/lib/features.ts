/**
 * Built-in features that ship in every project but stay OFF until the
 * project turns them on. FAIL CLOSED, like dev-mode.ts: a feature is on
 * only when its env var is exactly "1" or "true".
 *
 *   api  ALCHEMIST_FEATURE_API=1  Headless API product: /api/api-keys
 *                                 (api_sk_ keys) and every route under
 *                                 /api/v1 (src/services/headless-api/).
 *   mcp  ALCHEMIST_FEATURE_MCP=1  MCP server: /api/mcp, its OAuth 2.1
 *                                 endpoints, /api/mcp/api-keys (mcp_sk_
 *                                 keys) and the /.well-known/oauth-*
 *                                 discovery documents (src/mcp/).
 *
 * Both can be on at once. While a feature is off its routes answer 404,
 * exactly as if they did not exist, so nothing is exposed by default. The
 * tables and migrations exist in every project either way (they are cheap
 * and inert).
 *
 * How a project turns one on: on the Alchemist platform the builder (or the
 * builder's agent) calls the `set_project_feature` tool; the platform puts
 * the env var in the project's env and redeploys. In local dev, add the
 * var to `.env` and restart the server.
 *
 * Read per request, so a test can flip a feature with `setFeatureForTests`
 * without touching `Deno.env` (which parallel test workers share).
 */
import { createMiddleware } from "hono/factory";

export type Feature = "api" | "mcp";

export const FEATURE_ENV_VARS: Readonly<Record<Feature, string>> = {
  api: "ALCHEMIST_FEATURE_API",
  mcp: "ALCHEMIST_FEATURE_MCP",
};

const testOverrides = new Map<Feature, boolean>();

export function featureEnabled(feature: Feature): boolean {
  const override = testOverrides.get(feature);
  if (override !== undefined) return override;
  const v = Deno.env.get(FEATURE_ENV_VARS[feature]);
  return v === "1" || v === "true";
}

/** Tests only. Module state, so it stays inside the calling test worker. Pass null to clear. */
export function setFeatureForTests(feature: Feature, enabled: boolean | null): void {
  if (enabled === null) testOverrides.delete(feature);
  else testOverrides.set(feature, enabled);
}

/**
 * Answers 404 (the app's normal not-found response) while `feature` is off.
 * Register it on the exact paths the feature owns, never on a prefix that
 * other routes share: a request it rejects never reaches a later route.
 */
export function requireFeature(feature: Feature) {
  return createMiddleware(async (c, next) => {
    if (!featureEnabled(feature)) return c.notFound();
    await next();
  });
}
