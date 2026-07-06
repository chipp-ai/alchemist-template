<script lang="ts">
  import { onMount } from "svelte";
  import { authStore } from "../stores/auth.svelte";
  import { orgStore, type AssignableRole } from "../stores/organization.svelte";
  import {
    ASSIGNABLE_ROLES,
    can,
    canManage,
    roleLabel,
  } from "../lib/permissions";
  import { api, ApiError } from "../lib/api";
  import Modal from "../components/Modal.svelte";
  import {
    billingStore,
    formatPrice,
    type NewProductInput,
  } from "../stores/billing.svelte";

  // ---------- Tabs ----------

  type Tab = "profile" | "team" | "billing";

  let activeTab = $state<Tab>("profile");

  // ---------- Profile state ----------

  let profileName = $state(authStore.user?.name ?? "");
  let profileEmail = $state(authStore.user?.email ?? "");
  let profileSaving = $state(false);
  let profileMessage = $state<string | null>(null);

  async function saveProfile(e: Event) {
    e.preventDefault();
    profileSaving = true;
    profileMessage = null;
    try {
      await api.patch("/auth/me", {
        name: profileName.trim(),
        email: profileEmail.toLowerCase().trim(),
      });
      profileMessage = "Profile updated.";
    } catch (err) {
      profileMessage =
        err instanceof Error ? err.message : "Failed to save profile.";
    } finally {
      profileSaving = false;
    }
  }

  // ---------- Team state ----------

  let inviteEmail = $state("");
  let inviteRole = $state<AssignableRole>("editor");
  let isInviting = $state(false);
  let inviteSuccessMessage = $state<string | null>(null);

  // Capability-derived UI flags. Recomputed reactively as the
  // current user's role changes (e.g. they get promoted/demoted
  // from another tab).
  const canInvite = $derived(can(authStore.user?.role ?? "", "team.invite"));
  const canChangeRoles = $derived(can(authStore.user?.role ?? "", "team.update_role"));
  const canRemove = $derived(can(authStore.user?.role ?? "", "team.remove"));

  // One-shot data fetch on mount. Use onMount, NOT $effect — see
  // CLAUDE.md → "Stores: $effect on mount is a trap; use onMount".
  // fetchOrg / fetchMembers / fetchInvites write store state; inside
  // an $effect those writes would attribute as deps and loop the
  // fetches.
  onMount(() => {
    orgStore.fetchOrg();
    orgStore.fetchMembers();
    orgStore.fetchInvites();
  });

  async function handleInvite(e: Event) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    isInviting = true;
    inviteSuccessMessage = null;
    try {
      await orgStore.inviteMember(inviteEmail, inviteRole);
      inviteSuccessMessage = `Invitation sent to ${inviteEmail}.`;
      inviteEmail = "";
    } catch {
      // Error is in orgStore.error — UI already renders it via {#if orgStore.error}.
    } finally {
      isInviting = false;
    }
  }

  async function handleRevoke(inviteId: string) {
    await orgStore.revokeInvite(inviteId);
  }

  async function handleRoleChange(userId: string, role: AssignableRole) {
    await orgStore.updateMemberRole(userId, role);
  }

  async function handleRemove(userId: string, memberName: string) {
    if (!confirm(`Remove ${memberName} from this organization?`)) return;
    await orgStore.removeMember(userId);
  }

  function formatRelativeExpiry(expiresAt: string): string {
    const ms = new Date(expiresAt).getTime() - Date.now();
    const days = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
    if (days === 0) return "expires today";
    if (days === 1) return "expires in 1 day";
    return `expires in ${days} days`;
  }

  // ---------- Billing ----------

  let billingLoading = $state(false);

  const canManageBilling = $derived(
    can(authStore.user?.role ?? "", "billing.manage"),
  );

  async function openBillingPortal() {
    billingLoading = true;
    try {
      const data = await api.post<{ url: string }>("/billing/portal");
      window.location.href = data.url;
    } catch (err) {
      console.error("Failed to open billing portal:", err);
    } finally {
      billingLoading = false;
    }
  }

  // ---------- Products for sale ----------

  let productModalOpen = $state(false);
  let productSaving = $state(false);
  let productError = $state<string | null>(null);

  // Price is a TEXT input on purpose — <input type="number"> binds a
  // JS number (or null when empty), which breaks naive string handling.
  let npName = $state("");
  let npKey = $state("");
  let npDescription = $state("");
  let npType = $state<"one_time" | "subscription">("subscription");
  let npInterval = $state<"month" | "year">("month");
  let npPriceDollars = $state("");
  let npKeyTouched = $state(false);

  function slugifyKey(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  function onNameInput() {
    if (!npKeyTouched) npKey = slugifyKey(npName);
  }

  function dollarsToCents(input: string): number | null {
    const s = String(input ?? "").trim().replace(/^\$/, "");
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  }

  function openProductModal() {
    npName = "";
    npKey = "";
    npDescription = "";
    npType = "subscription";
    npInterval = "month";
    npPriceDollars = "";
    npKeyTouched = false;
    productError = null;
    productModalOpen = true;
  }

  async function saveProduct(e: Event) {
    e.preventDefault();
    const priceCents = dollarsToCents(npPriceDollars);
    if (!priceCents) {
      productError = "Enter a valid price (e.g. 29 or 29.99).";
      return;
    }
    productSaving = true;
    productError = null;
    const input: NewProductInput = {
      productKey: npKey || slugifyKey(npName),
      name: npName.trim(),
      description: npDescription.trim() || undefined,
      type: npType,
      priceCents,
      ...(npType === "subscription" ? { interval: npInterval } : {}),
    };
    try {
      await billingStore.createProduct(input);
      productModalOpen = false;
    } catch (err) {
      productError = err instanceof ApiError
        ? err.message
        : "Failed to create product.";
    } finally {
      productSaving = false;
    }
  }

  async function toggleProductActive(id: string, active: boolean) {
    try {
      await billingStore.updateProduct(id, { active });
    } catch (err) {
      console.error("Failed to update product:", err);
    }
  }

  async function buyProduct(productId: string) {
    try {
      await billingStore.startCheckout(productId);
    } catch (err) {
      console.error("Failed to start checkout:", err);
    }
  }

  function purchaseStatusLabel(status: string): string {
    return status.replace("_", " ");
  }
</script>

<div class="settings-page" data-testid="settings-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Settings</h1>
      <p class="page-subtitle">Manage your account and organization</p>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs" data-testid="settings-tabs">
    <button
      class="tab"
      class:active={activeTab === "profile"}
      onclick={() => (activeTab = "profile")}
      data-testid="settings-tab-profile"
    >
      Profile
    </button>
    <button
      class="tab"
      class:active={activeTab === "team"}
      onclick={() => (activeTab = "team")}
      data-testid="settings-tab-team"
    >
      Team
    </button>
    <button
      class="tab"
      class:active={activeTab === "billing"}
      onclick={() => (activeTab = "billing")}
      data-testid="settings-tab-billing"
    >
      Billing
    </button>
  </div>

  <!-- Profile Tab -->
  {#if activeTab === "profile"}
    <section class="card settings-section" data-testid="settings-section-profile">
      <h2 class="section-title">Profile</h2>

      {#if profileMessage}
        <div class="alert alert-success" data-testid="settings-profile-alert">
          {profileMessage}
        </div>
      {/if}

      <form onsubmit={saveProfile} class="settings-form">
        <div class="form-field">
          <label class="label" for="settings-name">Name</label>
          <input
            id="settings-name"
            class="input"
            type="text"
            bind:value={profileName}
            required
            data-testid="settings-profile-input-name"
          />
        </div>

        <div class="form-field">
          <label class="label" for="settings-email">Email</label>
          <input
            id="settings-email"
            class="input"
            type="email"
            bind:value={profileEmail}
            required
            data-testid="settings-profile-input-email"
          />
        </div>

        <button
          type="submit"
          class="btn btn-primary"
          disabled={profileSaving}
          data-testid="settings-profile-btn-save"
        >
          {profileSaving ? "Saving..." : "Save Changes"}
        </button>
      </form>
    </section>
  {/if}

  <!-- Team Tab -->
  {#if activeTab === "team"}
    <section class="card settings-section" data-testid="settings-section-team">
      <h2 class="section-title">Team Members</h2>

      <!-- Invite form (admin+) -->
      {#if canInvite}
        <form onsubmit={handleInvite} class="invite-form">
          <input
            class="input"
            type="email"
            bind:value={inviteEmail}
            placeholder="colleague@example.com"
            required
            data-testid="settings-team-input-email"
          />
          <select
            class="input invite-role"
            bind:value={inviteRole}
            data-testid="settings-team-select-role"
          >
            {#each ASSIGNABLE_ROLES as r (r)}
              <option value={r}>{roleLabel(r)}</option>
            {/each}
          </select>
          <button
            type="submit"
            class="btn btn-primary"
            disabled={isInviting}
            data-testid="settings-team-btn-invite"
          >
            {isInviting ? "Sending..." : "Send invite"}
          </button>
        </form>

        {#if inviteSuccessMessage}
          <div class="alert alert-success invite-message" data-testid="settings-team-alert-success">
            {inviteSuccessMessage}
          </div>
        {/if}
        {#if orgStore.error}
          <div class="alert alert-error invite-message" data-testid="settings-team-alert-error">
            {orgStore.error}
          </div>
        {/if}
      {/if}

      <!-- Pending invites (admin+) -->
      {#if canInvite && orgStore.pendingInvites.length > 0}
        <h3 class="subsection-title">Pending invites</h3>
        <div class="members-list" data-testid="settings-team-pending-invites">
          {#each orgStore.pendingInvites as invite (invite.id)}
            <div class="member-row" data-testid="settings-team-invite-{invite.id}">
              <div class="member-info">
                <div class="member-name">{invite.email}</div>
                <div class="member-email">
                  {roleLabel(invite.role)} · {formatRelativeExpiry(invite.expiresAt)}
                  · invited by {invite.invitedByName ?? invite.invitedByEmail}
                </div>
              </div>
              <button
                type="button"
                class="btn btn-ghost"
                onclick={() => handleRevoke(invite.id)}
                data-testid="settings-team-btn-revoke-{invite.id}"
              >
                Revoke
              </button>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Members list -->
      <h3 class="subsection-title">Members</h3>
      <div class="members-list" data-testid="settings-team-members">
        {#each orgStore.members as member (member.id)}
          {@const isSelf = member.id === authStore.user?.id}
          {@const canManageThis =
            !isSelf &&
            canManage(authStore.user?.role ?? "", member.role)}
          <div class="member-row" data-testid="settings-team-member-{member.id}">
            <div class="member-info">
              <div class="member-name">
                {member.name ?? member.email}
                {#if isSelf}<span class="text-muted">(you)</span>{/if}
              </div>
              <div class="member-email">{member.email}</div>
            </div>
            {#if canChangeRoles && canManageThis}
              <select
                class="input role-select"
                value={member.role}
                onchange={(e) =>
                  handleRoleChange(
                    member.id,
                    (e.currentTarget as HTMLSelectElement).value as AssignableRole,
                  )}
                data-testid="settings-team-select-role-{member.id}"
              >
                {#each ASSIGNABLE_ROLES as r (r)}
                  <option value={r}>{roleLabel(r)}</option>
                {/each}
              </select>
            {:else}
              <span class="badge">{roleLabel(member.role)}</span>
            {/if}
            {#if canRemove && canManageThis}
              <button
                type="button"
                class="btn btn-ghost btn-danger"
                onclick={() => handleRemove(member.id, member.name ?? member.email)}
                data-testid="settings-team-btn-remove-{member.id}"
              >
                Remove
              </button>
            {/if}
          </div>
        {:else}
          <p class="text-muted">No team members yet.</p>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Billing Tab -->
  {#if activeTab === "billing"}
    <section class="card settings-section" data-testid="settings-section-billing">
      <h2 class="section-title">Billing</h2>

      <div class="billing-info">
        <div class="billing-row">
          <span class="billing-label">Current Plan</span>
          <span class="badge">{orgStore.currentOrg?.subscriptionTier ?? "Free"}</span>
        </div>
      </div>

      <button
        class="btn btn-secondary"
        onclick={openBillingPortal}
        disabled={billingLoading}
        data-testid="settings-billing-btn-portal"
      >
        {billingLoading ? "Loading..." : "Manage Billing"}
      </button>
    </section>

    <!-- Products for sale (catalog management, admin+) -->
    {#if canManageBilling}
      <section
        class="card settings-section"
        data-testid="settings-section-products"
      >
        <div class="section-header">
          <h2 class="section-title">Products for sale</h2>
          <button
            class="btn btn-primary btn-sm"
            onclick={openProductModal}
            data-testid="settings-products-btn-new"
          >
            New product
          </button>
        </div>

        {#if billingStore.products.length === 0}
          <p class="text-muted">
            Nothing for sale yet. Create a product to start selling a one-time
            purchase or a monthly/yearly subscription -- Stripe products and
            prices are created for you.
          </p>
        {:else}
          <div class="members-list">
            {#each billingStore.products as product (product.id)}
              <div class="member-row" data-testid="settings-products-row">
                <div>
                  <div class="member-name">
                    {product.name}
                    {#if !product.active}
                      <span class="badge badge-muted">archived</span>
                    {/if}
                  </div>
                  <div class="member-email">
                    {product.productKey} · {formatPrice(product)}
                    {product.type === "one_time" ? " · one-time" : ""}
                  </div>
                </div>
                <div class="product-actions">
                  {#if product.active}
                    <button
                      class="btn btn-secondary btn-sm"
                      onclick={() => buyProduct(product.id)}
                      data-testid="settings-products-btn-buy"
                    >
                      Buy
                    </button>
                  {/if}
                  <button
                    class="btn btn-secondary btn-sm"
                    onclick={() => toggleProductActive(product.id, !product.active)}
                    data-testid="settings-products-btn-toggle"
                  >
                    {product.active ? "Archive" : "Unarchive"}
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    <!-- Purchases -->
    {#if billingStore.purchases.length > 0}
      <section
        class="card settings-section"
        data-testid="settings-section-purchases"
      >
        <h2 class="section-title">Purchases</h2>
        <div class="members-list">
          {#each billingStore.purchases as purchase (purchase.id)}
            <div class="member-row" data-testid="settings-purchases-row">
              <div>
                <div class="member-name">{purchase.productName}</div>
                <div class="member-email">
                  {new Date(purchase.createdAt).toLocaleDateString()}
                  {#if purchase.currentPeriodEnd && purchase.status !== "canceled"}
                    · renews {new Date(purchase.currentPeriodEnd).toLocaleDateString()}
                  {/if}
                </div>
              </div>
              <span
                class="badge"
                class:badge-muted={purchase.status !== "active"}
              >
                {purchaseStatusLabel(purchase.status)}
              </span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- New product modal -->
    <Modal
      open={productModalOpen}
      title="New product"
      onClose={() => (productModalOpen = false)}
      size="md"
    >
      <form class="settings-form" onsubmit={saveProduct}>
        {#if productError}
          <div class="alert alert-error" data-testid="settings-products-error">
            {productError}
          </div>
        {/if}

        <div class="form-field">
          <label class="label" for="np-name">Name</label>
          <input
            id="np-name"
            class="input"
            bind:value={npName}
            oninput={onNameInput}
            placeholder="Premium Reports"
            required
            data-testid="settings-products-input-name"
          />
        </div>

        <div class="form-field">
          <label class="label" for="np-key">Product key</label>
          <input
            id="np-key"
            class="input"
            bind:value={npKey}
            oninput={() => (npKeyTouched = true)}
            placeholder="premium_reports"
            pattern="[a-z0-9][a-z0-9_\-]*"
            required
            data-testid="settings-products-input-key"
          />
          <span class="field-hint">
            Stable identifier your code gates on. Can't change after purchases exist.
          </span>
        </div>

        <div class="form-field">
          <label class="label" for="np-description">Description (optional)</label>
          <input
            id="np-description"
            class="input"
            bind:value={npDescription}
            data-testid="settings-products-input-description"
          />
        </div>

        <div class="form-field">
          <label class="label" for="np-type">Type</label>
          <select
            id="np-type"
            class="input"
            bind:value={npType}
            data-testid="settings-products-select-type"
          >
            <option value="subscription">Subscription (recurring)</option>
            <option value="one_time">One-time purchase</option>
          </select>
        </div>

        {#if npType === "subscription"}
          <div class="form-field">
            <label class="label" for="np-interval">Billing interval</label>
            <select
              id="np-interval"
              class="input"
              bind:value={npInterval}
              data-testid="settings-products-select-interval"
            >
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
            </select>
          </div>
        {/if}

        <div class="form-field">
          <label class="label" for="np-price">
            Price (USD{npType === "subscription"
              ? npInterval === "month" ? ", per month" : ", per year"
              : ""})
          </label>
          <input
            id="np-price"
            class="input"
            bind:value={npPriceDollars}
            inputmode="decimal"
            placeholder="29.00"
            required
            data-testid="settings-products-input-price"
          />
        </div>
      </form>

      {#snippet footer()}
        <button
          class="btn btn-secondary"
          onclick={() => (productModalOpen = false)}
          data-testid="settings-products-btn-cancel"
        >
          Cancel
        </button>
        <button
          class="btn btn-primary"
          onclick={saveProduct}
          disabled={productSaving}
          data-testid="settings-products-btn-save"
        >
          {productSaving ? "Creating..." : "Create product"}
        </button>
      {/snippet}
    </Modal>
  {/if}
</div>

<style>
  .settings-page {
    max-width: 640px;
  }

  .tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: var(--space-lg);
  }

  .tab {
    padding: var(--space-sm) var(--space-md);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-family: var(--font-sans);
    transition: color 0.15s, border-color 0.15s;
  }

  .tab:hover {
    color: var(--color-text-secondary);
  }

  .tab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
  }

  .settings-section {
    margin-bottom: var(--space-lg);
  }

  .section-title {
    font-size: var(--text-base);
    font-weight: 600;
    margin-bottom: var(--space-lg);
  }

  .settings-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .form-field {
    display: flex;
    flex-direction: column;
  }

  .settings-form .btn {
    align-self: flex-start;
  }

  /* Team */
  .invite-form {
    display: flex;
    gap: var(--space-sm);
    margin-bottom: var(--space-md);
  }

  .invite-form .input {
    flex: 1;
  }

  .invite-role {
    width: 120px;
    flex: none;
  }

  .invite-message {
    margin-bottom: var(--space-md);
  }

  .members-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .member-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-sm) 0;
    border-bottom: 1px solid var(--color-border);
  }

  .member-row:last-child {
    border-bottom: none;
  }

  .member-name {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-text);
  }

  .member-email {
    font-size: var(--text-xs);
    color: var(--color-muted);
  }

  .text-muted {
    font-size: var(--text-sm);
    color: var(--color-muted);
  }

  /* Billing */
  .billing-info {
    margin-bottom: var(--space-lg);
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-lg);
  }

  .section-header .section-title {
    margin-bottom: 0;
  }

  .btn-sm {
    padding: 4px 10px;
    font-size: var(--text-xs);
  }

  .product-actions {
    display: flex;
    gap: var(--space-sm);
    align-items: center;
  }

  .badge-muted {
    opacity: 0.6;
    margin-left: var(--space-sm);
  }

  .field-hint {
    font-size: var(--text-xs);
    color: var(--color-muted);
    margin-top: 4px;
  }

  .billing-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-sm) 0;
  }

  .billing-label {
    font-size: var(--text-sm);
    color: var(--color-muted);
  }

  .alert {
    margin-bottom: var(--space-md);
  }
</style>
