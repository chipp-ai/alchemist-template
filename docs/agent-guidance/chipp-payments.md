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
always runs in test mode.

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
| Mirror columns | `db/migrations/*_chipp_payments_mirror.sql` |

## Wiring a paid feature

1. The product exists in Chipp (the builder confirmed it). Use its key,
   for example `pro`.
2. Put `<UpgradeButton productKey="pro" />` where the person decides to buy.
3. Put `<ManageBillingLink />` in Settings, near billing.
4. Gate the feature on the SERVER: `requirePurchase("pro")` or
   `hasActiveEntitlement(orgId, "pro")`. On the client,
   `billingStore.isEntitled("pro")` is UX only.

## Rules

- Never grant access on the checkout return page. Chipp tells the app with
  a signed `entitlement.changed` event, and the return page only calls
  `/api/chipp-payments/sync` to pull sooner.
- Never send a price, an amount or a full URL to Chipp. Send the product
  key and a relative return path. Chipp builds the origin.
- Never create or edit products in this app while Chipp Payments is on.
  The catalog lives in Chipp; `products` is a mirror.
- Test card in test mode: 4242 4242 4242 4242, any future date, any CVC.
