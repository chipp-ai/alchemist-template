<script lang="ts">
  /**
   * Review queue -- the admin side of the upload paved road.
   *
   * Everything a person uploads lands here as pending until somebody
   * decides. Approving opens the file to the workspace; rejecting keeps
   * it closed and tells the uploader why.
   *
   * The `files.review` capability gates this page in the UI and the API.
   * The client check decides which buttons to render; the server check
   * is the one that matters.
   */
  import { onMount } from "svelte";
  import { authStore } from "../stores/auth.svelte";
  import { can } from "../lib/permissions";
  import Modal from "../components/Modal.svelte";
  import UploadField from "../components/UploadField.svelte";
  import { toastStore } from "../stores/toast.svelte";
  import {
    formatFileSize,
    getReviewQueueQuery,
    UPLOAD_STATUS_LABELS,
    uploadsStore,
    uploadStatusBadgeClass,
    type UploadedFileSummary,
  } from "../stores/uploads.svelte";

  const canReview = $derived(can(authStore.user?.role ?? "", "files.review"));

  const query = getReviewQueueQuery();
  const files = $derived(query.data?.data.files ?? []);
  const pendingCount = $derived(query.data?.data.pendingCount ?? 0);

  let now = $state(Date.now());
  let busyId = $state<string | null>(null);

  // Reject flow: a reason is required, so it gets a dialog rather than a
  // bare button. A rejection nobody can explain becomes a support ticket.
  let rejecting = $state<UploadedFileSummary | null>(null);
  let rejectReason = $state("");

  onMount(() => {
    // Read `.data` once, deliberately. `createQuery` arms its fetch on
    // the FIRST `.data` read, and `isLoading` alone does not arm it -- so
    // a page whose `{#if query.isLoading}` branch renders before anything
    // reads `.data` sits on its skeleton forever. Reproduced in the
    // browser on this page before this line existed; the same shape is
    // the 2026-07-28 Valor Victoria freeze documented in query.svelte.ts.
    void query.data;

    const timer = window.setInterval(() => (now = Date.now()), 30_000);
    return () => window.clearInterval(timer);
  });

  function relativeTime(iso: string, reference: number): string {
    const seconds = Math.max(0, Math.floor((reference - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86_400)}d ago`;
  }

  async function approve(file: UploadedFileSummary): Promise<void> {
    busyId = file.id;
    try {
      await uploadsStore.approve(file.id);
      toastStore.show(`Approved ${file.filename}.`, "success");
    } catch (err) {
      toastStore.show(err instanceof Error ? err.message : "Could not approve that file.", "error");
    } finally {
      busyId = null;
    }
  }

  function openReject(file: UploadedFileSummary): void {
    rejecting = file;
    rejectReason = "";
  }

  async function confirmReject(): Promise<void> {
    const file = rejecting;
    if (!file) return;
    const reason = rejectReason.trim();
    if (!reason) {
      toastStore.show("Say why, so the person who sent it can fix it.", "warning");
      return;
    }

    busyId = file.id;
    try {
      await uploadsStore.reject(file.id, reason);
      toastStore.show(`Rejected ${file.filename}.`, "success");
      rejecting = null;
    } catch (err) {
      toastStore.show(err instanceof Error ? err.message : "Could not reject that file.", "error");
    } finally {
      busyId = null;
    }
  }

  async function openFile(file: UploadedFileSummary): Promise<void> {
    try {
      // Signed URLs expire, so one is fetched per click rather than held.
      const url = await uploadsStore.downloadUrl(file.id);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      toastStore.show(err instanceof Error ? err.message : "Could not open that file.", "error");
    }
  }

  function onUploaded(): void {
    uploadsStore.refresh();
  }
</script>

<div class="review-queue" data-testid="review-queue-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">File review</h1>
      <p class="page-subtitle">
        Uploads wait here until somebody decides. Approving opens a file to the
        workspace; rejecting keeps it closed and tells the sender why.
      </p>
    </div>
  </div>

  {#if !canReview}
    <div class="alert alert-info" data-testid="review-queue-forbidden">
      Reviewing files is an admin permission. Ask an admin or the owner of this
      workspace to look at the queue.
    </div>
  {:else}
    <div class="card upload-card">
      <h2 class="section-title">Add a file</h2>
      <UploadField
        testid="review-queue-upload"
        label="Choose a file"
        hint="Anything added here joins the same queue."
        onuploaded={onUploaded}
      />
    </div>

    {#if query.isLoading && files.length === 0}
      <div class="card" data-testid="review-queue-loading">
        <p class="text-muted">Loading the queue...</p>
      </div>
    {:else if query.error && files.length === 0}
      <div class="alert alert-error" data-testid="review-queue-error">
        Could not load the review queue: {query.error}
      </div>
    {:else if files.length === 0}
      <div class="card">
        <div class="empty-state" data-testid="review-queue-empty">
          <p>Nothing is waiting for review.</p>
          <p class="empty-hint">
            Every upload lands here first, so this page being empty means every
            file has been decided.
          </p>
        </div>
      </div>
    {:else}
      <div class="card table-card">
        <div class="queue-heading">
          <span data-testid="review-queue-count">
            {pendingCount}
            {pendingCount === 1 ? "file" : "files"} waiting
          </span>
        </div>

        <table class="file-table" data-testid="review-queue-table">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Type</th>
              <th scope="col" class="col-num">Size</th>
              <th scope="col">Attached to</th>
              <th scope="col">Uploaded</th>
              <th scope="col">Status</th>
              <th scope="col" class="col-actions">Decision</th>
            </tr>
          </thead>
          <tbody>
            {#each files as file (file.id)}
              <tr data-testid="review-queue-row">
                <td class="cell-name" title={file.filename}>{file.filename}</td>
                <td class="cell-type">{file.contentType}</td>
                <td class="cell-num">{formatFileSize(file.sizeBytes)}</td>
                <td class="cell-subject">
                  {file.subjectType ? `${file.subjectType} ${file.subjectId ?? ""}` : "--"}
                </td>
                <td class="cell-when" title={file.createdAt}>
                  {relativeTime(file.createdAt, now)}
                </td>
                <td>
                  <span
                    class="badge {uploadStatusBadgeClass(file.status)}"
                    data-testid="review-queue-status"
                  >
                    {UPLOAD_STATUS_LABELS[file.status]}
                  </span>
                </td>
                <td class="cell-actions">
                  <button
                    type="button"
                    class="btn btn-ghost"
                    onclick={() => openFile(file)}
                    data-testid="review-queue-btn-view"
                  >
                    View
                  </button>
                  <button
                    type="button"
                    class="btn btn-primary"
                    disabled={busyId === file.id}
                    onclick={() => approve(file)}
                    data-testid="review-queue-btn-approve"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    class="btn btn-danger"
                    disabled={busyId === file.id}
                    onclick={() => openReject(file)}
                    data-testid="review-queue-btn-reject"
                  >
                    Reject
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<Modal
  open={rejecting !== null}
  title="Reject this file"
  onClose={() => (rejecting = null)}
  size="sm"
>
  <p class="modal-text">
    {rejecting?.filename} stays closed to the workspace. The reason is stored on
    the file, so the person who sent it can see what to fix.
  </p>
  <label class="label" for="reject-reason">Reason</label>
  <textarea
    id="reject-reason"
    class="input reason-input"
    rows="3"
    bind:value={rejectReason}
    placeholder="The second page is missing."
    data-testid="review-queue-input-reason"
  ></textarea>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => (rejecting = null)}
      data-testid="review-queue-btn-reject-cancel"
    >
      Cancel
    </button>
    <button
      type="button"
      class="btn btn-danger"
      disabled={busyId !== null || rejectReason.trim().length === 0}
      onclick={confirmReject}
      data-testid="review-queue-btn-reject-confirm"
    >
      Reject
    </button>
  {/snippet}
</Modal>

<style>
  .review-queue {
    max-width: 1100px;
  }

  .upload-card {
    margin-bottom: var(--space-lg);
  }

  .section-title {
    margin: 0 0 var(--space-sm);
    font-family: var(--font-heading);
    font-size: var(--text-base);
    color: var(--color-text);
  }

  .table-card {
    padding: 0;
    overflow: hidden;
  }

  .queue-heading {
    padding: var(--space-sm) var(--space-md);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    border-bottom: 1px solid var(--color-border);
  }

  .file-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .file-table th,
  .file-table td {
    text-align: left;
    padding: var(--space-sm) var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }

  .file-table th {
    font-weight: 600;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--color-surface);
  }

  .file-table tbody tr:last-child td {
    border-bottom: none;
  }

  .col-num,
  .cell-num {
    text-align: right;
    white-space: nowrap;
  }

  .cell-name {
    color: var(--color-text);
    font-weight: 500;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cell-type,
  .cell-subject,
  .cell-when {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .col-actions,
  .cell-actions {
    text-align: right;
    white-space: nowrap;
  }

  .cell-actions .btn {
    margin-left: var(--space-xs);
  }

  .modal-text {
    margin: 0 0 var(--space-sm);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .reason-input {
    width: 100%;
    font-family: var(--font-sans);
    resize: vertical;
  }

  .text-muted {
    font-size: var(--text-sm);
    color: var(--color-muted);
  }

  .empty-hint {
    font-size: var(--text-xs);
    color: var(--color-muted);
    max-width: 52ch;
  }

  /* Shared semantic ramps, same as the other list surfaces. */
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
    .file-table {
      font-size: var(--text-xs);
    }
    .file-table th,
    .file-table td {
      padding: var(--space-xs) var(--space-sm);
    }
    .cell-type,
    .cell-subject,
    .file-table th:nth-child(2),
    .file-table th:nth-child(4) {
      display: none;
    }
  }
</style>
