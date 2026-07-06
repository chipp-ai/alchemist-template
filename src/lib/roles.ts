/**
 * Role hierarchy + permission helpers for team management.
 *
 * Single source of truth — both the API middleware
 * (`api/middleware/permissions.ts`) AND the client-side store/UI
 * (`web/src/lib/permissions.ts` mirror) read from this same hierarchy.
 *
 * Roles
 *
 *   owner   1 per org  full control. Set at org creation. Cannot be
 *                      invited; ownership transfer is a separate flow.
 *   admin   N per org  manage team (invite, role-change, remove) +
 *                      org settings + everything an editor can do.
 *   editor  N per org  write app data. Cannot manage team or org
 *                      settings. The "default invitee" role.
 *   viewer  N per org  read-only across the board.
 *
 * Backward compat
 *
 *   The original schema's enum included 'member', which is treated as
 *   a synonym for 'editor' here. Existing customer apps with users at
 *   role='member' get the same permissions as 'editor'. New invites
 *   default to 'editor'. Migration 003 backfills 'member' rows to
 *   'editor' so fresh databases never produce 'member' rows; the enum
 *   value remains in the type for back-compat with already-deployed
 *   schemas.
 */

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = typeof ROLES[number];

/**
 * Roles the application can ASSIGN via invite or role-update. 'owner'
 * is excluded — it's set once at org creation and changed only by an
 * explicit ownership-transfer flow. The DB enum still allows 'owner'
 * (we WRITE it on signup) but the public API surface caps at 'admin'.
 */
export const ASSIGNABLE_ROLES = ["admin", "editor", "viewer"] as const;
export type AssignableRole = typeof ASSIGNABLE_ROLES[number];

/**
 * Hierarchy ordering — higher number = more privileged. Used for
 * `canPerformAction` checks. NEVER compare role STRINGS directly;
 * always go through the hierarchy.
 */
const HIERARCHY: Record<string, number> = {
  owner: 100,
  admin: 80,
  editor: 50,
  // 'member' is a legacy synonym for 'editor' — same permission level.
  member: 50,
  viewer: 20,
};

/**
 * Capabilities. Each is a noun describing a permission gate. The
 * route middleware and the client UI both branch on these.
 *
 * Add a new capability by appending here + adding it to `CAPABILITY_MIN_ROLE`.
 */
export const CAPABILITIES = [
  // Team management
  "team.invite", // send invite, revoke pending invite
  "team.update_role", // change another member's role
  "team.remove", // remove (disconnect) another member
  // Organization
  "org.update", // edit org name, slug, etc.
  // Billing / monetization
  "billing.manage", // manage the product catalog, open the billing portal config
  // App-data writes (template's domain-specific actions go through this)
  "app.write",
  // Read-only org info — every role above 'viewer' has this implicitly.
  "app.read",
] as const;
export type Capability = typeof CAPABILITIES[number];

/**
 * Minimum role for each capability. Inclusive — the named role and
 * everything ABOVE it has the capability.
 */
const CAPABILITY_MIN_ROLE: Record<Capability, Role> = {
  "team.invite": "admin",
  "team.update_role": "admin",
  "team.remove": "admin",
  "org.update": "admin",
  "billing.manage": "admin",
  "app.write": "editor",
  "app.read": "viewer",
};

/**
 * Returns the rank of a role in the hierarchy. Unknown roles get the
 * lowest rank (0) — defensive against schema drift / typos.
 */
export function rankOf(role: string): number {
  return HIERARCHY[role] ?? 0;
}

/**
 * True if `role` has at least `minimum`'s level of privilege.
 *
 * @example hasAtLeast("admin", "editor") // true (admin > editor)
 * @example hasAtLeast("viewer", "editor") // false
 * @example hasAtLeast("editor", "editor") // true (inclusive)
 */
export function hasAtLeast(role: string, minimum: Role): boolean {
  return rankOf(role) >= rankOf(minimum);
}

/**
 * True if `role` has the named capability.
 */
export function can(role: string, cap: Capability): boolean {
  return hasAtLeast(role, CAPABILITY_MIN_ROLE[cap]);
}

/**
 * True if `actor` can manage `target` — i.e. change their role or
 * remove them. Rules:
 *   - Actor must have team.update_role (admin or owner).
 *   - Owner cannot be managed by anyone (ownership transfer is a
 *     separate flow).
 *   - Admins cannot manage other admins (prevents lateral demotion
 *     wars). Only the owner can manage admins.
 *   - You can never manage yourself via this function (route handlers
 *     should explicitly disallow self-mutation when relevant — e.g.
 *     "you can't remove yourself").
 */
export function canManage(actorRole: string, targetRole: string): boolean {
  if (!can(actorRole, "team.update_role")) return false;
  if (targetRole === "owner") return false;
  if (targetRole === "admin" && actorRole !== "owner") return false;
  return true;
}

/**
 * Display label for UI. Maps the legacy 'member' value to 'Editor' so
 * the user never sees mixed terminology.
 */
export function roleLabel(role: string): string {
  if (role === "member") return "Editor";
  return role.charAt(0).toUpperCase() + role.slice(1);
}
