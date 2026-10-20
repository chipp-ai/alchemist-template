<!--
  "Manage billing" link: opens the Stripe billing portal (cancel, change
  card, invoices) for the signed-in user's organization.

  <ManageBillingLink />
-->
<script lang="ts">
  import { openBillingPortal } from "../../lib/chipp-payments";

  let { label = "Manage billing" }: { label?: string } = $props();
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function go() {
    busy = true;
    error = null;
    try {
      await openBillingPortal();
    } catch (err) {
      error = err instanceof Error ? err.message : "Billing could not open. Try again.";
      busy = false;
    }
  }
</script>

<button
  type="button"
  class="btn btn-secondary"
  data-testid="chipp-payments-manage-billing-button"
  data-loading={busy ? "" : undefined}
  disabled={busy}
  onclick={go}
>
  {label}
</button>
{#if error}
  <p class="chipp-payments-error" role="alert" data-testid="chipp-payments-manage-billing-error">{error}</p>
{/if}

<style>
  .chipp-payments-error {
    margin: var(--space-xs) 0 0;
    color: var(--color-error);
    font-size: 0.875rem;
  }
</style>
