/**
 * View Transitions API wrapper for SPA route changes — same pure-gate /
 * thin-DOM-wrapper split as reveal.ts and theme.ts.
 *
 * `document.startViewTransition` is unsupported in a large chunk of
 * browsers (Firefox, Safari < 18) and must never be used when the user
 * has asked for reduced motion. `runWithViewTransition` degrades to a
 * plain synchronous call of `update()` in both cases — the route change
 * itself always happens; only the cross-fade is conditional. See
 * web/src/motion.css for the `::view-transition-*` pseudo-element rules
 * (also reduced-motion-gated independently, belt and suspenders).
 */

/** Pure gate — no DOM access, fully unit-testable. */
export function shouldUseViewTransition(opts: {
  supportsViewTransitions: boolean;
  prefersReducedMotion: boolean;
}): boolean {
  return opts.supportsViewTransitions && !opts.prefersReducedMotion;
}

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

  (document as unknown as { startViewTransition: (cb: () => void) => void }).startViewTransition(update);
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
