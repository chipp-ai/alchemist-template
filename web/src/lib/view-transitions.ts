/**
 * View Transitions API gate — PURE logic only, same pure-gate /
 * thin-DOM-wrapper split as reveal.ts / theme.ts. The DOM-touching wrapper
 * (`runWithViewTransition` / `navigateWithTransition`) lives in the
 * sibling `view-transitions-dom.ts`, which is never imported by a
 * `deno test` entry point — keeping `document` / `matchMedia` out of this
 * file's module graph is what makes `deno test src/__tests__/` (run
 * WITHOUT `--no-check` in CI) succeed under this repo's `deno.window`-only
 * `lib` compiler option (no `dom`).
 *
 * `document.startViewTransition` is unsupported in a large chunk of
 * browsers (Firefox, Safari < 18) and must never be used when the user
 * has asked for reduced motion. See web/src/motion.css for the
 * `::view-transition-*` pseudo-element rules (also reduced-motion-gated
 * independently, belt and suspenders).
 */

/** Pure gate — no DOM access, fully unit-testable. */
export function shouldUseViewTransition(opts: {
  supportsViewTransitions: boolean;
  prefersReducedMotion: boolean;
}): boolean {
  return opts.supportsViewTransitions && !opts.prefersReducedMotion;
}
