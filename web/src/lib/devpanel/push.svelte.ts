/**
 * Debounced push pipeline for the dev panel.
 *
 * Subscribes to every registered store via `subscribeAll`. When ANY
 * top-level write happens, schedules a debounced (1s) POST to
 * `/api/dev/app-state` with the current snapshot. Also pushes on:
 *
 *   - hashchange (route navigation)
 *   - resize (viewport changes)
 *   - 5s heartbeat (catches nested mutations the proxy doesn't see)
 *
 * No-op in production. The dev API endpoint is gated server-side
 * (`NODE_ENV !== "production"`), so even if this somehow ran in prod
 * it would 404. Adding the client-side gate is defense-in-depth: it
 * means production bundles don't bother to compile this code path
 * (Vite tree-shakes the body when `import.meta.env.PROD` is true).
 *
 * Heartbeat rationale (the 5s number)
 *
 *   - Top-level proxy writes are caught immediately and debounce 1s.
 *   - Nested mutations like `state.user.name = "X"` go through Svelte's
 *     deep $state proxy for component reactivity but DON'T trip our
 *     top-level subscriber. The CLAUDE.md rule asks customers to do
 *     whole-object updates instead, but agents don't always follow
 *     it perfectly.
 *   - 5s heartbeat is the safety net: any change is visible to the
 *     dev panel within 5s even when the rule is broken.
 *   - Cost: one fetch per 5s during dev = trivial.
 */

import { subscribeAll } from "./store.svelte";
import { collectClientSnapshot, formatSnapshotAsMarkdown } from "./snapshot";

const DEBOUNCE_MS = 1000;
const HEARTBEAT_MS = 5000;

let debounceTimer: number | null = null;
let heartbeatInterval: number | null = null;
let unsubscribeFromStores: (() => void) | null = null;
let lastPushedHash: string | null = null;

/**
 * Schedule a push, debounced so a burst of store writes coalesces
 * into one HTTP call. Call repeatedly; only the trailing edge fires.
 */
export function schedulePush(): void {
  if (import.meta.env.PROD) return;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    pushNow();
  }, DEBOUNCE_MS);
}

/**
 * Push immediately (skipping debounce). Used by the heartbeat and
 * by the initial mount.
 */
export async function pushNow(): Promise<void> {
  if (import.meta.env.PROD) return;
  if (typeof fetch === "undefined") return;

  try {
    const snapshot = collectClientSnapshot();
    // Skip if nothing has changed AND we've pushed recently. Cheap
    // shallow signature: timestamp + first store name + viewport.
    // Skipping reduces noise in the local dev log.
    const sig = JSON.stringify({
      route: snapshot.route.path,
      stores: snapshot.storeOrder,
      viewport: snapshot.viewport,
    });
    if (sig === lastPushedHash) return;
    lastPushedHash = sig;

    const markdown = formatSnapshotAsMarkdown(snapshot);

    await fetch("/api/dev/app-state", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, markdown }),
    });
  } catch {
    // Silently swallow — this is dev tooling. The endpoint 404s in
    // prod (defense-in-depth on top of the import.meta.env.PROD
    // early-return), and a network blip on a single push is recoverable
    // by the next heartbeat or store change.
  }
}

/**
 * Wire up the push pipeline: subscribe to stores, install listeners,
 * start the heartbeat, fire the initial push. Idempotent — calling
 * twice is a no-op the second time.
 *
 * Call once from `main.ts` after stores are imported (so any
 * registration-time side effects have already happened).
 */
export function startDevPanelPush(): void {
  if (import.meta.env.PROD) return;
  if (typeof window === "undefined") return;
  if (unsubscribeFromStores !== null) return; // already started

  unsubscribeFromStores = subscribeAll(schedulePush);

  window.addEventListener("hashchange", schedulePush);
  window.addEventListener("resize", schedulePush);

  heartbeatInterval = window.setInterval(pushNow, HEARTBEAT_MS);

  // Initial push so the agent can call /api/dev/app-state right
  // after the dev server is up — without waiting for the first
  // store change or the first heartbeat.
  setTimeout(pushNow, 100);
}

/**
 * Tear down the push pipeline. Mostly for tests; production apps
 * never need this.
 */
export function stopDevPanelPush(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (unsubscribeFromStores !== null) {
    unsubscribeFromStores();
    unsubscribeFromStores = null;
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("hashchange", schedulePush);
    window.removeEventListener("resize", schedulePush);
  }
  lastPushedHash = null;
}
