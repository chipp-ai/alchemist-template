# CI fix: `withLocalStorage` env-var race under `deno test --parallel`

**Status:** shipped (ALCHEM7-5)

## Problem

`withLocalStorage()` in `src/__tests__/helpers.ts` puts the LOCAL storage
driver into scope for a test by mutating process-wide env vars
(`LOCAL_STORAGE_DIR`, `R2_KEY_PREFIX`, etc.), running the caller's function,
then restoring them in a `finally`. `storage.test.ts` does something similar
at module load: it sets `R2_*` to fake R2 credentials and never restores
them.

`deno test --parallel` runs test **files** as separate V8 isolates, but all
of those isolates live inside **one OS process** (see the schema-isolation
comment in `src/db/client.ts`, which solved the equivalent problem for the
database by keying test schemas off a random id rather than `Deno.pid`,
since `Deno.pid` is identical across isolates). `Deno.env` is a binding onto
that one process's real environment, so it is genuinely shared across every
isolate. When commit `d647530` added a new `withLocalStorage` cross-tenant
test to `file-uploads.test.ts`, the odds of two files' `withLocalStorage`
critical sections overlapping in time went up enough to flake CI: whichever
call's `finally` restored/deleted `LOCAL_STORAGE_DIR` first pulled the rug
out from under the other, which then hit "file not found" reading its own
temp directory.

The five tests CI reported failing (`file-uploads.test.ts` raw-storage
isolation test, four `imports.test.ts` tests) all passed in isolation and
only failed under `--parallel` — the signature of a shared-mutable-state
race, not a logic bug.

## Decision

Serialize the whole env-mutation critical section with a **Postgres
advisory lock**, the same primitive `src/db/client.ts` already uses
(`PROVISION_LOCK_KEY`) to serialize per-worker schema provisioning across
isolates.

This is the one mutex primitive that actually reaches across isolate
boundaries: a plain module-scoped JS lock (a `Promise` chain, a boolean
flag) would only serialize calls *within one isolate*, because each isolate
gets its own module registry — two different test files racing from two
different isolates would each get their own copy of that lock and never see
each other. A Postgres advisory lock is scoped to a **database session**,
not a JS realm, so `pg_advisory_lock(495495)` / `pg_advisory_unlock(495495)`
correctly blocks isolate B's call until isolate A's is fully done mutating
`Deno.env` and has restored it.

Rejected alternative: redesign the storage driver to take its root
directory as an explicit parameter instead of reading `Deno.env` at call
time. This would remove the shared-mutable-state hazard at the root, but it
touches every call site of `storage.service.ts` / `storage-local.ts`
(production code, not just tests) for a CI-only problem — too large a
change for what is fundamentally a test-isolation bug.

## Public contract

- `src/__tests__/helpers.ts` exports `STORAGE_ENV_LOCK_KEY` (`495495`), the
  fixed advisory-lock key. `withLocalStorage()`'s behavior/signature is
  unchanged — it still takes `{ keyPrefix? }` and hands the caller
  `{ root, setKeyPrefix }`.
- `src/__tests__/storage.test.ts` now acquires the same lock (via
  `sql.reserve()` + `pg_advisory_lock`) before its module-level `R2_*`
  mutation, and releases it in a final `Deno.test("release the storage-env
  lock", ...)` that must stay the last test declared in the file — Deno
  runs a file's tests sequentially in declaration order and always runs
  every test regardless of an earlier failure, so this reliably fires last.
  Skipped entirely when no DB is configured (running that file standalone,
  with no `--parallel` fleet to race against in the first place).

## Gotchas

- The lock only helps `withLocalStorage` callers and `storage.test.ts`.
  Any *new* test file that mutates `R2_*` / `LOCAL_STORAGE_*` env vars
  directly (instead of going through `withLocalStorage`) reintroduces the
  same race and won't be caught by this lock.
- Holding a DB advisory lock across the whole critical section means every
  `withLocalStorage` call now costs one extra DB round trip
  (`sql.reserve()` + lock + unlock). Negligible in practice (each call was
  already going through a full HTTP-route + DB test setup), and it fully
  serializes storage tests against each other — acceptable since none of
  them are individually slow.

## Update (ALCHEM7-7): the per-call `sql.reserve()` itself leaked

Landing the fix above (calling `sql.reserve()` **inside** every
`withLocalStorage()` invocation) traded the env race for a new problem: it
broke CI's `Run tests` step with Deno leak-sanitizer failures on all 22
tests in `storage-local-driver.test.ts` ("A TCP connection was opened ...
but not closed", "A timer was started ... never completed", "An async call
to `op_read` ... never completed").

**Root cause:** `postgres.js` connects lazily — no socket opens until the
first query. `sql.reserve()` called *during* a running `Deno.test()` body
is therefore often the thing that opens that first physical connection.
`lock.release()` in the `finally` block returns the connection to the pool
without closing the socket (that's the point of pooling), so from Deno's
sanitizer's point of view a resource was opened after the test's "before"
snapshot and is still alive at the test's "after" snapshot — a leak, on
every single call.

**Fix:** reserve the lock connection exactly **once**, at module load —
before any `Deno.test()` body in an importing file runs — and hold it for
the whole worker's life, never returning it to the pool. This is the exact
pattern `storage.test.ts` already used successfully for its own module-load
`R2_*` mutation (see "Public contract" above): a resource created before
the first test's snapshot is never "new" for any later test, no matter how
many times its advisory lock is acquired/released across calls. Only the
`pg_advisory_lock` / `pg_advisory_unlock` *queries* run per call now — the
connection itself is a fixture, exported as
`const localStorageLockConnection` in `src/__tests__/helpers.ts`.

The cross-isolate serialization semantics (the whole reason this is a
Postgres advisory lock and not a JS mutex) are unchanged — see "Decision"
above, still true.
