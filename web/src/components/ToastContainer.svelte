<script lang="ts">
  /**
   * ToastContainer — mount ONCE (see App.svelte). Renders the live queue
   * from `toastStore` (web/src/stores/toast.svelte.ts) as a stack of
   * dismissible notifications, portalled to #overlay-root so it always
   * resolves against the viewport (same rationale as <Modal>, see
   * ../lib/portal.ts).
   *
   * A11y: the stack is a single `aria-live="polite"` region so screen
   * readers announce new toasts without stealing focus; each toast is
   * `role="status"` and its dismiss button is a real, keyboard-reachable
   * `<button>`. Enter/exit motion is a transform+opacity fly (compositor-
   * only, no layout/paint properties — see CLAUDE.md's hover-transition
   * rule) and collapses to an instant show/hide under
   * prefers-reduced-motion.
   */
  import { fly } from "svelte/transition";
  import { toastStore } from "../stores/toast.svelte";
  import { portal } from "../lib/portal";

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const flyParams = prefersReducedMotion
    ? { duration: 0 }
    : { y: 16, duration: 200 };
</script>

<div
  class="toast-stack"
  use:portal
  aria-live="polite"
  aria-atomic="false"
  data-testid="toast-stack"
>
  {#each toastStore.toasts as toast (toast.id)}
    <div
      class="toast toast-{toast.variant}"
      role="status"
      in:fly={flyParams}
      out:fly={flyParams}
      data-testid="toast-{toast.variant}"
    >
      <span class="toast-message">{toast.message}</span>
      <button
        type="button"
        class="toast-dismiss"
        aria-label="Dismiss notification"
        onclick={() => toastStore.dismiss(toast.id)}
        data-testid="toast-dismiss"
      >
        ✕
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-stack {
    position: fixed;
    bottom: var(--space-lg, 24px);
    right: var(--space-lg, 24px);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm, 8px);
    max-width: min(360px, calc(100vw - 2 * var(--space-lg, 24px)));
  }

  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-sm, 8px);
    padding: var(--space-sm, 8px) var(--space-md, 16px);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-lg);
    font-size: var(--text-sm);
    font-family: var(--font-sans);
    border: 1px solid var(--color-border);
    background: var(--color-surface-raised);
    color: var(--color-text);
  }

  .toast-message {
    flex: 1;
  }

  .toast-dismiss {
    flex-shrink: 0;
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    opacity: 0.6;
    font-size: var(--text-sm);
    line-height: 1;
    padding: 2px;
    border-radius: var(--radius-sm);
  }

  .toast-dismiss:hover,
  .toast-dismiss:focus-visible {
    opacity: 1;
    outline: none;
  }

  .toast-success {
    background: var(--color-success-bg);
    border-color: var(--color-success-border);
    color: var(--color-success);
  }

  .toast-error {
    background: var(--color-error-bg);
    border-color: var(--color-error-border);
    color: var(--color-error);
  }

  .toast-warning {
    background: var(--color-warning-bg);
    border-color: var(--color-warning-border);
    color: var(--color-warning);
  }

  .toast-info {
    background: var(--color-info-bg);
    border-color: var(--color-info-border);
    color: var(--color-info);
  }

  @media (max-width: 480px) {
    .toast-stack {
      left: var(--space-md, 16px);
      right: var(--space-md, 16px);
      bottom: var(--space-md, 16px);
      max-width: none;
    }
  }
</style>
