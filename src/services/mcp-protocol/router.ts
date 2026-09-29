/**
 * The MCP server feature (ALCHEMIST_FEATURE_MCP), mounted at /api/mcp by
 * the base app.ts. OFF by default: every path below answers 404 until the
 * project turns the feature on (src/lib/features.ts). /api/mcp belongs to
 * this router alone, so the gate covers all of it.
 *
 *   /api/mcp            the MCP endpoint (Streamable HTTP, src/mcp/)
 *   /api/mcp/oauth/*    OAuth 2.1 authorize, token, register (DCR), revoke
 *   /api/mcp/api-keys   mint, list and revoke mcp_sk_ keys (session auth)
 *
 * OAuth discovery (/.well-known/oauth-*) lives in well-known-router.ts:
 * RFC 8414/9728 put it at the origin root, not under /api/mcp.
 */
import { Hono } from "hono";
import { mcpRoutes } from "@/api/routes/mcp/index.ts";
import { mcpOauthRoutes } from "@/api/routes/mcp/oauth.ts";
import { mcpApiKeyRoutes } from "@/api/routes/mcp/api-keys.ts";
import { requireFeature } from "@/lib/features.ts";

export const mcpProtocolRouter = new Hono();

mcpProtocolRouter.use("*", requireFeature("mcp"));
mcpProtocolRouter.route("/oauth", mcpOauthRoutes);
mcpProtocolRouter.route("/api-keys", mcpApiKeyRoutes);
mcpProtocolRouter.route("/", mcpRoutes);
