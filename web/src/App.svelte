<script lang="ts">
  import { onMount } from "svelte";
  import Router, { location, push, replace } from "svelte-spa-router";
  import routes, { isPublicRoute } from "./routes";
  import { authStore } from "./stores/auth.svelte";
  import { sessionTimeoutStore } from "./stores/sessionTimeout.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import SessionTimeoutWarning from "./components/SessionTimeoutWarning.svelte";
  import DevPanel from "./components/DevPanel.svelte";
  import ToastContainer from "./components/ToastContainer.svelte";
  import { initRevealOnScroll } from "./lib/reveal-dom";
  import { navigateWithTransition } from "./lib/view-transitions-dom";

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
    // Arm the staggered reveal-on-scroll utility (web/src/motion.css'
    // `.reveal` class) for whatever's on the initial screen. No-op when
    // IntersectionObserver is unsupported or prefers-reduced-motion is
    // set — see web/src/lib/reveal.ts for the fail-safe contract.
    initRevealOnScroll();
  });

  // Redirect to login when not authenticated and on a protected route.
  // Wrapped in a View Transition (web/src/lib/view-transitions.ts) so
  // browsers that support the API get a cross-fade instead of a hard cut
  // — degrades to a plain replace() everywhere else (unsupported browser,
  // prefers-reduced-motion).
  $effect(() => {
    if (authStore.isLoading) return;
    const path = $location;

    if (!authStore.isAuthenticated && !isPublicRoute(path)) {
      navigateWithTransition(replace, "/login");
    }
  });

  // Re-scan for newly-mounted `.reveal` elements after every route change.
  // initRevealOnScroll() is idempotent — it skips anything already carrying
  // data-reveal-observed — so calling it on each navigation is safe.
  $effect(() => {
    void $location;
    initRevealOnScroll();
  });

  // HIPAA session-timeout: arm activity tracking + the warning modal
  // ONLY when the customer pod was provisioned with HIPAA on (the
  // /auth/me response carries hipaaEnabled, sourced from the pod's
  // HIPAA_ENABLED env var). Mount/unmount the store as the user
  // signs in / signs out so the listeners don't leak across sessions.
  $effect(() => {
    const shouldArm =
      !authStore.isLoading &&
      authStore.isAuthenticated &&
      authStore.hipaaEnabled;

    if (shouldArm && !sessionTimeoutStore.active) {
      sessionTimeoutStore.init();
    } else if (!shouldArm && sessionTimeoutStore.active) {
      sessionTimeoutStore.destroy();
    }
  });

  const onPublicRoute = $derived(isPublicRoute($location));
  const showLayout = $derived(!authStore.isLoading && authStore.isAuthenticated && !onPublicRoute);
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
  HIPAA session-timeout warning. Renders only when the store reports
  showWarning=true; the store itself only arms when the deployment is
  HIPAA-enabled. On non-HIPAA deployments this stays inert.
-->
<SessionTimeoutWarning />

<!--
  Toast stack: mounts on every route (auth-gated and public alike) so
  any part of the app can call toastStore.show(...) and have it render.
  See web/src/stores/toast.svelte.ts + web/src/components/ToastContainer.svelte.
-->
<ToastContainer />

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
