<script lang="ts">
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
