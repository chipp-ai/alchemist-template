/**
 * The Settings "AI assistants" panel (web/src/components/AssistantConnect.svelte).
 *
 *   GET  /api/assistants        -> 200 { data: { enabled, appName, mcpUrl, chipp } }
 *   POST /api/assistants/chipp  -> 200 { data: { action, token } }
 *
 * `enabled` is true when the MCP feature is on AND it requires sign-in
 * (MCP_AUTH_MODE=oauth). Only then does an assistant run the OAuth flow,
 * so the person reaches the app's tools as themselves. The platform sets
 * both when the builder turns on "Connect to AI assistants".
 *
 * `mcpUrl` is built on the server from the request's own origin
 * (requestBaseUrl), so a custom domain or a proxy gets the right address.
 *
 * `chipp` is true when `enabled` and the app runs on Chipp (the platform
 * injected ALCH_MEMBER_SYNC_SECRET and PROJECT_ID). Then POST /chipp mints a
 * short-lived token the browser form-posts to `action` on Chipp, which
 * connects this app to the person's chief of staff agent
 * (src/services/chipp-assistant-connect.ts). 404 when not available.
 *
 * Any signed-in member may use both, a viewer included: the MCP OAuth
 * consent admits every role, and the read tools work for viewers.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { type AuthUser, requireAuth } from "@/api/middleware/auth.ts";
import { mcpAuthMode } from "@/api/middleware/mcp-auth.ts";
import { requestBaseUrl } from "@/api/routes/well-known.ts";
import { memberSyncConfig } from "@/api/routes/platform/member-sync.ts";
import { BRAND } from "@/config/brand.ts";
import { featureEnabled } from "@/lib/features.ts";
import { chippWebUrl, mintAssistantConnectToken } from "@/services/chipp-assistant-connect.ts";
import { NotFoundError } from "@/utils/errors.ts";

export const assistantsRoutes = new Hono();

function mcpEnabled(): boolean {
  return featureEnabled("mcp") && mcpAuthMode() === "oauth";
}

assistantsRoutes.get("/", requireAuth, (c) => {
  const enabled = mcpEnabled();
  return c.json({
    data: {
      enabled,
      appName: BRAND.name,
      mcpUrl: enabled ? `${requestBaseUrl(c)}/api/mcp` : null,
      chipp: enabled && memberSyncConfig() !== null,
    },
  });
});

assistantsRoutes.post("/chipp", requireAuth, async (c: Context) => {
  const config = memberSyncConfig();
  if (!mcpEnabled() || !config) throw new NotFoundError("Route not found");
  const user = c.get("user") as AuthUser;
  const token = await mintAssistantConnectToken({
    syncSecret: config.secret,
    projectId: config.projectId,
    email: user.email,
    name: user.name ?? null,
    origin: requestBaseUrl(c),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ data: { action: `${chippWebUrl()}/api/assistant-connect`, token } });
});
