/**
 * Organization store using Svelte 5 runes.
 *
 * Tracks the current org and its members.
 */

import { api } from "../lib/api";

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

// ---------- State ----------

let currentOrg = $state<Organization | null>(null);
let members = $state<OrgMember[]>([]);
let isLoading = $state(false);

// ---------- Actions ----------

async function fetchOrg(): Promise<void> {
  isLoading = true;
  try {
    const data = await api.get<{ organization: Organization }>("/org");
    currentOrg = data.organization;
  } catch (err) {
    console.error("Failed to fetch organization:", err);
    currentOrg = null;
  } finally {
    isLoading = false;
  }
}

async function fetchMembers(): Promise<void> {
  try {
    const data = await api.get<{ members: OrgMember[] }>("/org/members");
    members = data.members;
  } catch (err) {
    console.error("Failed to fetch members:", err);
    members = [];
  }
}

async function updateOrg(
  data: Partial<Pick<Organization, "name">>,
): Promise<void> {
  try {
    const updated = await api.patch<{ organization: Organization }>("/org", data);
    currentOrg = updated.organization;
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
  currentOrg = null;
  members = [];
}

// ---------- Export ----------

export const orgStore = {
  get currentOrg() {
    return currentOrg;
  },
  get members() {
    return members;
  },
  get isLoading() {
    return isLoading;
  },
  fetchOrg,
  fetchMembers,
  updateOrg,
  inviteMember,
  reset,
};
