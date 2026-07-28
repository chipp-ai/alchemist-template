/**
 * createQuery derived-safe read regression tests (2026-07-28 dashboard freeze).
 *
 * `Query.data` is read from `$derived(...)` and template expressions across
 * the app (e.g. Overview.svelte's `{:else if portfolioVerticalsStore.result}`
 * branch). `revalidate()` synchronously writes `state.isFetching = true`, a
 * `$state` mutation -- Svelte 5 throws `state_unsafe_mutation` if that runs
 * during derived/template evaluation, aborting the WHOLE page render. That is
 * exactly what froze every non-admin (customer-role) dashboard on its loading
 * skeleton: for non-admins the `canViewPortfolio`-gated skeleton/error
 * branches don't match, so the template read of `.result` was the query's
 * FIRST fetch trigger and crashed the render.
 *
 * The fix: the `data` getter defers its revalidation kick to a microtask
 * (`queueMicrotask(() => ensureFresh(entry))`) so getter reads stay pure.
 * These shape assertions pin that contract.
 *
 * No DB required -- assertions are over file content (substring), matching
 * the sibling overview-stores-shape.test.ts convention.
 */

import { assert } from "@std/assert";

async function readQuerySrc(): Promise<string> {
  return Deno.readTextFile(
    new URL("../../web/src/lib/query.svelte.ts", import.meta.url),
  );
}

/** Extract the body of the `get data()` accessor from the handle object. */
function extractDataGetter(src: string): string {
  const start = src.indexOf("get data()");
  assert(start !== -1, "query.svelte.ts must define a `get data()` accessor");
  // Bounded scan: the getter ends at the next accessor declaration.
  const end = src.indexOf("get error()", start);
  assert(end !== -1, "expected `get error()` accessor after `get data()`");
  return src.slice(start, end);
}

Deno.test("query.svelte.ts: data getter defers its revalidation kick to a microtask", async () => {
  const body = extractDataGetter(await readQuerySrc());
  assert(
    body.includes("queueMicrotask(() => ensureFresh(entry))"),
    "get data() must kick revalidation via queueMicrotask -- a synchronous " +
      "kick mutates $state (isFetching) inside derived/template evaluation " +
      "and throws state_unsafe_mutation, freezing the page render",
  );
});

Deno.test("query.svelte.ts: data getter never calls ensureFresh/revalidate synchronously", async () => {
  const body = extractDataGetter(await readQuerySrc());
  const lines = body.split("\n").map((l) => l.trim());
  const syncKick = lines.some((l) =>
    (l.startsWith("ensureFresh(") || l.startsWith("void ensureFresh(") ||
      l.startsWith("revalidate(") || l.startsWith("void revalidate(")) &&
    !l.includes("queueMicrotask")
  );
  assert(
    !syncKick,
    "get data() must not call ensureFresh()/revalidate() synchronously -- " +
      "wrap the kick in queueMicrotask so reads from $derived stay pure",
  );
});
