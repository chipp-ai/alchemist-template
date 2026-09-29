/**
 * API key management (session-authenticated REST).
 *
 * Keys are how programmatic callers authenticate to this API
 * (`Authorization: Bearer api_sk_...` via requireAuthOrApiKey). Mint here
 * from a browser session; the plaintext is shown ONCE.
 *
 *   GET    /api/api-keys      -- list the caller's keys (metadata only)
 *   POST   /api/api-keys      -- mint; response includes the plaintext ONCE
 *   DELETE /api/api-keys/:id  -- revoke (idempotent)
 *
 * Deliberately session-only (requireAuth, NOT requireAuthOrApiKey): a
 * leaked API key must not be able to mint replacement keys.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getUser, requireAuth } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError } from "@/utils/errors.ts";
import { apiKeyService } from "@/services/api-key.service.ts";

const apiKeyRoutes = new Hono();

const mintSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(255),
});

apiKeyRoutes.get("/", requireAuth, async (c) => {
  const user = getUser(c);
  const keys = await apiKeyService.listForUser(user.id);
  return c.json({ data: { keys } });
});

apiKeyRoutes.post(
  "/",
  requireAuth,
  zValidator("json", mintSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { name } = c.req.valid("json");
    const minted = await apiKeyService.mint({ userId: user.id, name });
    return c.json({
      data: {
        key: minted, // .key is the plaintext -- shown once, never again
        warning: "Store this key now. It cannot be retrieved again.",
      },
    }, 201);
  },
);

apiKeyRoutes.delete("/:id", requireAuth, async (c) => {
  const user = getUser(c);
  const id = c.req.param("id");
  if (!id) throw new BadRequestError("Missing key id");
  await apiKeyService.revoke(id, user.id);
  return c.json({ data: { revoked: true } });
});

export { apiKeyRoutes };
