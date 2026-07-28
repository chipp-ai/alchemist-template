<script lang="ts">
  import { link, location } from "svelte-spa-router";
  import { authStore } from "../stores/auth.svelte";
  import { orgStore } from "../stores/organization.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";

  const navItems = [
    { path: "/", label: "Dashboard", icon: "grid" },
    { path: "/inbound-emails", label: "Inbound Email", icon: "mail" },
    { path: "/settings", label: "Settings", icon: "settings" },
  ];

  function isActive(itemPath: string, currentPath: string): boolean {
    if (itemPath === "/") return currentPath === "/";
    return currentPath.startsWith(itemPath);
  }
</script>

<nav class="sidebar" data-testid="sidebar">
  <div class="sidebar-header">
    <span class="sidebar-logo" data-testid="sidebar-logo">
      {orgStore.currentOrg?.name ?? "App"}
    </span>
  </div>

  <div class="sidebar-nav">
    {#each navItems as item}
      <a
        href="#{item.path}"
        class="sidebar-link"
        class:active={isActive(item.path, $location)}
        data-testid="sidebar-nav-{item.icon}"
      >
        <span class="sidebar-icon">{@html getIcon(item.icon)}</span>
        <span>{item.label}</span>
      </a>
    {/each}
  </div>

  <div class="sidebar-footer">
    <div class="sidebar-user" data-testid="sidebar-user">
      <div class="sidebar-user-avatar">
        {authStore.user?.name?.charAt(0).toUpperCase() ?? "?"}
      </div>
      <div class="sidebar-user-info">
        <div class="sidebar-user-name">{authStore.user?.name ?? ""}</div>
        <div class="sidebar-user-email">{authStore.user?.email ?? ""}</div>
      </div>
      <ThemeToggle />
    </div>
    <button
      class="btn btn-ghost sidebar-logout"
      onclick={() => authStore.logout()}
      data-testid="sidebar-btn-logout"
    >
      Log out
    </button>
  </div>
</nav>

<script lang="ts" module>
  function getIcon(name: string): string {
    const icons: Record<string, string> = {
      grid: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
      layers: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
      folder: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
      mail: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
      settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    };
    return icons[name] ?? "";
  }
</script>

<style>
  .sidebar {
    width: 240px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .sidebar-header {
    padding: var(--space-lg) var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }

  .sidebar-logo {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--color-text);
  }

  .sidebar-nav {
    flex: 1;
    padding: var(--space-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sidebar-link {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: none;
    transition: background-color 0.15s, color 0.15s;
  }

  .sidebar-link:hover {
    background: var(--color-bg);
    color: var(--color-text);
    text-decoration: none;
  }

  .sidebar-link.active {
    background: var(--color-bg);
    color: var(--color-text);
    font-weight: 500;
  }

  .sidebar-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: inherit;
  }

  .sidebar-footer {
    padding: var(--space-md);
    border-top: 1px solid var(--color-border);
  }

  .sidebar-user {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    margin-bottom: var(--space-sm);
  }

  .sidebar-user-avatar {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    background: var(--color-accent);
    color: var(--color-accent-text);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-sm);
    font-weight: 600;
    flex-shrink: 0;
  }

  .sidebar-user-info {
    min-width: 0;
  }

  .sidebar-user-name {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sidebar-user-email {
    font-size: var(--text-xs);
    color: var(--color-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sidebar-logout {
    width: 100%;
    font-size: var(--text-xs);
  }
</style>
