/**
 * Staggered reveal-on-scroll — PURE gating logic only, split the same way
 * as color-math.ts / theme.ts: the DECISION of whether to arm the effect
 * at all lives here as a pure function (zero DOM globals, so it type-checks
 * and unit-tests directly under Deno's default `deno.window` lib — no
 * `dom` lib needed). The IntersectionObserver plumbing that actually
 * touches the page lives in the sibling `reveal-dom.ts`, which is never
 * imported by a `deno test` entry point — keeping DOM-only globals
 * (`document`, `IntersectionObserver`, `matchMedia`, `HTMLElement`,
 * `requestAnimationFrame`) out of this file's module graph is what makes
 * `deno test src/__tests__/` (run WITHOUT `--no-check` in CI) succeed.
 *
 * Fail-safe contract (docs/design-system-program.md's S1 motion section):
 * elements marked `.reveal` in web/src/motion.css are VISIBLE BY DEFAULT
 * (`opacity: 1; transform: none`) — motion.css only starts hiding them once
 * `<html class="reveal-ready">` is present, and that class is added ONLY
 * from reveal-dom.ts, ONLY when it's safe to animate. So:
 *
 *   - IntersectionObserver unsupported (old browser, non-browser render,
 *     a test DOM)              -> class never added -> elements stay visible.
 *   - prefers-reduced-motion: reduce                  -> class never added -> visible.
 *   - Anything else                                   -> class added, elements
 *                                                          fade/slide in as they
 *                                                          scroll into view.
 *
 * This is exactly the behavior a marketing/landing page needs: worst case
 * (JS never runs, API missing, motion disabled) is "content is all just
 * there", never a page that renders blank sections forever.
 */

/** Pure gate — no DOM access, fully unit-testable. */
export function shouldArmReveal(opts: {
  hasIntersectionObserver: boolean;
  prefersReducedMotion: boolean;
}): boolean {
  return opts.hasIntersectionObserver && !opts.prefersReducedMotion;
}

export interface RevealHandle {
  /** Disconnects the observer and removes the reveal-ready class. Safe to call multiple times. */
  destroy(): void;
}
