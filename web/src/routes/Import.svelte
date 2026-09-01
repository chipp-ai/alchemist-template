<script lang="ts">
  /**
   * Import -- the page around the wizard.
   *
   * It does three things the wizard does not: pick which import to run
   * when the app registers more than one, show what has been imported
   * before, and say plainly when a person's role cannot run an import
   * rather than hiding it.
   *
   * The wizard itself is `<ImportWizard definition="..." />` and knows
   * nothing about this page. Drop it beside any list ("Import people"
   * next to the roster) instead of sending somebody here, if that reads
   * better in your app.
   */
  import { onMount } from "svelte";
  import ImportWizard from "../components/ImportWizard.svelte";
  import {
    getImportDefinitionsQuery,
    getImportSessionsQuery,
    type ImportSessionSummary,
    importsStore,
  } from "../stores/imports.svelte";

  const definitionsQuery = getImportDefinitionsQuery();
  const sessionsQuery = getImportSessionsQuery();

  const definitions = $derived(definitionsQuery.data?.data ?? []);
  const sessions = $derived(sessionsQuery.data?.data ?? []);

  let chosen = $state<string | null>(null);

  // One import needs no picker. Several do.
  const active = $derived(
    chosen ?? (definitions.length === 1 ? definitions[0].name : null),
  );

  onMount(() => {
    // Read `.data` once, deliberately. `createQuery` arms its fetch on the
    // FIRST `.data` read, and `isLoading` alone does not arm it -- a page
    // whose loading branch renders before anything reads `.data` sits on
    // its skeleton forever. See web/src/lib/query.svelte.ts.
    void definitionsQuery.data;
    void sessionsQuery.data;
  });

  function outcomeLine(session: ImportSessionSummary): string {
    if (!session.result) return session.status;
    if (session.result.rolledBack) return "Rolled back, nothing imported";
    const parts: string[] = [];
    if (session.result.created) parts.push(`${session.result.created} new`);
    if (session.result.updated) parts.push(`${session.result.updated} updated`);
    if (session.result.skipped) parts.push(`${session.result.skipped} skipped`);
    return parts.length > 0 ? parts.join(", ") : "Nothing imported";
  }

  function when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
</script>

<div class="import-page" data-testid="import-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Import a spreadsheet</h1>
      <p class="page-subtitle">
        Upload a CSV or Excel file, match its columns once, and check what will
        happen before anything is written. Importing the same file again updates
        the records that are already here instead of adding them twice.
      </p>
    </div>
  </div>

  {#if definitionsQuery.isLoading && definitions.length === 0}
    <div class="card"><p class="muted" data-testid="import-page-loading">Loading...</p></div>
  {:else if definitionsQuery.error && definitions.length === 0}
    <div class="alert alert-error" data-testid="import-page-error">
      Could not load what this app can import: {definitionsQuery.error}
    </div>
  {:else if definitions.length === 0}
    <div class="card">
      <div class="empty-state" data-testid="import-page-empty">
        <p>This app has no spreadsheet imports yet.</p>
        <p class="empty-hint">
          Adding one is a single registration on the server. See
          <code>src/services/import/examples/people.ts</code> for the worked
          example to copy.
        </p>
      </div>
    </div>
  {:else}
    {#if definitions.length > 1}
      <div class="card picker-card">
        <h2 class="section-title">What are you importing?</h2>
        <div class="picker" data-testid="import-page-picker">
          {#each definitions as def (def.name)}
            <button
              type="button"
              class="picker-option"
              class:selected={active === def.name}
              disabled={!def.canRun}
              onclick={() => (chosen = def.name)}
              data-testid="import-page-btn-{def.name}"
            >
              <span class="picker-label">{def.label}</span>
              <span class="picker-description">{def.description}</span>
              {#if !def.canRun}
                <span class="picker-locked">Needs the {def.capability} permission</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if active}
      {#key active}
        <ImportWizard definition={active} ondone={() => importsStore.refresh()} />
      {/key}
    {/if}

    {#if sessions.length > 0}
      <div class="card table-card">
        <h2 class="section-title recent-title">Recent imports</h2>
        <div class="table-wrap">
          <table class="recent-table" data-testid="import-page-recent">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Import</th>
                <th scope="col" class="col-num">Rows</th>
                <th scope="col">Outcome</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {#each sessions as session (session.id)}
                <tr data-testid="import-page-recent-row">
                  <td class="cell-name" title={session.filename}>{session.filename}</td>
                  <td class="cell-muted">{session.definitionName}</td>
                  <td class="cell-num">{session.rowCount}</td>
                  <td class="cell-muted">{outcomeLine(session)}</td>
                  <td class="cell-muted" title={session.createdAt}>{when(session.createdAt)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .import-page {
    max-width: 1100px;
    display: flex;
    flex-direction: column;
    gap: var(--space-lg);
  }

  .section-title {
    margin: 0 0 var(--space-sm);
    font-family: var(--font-heading);
    font-size: var(--text-base);
    color: var(--color-text);
  }

  .muted {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    margin: 0;
  }

  .empty-hint {
    font-size: var(--text-xs);
    color: var(--color-muted);
    max-width: 60ch;
  }

  /* ---------- Picker ---------- */
  .picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--space-sm);
  }

  .picker-option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    cursor: pointer;
    font: inherit;
  }

  .picker-option.selected {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .picker-option:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .picker-label {
    font-weight: 600;
    color: var(--color-text);
    font-size: var(--text-sm);
  }

  .picker-description {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .picker-locked {
    color: var(--color-muted);
    font-size: var(--text-xs);
    font-style: italic;
  }

  /* ---------- Recent ---------- */
  .table-card {
    padding: var(--space-md);
  }

  .recent-title {
    margin-bottom: var(--space-sm);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .recent-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .recent-table th,
  .recent-table td {
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
  }

  .recent-table th {
    font-weight: 600;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  .recent-table tbody tr:last-child td {
    border-bottom: none;
  }

  .cell-name {
    color: var(--color-text);
    font-weight: 500;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cell-muted {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .col-num,
  .cell-num {
    text-align: right;
    white-space: nowrap;
  }

  @media (max-width: 768px) {
    .recent-table {
      font-size: var(--text-xs);
    }
  }
</style>
