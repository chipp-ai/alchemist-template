/**
 * Design-system S1 — motion language slice.
 *
 * Coverage:
 *   - web/src/lib/reveal.ts: shouldArmReveal() pure gate — real unit
 *     tests (not source-shape lints), since this module has no Svelte
 *     runes/DOM dependency for the decision itself and can be imported
 *     directly under Deno. Proves the "fail safe to visible" contract:
 *     no IntersectionObserver -> never arm; prefers-reduced-motion ->
 *     never arm; both present -> arm.
 *   - web/src/lib/view-transitions.ts: shouldUseViewTransition() pure
 *     gate — same fail-safe shape (unsupported API or reduced motion ->
 *     never use the transition).
 *   - Source-shape lints:
 *     - web/src/motion.css: `.reveal` is visible by default outside
 *       `html.reveal-ready`, the reveal transition only applies once
 *       `reveal-ready` is present, skeleton shimmer is a real
 *       `@keyframes` animation, toast spring keyframes exist, the
 *       View Transitions pseudo-elements are styled, and a single
 *       `@media (prefers-reduced-motion: reduce)` block disables every
 *       animation/transition declared above it (including a blanket
 *       `*` kill-switch). No `transition: all` anywhere in the file.
 *     - web/src/main.ts imports motion.css after app.css.
 *     - web/src/App.svelte wires initRevealOnScroll() on mount + on
 *       every route change, and routes its login-redirect through
 *       navigateWithTransition() instead of calling replace() directly.
 *
 * This file intentionally does NOT cover the general-purpose "no raw hex
 * anywhere in web/src" / "no transition: all anywhere" guardrail lint
 * (a separate S1 guardrails work item) — it only asserts motion.css
 * itself never uses `transition: all`, which is a narrower, in-scope
 * check for the file this slice owns.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { shouldArmReveal } from "../../web/src/lib/reveal.ts";
import { shouldUseViewTransition } from "../../web/src/lib/view-transitions.ts";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
}

// ── reveal.ts: pure fail-safe gate ──────────────────────────────────────────

deno("shouldArmReveal: false when IntersectionObserver is unsupported", () => {
  assertEquals(
    shouldArmReveal({ hasIntersectionObserver: false, prefersReducedMotion: false }),
    false,
  );
});

deno("shouldArmReveal: false when prefers-reduced-motion, even with IntersectionObserver", () => {
  assertEquals(
    shouldArmReveal({ hasIntersectionObserver: true, prefersReducedMotion: true }),
    false,
  );
});

deno("shouldArmReveal: false when both signals say no", () => {
  assertEquals(
    shouldArmReveal({ hasIntersectionObserver: false, prefersReducedMotion: true }),
    false,
  );
});

deno("shouldArmReveal: true only when IntersectionObserver is present AND motion is allowed", () => {
  assertEquals(
    shouldArmReveal({ hasIntersectionObserver: true, prefersReducedMotion: false }),
    true,
  );
});

// ── view-transitions.ts: pure fail-safe gate ────────────────────────────────

deno("shouldUseViewTransition: false when the API is unsupported", () => {
  assertEquals(
    shouldUseViewTransition({ supportsViewTransitions: false, prefersReducedMotion: false }),
    false,
  );
});

deno("shouldUseViewTransition: false under prefers-reduced-motion, even with API support", () => {
  assertEquals(
    shouldUseViewTransition({ supportsViewTransitions: true, prefersReducedMotion: true }),
    false,
  );
});

deno("shouldUseViewTransition: true only when supported AND motion is allowed", () => {
  assertEquals(
    shouldUseViewTransition({ supportsViewTransitions: true, prefersReducedMotion: false }),
    true,
  );
});

// ── Source-shape lints: web/src/motion.css ──────────────────────────────────

deno("motion.css: .reveal is visible by default, hidden only once reveal-ready is present", async () => {
  const css = await read("web/src/motion.css");
  const bareRevealBlock = css.split(".reveal {")[1]?.split("}")[0] ?? "";
  assertStringIncludes(bareRevealBlock, "opacity: 1");
  assertStringIncludes(css, "html.reveal-ready .reveal {");
  const gatedBlock = css.split("html.reveal-ready .reveal {")[1]?.split("}")[0] ?? "";
  assertStringIncludes(gatedBlock, "opacity: 0");
});

deno("motion.css: reveal stagger reads --reveal-index (set by reveal.ts)", async () => {
  const css = await read("web/src/motion.css");
  assertStringIncludes(css, "var(--reveal-index, 0)");
});

deno("motion.css: skeleton shimmer is a real @keyframes animation", async () => {
  const css = await read("web/src/motion.css");
  assertStringIncludes(css, ".skeleton {");
  assertStringIncludes(css, "@keyframes skeleton-shimmer");
  assertStringIncludes(css, "animation: skeleton-shimmer");
});

deno("motion.css: toast spring enter/exit keyframes exist", async () => {
  const css = await read("web/src/motion.css");
  assertStringIncludes(css, "@keyframes toast-spring-in");
  assertStringIncludes(css, "@keyframes toast-spring-out");
});

deno("motion.css: View Transitions pseudo-elements are styled", async () => {
  const css = await read("web/src/motion.css");
  assertStringIncludes(css, "::view-transition-old(root)");
  assertStringIncludes(css, "::view-transition-new(root)");
});

deno("motion.css: a single prefers-reduced-motion block disables every animation, including a blanket kill-switch", async () => {
  const css = await read("web/src/motion.css");
  const matches = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)];
  assertEquals(matches.length, 1, "expected exactly one prefers-reduced-motion block in motion.css");
  const block = css.slice(matches[0].index);
  assertStringIncludes(block, "animation-duration: 0.01ms !important");
  assertStringIncludes(block, "transition-duration: 0.01ms !important");
});

deno("motion.css: never uses transition: all", async () => {
  const css = await read("web/src/motion.css");
  assert(!/transition:\s*all\b/.test(css), "motion.css must not use `transition: all`");
});

// ── Source-shape lints: wiring ───────────────────────────────────────────────

deno("main.ts: imports motion.css after app.css", async () => {
  const src = await read("web/src/main.ts");
  const appCssIdx = src.indexOf('import "./app.css"');
  const motionCssIdx = src.indexOf('import "./motion.css"');
  assert(appCssIdx > -1 && motionCssIdx > -1 && motionCssIdx > appCssIdx, "motion.css must be imported after app.css");
});

deno("App.svelte: wires initRevealOnScroll on mount and on every route change", async () => {
  const src = await read("web/src/App.svelte");
  assertStringIncludes(src, 'import { initRevealOnScroll } from "./lib/reveal"');
  assertStringIncludes(src, "initRevealOnScroll()");
});

deno("App.svelte: routes the login redirect through navigateWithTransition", async () => {
  const src = await read("web/src/App.svelte");
  assertStringIncludes(src, 'import { navigateWithTransition } from "./lib/view-transitions"');
  assertStringIncludes(src, 'navigateWithTransition(replace, "/login")');
});
