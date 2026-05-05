/**
 * Organization store — current org + members + CRUD actions.
 *
 * Built on `defineStore` (the canonical store factory — see
 * web/src/lib/devpanel/store.svelte.ts). Every shared store in this
 * app follows the same pattern so the dev panel can introspect them
 * at runtime.
 */

import { api } from "../lib/api";
import { defineStore } from "../lib/devpanel/store.svelte";

// ---------- Types ----------

export interface Organization {
  id: string;
  name: string;
  subscriptionTier: string;
  createdAt: string;
}

export interface OrgMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
}

interface OrgState {
  currentOrg: Organization | null;
  members: OrgMember[];
  isLoading: boolean;
}

// ---------- State ----------

const state = defineStore<OrgState>("organization", {
  currentOrg: null,
  members: [],
  isLoading: false,
});

// ---------- Actions ----------

async function fetchOrg(): Promise<void> {
  state.isLoading = true;
  try {
    const data = await api.get<{ organization: Organization }>("/org");
    state.currentOrg = data.organization;
  } catch (err) {
    console.error("Failed to fetch organization:", err);
    state.currentOrg = null;
  } finally {
    state.isLoading = false;
  }
}

async function fetchMembers(): Promise<void> {
  try {
    const data = await api.get<{ members: OrgMember[] }>("/org/members");
    state.members = data.members;
  } catch (err) {
    console.error("Failed to fetch members:", err);
    state.members = [];
  }
}

async function updateOrg(
  data: Partial<Pick<Organization, "name">>,
): Promise<void> {
  try {
    const updated = await api.patch<{ organization: Organization }>("/org", data);
    state.currentOrg = updated.organization;
  } catch (err) {
    console.error("Failed to update organization:", err);
    throw err;
  }
}

async function inviteMember(email: string, role: string = "member"): Promise<void> {
  try {
    await api.post("/org/members/invite", {
      email: email.toLowerCase().trim(),
      role,
    });
    await fetchMembers();
  } catch (err) {
    console.error("Failed to invite member:", err);
    throw err;
  }
}

function reset(): void {
  state.currentOrg = null;
  state.members = [];
}

// ---------- Export ----------

export const orgStore = {
  get currentOrg() {
    return state.currentOrg;
  },
  get members() {
    return state.members;
  },
  get isLoading() {
    return state.isLoading;
  },
  fetchOrg,
  fetchMembers,
  updateOrg,
  inviteMember,
  reset,
};
