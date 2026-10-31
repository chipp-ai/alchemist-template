<!--
  Thank-you page for a Chipp Payments donation: /app/#/donate/thank-you

  Stripe Checkout sends the donor here with chipp_purchase and session_id
  in the URL. The page confirms the gift with this app's server (which
  asks Chipp and records it in chipp_donations) and, for a monthly or
  yearly gift, offers the link to change the card or cancel. Public: a
  donor has no account in this app. The link is the donor's to keep.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import {
    confirmDonation,
    type DonationReceipt,
    manageDonationUrl,
    readDonationReturn,
    thankYouLine,
  } from "../lib/chipp-donations";

  type View = "loading" | "confirmed" | "processing" | "missing" | "error";
  let view = $state<View>("loading");
  let receipt = $state<DonationReceipt | null>(null);
  let ref = $state<{ purchaseId: string; sessionId: string } | null>(null);
  let managing = $state(false);
  let manageError = $state<string | null>(null);

  const DELAYS_MS = [800, 1600, 3200, 6400];
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  onMount(async () => {
    ref = readDonationReturn(window.location.href);
    if (!ref) {
      view = "missing";
      return;
    }
    // Stripe can send the donor back a moment before the gift settles.
    for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(DELAYS_MS[attempt - 1]);
      try {
        receipt = await confirmDonation(ref);
      } catch {
        view = "error";
        return;
      }
      if (receipt.status !== "pending") break;
    }
    view = receipt && receipt.status !== "pending" ? "confirmed" : "processing";
  });

  async function manage() {
    if (!ref) return;
    managing = true;
    manageError = null;
    try {
      window.location.assign(await manageDonationUrl({ ...ref, returnPath: `${window.location.pathname}${window.location.search}${window.location.hash}` }));
    } catch (err) {
      manageError = err instanceof Error ? err.message : "The donation settings could not open. Try again.";
      managing = false;
    }
  }
</script>

<main class="thanks" data-testid="donation-thank-you-page">
  <section class="thanks-card card" aria-live="polite">
    {#if view === "loading"}
      <p class="text-muted" role="status" data-testid="donation-thank-you-loading">Confirming your gift…</p>
    {:else if view === "missing"}
      <h1 class="thanks-title">Thank you</h1>
      <p class="thanks-body">We could not find a gift in this link. If you just gave, check your email for the receipt.</p>
    {:else if view === "error"}
      <h1 class="thanks-title">Thank you</h1>
      <p class="thanks-body" data-testid="donation-thank-you-error">
        We could not confirm your gift right now. If you were charged, your receipt is on its way by email.
      </p>
    {:else if receipt}
      <h1 class="thanks-title" data-testid="donation-thank-you-title">Thank you!</h1>
      <p class="thanks-body" data-testid="donation-thank-you-line">{thankYouLine(receipt)}</p>
      {#if view === "processing"}
        <p class="text-muted">Your payment is still being confirmed. You will get a receipt by email.</p>
      {:else}
        <p class="text-muted">A receipt is on its way to your email.</p>
      {/if}
      {#if receipt.recurring && receipt.canManage}
        <div class="thanks-manage">
          <p class="text-muted">Keep this page's link to change your card or cancel your {receipt.interval === "year" ? "yearly" : "monthly"} gift.</p>
          <button
            type="button"
            class="btn btn-secondary"
            onclick={manage}
            disabled={managing}
            data-loading={managing ? "" : undefined}
            data-testid="donation-thank-you-btn-manage"
          >
            Manage my donation
          </button>
          {#if manageError}
            <p class="thanks-error" role="alert">{manageError}</p>
          {/if}
        </div>
      {/if}
    {/if}
    <a class="btn btn-ghost" href="/" data-testid="donation-thank-you-link-home">Back to the site</a>
  </section>
</main>

<style>
  .thanks {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-md);
    background: var(--color-bg);
    box-sizing: border-box;
  }
  .thanks-card {
    width: 100%;
    max-width: 30rem;
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    align-items: flex-start;
  }
  .thanks-title {
    margin: 0;
    font-family: var(--font-heading);
    font-size: var(--text-2xl);
  }
  .thanks-body {
    margin: 0;
    font-size: var(--text-lg);
    color: var(--color-text);
  }
  .thanks-manage {
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    align-items: flex-start;
  }
  .thanks-error {
    margin: 0;
    color: var(--color-error);
    font-size: var(--text-sm);
  }
</style>
