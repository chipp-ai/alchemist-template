/**
 * OAuth discovery for the MCP server feature, mounted at the origin root
 * (/.well-known) by the base app.ts: RFC 8414/9728 require the root path.
 *
 * OFF by default, like the rest of the feature: while ALCHEMIST_FEATURE_MCP
 * is off these documents answer 404. The gate covers only the two OAuth
 * documents, so any other /.well-known file the project serves (for
 * example from web/dist) is unaffected.
 */
import { Hono } from "hono";
import { wellKnownRoutes } from "@/api/routes/well-known.ts";
import { requireFeature } from "@/lib/features.ts";

export const mcpWellKnownRouter = new Hono();

for (
  const path of [
    "/oauth-authorization-server",
    "/oauth-authorization-server/*",
    "/oauth-protected-resource",
    "/oauth-protected-resource/*",
  ]
) {
  mcpWellKnownRouter.use(path, requireFeature("mcp"));
}
mcpWellKnownRouter.route("/", wellKnownRoutes);
