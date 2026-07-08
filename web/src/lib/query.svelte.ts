/**
 * `createQuery` — stale-while-revalidate server-state fetching for customer
 * apps generated from this template. TanStack-Query semantics, runes-native,
 * zero dependencies.
 *
 * Why this exists
 *
 *   Server data in template apps was fetched imperatively (each store's
 *   `fetchX()` writing into `defineStore` state), which means: no caching
 *   across mounts, no background refresh, every surface hand-rolls its own
 *   polling, and stale data sits on screen until someone remembers to
 *   refetch. The stale-while-revalidate model fixes all four: reads are
 *   served instantly from cache (even stale), a background revalidation
 *   keeps them fresh, window re-focus triggers a refresh, and mutations
 *   invalidate by key so dependent views live-reload "magically".
 *
 * Relationship to `defineStore`
 *
 *   Each query's cache entry IS a `defineStore` named `query:<key>` — so
 *   every query is automatically visible to the DevPanel + the
 *   `/api/dev/app-state` verification snapshot, same as hand-written
 *   stores. The CLAUDE.md rule: client state that MIRRORS SERVER DATA goes
 *   through `createQuery`; client-only state (UI flags, drafts, wizards)
 *   stays on plain `defineStore`.
 *
 * Usage
 *
 *   ```ts
 *   // stores/shipments.svelte.ts
 *   import { createQuery, invalidateQueries } from "$lib/query.svelte";
 *   import { api } from "$lib/api";
 *
 *   const shipmentsQuery = createQuery({
 *     key: "shipments:list",
 *     fetcher: () => api.get<{ shipments: Shipment[] }>("/shipments"),
 *     staleTime: 15_000,        // serve cached for 15s before revalidating
 *     refetchInterval: 60_000,  // background refresh every 60s while in use
 *   });
 *
 *   export const shipmentStore = {
 *     get shipments() { return shipmentsQuery.data?.shipments ?? []; },
 *     get isLoading() { return shipmentsQuery.isLoading; },
 *     get error() { return shipmentsQuery.error; },
 *     async createShipment(input: NewShipment) {
 *       await api.post("/shipments", input);
 *       invalidateQueries("shipments:");   // list live-reloads everywhere
 *     },
 *   };
 *   ```
 *
 *   Per-entity queries use a key factory:
 *
 *   ```ts
 *   const detail = (id: string) =>
 *     createQuery({ key: `shipments:${id}`, fetcher: () => api.get(`/shipments/${id}`) });
 *   ```
 *
 *   `createQuery` is idempotent per key — calling it twice with the same
 *   key returns the SAME handle (the second call's options are ignored),
 *   so key factories are safe to call from components.
 *
 * Semantics
 *
 *   - First `.data` read fires the fetch (`isLoading` true until it lands).
 *   - Later reads within `staleTime` are pure cache hits.
 *   - Reads past `staleTime` return the stale value AND kick a background
 *     revalidation (`isFetching` true, `isLoading` false).
 *   - Window focus / tab re-visibility revalidates every ACTIVE query
 *     (read within the last 5 minutes) whose data is stale.
 *   - `refetchInterval` ticks only while the query is active AND the tab
 *     is visible — background tabs never burn requests.
 *   - `invalidateQueries(prefix)` marks matching keys stale and refetches
 *     the active ones immediately; inactive ones refetch on next read.
 *   - Concurrent revalidations dedupe on the in-flight promise.
 *   - Errors keep the last good data (`.data` stays) and set `.error`;
 *     the next trigger retries.
 */

import { defineStore } from "./devpanel/store.svelte";

interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  /** epoch ms of the last SUCCESSFUL fetch; 0 = never / invalidated. */
  updatedAt: number;
  isFetching: boolean;
}

interface QueryEntry<T> {
  state: QueryState<T>;
  fetcher: () => Promise<T>;
  staleTime: number;
  refetchInterval: number | null;
  refetchOnWindowFocus: boolean;
  /** epoch ms of the last `.data` read — drives the "active" window. */
  lastReadAt: number;
  inFlight: Promise<void> | null;
  intervalTimer: ReturnType<typeof setInterval> | null;
  handle: Query<T>;
}

export interface Query<T> {
  readonly data: T | undefined;
  readonly error: string | null;
  /** True until the FIRST fetch settles (success OR error; no data yet). */
  readonly isLoading: boolean;
  /** True while any (re)fetch is in flight. */
  readonly isFetching: boolean;
  /** Epoch ms of the last successful fetch (0 = never). */
  readonly updatedAt: number;
  /** Force a revalidation now (dedupes with any in-flight one). */
  refetch(): Promise<void>;
}

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// deno-lint-ignore no-explicit-any -- heterogeneous cache; each entry is typed at its createQuery site
const CACHE = new Map<string, QueryEntry<any>>();

function isActive(entry: QueryEntry<unknown>): boolean {
  return Date.now() - entry.lastReadAt < ACTIVE_WINDOW_MS;
}

function isStale(entry: QueryEntry<unknown>): boolean {
  return Date.now() - entry.state.updatedAt >= entry.staleTime;
}

function revalidate<T>(entry: QueryEntry<T>): Promise<void> {
  // Dedupe: one fetch at a time per key; concurrent triggers share it.
  if (entry.inFlight) return entry.inFlight;
  entry.state.isFetching = true;
  entry.inFlight = entry
    .fetcher()
    .then((data) => {
      entry.state.data = data;
      entry.state.error = null;
      entry.state.updatedAt = Date.now();
    })
    .catch((err) => {
      // Keep last good data; surface the error. Next trigger retries.
      entry.state.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      entry.state.isFetching = false;
      entry.inFlight = null;
    });
  return entry.inFlight;
}

/** Revalidate when stale; cheap no-op otherwise. */
function ensureFresh(entry: QueryEntry<unknown>): void {
  if (isStale(entry)) void revalidate(entry);
}

function armInterval(entry: QueryEntry<unknown>): void {
  if (entry.refetchInterval == null || entry.intervalTimer != null) return;
  entry.intervalTimer = setInterval(() => {
    // Only while someone is actually looking: active + visible tab.
    if (!isActive(entry)) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void revalidate(entry);
  }, entry.refetchInterval);
}

export function createQuery<T>(opts: {
  key: string;
  fetcher: () => Promise<T>;
  /** How long a successful result is served without revalidating. Default 30s. */
  staleTime?: number;
  /** Background refresh cadence while the query is in use. Default off. */
  refetchInterval?: number | null;
  /** Revalidate stale data when the window regains focus. Default true. */
  refetchOnWindowFocus?: boolean;
  initialData?: T;
}): Query<T> {
  const existing = CACHE.get(opts.key);
  if (existing) return existing.handle as Query<T>;

  // The cache entry IS a defineStore -> DevPanel/app-state introspection
  // sees every query like any hand-written store.
  const state = defineStore<QueryState<T>>(`query:${opts.key}`, {
    data: opts.initialData,
    error: null,
    updatedAt: opts.initialData !== undefined ? Date.now() : 0,
    isFetching: false,
  });

  const entry: QueryEntry<T> = {
    state,
    fetcher: opts.fetcher,
    staleTime: opts.staleTime ?? 30_000,
    refetchInterval: opts.refetchInterval ?? null,
    refetchOnWindowFocus: opts.refetchOnWindowFocus ?? true,
    lastReadAt: 0,
    inFlight: null,
    intervalTimer: null,
    handle: null as unknown as Query<T>,
  };

  const handle: Query<T> = {
    get data() {
      entry.lastReadAt = Date.now();
      armInterval(entry);
      ensureFresh(entry);
      return state.data;
    },
    get error() {
      return state.error;
    },
    get isLoading() {
      // "Loading" = the first fetch hasn't SETTLED yet. A FAILED first
      // fetch must flip this false (error set, data still undefined) or
      // every `{#if isLoading}` skeleton branch permanently shadows its
      // `{:else if error}` sibling -- pages sit on loading skeletons
      // forever whenever the first fetch 401s/errors (Valor Victoria
      // blank ETA-Feasibility screen, 2026-07-08). A later successful
      // retry clears `error` and sets `data`, so recovery renders
      // normally.
      return state.updatedAt === 0 && state.data === undefined &&
        state.error === null;
    },
    get isFetching() {
      return state.isFetching;
    },
    get updatedAt() {
      return state.updatedAt;
    },
    refetch() {
      return revalidate(entry);
    },
  };
  entry.handle = handle;
  CACHE.set(opts.key, entry);
  return handle;
}

/**
 * Mark every query whose key starts with `prefix` as stale. Active queries
 * (read in the last 5 minutes) refetch immediately — this is the mutation
 * hook that makes dependent views live-reload; inactive ones refetch on
 * their next read.
 */
export function invalidateQueries(prefix: string): void {
  for (const [key, entry] of CACHE) {
    if (!key.startsWith(prefix)) continue;
    entry.state.updatedAt = 0;
    if (isActive(entry)) void revalidate(entry);
  }
}

// ── Window-focus revalidation (one global listener) ────────────────────────
if (typeof window !== "undefined") {
  const onFocus = () => {
    for (const entry of CACHE.values()) {
      if (entry.refetchOnWindowFocus && isActive(entry) && isStale(entry)) {
        void revalidate(entry);
      }
    }
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onFocus();
  });
}
