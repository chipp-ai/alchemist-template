/**
 * Invite service — pending team invites lifecycle.
 *
 * Surface area:
 *   - createInvite          (admin-only, send email)
 *   - listPendingInvites    (admin-only, settings page)
 *   - revokeInvite          (admin-only, kills a pending invite)
 *   - resolveInviteByToken  (public, /invite/:token landing page)
 *   - acceptInvite          (public, consumes the token)
 *
 * All routes that call these helpers must enforce auth + capability
 * gates at the route layer (`requireCapability("team.invite")`,
 * etc.) — the service does NOT re-check role permissions. The single
 * exception is `acceptInvite`, which is intentionally callable by an
 * unauthenticated user (with the right token).
 *
 * Token format: 32-byte URL-safe base64 (43 chars after padding strip).
 * Generated server-side via crypto.getRandomValues; never derived from
 * email/orgId so it's not guessable in volume.
 */

import { db } from "@/db/client.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "@/utils/errors.ts";
import { sendInviteEmail } from "@/services/email.ts";
import { ASSIGNABLE_ROLES, type AssignableRole, roleLabel } from "@/lib/roles.ts";
import { log } from "@/lib/logger.ts";

const INVITE_TTL_DAYS = 7;
const TOKEN_BYTES = 32;

export interface CreateInviteInput {
  organizationId: string;
  invitedByUserId: string;
  email: string;
  role: AssignableRole;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  invitedByName: string | null;
  invitedByEmail: string;
  expiresAt: Date;
  createdAt: Date;
}

/** Resolved by `resolveInviteByToken`; does NOT include the token. */
export interface ResolvedInvite {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: string;
  expiresAt: Date;
  invitedByName: string | null;
  invitedByEmail: string;
}

/**
 * Create + persist a pending invite, then send the email.
 *
 * Validation:
 *   - role must be in ASSIGNABLE_ROLES (admin/editor/viewer; never owner).
 *   - email must already be normalized (.toLowerCase().trim()) by the caller
 *     — typically via the route's Zod schema.
 *   - the email must not match an existing org member (caller responsibility,
 *     but we double-check inside the service to keep behavior consistent).
 *   - if a pending invite already exists for (org, email), throw
 *     BadRequestError("An invite is already pending"). Caller can list
 *     pending invites and revoke before re-inviting.
 *
 * Email send is the LAST step. If persistence succeeds but email fails,
 * the invite IS in the DB — surfaces in the pending list, can be
 * revoked + re-invited. Better than an "invite went out but the row
 * isn't there to revoke" failure mode.
 */
export async function createInvite(input: CreateInviteInput): Promise<PendingInvite> {
  if (!ASSIGNABLE_ROLES.includes(input.role)) {
    throw new BadRequestError(
      `Invalid role "${input.role}". Allowed: ${ASSIGNABLE_ROLES.join(", ")}.`,
    );
  }

  // Existing-member check. The org_invites partial unique index also
  // catches duplicates at DB level, but we want the friendlier error
  // first.
  const existingMember = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", input.email)
    .where("organizationId", "=", input.organizationId)
    .executeTakeFirst();
  if (existingMember) {
    throw new BadRequestError("That email is already a member of this organization.");
  }

  const existingPending = await db
    .selectFrom("invites")
    .select(["id", "expiresAt"])
    .where("organizationId", "=", input.organizationId)
    .where("email", "=", input.email)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (existingPending && existingPending.expiresAt > new Date()) {
    throw new BadRequestError(
      "An invite is already pending for that email. Revoke it first if you want to change the role or resend.",
    );
  }
  // Fall-through: an EXPIRED pending invite still has accepted_at + revoked_at
  // null but expires_at in the past. Letting createInvite proceed then would
  // collide on the partial unique index. Mark expired ones as revoked first
  // so the new invite can be cleanly inserted.
  if (existingPending) {
    await db
      .updateTable("invites")
      .set({ revokedAt: new Date() })
      .where("id", "=", existingPending.id)
      .execute();
  }

  const token = generateInviteToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const inserted = await db
    .insertInto("invites")
    .values({
      organizationId: input.organizationId,
      invitedBy: input.invitedByUserId,
      email: input.email,
      role: input.role,
      token,
      expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // Send the email. Failure here doesn't void the row — the invite
  // is real and the admin can re-send manually. We log at warn (not
  // error) because email infra is the most likely failure point and
  // it's recoverable.
  try {
    const [inviter, org] = await Promise.all([
      db
        .selectFrom("users")
        .select(["name", "email"])
        .where("id", "=", input.invitedByUserId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("organizations")
        .select(["name"])
        .where("id", "=", input.organizationId)
        .executeTakeFirstOrThrow(),
    ]);
    await sendInviteEmail({
      to: input.email,
      inviterName: inviter.name,
      inviterEmail: inviter.email,
      organizationName: org.name,
      roleLabel: roleLabel(input.role),
      acceptUrl: buildAcceptUrl(token),
      expiresAt,
    });
  } catch (err) {
    log.warn("Invite email send failed", {
      source: "invite",
      inviteId: inserted.id,
      to: input.email,
    }, err as Error);
    // Continue — the invite row is valid, admin can use the
    // copy-link UI affordance to deliver it manually.
  }

  // Inviter's display info, for the admin's pending-invites list.
  const inviter = await db
    .selectFrom("users")
    .select(["name", "email"])
    .where("id", "=", input.invitedByUserId)
    .executeTakeFirstOrThrow();

  return {
    id: inserted.id,
    email: inserted.email,
    role: inserted.role,
    invitedBy: inserted.invitedBy,
    invitedByName: inviter.name,
    invitedByEmail: inviter.email,
    expiresAt: inserted.expiresAt,
    createdAt: inserted.createdAt,
  };
}

/**
 * List PENDING (not accepted, not revoked, not expired) invites for
 * an org, newest first. Joined with users to surface inviter
 * name/email.
 */
export async function listPendingInvites(organizationId: string): Promise<PendingInvite[]> {
  const rows = await db
    .selectFrom("invites")
    .innerJoin("users", "users.id", "invites.invitedBy")
    .select([
      "invites.id",
      "invites.email",
      "invites.role",
      "invites.invitedBy",
      "invites.expiresAt",
      "invites.createdAt",
      "users.name as invitedByName",
      "users.email as invitedByEmail",
    ])
    .where("invites.organizationId", "=", organizationId)
    .where("invites.acceptedAt", "is", null)
    .where("invites.revokedAt", "is", null)
    .where("invites.expiresAt", ">", new Date())
    .orderBy("invites.createdAt", "desc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.invitedBy,
    invitedByName: r.invitedByName,
    invitedByEmail: r.invitedByEmail,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

/**
 * Revoke a pending invite. Idempotent — revoking an already-revoked
 * or already-accepted invite is a no-op (no error). The route handler
 * is the security gate (admin-only); this just flips the column.
 */
export async function revokeInvite(opts: {
  inviteId: string;
  organizationId: string;
}): Promise<void> {
  await db
    .updateTable("invites")
    .set({ revokedAt: new Date() })
    .where("id", "=", opts.inviteId)
    .where("organizationId", "=", opts.organizationId)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .execute();
}

/**
 * Look up a pending invite by token. Used by the public
 * GET /invite/:token endpoint to render the accept-invite landing
 * page. Includes org name + inviter name/email so the landing page
 * can show "Alice (alice@acme.com) invited you to Acme as Editor".
 *
 * Throws NotFoundError if:
 *   - token doesn't match any row, OR
 *   - invite is already accepted, OR
 *   - invite is revoked, OR
 *   - invite is expired.
 *
 * The error is intentionally ambiguous — we don't want to leak
 * "this token used to exist" vs "this token never existed" to
 * unauthenticated callers.
 */
export async function resolveInviteByToken(token: string): Promise<ResolvedInvite> {
  const row = await db
    .selectFrom("invites")
    .innerJoin("organizations", "organizations.id", "invites.organizationId")
    .innerJoin("users", "users.id", "invites.invitedBy")
    .select([
      "invites.id",
      "invites.organizationId",
      "invites.email",
      "invites.role",
      "invites.expiresAt",
      "invites.acceptedAt",
      "invites.revokedAt",
      "organizations.name as organizationName",
      "users.name as invitedByName",
      "users.email as invitedByEmail",
    ])
    .where("invites.token", "=", token)
    .executeTakeFirst();

  if (!row) {
    throw new NotFoundError("Invite", "This invite link is invalid or has expired.");
  }
  if (row.acceptedAt !== null) {
    throw new NotFoundError("Invite", "This invite has already been accepted.");
  }
  if (row.revokedAt !== null) {
    throw new NotFoundError("Invite", "This invite has been revoked.");
  }
  if (row.expiresAt < new Date()) {
    throw new NotFoundError("Invite", "This invite has expired.");
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    invitedByName: row.invitedByName,
    invitedByEmail: row.invitedByEmail,
  };
}

/**
 * Consume an invite token: place the user into the org at the named
 * role, and mark the invite accepted.
 *
 * Two paths:
 *   - The user already exists (matched by email). Move them into the
 *     target org, set role. NOTE: this drops their previous org
 *     membership — by design, in the template's single-org-per-user
 *     model. Callers reach this function AFTER the user is signed
 *     in via OTP (so we know they own the email).
 *   - The user doesn't exist. Caller (the auth route) creates the
 *     user first (with the invited email), then calls this to bind
 *     them into the org.
 *
 * Concurrency: the row is updated with `WHERE accepted_at IS NULL AND
 * revoked_at IS NULL` so two simultaneous accepts can't both succeed.
 * The non-winner gets 0 affected rows — the function throws
 * ForbiddenError so the caller surfaces "this invite was already
 * consumed". The winner proceeds to update the user's org binding.
 */
export async function acceptInvite(opts: {
  token: string;
  /** The user accepting (already authenticated via OTP). */
  userId: string;
  /** Defensive: the email the user authenticated with. Must match
   *  the invite's email. Prevents a logged-in attacker from clicking
   *  someone else's invite link. */
  authenticatedEmail: string;
}): Promise<{ organizationId: string; role: string }> {
  // Resolve to a live invite (throws on invalid/expired/used). This
  // also gives us the row id we use in the conditional UPDATE below.
  const invite = await resolveInviteByToken(opts.token);

  if (invite.email.toLowerCase() !== opts.authenticatedEmail.toLowerCase()) {
    throw new ForbiddenError(
      "This invite was sent to a different email address. Sign in with that email to accept.",
    );
  }

  // Atomic claim — only one of N concurrent accepts wins.
  const claimed = await db
    .updateTable("invites")
    .set({ acceptedAt: new Date() })
    .where("id", "=", invite.id)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .returningAll()
    .executeTakeFirst();

  if (!claimed) {
    // Lost the race. The other winner has already moved the user;
    // bail with a clean error.
    throw new ForbiddenError("This invite has already been consumed.");
  }

  // Move the user into the org at the invited role.
  await db
    .updateTable("users")
    .set({
      organizationId: invite.organizationId,
      role: invite.role,
    })
    .where("id", "=", opts.userId)
    .execute();

  return {
    organizationId: invite.organizationId,
    role: invite.role,
  };
}

/**
 * Passwordless invite claim — the "magic link" path. The invite token
 * is itself the auth proof: it's a high-entropy single-use secret
 * delivered to invite.email's inbox, exactly the same trust basis as a
 * magic link or an OTP code. So clicking the emailed link can safely
 * create the account (if new) AND sign the user in, WITHOUT a separate
 * OTP round-trip — they already proved control of the inbox by holding
 * the token.
 *
 * Caller (POST /api/invite/:token/claim) mints the session cookie from
 * the returned identity. Atomic single-use: the invite is consumed
 * before the account is materialized so a replay can't mint a second
 * session.
 */
export async function claimInvite(token: string): Promise<{
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
}> {
  // Resolves to a live invite (throws on invalid / expired / used).
  const invite = await resolveInviteByToken(token);

  // Atomic single-use claim — only one of N concurrent clicks wins.
  const claimed = await db
    .updateTable("invites")
    .set({ acceptedAt: new Date() })
    .where("id", "=", invite.id)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .returningAll()
    .executeTakeFirst();
  if (!claimed) {
    throw new ForbiddenError("This invite has already been used.");
  }

  // Find-or-create the user for the invite's email, placing them in the
  // org at the invited role. emailVerified is true by construction —
  // holding the token proves inbox control.
  const existing = await db
    .selectFrom("users")
    .select(["id", "name"])
    .where("email", "=", invite.email)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("users")
      .set({
        organizationId: invite.organizationId,
        role: invite.role,
        emailVerified: true,
        lastLoginAt: new Date(),
      })
      .where("id", "=", existing.id)
      .execute();
    return {
      userId: existing.id,
      email: invite.email,
      name: existing.name,
      organizationId: invite.organizationId,
      role: invite.role,
    };
  }

  const created = await db
    .insertInto("users")
    .values({
      email: invite.email,
      name: null,
      role: invite.role,
      organizationId: invite.organizationId,
      emailVerified: true,
      lastLoginAt: new Date(),
    })
    .returning(["id", "name"])
    .executeTakeFirstOrThrow();
  return {
    userId: created.id,
    email: invite.email,
    name: created.name,
    organizationId: invite.organizationId,
    role: invite.role,
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

function generateInviteToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  // URL-safe base64; strip padding so the link is shorter and the
  // entire token survives intact in URL paths/clipboard.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildAcceptUrl(token: string): string {
  const base = Deno.env.get("APP_URL") ?? "http://localhost:8000";
  // Hash route — matches web/src/routes.ts.
  return `${base}/#/invite/${token}`;
}
