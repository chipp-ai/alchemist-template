<!--
  Upgrade button for a Chipp Payments product.

  <UpgradeButton productKey="pro" />
  <UpgradeButton productKey="setup" label="Buy setup" returnPath="/app/#/onboarding" />

  Sends the buyer to Stripe Checkout through this app's API. Access is
  granted by the server when Chipp confirms the payment, never by this
  button or the return page.
-->
<script lang="ts">
  import { startUpgrade } from "../../lib/chipp-payments";

  let {
    productKey,
    label = "Upgrade",
    returnPath,
  }: { productKey: string; label?: string; returnPath?: string } = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function go() {
    busy = true;
    error = null;
    try {
      await startUpgrade(productKey, returnPath);
    } catch (err) {
      error = err instanceof Error ? err.message : "Checkout could not start. Try again.";
      busy = false;
    }
  }
</script>

<button
  type="button"
  class="btn btn-primary"
  data-testid="chipp-payments-upgrade-button-{productKey}"
  data-loading={busy ? "" : undefined}
  disabled={busy}
  onclick={go}
>
  {label}
</button>
{#if error}
  <p class="chipp-payments-error" role="alert" data-testid="chipp-payments-upgrade-error">{error}</p>
{/if}

<style>
  .chipp-payments-error {
    margin: var(--space-xs) 0 0;
    color: var(--color-error);
    font-size: 0.875rem;
  }
</style>
