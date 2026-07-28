# [Project Name]

[Brief description of what this SaaS product does -- CUSTOMIZE THIS for your product]

**Powered by Alchemist AI** -- Autonomous development platform.

## Local Dev Ports

@.claude/local-dev.md

All references to `__VITE_PORT__` and `__API_PORT__` in docs mean **your** Vite and API ports from the file above.

## Quick Start

```bash
./scripts/setup.sh                                          # First time only
./scripts/dev.sh --api-port __API_PORT__ --port __VITE_PORT__  # Start dev stack
```

**Browser:** Always use `http://localhost:__VITE_PORT__` (Vite), NOT the API port.

**HMR is disabled.** Multiple agents build concurrently on the same repo. Frontend changes require a **hard reload** in the browser (Cmd+Shift+R). Do not wait for HMR -- it will not pick up changes.

**Dev login (local browser testing):** there is no SMTP / inbox harness in dev, so the email-OTP code never reaches an inbox — sign-in via the OTP form will always block. Two well-lit escape hatches:

- **In the browser**, the Login page renders a "Dev login as ..." button below the OTP form (visible only when `import.meta.env.DEV`). It POSTs to `/api/dev/login`, sets a real session cookie, and redirects in. This is the path for human / interactive testing.
- **From an agent or terminal**, `curl -X POST -H 'Content-Type: application/json' -d '{"email":"agent@dev.local"}' http://localhost:__API_PORT__/api/dev/login -c /tmp/jar.txt` issues the same session. Re-use the cookie jar with `-b /tmp/jar.txt` on subsequent requests.

The `/api/dev/*` routes 404 when `NODE_ENV=production`, and the Login page button is stripped from production SPA builds — both surfaces are local-only by construction. See "Dev affordances" further down for the full route catalog (seed / reset / introspect).

## Architecture

```
src/                    # Deno + Hono API server
  api/
    routes/             # Hono route handlers (thin orchestration)
    middleware/          # Auth, validation, error handling
  services/             # Business logic (one service per domain)
  db/
    client.ts           # Kysely client with CamelCasePlugin
    schema.ts           # TypeScript type definitions for all tables
  lib/
    logger.ts           # Structured logger (dev: pretty, prod: NDJSON)
  utils/                # Shared utilities (errors, validation hooks)
  __tests__/
    routes/             # Route integration tests
    services/           # Service unit tests
    helpers.ts          # Test utilities (createIsolatedUser, etc.)

web/                    # Svelte 5 SPA
  src/
    routes/             # Page components (hash-based routing)
    stores/             # Svelte stores (state management)
    lib/
      api.ts            # Typed fetch wrapper with 401 handling

db/
  migrations/           # SQL migration files (YYYYMMDDHHMMSS_description.sql)
  migrate.ts            # Migration runner

scripts/
  dev.sh                # Start full dev stack
  setup.sh              # First-time project setup

.scratch/               # Ephemeral files (gitignored except .gitkeep)
  logs/                 # Dev server logs (server.log, vite.log)
```

**Stack:**
- **API:** Deno + Hono
- **Frontend:** Svelte 5 SPA with hash-based routing (`svelte-spa-router`)
- **Database:** PostgreSQL via Kysely (CamelCasePlugin)
- **Cache / locks / rate limits:** shared platform Redis via `src/lib/redis.ts` (best-effort, fail-open -- see "Shared Redis" below). Sessions are stateless JWT cookies, NOT server-side session storage.
- **Edge Proxy:** Cloudflare Worker (when deployed)

## Engineering Preferences

These guide all code review and implementation decisions:

- **DRY is important** -- flag repetition aggressively. If you see the same logic in two places, call it out.
- **Well-tested code is non-negotiable.** Too many tests > too few tests.
- **"Engineered enough"** -- not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity). Find the middle.
- **Handle real edge cases at system boundaries** (user input, external APIs, DB results) -- not phantom ones in internal code.
- **Bias toward explicit over clever.** If a reader has to pause and think about what the code does, it is too clever.
- **Never hand-roll regex / keyword heuristics to interpret natural language or judge fuzzy intent.** Deciding "did the user say yes?", "is this message a complaint / positive / spam?", "which category is this free text?", or extracting structured fields from prose is a MODEL job — call a small cheap model (Haiku-class, e.g. `claude-haiku-4-5`) with **structured outputs** (a forced tool call / JSON schema returning typed fields) and fail CLOSED on error. A keyword list or affirmative-word regex silently mis-reads negation, conditionals, and sarcasm — it passes review and breaks on real input. Regex/string-matching is ONLY for genuinely structured, syntactic input (validating an email/URL/UUID format, parsing a known grammar, matching a fixed enum you control). If a person typed it in their own words and you're inferring meaning, that's a model call.

## Critical Rules

- No emojis unless necessary
- Never make things up -- ask if unsure
- PRs target `staging` branch, not `main`
- **`staging` IS production.** The `staging` branch serves real users. Treat every staging issue with production-level urgency.
- Use `.scratch/` for ephemeral files (test scripts, debug logs, scratch data)
- **ALWAYS capture test output:** `deno task test 2>&1 | tee .scratch/test-output.txt`. Grep the file instead of re-running tests.
- **Use `deno task test:fast`** for quick iteration (~1min). To run a specific test file: `deno test --env --no-check --allow-all <file>`.
- **Tests that create DB resources must use `createIsolatedUser()`** -- never the shared test user. Parallel tests can delete each other's data.
- **NEVER use `--no-verify` or `--no-gpg-sign`** on any git command. If hooks fail, fix the underlying issue.
- **Every interactive element gets `data-testid`** following `{area}-{component}-{element}` convention (e.g., `data-testid="settings-form-input-name"`).
- **ALWAYS use `./scripts/dev.sh --api-port __API_PORT__ --port __VITE_PORT__`** -- ports are required (no defaults), logs go to `.scratch/logs/`.

## Convention spokes — `.claude/rules/`

This file is the **hub**: universal rules that apply everywhere. Deep,
area-specific conventions live in **spoke** files under `.claude/rules/`,
each scoped to a path glob via `paths:` frontmatter. A spoke loads only
when you work in its area, so the hub stays focused.

| Spoke | Auto-loads when you touch | Covers |
|---|---|---|
| `database.md` | `db/**`, `*.service.ts` | Postgres extensions, Kysely + CamelCasePlugin, migrations, query safety |
| `api-layer.md` | `src/api/**` | Hono routes, validation, response envelope, WebSockets |
| `auth.md` | `src/auth/**`, middleware, `roles.ts` | Role hierarchy, capabilities, invite flow, soft-disconnect |
| `services-jobs.md` | `src/services/**`, `src/jobs/**` | Service structure, logging contract, `AppError` classes |

In Claude Code these load when you read a matching file. The Alchemist
build agent injects them when a tool call touches a matching path (and
exposes them via the `load_skill` tool). Add a new spoke by dropping a
`.claude/rules/<name>.md` with a `description:` and `paths:` frontmatter.

## Observability stream — `.scratch/logs/observability.jsonl`

Every server log statement, HTTP request, server error, AND every browser-side breadcrumb (console.*, errors, fetch/XHR, clicks, route changes, LCP/CLS/INP) converges in **time order** into a single JSONL file at `.scratch/logs/observability.jsonl`. This is the canonical "what happened during this test session" stream — read it after a user has poked at the app to understand exactly what they did, what fired, and what failed.

Each line is `{ts, sid, source: "client"|"server", kind, data}`. Stable `kind` slugs (do NOT mutate; analytics product depends on them): `server.log.{debug,info,warn,error}`, `server.http`, `server.error`, `client.console.{log,info,warn,error,debug}`, `client.error`, `client.promise`, `client.fetch`, `client.click`, `client.click.background`, `client.route`, `client.perf.{lcp,cls,inp}`, `client.session`.

Implementation lives in:
- `src/observability/jsonl-writer.ts` — append-only writer with 10MB rotation
- `src/observability/envelope.ts` — `recordServerEvent` / `recordClientEvents`
- `src/api/routes/observability/index.ts` — `POST /api/_observability/breadcrumb` collector
- `web/src/lib/observability/breadcrumbs.ts` — client-side hooks (installed from `web/src/main.ts`)
- Hooked into `src/lib/logger.ts` (every emit) and `src/lib/dev-activity.ts` (every recorded request + error)

Dev-only — the entire pipeline no-ops when `NODE_ENV === "production"`. The analytics product will replace the collector with a remote ingest at that boundary when it ships.

**When debugging a user-reported issue, tail this file first** — `tail -n 200 .scratch/logs/observability.jsonl | jq .` gives the most recent slice of what happened in their session, both client and server, in time order.

## Production debugging -- Alchemist MCP tools (`.mcp.json`)

The observability stream above is dev-only. To debug the DEPLOYED app, this repo ships a `.mcp.json` that connects Claude Code (or any MCP client) to the Alchemist platform's tenant MCP endpoint. Before launching Claude Code, export your tenant API key in the shell:

```bash
export ALCHEMIST_API_KEY=alch_...   # from the Alchemist dashboard; NEVER commit it
```

The config expands `${ALCHEMIST_API_KEY}` at connect time. All tools are tenant-scoped: they only see YOUR projects.

| Tool | Use for |
|------|---------|
| `get_project_errors` | Error-level logs from the deployed app (5m-7d lookback, pattern filter) |
| `get_project_logs` | General log search: error/warn/info levels, pattern filter, capped results |
| `query_database` | Read-only SQL against this project's production database (SELECT-only, row-capped, statement timeout) |
| `get_env_status` | Which required env vars are set on the deployed app |
| `get_alert_status` | Whether an error-investigation agent is already active |
| `dispatch_ticket`, `list_tickets`, `get_ticket`, `get_ticket_reports` | Hand work to the autonomous pipeline instead of doing it by hand |

Routing rule: a LOCAL issue → tail `.scratch/logs/observability.jsonl` (section above). A DEPLOYED-app issue → `get_project_errors` / `get_project_logs` first, then `query_database` to inspect data. A fix you'd rather not hand-write → `dispatch_ticket`.

The production database is reachable ONLY through `query_database` (read-only). There are no direct production DB credentials to configure locally, and you should never ask for any. If `get_project_logs` or `query_database` is missing from the tool list, your platform hasn't rolled them out yet -- fall back to `get_project_errors` and `dispatch_ticket`.

## API Conventions

> **Detailed API-layer rules live in `.claude/rules/api-layer.md`** (Hono route
> structure, `zValidator` + `validationHook`, the `{data}`/`{error}` envelope,
> the realtime/WebSocket surface). They auto-load when you touch `src/api/**`.
> The essentials: routes are thin orchestration (logic lives in services),
> `zValidator` MUST pass `validationHook`, and every response is `{ data }` or
> `{ error, code }`.

## Database Conventions

> **Detailed database rules live in `.claude/rules/database.md`** (Postgres
> extensions, Kysely + CamelCasePlugin, migration filenames, query safety).
> They auto-load when you touch `db/**` or a `*.service.ts`. The essentials:
> never `CREATE EXTENSION` (the platform installs them); migrations use a
> `YYYYMMDDHHMMSS_` UTC-timestamp prefix, never sequential integers; CamelCase
> in SELECT results + INSERT values, snake_case in WHERE/ORDER BY.

## Shared Redis — cache, locks, rate limits (best-effort)

The platform provisions every deployed project with `REDIS_URL` pointing at a
shared multi-tenant Redis. Your credentials are a per-project Redis ACL user
confined server-side to your own key prefix (`REDIS_KEY_PREFIX`), so you can
never see or touch another project's keys. **Always go through the helpers in
`src/lib/redis.ts`** -- they prepend the prefix automatically, bound every op
at 500ms, and fail open:

```ts
import { cacheGet, cacheSet, cacheDelete, acquireLock, releaseLock, rateLimit } from "@/lib/redis.ts";

// Cache an expensive lookup for 60s
const cached = await cacheGet<Report>(`report:${id}`);
if (cached) return cached;
const report = await buildReport(id);
await cacheSet(`report:${id}`, report, 60);

// Damp abuse on a public endpoint
const rl = await rateLimit(`signup:${ip}`, { limit: 5, windowSeconds: 3600 });
if (!rl.allowed) return c.json({ error: "Too many attempts" }, 429);

// De-duplicate a background job across restarts
if (await acquireLock("nightly-report", 300)) {
  try { await runNightlyReport(); } finally { await releaseLock("nightly-report"); }
}
```

The rules:

- **Redis is a CACHE, never a source of truth.** It runs with LRU eviction and
  no persistence; any key can vanish at any moment. Durable state (including
  anything billing- or correctness-critical) belongs in Postgres. Every helper
  fails OPEN -- a Redis outage degrades to cache misses / allowed actions, it
  never takes your app down. Never gate correctness on a Redis reply.
- **Never use a module-level `Map` (or any in-process memo) for state that
  must survive a restart or be shared across requests.** In-memory state
  silently evaporates on every deploy and breaks the moment the app scales
  past one replica. If it is worth caching across requests, use `cacheGet` /
  `cacheSet`. (Per-request memoization inside one handler call is fine.)
- **Locks and rate limits are damping, not guarantees.** `acquireLock` and
  `rateLimit` fail open when Redis is unavailable. For real mutual exclusion
  use a Postgres advisory lock or row-level locking.
- **`SCAN`/`KEYS` are denied by the ACL** (they would leak other tenants' key
  names). If you need to enumerate your own keys, track them explicitly in a
  Redis SET or in Postgres.
- **Dev parity:** `scripts/dev.sh` boots a local Redis and exports
  `REDIS_URL`, so behavior matches production. With `REDIS_URL` unset (tests),
  every helper is a silent no-op.

## Testing

### Running Tests

```bash
# Fast iteration (routes + services, ~1min)
deno task test:fast 2>&1 | tee .scratch/test-output.txt

# All tests
deno task test 2>&1 | tee .scratch/test-output.txt

# Single file
deno test --env --no-check --allow-all src/__tests__/services/user_test.ts

# Watch mode
deno task test:watch
```

### Test Isolation

```typescript
import { createIsolatedUser } from "../helpers.ts";

Deno.test("creates an application", async () => {
  const { user, org, workspace, cleanup } = await createIsolatedUser("owner");
  try {
    // ... test logic using user, org, workspace
  } finally {
    await cleanup();
  }
});
```

**Rules:**
- Always use `createIsolatedUser()` for test isolation -- never shared singletons.
- Always call `cleanup()` in a `finally` block.
- ALWAYS capture test output to `.scratch/test-output.txt` and grep the file instead of re-running.

### Test Structure

```
src/__tests__/
  helpers.ts              # createIsolatedUser, getTestDb, withTestServer
  routes/                 # Route integration tests
    auth_test.ts
    applications_test.ts
  services/               # Service unit tests
    user_service_test.ts
    billing_service_test.ts
```

## Error Handling

> **The server-side logging contract + `AppError` class table live in
> `.claude/rules/services-jobs.md`** (auto-loads on `src/services/**` /
> `src/jobs/**`). The essentials: never bare `console.error` or
> `.catch(() => {})`; use `log` from `src/lib/logger.ts` with a `source` and
> pass the `Error` as the 3rd arg; throw `AppError` subclasses and let the
> global handler format them.

## Frontend Conventions

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

### Routing

Hash-based routing via `svelte-spa-router`. Routes defined in `web/src/routes/`.

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

## Brand identity — `src/config/brand.ts` is the only source of truth

The deployed product has a customer-facing name that is **not**
"Alchemist" — Alchemist is the platform that built this app, not
the product the end-user sees. The platform sets two env vars on
the customer pod:

- `APP_NAME` — the user-facing product name (e.g. "Pinterest
  Clone", "Pickleball Tournament Matchmaker"). Sourced from
  `platform.projects.brand_config.productName`.
- `EMAIL_FROM` — the verified transactional sender address
  (e.g. `noreply@yourapp.adaas.dev`).

`src/config/brand.ts` reads both at boot into a frozen `BRAND`
object:

```ts
import { BRAND } from "@/config/brand.ts";

BRAND.name      // "Pinterest Clone"  (or "Your App" if APP_NAME unset)
BRAND.fromEmail // "noreply@..."       (or "noreply@example.com" if unset)
BRAND.fromName  // mirrors BRAND.name; pre-formatted for "Name <email>"
```

**Every customer-facing surface that needs the product name MUST
import `BRAND` from this module.** Never inline
`Deno.env.get("APP_NAME") ?? "Alchemist"` — the literal
`"Alchemist"` is the leak. The defensive fallbacks are
deliberately generic ("Your App", `noreply@example.com`) so a
misconfigured pod renders a placeholder, not the platform's
codename.

Surfaces wired through `BRAND` today:
- `src/services/email.ts` — every transactional email subject,
  body, and `From:` header.
- `web/index.html` — title is the placeholder `Loading…`;
  `web/public/brand-loader.js` overrides `document.title` with
  `brand.productName` from `/brand.json` once the SPA boots.

When adding a new surface (OG meta, push notification copy,
exported PDFs), reach for `BRAND.*` first. If you find yourself
typing the literal "Alchemist" anywhere in this repo's customer-
facing code, stop — that's the bug this module exists to prevent.

## Typography — Google Fonts is the only webfont source

All font usage flows through three semantic tokens in `web/src/app.css`:

```css
--font-heading  /* h1-h6 and any "this should feel like a heading" surface */
--font-sans     /* body + UI (buttons, labels, paragraph text) */
--font-mono     /* code, kbd, samp, pre, tabular numerics */
```

Components **NEVER** hardcode a `font-family` value. They reference one of the three tokens. That contract is the entire point: changing the product's typography is supposed to be a one-token edit, not a find-and-replace across every Svelte file. If you find yourself typing `font-family: "Inter"` (or any literal family name) anywhere in `web/src/`, stop — use the token.

### Adding or changing a font

Two files, always in lockstep:

1. **`web/index.html`** — update the `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?...">`. Include every weight + italic you'll actually use; don't load 9 weights "just in case" (each weight is a separate font file).
2. **`web/src/app.css`** — update the `--font-heading` / `--font-sans` / `--font-mono` token(s) to put the new family at the front of the stack. Keep the web-safe fallbacks after — they're what renders during the `display=swap` window (and forever for users behind webfont blockers).

**Google Fonts is the only webfont source.** No Adobe Fonts, no self-hosted `@font-face`, no Typekit. Reasons:

- One CDN, well-cached across the open web (visitors land on your app with the font already in their browser cache from another site).
- `preconnect` + `display=swap` are a known-good loading pattern; we don't have to rediscover it per app.
- Lets the local-dev agent's `present_choices` swatch pull from a single curated catalog instead of guessing at family availability.

### When the user asks for a "different vibe"

Don't pick fonts blind. The local-dev agent has a `present_choices` tool (in the orchestrator's tool palette) that opens a swatch of 3-4 visual options with sample text rendered in each candidate. Use it for any aesthetic-direction request: "make it feel more rustic", "modernize the typography", "give it a magazine feel", etc. The user picks; the orchestrator reads the chosen option's `spec` field and applies the two-file change above.

Use it for: `font`, `palette`, `layout`, `copy` — anything a designer would present as a swatch rather than guess at.

**Don't** use it for: bug fixes, specific values the user gave you ("use Inter"), or anything with a clearly-right answer. Over-using `present_choices` is annoying.

### The default pairing

The template ships with **Inter** (everything) + **JetBrains Mono** (code). Inter is the deliberate vibe-neutral default — it works for any product category, doesn't lean visual-design-y, and pairs with anything you'd swap in later. Don't change the default in this repo; let customer apps drift on top.

## HIPAA mode — env-var-gated, no schema changes

The template ships every building block for HIPAA-compliant session handling. Activation is binary, sourced from a single env var the Alchemist platform sets on the customer pod when the project was opted into HIPAA during onboarding (and the BAA was signed):

```
HIPAA_ENABLED=true
```

When set:
- Session JWTs expire after **4 hours** instead of 30 days (`src/utils/session-duration.ts`).
- The session cookie's `Max-Age` matches the JWT's `exp`.
- `/auth/me` returns `hipaaEnabled: true` and `sessionDurationMs: 14400000`.
- The SPA arms `sessionTimeoutStore` (`web/src/stores/sessionTimeout.svelte.ts`): activity tracking on `mousedown / keydown / scroll / touchstart / click` (throttled 1/sec), server-touch via `POST /auth/touch` (throttled 1/5 min), warning modal at TTL−5min, force-logout at TTL.
- Multiple tabs sync via `BroadcastChannel("alchemist-session-activity")` so activity in one tab resets timers in others.

When unset/false:
- 30-day default sessions, no activity tracking, no warning modal. The `sessionTimeoutStore` stays inert (`active: false`).

There is **no per-user / per-org HIPAA toggle inside this template**. The whole deployed app is HIPAA-bound or it isn't — that's a project-scope decision the alchemist platform records and propagates via the env var. Don't add a `hipaa_enabled` column on `organizations`; the platform's onboarding flow + customer-pod env is the only source of truth.

The `POST /auth/touch` endpoint re-issues a JWT with a fresh `exp` claim and resets the cookie. It calls `requireAuth`, so a session that already lapsed gets 401 → SPA force-logout. The store throttles outgoing `/touch` calls to once per 5 minutes regardless of how active the user is.

## Git Workflow

- Stay on `staging`. Do not create feature branches.
- Commit directly on `staging`.
- PRs target `staging`, never `main`.
- **NEVER use `--no-verify` or `--no-gpg-sign`** on any git command.

### `git add -A` is the rule, not a suggestion

Multiple Claude Code workers run side-by-side on this repo's `staging` branch at all times. When you commit, **other workers' uncommitted changes may already be in your working tree** — that is expected, not a bug. The rule:

**Always `git add -A` before committing.** Never cherry-pick individual files trying to "separate your changes from another worker's." Don't try to reason about which lines are "yours" and which aren't — that distinction is meaningless when sessions get compacted, contexts overlap, and the same agent picks back up with a stale model of what it already wrote. The working tree is the truth; commit all of it.

**Never `git stash` to "isolate your commit"** from another worker's in-progress changes. Stashing parks work in a per-clone reflog that other workers can't see and that gets lost on `git reset --hard`, `git clean -fd`, or a worktree teardown — uncommitted work outside the index has no durable home. The entire point of the always-commit rule is that the index is the only place work survives.

The only acceptable workflow:

```
git add -A
git commit -m "..."
git push
```

Trust CI to catch broken intermediate states. If a partial refactor genuinely shouldn't deploy, **revert the offending lines as a follow-up commit**, don't stash them. If a commit message ends up bundling more files than the message describes, that's fine — the message is an approximation of "what shipped in this push," not a strict scope contract.

## File storage — use `storage.service.ts`, never write to R2 directly

The platform injects shared R2 credentials (`R2_ENDPOINT` /
`R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`) plus a
per-customer `R2_KEY_PREFIX` (`customer-${projectId}/`). The whole
fleet shares one bucket; cross-tenant isolation lives in the path
layer. **Every R2 key MUST start with `R2_KEY_PREFIX`.** Don't
write your own R2 helpers — `src/services/storage.service.ts` does
this for you and structurally prevents prefix escape.

### What's available

```ts
import {
  putObject,                // server-side upload
  getObject,                // server-side fetch
  deleteObject,             // server-side delete
  getSignedDownloadUrl,     // browser-facing read URL (default 1h, max 7d)
  getSignedUploadUrl,       // browser direct PUT URL (default 15m, max 7d)
  isStorageConfigured,
  describeStorageConfig,
  scopedKey,                // utility — auto-prefixes a relative key
  assertOwnedKey,           // utility — validates a stored full key
} from "@/services/storage.service.ts";
```

### Recipe — user uploads an image

```ts
// Server: issue a presigned PUT URL the browser can use directly.
const { uploadUrl, key, expiresAt } = await fetch("/api/files/upload-url", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    key: `users/${user.id}/avatars/${crypto.randomUUID()}.jpg`,
    contentType: "image/jpeg",
  }),
}).then((r) => r.json());

// Browser: PUT the file bytes directly to R2. Server never sees them.
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "image/jpeg" },
  body: file,
});

// Server: store `key` (RELATIVE — without the prefix) in your DB.
await db.insertInto("app.user_avatars").values({ userId: user.id, key }).execute();
```

### Recipe — serve the image later

```ts
// Server: read the relative key from the DB row, hand back a fresh
// signed URL. The R2_KEY_PREFIX gets prepended in the helper.
const url = getSignedDownloadUrl(row.key, 3600);
return c.json({ avatarUrl: url });
```

### Cross-tenant isolation contract

`scopedKey()` (called by every public helper) **rejects**:
- Empty / missing keys
- Leading slash (would defeat prefix)
- `..` segments (path traversal)
- `.` segments (no-op but suspicious)
- Empty segments (double slash)
- Backslashes (Windows-style traversal)
- Keys longer than 900 chars

Application code passes RELATIVE keys (e.g. `images/foo.jpg`) — the
prefix is invisible to your code and impossible to escape using these
helpers. **Do NOT store the full prefixed key in your DB** — store
the relative key. That way if the prefix scheme ever changes (it
won't, but defensively), your data is portable.

### Reading an externally-supplied stored full key

If your DB stores the FULL prefixed key (legacy), validate it with
`assertOwnedKey()` before passing to any helper that accepts a raw
key. This is the only safe way to handle a fully-qualified R2 key
that came from outside your own write path.

### Built-in routes

`POST /api/files/upload-url` — body `{ key, contentType, expiresInSeconds? }`,
returns `{ uploadUrl, key, expiresAt, requiredHeaders }`. Auth required.

`POST /api/files/download-url` — body `{ key, expiresInSeconds?, downloadFilename? }`,
returns `{ downloadUrl, key, expiresAt }`. Auth required. Set
`downloadFilename` to force `Content-Disposition: attachment`.

`POST /api/files/upload` — multipart server-side proxy upload (8 MB cap).
Use this for small files when you don't want browser PUT. Body fields:
`file` (the bytes) + `key` (the relative key string).

`DELETE /api/files` — body `{ key }`. Auth required. Idempotent.

`GET /api/files/info` — diagnostic; returns `{ configured, bucket, prefix }`.

### CORS

For browser direct uploads to work, the R2 bucket needs CORS
configured to accept the customer's app origin. The platform handles
this for `*.adaas.dev` automatically — see chipp-ai/alchemist-ai
`scripts/bootstrap-r2-cors.sh`. For custom domains, the platform
adds the origin to the bucket-level rule when the customer registers
the domain (see `R2 Bucket CORS` in alchemist-ai/CLAUDE.md).

## Selling things — built-in Stripe monetization (do NOT rebuild this)

The template ships a complete "sell something" layer on top of Stripe:
one-time products AND monthly/yearly subscription products, with checkout,
webhook fulfillment, and org-level entitlements. **When a ticket says
"charge for X", "add a premium tier", "sell an add-on", or "paywall this
feature", wire it through this layer — never hand-roll new Stripe calls,
products tables, or webhook handlers.**

### The pieces

| Piece | Where |
|---|---|
| `products` + `purchases` tables | `db/migrations/20260706135633_products_and_purchases.sql` |
| Catalog + checkout + fulfillment + entitlements | `src/services/product.service.ts` |
| Routes (`/api/billing/products`, `/purchases`, `/entitlements`, webhook) | `src/api/routes/billing/index.ts` |
| Server-side feature gate | `requireEntitlement("key")` in `src/api/middleware/entitlement.ts` (402, code `ENTITLEMENT_REQUIRED`) |
| Client store + checkout redirect | `web/src/stores/billing.svelte.ts` (`billingStore`) |
| Operator UI (create/archive products, purchases list) | Settings → Billing tab (`web/src/routes/Settings.svelte`) |
| Shared Stripe client (API-version pin lives here) | `src/lib/stripe.ts` — always `getStripe()`/`requireStripe()`, never `new Stripe(...)` inline |

### Turning on selling (the whole flow)

1. Create a product — Settings → Billing → "New product", or
   `POST /api/billing/products` (`billing.manage` capability, admin+), or
   `createProduct()` from a seed script. The service creates the **Stripe
   Product + Price via the API** — no dashboard steps, no env vars.
   `type: "one_time"` or `type: "subscription"` + `interval: "month" | "year"`.
2. Buyers hit `billingStore.startCheckout(productId)` → Stripe Checkout
   (mode follows the product type) → webhook records the purchase.
3. Gate the feature:
   - Server: `requireEntitlement("premium_reports")` after `requireAuth`, or
     `hasActiveEntitlement(orgId, "premium_reports")` in a service.
   - Client (UX only, not security): `billingStore.isEntitled("premium_reports")`.

Gate on the **`productKey`** (stable slug like `premium_reports`), never the
UUID. Price changes go through `updateProduct` (mints a new Stripe Price —
prices are immutable). Archive with `active: false`; never DELETE a product
that has purchases (FK is RESTRICT on purpose).

### Invariants (each prevents a real failure mode)

- **Product subscriptions must NEVER touch `organizations.subscription_tier`.**
  The webhook routes on `metadata.productId`: present → purchases table;
  absent → plan-tier path. Checkout stamps that metadata on the session AND
  the subscription (`subscription_data.metadata`). If you add a new checkout
  surface, stamp both or renewals will corrupt the org's plan tier.
- **Fulfillment is webhook-driven and idempotent.** Never grant an
  entitlement in the checkout success redirect (users refresh; Stripe
  retries). `recordProductPurchase` / `applyProductSubscriptionEvent` are
  safe under replays and out-of-order delivery — go through them.
- **`mapSubscriptionToTier` must only return values in the
  `subscription_tier` enum** (`FREE|STARTER|PRO|ENTERPRISE`). A made-up tier
  name crashes the org UPDATE inside the webhook.
- The plan-tier layer (env `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_YEARLY`,
  `GET /api/billing/subscription`, `POST /api/billing/checkout`) is for the
  org's plan of THIS app. Products are what the app sells on top. Don't
  merge the two.

## Inbound email ingestion: built-in pipeline (do NOT rebuild this)

The template ships a dormant email-ingestion substrate: a purpose-built
address receives operational email (PDFs, spreadsheets, status updates) and
an LLM projects it into YOUR domain tables. **When a ticket says "ingest
emails", "process the ops inbox", "extract data from forwarded emails", or
"parse email attachments into the DB", wire it through this pipeline --
never build a new webhook receiver, IMAP poller, or extraction loop.**

The flow (all shipped, all dormant until configured):

```
Postmark inbound webhook -> POST /api/ingest/email?token=...   (fail-closed gate)
  -> capture.service.ts: dedup on Message-ID, attachments to R2,
     inbound_email + inbound_email_attachment rows, status='received'
  -> src/jobs/inbound-email-reaper.ts (60s loop, advisory lock)
  -> extract.service.ts: LLM triage into { <your data> | human_message | unclear }
  -> YOUR extraction profile's applyData() -> your domain tables
  -> Inbound Email dashboard page (list/detail, signed attachment URLs)
```

**Your ONE integration point is an extraction profile**
(`src/services/inbound-email/profile.ts`):

```ts
registerInboundEmailExtractionProfile({
  dataKind: "invoice_data",              // discriminator for the domain variant
  dataSchema: z.object({ ... }),         // zod schema the LLM must fill
  extractionInstructions: "...",         // domain guidance appended to the triage prompt
  applyData: async ({ orgId, emailId, data }) => {
    // Idempotent, keyed on emailId (the reaper re-runs failed rows).
    // Recommended dedup key for downstream writes: `email:<emailId>|...`
    return { applied: n, summary: "..." };
  },
});
```

Register it once at boot (import from `main.ts` or a service init). Schema
rules (each prevents a real failure mode): LLM-optional fields are
`.nullish()` never `.optional()`; soft descriptive fields truncate (see
`softText` in extract.service.ts) rather than reject.

Invariants:

- **Never bypass the capture-first contract.** Extraction is a re-runnable
  projection over durably captured rows; if extraction logic changes, rows
  can be re-processed. Do not extract inline in the webhook handler.
- **`INGEST_EMAIL_TOKEN` unset = endpoint OFF** (fails closed). The
  platform mints the token and provisions the Postmark inbound address +
  MX record; do not hand-roll either.
- **Set `INGEST_ORG_ID`** in production: captured rows are attributed to
  that org and the dashboard is org-scoped (NULL-org rows are invisible).
- **Attachments live in R2 via `storage.service.ts` relative keys**; the
  key folder is a hash of the Message-ID (attacker-controlled input must
  not choose object paths). Disallowed/oversized attachments are recorded
  with an empty `r2_key` sentinel, never dropped.
- The extraction LLM call runs through the platform billing proxy
  (`LLM_CONFIG`); a 402 credits-exhausted response backs off for 3 days
  automatically.
- The dashboard renders untrusted email HTML ONLY inside `sandbox=""`
  iframes via `frameSrcdocForEmailHtml()` (CSP blocks remote loads). Keep
  it that way.

## Browser automation / portal scraping: a platform capability (do NOT build it here)

When a ticket asks to log into a third-party web portal, scrape data from
it, submit data to it, or schedule a recurring pull (or names
playwright/puppeteer/selenium), **never add browser automation to this
repo**. No playwright, no puppeteer, no chromium download, no cookie-jar
login clients. The Alchemist platform operates a hardened browser lane:
headless Chromium in a sandbox, postback-safe interaction primitives,
encrypted credential + session storage (secret values never enter code or
LLM context), human SSO/MFA handoff for portals behind SSO, and a
scheduled runner for recurring flows with failure auto-pause. A repo-local
rebuild of any of that is a security regression and will be rejected in
review.

What THIS repo contributes:

- **Destination tables** for the scraped data, with provenance columns
  (`source`, `scraped_at`) and an idempotent natural UNIQUE key (flows
  re-run and overlap with backfills; a landing table without an upsert
  key accumulates duplicates).
- Nothing else. Writes land through the platform's gated data-operation
  lane, never via an in-repo scraper or an open DB credential.

How the capability is engaged: portal credentials are stored
platform-side under NAMES (e.g. `ACME_PORTAL_USER` / `ACME_PORTAL_PASS`);
the project's conversational agent authors the scrape flow interactively
against the live portal and promotes the working session to a saved,
scheduled flow. If the portal turns out to have a real HTTP API, skip
this lane and write a normal API client service instead. Full contract:
the platform recipe `browser-scrape-flows`.

## Verification Checklist

Before reporting any implementation as complete:

1. **Type checks:** `deno task check` passes
2. **Tests written and passing:** `deno task test:fast 2>&1 | tee .scratch/test-output.txt`
3. **API tested** (for backend changes): write a scratch test in `.scratch/` and run it
4. **Browser verified** (for UI changes): hard reload and check the actual rendered result
5. **No errors** in server logs (`.scratch/logs/server.log`) or browser console

**If ANY check fails: fix, re-run, proceed only when green.**

## Agent verification toolkit — pick the right tool

When verifying a change against the running app, three MCP tools cover almost everything. **Pick from cheapest → most expensive** and only escalate when the cheaper one doesn't answer the question.

### Tier 1 — `dev_app_state` (cheapest, no browser required)

```
mcp__dev-server__dev_app_state                  # JSON, structured
mcp__dev-server__dev_app_state({ format: "markdown" })   # Markdown, layered report
```

GETs `/api/dev/app-state` on the running customer app. Returns one merged payload:

- **Client side** — current route, viewport, every `defineStore`-registered store snapshot, and `recentErrors` (uncaught JS errors captured by `window.onerror` / `unhandledrejection`).
- **Server side** — the last 20 HTTP requests with method/path/status/duration, and any captured server errors.

**Use this first** for any "is the running app in the state I expect?" question. It answers "what page is the user on / what's in the auth store / did my last PATCH succeed / did the server throw" with a single tool call. The structured JSON (default) is the L1 view; `format: "markdown"` is the L2 deep-dive (same content, formatted for reading).

What `dev_app_state` does NOT capture: plain `console.log` / `console.warn` / `console.info` calls. Those need Tier 2.

### Tier 2 — `browser_get_console_logs` (full console output)

```
mcp__browser-devtools__browser_get_console_logs           # all types
mcp__browser-devtools__browser_get_console_logs({ type: "error" })  # filter
mcp__browser-devtools__browser_get_console_logs({ search: "..." })  # grep
```

Captures every `console.*` call from Chrome via CDP — `log`, `warn`, `error`, `info`, `debug` — with stack traces and timestamps. Use this when:

- A bug is suspected in code that uses `console.log` to surface state.
- An uncaught error appears in `dev_app_state.client.recentErrors` and you want the surrounding console context.
- A third-party library is logging warnings you need to read.

### Tier 3 — drive the browser (UI verification)

```
mcp__browser-devtools__browser_navigate
mcp__browser-devtools__browser_click
mcp__browser-devtools__browser_type
mcp__browser-devtools__browser_take_screenshot
mcp__browser-devtools__browser_execute_js
```

Use these when the previous tiers can't answer your question — you need to verify visual layout, click through a flow, or run JS in the page context (e.g. open a WebSocket from the SPA's origin to verify the proxy + auth path).

### Decision rule

> "Could `dev_app_state` answer this?" → call it first.
> "Could `browser_get_console_logs` answer this?" → call it next.
> "Do I actually need to see / click the page?" → only then go to `browser_*`.

Skipping the cheaper tools is the most common token-waster in verification — agents reach for `browser_navigate` + `browser_take_screenshot` to check things that `dev_app_state` already returns in one call.

## Dev affordances — DO NOT reverse-engineer auth from scratch

When NODE_ENV is anything other than `production` (which is the case in
the local dev stack AND inside the agent's E2B sandbox), the platform
mounts a small set of **dev-only routes** at `/api/dev/*` so you can
verify auth-gated flows without driving the OTP send + email + verify
cycle. SMTP is not configured in the sandbox, so the OTP email goes to
console — agents that try to verify the signup flow without these
routes will spend tokens screen-scraping the log. Don't.

### Available endpoints

```
GET  /api/dev/info     # Capability advertisement (safe to call first to
                       # confirm the routes are live).
POST /api/dev/login    # Body: { email, name? }
                       # Looks up or creates user + org, sets the same
                       # session_id cookie /verify-otp would set.
                       # Returns { user, organization, session_cookie }.
POST /api/dev/seed     # Body: { users?: [{email, name?}], raw?: [{table, rows}] }
                       # Bulk-create users with their own orgs, AND/OR
                       # ad-hoc inserts into any app./billing./jobs.
                       # table. Both modes run in one transaction.
POST /api/dev/reset    # Body: { tables?: [...] } (default = all
                       # app/billing/jobs tables). TRUNCATE CASCADE.
                       # Use BEFORE seeding for a known starting point.
```

### Recipe — verify a route that requires auth

```bash
# Inside the sandbox after ensure_local_dev_server succeeded:

# 1. Reset to a clean DB (optional but recommended).
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{}' http://localhost:8000/api/dev/reset

# 2. Instant-login as the user you want to be.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"email":"agent@dev.local"}' \
  http://localhost:8000/api/dev/login \
  -c /tmp/jar.txt

# 3. Hit the auth-gated route with the cookie jar.
curl -sS -b /tmp/jar.txt http://localhost:8000/api/auth/me
# → { user: { id, email, name }, organization: {...} }
```

### Recipe — verify the same flow in the headless browser

The dev login sets a real `session_id` cookie that's identical to
what `/verify-otp` would set, so once you've POSTed to
`/api/dev/login` from the page (e.g. via `browser_evaluate`), the SPA
behaves as if the user is logged in.

```ts
// Browser ALWAYS targets the Vite port (__VITE_PORT__), never the API
// port. Vite serves the SPA shell + proxies /api → :__API_PORT__, so
// the relative `/api/dev/login` fetch below reaches the API correctly.
browser_navigate({ url: "http://localhost:__VITE_PORT__/" })

// Bypass OTP — set the session via dev-login from the page itself.
browser_evaluate({
  expression: `(async () => {
    const r = await fetch('/api/dev/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: 'agent@dev.local' }),
    });
    return r.status;
  })()`
})

browser_navigate({ url: "http://localhost:__VITE_PORT__/dashboard" })  // now authed
browser_screenshot()  // capture the proof
```

### Recipe — populate mock domain data for visual verification

When the operator asks to "populate mock data", "seed sample
recipes", "fill in placeholder images", or "make the empty state
look real" — DO NOT edit the rendering component to invent a
placeholder. The page renders FROM the DB; changing only the
component leaves you with the same empty rows.

**Do NOT reset reflexively.** Operator-seeded rows live in the
same tables; `/api/dev/reset` wipes everything. The correct flow
inspects first and only resets when existing data is structurally
unfixable (NULL on a field the UI requires, AND no way to fix it
without re-seeding):

```bash
# 1. SEE what's already there.
curl -sS http://localhost:8000/api/<resource-list-endpoint>
# If rows exist with the field the UI needs, do NOT seed — the
# rendering side is what's wrong (auth wall, route mismatch,
# component bug). Diagnose that instead.

# 2. Get the organization_id you'd seed INTO if rows are missing
# or have NULL on the field the UI needs.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"email":"agent@dev.local"}' \
  http://localhost:8000/api/dev/login | jq -r '.organization.id'

# 3. Reset ONLY when existing rows are structurally wrong AND you
# can't UPDATE in place (/api/dev/seed is INSERT-only by design).
# Narrate the destruction out loud BEFORE running so the operator
# can stop you: "Clearing N existing rows so I can re-seed with
# photo URLs filled in." NEVER skip this announcement.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"tables":["recipes"]}' \
  http://localhost:8000/api/dev/reset

# 4. Insert with EVERY column the UI reads, including image URLs.
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"raw":[{"table":"recipes","rows":[
    {"organization_id":"<UUID>","title":"...","slug":"...",
     "description":"...","photo_url":"https://images.unsplash.com/...",
     "photo_width":1200,"photo_height":1600,
     "servings":4,"prep_minutes":30,"cook_minutes":12}
  ]}]}' \
  http://localhost:8000/api/dev/seed
```

**Image URL conventions** (use real CDN URLs, not `/placeholder.png`):

- Unsplash: `https://images.unsplash.com/photo-<ID>?w=1200&q=80&auto=format&fit=crop` — direct asset URLs, no rate limit at small scale, food/people/landscape topics search-friendly via `unsplash.com/s/photos/<topic>`.
- Picsum: `https://picsum.photos/seed/<slug>/1200/900` — deterministic-by-seed, good for "any image will do" cases.
- Avatars: `https://i.pravatar.cc/300?u=<email>` — deterministic by user email.

**There is NO PATCH endpoint** — `/api/dev/seed` only does INSERT and `/api/dev/reset` only does TRUNCATE. To "update" existing rows, reset the table first then re-insert with the new column values. This is intentional: the dev surface stays small, and the agent's mental model is "what should the DB look like" rather than "what's the column-level diff".

**Don't invent placeholders in components when the directive says "populate the data".** The user said "populate" because they want the DB rows to have real-looking values; a `<img src={photo_url ?? '/missing.svg'} />` fallback is not the same and feels broken if every row hits the fallback.

### Production safety

The whole dev router is wrapped in a guard middleware that throws
`NotFoundError` when `NODE_ENV === "production"`. The deployed
customer pod always has `NODE_ENV=production` (set by the rollout
controller) so the routes return 404 the same as if they had never
been registered. Don't remove this guard — the routes bypass auth.

## Library version idioms — fight your training-data defaults

Every dependency below is pinned to a major version where the API changed in a way that LLM training data still gets wrong by default. Read this section *before* reaching for muscle memory on any of these libraries. When training data and this section disagree, **this section wins** — the build will fail at deploy time if you guess wrong.

### Deno 2 (`denoland/deno:2.3.1` runtime)

`Deno.run` was REMOVED in Deno 2. Most training data is Deno 1.x.

| Subprocess | Deno 2 (use this) | Deno 1 (do NOT use) |
|---|---|---|
| Spawn + capture | `await new Deno.Command("git", { args: ["status"], stdout: "piped" }).output()` | `Deno.run({ cmd: ["git", "status"], stdout: "piped" })` |
| Spawn + stream | `new Deno.Command(...).spawn()` | `Deno.run(...)` |

`Deno.serve` is the default HTTP server — already used in `main.ts`. Don't fall back to `Deno.listen` + `serveHttp`.

`Deno.env.get()` is unchanged. `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.readDir` are unchanged. The breakage is concentrated on `Deno.run` and a few Deno-namespace helpers — when in doubt, run `deno doc --builtin Deno.<symbol>` to confirm the symbol still exists.

### Hono 4 (`hono@^4.6.0`)

`app.fire()` was removed. The custom-context typing pattern is now:

```typescript
type AppEnv = { Variables: { user: User; session: Session } };
const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("user", currentUser);
  await next();
});

app.get("/me", (c) => c.json({ user: c.get("user") }));
```

NOT the v3 `Hono.Variables` global augmentation pattern. Middleware that mutates the context type without the `Hono<{ Variables: ... }>` generic will type-check but `c.get(...)` will return `unknown` everywhere.

## Social login / SSO is PREBUILT — enable with env vars, never rebuild it

The template ships a complete, flag-gated social-login experience. When a builder asks for "sign in with Google" (or Microsoft, GitHub, Salesforce, Keycloak, Okta, Auth0, any OIDC IdP), the answer is env vars + a credential request, NOT new code. Do not write OAuth routes, do not add login buttons, do not touch the session layer.

How it works (`src/lib/oauth-providers.ts` + `src/api/routes/auth/index.ts` + `web/src/routes/Login.svelte`):

- Email OTP login is always-on (the platform injects SMTP creds). OAuth providers are opt-in per deployment.
- Setting a provider's env-var pair auto-registers `/api/auth/<id>` + `/api/auth/<id>/callback` and auto-shows its button on the Login page via `/auth/config`. Nothing else to wire.
- The callback finds-or-creates the user by email, links the OAuth identity (`users.oauthProvider`/`oauthId`), marks the email verified, and issues the normal session. Provider switching on the same email is allowed.

| Provider | Enable with | Notes |
|---|---|---|
| Google | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | offline access + consent prompt already set |
| Microsoft | `MICROSOFT_CLIENT_ID` + `MICROSOFT_CLIENT_SECRET` | `common` tenant: personal + any work/school account |
| GitHub | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | private-email recovery via /user/emails is handled |
| Salesforce | `SALESFORCE_CLIENT_ID` + `SALESFORCE_CLIENT_SECRET` | sandbox orgs: also set `SALESFORCE_LOGIN_URL=https://test.salesforce.com` |
| Any OIDC IdP (Keycloak / Okta / Auth0 / Azure AD single-tenant / ...) | `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` + `OIDC_AUTH_URL` + `OIDC_TOKEN_URL` + `OIDC_USERINFO_URL` (optional `OIDC_LABEL`, `OIDC_SCOPES`) | endpoint recipes below |

OIDC endpoint recipes:

- Keycloak (issuer `https://<host>/realms/<realm>`): `<issuer>/protocol/openid-connect/auth`, `.../token`, `.../userinfo`
- Okta: `https://<domain>/oauth2/default/v1/authorize`, `.../v1/token`, `.../v1/userinfo`
- Auth0: `https://<domain>/authorize`, `https://<domain>/oauth/token`, `https://<domain>/userinfo`

The redirect/callback URL the builder must register in their IdP console is `${APP_URL}/api/auth/<provider-id>/callback` (production: `https://<project>.adaas.dev/api/auth/google/callback` etc.; custom domains use that domain instead).

Getting the credentials: the client id/secret belong to the BUILDER's own IdP tenancy (their Google Cloud project, Azure app registration, Salesforce Connected App, Keycloak realm client). Request them through the platform credential-request flow (`request_human_input` / credential invite) with the exact callback URL and required scopes named in the request; the values are applied to the deployment env by the platform. NEVER paste client secrets into code, tickets, commit messages, or docs, and never invent placeholder values that ship.

If a ticket asks for a provider that genuinely does not fit the generic OIDC slot (e.g. Apple's JWT-based client secret, SAML-only IdPs), add ONE registry entry mirroring the existing pattern in `src/lib/oauth-providers.ts` (see `src/__tests__/oauth-providers.test.ts`) rather than building a parallel auth path.

### Arctic 2 (`arctic@^2.0.0`)

Arctic 2.0 was a near-total rewrite (Sept 2024). The OOTB providers in `src/lib/oauth-providers.ts` are already on v2 — DO NOT rewrite them. If a ticket asks for a new provider, mirror the v2 pattern from the existing files, NOT the older v1 pattern from public docs.

The v2 idiom for token validation:

```typescript
const tokens = await provider.validateAuthorizationCode(code, codeVerifier);
const accessToken = tokens.accessToken();
const accessTokenExpiresAt = tokens.accessTokenExpiresAt();
const refreshToken = tokens.hasRefreshToken() ? tokens.refreshToken() : null;
```

NOT `tokens.accessToken` (property), NOT `OAuth2Tokens` returned as a plain object, NOT v1's `validateAuthorizationCode(code)` two-arg-less signature.

### date-fns 3 (`date-fns@^3.0.0`)

The default export was DROPPED. Use named imports only.

```typescript
// Correct
import { format, parseISO, differenceInDays } from "date-fns";
format(new Date(), "yyyy-MM-dd");

// Wrong — silently typechecks under Deno's npm: types but throws at runtime
import dateFns from "date-fns";
dateFns.format(new Date(), "yyyy-MM-dd");
```

date-fns 3 is also ESM-first. If you need locale support: `import { enUS } from "date-fns/locale"` (no `/dist/`).

### Stripe 17 (`stripe@^17.0.0`)

Pin the API version when constructing the client — the SDK major version and the API version must agree, otherwise the `Stripe.Checkout.Session.create({...})` call will type-check but fail at runtime with `parameter_invalid` for fields the older API didn't know about.

```typescript
import Stripe from "stripe";
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2025-02-24.acacia" as Stripe.LatestApiVersion,
});
```

The platform-injected `STRIPE_SECRET_KEY` belongs to the customer's connected Stripe account. Do not hardcode another key.

## Self-Improvement Loop (Non-Negotiable)

After ANY correction from the user, **immediately** update this `CLAUDE.md` with the pattern. Write rules for yourself that prevent the same mistake. Review this file at session start for the relevant project area.

## Common Pitfalls

This section grows as mistakes are discovered. Check it before writing code.

- **`zValidator` must always pass `validationHook`** -- raw ZodError objects are unreadable to clients
- **Zod `.trim()` before `.min(1)` for name fields** -- whitespace-only strings pass `.min(1)`
- **JSONB columns return as strings** -- always `JSON.parse()` before using
- **Never `JSON.stringify()` for Kysely JSONB** -- pass objects directly, stringify double-encodes
- **`countAll()` returns string** -- wrap with `Number()`
- **`whereIn()` with empty array crashes** -- guard with early return
- **CamelCase in SELECT/INSERT, snake_case in WHERE/ORDER** -- the CamelCasePlugin only transforms result columns
- **SPA error redirects use `replace()`, not `push()`** -- prevents back-button loops
- **Hard reload after frontend changes** -- HMR is disabled
- **Test isolation requires `createIsolatedUser()`** -- shared users cause FK violations in parallel tests
- **Deno 2: `Deno.run` removed** -- use `new Deno.Command(...)` (Deno 1 idiom is the default in training data)
- **Hono 4: custom context via `Hono<{ Variables: ... }>` generic** -- not v3 global `Hono.Variables` augmentation
- **Arctic 2: tokens are objects with method calls** -- `tokens.accessToken()`, not `tokens.accessToken`
- **date-fns 3: no default export** -- `import { format } from "date-fns"`, not `import dateFns from "date-fns"`
- **Stripe 17: pin `apiVersion` on the client** -- SDK major and API version must agree
- **Svelte 5 runes only** -- `$props()`, `$state()`, `$derived`, `$effect`, `{@render children()}`. NEVER `export let` (compile error)

## JSONB: never pass a pre-stringified value as a parameter

postgres.js serializes parameters per the SERVER-declared type: a jsonb-bound
parameter is JSON-serialized by the CLIENT, so `JSON.stringify(x)` double-encodes
into a jsonb string scalar, and an explicit `::jsonb` cast does NOT parse it
back. The corruption is invisible to tolerant readers and detonates only on
SQL-level structural ops (`||` append, `@>` containment, `->` extraction).

Rules (inherited from the chipp-deno 2026-07-28 audit: 62 columns / ~1.9M rows
corrupted platform-side by exactly this):

1. Pass the JS object/array directly as the parameter. In raw `sql` templates
   use `sql.json(value)`. NEVER `JSON.stringify` a value bound to a jsonb
   column, with or without a `::jsonb` cast.
2. Every NEW jsonb column must ship `CHECK (jsonb_typeof(col) <> 'string')`
   in the migration that creates it, so a double-encoding write fails loudly
   at write time instead of corrupting silently. Pre-existing columns are
   covered by the `jsonb_no_string_scalars` migration.
3. Only skip the CHECK when the column legitimately stores bare JSON string
   scalars, and say why in a comment next to the column.
