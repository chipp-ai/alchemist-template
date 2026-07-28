<script lang="ts">
  import { onMount } from "svelte";
  import { push } from "svelte-spa-router";
  import {
    getInboundEmailsQuery,
    type InboundEmailFilter,
  } from "../stores/inboundEmails.svelte";
  import {
    INBOUND_EMAIL_STATUSES,
    relativeTime,
    formatDateTime,
    STATUS_META,
    statusBadgeClass,
    statusLabel,
  } from "../lib/inbound-emails";

  // ---------- State ----------

  let filter = $state<InboundEmailFilter>("all");
  let now = $state(Date.now());

  // One query handle per filter; createQuery is idempotent per key so
  // re-deriving on filter change just switches cache entries.
  const query = $derived(getInboundEmailsQuery(filter));
  const emails = $derived(query.data?.data.emails ?? []);

  onMount(() => {
    // Tick for relative timestamps -- cheap, no API hit. The query itself
    // background-refreshes via refetchInterval; no manual polling here.
    const tickTimer = window.setInterval(() => {
      now = Date.now();
    }, 1_000);
    return () => window.clearInterval(tickTimer);
  });

  // ---------- Interactions ----------

  function openDetail(id: string): void {
    push(`/inbound-emails/${id}`);
  }

  function onRowKeydown(e: KeyboardEvent, id: string): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetail(id);
    }
  }

  // Filter chip config: All, then each status in enum order.
  const filterChips: { value: InboundEmailFilter; label: string }[] = [
    { value: "all", label: "All" },
    ...INBOUND_EMAIL_STATUSES.map((s) => ({
      value: s as InboundEmailFilter,
      label: STATUS_META[s].label,
    })),
  ];
</script>

<div class="inbound-emails" data-testid="inbound-emails-page">
  <div class="page-header">
    <div>
      <h1 class="page-title">Inbound Email</h1>
      <p class="page-subtitle">Emails received at the ingestion address</p>
    </div>
  </div>

  <div
    class="filter-bar"
    role="group"
    aria-label="Filter by status"
    data-testid="inbound-emails-filters"
  >
    {#each filterChips as chip (chip.value)}
      <button
        type="button"
        class="filter-chip"
        class:active={filter === chip.value}
        aria-pressed={filter === chip.value}
        title={chip.value !== "all" ? STATUS_META[chip.value].description : undefined}
        onclick={() => (filter = chip.value)}
        data-testid="inbound-emails-filter-{chip.value}"
      >
        {chip.label}
      </button>
    {/each}
  </div>

  {#if query.isLoading}
    <div class="card" data-testid="inbound-emails-loading">
      <p class="text-muted">Loading inbound emails...</p>
    </div>
  {:else if query.error && emails.length === 0}
    <div class="alert alert-error" data-testid="inbound-emails-error">
      Failed to load inbound emails: {query.error}
    </div>
  {:else if emails.length === 0}
    <div class="card">
      <div class="empty-state" data-testid="inbound-emails-empty">
        {#if filter === "all"}
          <p>No inbound emails yet.</p>
          <p class="empty-hint">
            This feature is dormant until the platform provisions an ingestion
            address and INGEST_EMAIL_TOKEN for this app.
          </p>
        {:else}
          <p>No emails match this filter.</p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="card table-card">
      <table class="email-table" data-testid="inbound-emails-table">
        <thead>
          <tr>
            <th scope="col">Received</th>
            <th scope="col">From</th>
            <th scope="col">Subject</th>
            <th scope="col" class="col-num">Attach.</th>
            <th scope="col">Status</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {#each emails as email (email.id)}
            <tr
              class="email-row"
              role="button"
              tabindex="0"
              aria-label={`Open email: ${email.subject || "(no subject)"}`}
              onclick={() => openDetail(email.id)}
              onkeydown={(e) => onRowKeydown(e, email.id)}
              data-testid="inbound-emails-list-row"
            >
              <td class="cell-received" title={formatDateTime(email.receivedAt)}>
                {relativeTime(email.receivedAt, now)}
              </td>
              <td class="cell-from">{email.fromAddress || "--"}</td>
              <td class="cell-subject">{email.subject || "(no subject)"}</td>
              <td class="cell-num">
                {email.attachmentCount > 0 ? email.attachmentCount : "--"}
              </td>
              <td>
                <span
                  class="badge {statusBadgeClass(email.status)}"
                  title={STATUS_META[email.status]?.description ?? email.status}
                  data-testid="inbound-emails-status-badge"
                >
                  {statusLabel(email.status)}
                </span>
              </td>
              <td class="cell-reason" title={email.statusReason ?? ""}>
                {email.statusReason ?? "--"}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .inbound-emails {
    max-width: 1100px;
  }

  /* ---------- Filter bar ---------- */
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-xs);
    margin-bottom: var(--space-lg);
  }

  .filter-chip {
    appearance: none;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 500;
    padding: 5px 13px;
    border-radius: var(--radius-full);
    background: var(--color-surface);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    cursor: pointer;
    transition: background-color 0.15s, color 0.15s, border-color 0.15s;
  }

  .filter-chip:hover {
    background: var(--color-bg);
    color: var(--color-text);
  }

  .filter-chip:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .filter-chip.active {
    background: var(--color-accent);
    color: var(--color-accent-text);
    border-color: var(--color-accent);
    font-weight: 600;
  }

  /* ---------- Table ---------- */
  .table-card {
    padding: 0;
    overflow: hidden;
  }

  .email-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .email-table th,
  .email-table td {
    text-align: left;
    padding: var(--space-sm) var(--space-md);
    border-bottom: 1px solid var(--color-border);
  }

  .email-table th {
    font-weight: 600;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--color-surface);
  }

  .email-table tbody tr:last-child td {
    border-bottom: none;
  }

  .col-num,
  .cell-num {
    text-align: right;
    white-space: nowrap;
  }

  .email-row {
    cursor: pointer;
    /* Instant hover swap -- paint properties (background/box-shadow/border)
       never belong in a transition list on list rows; see the
       "Hover/interactive transitions" rule in CLAUDE.md. */
  }

  .email-row:hover td {
    background: var(--color-surface);
  }

  .email-row:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .cell-received {
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .cell-from {
    color: var(--color-text-secondary);
    white-space: nowrap;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cell-subject {
    color: var(--color-text);
    font-weight: 500;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cell-reason {
    color: var(--color-muted);
    font-size: var(--text-xs);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---------- Status badge tones ----------
     The template palette only ships success/error tokens; amber (warn)
     and blue (info) tones are defined locally so each status reads as a
     distinct color. */
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

  .text-muted {
    font-size: var(--text-sm);
    color: var(--color-muted);
  }

  .empty-hint {
    font-size: var(--text-xs);
    color: var(--color-muted);
    max-width: 52ch;
  }

  @media (max-width: 768px) {
    .email-table {
      font-size: var(--text-xs);
    }
    .email-table th,
    .email-table td {
      padding: var(--space-xs) var(--space-sm);
    }
    .cell-from,
    .cell-subject {
      max-width: 140px;
    }
    .cell-reason,
    .email-table th:last-child {
      display: none;
    }
  }
</style>
