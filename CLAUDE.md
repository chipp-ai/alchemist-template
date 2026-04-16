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

### Svelte 5

This project uses Svelte 5 runes syntax:

```svelte
<script lang="ts">
  let count = $state(0);
  let doubled = $derived(count * 2);

  $effect(() => {
    console.log("count changed:", count);
  });
</script>
```

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

## Git Workflow

- Stay on `staging`. Do not create feature branches.
- Commit directly on `staging`.
- PRs target `staging`, never `main`.
- **When committing, always use `git add -A`** to stage all changes. Multiple agents may run side by side -- include everything.
- **NEVER use `--no-verify` or `--no-gpg-sign`** on any git command.

## Verification Checklist

Before reporting any implementation as complete:

1. **Type checks:** `deno task check` passes
2. **Tests written and passing:** `deno task test:fast 2>&1 | tee .scratch/test-output.txt`
3. **API tested** (for backend changes): write a scratch test in `.scratch/` and run it
4. **Browser verified** (for UI changes): hard reload and check the actual rendered result
5. **No errors** in server logs (`.scratch/logs/server.log`) or browser console

**If ANY check fails: fix, re-run, proceed only when green.**

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
