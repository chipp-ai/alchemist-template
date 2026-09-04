/**
 * Organization store — current org + members + pending invites + team
 * management actions.
 *
 * Built on `defineStore` (the canonical store factory — see
 * web/src/lib/devpanel/store.svelte.ts). Every shared store in this
 * app follows the same pattern so the dev panel can introspect them
 * at runtime.
 *
 * Action surface:
 *   fetchOrg           - Load the current org details
 *   fetchMembers       - Load the member list
 *   fetchInvites       - Load pending invites (admin+ only; 403 = no-op)
 *   updateOrg          - Edit org name / slug
 *   inviteMember       - Send invite (admin+)
 *   revokeInvite       - Revoke a pending invite (admin+)
 *   updateMemberRole   - Change a member's role (admin+)
 *   removeMember       - Soft-disconnect a member (admin+)
 *   transferOwnership  - Hand the owner role to another member (owner only)
 *   reset              - Clear store on logout
 */

import { api, ApiError } from "../lib/api";
import { defineStore } from "../lib/devpanel/store.svelte";

// ---------- Types ----------

export interface Organization {
  id: string;
  name: string;
  slug: string | null;
  subscriptionTier: string;
  createdAt: string;
}

export interface OrgMember {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  role: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  invitedByName: string | null;
  invitedByEmail: string;
  expiresAt: string;
  createdAt: string;
}

export type AssignableRole = "admin" | "editor" | "viewer";

interface OrgState {
  currentOrg: Organization | null;
  members: OrgMember[];
  pendingInvites: PendingInvite[];
  isLoading: boolean;
  /** Most recent server error from any team-management action — surface
   *  in the UI as inline error copy. Cleared at the start of each action. */
  error: string | null;
}

// ---------- State ----------

const state = defineStore<OrgState>("organization", {
  currentOrg: null,
  members: [],
  pendingInvites: [],
  isLoading: false,
  error: null,
});

// ---------- Helpers ----------

function setError(err: unknown, fallback: string): never {
  state.error = err instanceof ApiError ? err.message : fallback;
  throw err;
}

// ---------- Actions ----------

async function fetchOrg(): Promise<void> {
  state.isLoading = true;
  try {
    const data = await api.get<{ data: Organization }>("/org");
    state.currentOrg = data.data;
  } catch (err) {
    console.error("Failed to fetch organization:", err);
    state.currentOrg = null;
  } finally {
    state.isLoading = false;
  }
}

async function fetchMembers(): Promise<void> {
  try {
    const data = await api.get<{ data: OrgMember[] }>("/org/members");
    state.members = data.data;
  } catch (err) {
    console.error("Failed to fetch members:", err);
    state.members = [];
  }
}

/**
 * Fetch pending invites. Admin-only on the server; non-admins get 403
 * which we silently swallow (their UI doesn't show the section, so an
 * empty array is fine).
 */
async function fetchInvites(): Promise<void> {
  try {
    const data = await api.get<{ data: PendingInvite[] }>("/org/invites");
    state.pendingInvites = data.data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      // Non-admin — endpoint is gated. Empty list is the right shape.
      state.pendingInvites = [];
      return;
    }
    console.error("Failed to fetch invites:", err);
    state.pendingInvites = [];
  }
}

async function updateOrg(
  data: Partial<Pick<Organization, "name" | "slug">>,
): Promise<void> {
  state.error = null;
  try {
    const res = await api.patch<{ data: Organization }>("/org", data);
    state.currentOrg = { ...state.currentOrg, ...res.data } as Organization;
  } catch (err) {
    setError(err, "Failed to update organization.");
  }
}

async function inviteMember(email: string, role: AssignableRole): Promise<void> {
  state.error = null;
  try {
    const res = await api.post<{ data: PendingInvite }>("/org/invites", {
      email: email.toLowerCase().trim(),
      role,
    });
    // Prepend so the new invite shows at the top of the pending list.
    state.pendingInvites = [res.data, ...state.pendingInvites];
  } catch (err) {
    setError(err, "Failed to send invite.");
  }
}

async function revokeInvite(inviteId: string): Promise<void> {
  state.error = null;
  try {
    await api.delete(`/org/invites/${inviteId}`);
    state.pendingInvites = state.pendingInvites.filter((i) => i.id !== inviteId);
  } catch (err) {
    setError(err, "Failed to revoke invite.");
  }
}

async function updateMemberRole(
  userId: string,
  role: AssignableRole,
): Promise<void> {
  state.error = null;
  try {
    const res = await api.patch<{ data: { id: string; role: string } }>(
      `/org/members/${userId}/role`,
      { role },
    );
    state.members = state.members.map((m) =>
      m.id === userId ? { ...m, role: res.data.role } : m,
    );
  } catch (err) {
    setError(err, "Failed to update role.");
  }
}

async function removeMember(userId: string): Promise<void> {
  state.error = null;
  try {
    await api.delete(`/org/members/${userId}`);
    state.members = state.members.filter((m) => m.id !== userId);
  } catch (err) {
    setError(err, "Failed to remove member.");
  }
}

/**
 * Transfer the owner role to `userId`. The server demotes the caller
 * to admin in the same transaction. The member list is patched
 * locally; the caller should also refresh the auth store so its own
 * role flips to admin (`authStore.checkAuth()`).
 */
async function transferOwnership(userId: string): Promise<void> {
  state.error = null;
  try {
    const res = await api.post<{
      data: { newOwnerId: string; previousOwnerId: string };
    }>("/org/transfer-ownership", { userId });
    state.members = state.members.map((m) => {
      if (m.id === res.data.newOwnerId) return { ...m, role: "owner" };
      if (m.id === res.data.previousOwnerId) return { ...m, role: "admin" };
      return m;
    });
  } catch (err) {
    setError(err, "Failed to transfer ownership.");
  }
}

function reset(): void {
  state.currentOrg = null;
  state.members = [];
  state.pendingInvites = [];
  state.isLoading = false;
  state.error = null;
}

// ---------- Export ----------

export const orgStore = {
  get currentOrg() { return state.currentOrg; },
  get members() { return state.members; },
  get pendingInvites() { return state.pendingInvites; },
  get isLoading() { return state.isLoading; },
  get error() { return state.error; },
  fetchOrg,
  fetchMembers,
  fetchInvites,
  updateOrg,
  inviteMember,
  revokeInvite,
  updateMemberRole,
  removeMember,
  transferOwnership,
  reset,
};
