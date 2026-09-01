<script lang="ts">
  /**
   * ImportWizard -- the spreadsheet importer for this app. Use it for
   * EVERY "let them upload a spreadsheet" ticket; do not build a second
   * one.
   *
   * The whole component is driven by the definition the server hands
   * back, so it never knows what it is importing. Registering an
   * ImportDefinition on the server (see
   * src/services/import/definitions.ts) is the entire integration:
   *
   *   <ImportWizard definition="people" ondone={() => roster.refresh()} />
   *
   * Four steps, and each one answers the question a person has at that
   * moment:
   *
   *   upload    what file, and what should it look like
   *   map       which column is which, already filled in
   *   preview   what will happen, before it happens
   *   results   what actually happened, including what did not
   *
   * The mapping step is why the mapping is worth proposing rather than
   * asking: a person confirms four dropdowns instead of filling in
   * fourteen, and the ones they do have to touch are exactly the ones
   * the server could not decide.
   */
  import { onMount } from "svelte";
  import UploadField from "./UploadField.svelte";
  import { toastStore } from "../stores/toast.svelte";
  import type { UploadTypeId } from "../lib/upload-types";
  import {
    type ColumnMappingEntry,
    CONFIDENCE_LABELS,
    displayValue,
    type ImportDefinitionSummary,
    type ImportPreview,
    type ImportResult,
    type ImportSessionSummary,
    importsStore,
    ROW_ACTION_LABELS,
    rowActionBadgeClass,
  } from "../stores/imports.svelte";

  interface Props {
    /** The registered ImportDefinition's name. */
    definition: string;
    /** Called after a commit that wrote something, so a list can refresh. */
    ondone?: (result: ImportResult) => void;
    testid?: string;
  }

  let { definition, ondone, testid = "import-wizard" }: Props = $props();

  type Step = "upload" | "map" | "preview" | "results";

  let step = $state<Step>("upload");
  let spec = $state<ImportDefinitionSummary | null>(null);
  let specError = $state<string | null>(null);
  let session = $state<ImportSessionSummary | null>(null);
  let mapping = $state<ColumnMappingEntry[]>([]);
  let ambiguous = $state<Set<number>>(new Set());
  let confidence = $state<Record<number, string>>({});
  let preview = $state<ImportPreview | null>(null);
  let result = $state<ImportResult | null>(null);
  let busy = $state(false);

  const fields = $derived(spec?.fields ?? []);
  const acceptTypes = $derived((spec?.acceptTypes ?? ["csv", "xlsx"]) as UploadTypeId[]);
  const columns = $derived(session?.columns ?? []);

  // What a person is about to change, in one sentence, so the commit
  // button is never a leap of faith.
  const commitSummary = $derived.by(() => {
    if (!preview) return "";
    const parts: string[] = [];
    if (preview.counts.create) parts.push(`${preview.counts.create} new`);
    if (preview.counts.update) parts.push(`${preview.counts.update} updated`);
    const skipped = preview.counts.invalid + preview.counts.duplicate;
    if (skipped) parts.push(`${skipped} not imported`);
    return parts.length > 0 ? parts.join(", ") : "nothing to import";
  });

  const canCommit = $derived(
    preview !== null && preview.counts.create + preview.counts.update > 0 && !busy,
  );

  onMount(() => {
    void loadSpec();
  });

  async function loadSpec(): Promise<void> {
    try {
      spec = await importsStore.getDefinition(definition);
      specError = null;
    } catch (err) {
      specError = err instanceof Error ? err.message : "Could not load this import.";
    }
  }

  async function onUploaded(file: { id: string }): Promise<void> {
    busy = true;
    try {
      const started = await importsStore.start({ definition, uploadedFileId: file.id });
      session = started.session;
      mapping = started.proposal.map((p) => ({
        columnIndex: p.columnIndex,
        fieldKey: p.fieldKey,
        custom: null,
      }));
      ambiguous = new Set(started.proposal.filter((p) => p.ambiguous).map((p) => p.columnIndex));
      confidence = Object.fromEntries(started.proposal.map((p) => [p.columnIndex, p.confidence]));
      step = "map";
    } catch (err) {
      // The server's message names the fixable thing ("The header row of
      // that file is empty"), so it is what a person sees.
      toastStore.show(err instanceof Error ? err.message : "That file could not be read.", "error");
    } finally {
      busy = false;
    }
  }

  function setField(columnIndex: number, value: string): void {
    // Top-level array replacement, per the store rules in CLAUDE.md.
    mapping = mapping.map((entry) =>
      entry.columnIndex === columnIndex
        ? {
          columnIndex,
          fieldKey: value === "" || value === "__custom__" ? null : value,
          custom: value === "__custom__" ? (entry.custom || columns[columnIndex]) : null,
        }
        : entry
    );
    // Once a person has touched a column it is their decision, not a
    // proposal, so the "please check this" flag comes off.
    if (ambiguous.has(columnIndex)) {
      const next = new Set(ambiguous);
      next.delete(columnIndex);
      ambiguous = next;
    }
  }

  function setCustomName(columnIndex: number, value: string): void {
    mapping = mapping.map((entry) =>
      entry.columnIndex === columnIndex ? { ...entry, custom: value } : entry
    );
  }

  function selectValue(entry: ColumnMappingEntry): string {
    if (entry.fieldKey) return entry.fieldKey;
    return entry.custom ? "__custom__" : "";
  }

  /** Which fields are already taken, so the dropdowns cannot collide. */
  const usedFields = $derived(
    new Set(mapping.map((e) => e.fieldKey).filter((k): k is string => k !== null)),
  );

  const unmappedRequired = $derived(
    fields.filter((f) =>
      f.required && !usedFields.has(f.key) &&
      // A required field a derivation fills is satisfied by its source
      // column; the server has the final word, this only shapes the hint.
      !fields.some((other) => other.inputOnly && usedFields.has(other.key))
    ),
  );

  async function goToPreview(): Promise<void> {
    if (!session) return;
    busy = true;
    try {
      await importsStore.saveMapping(session.id, mapping);
      preview = await importsStore.preview(session.id);
      step = "preview";
    } catch (err) {
      toastStore.show(
        err instanceof Error ? err.message : "That mapping could not be used.",
        "error",
      );
    } finally {
      busy = false;
    }
  }

  async function commit(): Promise<void> {
    if (!session) return;
    busy = true;
    try {
      const outcome = await importsStore.commit(session.id);
      session = outcome.session;
      result = outcome.result;
      step = "results";
      if (outcome.result.rolledBack) {
        toastStore.show("Nothing was imported. The whole file was rolled back.", "error");
      } else {
        toastStore.show(
          `Imported ${outcome.result.created} new and ${outcome.result.updated} updated.`,
          "success",
        );
        ondone?.(outcome.result);
      }
    } catch (err) {
      toastStore.show(err instanceof Error ? err.message : "The import could not run.", "error");
    } finally {
      busy = false;
    }
  }

  function startOver(): void {
    session = null;
    mapping = [];
    preview = null;
    result = null;
    ambiguous = new Set();
    confidence = {};
    step = "upload";
  }

  const STEPS: Array<{ id: Step; label: string }> = [
    { id: "upload", label: "Upload" },
    { id: "map", label: "Match columns" },
    { id: "preview", label: "Check" },
    { id: "results", label: "Done" },
  ];

  function stepState(id: Step): "done" | "current" | "todo" {
    const order = STEPS.map((s) => s.id);
    const here = order.indexOf(step);
    const there = order.indexOf(id);
    if (there < here) return "done";
    if (there === here) return "current";
    return "todo";
  }
</script>

<div class="import-wizard" data-testid={testid}>
  <ol class="stepper" data-testid="{testid}-stepper">
    {#each STEPS as s (s.id)}
      <li class="step step-{stepState(s.id)}" data-testid="{testid}-step-{s.id}">
        <span class="step-dot" aria-hidden="true"></span>
        <span class="step-label">{s.label}</span>
      </li>
    {/each}
  </ol>

  {#if specError}
    <div class="alert alert-error" data-testid="{testid}-spec-error">{specError}</div>
  {:else if !spec}
    <div class="card"><p class="muted" data-testid="{testid}-loading">Loading...</p></div>
  {:else if !spec.canRun}
    <div class="alert alert-info" data-testid="{testid}-forbidden">
      Importing {spec.label} needs the {spec.capability} permission. Ask an admin
      or the owner of this workspace to run it.
    </div>

    <!-- ── Step 1: upload ───────────────────────────────────────────── -->
  {:else if step === "upload"}
    <div class="card">
      <h2 class="section-title">{spec.label}</h2>
      <p class="muted">{spec.description}</p>

      <ul class="field-hints" data-testid="{testid}-field-hints">
        {#each fields.filter((f) => !f.inputOnly || f.required) as f (f.key)}
          <li>
            <span class="field-name">{f.label}</span>
            {#if f.required}<span class="req">required</span>{/if}
            {#if f.options}<span class="muted">one of {f.options.join(", ")}</span>{/if}
          </li>
        {/each}
      </ul>

      {#if spec.hasSample}
        <p class="sample-line">
          Not sure about the headings?
          <a
            href={importsStore.sampleUrl(spec.name)}
            data-testid="{testid}-link-sample"
          >Download a starter file</a>
          with the exact ones this import knows.
        </p>
      {/if}

      <UploadField
        testid="{testid}-upload"
        label="Choose a spreadsheet"
        hint="A CSV or an Excel file. The first sheet with data is used."
        allow={acceptTypes}
        multiple={false}
        disabled={busy}
        subjectType="import"
        subjectId={spec.name}
        onuploaded={(file) => void onUploaded(file)}
      />
    </div>

    <!-- ── Step 2: map ──────────────────────────────────────────────── -->
  {:else if step === "map" && session}
    <div class="card">
      <h2 class="section-title">Match the columns</h2>
      <p class="muted">
        {session.filename} &middot; {session.rowCount}
        {session.rowCount === 1 ? "row" : "rows"}. Most of this is already filled
        in. Check anything flagged below.
      </p>

      {#if unmappedRequired.length > 0}
        <div class="alert alert-warning" data-testid="{testid}-missing-required">
          {unmappedRequired.map((f) => f.label).join(", ")}
          {unmappedRequired.length === 1 ? "is" : "are"} required. Pick a column for
          {unmappedRequired.length === 1 ? "it" : "them"} before continuing.
        </div>
      {/if}

      <div class="table-wrap">
        <table class="map-table" data-testid="{testid}-map-table">
          <thead>
            <tr>
              <th scope="col">Column in your file</th>
              <th scope="col">Goes to</th>
              <th scope="col">Match</th>
            </tr>
          </thead>
          <tbody>
            {#each mapping as entry (entry.columnIndex)}
              <tr class:flagged={ambiguous.has(entry.columnIndex)} data-testid="{testid}-map-row">
                <td class="cell-column">{columns[entry.columnIndex]}</td>
                <td>
                  <select
                    class="input"
                    value={selectValue(entry)}
                    disabled={busy}
                    aria-label="Field for {columns[entry.columnIndex]}"
                    data-testid="{testid}-select-{entry.columnIndex}"
                    onchange={(e) =>
                    setField(entry.columnIndex, (e.currentTarget as HTMLSelectElement).value)}
                  >
                    <option value="">Skip this column</option>
                    {#each fields as f (f.key)}
                      <option
                        value={f.key}
                        disabled={usedFields.has(f.key) && entry.fieldKey !== f.key}
                      >
                        {f.label}{f.required ? " (required)" : ""}
                      </option>
                    {/each}
                    <option value="__custom__">Keep as extra data</option>
                  </select>

                  {#if entry.fieldKey === null && entry.custom !== null && entry.custom !== undefined}
                    <input
                      class="input custom-name"
                      value={entry.custom}
                      placeholder="Name for this data"
                      aria-label="Name for {columns[entry.columnIndex]}"
                      data-testid="{testid}-input-custom-{entry.columnIndex}"
                      oninput={(e) =>
                      setCustomName(entry.columnIndex, (e.currentTarget as HTMLInputElement).value)}
                    />
                  {/if}
                </td>
                <td class="cell-confidence">
                  {#if ambiguous.has(entry.columnIndex)}
                    <span class="badge badge-warn" data-testid="{testid}-ambiguous">Please check</span>
                  {:else}
                    <span class="muted">
                      {CONFIDENCE_LABELS[
                        (confidence[entry.columnIndex] ?? "none") as keyof typeof CONFIDENCE_LABELS
                      ]}
                    </span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="actions">
        <button
          type="button"
          class="btn btn-ghost"
          onclick={startOver}
          disabled={busy}
          data-testid="{testid}-btn-restart"
        >
          Use a different file
        </button>
        <button
          type="button"
          class="btn btn-primary"
          onclick={goToPreview}
          disabled={busy}
          data-testid="{testid}-btn-preview"
        >
          Check the rows
        </button>
      </div>
    </div>

    <!-- ── Step 3: preview ──────────────────────────────────────────── -->
  {:else if step === "preview" && preview}
    <div class="card">
      <h2 class="section-title">Check what will happen</h2>

      <div class="counts" data-testid="{testid}-counts">
        <div class="count">
          <span class="count-value" data-testid="{testid}-count-create">
            {preview.counts.create}
          </span>
          <span class="count-label">new</span>
        </div>
        <div class="count">
          <span class="count-value" data-testid="{testid}-count-update">
            {preview.counts.update}
          </span>
          <span class="count-label">updated</span>
        </div>
        <div class="count">
          <span class="count-value" data-testid="{testid}-count-skipped">
            {preview.counts.invalid + preview.counts.duplicate}
          </span>
          <span class="count-label">not imported</span>
        </div>
      </div>

      {#if preview.problemRows.length > 0}
        <div class="alert alert-warning" data-testid="{testid}-problems">
          <p class="problems-title">
            {preview.problemRows.length}
            {preview.problemRows.length === 1 ? "row" : "rows"} will not be imported.
            {#if preview.unlistedProblemRows > 0}
              The first {preview.problemRows.length} are listed; {preview
                .unlistedProblemRows} more are not.
            {/if}
          </p>
          <ul class="problem-list">
            {#each preview.problemRows.slice(0, 20) as row (row.rowNumber)}
              <li data-testid="{testid}-problem-row">
                <strong>Row {row.rowNumber}</strong>: {row.reason}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <div class="table-wrap">
        <table class="preview-table" data-testid="{testid}-preview-table">
          <thead>
            <tr>
              <th scope="col" class="col-num">Row</th>
              <th scope="col">What happens</th>
              {#each fields.filter((f) => !f.inputOnly) as f (f.key)}
                <th scope="col">{f.label}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each preview.rows as row (row.rowNumber)}
              <tr class:bad={row.action === "skip"} data-testid="{testid}-preview-row">
                <td class="cell-num">{row.rowNumber}</td>
                <td>
                  <span
                    class="badge {rowActionBadgeClass(row.action)}"
                    data-testid="{testid}-row-action"
                  >
                    {ROW_ACTION_LABELS[row.action]}
                  </span>
                </td>
                {#each fields.filter((f) => !f.inputOnly) as f (f.key)}
                  <td
                    class:cell-error={row.errors.some((e) => e.field === f.key)}
                    title={row.errors.find((e) => e.field === f.key)?.message ?? ""}
                  >
                    {displayValue(row.values[f.key] ?? null)}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if preview.counts.total > preview.rows.length}
        <p class="muted table-note">
          Showing the first {preview.rows.length} of {preview.counts.total} rows. The
          counts above cover the whole file.
        </p>
      {/if}

      <div class="actions">
        <button
          type="button"
          class="btn btn-ghost"
          onclick={() => (step = "map")}
          disabled={busy}
          data-testid="{testid}-btn-back"
        >
          Back to columns
        </button>
        <button
          type="button"
          class="btn btn-primary"
          onclick={commit}
          disabled={!canCommit}
          data-loading={busy ? "true" : undefined}
          data-testid="{testid}-btn-commit"
        >
          Import {commitSummary}
        </button>
      </div>
    </div>

    <!-- ── Step 4: results ──────────────────────────────────────────── -->
  {:else if step === "results" && result}
    <div class="card">
      <h2 class="section-title">
        {result.rolledBack ? "Nothing was imported" : "Import finished"}
      </h2>

      {#if result.rolledBack}
        <div class="alert alert-error" data-testid="{testid}-rolled-back">
          A row could not be saved, so the whole file was rolled back and nothing
          changed. Fix the row below and import the same file again: rows that
          already exist are updated, not duplicated.
          {#if result.error}<br /><span class="muted">{result.error}</span>{/if}
        </div>
      {/if}

      <div class="counts" data-testid="{testid}-result-counts">
        <div class="count">
          <span class="count-value" data-testid="{testid}-result-created">{result.created}</span>
          <span class="count-label">created</span>
        </div>
        <div class="count">
          <span class="count-value" data-testid="{testid}-result-updated">{result.updated}</span>
          <span class="count-label">updated</span>
        </div>
        <div class="count">
          <span class="count-value" data-testid="{testid}-result-skipped">{result.skipped}</span>
          <span class="count-label">skipped</span>
        </div>
        <div class="count">
          <span class="count-value" data-testid="{testid}-result-failed">{result.failed}</span>
          <span class="count-label">failed</span>
        </div>
      </div>

      {#if result.problemRows.length > 0}
        <h3 class="subsection-title">Rows that did not land</h3>
        <div class="table-wrap">
          <table class="preview-table" data-testid="{testid}-result-table">
            <thead>
              <tr>
                <th scope="col" class="col-num">Row</th>
                <th scope="col">Outcome</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {#each result.problemRows as row (row.rowNumber)}
                <tr data-testid="{testid}-result-row">
                  <td class="cell-num">{row.rowNumber}</td>
                  <td>
                    <span class="badge {row.outcome === 'failed' ? 'badge-bad' : 'badge-warn'}">
                      {row.outcome}
                    </span>
                  </td>
                  <td>{row.reason}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if result.unlistedProblemRows > 0}
          <p class="muted table-note">
            {result.unlistedProblemRows} more rows are counted above but not listed
            here.
          </p>
        {/if}
      {:else if !result.rolledBack}
        <p class="muted" data-testid="{testid}-all-landed">
          Every row in the file was imported.
        </p>
      {/if}

      <div class="actions">
        <button
          type="button"
          class="btn btn-primary"
          onclick={startOver}
          data-testid="{testid}-btn-again"
        >
          Import another file
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .import-wizard {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
  }

  /* ---------- Stepper ---------- */
  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-lg);
    list-style: none;
    margin: 0;
    padding: 0;
    flex-wrap: wrap;
  }

  .step {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    font-size: var(--text-sm);
    color: var(--color-muted);
  }

  .step-dot {
    width: 10px;
    height: 10px;
    border-radius: var(--radius-full);
    background: var(--color-border-strong);
  }

  .step-current .step-dot,
  .step-done .step-dot {
    background: var(--color-accent);
  }

  .step-current .step-label {
    color: var(--color-text);
    font-weight: 600;
  }

  .step-done .step-label {
    color: var(--color-text-secondary);
  }

  /* ---------- Shared ---------- */
  .section-title {
    margin: 0 0 var(--space-xs);
    font-family: var(--font-heading);
    font-size: var(--text-base);
    color: var(--color-text);
  }

  .subsection-title {
    margin: var(--space-md) 0 var(--space-xs);
    font-family: var(--font-heading);
    font-size: var(--text-sm);
    color: var(--color-text);
  }

  .muted {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    margin: 0 0 var(--space-sm);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-sm);
    margin-top: var(--space-md);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .table-note {
    margin-top: var(--space-sm);
    font-size: var(--text-xs);
  }

  /* ---------- Upload step ---------- */
  .field-hints {
    list-style: none;
    margin: 0 0 var(--space-md);
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs) var(--space-md);
    font-size: var(--text-xs);
  }

  .field-hints li {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .field-name {
    color: var(--color-text);
    font-weight: 500;
  }

  .req {
    color: var(--color-error);
    font-size: var(--text-xs);
  }

  .field-hints .muted {
    margin: 0;
    font-size: var(--text-xs);
  }

  .sample-line {
    margin: 0 0 var(--space-md);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* ---------- Tables ---------- */
  .map-table,
  .preview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .map-table th,
  .map-table td,
  .preview-table th,
  .preview-table td {
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--color-border);
    vertical-align: top;
  }

  .map-table th,
  .preview-table th {
    font-weight: 600;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    white-space: nowrap;
  }

  .map-table tbody tr:last-child td,
  .preview-table tbody tr:last-child td {
    border-bottom: none;
  }

  .map-table .flagged {
    background: var(--color-warning-bg);
  }

  .cell-column {
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
  }

  .cell-confidence {
    white-space: nowrap;
  }

  .cell-confidence .muted {
    margin: 0;
    font-size: var(--text-xs);
  }

  .custom-name {
    margin-top: var(--space-xs);
    width: 100%;
  }

  .col-num,
  .cell-num {
    text-align: right;
    white-space: nowrap;
    color: var(--color-muted);
  }

  .preview-table .bad td {
    color: var(--color-text-secondary);
  }

  .cell-error {
    color: var(--color-error);
    text-decoration: underline dotted;
  }

  /* ---------- Counts ---------- */
  .counts {
    display: flex;
    gap: var(--space-lg);
    margin-bottom: var(--space-md);
    flex-wrap: wrap;
  }

  .count {
    display: flex;
    flex-direction: column;
  }

  .count-value {
    font-family: var(--font-heading);
    font-size: var(--text-xl);
    color: var(--color-text);
    line-height: 1.1;
  }

  .count-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
  }

  /* ---------- Problems ---------- */
  .problems-title {
    margin: 0 0 var(--space-xs);
    font-weight: 600;
  }

  .problem-list {
    margin: 0;
    padding-left: var(--space-md);
    font-size: var(--text-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* ---------- Badge tones ----------
     The same shared semantic ramps the other list surfaces use, so no
     status pill here hand-picks a colour. */
  .badge.badge-good {
    background: var(--color-success-bg);
    color: var(--color-success);
    border-color: var(--color-success-border);
  }

  .badge.badge-bad {
    background: var(--color-error-bg);
    color: var(--color-error);
    border-color: var(--color-error-border);
  }

  .badge.badge-warn {
    background: var(--color-warning-bg);
    color: var(--color-warning);
    border-color: var(--color-warning-border);
  }

  @media (max-width: 768px) {
    .map-table,
    .preview-table {
      font-size: var(--text-xs);
    }
    .counts {
      gap: var(--space-md);
    }
  }
</style>
