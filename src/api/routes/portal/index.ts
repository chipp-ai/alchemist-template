/**
 * Portal routes -- the END-USER lane.
 *
 *   POST   /api/portal/claim            - exchange a link for a session  (PUBLIC)
 *   GET    /api/portal/me               - the caller's own bindings      (any auth)
 *   GET    /api/portal/tokens           - list issued links              (admin)
 *   POST   /api/portal/tokens           - issue + email a link           (admin)
 *   POST   /api/portal/tokens/:id/resend- issue a fresh link, retire old (admin)
 *   DELETE /api/portal/tokens/:id       - revoke a link                  (admin)
 *
 * Mounted at `/api/portal`, NOT under `/api/org`: a portal user is not
 * an org member in the team sense, and the claim endpoint runs before any
 * session exists.
 *
 * Admins are invite-only, through src/services/invite.service.ts. End
 * users NEVER go through the invite flow. If you find yourself sending an
 * invite to a customer, an employee, or a client so they can "just look at
 * their own record", issue a portal link instead.
 *
 * The admin gate is `team.invite` (admin and owner): handing someone
 * access to a record is the same class of decision as adding a member.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createSessionToken,
  getUser,
  requireAuth,
  requireCapability,
} from "@/api/middleware/auth.ts";
import { setSessionCookie } from "@/api/routes/auth/index.ts";
import { validationHook } from "@/utils/zod-validation-hook.ts";
import { log } from "@/lib/logger.ts";
import {
  claimPortalAccess,
  issuePortalAccess,
  listPortalAccess,
  listPortalAccessForUser,
  resendPortalAccess,
  revokePortalAccess,
} from "@/services/portal-access.service.ts";

const portalRoutes = new Hono();

// ── POST /claim ───────────────────────────────────────────────────────────
//
// PUBLIC. The token IS the credential: it is a 32-byte secret delivered to
// an inbox an admin chose, which is the same trust basis as the invite
// magic link. So claiming it mints a session with no OTP round-trip.
//
// POST, never GET, so an email client's passive link prefetch cannot sign
// anyone in (and so the claim cannot be triggered cross-site by an <img>).

const claimSchema = z.object({ token: z.string().trim().min(1) });

portalRoutes.post(
  "/claim",
  zValidator("json", claimSchema, validationHook),
  async (c) => {
    const { token } = c.req.valid("json");
    const claimed = await claimPortalAccess(token);

    const sessionToken = await createSessionToken({
      id: claimed.userId,
      email: claimed.email,
      name: claimed.name,
      organizationId: claimed.organizationId,
      role: claimed.role,
    });
    setSessionCookie(c, sessionToken);

    log.info("Portal link claimed", {
      source: "portal",
      feature: "claim",
      userId: claimed.userId,
      organizationId: claimed.organizationId,
    });

    return c.json({
      data: {
        user: { id: claimed.userId, email: claimed.email, name: claimed.name },
        organization: { id: claimed.organizationId },
        subject: {
          type: claimed.access.subjectType,
          id: claimed.access.subjectId,
        },
      },
    });
  },
);

// ── GET /me ───────────────────────────────────────────────────────────────
//
// The portal shell's ONLY data source: the caller's own live bindings.
// Scoped by userId, so a portal user can never read another person's
// record by changing a query parameter.

portalRoutes.get("/me", requireAuth, async (c) => {
  const user = getUser(c);
  const access = await listPortalAccessForUser(user.id);
  return c.json({
    data: {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      subjects: access.map((a) => ({
        id: a.id,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        lastUsedAt: a.lastUsedAt,
      })),
    },
  });
});

// ── Admin surface ─────────────────────────────────────────────────────────

const issueSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  subjectType: z.string().trim().min(1),
  subjectId: z.string().trim().min(1),
  subjectLabel: z.string().trim().min(1).nullish(),
  /** Omit for a link that never expires, which is the normal case. */
  expiresInDays: z.number().int().positive().max(3650).nullish(),
  /** Set false to mint without emailing, when an admin will hand it over. */
  sendEmail: z.boolean().optional(),
});

portalRoutes.post(
  "/tokens",
  requireAuth,
  requireCapability("team.invite"),
  zValidator("json", issueSchema, validationHook),
  async (c) => {
    const user = getUser(c);
    const body = c.req.valid("json");

    const issued = await issuePortalAccess({
      organizationId: user.organizationId,
      email: body.email,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      subjectLabel: body.subjectLabel ?? null,
      expiresInDays: body.expiresInDays ?? null,
      createdByUserId: user.id,
      sendEmail: body.sendEmail,
    });

    // The URL is returned ONCE. Only a hash is stored, so this response is
    // the single opportunity to copy the link; after it, re-sending issues
    // a fresh one.
    return c.json({
      data: {
        access: issued.access,
        url: issued.url,
        replacedPrevious: issued.replacedPrevious,
        provisionedUser: issued.provisionedUser,
      },
    }, 201);
  },
);

portalRoutes.get(
  "/tokens",
  requireAuth,
  requireCapability("team.invite"),
  async (c) => {
    const user = getUser(c);
    const access = await listPortalAccess({
      organizationId: user.organizationId,
      subjectType: c.req.query("subjectType") || undefined,
      subjectId: c.req.query("subjectId") || undefined,
      includeInactive: c.req.query("includeInactive") === "true",
    });
    return c.json({ data: access });
  },
);

// No zValidator here on purpose: a re-send carries no required input, and
// a "resend" button that 400s because the client sent an empty body would
// be a silly failure. The one optional field rides the query string.
portalRoutes.post(
  "/tokens/:id/resend",
  requireAuth,
  requireCapability("team.invite"),
  async (c) => {
    const user = getUser(c);

    const issued = await resendPortalAccess({
      accessId: c.req.param("id"),
      // Org scope lives in the service's WHERE clause too; passing it is
      // not the check, it IS the scope.
      organizationId: user.organizationId,
      subjectLabel: c.req.query("subjectLabel") || null,
      requestedByUserId: user.id,
    });

    return c.json({
      data: { access: issued.access, url: issued.url, replacedPrevious: true },
    });
  },
);

portalRoutes.delete(
  "/tokens/:id",
  requireAuth,
  requireCapability("team.invite"),
  async (c) => {
    const user = getUser(c);
    await revokePortalAccess({
      accessId: c.req.param("id"),
      organizationId: user.organizationId,
    });
    // Idempotent by design: revoking twice is not an error.
    return c.json({ data: { revoked: true } });
  },
);

export { portalRoutes };
