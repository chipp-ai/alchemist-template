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
  migrations/           # SQL migration files (NNN_description.sql)
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
- **Cache/Sessions:** Redis
- **Edge Proxy:** Cloudflare Worker (when deployed)

## Engineering Preferences

These guide all code review and implementation decisions:

- **DRY is important** -- flag repetition aggressively. If you see the same logic in two places, call it out.
- **Well-tested code is non-negotiable.** Too many tests > too few tests.
- **"Engineered enough"** -- not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity). Find the middle.
- **Handle real edge cases at system boundaries** (user input, external APIs, DB results) -- not phantom ones in internal code.
- **Bias toward explicit over clever.** If a reader has to pause and think about what the code does, it is too clever.

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

## API Conventions

### Route Structure

Routes live in `src/api/routes/`. Each route file exports a Hono app that is mounted in the main router. Routes are thin orchestration -- business logic lives in services.

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { validationHook } from "@/utils/zod-validation-hook.ts";

const app = new Hono();

app.get("/items", async (c) => {
  const items = await itemService.list();
  return c.json({ data: items });
});

app.post(
  "/items",
  zValidator("json", createItemSchema, validationHook),
  async (c) => {
    const body = c.req.valid("json");
    const item = await itemService.create(body);
    return c.json({ data: item }, 201);
  },
);

export default app;
```

### Request Validation

- **`zValidator` MUST always pass `validationHook`** as the third argument. Without it, validation errors return a raw ZodError object and clients see `[object Object]` instead of a readable message.
- **Zod `.trim()` before `.min(1)` for name fields.** `z.string().min(1)` passes whitespace-only strings (`"   "` has length 3). Chain `.trim().min(1)` for user-facing name/label fields. Do not trim passwords or API keys.

### Response Format

All endpoints return:
- **Success:** `{ data: T }` with appropriate status code (200, 201, 204)
- **Error:** `{ error: string, code: string }` with appropriate status code

### Auth Middleware

Protected routes use `requireAuth` middleware, which populates `c.get("user")` and `c.get("session")`. Place it before route handlers that need authentication.

### Services

Services live in `src/services/`. One service per domain (e.g., `user.service.ts`, `billing.service.ts`). Services contain all business logic and database queries. Routes call services -- they never query the database directly.

## Database Conventions

### Kysely + CamelCasePlugin

The CamelCasePlugin transforms column names:
- **In SELECT results:** snake_case columns become camelCase properties (`created_at` -> `createdAt`)
- **In WHERE, ORDER BY, ON:** Use the original **snake_case** column names
- **In INSERT/UPDATE `.set()` and `.values()`:** Use **camelCase** property names

```typescript
// SELECT -- camelCase in results
const user = await db
  .selectFrom("app.users")
  .select(["id", "email", "createdAt"])   // camelCase
  .where("organization_id", "=", orgId)   // snake_case in WHERE
  .orderBy("created_at", "desc")          // snake_case in ORDER BY
  .executeTakeFirst();

// INSERT -- camelCase in values
await db
  .insertInto("app.users")
  .values({ email, name, organizationId: orgId })  // camelCase
  .execute();
```

### Migrations

- Files: `db/migrations/NNN_description.sql` (sorted lexically)
- **All migrations must be backward-compatible** with currently running code (expand/contract pattern)
- Run: `deno task db:migrate`
- Migrations run automatically in CI before deploy
- Each migration runs in a transaction -- if it fails, it rolls back
- Never put DML (`UPDATE`) in the same migration as `ALTER TYPE ... ADD VALUE` (PostgreSQL limitation)

### Query Safety

- **`withTimeout(ms, fn)`** for all Kysely queries -- prevents pool starvation during DB contention
- **`raceTimeout(ms, promise)`** for raw `postgres.js` queries when you need snake_case result keys
- **`countAll()` returns a string** -- always wrap with `Number()`
- **Never `JSON.stringify()` for Kysely JSONB** -- pass objects directly to `.set()` / `.values()`. Stringify double-encodes.
- **JSONB columns return as strings from SELECT** -- always `JSON.parse()` before using. Never cast directly.
- **Guard `whereIn()` against empty arrays** -- `WHERE column IN ()` is a PostgreSQL syntax error. Always check `if (ids.length === 0) return [];` before the query.
- **`isTransientDbError(err)`** -- use in catch blocks to downgrade connection resets and pool timeouts to `log.warn` instead of `log.error`.

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

### Server-Side

- **Never use bare `console.error`.** Use `log` from `src/lib/logger.ts` with `source` context.
- **Always pass `Error` as the 3rd arg** to `log.error()` and `log.warn()` for stack trace extraction.
- **Never use bare `.catch(() => {})`** -- always log failures. Silent swallowing hides bugs.

```typescript
import { log } from "@/lib/logger.ts";

// Good
try {
  await riskyOperation();
} catch (err) {
  log.error("Operation failed", { source: "billing", orgId }, err);
  throw err;
}

// Bad -- silent swallowing
await riskyOperation().catch(() => {});
```

### Error Classes

Use `AppError` subclasses from `src/utils/errors.ts`:

| Class | Status | When |
|-------|--------|------|
| `BadRequestError` | 400 | Invalid input |
| `UnauthorizedError` | 401 | Not authenticated |
| `ForbiddenError` | 403 | Not authorized |
| `NotFoundError` | 404 | Resource not found |
| `ConflictError` | 409 | Duplicate / conflict |
| `ExternalServiceError` | 502 | Third-party API failure |

Route catch blocks should re-throw `AppError` subclasses without logging (the global error handler logs them).

## Frontend Conventions

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

Customer apps inherit a 4-role hierarchy + an email-driven invite
flow. The role hierarchy lives in **one** file — `src/lib/roles.ts`
on the server, mirrored EXACTLY in `web/src/lib/permissions.ts`
on the client. A regression test
(`src/__tests__/team.test.ts → "client mirror"`) lints the two
files for the same capability list and roles.

**Roles**

| Role | Count | Powers |
|---|---|---|
| `owner` | 1 per org | Full control. Set at org creation. CANNOT be invited (transfer is a separate flow, deferred). |
| `admin` | N per org | Manage team (invite, change roles, remove) + edit org settings + everything an editor can do. |
| `editor` | N per org | Write app data. Cannot manage team or org settings. The default invitee role. |
| `viewer` | N per org | Read-only across the board. |

The schema enum still allows the legacy `member` value for backward
compat with rows that pre-date migration 003. `member` is a synonym
for `editor` in code — same hierarchy rank, same capabilities.
Migration 003 backfills `member` rows to `editor` so fresh databases
never produce them.

**Capabilities**

Routes gate via the `requireCapability` middleware (in
`src/api/middleware/auth.ts`):

```typescript
import { requireAuth, requireCapability } from "@/api/middleware/auth.ts";

orgRoutes.post(
  "/invites",
  requireCapability("team.invite"),
  zValidator("json", inviteSchema, validationHook),
  handler,
);
```

The capability set lives in `src/lib/roles.ts`:

| Capability | Min role |
|---|---|
| `team.invite` | admin |
| `team.update_role` | admin |
| `team.remove` | admin |
| `org.update` | admin |
| `app.write` | editor |
| `app.read` | viewer |

Use the `can(role, capability)` helper for inline checks; never
compare role strings directly. The hierarchy enforces "fail closed"
for unknown roles — `rankOf("nonexistent")` returns 0, so `can()`
returns false on schema drift.

**Manage-vs-target rules**

The `canManage(actor, target)` helper enforces:

- Owner is untouchable. Only the explicit ownership-transfer flow
  (deferred) can change owner.
- Admins cannot manage other admins — only the owner can. Prevents
  lateral demotion wars between admins.
- Viewers and editors can never manage anyone.

The Settings → Team UI uses `canManage` to gate role-edit dropdowns
and remove buttons per-row, so an admin sees "edit role" on editors
and viewers but a static badge on other admins.

**Invite flow**

```
POST /api/org/invites    → admin creates invite (sends email)
GET  /api/org/invites    → admin lists pending invites
DELETE /api/org/invites/:id → admin revokes a pending invite
PATCH /api/org/members/:userId/role → admin changes role
DELETE /api/org/members/:userId → admin SOFT-DISCONNECTS member

GET  /api/invite/:token            → public preview (no auth)
POST /api/invite/:token/accept     → consume token (auth required;
                                     authenticated email must match
                                     invite email)
```

Frontend route: `/#/invite/:token` → `web/src/routes/InviteAccept.svelte`.
Logged-out users get a "sign in to accept" page that pre-fills the
invited email; logged-in users with a matching email get auto-accept.

**CRITICAL: removing a member is SOFT-DISCONNECT, not hard-delete.**

The DELETE /members/:userId route sets `users.organization_id = NULL`
and `role = 'viewer'`. The user row itself is preserved — sessions,
oauth bindings, and any FK'd domain data persist. Re-inviting a
removed user lands cleanly via the same flow as a new invite. A
regression test (`src/__tests__/team.test.ts → "DELETE
/members/:userId soft-disconnects"`) lints the route file for
`organizationId: null` and forbids `db.deleteFrom("users")`.

**Email rendering**

Invite emails go through `src/services/email.ts → sendInviteEmail`.
Falls back to console.log in dev (when SMTP isn't configured) so
the agent can grab the accept URL during local testing without a
real mailbox. The `APP_URL` env var determines the link host.

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

## Git Workflow

- Stay on `staging`. Do not create feature branches.
- Commit directly on `staging`.
- PRs target `staging`, never `main`.
- **When committing, always use `git add -A`** to stage all changes. Multiple agents may run side by side -- include everything.
- **NEVER use `--no-verify` or `--no-gpg-sign`** on any git command.

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

## Verification Checklist

Before reporting any implementation as complete:

1. **Type checks:** `deno task check` passes
2. **Tests written and passing:** `deno task test:fast 2>&1 | tee .scratch/test-output.txt`
3. **API tested** (for backend changes): write a scratch test in `.scratch/` and run it
4. **Browser verified** (for UI changes): hard reload and check the actual rendered result
5. **No errors** in server logs (`.scratch/logs/server.log`) or browser console

**If ANY check fails: fix, re-run, proceed only when green.**

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
browser_navigate({ url: "http://localhost:8000/" })

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

browser_navigate({ url: "http://localhost:8000/dashboard" })  // now authed
browser_screenshot()  // capture the proof
```

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
