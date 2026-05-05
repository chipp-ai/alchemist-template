/**
 * `defineStore` — the canonical way to declare shared client state in
 * customer apps generated from this template.
 *
 * Why this exists
 *
 *   The alchemist platform's verification pipeline (`/api/dev/app-state`
 *   endpoint + DevPanel UI + agent prompt) needs to introspect every
 *   piece of shared state in the running app — without knowing what
 *   stores any given customer happens to have built.
 *
 *   The way that works is: every shared store registers itself in
 *   ONE place (this module's REGISTRY), so a generic snapshot
 *   function can iterate them and produce structured output that
 *   the agent can read. If individual stores use bare module-level
 *   `$state` that the agent doesn't know about, they're invisible to
 *   the dev panel and the L1 verification layer is incomplete.
 *
 *   This is the load-bearing convention that makes the rest of the
 *   verification stack work. The CLAUDE.md rule names it explicitly:
 *   "ALL shared cross-component state goes through `defineStore`."
 *
 * Usage
 *
 *   ```ts
 *   // stores/auth.svelte.ts
 *   import { defineStore } from "$lib/devpanel/store.svelte";
 *
 *   interface AuthState {
 *     user: User | null;
 *     isLoading: boolean;
 *     error: string | null;
 *   }
 *
 *   const state = defineStore<AuthState>("auth", {
 *     user: null,
 *     isLoading: true,
 *     error: null,
 *   });
 *
 *   export async function login(email: string, otp: string) {
 *     state.isLoading = true;
 *     state.error = null;
 *     try {
 *       const res = await api.post("/auth/verify", { email, otp });
 *       state.user = res.user;
 *     } catch (err) {
 *       state.error = err.message;
 *     } finally {
 *       state.isLoading = false;
 *     }
 *   }
 *
 *   export const authStore = {
 *     get user() { return state.user; },
 *     get isLoading() { return state.isLoading; },
 *     get error() { return state.error; },
 *     get isAuthenticated() { return state.user !== null; },
 *     login,
 *   };
 *   ```
 *
 *   In components, prefer reading via the exported `authStore` (which
 *   provides a stable read-only-ish interface). For one-off reads in
 *   non-component code, you can also import `state` directly from
 *   the store module — both pathways feed the same reactive value.
 *
 * Update conventions (the rule customers must follow)
 *
 *   - Always update via TOP-LEVEL property assignment:
 *       state.user = newUser;          // ✅ DevPanel sees this
 *       state.user = { ...state.user, name: "X" };  // ✅ whole-object update
 *   - Avoid nested mutations:
 *       state.user.name = "X";         // ⚠️ Svelte's deep $state proxy makes
 *                                      // this work for UI reactivity, but
 *                                      // our top-level subscriber Proxy
 *                                      // doesn't see it, so the dev-panel
 *                                      // push fires later via the heartbeat
 *                                      // instead of immediately.
 *   - For arrays/Maps: replace the whole reference (`state.items = [...]`)
 *     rather than mutating in place. Same rationale.
 *
 *   The dev-panel pipeline has a 5s heartbeat that catches anything
 *   missed, so nested mutation is a "delayed visibility" issue, not a
 *   correctness one. But debugging is sharper when state changes
 *   surface within ~50ms.
 *
 * Implementation notes
 *
 *   - Built on Svelte 5 runes (`$state`, `$state.snapshot`). The runes
 *     ARE allowed inside functions in `.svelte.ts` files — each call
 *     to `defineStore` allocates a fresh reactive root.
 *   - The Proxy intercepts top-level writes and notifies subscribers.
 *     Read operations pass through to Svelte's underlying $state proxy
 *     so component reactivity works exactly like bare $state.
 *   - The snapshot uses `$state.snapshot()` which returns a deep,
 *     non-reactive clone. Safe to JSON.stringify.
 */

interface RegistryEntry {
  /** Snapshot the current state as a plain (non-reactive) object. */
  snapshot: () => unknown;
  /**
   * Subscribers to fire on TOP-LEVEL writes. The push pipeline adds
   * one entry that triggers a debounced server push. Components don't
   * subscribe through here — they go through Svelte's $state proxy.
   */
  subscribers: Set<() => void>;
}

const REGISTRY = new Map<string, RegistryEntry>();

/**
 * Define a named reactive store. Returns the state object directly —
 * read and write properties on it like normal. Reads go through Svelte's
 * deep reactive proxy (so components re-render); top-level writes
 * notify the dev-panel subscriber set.
 *
 * @param name Unique identifier shown in the dev panel and `/api/dev/app-state`
 *             output. Convention: snake_case singular noun (`auth`, `chat`,
 *             `cart`, `editor`).
 * @param initial Initial state. Must be a plain object (not a primitive,
 *             array, or class instance — those don't proxy cleanly and
 *             aren't snapshot-friendly).
 */
export function defineStore<T extends object>(
  name: string,
  initial: T,
): T {
  if (REGISTRY.has(name)) {
    // In dev, this almost always means HMR re-imported a store module.
    // Throwing would break HMR; warn and replace instead. The new
    // registration wins so the snapshot function captures the fresh
    // closure, otherwise stale state would surface in the dev panel.
    if (typeof console !== "undefined") {
      console.warn(
        `[defineStore] Store "${name}" was already defined; replacing. ` +
          `If this is a real duplicate (not HMR), rename one of them.`,
      );
    }
  }

  // Reactive state. In Svelte 5, $state inside .svelte.ts files works
  // when called from functions — each invocation creates a fresh
  // reactive root.
  // deno-lint-ignore prefer-const -- $state needs `let` even when never reassigned at this scope
  let state = $state(initial);

  const subscribers = new Set<() => void>();

  REGISTRY.set(name, {
    snapshot: () => $state.snapshot(state),
    subscribers,
  });

  // Wrap in a Proxy so top-level writes notify the subscriber set.
  // Reads pass through unchanged — Svelte's underlying $state proxy
  // handles fine-grained reactivity for component re-renders.
  return new Proxy(state, {
    set(target, key, value, receiver) {
      const ok = Reflect.set(target, key, value, receiver);
      // Notify after the write lands so subscribers see the new value.
      // Wrap in try/catch so a buggy subscriber can't break the write
      // itself.
      for (const fn of subscribers) {
        try {
          fn();
        } catch (err) {
          if (typeof console !== "undefined") {
            console.error(`[defineStore "${name}"] subscriber threw:`, err);
          }
        }
      }
      return ok;
    },
  });
}

/**
 * Snapshot every registered store. Returns a plain object keyed by
 * store name; values are non-reactive deep clones, safe for JSON
 * serialization.
 *
 * Errors during snapshot for any individual store are caught and
 * surfaced as `{ __error: "..." }` in that store's slot, so a
 * misbehaving store can't break the whole snapshot.
 */
export function getStoreSnapshots(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, entry] of REGISTRY) {
    try {
      result[name] = entry.snapshot();
    } catch (err) {
      result[name] = {
        __error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return result;
}

/**
 * List the names of every registered store, in registration order.
 * Used by the DevPanel UI for predictable display ordering.
 */
export function listStoreNames(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * Subscribe to top-level writes across ALL registered stores. The
 * callback fires synchronously after each write. Returns an
 * unsubscribe function.
 *
 * Used by the push pipeline (one global subscriber that debounces
 * a server snapshot push) and by the DevPanel UI (one subscriber
 * that re-renders the panel when state changes).
 *
 * Subscribers added via this function are also attached to stores
 * registered LATER in the session — no need to re-subscribe when
 * a new store comes online.
 */
export function subscribeAll(fn: () => void): () => void {
  // Add to all currently-registered stores.
  for (const entry of REGISTRY.values()) {
    entry.subscribers.add(fn);
  }
  // Track in a meta-set so newly-registered stores can adopt this
  // subscriber too.
  PENDING_SUBSCRIBERS.add(fn);
  return () => {
    PENDING_SUBSCRIBERS.delete(fn);
    for (const entry of REGISTRY.values()) {
      entry.subscribers.delete(fn);
    }
  };
}

/**
 * Subscribers added via `subscribeAll` that should also attach to
 * future store registrations. Wraps `defineStore` to inject these
 * into newly-registered store entries.
 */
const PENDING_SUBSCRIBERS = new Set<() => void>();

// Augment defineStore so future stores pick up subscribers added
// before they were defined. This handles the case where the push
// pipeline runs `subscribeAll` at app start, then a store module
// gets imported lazily later (route-based code splitting).
const ORIGINAL_REGISTER = REGISTRY.set.bind(REGISTRY);
REGISTRY.set = (name: string, entry: RegistryEntry) => {
  for (const fn of PENDING_SUBSCRIBERS) {
    entry.subscribers.add(fn);
  }
  return ORIGINAL_REGISTER(name, entry);
};

/**
 * Test-only: clear the registry between tests. Real customer apps
 * should never call this; it exists so the `__tests__` suite can
 * isolate tests from each other.
 */
export function __resetRegistryForTests(): void {
  REGISTRY.clear();
  PENDING_SUBSCRIBERS.clear();
}
