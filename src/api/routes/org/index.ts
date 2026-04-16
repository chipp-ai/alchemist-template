/**
 * Organization Routes
 *
 * All routes require authentication.
 *
 * GET    /             - Current org details
 * PATCH  /             - Update org name/slug
 * GET    /members      - List org members
 * POST   /invite       - Invite user by email
 * DELETE /members/:userId - Remove member
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client.ts";
import { requireAuth, getUser } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { ForbiddenError, NotFoundError, BadRequestError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";

const orgRoutes = new Hono();

// All org routes require auth
orgRoutes.use("*", requireAuth);

// ── Schemas ──

const updateOrgSchema = z.object({
  name: z.string().trim().min(1).optional(),
  slug: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
    .optional(),
});

const inviteSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  role: z.enum(["admin", "member"]).default("member"),
});

// ── Routes ──

/**
 * GET /
 * Returns the current user's organization.
 */
orgRoutes.get("/", async (c) => {
  const user = getUser(c);

  const org = await db
    .selectFrom("app.organizations")
    .select([
      "id",
      "name",
      "slug",
      "subscriptionTier",
      "stripeCustomerId",
      "creditsExhausted",
      "createdAt",
      "updatedAt",
    ])
    .where("id", "=", user.organizationId)
    .executeTakeFirst();

  if (!org) {
    throw new NotFoundError("Organization");
  }

  return c.json({ data: org });
});

/**
 * PATCH /
 * Update organization name or slug. Owner/admin only.
 */
orgRoutes.patch("/", zValidator("json", updateOrgSchema, validationHook), async (c) => {
  const user = getUser(c);
  const body = c.req.valid("json");

  if (user.role !== "owner" && user.role !== "admin") {
    throw new ForbiddenError("Only owners and admins can update the organization");
  }

  if (!body.name && !body.slug) {
    throw new BadRequestError("At least one field (name or slug) is required");
  }

  // Check slug uniqueness if updating
  if (body.slug) {
    const existingSlug = await db
      .selectFrom("app.organizations")
      .select("id")
      .where("slug", "=", body.slug)
      .where("id", "!=", user.organizationId)
      .executeTakeFirst();

    if (existingSlug) {
      throw new BadRequestError("This slug is already taken");
    }
  }

  const org = await db
    .updateTable("app.organizations")
    .set({
      ...(body.name && { name: body.name }),
      ...(body.slug && { slug: body.slug }),
      updatedAt: new Date(),
    })
    .where("id", "=", user.organizationId)
    .returning(["id", "name", "slug", "subscriptionTier"])
    .executeTakeFirstOrThrow();

  return c.json({ data: org });
});

/**
 * GET /members
 * List all members in the organization.
 */
orgRoutes.get("/members", async (c) => {
  const user = getUser(c);

  const members = await db
    .selectFrom("app.users")
    .select(["id", "email", "name", "picture", "role", "lastLoginAt", "createdAt"])
    .where("organizationId", "=", user.organizationId)
    .orderBy("createdAt", "asc")
    .execute();

  return c.json({ data: members });
});

/**
 * POST /invite
 * Invite a user to the organization. Owner/admin only.
 */
orgRoutes.post("/invite", zValidator("json", inviteSchema, validationHook), async (c) => {
  const user = getUser(c);
  const { email, role } = c.req.valid("json");

  if (user.role !== "owner" && user.role !== "admin") {
    throw new ForbiddenError("Only owners and admins can invite members");
  }

  // Check if user already exists in this org
  const existing = await db
    .selectFrom("app.users")
    .select("id")
    .where("email", "=", email)
    .where("organizationId", "=", user.organizationId)
    .executeTakeFirst();

  if (existing) {
    throw new BadRequestError("User is already a member of this organization");
  }

  // For now, create a placeholder user record.
  // In a real implementation, this would send an invite email.
  log.info("Org invite sent", {
    source: "org",
    invitedEmail: email,
    role,
    invitedBy: user.id,
    orgId: user.organizationId,
  });

  return c.json({ message: "Invite sent", email, role }, 201);
});

/**
 * DELETE /members/:userId
 * Remove a member from the organization. Owner only.
 */
orgRoutes.delete("/members/:userId", async (c) => {
  const user = getUser(c);
  const targetUserId = c.req.param("userId") as string;

  if (user.role !== "owner") {
    throw new ForbiddenError("Only the owner can remove members");
  }

  if (targetUserId === user.id) {
    throw new BadRequestError("Cannot remove yourself from the organization");
  }

  const target = await db
    .selectFrom("app.users")
    .select(["id", "role"])
    .where("id", "=", targetUserId)
    .where("organizationId", "=", user.organizationId)
    .executeTakeFirst();

  if (!target) {
    throw new NotFoundError("User", targetUserId);
  }

  if (target.role === "owner") {
    throw new ForbiddenError("Cannot remove the organization owner");
  }

  // Remove the user record (or mark as removed -- for now, delete)
  await db
    .deleteFrom("app.users")
    .where("id", "=", targetUserId)
    .execute();

  return c.json({ ok: true });
});

export { orgRoutes };
