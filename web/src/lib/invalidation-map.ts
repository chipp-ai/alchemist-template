/**
 * Query-invalidation dependency map: ONE place that records which cached
 * views are derived from each server entity.
 *
 * Why this exists
 *
 *   Every store mutation must invalidate the `createQuery` keys whose data
 *   it changed (see `query.svelte.ts`). The same server fact often feeds
 *   several keys (a detail page and a list page, a table and a dashboard
 *   tile). When each mutation hand-picks its prefixes, one of those keys
 *   gets forgotten, and that view stays stale until its `staleTime` lapses
 *   or the user hard-refreshes. That bug class shipped four times in one
 *   week on one customer app. The fix is to name the dependents once, per
 *   entity, and have mutations say WHAT changed rather than WHICH keys to
 *   refresh.
 *
 * How to use
 *
 *   - A mutation calls `invalidateEntity("upload")` (see `invalidation.ts`)
 *     instead of a list of `invalidateQueries(...)`.
 *   - When you add a domain entity (orders, shipments, patients), add it
 *     here with EVERY key prefix that renders it. When a NEW query starts
 *     reading an entity from a new key prefix, add that prefix HERE, not
 *     at the call sites.
 *   - `REQUIRED_PREFIXES_BY_WRITE_PATH` below is enforced by
 *     `src/__tests__/routes/store-mutation-invalidation-lint.test.ts`: a
 *     store function that writes to a matching API path must invalidate
 *     every listed prefix (directly, via `invalidateEntity`, or via a
 *     helper). Add a row as soon as one entity is rendered from two
 *     different key prefixes, so the class of bug cannot come back
 *     silently.
 *
 * This file is pure data with no imports, so the lint test can import it
 * under Deno without pulling in Svelte runes.
 */

export const ENTITY_DEPENDENTS = {
  /** A user-uploaded file (approve, reject, remove, re-upload). */
  upload: ["uploads:"],
  /** A spreadsheet import session (start, mapping, commit). */
  importSession: ["imports:"],
  /** A sellable product or a checkout that changes entitlements. */
  billingProduct: ["billing:"],
} as const satisfies Record<string, readonly string[]>;

export type InvalidationEntity = keyof typeof ENTITY_DEPENDENTS;

/**
 * Cross-view dependencies the lint enforces. `path` is matched against the
 * STATIC prefix of the API path a store mutation writes to (a template
 * literal is cut at its first `${`). `requires` lists the query-key
 * prefixes that write must invalidate, however it gets there.
 *
 * Empty in the template on purpose: the first time a project renders one
 * entity from two key prefixes, add the row here. Example:
 *
 *   {
 *     path: /^\/assignments(\/|$)/,
 *     requires: ENTITY_DEPENDENTS.assignment,
 *     why: "PersonDetail reads assignments from persons:<id>; the project page reads assignments:list",
 *   }
 */
export const REQUIRED_PREFIXES_BY_WRITE_PATH: ReadonlyArray<{
  path?: RegExp;
  method?: "post" | "put" | "patch" | "delete";
  file?: string;
  fn?: string;
  requires: readonly string[];
  why: string;
}> = [
  {
    path: /^\/imports\/sessions\//,
    requires: ENTITY_DEPENDENTS.importSession,
    why: "the sessions list and the session detail both render from imports:* keys",
  },
];

/**
 * Writes that touch NO cached server state, so the lint does not require
 * an invalidation after them. Keep each entry honest: a path belongs here
 * only when no `createQuery` anywhere reads what it changed.
 */
export const NON_CACHED_WRITE_PATHS: ReadonlyArray<{
  path?: RegExp;
  method?: "post" | "put" | "patch" | "delete";
  /** Narrow by store file name + function name when a path prefix is too broad. */
  file?: string;
  fn?: string;
  why: string;
}> = [
  { path: /^\/auth\//, why: "session endpoints; auth state lives in authStore, not in a query" },
  { path: /\/upload-url$/, why: "presign step of a multi-step upload; the step that records the file invalidates" },
  {
    // The path is templated (`/billing/products/${id}/checkout`), so its
    // static prefix cannot be matched; key on the function instead.
    file: "billing.svelte.ts",
    fn: "startCheckout",
    why: "navigates the browser to Stripe; the return page refreshes billing via billingStore.refresh()",
  },
];
