/**
 * MCP API key management (session-authenticated REST).
 *
 * Keys are the SECONDARY auth method for /api/mcp (OAuth is primary -- see
 * docs/mcp-server.md § Authentication). Mint here, paste into headless
 * clients as `Authorization: Bearer mcp_sk_...`.
 *
 *   GET    /api/mcp/api-keys      -- list the caller's mcp_sk_ keys (metadata only)
 *   POST   /api/mcp/api-keys      -- mint; response includes the plaintext ONCE
 *   DELETE /api/mcp/api-keys/:id  -- revoke (idempotent)
 *
 * Mounted by src/services/mcp-protocol/router.ts, so it 404s unless the MCP
 * feature is on (ALCHEMIST_FEATURE_MCP). The API feature has its own key
 * route at /api/api-keys (api_sk_ keys); both use the api_credentials table,
 * and each lists and revokes only its own prefix.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getUser, requireAuth } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError } from "@/utils/errors.ts";
import { mcpApiKeyService } from "@/services/mcp-oauth/api-key.service.ts";
import { ALL_MCP_SCOPES } from "@/services/mcp-oauth/permissions.ts";

const mcpApiKeyRoutes = new Hono();

const mintSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(255),
  scopes: z.array(z.enum(ALL_MCP_SCOPES)).optional(),
});

mcpApiKeyRoutes.get("/", requireAuth, async (c) => {
  const user = getUser(c);
  const keys = await mcpApiKeyService.listForUser(user.id);
  return c.json({ data: { keys } });
});

mcpApiKeyRoutes.post(
  "/",
  requireAuth,
  zValidator("json", mintSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { name, scopes } = c.req.valid("json");
    const minted = await mcpApiKeyService.mint({ userId: user.id, name, scopes });
    return c.json({
      data: {
        key: minted, // .key is the plaintext -- shown once, never again
        warning: "Store this key now. It cannot be retrieved again.",
      },
    }, 201);
  },
);

mcpApiKeyRoutes.delete("/:id", requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param("id");
  if (!id) throw new BadRequestError("Missing key id");
  await mcpApiKeyService.revoke(id, user.id);
  return c.json({ data: { revoked: true } });
});

export { mcpApiKeyRoutes };
