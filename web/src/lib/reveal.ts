/**
 * Staggered reveal-on-scroll — pure gating logic + DOM wiring, split the
 * same way as color-math.ts / theme.ts: the DECISION of whether to arm the
 * effect at all is a pure function (unit-tested directly under Deno,
 * no DOM required), and the IntersectionObserver plumbing that actually
 * touches the page is a thin, untested-by-design wrapper around it (the
 * same split this repo's existing design-system slices use for anything
 * that needs a browser to run for real).
 *
 * Fail-safe contract (docs/design-system-program.md's S1 motion section):
 * elements marked `.reveal` in web/src/motion.css are VISIBLE BY DEFAULT
 * (`opacity: 1; transform: none`) — motion.css only starts hiding them once
 * `<html class="reveal-ready">` is present, and that class is added ONLY
 * from here, ONLY when it's safe to animate. So:
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

const NOOP_HANDLE: RevealHandle = { destroy() {} };

/**
 * Wire up reveal-on-scroll for every `.reveal` element under `root`
 * (defaults to the whole document). Call once per view/mount — safe to
 * call again after new `.reveal` nodes are added to the DOM (e.g. a
 * route change); each call only observes elements not already observed
 * via `data-reveal-observed`.
 */
export function initRevealOnScroll(root: ParentNode = document): RevealHandle {
  const hasIntersectionObserver = typeof IntersectionObserver !== "undefined";
  const prefersReducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!shouldArmReveal({ hasIntersectionObserver, prefersReducedMotion })) {
    return NOOP_HANDLE;
  }

  document.documentElement.classList.add("reveal-ready");

  const elements = Array.from(root.querySelectorAll<HTMLElement>(".reveal:not([data-reveal-observed])"));
  if (elements.length === 0) {
    return NOOP_HANDLE;
  }

  elements.forEach((el, i) => {
    el.dataset.revealObserved = "true";
    if (!el.style.getPropertyValue("--reveal-index")) {
      // Stagger buckets of 6 so long lists don't produce a multi-second
      // cascade — the 7th item reveals alongside the 1st, etc.
      el.style.setProperty("--reveal-index", String(i % 6));
    }
  });

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: "0px 0px -10% 0px" },
  );

  elements.forEach((el) => observer.observe(el));

  return {
    destroy() {
      observer.disconnect();
    },
  };
}
