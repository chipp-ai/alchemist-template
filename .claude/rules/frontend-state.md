---
name: frontend-state
description: Frontend data loading and tenant context — pages fetch in onMount and rely on the Router key in App.svelte to remount on a tenant switch or a path change; runContextSwitch() clears stores and the query cache; never key a refetch on an org id. Load when touching routes, stores, the query layer, App.svelte, or when adding any organization / workspace / account switcher.
paths:
  - "web/src/App.svelte"
  - "web/src/routes/**"
  - "web/src/stores/**"
  - "web/src/lib/query.svelte.ts"
  - "web/src/lib/context-switch.svelte.ts"
---

# Frontend state: tenant context and page lifetime

The decision rule lives in `CLAUDE.md` -> "Tenant and route context: the
Router key, not per-page watches". This spoke carries the mechanics.

## The contract

1. **Pages fetch in `onMount`** (never `$effect`, see the hub) and do NOT
   watch tenant ids. A page is allowed to assume it was mounted for
   exactly one tenant and one path.
2. **`web/src/App.svelte` keys every `<Router>`** on
   `` `${contextSwitch.epoch}:${$location}` ``. A tenant switch or a path
   change destroys and remounts the routed page, so its `onMount` loaders
   run again. Both `<Router>` mounts stay inside that key; a lint test
   (`src/__tests__/routes/context-switch-remount-lint.test.ts`) fails
   the build if one moves out.
3. **`runContextSwitch()`** (`web/src/lib/context-switch.svelte.ts`) runs
   every registered store reset, calls `resetQueries()` to drop the whole
   `createQuery` cache, then bumps `contextSwitch.epoch`. The bump is last
   so the remount never reads stale data.
4. **Who calls it:** `authStore.logout()` (already wired), and ANY switcher
   you add later (organization, workspace, account, environment). Call it
   AFTER the server has acknowledged the switch (after the `POST .../switch`
   resolves), never before: the remounted page's first requests must hit a
   session the server already moved.
5. **Tenant-scoped `defineStore` state registers a reset** once at module
   load: `registerContextReset(() => { state.items = []; ... })`. Queries
   need nothing; `resetQueries()` covers every `createQuery`. Session-level
   stores (`auth`, `toast`, `sessionTimeout`) do NOT register.
6. **A signed-out session never mounts a protected page.** `App.svelte`
   renders nothing (not the `<Router>`) when the user is unauthenticated on
   a non-public, non-portal path, while the redirect effect moves to
   `/login`. Without that branch a logout from `/settings` remounted the
   page for one frame and its `onMount` loaders fired three 401s against
   the dead session. Keep the branch when you touch the shell.

## Adding a switcher (the checklist)

```ts
// stores/organization.svelte.ts
async function switchOrg(orgId: string): Promise<void> {
  await api.post(`/org/${orgId}/switch`);   // server moves the session first
  runContextSwitch();                        // then clear + remount
}
```

- The server endpoint re-issues the session (cookie / JWT) for the new
  tenant before it responds, so the remounted page's first request already
  carries the new context.
- Do not navigate as a substitute for `runContextSwitch()`: navigating to
  the same path does not remount, and navigating elsewhere loses the page.
- Do not add `$effect(() => { if (orgStore.currentOrg?.id) load(); })` to a
  page. A same-org re-select or a switch between two workspaces of one org
  never moves that id, so the watch does nothing, and the epoch already
  covers every shape of switch.

## Query keys stay tenant-free

`createQuery` keys are `<domain>:<qualifier>` (`shipments:list`), with no
org id in them. That is correct BECAUSE `resetQueries()` empties the cache
on every switch. If you ever add a tenant id to a key, you also have to
evict by tenant on switch; do not go there.

## Param-driven detail pages

`/things/:id` -> `/things/:other` is the same bug in miniature: the
component would stay mounted with A's data. The `$location` half of the
Router key remounts it. A detail page therefore reads `params.id` once, in
`onMount`, and never needs a param watch.
