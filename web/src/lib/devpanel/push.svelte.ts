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
 *     top-level subscriber. The docs/conventions/frontend.md rule asks customers to do
 *     whole-object updates instead, but agents don't always follow
 *     it perfectly.
 *   - 5s heartbeat is the safety net: any change is visible to the
 *     dev panel within 5s even when the rule is broken.
 *   - Cost: one fetch per 5s during dev = trivial.
 *
 * Dead server (a paused Builder sandbox): the push goes through a circuit
 * breaker (lib/circuit-breaker.ts). After 3 failed pushes in a row it backs
 * off (5s, 10s, 20s ... 5 min); after 10 it stops until the page is visible
 * again or the hash changes. A paused preview once sent ~2,769 404s an hour.
 */

import { subscribeAll } from "./store.svelte";
import { collectClientSnapshot, formatSnapshotAsMarkdown } from "./snapshot";
import { createCircuitBreaker, wakeOnPageReturn } from "../circuit-breaker.ts";

const DEBOUNCE_MS = 1000;
/** Also skipped by the breadcrumb fetch hook, so a failing push never queues a breadcrumb flush. */
export const DEV_APP_STATE_PATH = "/api/dev/app-state";
const HEARTBEAT_MS = 5000;

let debounceTimer: number | null = null;
let heartbeatInterval: number | null = null;
let unsubscribeFromStores: (() => void) | null = null;
let stopWakeListeners: (() => void) | null = null;

/** Push breaker. Exported for the dev panel and tests. */
export const pushBreaker = createCircuitBreaker();

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
  if (!pushBreaker.tryAttempt()) return;

  try {
    const snapshot = collectClientSnapshot();
    const markdown = formatSnapshotAsMarkdown(snapshot);

    // Earlier versions did a shallow-signature dedup (route + storeOrder +
    // viewport) to skip "no-change" pushes. That excluded actual store
    // CONTENTS, so when an auth field flipped or a cart item was added the
    // signature stayed identical and the push silently dropped — which is
    // the load-bearing change to surface, not the one to skip. The 1s
    // debounce + 5s heartbeat already cap wasted bandwidth; computing a
    // content-aware hash on every snapshot would re-stringify the entire
    // store graph just to compare strings. Drop the dedup, always send.
    const res = await fetch(DEV_APP_STATE_PATH, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, markdown }),
    });
    pushBreaker.recordResponse(res.status);
  } catch {
    // Dev tooling: no console noise. A network error counts against the
    // breaker, so a dead server is not polled forever.
    pushBreaker.recordFailure();
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
  stopWakeListeners = wakeOnPageReturn(pushBreaker);

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
  if (stopWakeListeners !== null) {
    stopWakeListeners();
    stopWakeListeners = null;
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("hashchange", schedulePush);
    window.removeEventListener("resize", schedulePush);
  }
}
