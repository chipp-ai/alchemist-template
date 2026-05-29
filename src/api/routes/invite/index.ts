/**
 * Invite acceptance routes — public surface for /invite/:token.
 *
 *   GET  /:token              - Preview an invite (no auth required)
 *                               Returns: { organizationName, role, email,
 *                               invitedByName, invitedByEmail, expiresAt }
 *   POST /:token/accept       - Consume the invite. Requires the user
 *                               to already be authenticated; the
 *                               authenticated email must match the
 *                               invite's email.
 *
 * Mounted at `/api/invite` in app.ts (NOT under /api/org — these are
 * accessible without an org binding, since the user might not yet
 * belong to any org when accepting).
 *
 * The signup flow for new users is:
 *   1. Open /#/invite/:token (frontend route) — page loads, calls
 *      GET /api/invite/:token to render org name + role.
 *   2. Page shows "sign in or sign up to accept". User does OTP flow
 *      with the invite's email pre-filled.
 *   3. After verify-otp returns the session, page POSTs
 *      /api/invite/:token/accept. Backend ensures email match,
 *      moves the user into the org at the invited role.
 *
 * For existing users (already signed in), the page detects the auth
 * state and POSTs straight to accept.
 */

import { Hono } from "hono";
import { createSessionToken, getUser, requireAuth } from "@/api/middleware/auth.ts";
import { setSessionCookie } from "@/api/routes/auth/index.ts";
import { ForbiddenError } from "@/utils/errors.ts";
import {
  acceptInvite,
  claimInvite,
  resolveInviteByToken,
} from "@/services/invite.service.ts";
import { log } from "@/lib/logger.ts";

const inviteRoutes = new Hono();

/**
 * POST /:token/claim
 *
 * Passwordless accept — the "magic link" path. PUBLIC (no auth): the
 * invite token IS the credential. Holding it proves control of the
 * invited inbox (it was emailed there), so we create the account if
 * needed AND mint a session right here — no OTP, no sign-in form. This
 * is the one-click flow: click the email link, land authenticated.
 *
 * Must be a POST triggered by the SPA's JS (not a GET), so a passive
 * email-link prefetch can't consume the single-use invite.
 */
inviteRoutes.post("/:token/claim", async (c) => {
  const token = c.req.param("token");
  const result = await claimInvite(token);

  const sessionToken = await createSessionToken({
    id: result.userId,
    email: result.email,
    name: result.name,
    organizationId: result.organizationId,
    role: result.role,
  });
  setSessionCookie(c, sessionToken);

  log.info("Invite claimed (passwordless)", {
    source: "invite",
    feature: "claim",
    userId: result.userId,
    organizationId: result.organizationId,
    role: result.role,
  });

  return c.json({
    user: { id: result.userId, email: result.email, name: result.name },
    organization: { id: result.organizationId },
  });
});

/**
 * GET /:token
 *
 * Public preview. Returns enough info for the landing page to render
 * "Alice (alice@acme.com) invited you to Acme Corp as Editor". Does
 * NOT return the token itself in the response (the URL already has
 * it; echoing is just attack-surface for nothing).
 *
 * 404s on invalid / expired / revoked / already-accepted invites,
 * with intentionally ambiguous error copy ("invite link is invalid
 * or has expired") so an unauthenticated probe can't distinguish
 * "real but used" from "never existed".
 */
inviteRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const invite = await resolveInviteByToken(token);
  return c.json({
    data: {
      organizationName: invite.organizationName,
      role: invite.role,
      email: invite.email,
      invitedByName: invite.invitedByName,
      invitedByEmail: invite.invitedByEmail,
      expiresAt: invite.expiresAt,
    },
  });
});

/**
 * POST /:token/accept
 *
 * Auth-required. The signed-in user's email MUST match the invite's
 * email — see acceptInvite() in the service for the check. On
 * success, returns the new {organizationId, role}.
 *
 * The frontend's organization store should re-fetch after this lands
 * so the UI reflects the new org binding immediately.
 */
inviteRoutes.post("/:token/accept", requireAuth, async (c) => {
  const user = getUser(c);
  const token = c.req.param("token");

  if (!user.email) {
    // Defensive: requireAuth always populates email from JWT, but
    // belt-and-suspenders for the edge case where the token's email
    // claim is somehow empty.
    throw new ForbiddenError("Authenticated session is missing an email.");
  }

  const result = await acceptInvite({
    token,
    userId: user.id,
    authenticatedEmail: user.email,
  });

  log.info("Invite accepted", {
    source: "invite",
    feature: "accept",
    userId: user.id,
    orgId: result.organizationId,
    role: result.role,
  });

  return c.json({ data: result });
});

export { inviteRoutes };
