/**
 * Portal access -- the END-USER lane.
 *
 * Two audiences, two doors, and mixing them is the mistake this module
 * exists to prevent:
 *
 *   ADMINS      arrive through src/services/invite.service.ts. Invite-only,
 *               role-bearing, they belong to the workspace.
 *   END USERS   never touch the invite flow. An employee checking their own
 *               certifications, a client watching one project: they get a
 *               long-lived tokenized link, bound to ONE record and ONE
 *               address, that signs them into a read-only portal.
 *
 * Do not build a second portal, a second login, or a second session
 * mechanism. This lane reuses the app's own sessions and its `viewer`
 * role; it adds only the token and the record binding.
 *
 * Trust basis: the token is a 32-byte secret delivered to an inbox the
 * issuer chose. Holding it proves control of that inbox, exactly like the
 * invite magic link (`claimInvite`). So claiming it may mint a session
 * with no OTP round-trip.
 *
 * What is stored is a SHA-256 of the token, never the token. A re-send
 * therefore cannot resurrect the same URL: it ISSUES A FRESH LINK and
 * revokes the previous one. That is the safer default, because it retires
 * a link that may have been forwarded, and it makes revocation real.
 *
 * Every query here is org-scoped in its WHERE clause. The route layer's
 * gate is not the authorization check (CWE-639).
 */

import { db } from "@/db/client.ts";
import { ForbiddenError, NotFoundError } from "@/utils/errors.ts";
import { log } from "@/lib/logger.ts";
import { sendEmailKind } from "@/services/email-kinds.ts";

const LOG_SOURCE = "portal-access";
const TOKEN_BYTES = 32;

/** The role an auto-provisioned portal account gets. Read-only, deliberately. */
export const PORTAL_ROLE = "viewer";

export interface PortalAccess {
  id: string;
  organizationId: string;
  userId: string;
  email: string;
  subjectType: string;
  subjectId: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastSentAt: Date | null;
  lastUsedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface IssuePortalAccessInput {
  organizationId: string;
  /** Recipient. Normalized to lowercase before anything else happens. */
  email: string;
  subjectType: string;
  subjectId: string;
  /** Human label for the record, used in the email copy. */
  subjectLabel?: string | null;
  createdByUserId?: string | null;
  /** Omit for a link that never expires (the normal case). */
  expiresInDays?: number | null;
  /** Set false to mint a link without emailing it (an admin copies it). */
  sendEmail?: boolean;
}

export interface IssuedPortalAccess {
  access: PortalAccess;
  /** The full link. Returned ONCE at mint; never recoverable afterwards. */
  url: string;
  /** The raw token. Same caveat. */
  token: string;
  /** True when a previous live link for this record was retired. */
  replacedPrevious: boolean;
  /** Whether a new viewer account was created for this address. */
  provisionedUser: boolean;
}

// ── Mint ───────────────────────────────────────────────────────────────────

/**
 * Issue a portal link for one record, auto-provisioning the account it
 * signs in as.
 *
 * Account resolution, and the rule that matters: find-or-create BY EMAIL,
 * and NEVER modify an account that already exists. An admin who is also an
 * employee keeps their admin role and their org; they simply gain a portal
 * link too. Silently demoting a real user to `viewer` because someone
 * issued them a portal link would be a live privilege regression.
 */
export async function issuePortalAccess(
  input: IssuePortalAccessInput,
): Promise<IssuedPortalAccess> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new ForbiddenError("A portal link needs a recipient address.");

  const { userId, provisioned } = await findOrCreatePortalUser(email, input.organizationId);

  // Retire any live link for the same record. One live link per record
  // keeps "revoke" meaningful: an admin who revokes should not have to
  // guess how many older links are still floating around.
  const retired = await db
    .updateTable("portal_access_tokens")
    .set({ revokedAt: new Date() })
    .where("organizationId", "=", input.organizationId)
    .where("subjectType", "=", input.subjectType)
    .where("subjectId", "=", input.subjectId)
    .where("email", "=", email)
    .where("revokedAt", "is", null)
    .returning(["id"])
    .execute();

  const token = generatePortalToken();
  const tokenHash = await hashToken(token);
  const expiresAt = input.expiresInDays && input.expiresInDays > 0
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const row = await db
    .insertInto("portal_access_tokens")
    .values({
      organizationId: input.organizationId,
      userId,
      email,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      tokenHash,
      expiresAt,
      createdBy: input.createdByUserId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const url = buildPortalUrl(token);

  if (input.sendEmail !== false) {
    await deliverPortalLink({
      accessId: row.id,
      organizationId: input.organizationId,
      to: email,
      url,
      subjectLabel: input.subjectLabel ?? null,
    });
  }

  log.info("Portal access issued", {
    source: LOG_SOURCE,
    feature: "issue",
    accessId: row.id,
    organizationId: input.organizationId,
    subjectType: input.subjectType,
    retiredPrevious: retired.length,
    provisionedUser: provisioned,
  });

  return {
    access: toPortalAccess(row),
    url,
    token,
    replacedPrevious: retired.length > 0,
    provisionedUser: provisioned,
  };
}

/**
 * Re-send: issue a FRESH link for an existing record binding and retire
 * the old one. The admin-facing verb is "resend"; the mechanism is a
 * rotation, because the stored hash cannot reproduce the original URL.
 *
 * Org-scoped: an id from another workspace is a 404, not a leak.
 */
export async function resendPortalAccess(opts: {
  accessId: string;
  organizationId: string;
  subjectLabel?: string | null;
  requestedByUserId?: string | null;
}): Promise<IssuedPortalAccess> {
  const existing = await db
    .selectFrom("portal_access_tokens")
    .selectAll()
    .where("id", "=", opts.accessId)
    .where("organizationId", "=", opts.organizationId)
    .executeTakeFirst();

  if (!existing) throw new NotFoundError("Portal link");

  const issued = await issuePortalAccess({
    organizationId: opts.organizationId,
    email: existing.email,
    subjectType: existing.subjectType,
    subjectId: existing.subjectId,
    subjectLabel: opts.subjectLabel ?? null,
    createdByUserId: opts.requestedByUserId ?? existing.createdBy,
    expiresInDays: null,
  });

  log.info("Portal access re-sent", {
    source: LOG_SOURCE,
    feature: "resend",
    previousAccessId: opts.accessId,
    accessId: issued.access.id,
    organizationId: opts.organizationId,
  });

  return issued;
}

/**
 * Revoke a link. Idempotent: revoking an already-revoked link is a no-op,
 * not an error. Org-scoped in the WHERE clause.
 */
export async function revokePortalAccess(opts: {
  accessId: string;
  organizationId: string;
}): Promise<void> {
  const updated = await db
    .updateTable("portal_access_tokens")
    .set({ revokedAt: new Date() })
    .where("id", "=", opts.accessId)
    .where("organizationId", "=", opts.organizationId)
    .where("revokedAt", "is", null)
    .returning(["id"])
    .execute();

  if (updated.length > 0) {
    log.info("Portal access revoked", {
      source: LOG_SOURCE,
      feature: "revoke",
      accessId: opts.accessId,
      organizationId: opts.organizationId,
    });
  }
}

// ── Read ───────────────────────────────────────────────────────────────────

/** Admin list for one org, newest first. Optionally narrowed to a record. */
export async function listPortalAccess(opts: {
  organizationId: string;
  subjectType?: string;
  subjectId?: string;
  /** Include revoked and expired rows. Default: live links only. */
  includeInactive?: boolean;
}): Promise<PortalAccess[]> {
  let query = db
    .selectFrom("portal_access_tokens")
    .selectAll()
    .where("organizationId", "=", opts.organizationId);

  if (opts.subjectType) query = query.where("subjectType", "=", opts.subjectType);
  if (opts.subjectId) query = query.where("subjectId", "=", opts.subjectId);
  if (!opts.includeInactive) query = query.where("revokedAt", "is", null);

  const rows = await query.orderBy("createdAt", "desc").execute();
  return rows.map(toPortalAccess);
}

/**
 * What the signed-in portal user is allowed to see: their OWN live
 * bindings, and nothing else. Backs GET /api/portal/me, which is the
 * portal shell's only data source.
 */
export async function listPortalAccessForUser(userId: string): Promise<PortalAccess[]> {
  const rows = await db
    .selectFrom("portal_access_tokens")
    .selectAll()
    .where("userId", "=", userId)
    .where("revokedAt", "is", null)
    .orderBy("createdAt", "desc")
    .execute();

  const now = new Date();
  return rows
    .filter((r) => r.expiresAt === null || r.expiresAt > now)
    .map(toPortalAccess);
}

// ── Claim ──────────────────────────────────────────────────────────────────

export interface ClaimedPortalAccess {
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  role: string;
  access: PortalAccess;
}

/**
 * Exchange a portal token for the identity it is bound to. The caller
 * (POST /api/portal/claim) mints the session cookie.
 *
 * NOT single-use, unlike an invite: the whole point is a link someone can
 * come back to. Revocation and expiry are the controls instead.
 *
 * Errors are deliberately ambiguous. An unauthenticated prober must not
 * be able to tell "revoked" from "never existed".
 */
export async function claimPortalAccess(token: string): Promise<ClaimedPortalAccess> {
  const tokenHash = await hashToken(token ?? "");

  const row = await db
    .selectFrom("portal_access_tokens")
    .selectAll()
    .where("tokenHash", "=", tokenHash)
    .executeTakeFirst();

  const dead = new NotFoundError("Portal link", "This portal link is invalid or has expired.");
  if (!row) throw dead;
  if (row.revokedAt !== null) throw dead;
  if (row.expiresAt !== null && row.expiresAt <= new Date()) throw dead;

  const user = await db
    .selectFrom("users")
    .select(["id", "email", "name", "role", "organizationId"])
    .where("id", "=", row.userId)
    .executeTakeFirst();
  if (!user) throw dead;

  await db
    .updateTable("portal_access_tokens")
    .set({ lastUsedAt: new Date() })
    .where("id", "=", row.id)
    .execute();

  await db
    .updateTable("users")
    .set({ lastLoginAt: new Date(), emailVerified: true })
    .where("id", "=", user.id)
    .execute();

  log.info("Portal access claimed", {
    source: LOG_SOURCE,
    feature: "claim",
    accessId: row.id,
    organizationId: row.organizationId,
    userId: user.id,
  });

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    // The session is minted against the account's OWN org and role, not
    // the token's. A pre-existing admin claiming a portal link stays an
    // admin of their own workspace; they do not get re-homed by a link.
    organizationId: user.organizationId ?? row.organizationId,
    role: user.role,
    access: toPortalAccess(row),
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

async function findOrCreatePortalUser(
  email: string,
  organizationId: string,
): Promise<{ userId: string; provisioned: boolean }> {
  const existing = await db
    .selectFrom("users")
    .select(["id"])
    .where("email", "=", email)
    .executeTakeFirst();

  // Never touch an existing account. See the doc comment on
  // issuePortalAccess for why this is not an oversight.
  if (existing) return { userId: existing.id, provisioned: false };

  const created = await db
    .insertInto("users")
    .values({
      email,
      name: null,
      role: PORTAL_ROLE,
      organizationId,
      // The link is emailed to this address; delivering it is the proof.
      emailVerified: true,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  return { userId: created.id, provisioned: true };
}

async function deliverPortalLink(opts: {
  accessId: string;
  organizationId: string;
  to: string;
  url: string;
  subjectLabel: string | null;
}): Promise<void> {
  const org = await db
    .selectFrom("organizations")
    .select(["name"])
    .where("id", "=", opts.organizationId)
    .executeTakeFirst();

  try {
    await sendEmailKind({
      kind: "portal_link",
      to: opts.to,
      organizationId: opts.organizationId,
      data: {
        organizationName: org?.name ?? "",
        subjectLabel: opts.subjectLabel,
        portalUrl: opts.url,
      },
    });
    await db
      .updateTable("portal_access_tokens")
      .set({ lastSentAt: new Date() })
      .where("id", "=", opts.accessId)
      .execute();
  } catch (err) {
    // The row is real and the admin can re-send, so this is recoverable
    // rather than fatal. It is still an error: a portal link that never
    // arrives is exactly the silent failure this module was built to end.
    log.error(
      "Portal link email failed to send",
      {
        source: LOG_SOURCE,
        feature: "deliver",
        accessId: opts.accessId,
        organizationId: opts.organizationId,
        to: opts.to,
      },
      err as Error,
    );
  }
}

function generatePortalToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  // URL-safe base64, padding stripped, so the whole token survives a URL
  // path and a clipboard round-trip. Same shape as the invite token.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 hex. The DB stores this; the token itself never lands in a row. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildPortalUrl(token: string): string {
  const base = Deno.env.get("APP_URL") ?? "http://localhost:8000";
  // Hash route -- matches web/src/routes.ts.
  return `${base}/#/portal/claim/${token}`;
}

// deno-lint-ignore no-explicit-any
function toPortalAccess(row: any): PortalAccess {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    email: row.email,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    expiresAt: row.expiresAt ?? null,
    revokedAt: row.revokedAt ?? null,
    lastSentAt: row.lastSentAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
  };
}
