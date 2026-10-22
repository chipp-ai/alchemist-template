# Chipp Payments: selling without a Stripe key

Chipp Payments lets this app sell one-time products and monthly or yearly
subscriptions on the org's own Stripe account. Chipp holds the Stripe
connection. This app holds no Stripe key, no OAuth token and no webhook
secret, and the builder never creates a webhook.

## How it is turned on

The builder sets it up in the Chipp Builder (the Sell tab, or by asking
"charge $29/month for Pro"). Chipp then injects `CHIPP_PAYMENTS_URL`,
`CHIPP_PAYMENTS_TOKEN`, `CHIPP_PAYMENTS_MODE`, `CHIPP_PAYMENTS_SCOPE`,
`CHIPP_PAYMENTS_PROJECT_ID` and `CHIPP_PAYMENTS_ORG_ID`. A Builder preview
always runs in test mode. The published app gets these only after an owner
or admin goes live; before that it does not sell, and test sales happen in
the preview only.

**Never ask the person for a Stripe key for Chipp Payments.** If
`STRIPE_SECRET_KEY` is set, the app keeps selling with its own key
(`src/services/product.service.ts`) and Chipp Payments stays off for it.
Moving such an app to Chipp Payments is the owner's decision.

## The pieces

| Piece | File |
|---|---|
| Broker client (checkout, portal, catalog, pull) | `src/lib/chipp-payments.ts` |
| Mirror into `products` and `purchases`, inbox handler | `src/services/chipp-entitlements.ts` |
| App routes `/api/chipp-payments/*` | `src/api/routes/chipp-payments/index.ts` |
| Upgrade button | `web/src/components/chipp-payments/UpgradeButton.svelte` |
| Manage billing link | `web/src/components/chipp-payments/ManageBillingLink.svelte` |
| Test mode banner (once, in `App.svelte`) | `web/src/components/chipp-payments/TestModeBanner.svelte` |
| Checkout return wait (`waitForPurchase`) | `web/src/lib/chipp-payments.ts`, logic in `web/src/lib/chipp-payments-return.ts` |
| Mirror columns | `db/migrations/*_chipp_payments_mirror.sql` |

## Wiring a paid feature

1. The product exists in Chipp (the builder confirmed it). Use its key,
   for example `pro`.
2. Put `<UpgradeButton productKey="pro" />` where the person decides to buy.
3. Put `<ManageBillingLink />` in Settings, near billing.
4. Gate the feature on the SERVER: `requirePurchase("pro")` or
   `hasActiveEntitlement(orgId, "pro")`. On the client,
   `billingStore.isEntitled("pro")` is UX only.
5. On the gated page, decide locked or unlocked with `waitForPurchase`.
   Stripe sends the buyer back before Chipp has always settled the sale, so
   a single read on the checkout return can still say locked. On a return,
   `waitForPurchase` pulls the sale and reads again with backoff, so the
   page unlocks without a reload. Show "Confirming your purchase…" while it
   waits, never the lock.

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { isCheckoutReturn, waitForPurchase } from "../lib/chipp-payments";

  type State = "loading" | "confirming" | "locked" | "pro" | "error";
  let state = $state<State>(isCheckoutReturn() ? "confirming" : "loading");

  onMount(async () => {
    try {
      const unlocked = await waitForPurchase(async () => {
        try {
          await api.get("/pro"); // requirePurchase("pro") on the server
          return true;
        } catch (err) {
          if ((err as { status?: number }).status === 402) return false;
          throw err;
        }
      });
      state = unlocked ? "pro" : "locked";
    } catch {
      state = "error";
    }
  });
</script>

{#if state === "confirming"}
  <p class="text-muted" role="status" data-testid="pro-confirming">Confirming your purchase…</p>
{/if}
```

## Rules

- Never grant access on the checkout return page. Chipp tells the app with
  a signed `entitlement.changed` event, and the return page only calls
  `/api/chipp-payments/sync` to pull sooner. `waitForPurchase` only waits
  for the server gate; it never grants access itself.
- Never send a price, an amount or a full URL to Chipp. Send the product
  key and a relative return path. Chipp builds the origin.
- Never create or edit products in this app while Chipp Payments is on.
  The catalog lives in Chipp; `products` is a mirror.
- A sale counts only in the mode the app runs in now (`purchases.chipp_mode`
  against `CHIPP_PAYMENTS_MODE`), so a test-card sale never unlocks a live
  app.
- Test card in test mode: 4242 4242 4242 4242, any future date, any CVC.
