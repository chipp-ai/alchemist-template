/**
 * Platform member sync: keep this app's users in step with the people who
 * hold a role on the Chipp project.
 *
 * The Chipp platform POSTs the FULL desired set of platform members to
 * `POST /api/platform/member-sync` (src/api/routes/platform/member-sync.ts)
 * every time project membership changes. This service reconciles it. It is
 * idempotent: the same body twice changes nothing the second time.
 *
 * Ownership of rows
 *
 *   users.managed_by = 'platform' marks a row this sync created. The sync
 *   creates, updates and disconnects ONLY those rows. A row with managed_by
 *   NULL (invited in the app, or signed up on its own) is app-native and is
 *   never touched: when a desired member's email already belongs to a
 *   native row, the member is skipped with reason "app_account".
 *
 * Target organization (each user belongs to one org; see roles.ts)
 *
 *   1. the org of an attached managed row (the org earlier syncs used), else
 *   2. the org of a native user whose email is one of the desired owners
 *      (the platform owner already uses the app), else
 *   3. the oldest organization that is not the verification org, else
 *   4. a new organization named "Team".
 *
 *   The verification org (VERIFICATION_ORG_SLUG) is never a target, and
 *   verification account addresses are skipped with reason "reserved".
 *
 * Role mapping
 *
 *   platform viewer -> viewer, editor -> editor, owner -> owner when the
 *   target org has no other owner, else admin. A managed row that already
 *   holds the owner role keeps it while the platform still says owner. Only
 *   one platform owner becomes the app owner; the rest are admins. A native
 *   owner is never demoted or touched.
 *
 * Removal
 *
 *   An attached managed row whose email is not in the desired set is
 *   soft-disconnected exactly like DELETE /api/org/members/:userId
 *   (organization_id NULL, role viewer), and token_invalidated_before is set
 *   to now, so its live sessions and MCP tokens stop at once. A later sync
 *   that lists the email again re-attaches the same row.
 *
 * Role changes apply on the next request with no re-issued token:
 * resolveUser (src/api/middleware/auth.ts) and the MCP token lookup both
 * read the role from the users row on every request.
 *
 * Replay: platform_member_sync_state holds the highest `seq` applied. The
 * reconcile runs in one transaction that locks that row first, so two
 * concurrent deliveries apply one after the other, and a seq that is not
 * newer is ignored.
 */

import { sql, type Transaction } from "kysely";
import { db } from "@/db/client.ts";
import type { Database } from "@/db/schema.ts";
import type { AccessMode } from "@/services/platform-access.service.ts";
import { isVerificationAccountEmail, VERIFICATION_ORG_SLUG } from "@/lib/verification-accounts.ts";

export const PLATFORM_ROLES = ["owner", "editor", "viewer"] as const;
export type PlatformRole = typeof PLATFORM_ROLES[number];

export const MEMBER_SYNC_MAX_MEMBERS = 500;
export const MANAGED_BY_PLATFORM = "platform" as const;

const NEW_ORG_NAME = "Team";

export interface DesiredMember {
  email: string;
  name: string | null;
  role: PlatformRole;
}

export interface SkippedMember {
  email: string;
  reason: "app_account" | "reserved";
}

export type MemberSyncResult =
  | {
    applied: true;
    orgId: string | null;
    created: number;
    updated: number;
    disconnected: number;
    skipped: SkippedMember[];
  }
  | { applied: false; reason: "stale_seq"; lastSeq: number };

type Trx = Transaction<Database>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The app role for a platform role, given whether the owner slot is free. */
export function mapPlatformRole(role: PlatformRole, ownerSlotFree: boolean): string {
  if (role === "owner") return ownerSlotFree ? "owner" : "admin";
  return role;
}

async function claimSeq(
  trx: Trx,
  seq: number,
): Promise<{ ok: true } | { ok: false; lastSeq: number }> {
  // Make sure the one state row exists, then lock it. Every delivery
  // serializes on this lock for the rest of the transaction.
  await trx
    .insertInto("platform_member_sync_state")
    .values({ id: true, lastSeq: -1 })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  const state = await trx
    .selectFrom("platform_member_sync_state")
    .select("lastSeq")
    .where("id", "=", true)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const lastSeq = Number(state.lastSeq);
  if (seq <= lastSeq) return { ok: false, lastSeq };
  return { ok: true };
}

async function verificationOrgId(trx: Trx): Promise<string | null> {
  const row = await trx
    .selectFrom("organizations")
    .select("id")
    .where("slug", "=", VERIFICATION_ORG_SLUG)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function resolveTargetOrg(
  trx: Trx,
  desired: DesiredMember[],
  excludeOrgId: string | null,
): Promise<string | null> {
  // 1. Where earlier syncs put platform members.
  let q1 = trx
    .selectFrom("users")
    .select("organizationId")
    .where("managedBy", "=", MANAGED_BY_PLATFORM)
    .where("organizationId", "is not", null);
  if (excludeOrgId) q1 = q1.where("organizationId", "!=", excludeOrgId);
  const managed = await q1.orderBy("createdAt", "asc").limit(1).executeTakeFirst();
  if (managed?.organizationId) return managed.organizationId;

  // 2. A platform owner who already has a native account here.
  const ownerEmails = desired.filter((m) => m.role === "owner").map((m) => m.email);
  if (ownerEmails.length > 0) {
    let q2 = trx
      .selectFrom("users")
      .select("organizationId")
      .where("managedBy", "is", null)
      .where("organizationId", "is not", null)
      .where(sql<string>`lower(email)`, "in", ownerEmails);
    if (excludeOrgId) q2 = q2.where("organizationId", "!=", excludeOrgId);
    const native = await q2.orderBy("createdAt", "asc").limit(1).executeTakeFirst();
    if (native?.organizationId) return native.organizationId;
  }

  // 3. The oldest real organization.
  let q3 = trx.selectFrom("organizations").select("id");
  if (excludeOrgId) q3 = q3.where("id", "!=", excludeOrgId);
  const oldest = await q3.orderBy("createdAt", "asc").limit(1).executeTakeFirst();
  if (oldest) return oldest.id;

  // 4. Nothing yet. Create one only when there is someone to put in it.
  if (desired.length === 0) return null;
  const created = await trx
    .insertInto("organizations")
    .values({
      name: NEW_ORG_NAME,
      slug: `team-${crypto.randomUUID().slice(0, 8)}`,
      subscriptionTier: "FREE",
      creditsExhausted: false,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return created.id;
}

/**
 * Apply one delivery. `desired` must already be validated: unique,
 * normalized emails (see the route's schema).
 */
export async function applyMemberSync(input: {
  seq: number;
  members: DesiredMember[];
  /** Absent: the stored access setting is left as it is. */
  access?: { mode: AccessMode; allowedEmails: string[] };
}): Promise<MemberSyncResult> {
  const desired = input.members.map((m) => ({ ...m, email: normalizeEmail(m.email) }));

  return await db.transaction().execute(async (trx): Promise<MemberSyncResult> => {
    const claim = await claimSeq(trx, input.seq);
    if (!claim.ok) return { applied: false, reason: "stale_seq", lastSeq: claim.lastSeq };

    const skipped: SkippedMember[] = [];
    const eligible: DesiredMember[] = [];
    for (const m of desired) {
      if (isVerificationAccountEmail(m.email)) skipped.push({ email: m.email, reason: "reserved" });
      else eligible.push(m);
    }

    const verificationOrg = await verificationOrgId(trx);
    const orgId = await resolveTargetOrg(trx, eligible, verificationOrg);

    // Every existing row for a desired email, native or managed.
    const emails = eligible.map((m) => m.email);
    const existing = emails.length === 0 ? [] : await trx
      .selectFrom("users")
      .select(["id", "email", "name", "role", "organizationId", "managedBy"])
      .where(sql<string>`lower(email)`, "in", emails)
      .execute();
    const byEmail = new Map(existing.map((u) => [normalizeEmail(u.email), u]));

    // The owner slot: a native owner in the target org keeps it. Otherwise a
    // managed row that is already owner keeps it if the platform still says
    // owner; else the first platform owner in the delivery takes it.
    let ownerEmail: string | null = null;
    if (orgId) {
      const nativeOwner = await trx
        .selectFrom("users")
        .select("id")
        .where("organizationId", "=", orgId)
        .where("role", "=", "owner")
        .where("managedBy", "is", null)
        .executeTakeFirst();
      if (!nativeOwner) {
        const platformOwners = eligible.filter((m) => {
          if (m.role !== "owner") return false;
          const row = byEmail.get(m.email);
          return !row || row.managedBy === MANAGED_BY_PLATFORM;
        });
        const sitting = platformOwners.find((m) => {
          const row = byEmail.get(m.email);
          return row?.role === "owner" && row.organizationId === orgId;
        });
        ownerEmail = (sitting ?? platformOwners[0])?.email ?? null;
      }
    }

    let created = 0;
    let updated = 0;
    const now = new Date();
    for (const m of eligible) {
      if (!orgId) break;
      const role = mapPlatformRole(m.role, m.email === ownerEmail);
      const row = byEmail.get(m.email);

      if (row && row.managedBy !== MANAGED_BY_PLATFORM) {
        skipped.push({ email: m.email, reason: "app_account" });
        continue;
      }

      if (row) {
        const name = m.name ?? row.name;
        if (row.role === role && row.organizationId === orgId && row.name === name) continue;
        await trx
          .updateTable("users")
          .set({ role, organizationId: orgId, name, updatedAt: now })
          .where("id", "=", row.id)
          .where("managedBy", "=", MANAGED_BY_PLATFORM)
          .execute();
        updated++;
        continue;
      }

      // A concurrent OTP sign-up can create a native row for this email
      // between the read above and this insert. The unique email index
      // makes the insert a no-op then, and the member is skipped.
      const inserted = await trx
        .insertInto("users")
        .values({
          email: m.email,
          name: m.name ?? m.email.split("@")[0],
          role,
          organizationId: orgId,
          emailVerified: true,
          managedBy: MANAGED_BY_PLATFORM,
        })
        .onConflict((oc) => oc.column("email").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (inserted) created++;
      else skipped.push({ email: m.email, reason: "app_account" });
    }

    // Managed rows that are attached but no longer wanted: soft-disconnect,
    // and end their sessions.
    let dq = trx
      .updateTable("users")
      .set({ organizationId: null, role: "viewer", tokenInvalidatedBefore: now, updatedAt: now })
      .where("managedBy", "=", MANAGED_BY_PLATFORM)
      .where("organizationId", "is not", null);
    if (emails.length > 0) dq = dq.where(sql<string>`lower(email)`, "not in", emails);
    const disconnectedRows = await dq.returning("id").execute();

    await trx
      .updateTable("platform_member_sync_state")
      .set({
        lastSeq: input.seq,
        organizationId: orgId,
        appliedAt: now,
        ...(input.access
          ? { accessMode: input.access.mode, allowedEmails: input.access.allowedEmails }
          : {}),
      })
      .where("id", "=", true)
      .execute();

    return {
      applied: true,
      orgId,
      created,
      updated,
      disconnected: disconnectedRows.length,
      skipped,
    };
  });
}

/** True when this user row is owned by the platform member sync. */
export function isPlatformManaged(row: { managedBy?: string | null } | null | undefined): boolean {
  return row?.managedBy === MANAGED_BY_PLATFORM;
}

/** Shown wherever the app refuses to change a platform-managed member. */
export const MANAGED_BY_CHIPP_MESSAGE =
  "This person's access is managed on Chipp. Change it in the Chipp project's members, not here.";

/** The managedBy marker for one user, or null when the row is gone. */
export async function managedByOf(userId: string): Promise<string | null> {
  const row = await db.selectFrom("users").select("managedBy").where("id", "=", userId)
    .executeTakeFirst();
  return row?.managedBy ?? null;
}

/** True when a platform-managed account holds this email (any case). */
export async function isPlatformManagedEmail(email: string): Promise<boolean> {
  const row = await db
    .selectFrom("users")
    .select("id")
    .where(sql<string>`lower(email)`, "=", normalizeEmail(email))
    .where("managedBy", "=", MANAGED_BY_PLATFORM)
    .executeTakeFirst();
  return row !== undefined;
}
