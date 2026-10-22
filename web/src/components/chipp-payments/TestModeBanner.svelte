<!--
  Shows a banner while payments run in TEST mode, so no one mistakes a test
  checkout for a real one. Renders nothing in live mode or when Chipp
  Payments is off. Place it once, near the top of App.svelte.

  <TestModeBanner />
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { checkoutReturnSync, chippPaymentsStatus, isCheckoutReturn } from "../../lib/chipp-payments";

  let testMode = $state(false);

  onMount(() => {
    chippPaymentsStatus().then((s) => {
      testMode = s.active && s.testMode;
      if (s.active && isCheckoutReturn()) {
        checkoutReturnSync().catch((err) => console.warn("Chipp Payments sync after checkout failed", err));
      }
    });
  });
</script>

{#if testMode}
  <div class="chipp-payments-test-banner" role="status" data-testid="chipp-payments-test-mode-banner">
    Test mode: payments here are not real. Use card 4242 4242 4242 4242.
  </div>
{/if}

<style>
  .chipp-payments-test-banner {
    padding: var(--space-xs) var(--space-md);
    background: var(--color-warning-bg);
    border-bottom: 1px solid var(--color-warning-border);
    color: var(--color-text);
    font-size: 0.875rem;
    text-align: center;
  }
</style>
