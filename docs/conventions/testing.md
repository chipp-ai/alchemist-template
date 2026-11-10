# Testing

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
- **A `dbTest` with no database is skipped, not passed.** `dbTest` in `src/__tests__/helpers.ts` sets `ignore` when neither `TEST_DATABASE_URL` nor `DATABASE_URL` is set, so deno reports the case as `ignored`. A run whose summary shows your test as `ignored` proves nothing: start Postgres (`./scripts/setup.sh`, or the sandbox `DATABASE_URL`, then `deno task db:migrate`) and run it again, and `grep ignored .scratch/test-output.txt` before you report.
- **A test proves the fix only if it fails on the old code.** Drive the real entry point (`app.request(...)` on `app.ts` or the route's Hono app via `withTestServer`), not a copy of the logic. For a bug fix, run the new test once against the base and cite the failing line (see "Evidence").
- **A test runner script you add ends with `process.exit(failures ? 1 : 0)`** and is chained into the package's test script (the template has no `web/tests/dom`; projects add them, and a runner that never exits hangs CI). A test that greps source must match code, not comments.

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

## Type checks and the Chipp sandbox memory guard

- **`deno task check`, `check:tests` and `check:touched` run the native TypeScript 7 compiler** through `scripts/check-types.ts` (a few times faster than `deno check`, same diagnostics). It falls back to `deno check` on its own when it cannot give a verdict; `CHECK_ENGINE=deno` forces `deno check`. CI runs both and fails if either fails. `scripts/lib/tsgo-check.ts` is copied from chipp-deno: change it there first, then copy it here unchanged.
- **In a Chipp sandbox (Builder or Software Factory), every `deno` command goes through a memory guard.** Since 2026-10-23 it RUNS this project's tests under a memory lease: run the tests that cover every file you touched (`deno test --env --no-check --allow-all <test files> 2>&1 | tee .scratch/test-output.txt`) and cite deno's summary line (`ok | N passed | 0 failed | M ignored`). It still refuses a whole-repo check (`deno task check`, `deno task check:tests`, `deno check main.ts`, `deno check src/`) with a `[chipp deno-guard] refused` line; that is the sandbox, not a fault in this repo, so do not work around it. It allows `deno check <file>` and `deno task check:touched <file>` on up to 20 files that are not `main.ts`; each also checks everything those files import. If the guard refuses a test run (an older sandbox image), quote the refused line verbatim in your report; never write "tests not run" without it. The full `deno check main.ts` runs at Builder Publish and in the deploy build.

## Environment variables in code and tests

- **Read env with `getEnv()` from `src/lib/env.ts`, never `Deno.env.get()`, in server code (`src/`, `main.ts`). In tests, override env with `__setEnvForTest()` / `__deleteEnvForTest()`, never `Deno.env.set` / `Deno.env.delete`.** `deno test --parallel` runs every test file in one process, so a `Deno.env.set` in one file changes the env every other file sees and makes them fail at random. The overrides in `src/lib/env.ts` stay inside their own test file. `src/__tests__/env-isolation.test.ts` fails CI on any direct `Deno.env` use and prints each `file:line` with its replacement: apply those replacements (`envObject()` replaces `Deno.env.toObject()`, and `envReader` replaces a bare `Deno.env` passed as a reader). `scripts/` and `db/` run as separate processes and keep `Deno.env`.
