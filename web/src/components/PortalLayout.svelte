<!--
  PortalLayout: the END-USER shell.

  Deliberately not the admin layout. No sidebar, no Dashboard, no
  Settings, no Inbound Email: a portal user sees their own record and a
  way out, and nothing that would tempt them (or an attacker holding a
  forwarded link) toward a surface they cannot use anyway.

  This is a SHELL, not a page. Wrap a portal route in it:

    <PortalLayout>
      {#snippet children()}
        ...your content...
      {/snippet}
    </PortalLayout>

  Adding a portal page means adding a route under /portal that uses this
  layout. Do NOT build a second portal shell, a second login, or a second
  session mechanism; the lane already has all three.
-->
<script lang="ts">
  import { authStore } from "../stores/auth.svelte";
  import { onMount } from "svelte";
  import { applyBrandLogos } from "../lib/brand-logo";
  import ThemeToggle from "./ThemeToggle.svelte";
  // Feature links for end users (web/src/features/support.ts). Empty in
  // the base template, so the header shows no extra link until the
  // app-support pack replaces the stub.
  import { supportNavItems } from "../features/support";

  let {
    /** Brand line in the header. */
    title = "Your portal",
    children,
  }: {
    title?: string;
    // deno-lint-ignore no-explicit-any
    children?: any;
  } = $props();

  // Sign out lands back on the portal's own page, never the admin login
  // form. An end user who signs out should see "ask for a new link", not
  // a workspace sign-in they have no business completing.
  function signOut() {
    authStore.logout("#/portal");
  }

  onMount(applyBrandLogos);
</script>

<div class="portal-shell" data-testid="portal-layout">
  <header class="portal-header">
    <span class="portal-brand" data-testid="portal-brand">
      <img data-brand-logo="light" class="brand-logo-img" alt={title} hidden data-testid="portal-brand-logo" />
      <span class="brand-logo-name">{title}</span>
    </span>
    <div class="portal-header-actions">
      {#each supportNavItems as item (item.path)}
        <a
          class="btn btn-ghost portal-link"
          href={"#" + item.path}
          data-testid={"portal-nav-" + item.testId}
        >
          {item.label}
        </a>
      {/each}
      <ThemeToggle />
      {#if authStore.isAuthenticated}
        <span class="portal-identity" data-testid="portal-identity">
          {authStore.user?.email ?? ""}
        </span>
        <button
          class="btn btn-ghost portal-signout"
          onclick={signOut}
          data-testid="portal-btn-signout"
        >
          Sign out
        </button>
      {/if}
    </div>
  </header>

  <main class="portal-main" data-testid="portal-main">
    {@render children?.()}
  </main>
</div>

<style>
  .portal-shell {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    background: var(--color-bg);
  }

  .portal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-md) var(--space-lg);
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
  }

  .brand-logo-img {
    max-height: 28px;
    max-width: 160px;
    object-fit: contain;
  }
  .brand-logo-img[hidden] {
    display: none;
  }
  .brand-logo-img:not([hidden]) + .brand-logo-name {
    display: none;
  }

  .portal-brand {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-heading);
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--color-text);
  }

  .portal-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .portal-identity {
    font-size: var(--text-sm);
    color: var(--color-muted);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .portal-signout,
  .portal-link {
    font-size: var(--text-sm);
  }

  .portal-main {
    flex: 1;
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding: var(--space-xl) var(--space-md);
  }
</style>
