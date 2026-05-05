<!--
  Dev panel — visual companion to the /api/dev/app-state endpoint.

  Mounts as a floating button at bottom-right, only when the app is
  running in dev mode (`import.meta.env.DEV`). Clicking opens an
  expanded panel showing every store's live state, recent client
  errors, current route, and viewport.

  This component is the HUMAN side of the dev-panel pipeline. The
  AGENT side (the verification + implement subagents in alchemist-ai)
  reads the same data via `curl http://localhost:$PORT/api/dev/app-state`.
  Same source of truth, two consumers.

  No-op in production: the {#if !PROD} gate prevents the markup from
  rendering, AND Vite's dead-code elimination drops the imported
  modules from the production bundle.

  Customer apps inherit this component automatically — it's mounted
  in App.svelte. Customers should not need to touch it.
-->
<script lang="ts">
  import {
    getStoreSnapshots,
    listStoreNames,
  } from "../lib/devpanel/store.svelte";
  import { getRecentClientErrors } from "../lib/devpanel/errors";

  const PROD = import.meta.env.PROD;

  // Local UI state. Not registered via defineStore — it's the
  // panel's own UI state, not app state. (defineStore is for state
  // that should be visible in the panel; defining the panel's
  // own state in itself would be a fun loop but not useful.)
  let isOpen = $state(false);
  let snapshotTick = $state(0);

  // Re-render the panel on a 1s tick when it's open. We don't hook
  // into subscribeAll here because the panel only needs to be live
  // when the human is looking at it — polling at 1s is plenty,
  // avoids reactive cascades when many stores change at once.
  let pollInterval: number | null = null;
  $effect(() => {
    if (!isOpen) return;
    pollInterval = window.setInterval(() => {
      snapshotTick += 1;
    }, 1000);
    return () => {
      if (pollInterval !== null) clearInterval(pollInterval);
      pollInterval = null;
    };
  });

  // Re-derive on every snapshotTick. The void reference forces
  // Svelte to re-run when snapshotTick changes; the actual values
  // are read from the registry which has the up-to-date snapshots.
  const stores = $derived.by(() => {
    void snapshotTick;
    return getStoreSnapshots();
  });
  const storeNames = $derived.by(() => {
    void snapshotTick;
    return listStoreNames();
  });
  const errors = $derived.by(() => {
    void snapshotTick;
    return getRecentClientErrors();
  });
</script>

{#if !PROD}
  <div class="devpanel-root" data-testid="devpanel-root">
    {#if !isOpen}
      <button
        type="button"
        class="devpanel-toggle"
        onclick={() => (isOpen = true)}
        data-testid="devpanel-toggle"
        title="Open dev panel ({storeNames.length} stores)"
        aria-label="Open dev panel"
      >
        🛠 {storeNames.length}
      </button>
    {:else}
      <div class="devpanel-panel" data-testid="devpanel-panel">
        <div class="devpanel-header">
          <strong>Dev Panel</strong>
          <span class="devpanel-meta">
            {storeNames.length} stores · {errors.length} errors
          </span>
          <button
            type="button"
            class="devpanel-close"
            onclick={() => (isOpen = false)}
            data-testid="devpanel-close"
            aria-label="Close dev panel"
          >
            ×
          </button>
        </div>

        <div class="devpanel-body">
          <section>
            <h4>Stores</h4>
            {#if storeNames.length === 0}
              <p class="devpanel-empty">
                No stores registered via <code>defineStore</code>. See
                <code>web/src/lib/devpanel/store.svelte.ts</code>.
              </p>
            {:else}
              {#each storeNames as name (name)}
                <details class="devpanel-store">
                  <summary>
                    <code>{name}</code>
                  </summary>
                  <pre>{JSON.stringify(stores[name], null, 2)}</pre>
                </details>
              {/each}
            {/if}
          </section>

          {#if errors.length > 0}
            <section>
              <h4>Recent client errors</h4>
              {#each errors as err, i (i)}
                <div class="devpanel-error">
                  <div class="devpanel-error-meta">
                    {err.timestamp} · {err.source}
                  </div>
                  <div class="devpanel-error-msg">{err.message}</div>
                  {#if err.stack}
                    <pre class="devpanel-stack">{err.stack
                        .split("\n")
                        .slice(0, 5)
                        .join("\n")}</pre>
                  {/if}
                </div>
              {/each}
            </section>
          {/if}

          <section class="devpanel-hint">
            Same data is available to the agent via
            <code>curl localhost:$PORT/api/dev/app-state</code>.
          </section>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .devpanel-root {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 999999;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    color: #e2e8f0;
  }

  .devpanel-toggle {
    background: #0f172a;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 999px;
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .devpanel-toggle:hover {
    background: #1e293b;
  }

  .devpanel-panel {
    width: 420px;
    max-width: calc(100vw - 2rem);
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .devpanel-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #334155;
    background: #1e293b;
    border-radius: 8px 8px 0 0;
  }
  .devpanel-meta {
    flex: 1;
    color: #94a3b8;
    font-size: 11px;
  }
  .devpanel-close {
    background: transparent;
    color: #e2e8f0;
    border: none;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .devpanel-close:hover {
    color: #f87171;
  }

  .devpanel-body {
    padding: 0.5rem 0.75rem;
  }

  .devpanel-body section {
    margin-bottom: 1rem;
  }
  .devpanel-body h4 {
    margin: 0 0 0.5rem;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
  }

  .devpanel-empty {
    color: #94a3b8;
    margin: 0;
  }
  .devpanel-empty code {
    background: #1e293b;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .devpanel-store {
    margin-bottom: 0.25rem;
  }
  .devpanel-store summary {
    cursor: pointer;
    padding: 2px 0;
  }
  .devpanel-store summary code {
    color: #93c5fd;
  }
  .devpanel-store pre {
    background: #1e293b;
    padding: 0.5rem;
    border-radius: 4px;
    margin: 0.25rem 0 0;
    overflow-x: auto;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .devpanel-error {
    border-left: 3px solid #f87171;
    padding-left: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .devpanel-error-meta {
    color: #94a3b8;
    font-size: 10px;
  }
  .devpanel-error-msg {
    color: #fca5a5;
    margin: 2px 0;
  }
  .devpanel-stack {
    background: #1e293b;
    padding: 0.25rem 0.5rem;
    margin: 0;
    font-size: 10px;
    color: #cbd5e1;
    overflow-x: auto;
  }

  .devpanel-hint {
    color: #94a3b8;
    font-size: 11px;
    border-top: 1px solid #334155;
    padding-top: 0.5rem;
  }
  .devpanel-hint code {
    color: #93c5fd;
  }
</style>
