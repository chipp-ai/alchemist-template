# Selling things

## Selling things — built-in Stripe monetization (do NOT rebuild this)

The template ships a complete "sell something" layer on top of Stripe:
one-time products AND monthly/yearly subscription products, with checkout,
webhook fulfillment, and org-level entitlements. **When a ticket says
"charge for X", "add a premium tier", "sell an add-on", or "paywall this
feature", wire it through this layer — never hand-roll new Stripe calls,
products tables, or webhook handlers.**

### The pieces

| Piece | Where |
|---|---|
| `products` + `purchases` tables | `db/migrations/20260706135633_products_and_purchases.sql` |
| Catalog + checkout + fulfillment + entitlements | `src/services/product.service.ts` |
| Routes (`/api/billing/products`, `/purchases`, `/entitlements`, webhook) | `src/api/routes/billing/index.ts` |
| Server-side feature gate | `requireEntitlement("key")` in `src/api/middleware/entitlement.ts` (402, code `ENTITLEMENT_REQUIRED`) |
| Client store + checkout redirect | `web/src/stores/billing.svelte.ts` (`billingStore`) |
| Operator UI (create/archive products, purchases list) | Settings → Billing tab (`web/src/routes/Settings.svelte`). The tab shows once payments are set up (Stripe key or Chipp Payments; `paymentsConfigured()` in `src/lib/chipp-payments.ts`) or the org has a billing account. Settings itself is the sidebar footer link, not a main nav item. |
| Shared Stripe client (API-version pin lives here) | `src/lib/stripe.ts` — always `getStripe()`/`requireStripe()`, never `new Stripe(...)` inline |

### Turning on selling (the whole flow)

1. Create a product — Settings → Billing → "New product", or
   `POST /api/billing/products` (`billing.manage` capability, admin+), or
   `createProduct()` from a seed script. The service creates the **Stripe
   Product + Price via the API** — no dashboard steps, no env vars.
   `type: "one_time"` or `type: "subscription"` + `interval: "month" | "year"`.
2. Buyers hit `billingStore.startCheckout(productId)` → Stripe Checkout
   (mode follows the product type) → webhook records the purchase.
3. Gate the feature:
   - Server: `requireEntitlement("premium_reports")` after `requireAuth`, or
     `hasActiveEntitlement(orgId, "premium_reports")` in a service.
   - Client (UX only, not security): `billingStore.isEntitled("premium_reports")`.

Gate on the **`productKey`** (stable slug like `premium_reports`), never the
UUID. Price changes go through `updateProduct` (mints a new Stripe Price —
prices are immutable). Archive with `active: false`; never DELETE a product
that has purchases (FK is RESTRICT on purpose).

### Invariants (each prevents a real failure mode)

- **Product subscriptions must NEVER touch `organizations.subscription_tier`.**
  The webhook routes on `metadata.productId`: present → purchases table;
  absent → plan-tier path. Checkout stamps that metadata on the session AND
  the subscription (`subscription_data.metadata`). If you add a new checkout
  surface, stamp both or renewals will corrupt the org's plan tier.
- **Fulfillment is webhook-driven and idempotent.** Never grant an
  entitlement in the checkout success redirect (users refresh; Stripe
  retries). `recordProductPurchase` / `applyProductSubscriptionEvent` are
  safe under replays and out-of-order delivery — go through them.
- **Webhook handlers read Stripe defensively.** Treat `""` metadata as missing
  (a checkout that stamps `organizationId: ""` fulfills nothing otherwise),
  read a field that moved in newer Stripe API versions from both places
  (`invoice.subscription` and `invoice.parent.subscription_details`), stamp
  conversion state in the same handler that records the payment, and return
  5xx only for a failure a retry can fix.
- **`mapSubscriptionToTier` must only return values in the
  `subscription_tier` enum** (`FREE|STARTER|PRO|ENTERPRISE`). A made-up tier
  name crashes the org UPDATE inside the webhook.
- The plan-tier layer (env `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_YEARLY`,
  `GET /api/billing/subscription`, `POST /api/billing/checkout`) is for the
  org's plan of THIS app. Products are what the app sells on top. Don't
  merge the two.

## Selling through Chipp Payments (no Stripe key in the app)

When Chipp injects `CHIPP_PAYMENTS_TOKEN` (the builder turned on selling in
the Chipp Builder) and `STRIPE_SECRET_KEY` is NOT set, the same selling
layer above sells through Chipp: every sale is a direct charge on the org's
own Stripe Connect account, Chipp settles it from its own webhook, and this
app's `products` and `purchases` tables become a mirror that Chipp keeps
current with a signed `entitlement.changed` event (POST /api/events/inbox)
plus a pull. `requirePurchase`, `requireEntitlement` and `billingStore` work
unchanged. Full guide: `docs/agent-guidance/chipp-payments.md`.

- **Never ask for a Stripe key, a webhook secret, or a webhook setup** for
  Chipp Payments. There is none.
- **`STRIPE_SECRET_KEY` wins.** An app that already sells with its own key
  keeps that path. Never switch it silently.
- **UI:** `<UpgradeButton productKey="pro" />`,
  `<ManageBillingLink />` (`web/src/components/chipp-payments/`), and the
  test-mode banner already mounted in `App.svelte`.
- **Never grant access on the checkout return.** The return only pulls
  sooner (`/api/chipp-payments/sync`).
- **A gated page decides with `waitForPurchase(check)`** from
  `web/src/lib/chipp-payments.ts` and shows "Confirming your purchase…"
  while `isCheckoutReturn()` is true. A single read on the return can run
  before the sale settles and show the lock until a reload.
- **Products are managed in Chipp** (the Sell tab). `createProduct` and
  `updateProduct` refuse while Chipp Payments is on.
- **Test sales run in the preview only.** The published app gets the
  payments env after an owner goes live, and a sale counts only in the mode
  the app runs in now (`purchases.chipp_mode`), so a test-card sale never
  unlocks a live app.
- **Donations are Chipp Payments too.** A donation product lets any
  visitor give an amount they choose, once or monthly or yearly, with no
  account here: `<DonateForm productKey="donate" />` (or the `DonateForm`
  island), and donors return to `/app/#/donate/thank-you`. Gifts land in
  `chipp_donations`. Never build donations on the app's own Stripe keys and
  never ask for a webhook for them.
