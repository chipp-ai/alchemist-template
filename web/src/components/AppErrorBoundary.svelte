<script lang="ts">
  /**
   * AppErrorBoundary: catches an error while the app renders, so one broken
   * page shows a fallback instead of a blank screen. Mounted once around the
   * routed pages in App.svelte.
   *
   * Every caught error is reported to the Chipp Builder preview
   * (lib/app-error.ts). Inside that preview the Builder's dev overlay is the
   * error screen (it shows the stack and can ask the agent to fix it), so
   * this boundary renders only one plain line there. Everywhere else it
   * renders the full fallback with "Try again" and "Reload".
   *
   * A <svelte:boundary> catches errors thrown while rendering and in
   * effects, not in event handlers or after an await; the Builder preview
   * catches those itself (window error and unhandledrejection).
   */
  import type { Snippet } from "svelte";
  import { isInBuilderPreview, reportAppError, toAppErrorDetail } from "../lib/app-error";

  let { children }: { children: Snippet } = $props();

  const inBuilderPreview = isInBuilderPreview();

  function handleError(error: unknown) {
    reportAppError(error);
    if (!inBuilderPreview) console.error("[AppErrorBoundary]", error);
  }
</script>

<svelte:boundary onerror={handleError}>
  {@render children()}

  {#snippet failed(error, reset)}
    {#if inBuilderPreview}
      <p class="error-line" role="alert" data-testid="app-error-preview-line">
        Something went wrong: {toAppErrorDetail(error).message}
      </p>
    {:else}
      <div class="error-fallback" role="alert" data-testid="app-error-fallback">
        <h1 class="error-title">Something went wrong</h1>
        <p class="error-message">{toAppErrorDetail(error).message}</p>
        <div class="error-actions">
          <button class="btn btn-primary" type="button" onclick={reset} data-testid="app-error-retry">Try again</button>
          <button class="btn btn-secondary" type="button" onclick={() => location.reload()} data-testid="app-error-reload">
            Reload
          </button>
        </div>
      </div>
    {/if}
  {/snippet}
</svelte:boundary>

<style>
  .error-line {
    margin: 0;
    padding: var(--space-sm) var(--space-md);
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error-fallback {
    max-width: 32rem;
    margin: var(--space-xl) auto;
    padding: var(--space-lg);
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
  }

  .error-title {
    margin: 0;
    font-family: var(--font-heading);
    font-size: var(--text-lg);
    color: var(--color-text);
  }

  .error-message {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }

  .error-actions {
    display: flex;
    gap: var(--space-sm);
  }
</style>
