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

  let bucket = 0;

  // Find every not-yet-armed `.reveal`, mark + observe it, and — only when
  // there is actually something to observe — flip the global `reveal-ready`
  // class that motion.css keys the hidden→revealed transition off.
  //
  // Adding `reveal-ready` ONLY inside a pass that found elements (rather than
  // unconditionally, as an earlier version did) is what keeps the fail-safe
  // contract honest: a `.reveal` that JS never reaches is never hidden by the
  // global flag, so it stays visible. The previous version added the class
  // up-front and then returned early when it found 0 elements — leaving the
  // class on `<html>` with the real route content still un-mounted, so the
  // login/dashboard cards that mounted a beat later were globally hidden yet
  // never observed → stuck at opacity 0 forever.
  function scan(): void {
    const elements = Array.from(
      root.querySelectorAll<HTMLElement>(".reveal:not([data-reveal-observed])"),
    );
    if (elements.length === 0) return;

    document.documentElement.classList.add("reveal-ready");

    for (const el of elements) {
      el.dataset.revealObserved = "true";
      if (!el.style.getPropertyValue("--reveal-index")) {
        // Stagger buckets of 6 so long lists don't produce a multi-second
        // cascade — the 7th item reveals alongside the 1st, etc.
        el.style.setProperty("--reveal-index", String(bucket % 6));
        bucket++;
      }
      observer.observe(el);
    }
  }

  // Scan synchronously for whatever is already in the DOM, then again on the
  // next frame. The deferred pass is load-bearing: App.svelte arms reveal from
  // a route-level `$effect`, which Svelte fires BEFORE the freshly-routed
  // component's DOM is committed — without the rAF re-scan a just-navigated
  // `.reveal` element is missed and (once any pass has set `reveal-ready`)
  // stays hidden. Both passes are idempotent via `data-reveal-observed`.
  scan();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(scan);
  }

  return {
    destroy() {
      observer.disconnect();
    },
  };
}
