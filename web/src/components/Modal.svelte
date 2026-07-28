<script lang="ts">
  /**
   * Modal — the design-system dialog primitive. Use this for EVERY modal /
   * dialog / overlay. Do not hand-roll `.modal-backdrop` + `position: fixed`
   * markup in a route: it silently breaks the moment an ancestor gains a
   * `transform`/`overflow` (see ../lib/portal.ts for why). This component
   * portals out to `#overlay-root` so it always resolves against the viewport,
   * and wires scroll-lock + ESC-to-close + focus management for you.
   *
   * Usage (in a route component):
   *   import Modal from "../components/Modal.svelte";
   *   let open = $state(false);
   *   ...
   *   <button onclick={() => (open = true)}>New thing</button>
   *   <Modal {open} title="New thing" onClose={() => (open = false)}>
   *     <p>Body content goes here.</p>
   *     {#snippet footer()}
   *       <button class="btn btn-secondary" onclick={() => (open = false)}>Cancel</button>
   *       <button class="btn btn-primary" onclick={save}>Save</button>
   *     {/snippet}
   *   </Modal>
   */
  import type { Snippet } from "svelte";
  import { portal } from "../lib/portal";
  import { modalBehavior } from "../lib/modal";

  interface Props {
    /** Whether the modal is shown. Bind your own `$state` boolean. */
    open: boolean;
    /** Title rendered in the header. Omit to render a header-less modal. */
    title?: string;
    /** Called when the user dismisses (close button, backdrop, or ESC). */
    onClose: () => void;
    /** Max-width preset. */
    size?: "sm" | "md" | "lg";
    /** Clicking the dimmed backdrop closes the modal. Default true. */
    closeOnBackdrop?: boolean;
    /** Body content. */
    children: Snippet;
    /** Optional footer (typically action buttons), right-aligned. */
    footer?: Snippet;
  }

  let {
    open,
    title,
    onClose,
    size = "md",
    closeOnBackdrop = true,
    children,
    footer,
  }: Props = $props();

  // Close only when the dimmed backdrop itself is clicked, not when a click
  // bubbles up from inside the dialog. Using a target check (rather than
  // stopPropagation on the inner node) keeps the dialog free of a stray
  // click handler, which an a11y linter would (rightly) flag.
  function onBackdropClick(e: MouseEvent) {
    if (closeOnBackdrop && e.target === e.currentTarget) onClose();
  }
</script>

{#if open}
  <div
    class="modal-backdrop"
    onclick={onBackdropClick}
    role="presentation"
    data-testid="modal-backdrop"
    use:portal
    use:modalBehavior={{ onClose }}
  >
    <div
      class="modal modal-{size}"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      data-testid="modal"
    >
      {#if title}
        <div class="modal-header">
          <h2 class="modal-title">{title}</h2>
          <button
            class="modal-close"
            type="button"
            onclick={onClose}
            aria-label="Close"
            data-testid="modal-close"
          >
            ✕
          </button>
        </div>
      {/if}

      <div class="modal-body" data-testid="modal-body">
        {@render children()}
      </div>

      {#if footer}
        <div class="modal-footer">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* The backdrop resolves against the VIEWPORT only because this node is
     portalled into #overlay-root (a body child). Do not rely on this CSS
     working from inside .app-main — that is the trap this component avoids. */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-md);
    /* Below the security-critical session-timeout overlay (9999) and the
       dev panel (999999); above all in-page content. */
    z-index: 1000;
  }

  .modal {
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: 0 24px 48px -20px rgba(0, 0, 0, 0.28), 0 8px 20px -12px rgba(0, 0, 0, 0.16);
    width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-sm {
    max-width: 420px;
  }
  .modal-md {
    max-width: 640px;
  }
  .modal-lg {
    max-width: 860px;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-lg) var(--space-xl);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .modal-title {
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--color-text);
    margin: 0;
  }

  .modal-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: var(--text-lg);
    line-height: 1;
    padding: 4px;
    border-radius: var(--radius-sm);
    transition: color 0.15s, background 0.15s;
  }
  .modal-close:hover,
  .modal-close:focus-visible {
    color: var(--color-text);
    background: var(--color-surface);
    outline: none;
  }

  .modal-body {
    padding: var(--space-lg) var(--space-xl);
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    padding: var(--space-md) var(--space-xl);
    border-top: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  @media (max-width: 600px) {
    .modal-header,
    .modal-footer {
      padding-left: var(--space-md);
      padding-right: var(--space-md);
    }
    .modal-body {
      padding: var(--space-md);
    }
  }
</style>
