/**
 * The checkout return, as pure logic with no imports, so a Deno test can run
 * it and web/src/lib/chipp-payments.ts can wire it to the API.
 *
 * Stripe sends the buyer back before Chipp has always settled the sale, so
 * the first entitlement read after a return can still say "locked". A gated
 * page waits here, pulling and re-reading with backoff, and shows
 * "Confirming your purchase…" meanwhile, instead of showing the lock until
 * a reload.
 */

/** Delays between attempts, in ms. Five reads over about 7.5 seconds. */
export const CHECKOUT_RETURN_DELAYS_MS: readonly number[] = [
  500,
  1000,
  2000,
  4000,
];

export interface ConfirmPurchaseDeps {
  /** True when the page was opened by a successful checkout return. */
  isReturn: boolean;
  /** Pulls sales Chipp settled. Errors are ignored: the read decides. */
  sync: (attempt: number) => Promise<unknown>;
  /** The page's own access read (the server gate). Throws on a real error. */
  check: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves true when `check` grants access. Not a checkout return: one read.
 * A checkout return: sync then read, retried with backoff until the read
 * grants access or the delays run out. An error from `check` is a real
 * error and is thrown; a failed sync only means "not yet".
 */
export async function confirmPurchase(
  deps: ConfirmPurchaseDeps,
): Promise<boolean> {
  if (!deps.isReturn) return await deps.check();
  const delays = deps.delaysMs ?? CHECKOUT_RETURN_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1]);
    await Promise.resolve().then(() => deps.sync(attempt)).catch(() =>
      undefined
    );
    if (await deps.check()) return true;
  }
  return false;
}

/**
 * `href` without the parameters Chipp adds to a checkout return
 * (chipp_checkout, chipp_purchase, session_id), so a reload does not wait
 * again. Other parameters and the hash route stay.
 */
export function withoutCheckoutMarker(href: string): string {
  const url = new URL(href);
  if (!url.searchParams.has("chipp_checkout")) return href;
  for (const name of ["chipp_checkout", "chipp_purchase", "session_id"]) {
    url.searchParams.delete(name);
  }
  return url.toString();
}
