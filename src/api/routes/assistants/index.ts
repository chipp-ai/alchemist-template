/**
 * GET /api/assistants: what the "Use with Claude / ChatGPT / Grok" panel in
 * Settings needs (web/src/components/AssistantConnect.svelte).
 *
 *   -> 200 { data: { enabled, appName, mcpUrl } }
 *
 * `enabled` is true when the MCP feature is on AND it requires sign-in
 * (MCP_AUTH_MODE=oauth). Only then does an assistant run the OAuth flow,
 * so the person reaches the app's tools as themselves. The platform sets
 * both when the builder turns on "Connect to AI assistants".
 *
 * `mcpUrl` is built on the server from the request's own origin
 * (requestBaseUrl), so a custom domain or a proxy gets the right address.
 *
 * Any signed-in member may read it, a viewer included: the MCP OAuth
 * consent admits every role, and the read tools work for viewers.
 */

import { Hono } from "hono";
import { requireAuth } from "@/api/middleware/auth.ts";
import { mcpAuthMode } from "@/api/middleware/mcp-auth.ts";
import { requestBaseUrl } from "@/api/routes/well-known.ts";
import { BRAND } from "@/config/brand.ts";
import { featureEnabled } from "@/lib/features.ts";

export const assistantsRoutes = new Hono();

assistantsRoutes.get("/", requireAuth, (c) => {
  const enabled = featureEnabled("mcp") && mcpAuthMode() === "oauth";
  return c.json({
    data: {
      enabled,
      appName: BRAND.name,
      mcpUrl: enabled ? `${requestBaseUrl(c)}/api/mcp` : null,
    },
  });
});
