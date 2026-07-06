<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "../lib/api";
  import {
    fetchInboundEmailDetail,
    type InboundEmailAttachment,
    type InboundEmailDetail,
  } from "../stores/inboundEmails.svelte";
  import {
    formatBytes,
    formatDateTime,
    frameSrcdocForEmailHtml,
    STATUS_META,
    statusBadgeClass,
    statusLabel,
  } from "../lib/inbound-emails";

  // svelte-spa-router passes route params as the `params` prop.
  let { params }: { params: { id: string } } = $props();

  // ---------- State ----------

  let email = $state<InboundEmailDetail | null>(null);
  let attachments = $state<InboundEmailAttachment[]>([]);
  let loading = $state(true);
  let notFound = $state(false);
  let error = $state<string | null>(null);
  let headersOpen = $state(false);

  onMount(() => {
    // One-shot fetch on mount -- onMount, NOT $effect (see CLAUDE.md:
    // "$effect on mount is a trap; use onMount").
    async function load() {
      try {
        const data = await fetchInboundEmailDetail(params.id);
        email = data.email;
        attachments = data.attachments;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          notFound = true;
        } else {
          error = e instanceof Error ? e.message : "Failed to load email";
        }
      } finally {
        loading = false;
      }
    }
    void load();
  });

  function headersJson(h: Record<string, unknown> | null): string {
    if (h === null || h === undefined) return "(no headers)";
    try {
      return JSON.stringify(h, null, 2);
    } catch {
      return String(h);
    }
  }
</script>

<div class="email-detail" data-testid="inbound-email-detail-page">
  <a
    class="back-link"
    href="#/inbound-emails"
    data-testid="inbound-email-detail-back"
  >
    &larr; Back to Inbound Email
  </a>

  {#if loading}
    <div class="card" data-testid="inbound-email-detail-loading">
      <p class="text-muted">Loading email...</p>
    </div>
  {:else if notFound}
    <div class="card">
      <div class="empty-state" data-testid="inbound-email-detail-not-found">
        <p>Email not found.</p>
        <p class="empty-hint">
          It may have been removed, or the link is for a different app.
        </p>
      </div>
    </div>
  {:else if error}
    <div class="alert alert-error" data-testid="inbound-email-detail-error">
      Failed to load email: {error}
    </div>
  {:else if email}
    <!-- ---------- Header / metadata ---------- -->
    <header class="detail-header">
      <div class="header-top">
        <h1 class="subject" data-testid="inbound-email-detail-subject">
          {email.subject || "(no subject)"}
        </h1>
        <span
          class="badge {statusBadgeClass(email.status)}"
          title={STATUS_META[email.status]?.description ?? email.status}
          data-testid="inbound-email-detail-status"
        >
          {statusLabel(email.status)}
        </span>
      </div>
      {#if email.statusReason}
        <p class="status-reason" data-testid="inbound-email-detail-status-reason">
          {email.statusReason}
        </p>
      {/if}
      <dl class="meta-grid">
        <div>
          <dt>From</dt>
          <dd>{email.fromAddress || "--"}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>{email.toAddress || "--"}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{formatDateTime(email.receivedAt)}</dd>
        </div>
        <div>
          <dt>Processed</dt>
          <dd>{formatDateTime(email.processedAt)}</dd>
        </div>
      </dl>
    </header>

    <!-- ---------- Apply result ---------- -->
    {#if email.applyResult}
      <section class="card section-card" data-testid="inbound-email-detail-apply-result">
        <h2 class="section-title">Apply result</h2>
        <div class="apply-counts">
          <div class="apply-count">
            <span class="apply-num">{email.applyResult.applied}</span>
            <span class="apply-label">applied</span>
          </div>
          <div class="apply-count">
            <span class="apply-num">{email.applyResult.deferred}</span>
            <span class="apply-label">deferred</span>
          </div>
          <div class="apply-count" class:apply-failed={email.applyResult.failed > 0}>
            <span class="apply-num">{email.applyResult.failed}</span>
            <span class="apply-label">failed</span>
          </div>
        </div>
        {#if email.applyResult.summary}
          <p class="apply-summary">{email.applyResult.summary}</p>
        {/if}
      </section>
    {/if}

    <!-- ---------- Attachments ---------- -->
    {#if attachments.length > 0}
      <section class="card section-card" data-testid="inbound-email-detail-attachments">
        <h2 class="section-title">Attachments ({attachments.length})</h2>
        <ul class="attachment-list">
          {#each attachments as att (att.id)}
            <li class="attachment-row" data-testid="inbound-email-detail-attachment">
              <div class="att-meta">
                <span class="att-name">{att.filename || "(unnamed)"}</span>
                <span class="att-sub">
                  {att.contentType || "unknown type"} &middot; {formatBytes(att.sizeBytes)}
                </span>
              </div>
              {#if att.downloadUrl}
                <a
                  class="btn btn-secondary att-download"
                  href={att.downloadUrl}
                  download={att.filename || "attachment"}
                  rel="noopener"
                  data-testid="inbound-email-detail-download-attachment"
                >
                  Download
                </a>
              {:else if !att.stored}
                <span
                  class="att-unavailable"
                  data-testid="inbound-email-detail-attachment-not-stored"
                >
                  not stored
                </span>
              {:else}
                <span class="att-unavailable">not available</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- ---------- Body ----------
      SAFETY: the email body is untrusted sender content. We NEVER {@html}
      it into the app document. HTML bodies render inside an iframe with an
      EMPTY `sandbox` attribute (no scripts, forms, popups, or same-origin
      access) AND a restrictive CSP wrapper (frameSrcdocForEmailHtml) so
      remote sub-resources -- <img> tracking pixels, CSS url() beacons --
      can't load. Text bodies use Svelte text interpolation (auto-escaped).
    -->
    <section class="card section-card" data-testid="inbound-email-detail-body">
      <h2 class="section-title">Message</h2>
      {#if email.bodyHtml}
        <iframe
          class="body-html"
          sandbox=""
          referrerpolicy="no-referrer"
          srcdoc={frameSrcdocForEmailHtml(email.bodyHtml)}
          title="Email HTML body (sandboxed)"
          data-testid="inbound-email-detail-body-html"
        ></iframe>
        <p class="body-note">
          Rendered in a sandboxed frame -- scripts and remote content (images,
          tracking pixels) are disabled.
        </p>
      {:else if email.bodyText}
        <pre class="body-text" data-testid="inbound-email-detail-body-text">{email.bodyText}</pre>
      {:else}
        <p class="text-muted">(no body)</p>
      {/if}
    </section>

    <!-- ---------- Raw email + headers ---------- -->
    <section class="card section-card" data-testid="inbound-email-detail-raw">
      <div class="raw-row">
        <div>
          <h2 class="section-title">Raw email</h2>
          <p class="text-muted small">The full original MIME message, as captured.</p>
        </div>
        {#if email.rawMimeUrl}
          <a
            class="btn btn-secondary"
            href={email.rawMimeUrl}
            download="raw-email.eml"
            rel="noopener"
            data-testid="inbound-email-detail-raw-download"
          >
            Download raw email
          </a>
        {:else}
          <span class="att-unavailable" data-testid="inbound-email-detail-raw-unavailable">
            Raw MIME not captured
          </span>
        {/if}
      </div>

      {#if email.headers}
        <button
          type="button"
          class="headers-toggle"
          aria-expanded={headersOpen}
          onclick={() => (headersOpen = !headersOpen)}
          data-testid="inbound-email-detail-headers-toggle"
        >
          {headersOpen ? "Hide" : "Show"} headers
        </button>
        {#if headersOpen}
          <pre
            class="headers-json"
            data-testid="inbound-email-detail-headers"
          >{headersJson(email.headers)}</pre>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .email-detail {
    max-width: 860px;
  }

  .back-link {
    display: inline-block;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    margin-bottom: var(--space-md);
  }

  .back-link:hover {
    color: var(--color-text);
  }

  .small {
    font-size: var(--text-xs);
  }

  .text-muted {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    margin: 0;
  }

  .empty-hint {
    font-size: var(--text-xs);
    color: var(--color-muted);
  }

  /* ---------- Header ---------- */
  .detail-header {
    margin-bottom: var(--space-lg);
  }

  .header-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-md);
    margin-bottom: var(--space-sm);
  }

  .subject {
    font-size: var(--text-2xl);
    font-weight: 600;
    margin: 0;
    color: var(--color-text);
    word-break: break-word;
  }

  .status-reason {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0 0 var(--space-md);
  }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-md);
    margin: 0;
  }

  .meta-grid dt {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-muted);
    margin-bottom: 2px;
  }

  .meta-grid dd {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text);
    word-break: break-word;
  }

  /* ---------- Cards ---------- */
  .section-card {
    margin-bottom: var(--space-lg);
  }

  .section-title {
    font-size: var(--text-base);
    font-weight: 600;
    margin: 0 0 var(--space-md);
    color: var(--color-text);
  }

  /* ---------- Apply result ---------- */
  .apply-counts {
    display: flex;
    gap: var(--space-xl);
    margin-bottom: var(--space-md);
  }

  .apply-count {
    display: flex;
    flex-direction: column;
  }

  .apply-num {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--color-text);
  }

  .apply-failed .apply-num {
    color: var(--color-error);
  }

  .apply-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-muted);
  }

  .apply-summary {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* ---------- Attachments ---------- */
  .attachment-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .attachment-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    padding: var(--space-sm) var(--space-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }

  .att-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .att-name {
    font-weight: 500;
    font-size: var(--text-sm);
    color: var(--color-text);
    word-break: break-all;
  }

  .att-sub {
    font-size: var(--text-xs);
    color: var(--color-muted);
  }

  .att-download {
    flex-shrink: 0;
    text-decoration: none;
  }

  .att-unavailable {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--color-muted);
    font-style: italic;
  }

  /* ---------- Body ---------- */
  .body-text {
    margin: 0;
    padding: var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 480px;
    overflow: auto;
  }

  .body-html {
    width: 100%;
    height: 420px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: #ffffff;
  }

  .body-note {
    margin: var(--space-xs) 0 0;
    font-size: var(--text-xs);
    color: var(--color-muted);
  }

  /* ---------- Raw + headers ---------- */
  .raw-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-md);
    flex-wrap: wrap;
  }

  .headers-toggle {
    appearance: none;
    background: transparent;
    border: none;
    color: var(--color-text-secondary);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    cursor: pointer;
    padding: var(--space-sm) 0 0;
  }

  .headers-toggle:hover {
    color: var(--color-text);
  }

  .headers-json {
    margin: var(--space-sm) 0 0;
    padding: var(--space-sm) var(--space-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    color: var(--color-text);
    max-height: 360px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ---------- Status badge tones (match the list page) ---------- */
  .badge.badge-good {
    background: var(--color-success-bg);
    color: var(--color-success);
    border-color: rgba(22, 163, 74, 0.25);
  }

  .badge.badge-bad {
    background: var(--color-error-bg);
    color: var(--color-error);
    border-color: rgba(220, 38, 38, 0.25);
  }

  .badge.badge-warn {
    background: #fffbeb;
    color: #b45309;
    border-color: rgba(180, 83, 9, 0.25);
  }

  .badge.badge-info {
    background: #eff6ff;
    color: #2c5d99;
    border-color: rgba(44, 93, 153, 0.25);
  }

  .badge.badge-neutral {
    background: var(--color-surface);
    color: var(--color-text-secondary);
    border-color: var(--color-border);
  }

  @media (max-width: 768px) {
    .header-top {
      flex-direction: column;
      gap: var(--space-sm);
    }
  }
</style>
