/**
 * One-call entrypoint for the dev panel. Wires up:
 *   - global error listeners (errors.ts)
 *   - debounced store-change push pipeline (push.svelte.ts)
 *
 * Call exactly once from `main.ts` AFTER all store modules have
 * been imported (so their `defineStore` calls have registered).
 *
 * No-op in production via early returns inside the wired modules.
 */

import { installClientErrorListeners } from "./errors";
import { startDevPanelPush } from "./push.svelte";

let initialized = false;

/**
 * Idempotent. Calling twice is a no-op the second time.
 */
export function initDevPanel(): void {
  if (initialized) return;
  initialized = true;

  installClientErrorListeners();
  startDevPanelPush();
}
