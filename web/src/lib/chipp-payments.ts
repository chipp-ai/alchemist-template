/**
 * Chipp Payments in the browser: upgrade, manage billing, and the test banner.
 *
 * Every call goes to this app's own API (/api/chipp-payments/*). The browser
 * never talks to Stripe or to Chipp directly, and never sends a price.
 */

import { api } from "./api";
import { confirmPurchase, withoutCheckoutMarker } from "./chipp-payments-return";

export { CHECKOUT_RETURN_DELAYS_MS } from "./chipp-payments-return";

export interface ChippPaymentsStatus {
  active: boolean;
  ownStripeKey: boolean;
  mode: "test" | "live" | null;
  testMode: boolean;
  sandboxAccount: boolean;
  products: Array<{
    key: string;
    name: string;
    description: string | null;
    kind: "one_time" | "subscription";
    amountCents: number;
    currency: string;
    interval: "month" | "year" | null;
  }>;
}

let statusPromise: Promise<ChippPaymentsStatus> | null = null;

/** The payments status, fetched once per page load. */
export function chippPaymentsStatus(): Promise<ChippPaymentsStatus> {
  statusPromise ??= api
    .get<{ data: ChippPaymentsStatus }>("/chipp-payments/status", { silent401: true })
    .then((r) => r.data)
    .catch(() => {
      statusPromise = null;
      return {
        active: false,
        ownStripeKey: false,
        mode: null,
        testMode: false,
        sandboxAccount: false,
        products: [],
      };
    });
  return statusPromise;
}

/** The current page as a relative return path ("/app/#/pricing"). */
export function currentReturnPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** Sends the buyer to Chipp's Stripe Checkout for `productKey`. */
export async function startUpgrade(
  productKey: string,
  returnPath: string = currentReturnPath(),
): Promise<void> {
  const res = await api.post<{ data: { url: string } }>("/chipp-payments/checkout", {
    productKey,
    returnPath,
  });
  window.location.assign(res.data.url);
}

/** Opens the Stripe billing portal for the signed-in user's organization. */
export async function openBillingPortal(returnPath: string = currentReturnPath()): Promise<void> {
  const res = await api.post<{ data: { url: string } }>("/chipp-payments/portal", { returnPath });
  window.location.assign(res.data.url);
}

/** Pulls sales Chipp settled. Call after the checkout return. */
export async function syncPurchases(): Promise<Record<string, boolean>> {
  const res = await api.post<{ data: { entitlements: Record<string, boolean> } }>(
    "/chipp-payments/sync",
  );
  return res.data.entitlements;
}

/** True when the page was opened by a successful Chipp checkout return. */
export function isCheckoutReturn(href: string = window.location.href): boolean {
  return /[?&]chipp_checkout=success\b/.test(href);
}

let returnSyncPromise: Promise<unknown> | null = null;

/**
 * The first sync after a checkout return, shared by the test banner and
 * every gated page on this page load, so the return pulls once, not once
 * per component.
 */
export function checkoutReturnSync(): Promise<unknown> {
  returnSyncPromise ??= syncPurchases();
  return returnSyncPromise;
}

/**
 * Decides a gated page after a checkout return. `check` is the page's own
 * access read (the server gate), resolving true when the person has access:
 *
 *   const unlocked = await waitForPurchase(async () => {
 *     try { await api.get("/pro"); return true; }
 *     catch (err) { if ((err as { status?: number }).status === 402) return false; throw err; }
 *   });
 *
 * On a normal visit it reads once. On a checkout return it pulls the sale
 * from Chipp and reads again with backoff (about 7.5 seconds in all), so the
 * page unlocks without a reload. While `isCheckoutReturn()` is true, show
 * "Confirming your purchase…" instead of the lock. Access still comes only
 * from the server gate: this only waits for it.
 */
export async function waitForPurchase(check: () => Promise<boolean>): Promise<boolean> {
  const isReturn = isCheckoutReturn() && (await chippPaymentsStatus()).active;
  const unlocked = await confirmPurchase({
    isReturn,
    sync: (attempt) => (attempt === 0 ? checkoutReturnSync() : syncPurchases()),
    check,
  });
  // A reload after the answer must not wait again.
  if (isReturn && unlocked) {
    history.replaceState(history.state, "", withoutCheckoutMarker(window.location.href));
  }
  return unlocked;
}
