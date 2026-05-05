<script lang="ts">
  import { onMount } from "svelte";
  import { authStore } from "../stores/auth.svelte";
  import { orgStore } from "../stores/organization.svelte";

  // One-shot fetch on mount. Use onMount, NOT $effect — see CLAUDE.md
  // → "Stores: $effect on mount is a trap; use onMount". fetchOrg()
  // writes `state.currentOrg`, and inside an $effect that write would
  // attribute as a dep and re-fetch in a tight loop.
  onMount(() => {
    orgStore.fetchOrg();
  });
</script>

<div class="dashboard" data-testid="dashboard-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Dashboard</h1>
      <p class="page-subtitle">
        Welcome back, {authStore.user?.name ?? "there"}
      </p>
    </div>
  </div>

  {#if orgStore.currentOrg}
    <div class="stats-grid">
      <div class="card stat-card" data-testid="dashboard-card-plan">
        <div class="stat-label">Current Plan</div>
        <div class="stat-value">
          <span class="badge">{orgStore.currentOrg.subscriptionTier}</span>
        </div>
      </div>

      <div class="card stat-card" data-testid="dashboard-card-members">
        <div class="stat-label">Team Members</div>
        <div class="stat-value">--</div>
        <div class="stat-hint">
          <a href="#/settings" data-testid="dashboard-link-team">Manage team</a>
        </div>
      </div>
    </div>
  {/if}

  <section class="recent-section">
    <h2 class="section-title">Recent Activity</h2>
    <div class="card">
      <div class="empty-state" data-testid="dashboard-empty-activity">
        <p>No recent activity yet.</p>
      </div>
    </div>
  </section>
</div>

<style>
  .dashboard {
    max-width: 960px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-md);
    margin-bottom: var(--space-xl);
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .stat-label {
    font-size: var(--text-sm);
    color: var(--color-muted);
  }

  .stat-value {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--color-text);
  }

  .stat-hint {
    font-size: var(--text-xs);
    color: var(--color-muted);
  }

  .stat-hint a {
    color: var(--color-text-secondary);
  }

  .stat-hint a:hover {
    color: var(--color-text);
  }

  .recent-section {
    margin-top: var(--space-lg);
  }

  .section-title {
    font-size: var(--text-lg);
    font-weight: 600;
    margin-bottom: var(--space-md);
  }
</style>
