/**
 * Context switch: the one signal that says "the tenant this UI is showing
 * just changed" (a different organization, workspace, account, or user).
 *
 * The bug class this exists for
 *
 *   Pages fetch their data once in `onMount` (see CLAUDE.md, "$effect on
 *   mount is a trap"). A global switcher (org, workspace, account) or a
 *   logout-then-login does NOT navigate, so the routed page stays mounted
 *   and keeps showing the PREVIOUS tenant's data. Chipp hit this on its
 *   billing page (2026-09-24): switching organizations left the old org's
 *   credit balance on screen.
 *
 * The guard, in three parts
 *
 *   1. `App.svelte` keys every `<Router>` on `contextSwitch.epoch` (and on
 *      `$location`), so a switch destroys and remounts the routed page and
 *      its `onMount` loaders run again for the new tenant. No page needs
 *      its own watch, and no future page can forget one.
 *   2. `runContextSwitch()` clears every `createQuery` cache entry and every
 *      store that registered a reset, so a remounted page can never read the
 *      previous tenant's data out of a module-level cache.
 *   3. Whoever switches tenant calls `runContextSwitch()` AFTER the server
 *      has acknowledged the switch (after the POST resolves), never before:
 *      the remounted page's first requests must hit a session the server
 *      already moved, or they race the switch and load the old tenant.
 *
 * Do NOT key a refetch on an org / workspace id (`$effect(() => { if
 * (orgStore.currentOrg?.id) load() })`): a same-org re-select or a switch
 * between two workspaces of one org never moves the org id, so such a
 * watch silently does nothing. The epoch moves on every switch by
 * construction.
 *
 * Usage
 *
 *   ```ts
 *   // A tenant-scoped store registers its reset once, at module load.
 *   registerContextReset(() => { state.items = []; state.error = null; });
 *
 *   // The switcher (or logout) fires the switch after the server confirms.
 *   await api.post(`/org/${orgId}/switch`);
 *   runContextSwitch();
 *   ```
 *
 * Runes-native (`$state`) so `contextSwitch.epoch` is reactive in
 * components; `.svelte.ts` is required for that.
 */

import { resetQueries } from "./query.svelte";

type ResetFn = () => void;

const resets: ResetFn[] = [];

let epoch = $state(0);

export const contextSwitch = {
  /** Number of context switches since page load. Reactive. */
  get epoch(): number {
    return epoch;
  },
};

/**
 * Register a reset that runs on every context switch (tenant switch or
 * logout). Call once at module load from a store whose state mirrors
 * tenant-scoped data and is NOT a `createQuery` (queries reset themselves).
 */
export function registerContextReset(fn: ResetFn): void {
  resets.push(fn);
}

/**
 * Run every registered reset, clear the query cache, then bump the epoch.
 * The bump comes LAST so the remount it triggers never observes a store or
 * cache entry that still holds the previous tenant's data.
 */
export function runContextSwitch(): void {
  for (const fn of resets) {
    try {
      fn();
    } catch (err) {
      if (typeof console !== "undefined") {
        console.error("[contextSwitch] reset threw:", err);
      }
    }
  }
  resetQueries();
  epoch += 1;
}
