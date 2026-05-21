<script lang="ts">
  import { onMount } from "svelte";
  import { recordClientRoute404 } from "$lib/observability/breadcrumbs";

  // Fire a `client.route.404` observability breadcrumb so agents
  // calling `open_url` against an unknown SPA route get a digest
  // entry instead of an empty result. Without this, an agent that
  // navigates to a path that the SPA renders as "Page not found"
  // sees zero network events — server.http only captures real
  // network round-trips, and the SPA's NotFound rendering is
  // entirely client-side.
  onMount(() => {
    recordClientRoute404(location.pathname + location.search + location.hash);
  });
</script>

<div class="not-found" data-testid="not-found-page">
  <h1>404</h1>
  <p>Page not found.</p>
  <a href="#/" class="btn btn-secondary" data-testid="not-found-link-home">
    Back to Dashboard
  </a>
</div>

<style>
  .not-found {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    text-align: center;
    gap: var(--space-md);
  }

  h1 {
    font-size: 4rem;
    font-weight: 700;
    color: var(--color-muted);
    line-height: 1;
  }

  p {
    font-size: var(--text-lg);
    color: var(--color-text-secondary);
  }
</style>
