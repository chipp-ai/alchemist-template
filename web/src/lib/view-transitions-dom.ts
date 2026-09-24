/**
 * View Transitions API wrapper for SPA route changes — the DOM half of
 * the split documented in `view-transitions.ts`. This is the ONLY file
 * that touches `document` / `matchMedia` for this feature, and it is
 * imported ONLY from Svelte components (never from a `deno test` entry
 * point) so its DOM globals never enter the Deno type-checker's module
 * graph.
 *
 * `runWithViewTransition` degrades to a plain synchronous call of
 * `update()` when the API is unsupported or reduced motion is requested —
 * the route change itself always happens; only the cross-fade is
 * conditional.
 */

import { shouldUseViewTransition } from "./view-transitions.ts";

/**
 * Run `update` (typically a svelte-spa-router navigation) inside
 * `document.startViewTransition` when supported and motion is allowed;
 * otherwise just calls `update()` directly. Errors from `update` propagate
 * normally either way.
 */
export function runWithViewTransition(update: () => void): void {
  const supportsViewTransitions =
    typeof document !== "undefined" &&
    typeof (document as { startViewTransition?: unknown }).startViewTransition === "function";
  const prefersReducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!shouldUseViewTransition({ supportsViewTransitions, prefersReducedMotion })) {
    update();
    return;
  }

  const transition = (document as unknown as {
    startViewTransition: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> };
  }).startViewTransition(update);

  // A transition that gets skipped (a second navigation lands mid-fade, the
  // tab is hidden, the routed tree remounts under it) rejects `ready` with
  // InvalidStateError. That is the browser saying "no cross-fade this
  // time", not a failure: `update()` already ran. Without these handlers
  // every skipped fade surfaces as an unhandled promise rejection in the
  // console (seen on logout, which navigates twice: the auth effect and
  // the logout redirect).
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}

/**
 * Convenience wrappers for svelte-spa-router's `push`/`replace` — pass the
 * router function itself (so this module doesn't hard-depend on
 * svelte-spa-router) plus the destination path. Use at the app's
 * programmatic-navigation call sites (redirects, post-auth landing) to get
 * a cross-fade where the browser supports it and motion is allowed.
 *
 * Native `<a use:link>` clicks (e.g. Sidebar nav) are NOT wrapped here —
 * intercepting those safely would mean re-implementing svelte-spa-router's
 * own click handling, which risks breaking navigation for a purely
 * cosmetic win. This covers the app's actual imperative redirects.
 */
export function navigateWithTransition(navigate: (path: string) => void, path: string): void {
  runWithViewTransition(() => navigate(path));
}
