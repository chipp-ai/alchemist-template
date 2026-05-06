<script lang="ts">
  // Non-dismissable warning modal shown 5 min before HIPAA session
  // timeout. Renders only when sessionTimeoutStore.showWarning. The
  // user's only ways out are "Stay signed in" (resets the window) or
  // "Log out" (force logout). No backdrop click, no Esc — clicking
  // through accidentally would defeat the purpose.

  import { sessionTimeoutStore } from "../stores/sessionTimeout.svelte";

  function fmt(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
</script>

{#if sessionTimeoutStore.showWarning}
  <div class="overlay" data-testid="session-timeout-overlay">
    <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="sto-title">
      <h2 id="sto-title">You're about to be signed out</h2>
      <p>
        For security, this app signs you out after a period of inactivity.
        You will be logged out in
        <strong data-testid="session-timeout-countdown">{fmt(sessionTimeoutStore.secondsRemaining)}</strong>.
      </p>
      <div class="actions">
        <button
          type="button"
          class="btn btn-primary"
          onclick={() => sessionTimeoutStore.stayActive()}
          data-testid="session-timeout-stay"
        >
          Stay signed in
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          onclick={() => sessionTimeoutStore.forceLogout()}
          data-testid="session-timeout-logout"
        >
          Log out now
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  .modal {
    background: var(--color-card, #fff);
    border-radius: 8px;
    padding: var(--space-lg, 24px);
    max-width: 420px;
    width: 90%;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  }
  .modal h2 {
    margin: 0 0 var(--space-sm, 12px) 0;
    font-size: var(--text-lg, 18px);
    font-weight: 600;
  }
  .modal p {
    margin: 0 0 var(--space-md, 16px) 0;
    color: var(--color-muted, #666);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    gap: var(--space-sm, 8px);
    justify-content: flex-end;
  }
</style>
