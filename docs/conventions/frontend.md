# Frontend conventions

## Frontend Conventions

### App pages go in `web/src/recipe-routes.ts`; public pages too

`web/src/routes.ts` and `Sidebar.svelte` are base-owned. Add a page to
`recipeRoutes` and its link to `recipeNavItems`. To make a page public (a
signed-out visitor sees it instead of the login form), list its route key
in `recipePublicRoutes` (`"/"`, `"/pricing"`, `"/share/:id"`, `"/docs/*"`).
Never edit `PUBLIC_LITERAL_ROUTES`, `PUBLIC_PREFIX_ROUTES` or
`isPublicRoute` in `routes.ts`: `src/__tests__/recipe-public-routes.test.ts`
fails when the base sets change. Public is a UI rule only; every API call
behind the page still checks access on the server. Full guide:
`docs/agent-guidance/dashboard-shell.md`.

### Design system — tokens, motion, dark mode, component kit: read `web/DESIGN.md`

The full design-system contract — token usage rules (no raw hex in
components, colors/spacing/radius/elevation ALWAYS via `var(--...)`),
typography (`--font-heading`/`--font-sans`/`--font-mono` only, never a
literal family name), motion conventions (`prefers-reduced-motion`,
visible-by-default reveal-on-scroll), dark mode as a user-toggled theme, and
how to add a new component at the bar — lives in **`web/DESIGN.md`**. Read it
before styling anything customer-facing. It is enforced by
`src/__tests__/design-guardrails.test.ts` (no raw hex outside the token
files, no `transition: all`, font-family only via tokens) — a violation
fails `deno task test`.

### Mobile and touch: every page works on a phone first

Read "Mobile and touch" in `web/DESIGN.md` before writing a page. In short:
`:hover` only inside `@media (hover: hover) and (pointer: fine)`, with an
`:active` twin for every tappable element; `.icon-btn` on icon-only
buttons (44px tap area); fields at 16px or more on touch screens, and the
right `inputmode` / `type` / `autocomplete` on each field; `100dvh` (or
`100svh` for a hero), never `vh`; `env(safe-area-inset-*)` on fixed and
sticky bars; never `maximum-scale` or `user-scalable=no`. Check new pages
at 320, 375 and 390px for sideways scroll.
`src/__tests__/mobile-guardrails.test.ts` fails the build on the mechanical
rules.

### Hover/interactive transitions animate ONLY compositor properties (transform, opacity)

`box-shadow`, `background`/`background-color`, and `border-color` must NEVER appear in a `transition:` list on cards, list rows, table rows, or any element repeated in a scrollable list. Scrolling sweeps rows under a stationary cursor, and every hover enter/leave that INTERPOLATES a blurred shadow or a background fill repaints that element's area on every frame of the transition — with dozens of rows on screen this is visible scroll jank even though the main thread is completely idle (root-caused on a generated project's dashboards, 2026-07-28: zero long tasks while scrolling; the cost was pure paint). The fix is free visually: keep the `:hover` rules exactly as they are (the shadow/background/border SWAP still happens — instantly, one repaint per flip) and keep `transform`/`opacity` in the transition so the lift or fade the eye tracks still animates.

**Rule:** `transition:` lists on interactive elements contain ONLY `transform` and/or `opacity` (plus `color` on tiny inline controls where the painted area is a few pixels). Hover elevation = static base `box-shadow` + instant swap, or an `opacity`-faded pre-rendered shadow on a pseudo-element (only on elements without `overflow: hidden`, which clips outer shadows). Tiny one-off controls (a single chip, a tab, a segmented button) are tolerated with paint transitions — never rows or cards.

Two related paint rules: (1) never put `background-attachment: fixed` on a scrolling document — a viewport-fixed background repaints in full on every scrolled frame (acceptable only when an inner container scrolls and the document itself never moves); (2) infinite CSS animations (shimmer, pulse) may only exist on elements that unmount when idle (skeletons) — never on permanently-mounted chrome.

### Svelte 5 — runes only, NOT Svelte 4

`web/package.json` pins `"svelte": "^5.0.0"`, which compiles in runes mode and **rejects Svelte 4 syntax outright**. Most LLM training data is Svelte 4 — consciously override your defaults when writing or editing `*.svelte` files.

| Concept | Svelte 5 (use this) | Svelte 4 (do NOT use) |
|---|---|---|
| Props | `let { foo, bar }: { foo: string; bar?: number } = $props();` | `export let foo: string;` |
| Local state | `let count = $state(0);` | `let count = 0;` (becomes non-reactive in runes mode) |
| Derived | `let doubled = $derived(count * 2);` | `$: doubled = count * 2;` |
| Side effect | `$effect(() => { console.log(count); });` | `$: console.log(count);` |
| Children/slots | `{@render children()}` with `let { children } = $props();` | `<slot />` |

Unchanged from v4: `bind:value` two-way binding, `$store` access for stores.

**Build gate before push.** Any change touching `web/src/**/*.svelte` MUST be followed by:

```bash
cd web && npm install --silent && npm run build
```

The build MUST succeed and produce `web/dist/index.html`. The runtime Dockerfile's `web-builder` stage runs the same command — failures here mean the deploy will fail AFTER the push lands. If the build errors with `Cannot use 'export let' in runes mode` or similar, fix the syntax — **do NOT downgrade Svelte to v4 in `package.json`**, that breaks the platform contract.

### `$effect` on mount is a trap — use `onMount` for one-shot side effects

If a side effect should run **once when the component mounts**, use
`onMount` from `svelte`, NOT `$effect`. The bug this avoids:

```svelte
<script>
  // ❌ BAD — runaway loop
  $effect(() => {
    authStore.checkAuth();   // synchronously writes state.isLoading = true
  });
</script>
```

Why this loops: Svelte 5's `$effect` tracks reactive reads for re-run.
When `checkAuth()` synchronously writes `state.isLoading = true`, Svelte
internally reads the previous value to decide whether to invalidate
dependents — and that internal read gets attributed to the currently-
running `$effect` as a tracked dep. When the `finally` block flips
`state.isLoading = false`, the effect re-runs, calls `checkAuth` again,
which writes `isLoading = true`, which re-invalidates the effect…
**unbounded `/auth/me` loop.** (Reproduced live: 24K requests in 13min
before the fix.)

```svelte
<script>
  import { onMount } from "svelte";

  // ✅ GOOD — fires exactly once after mount, no reactive tracking
  onMount(() => {
    authStore.checkAuth();
  });
</script>
```

**Rule:** if your `$effect` body would read no reactive value (it just
calls a fetcher / store action / API method as a one-shot), it's the
wrong tool. Reach for `onMount`. Reserve `$effect` for code that
*intentionally* re-runs when reactive state changes (e.g.
`$effect(() => { if (authStore.isLoading) return; redirectIfNeeded(); })`
in App.svelte, where reading `isLoading` is the whole point).

The same trap applies to async work that resolves later (e.g.
`api.get(...).then(data => state.foo = data)` inside an effect): the
later `.then()` write fires after the tracking phase and *can* be safe,
but if the synchronous portion of the effect writes ANY reactive value,
the loop is back. Default to `onMount` for fetchers; reach for `$effect`
only when the reactivity is intentional.

### Tenant and route context: the Router key, not per-page watches

`onMount` runs once per mount, so a page that fetched for organization A
keeps showing A after the user switches to organization B unless something
remounts it. Chipp shipped exactly that bug on its billing page. This
template closes the class in one place, and every page relies on it:

- **`web/src/App.svelte` keys every `<Router>`** on
  `` `${contextSwitch.epoch}:${$location}` ``. A tenant switch bumps the
  epoch; a path change moves `$location`; either one destroys and remounts
  the routed page, so its `onMount` loaders run again for the new context.
  Never move a `<Router>` outside that key (a lint test fails the build).
- **`runContextSwitch()`** (`web/src/lib/context-switch.svelte.ts`) is the
  switch signal: it runs every registered store reset, drops the whole
  `createQuery` cache via `resetQueries()`, then bumps the epoch. `logout()`
  already calls it. **Any switcher you add (organization, workspace,
  account) MUST call it after the server acknowledged the switch**, never
  before, and must not rely on navigation instead.
- **A store whose state mirrors tenant data registers a reset** once at
  module load: `registerContextReset(() => { ... })`. Queries need nothing.
- **Never key a refetch on an org or workspace id** in a page
  (`$effect(() => { if (orgStore.currentOrg?.id) load(); })`): a same-org
  re-select or a switch between two workspaces of one org never moves the
  id, so the watch does nothing, while the epoch moves on every switch.
- **Detail pages read `params.id` once in `onMount`**; the `$location` half
  of the key remounts them on `/things/A` -> `/things/B`.

Mechanics and the switcher checklist: `.claude/rules/frontend-state.md`.

### Routing

Hash-based routing via `svelte-spa-router`. Routes defined in `web/src/routes/`.
The SPA is served at `/app`, so a full URL is `/app/#/dashboard`; `push()` and
`replace()` take the hash path only, as before.

```typescript
import { push, replace } from "svelte-spa-router";

// Navigate forward
push("/dashboard");

// Replace current entry (use for error redirects to avoid back-button loops)
replace("/apps");
```

**SPA error redirects: use `replace()`, not `push()`.** When a page load fails (403, 404, catch block) and you redirect away, `push()` creates a back-button loop.

### Modals, dialogs, and overlays — use `<Modal>`, never hand-roll

**There is a design-system modal. Use it. Do not write a `.modal-backdrop` +
`position: fixed` block in a route.** The primitive is `web/src/components/Modal.svelte`,
backed by two actions: `web/src/lib/portal.ts` and `web/src/lib/modal.ts`.

```svelte
<script>
  import Modal from "../components/Modal.svelte";
  let open = $state(false);
</script>

<button onclick={() => (open = true)}>New quote</button>

<Modal {open} title="New quote" onClose={() => (open = false)} size="md">
  <p>Body content.</p>
  {#snippet footer()}
    <button class="btn btn-secondary" onclick={() => (open = false)}>Cancel</button>
    <button class="btn btn-primary" onclick={save}>Save</button>
  {/snippet}
</Modal>
```

`<Modal>` gives you, for free: portal-out to `#overlay-root`, dimmed backdrop,
backdrop-click + ESC + close-button dismissal, body scroll-lock (ref-counted so
stacked overlays behave), and focus capture/restore. Props: `open`, `title?`,
`onClose`, `size?` (`sm`/`md`/`lg`), `closeOnBackdrop?`, plus a `children` body
and an optional `footer` snippet.

**Why hand-rolling breaks (the containing-block trap):** every route renders
inside `.app-main { overflow-y: auto }`. The instant any ancestor gains a
`transform`, `filter`, `will-change`, or a route-entry animation with a
`transform` keyframe, that ancestor becomes the *containing block* for
`position: fixed` descendants. A `fixed; inset: 0` backdrop then resolves
against that ancestor instead of the viewport, so the modal renders clipped
into the content column (off-center, jammed under the header) even though the
CSS looks correct. The bug is invisible in code and only appears once rendered.
`<Modal>` sidesteps it by portalling the node to `#overlay-root` (a `<body>`
child, sibling of `#app`), which always resolves against the viewport.

**Overlay z-index register** (keep overlays consistent and correctly stacked):
`<Modal>` backdrop = `1000`; the security-critical session-timeout overlay =
`9999` (must always win); the dev panel = `999999`. A new overlay type slots
between these, it does not invent a higher number than the session-timeout
warning.

`SessionTimeoutWarning.svelte` is deliberately NOT built on `<Modal>` — it is
non-dismissable (no backdrop click, no ESC) by security design. That is the one
sanctioned exception; everything else uses `<Modal>`.

### API Calls

Use the typed client from `web/src/lib/api.ts`:

```typescript
import { api } from "$lib/api";

const result = await api.get<{ data: Item[] }>("/items");
const items = result.data;
```

The client automatically:
- Prefixes `/api` to paths
- Includes credentials
- Redirects to login on 401
- Parses JSON responses

### Hard Reload Required

HMR is disabled. After any frontend change, hard reload: **Cmd+Shift+R** (Mac) or **Ctrl+Shift+R** (Windows/Linux).

### Roles and team management

> **The full role hierarchy, capability set, `can()`/`canManage()` helpers,
> invite flow, and soft-disconnect semantics live in `.claude/rules/auth.md`**
> (auto-loads on `src/auth/**`, `src/api/middleware/**`, `src/lib/roles.ts`,
> `web/src/lib/permissions.ts`). The essentials: 4 roles
> (owner/admin/editor/viewer), gate routes with `requireCapability(...)`, use
> `can(role, cap)` (never compare role strings), and member removal is a
> SOFT-DISCONNECT (`organization_id = NULL`), never a hard delete.

### Stores and the DevPanel — `defineStore` is mandatory for shared state

Every shared client-side store MUST be declared via `defineStore` from
`web/src/lib/devpanel/store.svelte.ts`. This is the load-bearing
convention that lets the DevPanel (visible in dev) AND the agent
verification pipeline (`GET /api/dev/app-state`) introspect every
piece of shared state in the running app, without knowing what stores
any given customer's code happens to have built.

```typescript
// web/src/stores/cart.svelte.ts
import { defineStore } from "../lib/devpanel/store.svelte";

interface CartState {
  items: Array<{ id: string; qty: number }>;
  isLoading: boolean;
  error: string | null;
}

const state = defineStore<CartState>("cart", {
  items: [],
  isLoading: false,
  error: null,
});

export async function addItem(id: string) {
  // Always assign at the TOP LEVEL — replace the array, don't push() into it.
  state.items = [...state.items, { id, qty: 1 }];
}

export const cartStore = {
  get items() { return state.items; },
  get isLoading() { return state.isLoading; },
  get error() { return state.error; },
  get count() { return state.items.length; },
  addItem,
};
```

**Then add the import to `web/src/main.ts`** in the eager-load block:

```typescript
// web/src/main.ts
import "./stores/auth.svelte";
import "./stores/organization.svelte";
import "./stores/cart.svelte";  // ← add new stores here
```

**Update conventions (the rule):**

- Always update via TOP-LEVEL property assignment: `state.items = [...]`,
  `state.user = newUser`. The Proxy notifies the DevPanel push pipeline
  on top-level writes; nested mutations (`state.items.push(x)`,
  `state.user.name = "X"`) work for component reactivity but are
  delayed in the DevPanel by up to 5s (heartbeat) instead of being
  visible immediately.
- For arrays / Maps / Sets: replace the whole reference, don't mutate
  in place.
- The store name (first arg to `defineStore`) is the user-visible
  identifier in the DevPanel — use snake_case singular nouns
  (`auth`, `cart`, `editor`, `chat`).

**What NOT to do:**

```typescript
// ❌ BAD — bare module-level $state. The DevPanel can't see this.
let count = $state(0);
let user = $state<User | null>(null);

// ❌ BAD — class instances. Not snapshot-safe (JSON.stringify drops them).
const state = defineStore("foo", new SomeClass());
```

Component-local `$state` inside `*.svelte` components is fine — that's
component scratch state, not shared store state, and the DevPanel
doesn't try to introspect it.

### Server-mirroring state — use `createQuery` (stale-while-revalidate)

State that MIRRORS SERVER DATA (lists, details, dashboards — anything a
`fetch` fills) goes through `createQuery` from `web/src/lib/query.svelte.ts`,
NOT a hand-rolled `fetchX()` + `defineStore` pair. It gives TanStack-Query
semantics with zero dependencies: instant cached reads, background
revalidation past `staleTime`, window-focus refresh, optional
`refetchInterval` (auto-paused for background tabs / unused queries), and
key-prefix invalidation so mutations live-reload every dependent view.

```typescript
import { createQuery, invalidateQueries } from "../lib/query.svelte";
import { api } from "../lib/api";

const ordersQuery = createQuery({
  key: "orders:list",
  fetcher: () => api.get<{ orders: Order[] }>("/orders"),
  staleTime: 15_000,
  refetchInterval: 60_000,
});

export const orderStore = {
  get orders() { return ordersQuery.data?.orders ?? []; },
  get isLoading() { return ordersQuery.isLoading; },
  get error() { return ordersQuery.error; },
  async createOrder(input: NewOrder) {
    await api.post("/orders", input);
    invalidateQueries("orders:");   // every orders:* view refreshes itself
  },
};
```

Rules:

- **Every mutation invalidates its key prefix.** That is the mechanism that
  makes data "just live-reload" — a mutation that forgets to invalidate
  leaves every other surface stale until its `staleTime` lapses.
- Key convention: `<domain>:<qualifier>` (`orders:list`, `orders:<id>`).
  Prefix-invalidate the domain after writes.
- `createQuery` is idempotent per key (same key returns the same handle),
  so per-entity key factories are safe to call from components.
- The public store getter API stays the same shape as before — components
  never import queries directly, they read the store facade.
- DevPanel introspection is preserved automatically: each cache entry IS a
  `defineStore` named `query:<key>`.
- Client-ONLY state (UI flags, wizard steps, drafts) stays on plain
  `defineStore` — don't wrap non-server state in a query.

**Invalidate by ENTITY, not by hand-picked key list.** The same server fact
usually renders from more than one key (a detail page and a list page, a
table and a dashboard tile). A mutation that lists prefixes by hand forgets
one of them, and that screen stays stale until `staleTime` lapses or the
user hard-refreshes. That bug class shipped four times in one week on one
customer app (project assignments on the person page, a verification result
in the compliance table, a new incoming employee on the roster, a sweep
resolution on the person card). So:

- `web/src/lib/invalidation-map.ts` is the ONE place that lists, per
  entity, every key prefix that renders it (`ENTITY_DEPENDENTS`). A
  mutation calls `invalidateEntity("upload")` from
  `web/src/lib/invalidation.ts` and says WHAT changed. When a new query
  starts reading an entity from a new prefix, add the prefix to the map,
  never to the call sites.
- The moment one entity renders from two different prefixes, add a row to
  `REQUIRED_PREFIXES_BY_WRITE_PATH` in the same file (API path pattern,
  required prefixes, and why). The lint
  `src/__tests__/routes/store-mutation-invalidation-lint.test.ts` then
  fails any store function that writes to that path without invalidating
  every required prefix. It also fails any store write that invalidates
  nothing at all, unless the path is in `NON_CACHED_WRITE_PATHS` with a
  reason (auth endpoints, presign steps).
- Do not "fix" a stale screen by adding one more `invalidateQueries` to one
  handler. Add the prefix to the entity in the map so every mutation of
  that entity gets it, and add the `REQUIRED_PREFIXES_BY_WRITE_PATH` row so
  the next handler cannot forget it.

**Why this matters: the agent's L1 verification check.** Before
driving the browser to verify a change, the verification subagent
runs `curl http://localhost:$PORT/api/dev/app-state` to read the
running app's full state. That endpoint returns every `defineStore`-
registered store, the current route, viewport, recent client errors,
recent server requests, and recent server errors — all in one
structured payload. If you create state via bare `$state` for shared
data, the agent's pre-browser check is incomplete and verification
gets harder.

**The DevPanel UI** (floating 🛠 button in the bottom-right when
`import.meta.env.DEV`) shows the same data live during human
debugging. Implementation: `web/src/components/DevPanel.svelte`,
mounted in `App.svelte`. Production builds short-circuit via
`import.meta.env.PROD` — the panel never renders for end users.
