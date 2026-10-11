/**
 * Dedicated verification accounts for platform post-deploy checks.
 *
 * `POST /api/auth/verification-session` signs the platform verifier in as
 * one of these accounts, never as a real user. Each role gets its own user,
 * and every one lives in a dedicated "Alchemist verification" organization,
 * so a verification session sees only that org's (empty) data and never a
 * customer's records.
 *
 * The addresses use the reserved `.invalid` TLD (RFC 2606). Mail to them
 * cannot be delivered, so nobody can sign in to these accounts by email
 * code. The only way in is the platform-signed verification token.
 *
 * CUSTOMIZE: if your app derives personas from extra rows (for example a
 * `students` row makes a user a student), extend
 * `provisionVerificationAccount` to create that row for the matching role
 * and add the role to VERIFICATION_ROLES. Keep the account inside the
 * verification organization. Do NOT add `owner`.
 */

import { db } from "@/db/client.ts";

/**
 * Roles a verification session may request. `member` is the legacy synonym
 * for `editor` (see src/lib/roles.ts) and is stored as `editor`. `owner` is
 * never allowed: a verification session must not hold ownership powers.
 */
export const VERIFICATION_ROLES = ["admin", "editor", "viewer", "member"] as const;

export const VERIFICATION_ORG_SLUG = "alchemist-verification";
const VERIFICATION_ORG_NAME = "Alchemist verification";

export function isVerificationRole(role: string): boolean {
  return (VERIFICATION_ROLES as readonly string[]).includes(role);
}

/** The stored user role for a requested verification role. */
export function storedVerificationRole(role: string): string {
  return role === "member" ? "editor" : role;
}

export function verificationAccountEmail(role: string): string {
  return `alchemist-verify-${storedVerificationRole(role)}@verification.invalid`;
}

/** True for an address this module owns. Used to keep these accounts out of real flows. */
export function isVerificationAccountEmail(email: string): boolean {
  return /^alchemist-verify-[a-z0-9_-]+@verification\.invalid$/.test(email.toLowerCase());
}

export interface VerificationAccount {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

async function findOrCreateVerificationOrg(): Promise<string> {
  const existing = await db
    .selectFrom("organizations")
    .select("id")
    .where("slug", "=", VERIFICATION_ORG_SLUG)
    .executeTakeFirst();
  if (existing) return existing.id;
  try {
    const created = await db
      .insertInto("organizations")
      .values({
        name: VERIFICATION_ORG_NAME,
        slug: VERIFICATION_ORG_SLUG,
        subscriptionTier: "FREE",
        creditsExhausted: false,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return created.id;
  } catch (err) {
    // Two concurrent first mints race on the unique slug. The loser reads
    // the winner's row.
    if (!isUniqueViolation(err)) throw err;
    const raced = await db
      .selectFrom("organizations")
      .select("id")
      .where("slug", "=", VERIFICATION_ORG_SLUG)
      .executeTakeFirstOrThrow();
    return raced.id;
  }
}

/**
 * Find or create the verification account for `role`. Idempotent: the same
 * role always resolves to the same user. If the stored row drifted (role or
 * org changed by hand), it is put back, so a verification account can never
 * keep a privilege the request did not ask for.
 */
export async function provisionVerificationAccount(role: string): Promise<VerificationAccount> {
  if (!isVerificationRole(role)) {
    throw new Error(`role "${role}" is not a verification role`);
  }
  const storedRole = storedVerificationRole(role);
  const email = verificationAccountEmail(role);
  const name = `Alchemist verification (${storedRole})`;
  const organizationId = await findOrCreateVerificationOrg();

  const existing = await db
    .selectFrom("users")
    .select(["id", "role", "organizationId"])
    .where("email", "=", email)
    .executeTakeFirst();
  if (existing) {
    if (existing.role !== storedRole || existing.organizationId !== organizationId) {
      await db
        .updateTable("users")
        .set({ role: storedRole, organizationId })
        .where("id", "=", existing.id)
        .execute();
    }
    return { id: existing.id, email, name, role: storedRole, organizationId };
  }

  try {
    const created = await db
      .insertInto("users")
      .values({ email, name, role: storedRole, organizationId, emailVerified: true })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { id: created.id, email, name, role: storedRole, organizationId };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    return { id: raced.id, email, name, role: storedRole, organizationId };
  }
}
