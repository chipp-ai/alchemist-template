<script lang="ts">
  import { onMount } from "svelte";
  import Router, { location, push, replace } from "svelte-spa-router";
  import routes, { publicRoutes } from "./routes";
  import { authStore } from "./stores/auth.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import DevPanel from "./components/DevPanel.svelte";

  // One-shot session check on mount.
  //
  // Use onMount, NOT $effect. checkAuth() synchronously writes to the
  // auth store (`state.isLoading = true`), and Svelte 5's $effect tracks
  // those writes as deps via its internal read-for-comparison — so the
  // effect ends up depending on isLoading, the finally-block flips
  // isLoading back to false, the effect re-runs, calls checkAuth again,
  // and you get an unbounded /auth/me loop. (Reproduced live: 24K
  // /auth/me requests in 13min before this fix.) onMount fires exactly
  // once after mount with no reactive tracking — the right tool for a
  // one-shot side effect. See CLAUDE.md → "Stores: $effect on mount
  // is a trap; use onMount".
  onMount(() => {
    authStore.checkAuth();
  });

  // Redirect to login when not authenticated and on a protected route
  $effect(() => {
    if (authStore.isLoading) return;
    const path = $location;

    if (!authStore.isAuthenticated && !publicRoutes.has(path)) {
      replace("/login");
    }
  });

  const isPublicRoute = $derived(publicRoutes.has($location));
  const showLayout = $derived(!authStore.isLoading && authStore.isAuthenticated && !isPublicRoute);
</script>

{#if authStore.isLoading}
  <div class="loading-screen" data-testid="app-loading">
    <div class="loading-spinner"></div>
  </div>
{:else if showLayout}
  <div class="app-layout" data-testid="app-layout">
    <Sidebar />
    <main class="app-main">
      <Router {routes} />
    </main>
  </div>
{:else}
  <Router {routes} />
{/if}

<!--
  Dev panel: floating button + expanded view of every store + recent
  client errors. Mounts on EVERY route — auth-gated and public alike,
  so the agent can see app state during signup/login flows too. The
  component itself short-circuits in production via import.meta.env.PROD.
-->
<DevPanel />

<style>
  .loading-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
  }

  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .app-layout {
    display: flex;
    height: 100vh;
  }

  .app-main {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-xl);
  }
</style>
