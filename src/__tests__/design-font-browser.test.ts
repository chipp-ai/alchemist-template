/**
 * Design-system C6 — font browser lazy-load.
 *
 * Coverage (source-shape lint, following the culture in devpanel.test.ts /
 * design-kit.test.ts — this repo has no browser test runner for Svelte, so
 * this reads Design.svelte's compiled source for the invariants that matter):
 *
 *   - openBrowser() no longer eagerly calls loadFontSpecimen for every
 *     catalog entry the instant the font browser modal opens (~60-70
 *     requests fired at once, most for fonts the user never scrolls to).
 *   - A lazy-load action (IntersectionObserver-backed) exists and is wired
 *     onto every `.font-option` button via `use:`, so a specimen is only
 *     requested once its button is about to be visible.
 *   - The action disconnects its observer once fired (a family's specimen
 *     link is a load-once singleton; there's nothing to keep watching for).
 *
 * Live behavior (specimens load progressively as the modal scrolls, not
 * all at once) was verified against a running dev server + real browser —
 * see the design-system-rollout-state project memory / commit message.
 */

import { assert, assertStringIncludes } from "@std/assert";

function deno(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });
}

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

deno("Design.svelte: openBrowser() does not eagerly load every font's specimen on modal open", async () => {
  const src = await read("web/src/routes/Design.svelte");
  const fnMatch = src.match(/function openBrowser\([\s\S]*?\n {2}\}/);
  assert(fnMatch, "Design.svelte should define openBrowser()");
  const body = fnMatch![0];
  assert(
    !body.includes("loadFontSpecimen"),
    "openBrowser() should not call loadFontSpecimen directly — that eagerly " +
      "fires a stylesheet request for every catalog entry the instant the " +
      "modal opens. Loading should be deferred to a per-button lazy action.",
  );
});

deno("Design.svelte: a lazy-load action backs the font specimen request", async () => {
  const src = await read("web/src/routes/Design.svelte");
  assertStringIncludes(src, "new IntersectionObserver");
  assertStringIncludes(src, "loadFontSpecimen");

  // The action itself calls loadFontSpecimen only from inside an
  // IntersectionObserver callback, and disconnects once it has fired —
  // it shouldn't keep observing (and re-requesting) after the family's
  // specimen has already been loaded once.
  const actionMatch = src.match(/function lazySpecimen\([\s\S]*?\n {2}\}/);
  assert(actionMatch, "Design.svelte should define a lazySpecimen (or equivalently named) action");
  const body = actionMatch![0];
  assertStringIncludes(body, "isIntersecting");
  assertStringIncludes(body, "loadFontSpecimen");
  assertStringIncludes(body, "observer.disconnect()");
});

deno("Design.svelte: the .font-option button wires the lazy-load action", async () => {
  const src = await read("web/src/routes/Design.svelte");
  const classIdx = src.indexOf('class="font-option"');
  assert(classIdx >= 0, 'Design.svelte should render a <button class="font-option"> element');
  // The button's remaining attributes (style:font-family, data-testid,
  // onclick, use:) close before its first child (<span ...>). A plain
  // `>` search would stop early at the `=>` inside onclick's arrow
  // function, so anchor on the next child element instead.
  const spanIdx = src.indexOf("<span", classIdx);
  assert(spanIdx > classIdx, "expected .font-option button to have <span> children");
  const attrs = src.slice(classIdx, spanIdx);
  assertStringIncludes(
    attrs,
    "use:lazySpecimen",
    ".font-option button should wire use:lazySpecimen so its specimen loads on visibility, not on modal open",
  );
});
