/**
 * Client-side role + capability helpers.
 *
 * Mirrors the server's `src/lib/roles.ts` hierarchy. The two files
 * MUST stay in sync — capability gating in the API would be useless
 * if the UI couldn't predict which buttons to enable. A regression
 * test in `src/__tests__/team.test.ts` lints the two files for the
 * same capability/hierarchy shape.
 *
 * Use this module to:
 *   - Show/hide UI affordances based on the current user's role.
 *   - Disable a member's role-update dropdown when an admin can't
 *     manage another admin (only the owner can).
 *   - Render the right role label ("Editor" not "member") in
 *     consumer-visible UI.
 */

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ASSIGNABLE_ROLES = ["admin", "editor", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const HIERARCHY: Record<string, number> = {
  owner: 100,
  admin: 80,
  editor: 50,
  member: 50, // legacy synonym for editor
  viewer: 20,
};

export const CAPABILITIES = [
  "team.invite",
  "team.update_role",
  "team.remove",
  "org.update",
  "org.transfer_ownership",
  "billing.manage",
  "files.review",
  "app.write",
  "app.read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_MIN_ROLE: Record<Capability, Role> = {
  "team.invite": "admin",
  "team.update_role": "admin",
  "team.remove": "admin",
  "org.update": "admin",
  "org.transfer_ownership": "owner",
  "billing.manage": "admin",
  "files.review": "admin",
  "app.write": "editor",
  "app.read": "viewer",
};

export function rankOf(role: string): number {
  return HIERARCHY[role] ?? 0;
}

export function hasAtLeast(role: string, minimum: Role): boolean {
  return rankOf(role) >= rankOf(minimum);
}

export function can(role: string, cap: Capability): boolean {
  return hasAtLeast(role, CAPABILITY_MIN_ROLE[cap]);
}

/**
 * Whether `actor` can manage (change role / remove) `target`. Mirrors
 * `canManage` in the server's roles.ts:
 *   - actor must have team.update_role
 *   - owner can never be managed
 *   - admins can't manage other admins (only the owner can)
 */
export function canManage(actorRole: string, targetRole: string): boolean {
  if (!can(actorRole, "team.update_role")) return false;
  if (targetRole === "owner") return false;
  if (targetRole === "admin" && actorRole !== "owner") return false;
  return true;
}

/** UI label. Maps legacy 'member' → 'Editor' so users never see the
 *  raw enum value. */
export function roleLabel(role: string): string {
  if (role === "member") return "Editor";
  return role.charAt(0).toUpperCase() + role.slice(1);
}
