<script lang="ts">
  /**
   * Small light/dark toggle. Persisted to localStorage via
   * web/src/stores/theme.svelte.ts — DEFAULT LIGHT, no OS-auto.
   */
  import { themeStore } from "../stores/theme.svelte";
</script>

<button
  type="button"
  class="theme-toggle"
  onclick={() => themeStore.toggle()}
  aria-pressed={themeStore.isDark}
  aria-label={themeStore.isDark ? "Switch to light theme" : "Switch to dark theme"}
  title={themeStore.isDark ? "Switch to light theme" : "Switch to dark theme"}
  data-testid="theme-toggle-button"
>
  {#if themeStore.isDark}
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  {:else}
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  {/if}
</button>

<style>
  /*
   * A single tiny inline control (icon-only chip) — the sanctioned
   * exception in CLAUDE.md's "Hover/interactive transitions animate
   * only compositor properties" rule allows a `color` paint transition
   * here (painted area is a few pixels). Never add background-color /
   * box-shadow / border-color to this list.
   */
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: color 0.15s, transform 0.1s;
  }

  .theme-toggle:hover {
    color: var(--color-text);
  }

  .theme-toggle:active {
    transform: scale(0.94);
  }
</style>
