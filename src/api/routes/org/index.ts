/**
 * Organization Routes
 *
 * Team management — invites, member listing, role transitions, removal.
 *
 *   GET    /                       - Current org details
 *   PATCH  /                       - Update org name/slug          (admin+)
 *   GET    /members                - List org members              (any auth)
 *   GET    /invites                - List pending invites          (admin+)
 *   POST   /invites                - Send invite by email          (admin+)
 *   DELETE /invites/:id            - Revoke pending invite         (admin+)
 *   PATCH  /members/:userId/role   - Change member's role          (admin+)
 *   DELETE /members/:userId        - Remove member from org        (admin+)
 *   POST   /transfer-ownership     - Hand owner role to a member   (owner only)
 *   POST   /leave                  - Self-removal from org         (any auth, non-owner)
 *
 * Permissions go through `requireCapability` from the auth middleware,
 * which keys off the role hierarchy in `src/lib/roles.ts`. The route
 * file enforces the role-vs-role rules (admin can't manage another
 * admin, can't remove the owner, can't self-remove) via the
 * `canManage` helper from the same hierarchy module.
 *
 * IMPORTANT: DELETE /members/:userId previously hard-DELETED the user
 * row. That took sessions, oauth bindings, and any FK'd domain data
 * with it. The new behavior is SOFT-DISCONNECT — set
 * users.organization_id = NULL and role = 'viewer'. The user keeps
 * their account and can be re-invited; their email and name persist.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { deleteCookie } from "hono/cookie";
import { db } from "@/db/client.ts";
import { getUser, requireAuth, requireCapability } from "@/api/middleware/auth.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/utils/errors.ts";
import { ASSIGNABLE_ROLES, canManage } from "@/lib/roles.ts";
import { createInvite, listPendingInvites, revokeInvite } from "@/services/invite.service.ts";
import { log } from "@/lib/logger.ts";

const orgRoutes = new Hono();

// All org routes require auth.
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
  // Default to editor (the most common case). owner is intentionally
  // not in ASSIGNABLE_ROLES — invites can never confer ownership.
  role: z.enum(ASSIGNABLE_ROLES).default("editor"),
});

const updateRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});

const transferOwnershipSchema = z.object({
  userId: z.string().uuid(),
});

// ── GET / ─────────────────────────────────────────────────────────────────

orgRoutes.get("/", async (c) => {
  const user = getUser(c);

  const org = await db
    .selectFrom("organizations")
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

// ── PATCH / ───────────────────────────────────────────────────────────────

orgRoutes.patch(
  "/",
  requireCapability("org.update"),
  zValidator("json", updateOrgSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const body = c.req.valid("json");

    if (!body.name && !body.slug) {
      throw new BadRequestError("At least one field (name or slug) is required");
    }

    if (body.slug) {
      const existingSlug = await db
        .selectFrom("organizations")
        .select("id")
        .where("slug", "=", body.slug)
        .where("id", "!=", user.organizationId)
        .executeTakeFirst();
      if (existingSlug) {
        throw new BadRequestError("This slug is already taken");
      }
    }

    const org = await db
      .updateTable("organizations")
      .set({
        ...(body.name && { name: body.name }),
        ...(body.slug && { slug: body.slug }),
        updatedAt: new Date(),
      })
      .where("id", "=", user.organizationId)
      .returning(["id", "name", "slug", "subscriptionTier"])
      .executeTakeFirstOrThrow();

    return c.json({ data: org });
  },
);

// ── GET /members ──────────────────────────────────────────────────────────

orgRoutes.get("/members", async (c) => {
  const user = getUser(c);

  const members = await db
    .selectFrom("users")
    .select(["id", "email", "name", "picture", "role", "lastLoginAt", "createdAt"])
    .where("organizationId", "=", user.organizationId)
    .orderBy("createdAt", "asc")
    .execute();

  return c.json({ data: members });
});

// ── GET /invites ──────────────────────────────────────────────────────────

orgRoutes.get(
  "/invites",
  requireCapability("team.invite"),
  async (c) => {
    const user = getUser(c);
    const invites = await listPendingInvites(user.organizationId);
    return c.json({ data: invites });
  },
);

// ── POST /invites ─────────────────────────────────────────────────────────

orgRoutes.post(
  "/invites",
  requireCapability("team.invite"),
  zValidator("json", inviteSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { email, role } = c.req.valid("json");

    const invite = await createInvite({
      organizationId: user.organizationId,
      invitedByUserId: user.id,
      email,
      role,
    });

    log.info("Org invite sent", {
      source: "org",
      feature: "invite",
      orgId: user.organizationId,
      invitedBy: user.id,
      to: email,
      role,
    });

    return c.json({ data: invite }, 201);
  },
);

// ── DELETE /invites/:id ───────────────────────────────────────────────────

orgRoutes.delete(
  "/invites/:id",
  requireCapability("team.invite"),
  async (c) => {
    const user = getUser(c);
    const inviteId = c.req.param("id") as string;

    await revokeInvite({ inviteId, organizationId: user.organizationId });

    log.info("Org invite revoked", {
      source: "org",
      feature: "invite",
      orgId: user.organizationId,
      revokedBy: user.id,
      inviteId,
    });

    return c.json({ ok: true });
  },
);

// ── PATCH /members/:userId/role ───────────────────────────────────────────

orgRoutes.patch(
  "/members/:userId/role",
  requireCapability("team.update_role"),
  zValidator("json", updateRoleSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const targetUserId = c.req.param("userId") as string;
    const { role } = c.req.valid("json");

    if (targetUserId === user.id) {
      throw new BadRequestError(
        "You cannot change your own role. Ask another admin or the owner.",
      );
    }

    const target = await db
      .selectFrom("users")
      .select(["id", "role"])
      .where("id", "=", targetUserId)
      .where("organizationId", "=", user.organizationId)
      .executeTakeFirst();
    if (!target) {
      throw new NotFoundError("User", targetUserId);
    }

    if (!canManage(user.role, target.role)) {
      throw new ForbiddenError(
        target.role === "owner"
          ? "Cannot change the role of the organization owner."
          : "Only the owner can change another admin's role.",
      );
    }

    const updated = await db
      .updateTable("users")
      .set({ role, updatedAt: new Date() })
      .where("id", "=", targetUserId)
      .returning(["id", "email", "name", "role"])
      .executeTakeFirstOrThrow();

    log.info("Org member role changed", {
      source: "org",
      feature: "role-change",
      orgId: user.organizationId,
      changedBy: user.id,
      targetUserId,
      from: target.role,
      to: role,
    });

    return c.json({ data: updated });
  },
);

// ── DELETE /members/:userId ───────────────────────────────────────────────

orgRoutes.delete(
  "/members/:userId",
  requireCapability("team.remove"),
  async (c) => {
    const user = getUser(c);
    const targetUserId = c.req.param("userId") as string;

    if (targetUserId === user.id) {
      throw new BadRequestError("Cannot remove yourself from the organization");
    }

    const target = await db
      .selectFrom("users")
      .select(["id", "role"])
      .where("id", "=", targetUserId)
      .where("organizationId", "=", user.organizationId)
      .executeTakeFirst();
    if (!target) {
      throw new NotFoundError("User", targetUserId);
    }

    if (!canManage(user.role, target.role)) {
      throw new ForbiddenError(
        target.role === "owner"
          ? "Cannot remove the organization owner."
          : "Only the owner can remove another admin.",
      );
    }

    // SOFT-DISCONNECT, not hard-delete. The user row stays — sessions,
    // oauth bindings, audit history all persist. Clearing organizationId
    // detaches them; resetting role to 'viewer' so the column isn't
    // misleading if they ever re-join. Re-inviting them lands cleanly via
    // the same flow as an invite to a never-seen-before email.
    await db
      .updateTable("users")
      .set({
        organizationId: null,
        role: "viewer",
        updatedAt: new Date(),
      })
      .where("id", "=", targetUserId)
      .execute();

    log.info("Org member removed (soft-disconnected)", {
      source: "org",
      feature: "remove",
      orgId: user.organizationId,
      removedBy: user.id,
      targetUserId,
    });

    return c.json({ ok: true });
  },
);

// ── POST /transfer-ownership ──────────────────────────────────────────────
// The one deliberate way the owner role moves between accounts. The
// current owner names a successor (any existing member); in ONE
// transaction the successor becomes 'owner' and the caller drops to
// 'admin'. Auth middleware re-reads the role from the DB on every
// request, so both sides see their new powers immediately with no
// token re-issue.
//
// This is the escape hatch for every "owner is a dead end" case:
//   - remove an owner:        transfer first, then DELETE /members/:userId
//   - owner leaving the org:  transfer first, then POST /leave
//   - owner changing emails:  invite the new address, transfer to it
//
// Guards:
//   - owner only (org.transfer_ownership is the sole owner-gated capability)
//   - target must be an active member of the SAME org
//   - self-transfer is a no-op request shape, rejected as 400
//   - the caller's demotion UPDATE is predicated on role = 'owner' so a
//     concurrent transfer can't demote an already-demoted account (409)

orgRoutes.post(
  "/transfer-ownership",
  requireCapability("org.transfer_ownership"),
  zValidator("json", transferOwnershipSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const { userId: targetUserId } = c.req.valid("json");

    if (targetUserId === user.id) {
      throw new BadRequestError("You are already the owner.");
    }

    const target = await db
      .selectFrom("users")
      .select(["id", "email", "role"])
      .where("id", "=", targetUserId)
      .where("organizationId", "=", user.organizationId)
      .executeTakeFirst();
    if (!target) {
      throw new NotFoundError("User", targetUserId);
    }

    await db.transaction().execute(async (trx) => {
      // Demote the caller FIRST, predicated on still being the owner.
      // If a concurrent transfer already demoted them, zero rows match
      // and the whole transaction rolls back instead of minting a
      // second owner.
      const demoted = await trx
        .updateTable("users")
        .set({ role: "admin", updatedAt: new Date() })
        .where("id", "=", user.id)
        .where("role", "=", "owner")
        .returning(["id"])
        .executeTakeFirst();
      if (!demoted) {
        throw new ConflictError(
          "Ownership changed while this request was in flight. Reload and try again.",
        );
      }

      await trx
        .updateTable("users")
        .set({ role: "owner", updatedAt: new Date() })
        .where("id", "=", targetUserId)
        .where("organizationId", "=", user.organizationId)
        .execute();
    });

    log.info("Org ownership transferred", {
      source: "org",
      feature: "transfer-ownership",
      orgId: user.organizationId,
      fromUserId: user.id,
      toUserId: targetUserId,
      targetPreviousRole: target.role,
    });

    return c.json({
      data: { newOwnerId: targetUserId, previousOwnerId: user.id },
    });
  },
);

// ── POST /leave ───────────────────────────────────────────────────────────
// Self-removal. Owner is blocked: they must hand off the org first via
// POST /transfer-ownership (above), then leave as a regular admin.
// Non-owners get the same soft-disconnect as
// DELETE /members/:userId, plus the session cookie is cleared so
// the SPA flips to the login screen on the next /me call.

const SESSION_COOKIE = "session_id";

orgRoutes.post("/leave", requireAuth, async (c) => {
  const user = getUser(c);

  if (user.role === "owner") {
    throw new ForbiddenError(
      "The organization owner can't leave. Transfer ownership or delete the organization first.",
    );
  }

  await db
    .updateTable("users")
    .set({
      organizationId: null,
      role: "viewer",
      updatedAt: new Date(),
    })
    .where("id", "=", user.id)
    .execute();

  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  log.info("Org member self-left (soft-disconnected)", {
    source: "org",
    feature: "leave",
    orgId: user.organizationId,
    userId: user.id,
  });

  return c.json({ ok: true });
});

export { orgRoutes };
