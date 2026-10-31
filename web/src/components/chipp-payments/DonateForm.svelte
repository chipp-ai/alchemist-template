<!--
  Donation form for a Chipp Payments donation product.

  <DonateForm productKey="donate" />
  <DonateForm productKey="donate" title="Support the team" returnPath="/app/#/donate/thank-you" />

  The visitor picks how often (once, monthly, yearly, as the product
  allows), an amount chip or their own amount, and goes to Stripe Checkout
  on the organization's own Stripe account. No account in this app is
  needed: Checkout collects the email and Stripe emails the receipt.

  Self-contained on purpose (no api client, no stores), so the same file
  also mounts as the DonateForm island on a server-rendered page.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import {
    DONATION_THANK_YOU_RETURN_PATH,
    type DonationFrequency,
    type DonationProduct,
    donationAmountError,
    fetchDonationCatalog,
    formatDonationAmount,
    FREQUENCY_LABELS,
    parseAmountToCents,
    startDonation,
  } from "../../lib/chipp-donations";

  let {
    productKey,
    title,
    returnPath = DONATION_THANK_YOU_RETURN_PATH,
    cancelPath,
  }: { productKey: string; title?: string; returnPath?: string; cancelPath?: string } = $props();

  type Load = "loading" | "ready" | "unavailable";
  let load = $state<Load>("loading");
  let product = $state<DonationProduct | null>(null);
  let testMode = $state(false);
  let frequency = $state<DonationFrequency>("one_time");
  /** A suggested amount in cents, or "other". */
  let choice = $state<number | "other">("other");
  let other = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let touched = $state(false);

  const uid = Math.random().toString(36).slice(2, 8);

  onMount(async () => {
    const catalog = await fetchDonationCatalog();
    const found = catalog.active ? catalog.donations.find((d) => d.key === productKey) ?? null : null;
    if (!found) {
      load = "unavailable";
      return;
    }
    product = found;
    testMode = catalog.testMode;
    frequency = found.frequencies[0] ?? "one_time";
    const chips = found.suggestedAmountsCents;
    choice = chips.length > 0 ? chips[Math.min(1, chips.length - 1)] : "other";
    load = "ready";
  });

  const amountCents = $derived(choice === "other" ? parseAmountToCents(other) : choice);
  const amountProblem = $derived(product ? donationAmountError(amountCents, product) : null);
  const submitLabel = $derived.by(() => {
    if (!product || amountCents === null || amountProblem) return "Donate";
    const amount = formatDonationAmount(amountCents, product.currency);
    if (frequency === "month") return `Donate ${amount} monthly`;
    if (frequency === "year") return `Donate ${amount} yearly`;
    return `Donate ${amount}`;
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    touched = true;
    if (!product || amountCents === null || amountProblem) return;
    busy = true;
    error = null;
    try {
      const url = await startDonation({
        productKey,
        amountCents,
        frequency,
        returnPath,
        cancelPath: cancelPath ?? `${window.location.pathname}${window.location.search}${window.location.hash}`,
      });
      window.location.assign(url);
    } catch (err) {
      error = err instanceof Error ? err.message : "Checkout could not start. Try again.";
      busy = false;
    }
  }
</script>

{#if load === "loading"}
  <div class="donate donate--loading" data-testid="chipp-donate-form-loading" aria-busy="true">
    <div class="donate-skeleton"></div>
  </div>
{:else if load === "unavailable" || !product}
  <p class="donate-unavailable" data-testid="chipp-donate-form-unavailable">Online giving opens soon.</p>
{:else}
  <form class="donate" data-testid="chipp-donate-form-{productKey}" onsubmit={submit} novalidate>
    <h2 class="donate-title">{title ?? product.name}</h2>
    {#if product.description}
      <p class="donate-description">{product.description}</p>
    {/if}

    {#if product.frequencies.length > 1}
      <fieldset class="donate-group">
        <legend class="donate-legend">How often</legend>
        <div class="donate-segments">
          {#each product.frequencies as f (f)}
            <label class="donate-segment" class:is-selected={frequency === f}>
              <input
                type="radio"
                name="donate-frequency-{uid}"
                value={f}
                checked={frequency === f}
                onchange={() => (frequency = f)}
                data-testid="chipp-donate-form-frequency-{f}"
              />
              <span>{FREQUENCY_LABELS[f]}</span>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    <fieldset class="donate-group">
      <legend class="donate-legend">Amount</legend>
      <div class="donate-chips">
        {#each product.suggestedAmountsCents as cents (cents)}
          <label class="donate-chip" class:is-selected={choice === cents}>
            <input
              type="radio"
              name="donate-amount-{uid}"
              value={cents}
              checked={choice === cents}
              onchange={() => (choice = cents)}
              data-testid="chipp-donate-form-amount-{cents}"
            />
            <span>{formatDonationAmount(cents, product.currency)}</span>
          </label>
        {/each}
        <label class="donate-chip" class:is-selected={choice === "other"}>
          <input
            type="radio"
            name="donate-amount-{uid}"
            value="other"
            checked={choice === "other"}
            onchange={() => (choice = "other")}
            data-testid="chipp-donate-form-amount-other"
          />
          <span>Other</span>
        </label>
      </div>

      {#if choice === "other"}
        <label class="donate-other" for="donate-other-{uid}">
          <span class="donate-other-label">Your amount</span>
          <span class="donate-other-field">
            <span class="donate-other-prefix" aria-hidden="true">{product.currency === "usd" ? "$" : product.currency.toUpperCase()}</span>
            <input
              id="donate-other-{uid}"
              class="input donate-other-input"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              placeholder={(product.minAmountCents / 100).toFixed(0)}
              bind:value={other}
              onblur={() => (touched = true)}
              aria-invalid={touched && !!amountProblem}
              aria-describedby="donate-hint-{uid}"
              data-testid="chipp-donate-form-input-other"
            />
          </span>
        </label>
      {/if}
      <p
        id="donate-hint-{uid}"
        class="donate-hint"
        class:is-error={touched && !!amountProblem}
        aria-live="polite"
      >
        {#if touched && amountProblem}
          {amountProblem}
        {:else}
          The smallest gift is {formatDonationAmount(product.minAmountCents, product.currency)}.
        {/if}
      </p>
    </fieldset>

    <button
      type="submit"
      class="btn btn-primary donate-submit"
      disabled={busy}
      data-loading={busy ? "" : undefined}
      data-testid="chipp-donate-form-btn-submit"
    >
      {submitLabel}
    </button>

    {#if error}
      <p class="donate-error" role="alert" data-testid="chipp-donate-form-error">{error}</p>
    {/if}
    <p class="donate-fineprint">
      {#if testMode}
        Test mode: no real money moves.
      {:else}
        Secure checkout by Stripe. You get a receipt by email.
      {/if}
      {#if frequency !== "one_time"}
        Cancel any time from the link on the thank-you page.
      {/if}
    </p>
  </form>
{/if}

<style>
  .donate {
    display: flex;
    flex-direction: column;
    gap: var(--space-md);
    max-width: 28rem;
    width: 100%;
    padding: var(--space-lg);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    box-sizing: border-box;
  }
  .donate--loading {
    min-height: 16rem;
  }
  .donate-skeleton {
    flex: 1;
    border-radius: var(--radius-md);
    background: var(--color-surface-sunken);
  }
  .donate-title {
    margin: 0;
    font-family: var(--font-heading);
    font-size: var(--text-lg);
    color: var(--color-text);
  }
  .donate-description,
  .donate-unavailable {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-base);
  }
  .donate-group {
    margin: 0;
    padding: 0;
    border: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    min-width: 0;
  }
  .donate-legend {
    padding: 0;
    margin-bottom: var(--space-sm);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text-secondary);
  }
  .donate-segments {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    padding: var(--space-xs);
    gap: var(--space-xs);
    background: var(--color-surface-sunken);
    border-radius: var(--radius-md);
  }
  .donate-chips {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
    gap: var(--space-sm);
  }
  .donate-segment,
  .donate-chip {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 var(--space-sm);
    border-radius: var(--radius-md);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--color-text);
    cursor: pointer;
    user-select: none;
  }
  .donate-chip {
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface-raised);
  }
  .donate-segment.is-selected {
    background: var(--color-surface-raised);
    box-shadow: var(--shadow-sm);
  }
  .donate-segment:active,
  .donate-chip:active {
    transform: scale(0.98);
  }
  .donate-chip.is-selected {
    border-color: var(--color-accent);
    background: var(--color-accent-subtle);
  }
  .donate-segment input,
  .donate-chip input {
    position: absolute;
    opacity: 0;
    inset: 0;
    margin: 0;
    cursor: pointer;
  }
  .donate-segment:has(input:focus-visible),
  .donate-chip:has(input:focus-visible) {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }
  .donate-other {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }
  .donate-other-label {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .donate-other-field {
    position: relative;
    display: flex;
    align-items: center;
  }
  .donate-other-prefix {
    position: absolute;
    left: var(--space-md);
    font-size: 16px;
    color: var(--color-text-secondary);
    pointer-events: none;
  }
  .donate-other-input {
    width: 100%;
    min-height: 44px;
    padding-left: calc(var(--space-md) + 2.25ch);
    /* 16px keeps iOS Safari from zooming into the field. */
    font-size: 16px;
  }
  .donate-hint {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .donate-hint.is-error,
  .donate-error {
    color: var(--color-error);
  }
  .donate-error {
    margin: 0;
    font-size: var(--text-sm);
  }
  .donate-submit {
    width: 100%;
    min-height: 48px;
    font-size: var(--text-base);
  }
  .donate-fineprint {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-muted);
    text-align: center;
  }
  @media (max-width: 480px) {
    .donate {
      padding: var(--space-md);
    }
  }
</style>
