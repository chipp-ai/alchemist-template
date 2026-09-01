<script lang="ts">
  /**
   * UploadField -- the file picker for this app. Use it for EVERY
   * end-user upload; do not hand-roll an <input type="file"> and a fetch.
   *
   * What it gives you, none of which you have to write again:
   *   - the accepted-types allowlist, fetched from the server, so the
   *     `accept` attribute and the pre-check can never drift from what
   *     the server will actually take
   *   - a per-file progress bar (real upload progress, not a spinner)
   *   - the server's own error message when a file is refused, which
   *     names the problem the person can fix
   *   - drag and drop, keyboard reachable, one file or many
   *
   * Usage:
   *   <UploadField
   *     subjectType="expense"
   *     subjectId={expense.id}
   *     onuploaded={(file) => attachments.push(file)}
   *   />
   *
   * The upload lands as `pending_review` unless this app approves on
   * arrival. That is why the row below the picker says so: a person who
   * has just attached a receipt should not have to guess whether anyone
   * will look at it.
   */
  import { onMount } from "svelte";
  import {
    FALLBACK_UPLOAD_POLICY,
    formatFileSize,
    getUploadPolicyQuery,
    UPLOAD_STATUS_LABELS,
    uploadFile,
    uploadStatusBadgeClass,
    type UploadedFileSummary,
    type UploadPolicy,
  } from "../stores/uploads.svelte";
  import { checkUpload, type UploadTypeId } from "../lib/upload-types";
  import { toastStore } from "../stores/toast.svelte";

  interface Props {
    /** The record this file belongs to. Both or neither. */
    subjectType?: string | null;
    subjectId?: string | null;
    /**
     * Narrow the accepted types for THIS field (a courtesy in the
     * picker; the server enforces the same narrowing only if the route
     * passes `allow` too).
     */
    allow?: readonly UploadTypeId[];
    label?: string;
    hint?: string;
    /** Accept more than one file per pick. */
    multiple?: boolean;
    disabled?: boolean;
    /** Called once per file the server accepted. */
    onuploaded?: (file: UploadedFileSummary) => void;
    /** Prefix for data-testid attributes, so a page can host two fields. */
    testid?: string;
  }

  let {
    subjectType = null,
    subjectId = null,
    allow,
    label = "Attach a file",
    hint,
    multiple = true,
    disabled = false,
    onuploaded,
    testid = "upload-field",
  }: Props = $props();

  interface QueueItem {
    key: string;
    filename: string;
    sizeBytes: number;
    /** 0 to 1 while uploading. */
    progress: number;
    state: "uploading" | "done" | "error";
    error: string | null;
    file: UploadedFileSummary | null;
  }

  const policyQuery = getUploadPolicyQuery();
  let queue = $state<QueueItem[]>([]);
  let dragging = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);

  // The server's policy the moment it lands; the mirrored table until
  // then, so the picker is usable on first paint.
  const policy = $derived<UploadPolicy>(policyQuery.data?.data ?? FALLBACK_UPLOAD_POLICY);

  const acceptAttr = $derived(
    allow
      ? policy.types
        .filter((t) => allow.includes(t.id))
        .flatMap((t) => [...t.extensions, ...t.contentTypes])
        .join(",")
      : policy.accept,
  );

  const acceptedLabel = $derived(
    (allow ? policy.types.filter((t) => allow.includes(t.id)) : policy.types)
      .map((t) => t.extensions[0])
      .join(", "),
  );

  const busy = $derived(queue.some((item) => item.state === "uploading"));

  onMount(() => {
    // Touch the query so the real policy is fetched on mount rather than
    // on the first pick, when it would be too late to shape the dialog.
    void policyQuery.data;
  });

  function openPicker(): void {
    if (disabled) return;
    inputEl?.click();
  }

  function onInputChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    void handleFiles(input.files);
    // Reset so picking the same file twice in a row still fires.
    input.value = "";
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    if (disabled) return;
    void handleFiles(event.dataTransfer?.files ?? null);
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (!disabled) dragging = true;
  }

  function onDragLeave(): void {
    dragging = false;
  }

  async function handleFiles(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    const picked = multiple ? Array.from(list) : [list[0]];
    for (const file of picked) await handleOne(file);
  }

  async function handleOne(file: File): Promise<void> {
    const key = `${file.name}-${file.size}-${crypto.randomUUID()}`;

    // The client-side pre-check is a courtesy, never a control. It saves
    // a round trip on an obviously wrong file; the server applies the
    // same rules again to the request that actually arrives.
    const precheck = checkUpload(
      { filename: file.name, contentType: file.type, sizeBytes: file.size },
      { allow, maxBytes: policy.maxBytes },
    );
    if (!precheck.ok) {
      queue = [...queue, {
        key,
        filename: file.name,
        sizeBytes: file.size,
        progress: 0,
        state: "error",
        error: precheck.message,
        file: null,
      }];
      return;
    }

    queue = [...queue, {
      key,
      filename: file.name,
      sizeBytes: file.size,
      progress: 0,
      state: "uploading",
      error: null,
      file: null,
    }];

    function patch(changes: Partial<QueueItem>): void {
      // Top-level array replacement, per the store rules in CLAUDE.md.
      queue = queue.map((item) => (item.key === key ? { ...item, ...changes } : item));
    }

    try {
      const uploaded = await uploadFile({
        file,
        subjectType,
        subjectId,
        onProgress: (fraction) => patch({ progress: fraction }),
      });
      patch({ state: "done", progress: 1, file: uploaded });
      onuploaded?.(uploaded);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The upload failed.";
      patch({ state: "error", error: message });
      // The row below carries the detail; the toast is what a person
      // notices when the field is scrolled out of view.
      toastStore.show(message, "error");
    }
  }

  function dismiss(key: string): void {
    queue = queue.filter((item) => item.key !== key);
  }
</script>

<div class="upload-field" data-testid={testid}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="dropzone"
    class:dragging
    class:disabled
    ondrop={onDrop}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
  >
    <button
      type="button"
      class="btn btn-secondary"
      onclick={openPicker}
      {disabled}
      data-testid="{testid}-btn-choose"
    >
      {label}
    </button>

    <p class="dropzone-hint" data-testid="{testid}-hint">
      {hint ?? "Drag a file here, or choose one."}
    </p>
    <p class="dropzone-types" data-testid="{testid}-accepted">
      Accepted: {acceptedLabel} &middot; up to {formatFileSize(policy.maxBytes)}
    </p>

    <input
      bind:this={inputEl}
      type="file"
      class="visually-hidden"
      accept={acceptAttr}
      {multiple}
      {disabled}
      onchange={onInputChange}
      data-testid="{testid}-input"
      aria-label={label}
    />
  </div>

  {#if queue.length > 0}
    <ul class="queue" data-testid="{testid}-queue" aria-live="polite">
      {#each queue as item (item.key)}
        <li class="queue-item" data-testid="{testid}-queue-item">
          <div class="queue-row">
            <span class="queue-name" title={item.filename}>{item.filename}</span>
            <span class="queue-size">{formatFileSize(item.sizeBytes)}</span>

            {#if item.state === "done" && item.file}
              <span
                class="badge {uploadStatusBadgeClass(item.file.status)}"
                data-testid="{testid}-status"
              >
                {UPLOAD_STATUS_LABELS[item.file.status]}
              </span>
            {:else if item.state === "error"}
              <span class="badge badge-bad" data-testid="{testid}-status">Not accepted</span>
            {:else}
              <span class="badge badge-neutral" data-testid="{testid}-status">
                {Math.round(item.progress * 100)}%
              </span>
            {/if}

            <button
              type="button"
              class="btn btn-ghost queue-dismiss"
              onclick={() => dismiss(item.key)}
              aria-label="Dismiss {item.filename}"
              data-testid="{testid}-btn-dismiss"
            >
              Dismiss
            </button>
          </div>

          {#if item.state === "uploading"}
            <div
              class="progress"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={Math.round(item.progress * 100)}
              aria-label="Uploading {item.filename}"
            >
              <div class="progress-bar" style="transform: scaleX({item.progress})"></div>
            </div>
          {/if}

          {#if item.error}
            <p class="queue-error" data-testid="{testid}-error">{item.error}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if busy}
    <p class="visually-hidden" aria-live="assertive">Uploading.</p>
  {/if}
</div>

<style>
  .upload-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  /* ---------- Dropzone ---------- */
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-xs);
    padding: var(--space-lg);
    border: 1px dashed var(--color-border-strong);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    text-align: center;
  }

  .dropzone.dragging {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }

  .dropzone.disabled {
    opacity: 0.6;
  }

  .dropzone-hint {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .dropzone-types {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-muted);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* ---------- Queue ---------- */
  .queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .queue-item {
    padding: var(--space-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .queue-row {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .queue-name {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .queue-size {
    font-size: var(--text-xs);
    color: var(--color-muted);
    white-space: nowrap;
  }

  .queue-dismiss {
    font-size: var(--text-xs);
    padding: 2px 8px;
  }

  .queue-error {
    margin: var(--space-xs) 0 0;
    font-size: var(--text-xs);
    color: var(--color-error);
  }

  /* ---------- Progress ----------
     Animated with transform only, per the motion rules: a width
     transition would lay out on every frame. */
  .progress {
    margin-top: var(--space-xs);
    height: 4px;
    border-radius: var(--radius-full);
    background: var(--color-surface-sunken);
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    width: 100%;
    transform-origin: left center;
    background: var(--color-accent);
    transition: transform 0.15s linear;
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-bar {
      transition: none;
    }
  }

  /* ---------- Badge tones ----------
     Same shared semantic ramps the other list surfaces use, so no
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

  .badge.badge-neutral {
    background: var(--color-surface-sunken);
    color: var(--color-text-secondary);
    border-color: var(--color-border);
  }
</style>
